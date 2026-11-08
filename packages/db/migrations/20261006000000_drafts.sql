-- Draft mode for processes (issue #9; docs/PRD.md §7.1b, decision D18).
--
-- Each process has one live (published) revision and at most one draft. The
-- first edit to a published process copies its live revision into a new draft
-- revision with the same step and edge ids (open_draft); every later edit goes
-- to that draft. Publishing makes the draft live in one transaction
-- (publish_process); discarding deletes it (discard_draft). Live revisions are
-- never edited in place, so simulation, the company map, forecasts, reports
-- and MCP reads of the live revision never see work in progress.
--
-- Strictly additive: two partial unique indexes, three RPCs (security
-- invoker, so RLS decides what the caller may do), a private helper, and two
-- triggers: one refuses step and edge writes by signed-in users outside a
-- draft revision, one writes audit_log entries for opening, publishing and
-- discarding drafts.
--
-- Rollback:
--   drop trigger if exists audit on public.process_revisions;
--   drop trigger if exists edit_drafts_only on public.steps;
--   drop trigger if exists edit_drafts_only on public.edges;
--   drop function if exists public.audit_revision_change();
--   drop function if exists public.edit_drafts_only();
--   drop function if exists public.publish_process(uuid, boolean);
--   drop function if exists public.discard_draft(uuid);
--   drop function if exists public.open_draft(uuid);
--   drop function if exists private.revision_changes(uuid, uuid);
--   drop index if exists public.process_revisions_one_draft;
--   drop index if exists public.process_revisions_one_published;
--   delete from supabase_migrations.schema_migrations where version = '20261006000000';

-- ---------------------------------------------------------------------------
-- At most one draft and one published revision per process
-- ---------------------------------------------------------------------------

create unique index process_revisions_one_draft on public.process_revisions (process_id) where status = 'draft';
create unique index process_revisions_one_published on public.process_revisions (process_id) where status = 'published';

-- ---------------------------------------------------------------------------
-- What changed between two revisions of a process (step and edge ids are
-- stable across revisions). Internal: used for the audit entry and returned by
-- publish_process. Bookkeeping columns don't count as changes.
-- ---------------------------------------------------------------------------

create function private.revision_changes(from_revision uuid, to_revision uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  with
    ignored as (select array['revision_id', 'created_at', 'updated_at', 'created_by'] as cols),
    ls as (select s.id, to_jsonb(s) - (select cols from ignored) as j from public.steps s where s.revision_id = from_revision),
    ds as (select s.id, to_jsonb(s) - (select cols from ignored) as j from public.steps s where s.revision_id = to_revision),
    le as (select e.id, to_jsonb(e) - (select cols from ignored) as j from public.edges e where e.revision_id = from_revision),
    de as (select e.id, to_jsonb(e) - (select cols from ignored) as j from public.edges e where e.revision_id = to_revision)
  select jsonb_build_object(
    'steps', jsonb_build_object(
      'added', coalesce((select jsonb_agg(ds.id order by ds.id) from ds where not exists (select 1 from ls where ls.id = ds.id)), '[]'),
      'removed', coalesce((select jsonb_agg(ls.id order by ls.id) from ls where not exists (select 1 from ds where ds.id = ls.id)), '[]'),
      'changed', coalesce((select jsonb_agg(ds.id order by ds.id) from ds join ls on ls.id = ds.id where ds.j <> ls.j), '[]')),
    'edges', jsonb_build_object(
      'added', coalesce((select jsonb_agg(de.id order by de.id) from de where not exists (select 1 from le where le.id = de.id)), '[]'),
      'removed', coalesce((select jsonb_agg(le.id order by le.id) from le where not exists (select 1 from de where de.id = le.id)), '[]'),
      'changed', coalesce((select jsonb_agg(de.id order by de.id) from de join le on le.id = de.id where de.j <> le.j), '[]')));
$$;

revoke all on function private.revision_changes(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- open_draft: the process's draft revision, created from live if there is none
-- ---------------------------------------------------------------------------

-- Returns {status: 'ok', revision_id, number, created} or {status: 'not_found'}
-- (no such process, or the caller may not edit it). Race-safe: the process row
-- is locked first, so two editors opening at once end up in the same draft;
-- the partial unique index is the backstop.
create function public.open_draft(target_process uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  proc public.processes;
  live public.process_revisions;
  draft public.process_revisions;
begin
  -- FOR UPDATE applies the update policy too: a process the caller can't edit is not found.
  select * into proc from public.processes p where p.id = target_process for update;
  if proc.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into draft from public.process_revisions r where r.process_id = proc.id and r.status = 'draft';
  if draft.id is not null then
    if proc.draft_revision_id is distinct from draft.id then
      update public.processes p set draft_revision_id = draft.id where p.id = proc.id;
    end if;
    return jsonb_build_object('status', 'ok', 'revision_id', draft.id, 'number', draft.number, 'created', false);
  end if;

  select * into live from public.process_revisions r where r.id = proc.live_revision_id;

  insert into public.process_revisions (workspace_id, process_id, number, status, layout)
  values (
    proc.workspace_id,
    proc.id,
    coalesce((select max(r.number) from public.process_revisions r where r.process_id = proc.id), 0) + 1,
    'draft',
    coalesce(live.layout, '{}'))
  returning * into draft;

  if live.id is not null then
    -- Every column is copied (so columns added later come along), with the
    -- same ids; steps first, as edges reference them.
    insert into public.steps
    select (jsonb_populate_record(null::public.steps,
      to_jsonb(s) || jsonb_build_object('revision_id', draft.id, 'created_at', now(), 'updated_at', now()))).*
    from public.steps s where s.revision_id = live.id;
    insert into public.edges
    select (jsonb_populate_record(null::public.edges,
      to_jsonb(e) || jsonb_build_object('revision_id', draft.id, 'created_at', now(), 'updated_at', now()))).*
    from public.edges e where e.revision_id = live.id;
  end if;

  update public.processes p set draft_revision_id = draft.id where p.id = proc.id;
  return jsonb_build_object('status', 'ok', 'revision_id', draft.id, 'number', draft.number, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- discard_draft: delete the draft (its steps and edges go with it)
-- ---------------------------------------------------------------------------

-- Returns {status: 'discarded', revision_id}, {status: 'no_draft'} or {status: 'not_found'}.
create function public.discard_draft(target_process uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  proc public.processes;
  draft_id uuid;
begin
  select * into proc from public.processes p where p.id = target_process for update;
  if proc.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select r.id into draft_id from public.process_revisions r where r.process_id = proc.id and r.status = 'draft';
  if draft_id is null then
    return jsonb_build_object('status', 'no_draft');
  end if;
  update public.processes p set draft_revision_id = null where p.id = proc.id;
  delete from public.process_revisions r where r.id = draft_id;
  return jsonb_build_object('status', 'discarded', 'revision_id', draft_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- publish_process: make the draft live
-- ---------------------------------------------------------------------------

-- Returns one of
--   {status: 'published', revision_id, number, previous_revision_id, changes}
--   {status: 'unresolved', steps: [{id, name, assumption, conflict}]}  (nothing written)
--   {status: 'no_draft'} | {status: 'not_found'}
-- Publishing is refused while a step of the draft is an assumption or a
-- conflict, unless accept_estimates is true; the choice is recorded in the
-- audit entry. The draft's number is already one above every other revision,
-- so live's number goes up by one. The old live revision becomes superseded.
create function public.publish_process(target_process uuid, accept_estimates boolean default false) returns jsonb
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

revoke execute on function public.open_draft(uuid) from public, anon;
revoke execute on function public.discard_draft(uuid) from public, anon;
revoke execute on function public.publish_process(uuid, boolean) from public, anon;
grant execute on function public.open_draft(uuid) to authenticated;
grant execute on function public.discard_draft(uuid) to authenticated;
grant execute on function public.publish_process(uuid, boolean) to authenticated;
-- publish_process (security invoker) builds its reply with it.
grant execute on function private.revision_changes(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Signed-in users edit drafts only
-- ---------------------------------------------------------------------------

-- Steps and edges of published and superseded revisions are fixed for signed-in
-- users: edits go into the draft. Cascades from deleting a revision or a
-- process run as the table owner and are not affected, nor are the seed and
-- migrations.
create function public.edit_drafts_only() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rev uuid;
  rev_status text;
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  foreach rev in array array[
    case when tg_op <> 'INSERT' then old.revision_id end,
    case when tg_op <> 'DELETE' then new.revision_id end
  ] loop
    continue when rev is null;
    select r.status into rev_status from public.process_revisions r where r.id = rev;
    if rev_status is not null and rev_status <> 'draft' then
      raise exception 'Revision % is %: edits go into the process''s draft', rev, rev_status using errcode = '55000';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;

create trigger edit_drafts_only before insert or update or delete on public.steps
  for each row execute function public.edit_drafts_only();
create trigger edit_drafts_only before insert or update or delete on public.edges
  for each row execute function public.edit_drafts_only();

-- ---------------------------------------------------------------------------
-- Audit: opening, publishing and discarding drafts
-- ---------------------------------------------------------------------------

create function public.audit_revision_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  kind text := case
    when auth.jwt() ? 'api_token_id' then 'mcp'
    when auth.uid() is not null then 'user'
    else 'system' end;
  action text;
  diff jsonb;
  previous public.process_revisions;
  estimates jsonb;
begin
  if tg_op = 'INSERT' and new.status = 'draft' then
    action := 'open_draft';
    select r.* into previous from public.processes p join public.process_revisions r on r.id = p.live_revision_id
    where p.id = new.process_id;
    diff := jsonb_build_object('revision_id', new.id, 'number', new.number,
      'from_revision_id', previous.id, 'from_number', previous.number);
  elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'published' then
    action := 'publish';
    -- publish_process points the process at the new revision after this runs.
    select r.* into previous from public.processes p join public.process_revisions r on r.id = p.live_revision_id
    where p.id = new.process_id and r.id <> new.id;
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'assumption', s.assumption, 'conflict', s.conflict)
      order by s.name, s.id), '[]')
      into estimates
    from public.steps s where s.revision_id = new.id and (s.assumption or s.conflict);
    diff := jsonb_build_object(
      'revision_id', new.id,
      'number', new.number,
      'previous_revision_id', previous.id,
      'previous_number', previous.number,
      'accept_estimates', coalesce(current_setting('transpera.accept_estimates', true), '') = 'on',
      'estimates', estimates,
      'changes', private.revision_changes(previous.id, new.id));
  elsif tg_op = 'DELETE' and old.status = 'draft' then
    action := 'discard_draft';
    diff := jsonb_build_object('revision_id', old.id, 'number', old.number);
  else
    return null;
  end if;

  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (coalesce(new.workspace_id, old.workspace_id), auth.uid(), kind, action, 'processes',
    coalesce(new.process_id, old.process_id), diff);
  return null;
end;
$$;

revoke execute on function public.audit_revision_change() from public, anon, authenticated;

create trigger audit after insert or update of status or delete on public.process_revisions
  for each row execute function public.audit_revision_change();
