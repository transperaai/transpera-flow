-- Process history (docs/plans/redesign-plan.md A40; issue #105).
--
-- The History screen lists a process's published versions and lets an editor
-- restore one into the draft or duplicate one as a new process. No table or
-- column changes: four functions only (three public, one private helper). (Headline numbers are not stored: the
-- browser simulates each version, so no results table is needed.)
--
--   * `revision_history(process)`: every published and superseded revision of
--     a process with when it was published, by whom (a person's name, or the
--     kind of actor: user, mcp or system, from the audit log) and what changed
--     since the version before it: counts of steps and connections added,
--     removed and changed (moving a step on the canvas is not a change).
--     SECURITY DEFINER because auth.users and the audit log are not readable by
--     every member; it returns rows only to someone who can read the workspace,
--     and shows an email only to someone who manages it.
--   * `restore_version(process, revision, replace_draft)`: copies an old
--     revision into the process's draft (the same step and edge ids, as
--     open_draft does). Live is untouched: it changes on publish, as ever.
--     An open draft with changes is replaced only when `replace_draft` is true.
--     A step holding a child process that no longer sits inside this process is
--     kept as a plain step (its link is cleared), so the nesting rules hold.
--     SECURITY DEFINER, so it can write its own audit entry ("restore_version",
--     naming the version restored; the open_draft entry its draft insert would
--     write is rewritten into it). It checks `can_edit_workspace` itself and
--     writes only into the process's draft.
--   * `duplicate_version(revision, name)`: a new top-level process (kind, entity
--     name and description copied) whose first draft is a copy of that revision,
--     with new step and edge ids so the copy shares no issues or evidence with
--     the original. Child-process links are cleared (a child has one parent), and
--     split or replaced steps are left out. Editors only.
--
-- Preflight: none needed (adds functions only).
--
-- Rollback:
--   drop function if exists public.duplicate_version(uuid, text);
--   drop function if exists public.restore_version(uuid, uuid, boolean);
--   drop function if exists public.revision_history(uuid);
--   drop function if exists private.revision_change_counts(uuid, uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261118000000';

-- ---------------------------------------------------------------------------
-- revision_history
-- ---------------------------------------------------------------------------

-- Counts of what changed between two revisions, as private.revision_changes finds it, except that moving a
-- step (x, y) is not a change.
create function private.revision_change_counts(from_revision uuid, to_revision uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  with
    ignored as (select array['revision_id', 'created_at', 'updated_at', 'created_by', 'x', 'y'] as cols),
    ls as (select s.id, to_jsonb(s) - (select cols from ignored) as j from public.steps s where s.revision_id = from_revision),
    ds as (select s.id, to_jsonb(s) - (select cols from ignored) as j from public.steps s where s.revision_id = to_revision),
    le as (select e.id, to_jsonb(e) - (select cols from ignored) as j from public.edges e where e.revision_id = from_revision),
    de as (select e.id, to_jsonb(e) - (select cols from ignored) as j from public.edges e where e.revision_id = to_revision)
  select jsonb_build_object(
    'steps', jsonb_build_object(
      'added', (select count(*) from ds where not exists (select 1 from ls where ls.id = ds.id)),
      'removed', (select count(*) from ls where not exists (select 1 from ds where ds.id = ls.id)),
      'changed', (select count(*) from ds join ls on ls.id = ds.id where ds.j <> ls.j)),
    'edges', jsonb_build_object(
      'added', (select count(*) from de where not exists (select 1 from le where le.id = de.id)),
      'removed', (select count(*) from le where not exists (select 1 from de where de.id = le.id)),
      'changed', (select count(*) from de join le on le.id = de.id where de.j <> le.j)));
$$;

revoke all on function private.revision_change_counts(uuid, uuid) from public, anon, authenticated;

create function public.revision_history(target_process uuid)
returns table (
  revision_id uuid,
  number integer,
  status text,
  published_at timestamptz,
  author_kind text,
  author_name text,
  changes jsonb
)
language sql stable security definer
set search_path = ''
as $$
  select
    r.id,
    r.number,
    r.status,
    r.published_at,
    a.actor_kind,
    coalesce(per.name, case when public.can_manage_workspace(r.workspace_id) then u.email end),
    -- Against the published version before it; none for the first.
    case when prev.id is not null then private.revision_change_counts(prev.id, r.id) end
  from public.processes p
  join public.process_revisions r on r.process_id = p.id
  left join auth.users u on u.id = r.published_by
  left join public.memberships m on m.user_id = r.published_by and m.workspace_id = r.workspace_id
  left join public.people per on per.id = m.person_id and per.workspace_id = r.workspace_id
  left join lateral (
    select l.actor_kind
    from public.audit_log l
    where l.workspace_id = r.workspace_id
      and l.target_table = 'processes' and l.target_id = p.id and l.action = 'publish' and l.diff ->> 'revision_id' = r.id::text
    order by l.created_at desc
    limit 1
  ) a on true
  left join lateral (
    select q.id from public.process_revisions q
    where q.process_id = p.id and q.status in ('published', 'superseded') and q.number < r.number
    order by q.number desc
    limit 1
  ) prev on true
  where p.id = target_process
    and public.can_read_workspace(p.workspace_id)
    and r.status in ('published', 'superseded')
  order by r.number desc;
$$;

-- ---------------------------------------------------------------------------
-- restore_version
-- ---------------------------------------------------------------------------

-- Returns one of
--   {status: 'restored', revision_id, number, unlinked_children}
--   {status: 'draft_exists', number}   (the draft has changes and replace_draft is false; nothing written)
--   {status: 'already_live'}
--   {status: 'not_found'}              (no such process or version, a draft, or the caller may not edit it)
create function public.restore_version(target_process uuid, source_revision uuid, replace_draft boolean default false) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  proc public.processes;
  src public.process_revisions;
  draft public.process_revisions;
  unlinked integer;
  untouched constant jsonb := '{"steps":{"added":[],"removed":[],"changed":[]},"edges":{"added":[],"removed":[],"changed":[]}}';
  had_draft boolean;
  kind text := case
    when auth.jwt() ? 'api_token_id' then 'mcp'
    when auth.uid() is not null then 'user'
    else 'system' end;
  entry jsonb;
  ws uuid;
begin
  -- Security definer: the caller's right to edit is checked here, before the process row is locked, and only the
  -- process's draft is written.
  select p.workspace_id into ws from public.processes p where p.id = target_process;
  if ws is null or public.can_edit_workspace(ws) is not true then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into proc from public.processes p where p.id = target_process for update;
  if proc.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into src from public.process_revisions r where r.id = source_revision and r.process_id = proc.id;
  if src.id is null or src.status = 'draft' then
    return jsonb_build_object('status', 'not_found');
  end if;
  if src.id = proc.live_revision_id then
    return jsonb_build_object('status', 'already_live');
  end if;

  select * into draft from public.process_revisions r where r.process_id = proc.id and r.status = 'draft';
  had_draft := draft.id is not null;
  if draft.id is not null then
    -- A draft nobody has changed (just opened) is safe to replace; one with work in it needs a yes.
    if not coalesce(replace_draft, false)
       and (proc.live_revision_id is null
            and exists (select 1 from public.steps s where s.revision_id = draft.id)
            or proc.live_revision_id is not null and private.revision_changes(proc.live_revision_id, draft.id) <> untouched) then
      return jsonb_build_object('status', 'draft_exists', 'number', draft.number);
    end if;
    -- Edges go with their steps.
    delete from public.steps s where s.revision_id = draft.id;
    update public.process_revisions r set layout = src.layout where r.id = draft.id;
  else
    insert into public.process_revisions (workspace_id, process_id, number, status, layout)
    values (
      proc.workspace_id,
      proc.id,
      coalesce((select max(r.number) from public.process_revisions r where r.process_id = proc.id), 0) + 1,
      'draft',
      src.layout)
    returning * into draft;
  end if;

  -- A holder step keeps its child process only while that process still sits inside this one.
  select count(*) into unlinked from public.steps s
  where s.revision_id = src.id and s.child_process_id is not null
    and not exists (select 1 from public.processes c where c.id = s.child_process_id and c.parent_process_id = proc.id);

  insert into public.steps
  select (jsonb_populate_record(null::public.steps,
    to_jsonb(s) || jsonb_build_object(
      'revision_id', draft.id,
      'created_at', now(),
      'updated_at', now(),
      'child_process_id', (select c.id from public.processes c where c.id = s.child_process_id and c.parent_process_id = proc.id)))).*
  from public.steps s where s.revision_id = src.id;
  insert into public.edges
  select (jsonb_populate_record(null::public.edges,
    to_jsonb(e) || jsonb_build_object('revision_id', draft.id, 'created_at', now(), 'updated_at', now()))).*
  from public.edges e where e.revision_id = src.id;

  update public.processes p set draft_revision_id = draft.id where p.id = proc.id;

  -- One audit entry says what happened. A new draft already has an 'open_draft' entry (written by the trigger on the
  -- insert, in this transaction, saying it came from live); it is rewritten rather than followed by a second.
  entry := jsonb_build_object('revision_id', draft.id, 'number', draft.number, 'restored_from_revision_id', src.id,
    'restored_from_number', src.number, 'replaced_draft', had_draft);
  if not had_draft then
    update public.audit_log l set action = 'restore_version', diff = entry
    -- Narrowed to this workspace and this transaction's timestamp so it uses the (workspace_id, created_at) index.
    where l.workspace_id = proc.workspace_id and l.target_table = 'processes' and l.created_at = now()
      and l.target_id = proc.id and l.action = 'open_draft' and l.diff ->> 'revision_id' = draft.id::text;
  end if;
  if had_draft or not found then
    insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
    values (proc.workspace_id, auth.uid(), kind, 'restore_version', 'processes', proc.id, entry);
  end if;
  return jsonb_build_object('status', 'restored', 'revision_id', draft.id, 'number', draft.number, 'unlinked_children', unlinked);
end;
$$;

-- ---------------------------------------------------------------------------
-- duplicate_version
-- ---------------------------------------------------------------------------

-- Returns one of
--   {status: 'duplicated', process_id, revision_id}
--   {status: 'invalid_name'} | {status: 'name_taken'}
--   {status: 'not_found'}   (no such version, a draft, or the caller may not edit its workspace)
create function public.duplicate_version(source_revision uuid, new_name text) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  src public.process_revisions;
  proc public.processes;
  np public.processes;
  rev public.process_revisions;
  clean text := btrim(coalesce(new_name, ''));
  ids jsonb;
begin
  select * into src from public.process_revisions r where r.id = source_revision;
  if src.id is null or src.status = 'draft' or public.can_edit_workspace(src.workspace_id) is not true then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into proc from public.processes p where p.id = src.process_id;
  if clean = '' or char_length(clean) > 120 then
    return jsonb_build_object('status', 'invalid_name');
  end if;
  if exists (select 1 from public.processes p where p.workspace_id = src.workspace_id and lower(btrim(p.name)) = lower(clean)) then
    return jsonb_build_object('status', 'name_taken');
  end if;

  -- Top level of the company map, after the processes already there (the map lists by creation).
  insert into public.processes (workspace_id, name, kind, entity_name, description, source)
  values (src.workspace_id, clean, proc.kind, proc.entity_name, proc.description, 'manual')
  returning * into np;
  -- Signed-in users write drafts only, so the copy starts as the new process's draft.
  insert into public.process_revisions (workspace_id, process_id, number, status, layout)
  values (np.workspace_id, np.id, 1, 'draft', src.layout)
  returning * into rev;

  -- Old step id -> new step id, for the steps in use (split or replaced steps are left out).
  select coalesce(jsonb_object_agg(s.id::text, gen_random_uuid()::text), '{}') into ids
  from public.steps s where s.revision_id = src.id and cardinality(s.replaced_by) = 0;

  insert into public.steps
  select (jsonb_populate_record(null::public.steps,
    to_jsonb(s) || jsonb_build_object(
      'id', ids ->> s.id::text,
      'revision_id', rev.id,
      'process_id', np.id,
      'rework_to_step_id', ids ->> s.rework_to_step_id::text,
      'parent_step_id', ids ->> s.parent_step_id::text,
      'entry_step_id', ids ->> s.entry_step_id::text,
      'child_process_id', null::uuid,
      'created_at', now(),
      'updated_at', now(),
      'created_by', auth.uid()))).*
  from public.steps s where s.revision_id = src.id and cardinality(s.replaced_by) = 0;
  insert into public.edges
  select (jsonb_populate_record(null::public.edges,
    to_jsonb(e) || jsonb_build_object(
      'id', gen_random_uuid(),
      'revision_id', rev.id,
      'process_id', np.id,
      'from_step_id', ids ->> e.from_step_id::text,
      'to_step_id', ids ->> e.to_step_id::text,
      'created_at', now(),
      'updated_at', now(),
      'created_by', auth.uid()))).*
  from public.edges e
  where e.revision_id = src.id and ids ? e.from_step_id::text and ids ? e.to_step_id::text;

  update public.processes p set draft_revision_id = rev.id where p.id = np.id;
  return jsonb_build_object('status', 'duplicated', 'process_id', np.id, 'revision_id', rev.id);
end;
$$;

revoke execute on function public.revision_history(uuid) from public, anon;
revoke execute on function public.restore_version(uuid, uuid, boolean) from public, anon;
revoke execute on function public.duplicate_version(uuid, text) from public, anon;
grant execute on function public.revision_history(uuid) to authenticated;
grant execute on function public.restore_version(uuid, uuid, boolean) to authenticated;
grant execute on function public.duplicate_version(uuid, text) to authenticated;
