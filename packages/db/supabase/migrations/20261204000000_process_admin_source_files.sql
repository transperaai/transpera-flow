-- Everything can be added by hand, part 2 (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"; PRD D43): archiving and
-- restoring a process, and keeping the original file of a source in Supabase Storage.
--
-- Processes were already created, renamed and re-kinded by editors with ordinary writes (RLS: owners and editors write,
-- viewers read; the company map's sync reacts to a rename or a kind change). What was missing, and what this adds:
--
--   * `processes.archived_at` and `processes.archived_by` (nullable): an archived process is soft deleted. The app and MCP
--     leave it out of every list, the company map and the simulation (`listProcesses` filters it), and its versions, history,
--     issues and sources are all kept. Restoring it clears both columns. Nothing deletes a process.
--   * `private.process_archive_guard` and its trigger (before insert, and before an update of `archived_at` or `archived_by`;
--     every caller): a new process never starts archived; `archived_by` is never set by hand (archiving stamps `now()` and
--     `auth.uid()`, archiving again keeps the first stamp, restoring clears both); the company map is never archived; a process
--     that sits inside another ordinary process (a live link), holds other processes in its live version, is a service's way in
--     (`services.entry_process_id`) or is client work a service generates (`service_servicing`) is REFUSED, with a plain message
--     naming them; restoring is refused while another process in use has its name (an archived process gives its name up).
--   * `private.process_archive_map` and its trigger (after update of `archived_at`): archiving takes the process's card off
--     the company map as a system version ("Archived Sales"; an open draft of the map loses the card too), restoring puts it
--     back at the bottom of its column ("Restored Sales"), through the map's existing sync (`private.company_map_apply`).
--   * While archived, nothing changes the process: `private.refuse_archived_revision` (before insert or update on
--     `process_revisions`: no draft opened, no version restored into a new or an open draft) and `private.refuse_archived_publish` (before its `live_revision_id` moves: an
--     old draft can't be published), each with its trigger; `public.open_draft` (full copy of 20261006000000's, changed) refuses
--     it too, even when a draft is already open.
--   * `private.refuse_archived_placements` and its trigger (before update of `live_revision_id`, every caller): publishing (or
--     any other road to a new live version) that newly holds an archived process is refused ("Sales is archived. ...").
--   * `private.holder_allows` (full copy of 20261130000000's, changed): an archived process may not be placed. So placing it in
--     a draft is refused, and `restore_version` (which already asks `holder_allows`) skips its card on a restored company map
--     and unlinks it in a restored ordinary process. `private.check_step_nesting` (full copy of 20261130000000's, changed: the
--     message only) says "Sales is archived" instead of the generic refusal. `private.company_add_holder` (full copy of
--     20261130000000's, changed): the system never puts an archived process's card on the company map.
--   * Names are unique among the processes in use: `public.create_library_process` (full copy of 20261130000000's) and
--     `public.import_new_process` (full copy of 20261128000000's) no longer count archived processes (changed lines marked B19).
--   * Source files: `sources.file_path`, `file_name`, `file_type` and `file_size` (nullable, all set or none), with checks: the
--     path is `<workspace_id>/<source id>/<uuid>/<name>` (the source's own workspace and folder), the type is one of txt, md,
--     csv, xlsx, pdf, and the size is 1 byte to 10 MB. The text extracted from the file is the source's `body`.
--   * Supabase Storage: a PRIVATE bucket `sources` (10 MB per file, and only the five MIME types the app sends), and three
--     policies on `storage.objects` for that bucket, keyed by the workspace id in the first folder of the object's name:
--     members read a file only once a source keeps it (until then only its uploader can, so the app's server can check it);
--     owners, editors and agency admins upload (as themselves, into a source's folder, under a name no source keeps yet) and
--     delete; no update; `anon` nothing. `private.storage_workspace(text)` reads that first folder as a uuid (null when it is
--     not one). Objects no source keeps (an upload abandoned before it was checked) are readable only by their uploader; the
--     sweep in docs/supabase-notes.md removes them.
--
-- STRICTLY ADDITIVE: new nullable columns (no default, so no rewrite), NOT VALID checks on new columns, new functions and
-- triggers, six functions replaced with the same signatures, one bucket row and three storage policies. No existing column,
-- policy or grant changes. Data: none to move (no process is archived, no source has a file).
--
-- ORDER: apply after 20261202000000 (C2 calibration, row 50 of docs/production-migrations.md).
--
-- PREFLIGHT (read-only; each must return the stated result before applying):
--   0. The migration before this one is applied. Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261202000000';
--   1. Nothing later is applied. Expect 0:
--        select count(*) from supabase_migrations.schema_migrations where version >= '20261204000000';
--   2. Nothing this migration creates exists yet. Expect 0 rows from each:
--        select column_name from information_schema.columns where table_schema = 'public' and ((table_name = 'processes' and column_name in ('archived_at', 'archived_by')) or (table_name = 'sources' and column_name in ('file_path', 'file_name', 'file_type', 'file_size')));
--        select proname from pg_proc where pronamespace = 'private'::regnamespace and proname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'refuse_archived_revision', 'refuse_archived_publish', 'storage_workspace');
--        select id from storage.buckets where id = 'sources';
--        select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'sources:%';
--   3. The replaced functions are the bodies this copies, not yet changed. Expect 6 rows, each true:
--        select proname, case proname
--            when 'holder_allows' then prosrc like '%not coalesce(child.is_company, false)%' and prosrc not like '%archived%'
--            when 'check_step_nesting' then prosrc like '%a process can''''t hold itself or the company map%' and prosrc not like '%archived%'
--            when 'company_add_holder' then prosrc like '%B12: a process another process holds (live)%' and prosrc not like '%archived%'
--            when 'open_draft' then prosrc like '%FOR UPDATE applies the update policy too%' and prosrc not like '%archived%'
--            when 'create_library_process' then prosrc like '%transpera.library_create%' and prosrc not like '%archived%'
--            else prosrc like '%Same rule as the app''s check%' and prosrc not like '%archived%' end
--        from pg_proc where (pronamespace = 'private'::regnamespace and proname in ('holder_allows', 'check_step_nesting', 'company_add_holder'))
--          or (pronamespace = 'public'::regnamespace and proname in ('open_draft', 'create_library_process', 'import_new_process'));
--   4. Storage is there, with RLS on its objects. Expect 1 row, true:
--        select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;
--
-- POST-APPLY CHECK:
--   1. Five triggers exist and are enabled. Expect 5 rows, tgenabled 'O':
--        select tgname, tgenabled from pg_trigger where tgname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'refuse_archived_revision', 'refuse_archived_publish') and not tgisinternal;
--   2. The bucket is private with its limits. Expect 1 row: false, 10485760, 5 types:
--        select public, file_size_limit, cardinality(allowed_mime_types) from storage.buckets where id = 'sources';
--   3. Three policies, all for authenticated (read, upload, delete; no update). Expect 3 rows, roles {authenticated}:
--        select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'sources:%';
--   4. The new private functions have an empty search_path and no EXECUTE for anon or PUBLIC (storage_workspace is executable
--      by authenticated, which the policies need). Expect 6 rows with {search_path=""}, then 1 row (authenticated, storage_workspace):
--        select proname, proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'refuse_archived_revision', 'refuse_archived_publish', 'storage_workspace');
--        select grantee, routine_name from information_schema.routine_privileges where routine_schema = 'private' and routine_name in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'refuse_archived_revision', 'refuse_archived_publish', 'storage_workspace') and grantee in ('anon', 'authenticated', 'PUBLIC');
--
-- ROLLBACK (redeploy the app to a build from before it FIRST; run as one transaction. Archived processes come back as ordinary
-- processes, with no card on the company map until someone places one; uploaded files stay in the bucket, unreachable from the
-- app, until the bucket is emptied from the Storage dashboard; a bucket with objects can't be deleted from SQL):
--
--   begin;
--   drop policy if exists "sources: members read" on storage.objects;
--   drop policy if exists "sources: editors upload" on storage.objects;
--   drop policy if exists "sources: editors delete" on storage.objects;
--   -- Keep the bucket row if it has objects (empty it from the dashboard, then): delete from storage.buckets where id = 'sources';
--   drop function if exists private.storage_workspace(text);
--   alter table public.sources drop constraint if exists sources_file_all_or_none, drop constraint if exists sources_file_path_shape,
--     drop constraint if exists sources_file_type, drop constraint if exists sources_file_size, drop constraint if exists sources_file_name_length;
--   alter table public.sources drop column if exists file_path, drop column if exists file_name, drop column if exists file_type, drop column if exists file_size;
--   drop trigger if exists refuse_archived_placements on public.processes;
--   drop function if exists private.refuse_archived_placements();
--   drop trigger if exists refuse_archived_publish on public.processes;
--   drop function if exists private.refuse_archived_publish();
--   drop trigger if exists refuse_archived_revision on public.process_revisions;
--   drop function if exists private.refuse_archived_revision();
--   drop trigger if exists process_archive_map on public.processes;
--   drop function if exists private.process_archive_map();
--   drop trigger if exists process_archive_guard on public.processes;
--   drop function if exists private.process_archive_guard();
--   -- Re-create, as `create or replace function`, 20261130000000's private.holder_allows, private.check_step_nesting,
--   -- private.company_add_holder and public.create_library_process, 20261006000000's public.open_draft and 20261128000000's
--   -- public.import_new_process (copy those blocks from their migrations; grants are kept by `create or replace`), then:
--   alter table public.processes drop column if exists archived_by, drop column if exists archived_at;
--   delete from supabase_migrations.schema_migrations where version = '20261204000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Archiving a process
-- ---------------------------------------------------------------------------

alter table public.processes
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users (id) on delete set null;

comment on column public.processes.archived_at is
  'When the process was archived (soft deleted: off the map, the lists and the simulation; history kept). Null for an active process.';

-- Who may archive and restore, and when. On insert: a new process never starts archived. On an update touching `archived_at` or
-- `archived_by`: `archived_by` is never set by hand (archiving stamps `now()` and `auth.uid()`; archiving again keeps the first
-- stamp; restoring clears both). Archiving is refused for the company map, for a process that sits inside another ordinary
-- process (live) or holds other processes in its live version, for a pipeline that is a service's way in, and for client work
-- that services generate: an archived process is never part of the live tree or of the simulation. Restoring is refused while
-- another process in use has its name. Security definer: it reads every link and service of the workspace, whatever the caller
-- may read, and names only things of the same workspace.
create function private.process_archive_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  holder public.processes;
  held text;
  named text;
begin
  if tg_op = 'INSERT' then
    if new.archived_at is not null or new.archived_by is not null then
      raise exception 'A new process can''t start archived' using errcode = '55000';
    end if;
    return new;
  end if;
  if new.archived_at is not distinct from old.archived_at then
    if new.archived_by is distinct from old.archived_by then
      raise exception 'Who archived a process is recorded by the database, not set by hand' using errcode = '55000';
    end if;
    return new;
  end if;
  if new.is_company then
    raise exception 'The company map can''t be archived' using errcode = '55000';
  end if;
  if new.archived_at is null then
    -- Restore. Names are unique among the processes in use (an archived one gives its name up).
    if exists (select 1 from public.processes p where p.workspace_id = new.workspace_id and p.id <> new.id and not p.is_company
               and p.archived_at is null and lower(btrim(p.name)) = lower(btrim(new.name))) then
      raise exception 'Another process is called %. Rename one of them, then restore it.', new.name using errcode = '55000';
    end if;
    new.archived_by := null;
    return new;
  end if;
  if old.archived_at is not null then
    -- Already archived: keep when and by whom.
    new.archived_at := old.archived_at;
    new.archived_by := old.archived_by;
    return new;
  end if;
  -- The same locks as a publish's placement check (the company map's row, then the workspace's placement lock), so a publish
  -- placing this process and this archive can't both pass.
  perform 1 from public.processes m where m.workspace_id = new.workspace_id and m.is_company for no key update;
  perform pg_advisory_xact_lock(hashtextextended('process_placements:' || new.workspace_id::text, 0));
  select h.* into holder from public.processes h where h.id = private.live_holder(new.id) and not h.is_company;
  if holder.id is not null then
    raise exception '% sits inside %. Take it out of % and publish, then archive it.', new.name, holder.name, holder.name
      using errcode = '55000';
  end if;
  select string_agg(distinct p.name, ', ' order by p.name) into held
  from public.steps s join public.processes p on p.id = s.child_process_id
  where s.revision_id = new.live_revision_id;
  if held is not null then
    raise exception '% holds %. Take % out of % and publish, then archive it.', new.name, held, held, new.name
      using errcode = '55000';
  end if;
  -- The simulation reaches a process through services too: a service's way in, or the client work a service generates.
  select string_agg(distinct v.name, ', ' order by v.name) into named
  from public.services v where v.workspace_id = new.workspace_id and v.entry_process_id = new.id;
  if named is not null then
    raise exception '% is where new work for % comes in. Choose another process for it in Settings, Services, then archive it.', new.name, named
      using errcode = '55000';
  end if;
  select string_agg(distinct v.name, ', ' order by v.name) into named
  from public.service_servicing l join public.services v on v.id = l.service_id where l.process_id = new.id;
  if named is not null then
    raise exception '% is client work for %. Unlink it from that in Settings, Services, then archive it.', new.name, named
      using errcode = '55000';
  end if;
  new.archived_at := now();
  new.archived_by := auth.uid();
  return new;
end;
$$;

revoke all on function private.process_archive_guard() from public, anon, authenticated;

create trigger process_archive_guard before insert or update of archived_at, archived_by on public.processes
  for each row execute function private.process_archive_guard();

-- While a process is archived nothing changes it: no version made or changed (a draft opened, a version restored into a new
-- or an open draft) and no new live version (publishing a draft opened before it was archived). Every caller and road.
create function private.refuse_archived_revision() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  proc public.processes;
begin
  select * into proc from public.processes p where p.id = new.process_id;
  if proc.archived_at is not null then
    raise exception '% is archived. Restore it from Processes (Archived) before changing it.', proc.name using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.refuse_archived_revision() from public, anon, authenticated;

create trigger refuse_archived_revision before insert or update on public.process_revisions
  for each row execute function private.refuse_archived_revision();

create function private.refuse_archived_publish() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is archived. Restore it from Processes (Archived) before publishing it.', new.name using errcode = '55000';
end;
$$;

revoke all on function private.refuse_archived_publish() from public, anon, authenticated;

create trigger refuse_archived_publish before update of live_revision_id on public.processes
  for each row when (old.archived_at is not null and new.archived_at is not null and new.live_revision_id is distinct from old.live_revision_id)
  execute function private.refuse_archived_publish();

-- After an archive or a restore: the company map follows, through its sync (a system version, mirrored into an open draft).
create function private.process_archive_map() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    perform private.company_map_apply(new.workspace_id, new.id, 'remove', 'Archived ' || new.name);
  elsif old.archived_at is not null and new.archived_at is null then
    perform private.company_map_apply(new.workspace_id, new.id, 'add', 'Restored ' || new.name);
  end if;
  return null;
end;
$$;

revoke all on function private.process_archive_map() from public, anon, authenticated;

create trigger process_archive_map after update of archived_at on public.processes
  -- (The company map is never archived: the guard refuses it.)
  for each row when ((new.archived_at is null) <> (old.archived_at is null))
  execute function private.process_archive_map();

-- A new live version may not newly hold an archived process (a draft that linked it before it was archived). Runs after
-- check_live_placements (triggers fire in name order), which has taken the placement locks.
create function private.refuse_archived_placements() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  names text;
begin
  if not exists (select 1 from public.process_revisions r where r.id = new.live_revision_id and r.process_id = new.id and r.workspace_id = new.workspace_id) then
    return new;
  end if;
  select string_agg(distinct p.name, ', ' order by p.name) into names
  from public.steps s join public.processes p on p.id = s.child_process_id
  where s.revision_id = new.live_revision_id and p.archived_at is not null
    and not exists (select 1 from public.steps o where o.revision_id = old.live_revision_id and o.child_process_id = s.child_process_id);
  if names is not null then
    raise exception '% is archived. Restore it from Processes (Archived), or take it out of this draft, then publish again.', names
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.refuse_archived_placements() from public, anon, authenticated;

create trigger refuse_archived_placements before update of live_revision_id on public.processes
  for each row when (new.live_revision_id is not null and new.live_revision_id is distinct from old.live_revision_id)
  execute function private.refuse_archived_placements();

-- A full copy of 20261130000000's, changed (marked B19): an archived process can't be placed.
create or replace function private.holder_allows(owner uuid, child public.processes) returns boolean
language sql stable
set search_path = ''
as $$
  select owner is not null and child.id is distinct from owner and not coalesce(child.is_company, false)
     -- B19: nor an archived one.
     and child.archived_at is null
     and exists (select 1 from public.processes o where o.id = owner);
$$;

-- A full copy of 20261130000000's; only the refusal message changes (marked B19).
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
      -- B19: say so plainly when it is archived.
      if child.archived_at is not null then
        raise exception '% is archived: restore it from Processes (Archived) before placing it', child.name using errcode = '23514';
      end if;
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

-- A full copy of 20261130000000's, changed (marked B19): never for an archived process.
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
  -- B19: an archived process is off the map until it is restored.
  if proc.archived_at is not null then
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

-- A full copy of 20261006000000's, changed (marked B19): an archived process is refused, with a plain message.
create or replace function public.open_draft(target_process uuid) returns jsonb
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
  -- B19: nothing changes an archived process, not even an old draft of it.
  if proc.archived_at is not null then
    raise exception '% is archived. Restore it from Processes (Archived) before changing it.', proc.name using errcode = '55000';
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

-- A full copy of 20261130000000's, changed (marked B19): names are unique among the processes in use.
create or replace function public.create_library_process(p_workspace uuid, p_name text, p_kind text, p_entity_name text default null, p_description text default null, p_source text default 'manual') returns jsonb
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
  -- B19: an archived process gives its name up.
  if exists (select 1 from public.processes p where p.workspace_id = p_workspace and not p.is_company and p.archived_at is null and lower(btrim(p.name)) = lower(clean)) then
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

-- A full copy of 20261128000000's, changed (marked B19): names are unique among the processes in use.
create or replace function public.import_new_process(p_workspace uuid, p_nodes jsonb, p_adopt jsonb default '[]') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  node jsonb;
  adopt jsonb;
  draft jsonb;
  rev uuid;
  proc uuid;
  rows_json jsonb;
  cols text;
  revisions jsonb := '{}';
  result jsonb := '[]';
  made uuid[] := '{}';
  total_steps integer;
  clash text;
  nname text;
  names text[] := '{}';
begin
  if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) not between 1 and 200
    or jsonb_typeof(coalesce(p_adopt, '[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_adopt, '[]')) > 200 then
    raise exception 'import_new_process: p_nodes must be an array of 1 to 200 processes and p_adopt an array' using errcode = '22023';
  end if;
  select coalesce(sum(case when jsonb_typeof(n.value -> 'steps') = 'array' then jsonb_array_length(n.value -> 'steps') else 0 end), 0)
    into total_steps from jsonb_array_elements(p_nodes) n;
  if total_steps > 1000 then
    raise exception 'import_new_process: an import can have at most 1000 steps in all (this one has %)', total_steps using errcode = '22023';
  end if;

  -- One import at a time per workspace, so the name check below holds until this transaction commits.
  perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));

  -- 1. Every process and its draft, parents first (a child names its parent).
  for node in select value from jsonb_array_elements(p_nodes) loop
    proc := (node ->> 'id')::uuid;
    -- The first process is the top one; every other has an earlier process of this call as its parent.
    if (node ->> 'parent_id') is null then
      if cardinality(made) > 0 then
        raise exception 'import_new_process: only the first process has no parent' using errcode = '22023';
      end if;
    elsif not ((node ->> 'parent_id')::uuid = any (made)) then
      raise exception 'import_new_process: a process can only sit inside an earlier one of the same import' using errcode = '22023';
    end if;
    if proc = any (made) then
      raise exception 'import_new_process: a process is listed twice' using errcode = '22023';
    end if;
    -- Same rule as the app's check: ignoring case and punctuation, the company map excluded, and the other new processes count too.
    nname := trim(regexp_replace(replace(lower(coalesce(node ->> 'name', '')), '&', ' and '), '[^[:alnum:]]+', ' ', 'g'));
    select p.name into clash from public.processes p
    -- B19: an archived process gives its name up.
    where p.workspace_id = p_workspace and not p.is_company and p.archived_at is null
      and trim(regexp_replace(replace(lower(p.name), '&', ' and '), '[^[:alnum:]]+', ' ', 'g')) = nname limit 1;
    if clash is null and nname = any (names) then
      clash := node ->> 'name';
    end if;
    names := names || nname;
    if clash is not null then
      raise exception 'You already have a process called ''%''. Give this one a different name.', clash using errcode = '23505', hint = 'name_taken';
    end if;
    made := made || proc;
    insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
    values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_id')::uuid);
    draft := public.open_draft(proc);
    if draft ->> 'status' is distinct from 'ok' then
      raise exception 'import_new_process: could not open a draft' using errcode = '42501';
    end if;
    revisions := revisions || jsonb_build_object(proc::text, draft ->> 'revision_id');
    result := result || jsonb_build_object('process_id', proc, 'revision_id', draft ->> 'revision_id', 'number', (draft ->> 'number')::int);
  end loop;

  -- 2. Existing processes that move inside a step of the new ones.
  for adopt in select value from jsonb_array_elements(coalesce(p_adopt, '[]')) loop
    if not ((adopt ->> 'parent_id')::uuid = any (made)) then
      raise exception 'import_new_process: a process can only be moved inside a new one of this import' using errcode = '22023';
    end if;
    update public.processes p set parent_process_id = (adopt ->> 'parent_id')::uuid
    where p.id = (adopt ->> 'id')::uuid and p.workspace_id = p_workspace and p.parent_process_id is null and not p.is_company
      and not ((adopt ->> 'id')::uuid = any (made));
    if not found then
      raise exception 'import_new_process: a process to move inside another was not found, or already sits inside one' using errcode = '42501';
    end if;
  end loop;

  -- 3. Each process's steps (a group's first step is set once they are all in), then its edges.
  for node in select value from jsonb_array_elements(p_nodes) loop
    proc := (node ->> 'id')::uuid;
    rev := (revisions ->> proc::text)::uuid;

    select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null, 'created_by', auth.uid())), '[]')
      into rows_json from jsonb_array_elements(coalesce(node -> 'steps', '[]')) s;
    if jsonb_array_length(rows_json) > 0 then
      select string_agg(quote_ident(k), ', ') into cols from (select distinct jsonb_object_keys(r.value) k from jsonb_array_elements(rows_json) r) q;
      execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows_json;
      update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
      from jsonb_array_elements(node -> 'steps') s
      where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
    end if;

    select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'created_by', auth.uid())), '[]')
      into rows_json from jsonb_array_elements(coalesce(node -> 'edges', '[]')) e;
    if jsonb_array_length(rows_json) > 0 then
      select string_agg(quote_ident(k), ', ') into cols from (select distinct jsonb_object_keys(r.value) k from jsonb_array_elements(rows_json) r) q;
      execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows_json;
    end if;
  end loop;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- A source's original file
-- ---------------------------------------------------------------------------

alter table public.sources
  add column file_path text,
  add column file_name text,
  add column file_type text,
  add column file_size integer;

alter table public.sources
  add constraint sources_file_all_or_none check (
    (file_path is null and file_name is null and file_type is null and file_size is null)
    or (file_path is not null and file_name is not null and file_type is not null and file_size is not null)) not valid,
  -- `<workspace id>/<source id>/<uuid>/<name>`: the source's own workspace and its own folder (the storage policies key on both).
  add constraint sources_file_path_shape check (
    file_path is null or (split_part(file_path, '/', 1) = workspace_id::text and split_part(file_path, '/', 2) = id::text
      and file_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}$')) not valid,
  add constraint sources_file_type check (file_type is null or file_type in ('txt', 'md', 'csv', 'xlsx', 'pdf')) not valid,
  add constraint sources_file_size check (file_size is null or file_size between 1 and 10485760) not valid,
  add constraint sources_file_name_length check (file_name is null or char_length(btrim(file_name)) between 1 and 200) not valid;

-- The workspace an object of the `sources` bucket belongs to: the first folder of its name, when that is a uuid. Null
-- otherwise, so a name that doesn't follow the layout is nobody's (and `can_read_workspace(null)` is false for members).
create function private.storage_workspace(object_name text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', 1)::uuid end;
$$;

revoke all on function private.storage_workspace(text) from public, anon;
grant execute on function private.storage_workspace(text) to authenticated;

-- A private bucket: nothing is served without a signed-in member's policy or a short signed link. Storage itself refuses a
-- file over 10 MB or with another declared type; the app checks the size and the real content again on the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sources', 'sources', false, 10485760, array[
  'text/plain', 'text/markdown', 'text/csv', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- Keyed by the workspace id in the object's first folder; anon has no policy, so nothing. An object is
-- `<workspace>/<source id>/<uuid>/<name>.<txt|md|csv|xlsx|pdf>`, for a source of that workspace.
--   * Read: members of the workspace read a file only once a source keeps it (`sources.file_path`), which the app writes only
--     after checking the file on the server; until then only the person who uploaded it can read it (the app's server reads it
--     back as them to check it). So an upload being checked, refused or abandoned is never readable by anyone else.
--   * Upload: owners, editors and agency admins, as themselves (`owner_id`), into the folder of a source of the workspace, under
--     a name no source keeps yet (a kept file can't be swapped by deleting and uploading again under its name).
--   * Delete: owners, editors and agency admins (a refused upload, a replaced file, a deleted source's file).
--   * No update: a file is never replaced in place.
create policy "sources: members read" on storage.objects for select to authenticated
  using (bucket_id = 'sources' and private.storage_workspace(objects.name) is not null and (
    (public.can_read_workspace(private.storage_workspace(objects.name))
      and exists (select 1 from public.sources s where s.workspace_id = private.storage_workspace(objects.name) and s.file_path = objects.name))
    or (public.can_edit_workspace(private.storage_workspace(objects.name)) and objects.owner_id = (select auth.uid())::text)));

create policy "sources: editors upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'sources' and private.storage_workspace(objects.name) is not null
    and public.can_edit_workspace(private.storage_workspace(objects.name))
    and objects.owner_id = (select auth.uid())::text
    and objects.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}\.(txt|md|csv|xlsx|pdf)$'
    and exists (select 1 from public.sources s where s.workspace_id = private.storage_workspace(objects.name) and s.id::text = split_part(objects.name, '/', 2))
    and not exists (select 1 from public.sources s where s.file_path = objects.name));

create policy "sources: editors delete" on storage.objects for delete to authenticated
  using (bucket_id = 'sources' and private.storage_workspace(objects.name) is not null and public.can_edit_workspace(private.storage_workspace(objects.name)));
