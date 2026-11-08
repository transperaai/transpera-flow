-- Adopting a solution (capacity Q12, decision D44): "Adopt" on the Solution page opens the process's draft seeded with the solution's steps,
-- so a person reviews it in the Editor and presses Publish themselves. Nothing is ever published here, and live is not touched.
--
-- What it does: `public.adopt_solution(p_solution uuid, p_replace boolean default false)`, a security definer function like
-- `restore_version` (whose draft-seeding it follows; the caller's right to edit the workspace is checked first, and only the process's draft is
-- written):
--   * the process has no draft: a new draft is opened (the next version number) and filled with the solution's steps and edges;
--   * the process has a draft nobody has changed (it matches live): it is refilled;
--   * the process has a draft with work in it: nothing changes and `draft_exists` comes back, unless `p_replace` is true (the person said yes);
--   * the solution is marked Adopted (a person's call, shown as a pill; the status trigger logs it on each linked issue). This happens when the
--     draft is seeded, not when it is later published: publishing has no hook for it (a deliberate choice to keep `publish` untouched).
-- Returns `{status: 'ok', revision_id, number, replaced_draft}`, `{status: 'draft_exists', number}` or `{status: 'not_found'}`. An archived
-- process is refused with a plain message (as `open_draft` does).
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270132000000';` expect 0.
-- ROLLBACK: `drop function public.adopt_solution(uuid, boolean); delete from public.schema_migrations where version = '20270132000000';`

create or replace function public.adopt_solution(p_solution uuid, p_replace boolean default false) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sol public.solutions;
  proc public.processes;
  live public.process_revisions;
  draft public.process_revisions;
  had_draft boolean;
  untouched constant jsonb := '{"steps":{"added":[],"removed":[],"changed":[]},"edges":{"added":[],"removed":[],"changed":[]}}';
begin
  select * into sol from public.solutions s where s.id = p_solution;
  if sol.id is null or public.can_edit_workspace(sol.workspace_id) is not true then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into proc from public.processes p where p.id = sol.process_id for update;
  if proc.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if proc.archived_at is not null then
    raise exception '% is archived. Restore it from Processes (Archived) before changing it.', proc.name using errcode = '55000';
  end if;
  select * into live from public.process_revisions r where r.id = proc.live_revision_id;

  select * into draft from public.process_revisions r where r.process_id = proc.id and r.status = 'draft';
  had_draft := draft.id is not null;
  if draft.id is not null then
    -- A draft nobody has changed (just opened) is safe to replace; one with work in it needs a yes.
    if not coalesce(p_replace, false)
       and (live.id is null
            and exists (select 1 from public.steps s where s.revision_id = draft.id)
            or live.id is not null and private.revision_changes(live.id, draft.id) <> untouched) then
      return jsonb_build_object('status', 'draft_exists', 'number', draft.number);
    end if;
    -- Edges go with their steps.
    delete from public.steps s where s.revision_id = draft.id;
  else
    insert into public.process_revisions (workspace_id, process_id, number, status, layout)
    values (
      proc.workspace_id,
      proc.id,
      coalesce((select max(r.number) from public.process_revisions r where r.process_id = proc.id), 0) + 1,
      'draft',
      coalesce(live.layout, '{}'))
    returning * into draft;
  end if;

  -- The solution's rows keep their ids and carry no revision, workspace or process: they are given the draft's. A holder step keeps its
  -- child process only while that process may still sit inside this one (as restore_version checks).
  insert into public.steps
  select (jsonb_populate_record(null::public.steps,
    s.r || jsonb_build_object(
      'revision_id', draft.id,
      'workspace_id', proc.workspace_id,
      'process_id', proc.id,
      'created_at', now(),
      'updated_at', now(),
      'child_process_id', (select c.id from public.processes c where c.id = (s.r ->> 'child_process_id')::uuid and private.holder_allows(proc.id, c)
        and coalesce((select h.is_company and not proc.is_company from public.processes h where h.id = private.live_holder(c.id, proc.id)), true))))).*
  from jsonb_array_elements(sol.steps -> 'steps') as s(r);
  insert into public.edges
  select (jsonb_populate_record(null::public.edges,
    e.r || jsonb_build_object('revision_id', draft.id, 'workspace_id', proc.workspace_id, 'process_id', proc.id, 'created_at', now(), 'updated_at', now()))).*
  from jsonb_array_elements(sol.steps -> 'edges') as e(r);

  update public.processes p set draft_revision_id = draft.id where p.id = proc.id;
  update public.solutions s set status = 'adopted' where s.id = sol.id and s.status <> 'adopted';
  return jsonb_build_object('status', 'ok', 'revision_id', draft.id, 'number', draft.number, 'replaced_draft', had_draft);
end;
$$;

revoke all on function public.adopt_solution(uuid, boolean) from public, anon;
grant execute on function public.adopt_solution(uuid, boolean) to authenticated;
