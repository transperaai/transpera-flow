-- Harden process versions and provenance columns against direct API writes (issue #171; follows #170's company map guards).
--
-- The row-level security policies on `process_revisions` and `processes` are generic: an editor with the REST API could, on any
-- ordinary process, delete a superseded version, set the live version back to a draft and edit it, point `live_revision_id` at an
-- old version (no publish, no audit entry), insert a `superseded` version, or rewrite `created_by`, `created_at` and `source`
-- (after which `log_process_import` would log "Imported from ..." for a colleague's process). #170 closed the history hole for the
-- company map only (`private.company_revision_guard`). This gives every process the same rules.
--
-- NO TABLE OR COLUMN CHANGES: three trigger functions and three triggers. Nothing is dropped. Applies to a signed-in caller only
-- (`current_user` is `authenticated` or `anon`); the system, the table owner, `service_role`, SECURITY DEFINER functions
-- (restore_version, the company map functions, log_process_import) and referential cascades (deleting a process or a workspace) are
-- not signed-in roles and pass, as in `private.refuse_row_moves`. The security-invoker functions the app calls (open_draft,
-- discard_draft, publish_process, duplicate_version) run as the signed-in role, and every write they make is allowed by these rules.
--
--   * `private.version_rules_guard` and trigger `version_rules_guard` (before insert, update or delete, each row, on
--     `public.process_revisions`): a signed-in caller may insert only a `draft`, made by themselves (`created_by` = auth.uid(),
--     `created_at` = now(), not published), and delete only a `draft`. On update: published to superseded changes `status` and
--     nothing else; a draft stays a draft with only its layout changed (number, author and dates are frozen); draft to published
--     writes exactly what publish_process writes (`published_by` = auth.uid(), `published_at` = now(), `number` = the process's next
--     number, nothing else but the layout). Every other status move is refused;
--   * `private.version_pointer_check` and constraint trigger `version_pointer_check` (after insert, update of status or delete,
--     deferred to commit): when a signed-in caller changed a process's versions, its live version is its published version and it
--     has at most one (a process has a live version if and only if it has a published one). The functions change statuses and the
--     pointer in separate statements, so this is checked at commit. It stops a direct supersede of the live version, or a direct
--     publish, that leaves the pointer behind;
--   * `private.process_rules_guard` and trigger `process_rules_guard` (before insert, or update of `live_revision_id`,
--     `draft_revision_id`, `created_by`, `created_at`, `source`, each row, on `public.processes`): a signed-in caller inserts a process
--     with no version pointers, `created_by` = auth.uid() and `created_at` = now(); and cannot change `created_by`, `created_at` or
--     `source` afterwards; `live_revision_id` may move only to a published version of the same process and may not be
--     cleared; `draft_revision_id` may move only to a draft of the same process, or be cleared (discard_draft). That is exactly what
--     open_draft, publish_process, discard_draft and duplicate_version do (restore_version is security definer);
--   * `private.version_rules_guard` overlaps `private.company_revision_guard` for the company map; both apply and neither is changed.
--     (One published version per process is kept by the existing unique index `process_revisions_one_published`.)
--
-- Preflight (production):
--   1. Nothing of ours is applied past 20261128000000 or this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261128500000';
--   2. 20261127500000 (company_map_editing) is applied, so private.refuse_row_moves exists. Expect one row, true:
--        select count(*) = 1 from pg_proc where pronamespace = 'private'::regnamespace and proname = 'refuse_row_moves';
--   3. The three functions are not there yet. Expect 0:
--        select count(*) from pg_proc where pronamespace = 'private'::regnamespace and proname in ('version_rules_guard', 'version_pointer_check', 'process_rules_guard');
--   4. The functions the guards rely on are as reviewed: the four the app calls as the signed-in caller are security invoker, and
--      restore_version is security definer. Expect 5 rows: duplicate_version, discard_draft, open_draft, publish_process false; restore_version true:
--        select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname in ('open_draft', 'discard_draft', 'publish_process', 'duplicate_version', 'restore_version') order by 1;
--   5. Every process is consistent, or the commit check would refuse an editor's next change to its versions. Expect 0 rows (a row
--      is an old oddity to repair first: live must be the process's one published version, and a process with a published version must have it live):
--        select p.id from public.processes p where p.live_revision_id is distinct from (select r.id from public.process_revisions r where r.process_id = p.id and r.status = 'published');
--
-- Post-apply checks:
--   1. The three functions are executable by nobody signed in or anonymous. Expect 0 rows:
--        select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')
--          and routine_name in ('version_rules_guard', 'version_pointer_check', 'process_rules_guard');
--   2. The three triggers are there, once each. Expect 1, 1, then 1:
--        select count(*) from pg_trigger where tgrelid = 'public.process_revisions'::regclass and tgname = 'version_rules_guard' and not tgisinternal;
--        select count(*) from pg_trigger where tgrelid = 'public.process_revisions'::regclass and tgname = 'version_pointer_check' and not tgisinternal;
--        select count(*) from pg_trigger where tgrelid = 'public.processes'::regclass and tgname = 'process_rules_guard' and not tgisinternal;
--   3. Nothing was changed by applying it: the row counts of the two tables are as before (note them first):
--        select (select count(*) from public.processes), (select count(*) from public.process_revisions);
--
-- Rollback (run in one transaction; no app change is needed, the app never relies on the refusals):
--
--   begin;
--   drop trigger process_rules_guard on public.processes;
--   drop trigger version_pointer_check on public.process_revisions;
--   drop trigger version_rules_guard on public.process_revisions;
--   drop function private.process_rules_guard();
--   drop function private.version_pointer_check();
--   drop function private.version_rules_guard();
--   delete from supabase_migrations.schema_migrations where version = '20261128500000';
--   commit;

-- ---------------------------------------------------------------------------
-- Versions: history is kept
-- ---------------------------------------------------------------------------

create function private.version_rules_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  fixed text[] := array['status', 'updated_at'];
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new version starts as a draft' using errcode = '55000';
    end if;
    if new.published_at is not null or new.published_by is not null or new.created_by is distinct from auth.uid() or new.created_at <> now() then
      raise exception 'A new draft is made by the person saving it, now, and not yet published' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published versions are kept: they are the history of the process' using errcode = '55000';
    end if;
    return old;
  end if;
  if old.status = 'published' and new.status = 'superseded' then
    -- Superseding changes the status and nothing else.
    if to_jsonb(new) - fixed is distinct from to_jsonb(old) - fixed then
      raise exception 'A published version is kept as it was: only its status moves, when a newer one is published' using errcode = '55000';
    end if;
  elsif old.status = 'draft' and new.status = 'draft' then
    -- A draft's contents are edited; who made it, when and its number are not.
    if to_jsonb(new) - (fixed || array['layout']) is distinct from to_jsonb(old) - (fixed || array['layout']) then
      raise exception 'A draft''s number, author and dates are not changed' using errcode = '55000';
    end if;
  elsif old.status = 'draft' and new.status = 'published' then
    -- Exactly what publish_process writes: the caller, now, and the next number.
    if to_jsonb(new) - (fixed || array['layout', 'number', 'published_at', 'published_by']) is distinct from to_jsonb(old) - (fixed || array['layout', 'number', 'published_at', 'published_by'])
       or new.published_by is distinct from auth.uid()
       or new.published_at is distinct from now()
       or new.number is distinct from coalesce((select max(r.number) from public.process_revisions r where r.process_id = new.process_id and r.id <> new.id), 0) + 1 then
      raise exception 'A draft is published by publishing it: the person, time and number are set then' using errcode = '55000';
    end if;
  else
    raise exception 'A version can''t change status that way: publishing and restoring do it' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.version_rules_guard() from public, anon, authenticated;

create trigger version_rules_guard before insert or update or delete on public.process_revisions
  for each row execute function private.version_rules_guard();

-- At commit, a signed-in caller's change to versions leaves the process consistent: it has a live version if and only if it has a
-- published one, and the live version is that published version. publish_process, restore_version, discard_draft, open_draft,
-- duplicate_version and the company map's system versions all do; a bare status update, or a bare delete, does not. Checked at
-- commit (deferred) because those functions change the statuses and the pointer in separate statements. The unique index
-- `process_revisions_one_published` keeps it to one published version.
create function private.version_pointer_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pid uuid := case when tg_op = 'DELETE' then old.process_id else new.process_id end;
  live uuid;
  published uuid[];
begin
  if current_user not in ('authenticated', 'anon') then
    return null;
  end if;
  select p.live_revision_id into live from public.processes p where p.id = pid;
  if not found then
    return null; -- the process was deleted, with its versions
  end if;
  select coalesce(array_agg(r.id), '{}') into published from public.process_revisions r where r.process_id = pid and r.status = 'published';
  if live is distinct from published[1] or cardinality(published) > 1 then
    raise exception 'The live version of a process is its published version: publish a draft or restore a version' using errcode = '55000';
  end if;
  return null;
end;
$$;

revoke all on function private.version_pointer_check() from public, anon, authenticated;

create constraint trigger version_pointer_check after insert or update of status or delete on public.process_revisions
  deferrable initially deferred for each row execute function private.version_pointer_check();

-- ---------------------------------------------------------------------------
-- Processes: provenance and the version pointers
-- ---------------------------------------------------------------------------

create function private.process_rules_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A new process has no versions yet, and is made by the person saving it, now.
    if new.live_revision_id is not null or new.draft_revision_id is not null or new.created_by is distinct from auth.uid() or new.created_at <> now() then
      raise exception 'A new process has no versions yet and is made by the person saving it, now' using errcode = '55000';
    end if;
    return new;
  end if;
  if (new.created_by, new.created_at, new.source) is distinct from (old.created_by, old.created_at, old.source) then
    raise exception 'Who made a process, when and from where is not changed' using errcode = '55000';
  end if;
  if new.live_revision_id is distinct from old.live_revision_id then
    if new.live_revision_id is null then
      raise exception 'A process keeps its live version' using errcode = '55000';
    end if;
    if not exists (select 1 from public.process_revisions r where r.id = new.live_revision_id and r.process_id = new.id and r.status = 'published') then
      raise exception 'The live version is the process''s published version: publish a draft or restore a version' using errcode = '55000';
    end if;
  end if;
  if new.draft_revision_id is distinct from old.draft_revision_id and new.draft_revision_id is not null
     and not exists (select 1 from public.process_revisions r where r.id = new.draft_revision_id and r.process_id = new.id and r.status = 'draft') then
    raise exception 'The open draft is one of the process''s own drafts' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.process_rules_guard() from public, anon, authenticated;

create trigger process_rules_guard before insert or update of live_revision_id, draft_revision_id, created_by, created_at, source on public.processes
  for each row execute function private.process_rules_guard();
