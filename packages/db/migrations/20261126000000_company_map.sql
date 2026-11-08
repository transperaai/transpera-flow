-- The company map is a stored process (issue #163, B11 slice 1 of 2; PRD D26 and D39).
--
-- Until now the Overview built the company map on the fly (apps/web/src/lib/overview/company-map.ts): fake id
-- "company", computed positions, a made-up edge from every pipeline to every servicing process. This migration makes it
-- a real process per workspace, with a live revision whose steps are holders, one per top-level process, at stored
-- positions, with stored handoff edges between them. Slice 2 lets people edit it (drafts, publish, history).
--
-- Strictly additive:
--   * `public.processes.is_company boolean not null default false`, the unique index `processes_one_company_per_workspace`
--     (at most one per workspace), the check `processes_company_is_top` (the company map has no parent);
--   * `private.company_process_guard` and `private.company_revision_guard` (triggers `company_process_guard` on
--     `processes`, `company_revision_guard` on `process_revisions`) and `private.company_signed_in`: until the editor
--     arrives (slice 2) nobody signed in creates, renames, re-kinds, re-parents, deletes or re-points a company
--     process, nobody makes it a process's parent, and nobody creates, changes or deletes its revisions (which stops
--     open_draft, publish_process, restore_version and duplicate_version on it). A workspace's deletion still
--     removes it; `public.duplicate_version` is redefined (a full copy of 20261118000000's) to refuse copying it;
--   * `private.holder_allows(owner, child)`: the ONE place that says which process may hold which. `check_step_nesting`
--     is redefined (a full copy of 20261108000000's) to call it. The rule today: a child process is held by its parent
--     process; the company map holds the processes that have NO parent (so a process is held once, never twice: a
--     process with a parent is refused on the company map, and a parent-less one is refused anywhere else). B12 (#164)
--     relaxes this one function to let any process hold others;
--   * `private.ensure_company_map`, `private.company_layout_insert`, `private.sync_company_map`,
--     `private.relayout_company_map`, `private.company_map_before_delete`, `private.company_map_membership`,
--     `private.company_map_new_workspace` and the triggers `company_map_before_delete`, `company_map_membership` (on
--     `processes`) and `company_map_new_workspace` (on `workspaces`): a new workspace gets its company map, a new
--     top-level process gets a holder in it, a deleted or nested one loses its holder, a renamed one renames it.
--     Placing a process on the map NEVER writes to the placed process: the link is the holder step's
--     `child_process_id`, in the company map's revision only;
--   * a backfill: every existing workspace gets one company process with a published revision 1 whose holders are
--     laid out as today's Overview lays them out (pipelines in the first column, servicing processes in the second,
--     each column centred on the tallest; one card is 192 x 124 with 96 between columns and 36 between rows) and
--     one handoff edge from each pipeline to each servicing process, as drawn today. Processes never published get a
--     holder too, below the others in their column (the Overview shows a card only once the process has a live revision).
-- The engine never simulates the company process: it is left out of every list of processes (queries.ts) and
-- `toEngineModel` refuses it. Its holders and edges are layout only. `save_fields` and `open_draft` are unchanged.
--
-- Preflight (production):
--   1. Nothing of ours is applied past 20261125500000. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261126000000';
--   2. 20261108000000 (nested_processes) is applied. Expect 1 row:
--        select version from supabase_migrations.schema_migrations where version = '20261108000000';
--   3. The column does not exist yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'processes' and column_name = 'is_company';
--   4. The function this one redefines is as reviewed. Expect one row, true:
--        select prosrc like '%child.parent_process_id is distinct from owner%' from pg_proc where pronamespace = 'private'::regnamespace and proname = 'check_step_nesting';
--   4b. duplicate_version, which it redefines, is the 20261118000000 one. Expect one row, true:
--        select prosrc not like '%is_company%' and prosrc like '%Top level of the company map%' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'duplicate_version';
--   5. How many workspaces get a company process, and how many top-level processes get a holder. Note both:
--        select (select count(*) from public.workspaces) as workspaces,
--               (select count(*) from public.processes where parent_process_id is null) as top_level_processes;
--
-- Post-apply checks:
--   1. One company process per workspace. Expect 0 rows:
--        select w.id from public.workspaces w where (select count(*) from public.processes p where p.workspace_id = w.id and p.is_company) <> 1;
--   2. One holder per top-level process: expect the count to equal preflight 5's top_level_processes:
--        select count(*) from public.steps s join public.processes c on c.id = s.process_id and c.is_company;
--   3. Grants: no new table. Anon and PUBLIC may execute none of the new private functions. Expect 0 rows:
--        select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee in ('anon', 'PUBLIC')
--          and routine_name in ('ensure_company_map', 'company_layout_insert', 'sync_company_map', 'relayout_company_map', 'company_map_before_delete', 'company_map_membership', 'company_map_new_workspace', 'holder_allows', 'company_process_guard', 'company_revision_guard', 'company_signed_in');
--   4. Authenticated may execute only the two the guards and the nesting check call as the signed-in caller. Expect exactly
--      company_signed_in and holder_allows:
--        select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee = 'authenticated'
--          and routine_name in ('ensure_company_map', 'company_layout_insert', 'sync_company_map', 'relayout_company_map', 'company_map_before_delete', 'company_map_membership', 'company_map_new_workspace', 'holder_allows', 'company_process_guard', 'company_revision_guard', 'company_signed_in') order by 1;
--
-- Rollback (newest first; run in one transaction). FIRST revert or redeploy the app to a build from before this
-- migration (the app selects processes.is_company; dropping the column under it breaks every process list). It
-- deletes every company process, with its revisions, holders and handoff lines (the Overview then draws the map as
-- before this migration), and puts check_step_nesting back as 20261108000000 had it:
--
--   begin;
--   drop trigger company_map_new_workspace on public.workspaces;
--   drop trigger company_map_membership on public.processes;
--   drop trigger company_map_before_delete on public.processes;
--   drop trigger company_revision_guard on public.process_revisions;
--   drop trigger company_process_guard on public.processes;
--   -- The guard is gone, so the company processes can be deleted now (their revisions, steps and edges cascade).
--   delete from public.processes where is_company;
--   drop function private.company_map_new_workspace();
--   drop function private.company_map_membership();
--   drop function private.company_map_before_delete();
--   drop function private.relayout_company_map(uuid);
--   drop function private.sync_company_map(uuid);
--   drop function private.company_layout_insert(uuid, uuid);
--   drop function private.ensure_company_map(uuid);
--   drop function private.company_process_guard();
--   drop function private.company_revision_guard();
--   drop function private.company_signed_in();
--   -- Restore duplicate_version: run `create or replace function public.duplicate_version(uuid, text)` with the body in
--   -- packages/db/supabase/migrations/20261118000000_process_history.sql (without the refusal for a company map).
--   -- Restore check_step_nesting: run `create or replace function private.check_step_nesting()` with the body in
--   -- packages/db/supabase/migrations/20261108000000_nested_processes.sql (it does not call holder_allows).
--   drop function private.holder_allows(uuid, public.processes);
--   drop index public.processes_one_company_per_workspace;
--   alter table public.processes drop constraint processes_company_is_top, drop column is_company;
--   delete from supabase_migrations.schema_migrations where version = '20261126000000';
--   commit;

-- ---------------------------------------------------------------------------
-- The marker
-- ---------------------------------------------------------------------------

alter table public.processes
  add column is_company boolean not null default false,
  add constraint processes_company_is_top check (not is_company or parent_process_id is null);

create unique index processes_one_company_per_workspace on public.processes (workspace_id) where is_company;

-- Who changes the company map. Until its editor arrives (slice 2), only the system does: the functions below set
-- `transpera.company_system` for the one place they write the company process or its revision (ensure_company_map).
-- "The system" is anyone not signed in (no JWT subject, and not the authenticated or anon role); a signed-in person,
-- over PostgREST, MCP or a security-definer function they call (restore_version), is refused.
--   * nobody makes a company process, flips the marker, deletes it or renames it, changes its kind, parent or
--     revision pointers (a live_revision_id set to null would leave sync with nothing to keep in step);
--   * no process may take the company map as its parent (it holds processes by link, not by parent);
--   * the company map's revisions can't be created, changed or deleted by a signed-in person (this stops
--     open_draft, publish_process, restore_version and duplicate_version on it, which all write a revision). Deleting
--     the workspace still removes everything: the workspace is gone by then, as for check_process_parent.
create function private.company_signed_in() returns boolean
language sql stable
set search_path = ''
as $$
  -- The system flag is honoured only for a caller that is not itself authenticated or anon (the owner, inside
  -- ensure_company_map): a signed-in role can set any setting, so for it the flag means nothing.
  select (auth.uid() is not null or current_user in ('authenticated', 'anon'))
     and not (coalesce(current_setting('transpera.company_system', true), '') = 'on' and current_user not in ('authenticated', 'anon'));
$$;

create function private.company_process_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' and new.parent_process_id is not null
     and exists (select 1 from public.processes p where p.id = new.parent_process_id and p.is_company) then
    raise exception 'The company map holds processes by link: it can''t be a process''s parent' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.is_company and private.company_signed_in() then
      raise exception 'The company map is made by the system, not inserted' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.is_company is distinct from old.is_company then
      raise exception 'A process cannot become, or stop being, the company map' using errcode = '23514';
    end if;
    if old.is_company and private.company_signed_in()
       and (new.name, new.kind, new.parent_process_id, new.live_revision_id, new.draft_revision_id)
           is distinct from (old.name, old.kind, old.parent_process_id, old.live_revision_id, old.draft_revision_id) then
      raise exception 'The company map can''t be changed yet: editing it arrives with its editor' using errcode = '55000';
    end if;
    return new;
  end if;
  if old.is_company and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    raise exception 'The company map can''t be deleted' using errcode = '23514';
  end if;
  return old;
end;
$$;

create function private.company_revision_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r public.process_revisions := case when tg_op = 'DELETE' then old else new end;
begin
  if private.company_signed_in()
     and exists (select 1 from public.processes p where p.id = r.process_id and p.is_company)
     and exists (select 1 from public.workspaces w where w.id = r.workspace_id) then
    raise exception 'The company map can''t be versioned yet: editing it arrives with its editor' using errcode = '55000';
  end if;
  return r;
end;
$$;

revoke all on function private.company_signed_in() from public, anon;
-- The guards run as the signed-in caller.
grant execute on function private.company_signed_in() to authenticated;
revoke all on function private.company_process_guard() from public, anon, authenticated;
revoke all on function private.company_revision_guard() from public, anon, authenticated;

create trigger company_process_guard before insert or update of is_company, name, kind, parent_process_id, live_revision_id, draft_revision_id or delete on public.processes
  for each row execute function private.company_process_guard();
create trigger company_revision_guard before insert or update or delete on public.process_revisions
  for each row execute function private.company_revision_guard();

-- duplicate_version writes a NEW process, so the revision guard can't see it is a copy of the company map: a full copy
-- of 20261118000000's with one added refusal (the company map's versions can't be copied yet).
create or replace function public.duplicate_version(source_revision uuid, new_name text) returns jsonb
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
  if proc.is_company then
    return jsonb_build_object('status', 'not_found');
  end if;
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

-- ---------------------------------------------------------------------------
-- Who may hold whom: one place
-- ---------------------------------------------------------------------------

-- A holder step (kind 'subprocess' with child_process_id) in a revision of process `owner` may hold `child` when:
--   * `child` is a child process of `owner` (its parent is the owner), as before; or
--   * `owner` is a company map and `child` is a top-level process (no parent) that is not itself a company map.
-- A process is held once: a child has its parent, a top-level process the company map. B12 (#164) relaxes this
-- function (and nothing else) to let ordinary processes hold others.
create function private.holder_allows(owner uuid, child public.processes) returns boolean
language sql stable
set search_path = ''
as $$
  select (owner is not null and child.parent_process_id is not distinct from owner
          and not exists (select 1 from public.processes o where o.id = owner and o.is_company))
      or (child.parent_process_id is null and not child.is_company
          and exists (select 1 from public.processes o where o.id = owner and o.is_company));
$$;

revoke all on function private.holder_allows(uuid, public.processes) from public, anon;
-- The nesting trigger runs as the signed-in caller.
grant execute on function private.holder_allows(uuid, public.processes) to authenticated;

-- A full copy of 20261108000000's, with the holder rule moved into holder_allows.
create or replace function private.check_step_nesting() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cur public.steps;
  holder public.steps;
  entry public.steps;
  child public.processes;
  owner uuid;
begin
  -- Deferred: by commit the row may have been changed again or deleted, so check what is there now, not the row
  -- this event saw.
  select * into cur from public.steps s where s.revision_id = new.revision_id and s.id = new.id;
  if not found then
    return null;
  end if;

  if cur.parent_step_id is not null then
    select * into holder from public.steps s where s.revision_id = cur.revision_id and s.id = cur.parent_step_id;
    if holder.id is null or holder.kind <> 'group' then
      raise exception 'Step % can only sit inside a group', cur.name using errcode = '23514';
    end if;
    if exists (
      with recursive up(id) as (
        select cur.parent_step_id
        union
        select s.parent_step_id from public.steps s join up on s.revision_id = cur.revision_id and s.id = up.id where s.parent_step_id is not null
      )
      select 1 from up where id = cur.id
    ) then
      raise exception 'Step % cannot sit inside itself', cur.name using errcode = '23514';
    end if;
  end if;

  if cur.entry_step_id is not null then
    select * into entry from public.steps s where s.revision_id = cur.revision_id and s.id = cur.entry_step_id;
    if entry.id is null or entry.parent_step_id is distinct from cur.id then
      raise exception 'The first step of group % must be one of its own steps', cur.name using errcode = '23514';
    end if;
  end if;

  -- A step that is some group's first step stays in that group.
  if exists (select 1 from public.steps g where g.revision_id = cur.revision_id and g.entry_step_id = cur.id and g.id is distinct from cur.parent_step_id) then
    raise exception 'Step % is the first step of a group, so it must stay in that group (or change the group''s first step)', cur.name using errcode = '23514';
  end if;

  if cur.child_process_id is not null then
    select * into child from public.processes p where p.id = cur.child_process_id;
    -- The step's process comes from its revision, not from the step's own (denormalised) process_id.
    select r.process_id into owner from public.process_revisions r where r.id = cur.revision_id;
    if not private.holder_allows(owner, child) then
      raise exception 'Process % must be a child of this step''s process to sit in step % (or, on the company map, a process with no parent)', child.name, cur.name using errcode = '23514';
    end if;
  end if;

  -- A group that stops being a group can't leave steps inside it.
  if cur.kind <> 'group'
     and exists (select 1 from public.steps s where s.revision_id = cur.revision_id and s.parent_step_id = cur.id) then
    raise exception 'Step % holds steps, so it must stay a group', cur.name using errcode = '23514';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- The company map of a workspace
-- ---------------------------------------------------------------------------

-- The workspace's company process, made with an empty published revision 1 if it has none. Null when the workspace is
-- gone (it is being deleted). Security definer: it writes only rows of that workspace.
create function private.ensure_company_map(p_ws uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  cid uuid;
  rid uuid;
begin
  select p.id into cid from public.processes p where p.workspace_id = p_ws and p.is_company;
  if cid is not null then
    return cid;
  end if;
  if not exists (select 1 from public.workspaces w where w.id = p_ws) then
    return null;
  end if;
  cid := gen_random_uuid();
  rid := gen_random_uuid();
  -- The guards let the system through, whoever's statement this runs inside (create_workspace, say).
  perform set_config('transpera.company_system', 'on', true);
  insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, is_company, created_by)
  values (cid, p_ws, 'Company map', 'pipeline', 'process', 'Every process in the business, as a map.', 'manual', true, null);
  insert into public.process_revisions (id, workspace_id, process_id, number, status, published_at, created_by)
  values (rid, p_ws, cid, 1, 'published', now(), null);
  update public.processes set live_revision_id = rid where id = cid;
  perform set_config('transpera.company_system', '', true);
  return cid;
end;
$$;

-- Holders, one per top-level process of the workspace that has none in revision `p_rev`, laid out as the Overview lays
-- out the closed company map: sales pipelines in column 0 (x = 0), servicing processes in column 1 (x = 288), always (so
-- a later pipeline goes in column 0 even when the first ones were servicing); cards 192 x 124, 96 between columns, 36 between rows, each column centred on the tallest. Published
-- processes are laid out first, in creation order; the ones never published follow below them. Then one handoff edge
-- from each pipeline to each servicing process (the Overview draws one only when both cards are there).
create function private.company_layout_insert(p_ws uuid, p_rev uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  cid uuid;
begin
  select r.process_id into cid from public.process_revisions r where r.id = p_rev;
  with t as (
    select p.id, p.name, (p.kind = 'servicing') as svc, (p.live_revision_id is not null) as live, p.created_at
    from public.processes p
    where p.workspace_id = p_ws and not p.is_company and p.parent_process_id is null
      and not exists (select 1 from public.steps s where s.revision_id = p_rev and s.child_process_id = p.id)
  ), n as (
    select t.*,
      row_number() over (partition by svc order by (not live), created_at, id) as rn,
      count(*) filter (where live) over (partition by svc) as nlive
    from t
  ), h as (
    select n.*, case when nlive > 0 then nlive * 124 + (nlive - 1) * 36 else 0 end as colh from n
  )
  insert into public.steps (revision_id, workspace_id, process_id, name, kind, child_process_id, x, y)
  select p_rev, p_ws, cid, h.name, 'subprocess', h.id,
    case when h.svc then 288 else 0 end,
    (select max(h2.colh) from h h2) / 2.0 - h.colh / 2.0 + (h.rn - 1) * 160
  from h;
  insert into public.edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability)
  select p_rev, p_ws, cid, a.id, b.id, 1
  from public.steps a
  join public.processes pa on pa.id = a.child_process_id and pa.kind <> 'servicing'
  join public.steps b on b.revision_id = a.revision_id
  join public.processes pb on pb.id = b.child_process_id and pb.kind = 'servicing'
  where a.revision_id = p_rev
    and not exists (select 1 from public.edges e where e.revision_id = p_rev and e.from_step_id = a.id and e.to_step_id = b.id);
end;
$$;

-- Brings the company map's live revision (and its open draft, if any) in line with the workspace's processes: a holder
-- for each top-level process that has none, none for a process that is gone or has a parent. On an empty revision it
-- lays everything out as the Overview does; otherwise a new holder goes at the bottom of its column, with a handoff
-- line to each holder of the other kind. Never touches the placed processes, and never moves a holder that is there.
create function private.sync_company_map(p_ws uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  cid uuid;
  rid uuid;
  np record;
  nx numeric;
  ny numeric;
  hid uuid;
begin
  cid := private.ensure_company_map(p_ws);
  if cid is null then
    return;
  end if;
  -- One sync at a time per workspace: two processes made together each get their own place and lines.
  perform 1 from public.processes c where c.id = cid for update;
  for rid in
    select r.id from public.process_revisions r join public.processes c on c.id = r.process_id
    where c.id = cid and r.id in (c.live_revision_id, c.draft_revision_id)
  loop
    delete from public.steps s
    where s.revision_id = rid and s.kind = 'subprocess'
      and (s.child_process_id is null
           or exists (select 1 from public.processes q where q.id = s.child_process_id and q.parent_process_id is not null));
    if not exists (select 1 from public.steps s where s.revision_id = rid and s.child_process_id is not null) then
      perform private.company_layout_insert(p_ws, rid);
      continue;
    end if;
    for np in
      select p.id, p.name, p.kind from public.processes p
      where p.workspace_id = p_ws and not p.is_company and p.parent_process_id is null
        and not exists (select 1 from public.steps s where s.revision_id = rid and s.child_process_id = p.id)
      order by p.created_at, p.id
    loop
      nx := case when np.kind = 'servicing' then 288 else 0 end;
      select coalesce(max(s.y) + 160, 0) into ny from public.steps s where s.revision_id = rid and s.x = nx;
      hid := gen_random_uuid();
      insert into public.steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id, x, y)
      values (hid, rid, p_ws, cid, np.name, 'subprocess', np.id, nx, ny);
      insert into public.edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability)
      select rid, p_ws, cid,
        case when np.kind = 'servicing' then s.id else hid end,
        case when np.kind = 'servicing' then hid else s.id end, 1
      from public.steps s join public.processes q on q.id = s.child_process_id
      where s.revision_id = rid and s.id <> hid and (q.kind = 'servicing') <> (np.kind = 'servicing');
    end loop;
  end loop;
end;
$$;

-- Starts the company map's live revision over, as the Overview would lay it out today. Used after the seed and by the
-- backfill below; the app never calls it (it would undo people's moves).
create function private.relayout_company_map(p_ws uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  cid uuid;
  rid uuid;
begin
  cid := private.ensure_company_map(p_ws);
  if cid is null then
    return;
  end if;
  select p.live_revision_id into rid from public.processes p where p.id = cid;
  delete from public.steps s where s.revision_id = rid;
  perform private.company_layout_insert(p_ws, rid);
end;
$$;

-- Keeping the map in step with the processes. None of this writes to the process that changes: placing a process on
-- the map is a link held by the map, not an edit of the process.
create function private.company_map_before_delete() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not old.is_company then
    delete from public.steps s using public.processes c
    where s.child_process_id = old.id and c.id = s.process_id and c.is_company;
  end if;
  return old;
end;
$$;

create function private.company_map_membership() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_company then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.name is distinct from old.name then
    update public.steps s set name = new.name
    from public.processes c
    where s.child_process_id = new.id and c.id = s.process_id and c.is_company;
  end if;
  -- A process that changes kind moves to the other column and gets the other kind's handoff lines: take its holder
  -- off the map (its lines go with it) and let the sync put it back.
  if tg_op = 'UPDATE' and new.kind is distinct from old.kind then
    delete from public.steps s using public.processes c
    where s.child_process_id = new.id and c.id = s.process_id and c.is_company;
  end if;
  if tg_op = 'INSERT' or new.parent_process_id is distinct from old.parent_process_id or new.kind is distinct from old.kind then
    perform private.sync_company_map(new.workspace_id);
  end if;
  return null;
end;
$$;

create function private.company_map_new_workspace() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.ensure_company_map(new.id);
  return null;
end;
$$;

revoke all on function private.ensure_company_map(uuid) from public, anon, authenticated;
revoke all on function private.company_layout_insert(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sync_company_map(uuid) from public, anon, authenticated;
revoke all on function private.relayout_company_map(uuid) from public, anon, authenticated;
revoke all on function private.company_map_before_delete() from public, anon, authenticated;
revoke all on function private.company_map_membership() from public, anon, authenticated;
revoke all on function private.company_map_new_workspace() from public, anon, authenticated;

create trigger company_map_before_delete before delete on public.processes
  for each row execute function private.company_map_before_delete();
create trigger company_map_membership after insert or update of name, kind, parent_process_id on public.processes
  for each row execute function private.company_map_membership();
create trigger company_map_new_workspace after insert on public.workspaces
  for each row execute function private.company_map_new_workspace();

-- ---------------------------------------------------------------------------
-- Backfill: every existing workspace gets its company map, laid out as the Overview lays it out today.
-- ---------------------------------------------------------------------------

select private.relayout_company_map(w.id) from public.workspaces w order by w.created_at, w.id;
