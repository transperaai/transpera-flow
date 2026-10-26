-- The process library in every editor (issue #164, B12 part 2 of 2; PRD D26 and D39; ADR 0014).
--
-- Part 1 (20261129500000) put the library on the company map. This lets ANY process hold any other by a link: a `subprocess`
-- holder step whose `child_process_id` is the placed process, in the draft of the process being edited. Placing never writes the
-- placed process (its row, versions, steps or edges). "Inside" and "on the map" now come from ONE place, the holder steps of LIVE
-- versions (`public.process_placements`), not from `processes.parent_process_id`, which no rule here reads any more (ADR 0014,
-- "B12 part 2"). Publishing is where the rules bite: a process sits in at most one live version across every map, and no process
-- ends up inside itself. The company map is every process's default home and GIVES WAY: publishing a link to a process that is on
-- the map takes its card off the map (a system version of the map); when nothing holds it any more, its card comes back.
--
-- NO TABLE OR COLUMN CHANGE, NO DATA CHANGE ON APPLYING. New: one view, five functions, three triggers, one partial index.
-- Replaced with identical signatures: six functions.
--
--   * `public.process_placements` (new view, security invoker; authenticated may select): every link in a live version
--     (process, holder, holder's name, whether the holder is the company map, the step).
--   * `private.live_holder(uuid, uuid)` (new, security definer, executable by nobody signed in): the process whose live version
--     holds a process, other than a given one (and other than a holder being deleted).
--   * index `steps_child_process_id` (new, partial: `child_process_id is not null`): "who holds this process" by the child.
--   * `private.holder_allows(owner, child)` (replaced, from 20261126000000, same signature): any process of the workspace other than the owner itself
--     and other than a company map. It no longer looks at `parent_process_id`. So a DRAFT of any process may hold any process;
--   * `private.check_step_nesting` (replaced, a full copy of 20261127500000's): only its refusal message changes, to match;
--   * `private.check_live_placements` and trigger `check_live_placements` (new; before update of `live_revision_id` on
--     `public.processes`, for every process and every caller): for each process the new live version holds and the old one did
--     not: if the company map holds it live, takes its card off the map (`company_map_apply` 'remove': a system version of the
--     map, its open draft updated too); if another ORDINARY process holds it live, refuses (23514, "Sales is already inside
--     Onboarding. ..."); and refuses when it holds, at any depth through live versions, the process being published ("... would
--     sit inside itself."). One check at a time per workspace (the company map's row, made first if missing, then an advisory
--     lock). Links live already had are not checked again; a live version that is not the process's own is ignored (the version
--     guard refuses it), so nothing of another workspace is read or named;
--   * `private.give_back_placements` and trigger `give_back_placements` (new; after update of `live_revision_id`, ordinary
--     processes only), `private.give_back_on_delete` and trigger `give_back_on_delete` (new; before delete, ordinary processes
--     with a live version): a process the old live version held that nothing holds live any more gets its card back on the
--     company map (`company_map_apply` 'add', a system version);
--   * `public.create_library_process(uuid, text, text, text, text, text)` (new, security invoker; authenticated may execute):
--     the library's "New process" and templates. An ordinary insert as the caller, except that the company map's sync does not
--     give the new process a card of its own (it is placed where the person puts it);
--   * `private.company_map_membership` (replaced, a full copy of 20261127500000's): honours that note on insert;
--   * `private.company_add_holder` and `private.company_map_apply` (replaced, full copies of 20261127500000's): the system never
--     adds a card to the company map for a process another process holds live; `company_map_apply` takes the placement lock;
--   * `public.restore_version` (replaced, a full copy of 20261127500000's): a holder keeps its link only while no OTHER process
--     holds that process live, or only the company map does (it gives way on publish) (before: while the process's parent was
--     this one); otherwise it is unlinked (ordinary process) or
--     skipped (company map), as before; a restored company map does not add back a process another process links, live or in
--     its draft.
--
-- `parent_process_id` stays as a column (additive only). Nothing here writes it. `check_process_parent` and the company map's
-- sync still react when something else does (MCP `import_process` still sets it for a process it creates inside another, or moves
-- inside one, which keeps that process off the company map). The app and MCP read nesting from `process_placements`.
--
-- PREFLIGHT (production; read-only; each must return what it says before applying):
--   1. Nothing later than this is applied. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261130000000';
--   2. Part 1 (20261129500000, row 46) is applied. Expect 1 row:
--        select version from supabase_migrations.schema_migrations where version = '20261129500000';
--   3. The functions this replaces are as reviewed (from 20261126000000 / 20261127500000). Expect one row, true, for each:
--        select prosrc like '%child.parent_process_id is not distinct from owner%' from pg_proc where pronamespace = 'private'::regnamespace and proname = 'holder_allows';
--        select prosrc like '%no key update%' and prosrc like '%(or, on the company map, a process with no parent)%' from pg_proc where pronamespace = 'private'::regnamespace and proname = 'check_step_nesting';
--        select prosrc like '%company_map_edit(new_id%' and prosrc not like '%live_holder%' from pg_proc where pronamespace = 'private'::regnamespace and proname = 'company_map_apply';
--        select prosrc like '%proc.parent_process_id is not null%' and prosrc not like '%live_holder%' from pg_proc where pronamespace = 'private'::regnamespace and proname = 'company_add_holder';
--        select prosrc like '%company_map_apply(new.workspace_id, new.id, ''add''%' and prosrc not like '%library_create%' from pg_proc where pronamespace = 'private'::regnamespace and proname = 'company_map_membership';
--        select prosrc like '%skipped_holders%' and prosrc not like '%live_holder%' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_version';
--   4. What this adds is not there yet. Expect 0, then 0:
--        select count(*) from pg_proc where proname in ('live_holder', 'check_live_placements', 'create_library_process', 'give_back_placements', 'give_back_on_delete');
--        select count(*) from pg_class where relname in ('process_placements', 'steps_child_process_id');
--   5. Data: no process is held in two live versions today. Expect 0 rows (a row would be refused by nothing, but it breaks "at
--      most once"; repair it first by taking one of the links out in a draft and publishing):
--        select s.child_process_id, count(*) from public.steps s join public.processes h on h.live_revision_id = s.revision_id
--        where s.child_process_id is not null group by 1 having count(*) > 1;
--   6. Data: no loop through live versions. Expect 0 rows:
--        with recursive down(root, id) as (
--          select h.id, s.child_process_id from public.processes h join public.steps s on s.revision_id = h.live_revision_id where s.child_process_id is not null
--          union
--          select down.root, s.child_process_id from down join public.processes p on p.id = down.id join public.steps s on s.revision_id = p.live_revision_id where s.child_process_id is not null
--        ) select root from down where id = root;
--   7. Data, to NOTE (not a blocker): processes whose `parent_process_id` names a process whose LIVE version does not hold them
--      (an import whose parent was never published, or a link taken out since). After the app change they read as "Not on any
--      map" / top level, which is what their live versions say; publishing the parent's draft puts them inside it again. No data
--      is changed for them. Note the count and names:
--        select c.id, c.name, c.parent_process_id from public.processes c
--        where c.parent_process_id is not null
--          and not exists (select 1 from public.steps s join public.processes p on p.live_revision_id = s.revision_id where p.id = c.parent_process_id and s.child_process_id = c.id);
--   8. Note the row counts (the post-apply check compares): select (select count(*) from public.processes), (select count(*) from public.process_revisions), (select count(*) from public.steps);
--
-- POST-APPLY CHECKS:
--   1. Grants. Expect: true, false, false, true, false, and 0 rows:
--        select has_function_privilege('authenticated', 'public.create_library_process(uuid, text, text, text, text, text)', 'execute');
--        select has_function_privilege('anon', 'public.create_library_process(uuid, text, text, text, text, text)', 'execute');
--        select has_table_privilege('anon', 'public.process_placements', 'select');
--        select has_table_privilege('authenticated', 'public.process_placements', 'select');
--        select has_function_privilege('authenticated', 'private.live_holder(uuid, uuid)', 'execute');
--        select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')
--          and routine_name in ('live_holder', 'check_live_placements', 'give_back_placements', 'give_back_on_delete', 'company_add_holder', 'company_map_apply', 'company_map_membership');
--   2. The three triggers are there once each, the view is security invoker and the index exists. Expect 3, then true, then 1:
--        select count(*) from pg_trigger where tgrelid = 'public.processes'::regclass and tgname in ('check_live_placements', 'give_back_placements', 'give_back_on_delete') and not tgisinternal;
--        select 'security_invoker=true' = any (reloptions) from pg_class where relname = 'process_placements';
--        select count(*) from pg_indexes where schemaname = 'public' and indexname = 'steps_child_process_id';
--   3. Nothing was changed by applying it: preflight 8's counts are the same.
--
-- ROLLBACK (one transaction; redeploy the app to a build from before this migration FIRST: it calls create_library_process and
-- reads process_placements). Links published meanwhile stay as rows. Under the old rule an ordinary process may hold only its own
-- children, so after a rollback opening a draft of a process that holds (live) a process whose `parent_process_id` is not that
-- process is refused at commit by the old `check_step_nesting`; list them first and take those links out in a draft and publish:
--   select h.name as holder, c.name as held from public.processes h join public.steps s on s.revision_id = h.live_revision_id
--   join public.processes c on c.id = s.child_process_id where not h.is_company and c.parent_process_id is distinct from h.id;
--
--   begin;
--   drop trigger check_live_placements on public.processes;
--   drop function private.check_live_placements();
--   drop trigger give_back_placements on public.processes;
--   drop function private.give_back_placements();
--   drop trigger give_back_on_delete on public.processes;
--   drop function private.give_back_on_delete();
--   drop index public.steps_child_process_id;
--   drop function public.create_library_process(uuid, text, text, text, text, text);
--   drop view public.process_placements;
--   -- Re-create, as `create or replace function`, from packages/db/supabase/migrations/20261126000000_company_map.sql:
--   -- private.holder_allows; and from packages/db/supabase/migrations/20261127500000_company_map_editing.sql:
--   -- private.check_step_nesting, private.company_add_holder, private.company_map_apply, private.company_map_membership and
--   -- public.restore_version (their grants are kept by `create or replace`).
--   drop function private.live_holder(uuid, uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261130000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Where a process sits: one place, read from live versions
-- ---------------------------------------------------------------------------

-- The process whose LIVE version holds `p_child` (a holder step with that `child_process_id`), other than `p_except`; null when
-- none does. A process is held in at most one live version (checked on publish, below), so this is "where it sits". Security
-- definer: it returns only one id, for the functions below, whatever the caller may read.
create function private.live_holder(p_child uuid, p_except uuid default null) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select h.id
  from public.steps s
  join public.processes h on h.live_revision_id = s.revision_id
  where s.child_process_id = p_child and h.id is distinct from p_except
    -- A holder being deleted (private.give_back_on_delete) no longer counts.
    and h.id is distinct from nullif(current_setting('transpera.leaving_holder', true), '')::uuid
  order by h.is_company, h.id
  limit 1;
$$;

revoke all on function private.live_holder(uuid, uuid) from public, anon, authenticated;

-- Every link in a live version: which process holds which, through which step. "Inside" and "on the map" both read this (the
-- app's `listProcesses` derives `parent_process_id` from it: the holder, unless the holder is the company map). Security invoker,
-- so it shows only what the caller may read of `steps` and `processes`.
create view public.process_placements with (security_invoker = true) as
  select s.child_process_id as process_id,
    s.workspace_id,
    h.id as holder_process_id,
    h.name as holder_name,
    h.is_company as holder_is_company,
    s.id as step_id
  from public.steps s
  join public.processes h on h.live_revision_id = s.revision_id
  where s.child_process_id is not null;

revoke all on public.process_placements from public, anon;
grant select on public.process_placements to authenticated;

-- "Who holds this process?" is now asked on every publish and in every editor: look it up by the child, not by scanning steps.
-- (Production's steps table is small, so a plain create index inside the apply transaction is fine.)
create index steps_child_process_id on public.steps (child_process_id) where child_process_id is not null;

-- ---------------------------------------------------------------------------
-- Who may hold whom: any process may hold any other (B12)
-- ---------------------------------------------------------------------------

-- Same signature as 20261126000000's, the rule relaxed: a holder step in a revision of `owner` may hold any process of the same
-- workspace (the composite foreign key on `child_process_id` says so) other than `owner` itself and other than a company map. A
-- DRAFT may therefore hold a process that sits somewhere else; publishing it is what is refused (`private.check_live_placements`):
-- a process sits in at most one live version, and no process ends up inside itself. `parent_process_id` plays no part.
create or replace function private.holder_allows(owner uuid, child public.processes) returns boolean
language sql stable
set search_path = ''
as $$
  select owner is not null and child.id is distinct from owner and not coalesce(child.is_company, false)
     and exists (select 1 from public.processes o where o.id = owner);
$$;

-- A full copy of 20261127500000's; only the refusal message changes (who may hold whom is holder_allows, above).
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
    -- The step's process comes from its revision, not from the step's own (denormalised) process_id.
    select r.process_id into owner from public.process_revisions r where r.id = cur.revision_id;
    -- A card on the company map is checked against the processes as the other writers of the map leave them: wait for one
    -- that is nesting or deleting a process (it holds the map's row), then look. Looked at before, a process nested a moment
    -- ago would be on the map twice.
    perform 1 from public.processes o where o.id = owner and o.is_company for no key update;
    select * into child from public.processes p where p.id = cur.child_process_id;
    if not private.holder_allows(owner, child) then
      raise exception 'Process % can''t sit in step %: a process can''t hold itself or the company map', child.name, cur.name using errcode = '23514';
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
-- Publishing: at most once in the published tree, and no loops
-- ---------------------------------------------------------------------------

-- Runs whenever a process's live version changes (publish_process, a system version of the company map, any other road), before
-- the pointer moves. For each process the new live version holds that the old one did not:
--   * if the company map holds it (live), it GIVES WAY: the card is taken off the map in this transaction, as an ordinary system
--     version of the map (its open draft updated too), so the process moves here. The placed process itself is not written;
--   * if another ORDINARY process holds it (live), the publish is refused and says where it sits ("Sales is already inside
--     Onboarding. ..."), so a process is in the published tree at most once, across every map;
--   * it may not hold, at any depth through live versions, the process being published (that would put it inside itself).
-- Processes the old live version already held are not checked again, so a publish never fails over a state that was already there.
-- One placement check at a time per workspace: the company map's row first (as the map's own sync and publish take it), then an
-- advisory lock, so two drafts placing the same process can't both pass and the order never deadlocks with the map's sync.
create function private.check_live_placements() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  c record;
  other public.processes;
begin
  -- Only a version of this process can be its live version (process_rules_guard refuses anything else for signed-in callers): never
  -- read, or name in a message, what a foreign version holds.
  if not exists (select 1 from public.process_revisions r where r.id = new.live_revision_id and r.process_id = new.id and r.workspace_id = new.workspace_id) then
    return new;
  end if;
  -- The company map's row (made first if the workspace has none yet, so the lock order is always the same), then the advisory lock.
  if not new.is_company then
    perform private.ensure_company_map(new.workspace_id);
  end if;
  perform 1 from public.processes m where m.workspace_id = new.workspace_id and m.is_company and m.id <> new.id for no key update;
  perform pg_advisory_xact_lock(hashtextextended('process_placements:' || new.workspace_id::text, 0));
  for c in
    select distinct p.id, p.name
    from public.steps s join public.processes p on p.id = s.child_process_id
    where s.revision_id = new.live_revision_id
      and not exists (select 1 from public.steps o where o.revision_id = old.live_revision_id and o.child_process_id = s.child_process_id)
    order by p.name, p.id
  loop
    if exists (
      with recursive down(id) as (
        select c.id
        union
        select s.child_process_id
        from down
        join public.processes p on p.id = down.id
        join public.steps s on s.revision_id = p.live_revision_id and s.child_process_id is not null
      )
      select 1 from down where id = new.id
    ) then
      raise exception '% can''t hold %: % already holds %, so % would sit inside itself.', new.name, c.name, c.name, new.name, new.name
        using errcode = '23514';
    end if;
    select h.* into other from public.processes h where h.id = private.live_holder(c.id, new.id);
    if other.id is not null and other.is_company and not new.is_company then
      -- The company map is every process's default home: it gives way.
      perform private.company_map_apply(new.workspace_id, c.id, 'remove', 'Moved ' || c.name || ' inside ' || new.name);
      select h.* into other from public.processes h where h.id = private.live_holder(c.id, new.id);
    end if;
    if other.id is not null then
      raise exception '% is already %. A process can sit in one place only: take it off there first, then publish again.',
        c.name, case when other.is_company then 'on the company map' else 'inside ' || other.name end
        using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private.check_live_placements() from public, anon, authenticated;

create trigger check_live_placements before update of live_revision_id on public.processes
  for each row when (new.live_revision_id is not null and new.live_revision_id is distinct from old.live_revision_id)
  execute function private.check_live_placements();

-- The company map is the default home a process goes back to. When an ordinary process publishes a version that no longer holds a
-- process its old live version held, and nothing else holds that process live, it gets its card back on the company map (a
-- system version, as when it was made). Taking a card off the company map itself leaves the process off ("Not on any map"):
-- that is a person's choice. A process with a stored parent (made inside another by MCP's import) is the map's sync's business.
create function private.give_back_placements() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  c record;
begin
  for c in
    select distinct s.child_process_id as id, p.name
    from public.steps s join public.processes p on p.id = s.child_process_id
    where s.revision_id = old.live_revision_id
      and not exists (select 1 from public.steps n where n.revision_id = new.live_revision_id and n.child_process_id = s.child_process_id)
    order by p.name, s.child_process_id
  loop
    if private.live_holder(c.id) is null then
      perform private.company_map_apply(new.workspace_id, c.id, 'add', 'Put ' || c.name || ' back on the map: ' || new.name || ' no longer holds it');
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function private.give_back_placements() from public, anon, authenticated;

create trigger give_back_placements after update of live_revision_id on public.processes
  for each row when (not new.is_company and old.live_revision_id is not null and new.live_revision_id is distinct from old.live_revision_id)
  execute function private.give_back_placements();

-- The same when the holder is deleted: what it held live, and nothing else holds, goes back on the company map.
create function private.give_back_on_delete() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  c record;
begin
  perform set_config('transpera.leaving_holder', old.id::text, true);
  for c in
    select distinct s.child_process_id as id, p.name
    from public.steps s join public.processes p on p.id = s.child_process_id
    where s.revision_id = old.live_revision_id
    order by p.name, s.child_process_id
  loop
    if private.live_holder(c.id) is null then
      perform private.company_map_apply(old.workspace_id, c.id, 'add', 'Put ' || c.name || ' back on the map: ' || old.name || ' was deleted');
    end if;
  end loop;
  perform set_config('transpera.leaving_holder', '', true);
  return old;
end;
$$;

revoke all on function private.give_back_on_delete() from public, anon, authenticated;

create trigger give_back_on_delete before delete on public.processes
  for each row when (not old.is_company and old.live_revision_id is not null)
  execute function private.give_back_on_delete();

-- ---------------------------------------------------------------------------
-- A new process from the library
-- ---------------------------------------------------------------------------

-- The library's "New process" and its templates make a process that the person then places, in the draft they are editing. Made
-- the ordinary way, a new top-level process would also get a card on the company map at once (the sync rule) and then sit in two
-- places. This makes it as an ordinary insert by the caller (RLS: editors of the workspace; every guard sees the caller), with a
-- transaction-local note that `private.company_map_membership` reads to leave the map alone for that one process. Returns
-- `{status: 'created', process_id}`, or `invalid_name`, `name_taken`, `invalid_kind` or `not_found` (not an editor).
create function public.create_library_process(p_workspace uuid, p_name text, p_kind text, p_entity_name text default null, p_description text default null, p_source text default 'manual') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  clean text := btrim(coalesce(p_name, ''));
  pid uuid := gen_random_uuid();
begin
  if p_workspace is null or public.can_edit_workspace(p_workspace) is not true then
    return jsonb_build_object('status', 'not_found');
  end if;
  if clean = '' or char_length(clean) > 120 then
    return jsonb_build_object('status', 'invalid_name');
  end if;
  if p_kind is null or p_kind not in ('pipeline', 'servicing') or coalesce(p_source, '') not in ('manual', 'template') then
    return jsonb_build_object('status', 'invalid_kind');
  end if;
  -- One name check at a time per workspace (the lock import_new_process takes for its own).
  perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));
  if exists (select 1 from public.processes p where p.workspace_id = p_workspace and not p.is_company and lower(btrim(p.name)) = lower(clean)) then
    return jsonb_build_object('status', 'name_taken');
  end if;
  perform set_config('transpera.library_create', pid::text, true);
  insert into public.processes (id, workspace_id, name, kind, entity_name, description, source)
  values (pid, p_workspace, clean, p_kind,
    coalesce(nullif(btrim(coalesce(p_entity_name, '')), ''), case when p_kind = 'pipeline' then 'lead' else 'task' end),
    nullif(btrim(coalesce(p_description, '')), ''), p_source);
  perform set_config('transpera.library_create', '', true);
  return jsonb_build_object('status', 'created', 'process_id', pid);
end;
$$;

revoke execute on function public.create_library_process(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.create_library_process(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The company map's sync and restore, taught where a process sits
-- ---------------------------------------------------------------------------

-- A full copy of 20261127500000's, changed (marked B12): never for a process another process holds live.
create or replace function private.company_add_holder(p_rev uuid, p_proc uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  proc public.processes;
  cid uuid;
  ws uuid;
  nx numeric;
  ny numeric;
  hid uuid := gen_random_uuid();
begin
  select * into proc from public.processes p where p.id = p_proc;
  select r.process_id, r.workspace_id into cid, ws from public.process_revisions r where r.id = p_rev;
  if proc.id is null or proc.is_company or proc.parent_process_id is not null or proc.workspace_id is distinct from ws then
    return false;
  end if;
  if exists (select 1 from public.steps s where s.revision_id = p_rev and s.child_process_id = p_proc) then
    return false;
  end if;
  -- B12: a process another process holds (live) is there, not here: the system never puts it on the map as well.
  if private.live_holder(p_proc, cid) is not null then
    return false;
  end if;
  nx := case when proc.kind = 'servicing' then 288 else 0 end;
  -- Below whatever already sits in that column (a card is 192 wide): people move cards, so this is by position.
  select coalesce(max(s.y) + 160, 0) into ny from public.steps s
  where s.revision_id = p_rev and s.parent_step_id is null and s.x > nx - 192 and s.x < nx + 192;
  insert into public.steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id, x, y)
  values (hid, p_rev, ws, cid, proc.name, 'subprocess', proc.id, nx, ny);
  insert into public.edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability)
  select p_rev, ws, cid,
    case when proc.kind = 'servicing' then s.id else hid end,
    case when proc.kind = 'servicing' then hid else s.id end, 1
  from public.steps s join public.processes q on q.id = s.child_process_id
  where s.revision_id = p_rev and s.id <> hid and (q.kind = 'servicing') <> (proc.kind = 'servicing');
  return true;
end;
$$;

-- A full copy of 20261127500000's, changed (marked B12): 'add' is not needed when another process holds it live.
create or replace function private.company_map_apply(p_ws uuid, p_proc uuid, p_change text, p_note text, p_old_name text default null, p_old_kind text default null) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  cid uuid;
  live_id uuid;
  draft_id uuid;
  proc public.processes;
  cur public.process_revisions;
  needed boolean;
  new_id uuid;
  new_number integer;
  old_number integer;
begin
  -- The workspace being deleted takes the map with it: nothing to keep in step.
  if not exists (select 1 from public.workspaces w where w.id = p_ws) then
    return;
  end if;
  cid := private.ensure_company_map(p_ws);
  if cid is null then
    return;
  end if;
  -- One event at a time per workspace: two processes made together each get their own place and lines. (NO KEY UPDATE, as
  -- check_step_nesting takes it: it does not wait for the writers of the map's rows, who hold KEY SHARE.)
  perform 1 from public.processes c where c.id = cid for no key update;
  -- B12: and the placement check's lock (after the map's row, as check_live_placements takes them), so "who holds it live" below
  -- can't change under it.
  perform pg_advisory_xact_lock(hashtextextended('process_placements:' || p_ws::text, 0));
  select * into proc from public.processes p where p.id = p_proc;
  select c.live_revision_id, c.draft_revision_id into live_id, draft_id from public.processes c where c.id = cid;
  -- The guards let the system through, whoever's statement this runs inside.
  perform set_config('transpera.company_system', 'on', true);
  if live_id is not null then
    needed := case p_change
      when 'add' then proc.id is not null and not proc.is_company and proc.parent_process_id is null
        and not exists (select 1 from public.steps s where s.revision_id = live_id and s.child_process_id = p_proc)
        -- B12: not when another process holds it (live): it sits there.
        and private.live_holder(p_proc, cid) is null
      when 'remove' then exists (select 1 from public.steps s where s.revision_id = live_id and s.child_process_id = p_proc)
      when 'rename' then exists (select 1 from public.steps s where s.revision_id = live_id and s.child_process_id = p_proc and s.name is distinct from proc.name)
      when 'move' then exists (select 1 from public.steps s where s.revision_id = live_id and s.child_process_id = p_proc
        and s.x is distinct from (case when proc.kind = 'servicing' then 288 else 0 end))
      else false end;
    if needed then
      select * into cur from public.process_revisions r where r.id = live_id;
      if cur.status = 'published' and cur.published_by is null and cur.published_at = now() then
        -- Made by the system earlier in this transaction: extend it.
        new_id := live_id;
        perform private.company_map_edit(new_id, p_proc, p_change, true, p_old_name, p_old_kind);
        update public.audit_log l set diff = l.diff || jsonb_build_object(
          'note', left(coalesce(l.diff ->> 'note', '') || case when l.diff ->> 'note' is null then '' else '; ' end || p_note, 300),
          'changes', private.revision_changes((l.diff ->> 'previous_revision_id')::uuid, new_id))
        where l.workspace_id = p_ws and l.target_table = 'processes' and l.target_id = cid and l.action = 'publish'
          and l.actor_kind = 'system' and l.diff ->> 'revision_id' = new_id::text;
      else
        new_id := private.company_new_version(cid);
        perform private.company_map_edit(new_id, p_proc, p_change, true, p_old_name, p_old_kind);
        select r.number into new_number from public.process_revisions r where r.id = new_id;
        old_number := cur.number;
        -- The same entry a person's publish leaves (history reads it), by the system, with the note.
        insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
        values (p_ws, null, 'system', 'publish', 'processes', cid, jsonb_build_object(
          'revision_id', new_id, 'number', new_number, 'previous_revision_id', live_id, 'previous_number', old_number,
          'accept_estimates', false, 'estimates', '[]'::jsonb, 'note', p_note,
          'changes', private.revision_changes(live_id, new_id)));
      end if;
    end if;
  end if;
  if draft_id is not null then
    -- From live's new rows, where live changed, so an untouched draft stays equal to live.
    perform private.company_map_edit(draft_id, p_proc, p_change, false, p_old_name, p_old_kind, new_id);
  end if;
  perform set_config('transpera.company_system', '', true);
end;
$$;

-- A full copy of 20261127500000's, changed (marked B12): a process made from the library gets no card of its own.
create or replace function private.company_map_membership() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_company then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- B12: a process made from the library (`public.create_library_process`) is placed where the person puts it, so the map
    -- does not get a card for it on its own.
    if new.parent_process_id is null and coalesce(current_setting('transpera.library_create', true), '') is distinct from new.id::text then
      perform private.company_map_apply(new.workspace_id, new.id, 'add', 'Added ' || new.name);
    end if;
    return null;
  end if;
  if new.parent_process_id is distinct from old.parent_process_id then
    if new.parent_process_id is null then
      perform private.company_map_apply(new.workspace_id, new.id, 'add', 'Added ' || new.name);
    elsif old.parent_process_id is null then
      perform private.company_map_apply(new.workspace_id, new.id, 'remove', 'Removed ' || new.name || ' from the map: it now sits inside another process');
    end if;
  end if;
  if new.kind is distinct from old.kind and new.parent_process_id is null then
    perform private.company_map_apply(new.workspace_id, new.id, 'move',
      new.name || ' is now ' || case when new.kind = 'servicing' then 'a servicing process' else 'a sales pipeline' end, null, old.kind);
  end if;
  if new.name is distinct from old.name then
    perform private.company_map_apply(new.workspace_id, new.id, 'rename', 'Renamed ' || old.name || ' to ' || new.name, old.name);
  end if;
  return null;
end;
$$;

-- A full copy of 20261127500000's, changed: a holder keeps its link only while no OTHER process holds that process live.
create or replace function public.restore_version(target_process uuid, source_revision uuid, replace_draft boolean default false) returns jsonb
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
  -- company map: holders that can't be re-linked, and processes added back
  skipped uuid[] := '{}';
  added integer := 0;
  np record;
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

  -- A holder step keeps its child process only while that process may still sit inside this one: nothing else holds it live, or
  -- only the company map does (B12: the map gives way when this is published, as for a fresh link in a draft).
  select count(*) into unlinked from public.steps s
  where s.revision_id = src.id and s.child_process_id is not null
    and not exists (select 1 from public.processes c where c.id = s.child_process_id and private.holder_allows(proc.id, c)
      and coalesce((select h.is_company and not proc.is_company from public.processes h where h.id = private.live_holder(c.id, proc.id)), true));
  -- company map: a holder with no process to link (gone, marked when it went, or nested since) is not restored, with the lines on it;
  -- a subprocess step nobody linked (a placeholder a person drew) is.
  if proc.is_company then
    select coalesce(array_agg(s.id), '{}') into skipped from public.steps s
    where s.revision_id = src.id and s.kind = 'subprocess'
      and (s.child_process_id is not null and not exists (select 1 from public.processes c where c.id = s.child_process_id and private.holder_allows(proc.id, c)
      and coalesce((select h.is_company and not proc.is_company from public.processes h where h.id = private.live_holder(c.id, proc.id)), true))
           or s.child_process_id is null and exists (
                select 1 from public.audit_log l where l.workspace_id = proc.workspace_id and l.action = 'map_cards_removed'
                  and l.target_table = 'processes' and l.diff -> 'step_ids' ? s.id::text));
    unlinked := 0;
  end if;

  insert into public.steps
  select (jsonb_populate_record(null::public.steps,
    to_jsonb(s) || jsonb_build_object(
      'revision_id', draft.id,
      'created_at', now(),
      'updated_at', now(),
      'child_process_id', (select c.id from public.processes c where c.id = s.child_process_id and private.holder_allows(proc.id, c)
      and coalesce((select h.is_company and not proc.is_company from public.processes h where h.id = private.live_holder(c.id, proc.id)), true)),
      -- company map: a holder is called what its process is called now
      'name', coalesce((select c.name from public.processes c where proc.is_company and c.id = s.child_process_id and private.holder_allows(proc.id, c)
      and coalesce((select h.is_company and not proc.is_company from public.processes h where h.id = private.live_holder(c.id, proc.id)), true)), s.name),
      'entry_step_id', case when s.entry_step_id = any (skipped) then null else s.entry_step_id end,
      'rework_to_step_id', case when s.rework_to_step_id = any (skipped) then null else s.rework_to_step_id end))).*
  from public.steps s where s.revision_id = src.id and not (s.id = any (skipped));
  insert into public.edges
  select (jsonb_populate_record(null::public.edges,
    to_jsonb(e) || jsonb_build_object('revision_id', draft.id, 'created_at', now(), 'updated_at', now()))).*
  from public.edges e where e.revision_id = src.id and not (e.from_step_id = any (skipped) or e.to_step_id = any (skipped));

  -- company map: processes made since that version stay on the map.
  if proc.is_company then
    for np in
      select p.id from public.processes p
      where p.workspace_id = proc.workspace_id and not p.is_company and p.parent_process_id is null
        and not exists (select 1 from public.steps s where s.revision_id = draft.id and s.child_process_id = p.id)
        -- B12: not one another process links, live or in its draft (one the library made sits there, not here).
        and not exists (select 1 from public.steps s join public.processes h on s.revision_id in (h.live_revision_id, h.draft_revision_id)
          where s.child_process_id = p.id and h.id <> proc.id)
      order by p.created_at, p.id
    loop
      if private.company_add_holder(draft.id, np.id) then
        added := added + 1;
      end if;
    end loop;
  end if;

  update public.processes p set draft_revision_id = draft.id where p.id = proc.id;

  -- One audit entry says what happened. A new draft already has an 'open_draft' entry (written by the trigger on the
  -- insert, in this transaction, saying it came from live); it is rewritten rather than followed by a second.
  entry := jsonb_build_object('revision_id', draft.id, 'number', draft.number, 'restored_from_revision_id', src.id,
    'restored_from_number', src.number, 'replaced_draft', had_draft);
  if proc.is_company then
    entry := entry || jsonb_build_object('skipped_holders', cardinality(skipped), 'added_holders', added);
  end if;
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
  return jsonb_build_object('status', 'restored', 'revision_id', draft.id, 'number', draft.number, 'unlinked_children', unlinked,
    'skipped_holders', cardinality(skipped), 'added_holders', added);
end;
$$;
