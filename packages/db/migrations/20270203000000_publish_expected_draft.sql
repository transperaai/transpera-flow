-- Publishing names the draft the editor shows (security review: "publishing a draft the user never saw").
--
-- `public.publish_process(target_process, accept_estimates)` published whatever draft the process had when it ran. If someone else
-- published or discarded the draft this editor was showing and a new draft was then opened (by them, or by an MCP token), Publish
-- made that other draft live: changes the person pressing the button had never seen.
--
-- What it does:
--   1. Drops `public.publish_process(uuid, boolean)` and creates `public.publish_process(target_process uuid, accept_estimates boolean
--      default false, expected_draft uuid default null)`: the same body (20261006000000_drafts.sql, the only definition), plus one
--      check after the draft is found under the process's row lock. When `expected_draft` is given and is not the process's draft,
--      it raises SQLSTATE 55000 (object_not_in_prerequisite_state) with the message 'draft changed: ...' and writes nothing. The app
--      (apps/web/src/app/w/[slug]/actions.ts publishDraft) always passes the draft id the editor holds and maps that error to "This
--      draft changed since you opened it ... Reload". Null keeps the old behaviour, for a caller that has no draft id (none today;
--      the MCP server publishes nothing).
--   2. The same grants as before: execute for `authenticated` only. Still security invoker, so row-level security and the version
--      rules (20261128500000_harden_versions.sql) apply to every write as before.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270203000000';` expect 0.
--     Locks: replacing a function takes none on tables. Deploy the app after this (the old app's two-argument call still resolves,
--     since the third argument has a default).
-- Post-apply checks: select pg_get_function_identity_arguments('public.publish_process'::regproc);
--     expect 'target_process uuid, accept_estimates boolean, expected_draft uuid'.
--
-- ROLLBACK (run as one transaction):
--
--   begin;
--   drop function public.publish_process(uuid, boolean, uuid);
--   -- Re-run the `create function public.publish_process(...)` block and its revoke/grant lines from 20261006000000_drafts.sql.
--   delete from public.schema_migrations where version = '20270203000000';
--   commit;

drop function public.publish_process(uuid, boolean);

create function public.publish_process(target_process uuid, accept_estimates boolean default false, expected_draft uuid default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  proc public.processes;
  draft public.process_revisions;
  unresolved jsonb;
  next_number integer;
begin
  select * into proc from public.processes p where p.id = target_process for update;
  if proc.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into draft from public.process_revisions r where r.process_id = proc.id and r.status = 'draft';
  if draft.id is null then
    return jsonb_build_object('status', 'no_draft');
  end if;
  -- The draft the caller saw is gone and another took its place: publish nothing they haven't seen.
  if expected_draft is not null and draft.id is distinct from expected_draft then
    raise exception 'draft changed: the process''s draft is no longer the one being published' using errcode = '55000';
  end if;

  select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'assumption', s.assumption, 'conflict', s.conflict) order by s.name, s.id)
    into unresolved
  from public.steps s where s.revision_id = draft.id and (s.assumption or s.conflict);
  if unresolved is not null and not coalesce(accept_estimates, false) then
    return jsonb_build_object('status', 'unresolved', 'steps', unresolved);
  end if;

  next_number := coalesce((select max(r.number) from public.process_revisions r where r.process_id = proc.id and r.id <> draft.id), 0) + 1;

  -- Read by the audit trigger (transaction-local).
  perform set_config('transpera.accept_estimates', case when coalesce(accept_estimates, false) then 'on' else 'off' end, true);

  -- Superseded first (one published revision per process), then the draft,
  -- then the process: the audit trigger reads the previous live revision from it.
  update public.process_revisions r set status = 'superseded' where r.process_id = proc.id and r.status = 'published';
  update public.process_revisions r
  set status = 'published', number = next_number, published_at = now(), published_by = auth.uid()
  where r.id = draft.id;
  update public.processes p set live_revision_id = draft.id, draft_revision_id = null where p.id = proc.id;

  perform set_config('transpera.accept_estimates', '', true);

  return jsonb_build_object(
    'status', 'published',
    'revision_id', draft.id,
    'number', next_number,
    'previous_revision_id', proc.live_revision_id,
    'changes', private.revision_changes(proc.live_revision_id, draft.id));
end;
$$;

revoke execute on function public.publish_process(uuid, boolean, uuid) from public, anon;
grant execute on function public.publish_process(uuid, boolean, uuid) to authenticated;
