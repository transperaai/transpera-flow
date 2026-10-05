-- Everything can be added by hand, part 2 (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"; PRD D43): archiving and
-- restoring a process, and keeping the original file of a source in Supabase Storage.
--
-- Processes were already created, renamed and re-kinded by editors with ordinary writes (RLS: owners and editors write,
-- viewers read; the company map's sync reacts to a rename or a kind change). What was missing, and what this adds:
--
--   * `processes.archived_at` and `processes.archived_by` (nullable): an archived process is soft deleted. The app and MCP
--     leave it out of every list, the company map and the simulation (`listProcesses` filters it), and its versions, history,
--     issues and sources are all kept. Restoring it clears both columns. Nothing deletes a process.
--   * `private.process_archive_guard` and its trigger (before update of `archived_at`, every caller): the company map is never
--     archived; archiving stamps `now()` and `auth.uid()`; a process that sits inside another ordinary process (a live link)
--     or that holds other processes in its live version is REFUSED, with a plain message naming them (take it out, or take
--     them out, and publish first). So an archived process is never inside, nor holding, a live process.
--   * `private.process_archive_map` and its trigger (after update of `archived_at`): archiving takes the process's card off
--     the company map as a system version ("Archived Sales"; an open draft of the map loses the card too), restoring puts it
--     back at the bottom of its column ("Restored Sales"), through the map's existing sync (`private.company_map_apply`).
--   * `private.refuse_archived_placements` and its trigger (before update of `live_revision_id`, every caller): publishing (or
--     any other road to a new live version) that newly holds an archived process is refused ("Sales is archived. ...").
--   * `private.holder_allows` (full copy of 20261130000000's, changed): an archived process may not be placed. So placing it in
--     a draft is refused, and `restore_version` (which already asks `holder_allows`) skips its card on a restored company map
--     and unlinks it in a restored ordinary process. `private.check_step_nesting` (full copy of 20261130000000's, changed: the
--     message only) says "Sales is archived" instead of the generic refusal. `private.company_add_holder` (full copy of
--     20261130000000's, changed): the system never puts an archived process's card on the company map.
--   * Source files: `sources.file_path`, `file_name`, `file_type` and `file_size` (nullable, all set or none), with checks: the
--     path is `<workspace_id>/<uuid>/<name>` inside the source's own workspace, the type is one of txt, md, csv, xlsx, pdf, and
--     the size is 1 byte to 10 MB. The text extracted from the file is the source's `body` (as pasted text always was).
--   * Supabase Storage: a PRIVATE bucket `sources` (10 MB per file, and only the five MIME types the app sends), and four
--     policies on `storage.objects` for that bucket, keyed by the workspace id in the first folder of the object's name:
--     members of the workspace read (download, signed links), owners, editors and agency admins upload, replace and delete,
--     `anon` nothing (no policy is granted to anon). The object name must be `<workspace uuid>/<uuid>/<file>.<txt|md|csv|xlsx|pdf>`.
--     `private.storage_workspace(text)` reads that first folder as a uuid (null when it is not one).
--
-- STRICTLY ADDITIVE: new nullable columns (no default, so no rewrite), NOT VALID checks on new columns, new functions and
-- triggers, three functions replaced with the same signatures, one bucket row and four storage policies. No existing column,
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
--        select proname from pg_proc where pronamespace = 'private'::regnamespace and proname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'storage_workspace');
--        select id from storage.buckets where id = 'sources';
--        select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'sources:%';
--   3. The replaced functions are the bodies this copies (20261130000000's), not yet changed. Expect 3 rows, each true:
--        select proname, case proname
--            when 'holder_allows' then prosrc like '%not coalesce(child.is_company, false)%' and prosrc not like '%archived%'
--            when 'check_step_nesting' then prosrc like '%a process can''''t hold itself or the company map%' and prosrc not like '%archived%'
--            else prosrc like '%B12: a process another process holds (live)%' and prosrc not like '%archived%' end
--        from pg_proc where pronamespace = 'private'::regnamespace and proname in ('holder_allows', 'check_step_nesting', 'company_add_holder');
--   4. Storage is there, with RLS on its objects. Expect 1 row, true:
--        select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;
--
-- POST-APPLY CHECK:
--   1. Three triggers exist and are enabled. Expect 3 rows, tgenabled 'O':
--        select tgname, tgenabled from pg_trigger where tgname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements') and not tgisinternal;
--   2. The bucket is private with its limits. Expect 1 row: false, 10485760, 5 types:
--        select public, file_size_limit, cardinality(allowed_mime_types) from storage.buckets where id = 'sources';
--   3. Four policies, all for authenticated. Expect 4 rows, roles {authenticated}:
--        select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'sources:%';
--   4. The new private functions have an empty search_path and no EXECUTE for anon or PUBLIC (storage_workspace is executable
--      by authenticated, which the policies need). Expect 4 rows with {search_path=""}, then 1 row (authenticated, storage_workspace):
--        select proname, proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'storage_workspace');
--        select grantee, routine_name from information_schema.routine_privileges where routine_schema = 'private' and routine_name in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'storage_workspace') and grantee in ('anon', 'authenticated', 'PUBLIC');
--
-- ROLLBACK (redeploy the app to a build from before it FIRST; run as one transaction. Archived processes come back as ordinary
-- processes, with no card on the company map until someone places one; uploaded files stay in the bucket, unreachable from the
-- app, until the bucket is emptied from the Storage dashboard; a bucket with objects can't be deleted from SQL):
--
--   begin;
--   drop policy if exists "sources: members read" on storage.objects;
--   drop policy if exists "sources: editors upload" on storage.objects;
--   drop policy if exists "sources: editors replace" on storage.objects;
--   drop policy if exists "sources: editors delete" on storage.objects;
--   -- Keep the bucket row if it has objects (empty it from the dashboard, then): delete from storage.buckets where id = 'sources';
--   drop function if exists private.storage_workspace(text);
--   alter table public.sources drop constraint if exists sources_file_all_or_none, drop constraint if exists sources_file_path_shape,
--     drop constraint if exists sources_file_type, drop constraint if exists sources_file_size, drop constraint if exists sources_file_name_length;
--   alter table public.sources drop column if exists file_path, drop column if exists file_name, drop column if exists file_type, drop column if exists file_size;
--   drop trigger if exists refuse_archived_placements on public.processes;
--   drop function if exists private.refuse_archived_placements();
--   drop trigger if exists process_archive_map on public.processes;
--   drop function if exists private.process_archive_map();
--   drop trigger if exists process_archive_guard on public.processes;
--   drop function if exists private.process_archive_guard();
--   -- Re-create 20261130000000's bodies of private.holder_allows, private.check_step_nesting and private.company_add_holder
--   -- (copy the three `create or replace function` blocks from that migration), then:
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

-- Before an archive or a restore. Archiving is refused for the company map, for a process that sits inside another ordinary
-- process (live), and for one whose live version holds other processes: an archived process is never part of the live tree,
-- so nothing simulated or drawn depends on it. Security definer: it reads every link of the workspace, whatever the caller may
-- read, and names only processes of the same workspace.
create function private.process_archive_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  holder public.processes;
  held text;
begin
  if new.is_company then
    raise exception 'The company map can''t be archived' using errcode = '55000';
  end if;
  if new.archived_at is null then
    -- Restore.
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
  new.archived_at := now();
  new.archived_by := auth.uid();
  return new;
end;
$$;

revoke all on function private.process_archive_guard() from public, anon, authenticated;

create trigger process_archive_guard before update of archived_at on public.processes
  for each row when (new.archived_at is distinct from old.archived_at)
  execute function private.process_archive_guard();

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
  -- `<workspace_id>/<uuid>/<name>`, in the source's own workspace (the folder the storage policies key on).
  add constraint sources_file_path_shape check (
    file_path is null or (split_part(file_path, '/', 1) = workspace_id::text
      and file_path ~ '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}$')) not valid,
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

-- Members read; owners, editors and agency admins upload, replace and delete; anon has no policy, so nothing. Keyed by the
-- workspace id in the object's first folder. Uploads must follow `<workspace>/<uuid>/<name>.<txt|md|csv|xlsx|pdf>`.
create policy "sources: members read" on storage.objects for select to authenticated
  using (bucket_id = 'sources' and private.storage_workspace(name) is not null and public.can_read_workspace(private.storage_workspace(name)));

create policy "sources: editors upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'sources' and private.storage_workspace(name) is not null and public.can_edit_workspace(private.storage_workspace(name))
    and name ~* '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}\.(txt|md|csv|xlsx|pdf)$');

create policy "sources: editors replace" on storage.objects for update to authenticated
  using (bucket_id = 'sources' and private.storage_workspace(name) is not null and public.can_edit_workspace(private.storage_workspace(name)))
  with check (bucket_id = 'sources' and private.storage_workspace(name) is not null and public.can_edit_workspace(private.storage_workspace(name))
    and name ~* '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}\.(txt|md|csv|xlsx|pdf)$');

create policy "sources: editors delete" on storage.objects for delete to authenticated
  using (bucket_id = 'sources' and private.storage_workspace(name) is not null and public.can_edit_workspace(private.storage_workspace(name)));
