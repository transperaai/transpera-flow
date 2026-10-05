-- Production apply file for 20261128500000_harden_versions (issue #171). Run after 20261127500000 (company_map_editing) and, if pending, 20261128000000 (#172).
-- The preflight queries, post-apply checks and rollback are in the migration's own header, repeated below. No app deploy order: the app never relies on the refusals.

begin;
set local lock_timeout = '5s';

-- Harden process versions and provenance columns against direct API writes (issue #171; follows #170's company map guards).
--
-- The row-level security policies on `process_revisions` and `processes` are generic: an editor with the REST API could, on any
-- ordinary process, delete a superseded version, set the live version back to a draft and edit it, point `live_revision_id` at an
-- old version (no publish, no audit entry), insert a `superseded` version, or rewrite `created_by`, `created_at` and `source`
-- (after which `log_process_import` would log "Imported from ..." for a colleague's process). #170 closed the history hole for the
-- company map only (`private.company_revision_guard`). This gives every process the same rules.
--
-- NO TABLE OR COLUMN CHANGES: two trigger functions and two triggers. Nothing is dropped. Applies to a signed-in caller only
-- (`current_user` is `authenticated` or `anon`); the system, the table owner, `service_role`, SECURITY DEFINER functions
-- (restore_version, the company map functions, log_process_import) and referential cascades (deleting a process or a workspace) are
-- not signed-in roles and pass, as in `private.refuse_row_moves`. The security-invoker functions the app calls (open_draft,
-- discard_draft, publish_process, duplicate_version) run as the signed-in role, and every write they make is allowed by these rules.
--
--   * `private.version_rules_guard` and trigger `version_rules_guard` (before insert, update or delete, each row, on
--     `public.process_revisions`): a signed-in caller may insert only a `draft`, delete only a `draft`, and change `status` only
--     draft to published or published to superseded (a published or superseded version is otherwise never edited: an update that
--     leaves it as it was is refused too, as for the company map). A draft may be published only while the process has no other
--     published version (publish_process supersedes the old one first), so a direct update cannot leave two live versions;
--   * `private.process_rules_guard` and trigger `process_rules_guard` (before update of `live_revision_id`, `draft_revision_id`,
--     `created_by`, `created_at`, `source`, each row, on `public.processes`): a signed-in caller cannot change `created_by`,
--     `created_at` or `source`; `live_revision_id` may move only to a published version of the same process and may not be
--     cleared; `draft_revision_id` may move only to a draft of the same process, or be cleared (discard_draft). That is exactly what
--     open_draft, publish_process, discard_draft and duplicate_version do (restore_version is security definer);
--   * `private.version_rules_guard` overlaps `private.company_revision_guard` for the company map; both apply and neither is changed.
--
-- Not covered (noted in docs/supabase-notes.md): a direct draft to published update on a process that has no published version, or a
-- direct published to superseded update, can still be made by an editor; they skip the audit entry and leave the pointer as it was.
-- Closing that needs the status moves to go only through the functions (a marker the invoker functions set), a separate change.
--
-- Preflight (production):
--   1. Nothing of ours is applied past 20261128000000 or this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261128500000';
--   2. 20261127500000 (company_map_editing) is applied, so private.refuse_row_moves exists. Expect one row, true:
--        select count(*) = 1 from pg_proc where pronamespace = 'private'::regnamespace and proname = 'refuse_row_moves';
--   3. The two functions are not there yet. Expect 0:
--        select count(*) from pg_proc where pronamespace = 'private'::regnamespace and proname in ('version_rules_guard', 'process_rules_guard');
--   4. The functions the guards rely on are as reviewed: the four the app calls as the signed-in caller are security invoker, and
--      restore_version is security definer. Expect 5 rows: duplicate_version, discard_draft, open_draft, publish_process false; restore_version true:
--        select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname in ('open_draft', 'discard_draft', 'publish_process', 'duplicate_version', 'restore_version') order by 1;
--   5. For information (the guards only act on future writes): processes whose live pointer is not a published version of the
--      process. Expect 0 rows (a row here is an old oddity the guard will refuse to repeat, not to repair):
--        select p.id from public.processes p where p.live_revision_id is not null and not exists (select 1 from public.process_revisions r where r.id = p.live_revision_id and r.process_id = p.id and r.status = 'published');
--
-- Post-apply checks:
--   1. The two functions are executable by nobody signed in or anonymous. Expect 0 rows:
--        select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')
--          and routine_name in ('version_rules_guard', 'process_rules_guard');
--   2. The two triggers are there, once each. Expect 1, then 1:
--        select count(*) from pg_trigger where tgrelid = 'public.process_revisions'::regclass and tgname = 'version_rules_guard' and not tgisinternal;
--        select count(*) from pg_trigger where tgrelid = 'public.processes'::regclass and tgname = 'process_rules_guard' and not tgisinternal;
--   3. Nothing was changed by applying it: the row counts of the two tables are as before (note them first):
--        select (select count(*) from public.processes), (select count(*) from public.process_revisions);
--
-- Rollback (run in one transaction; no app change is needed, the app never relies on the refusals):
--
--   begin;
--   drop trigger process_rules_guard on public.processes;
--   drop trigger version_rules_guard on public.process_revisions;
--   drop function private.process_rules_guard();
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
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new version starts as a draft' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published versions are kept: they are the history of the process' using errcode = '55000';
    end if;
    return old;
  end if;
  if not ((old.status = 'draft' and new.status in ('draft', 'published')) or (old.status = 'published' and new.status = 'superseded')) then
    raise exception 'A version can''t change status that way: publishing and restoring do it' using errcode = '55000';
  end if;
  if old.status = 'draft' and new.status = 'published'
     and exists (select 1 from public.process_revisions r where r.process_id = new.process_id and r.status = 'published' and r.id <> new.id) then
    raise exception 'A process has one published version: publish the draft to replace it' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.version_rules_guard() from public, anon, authenticated;

create trigger version_rules_guard before insert or update or delete on public.process_revisions
  for each row execute function private.version_rules_guard();

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

create trigger process_rules_guard before update of live_revision_id, draft_revision_id, created_by, created_at, source on public.processes
  for each row execute function private.process_rules_guard();

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261128500000', 'harden_versions', array[$mig$-- Harden process versions and provenance columns against direct API writes (issue #171; follows #170's company map guards).
--
-- The row-level security policies on `process_revisions` and `processes` are generic: an editor with the REST API could, on any
-- ordinary process, delete a superseded version, set the live version back to a draft and edit it, point `live_revision_id` at an
-- old version (no publish, no audit entry), insert a `superseded` version, or rewrite `created_by`, `created_at` and `source`
-- (after which `log_process_import` would log "Imported from ..." for a colleague's process). #170 closed the history hole for the
-- company map only (`private.company_revision_guard`). This gives every process the same rules.
--
-- NO TABLE OR COLUMN CHANGES: two trigger functions and two triggers. Nothing is dropped. Applies to a signed-in caller only
-- (`current_user` is `authenticated` or `anon`); the system, the table owner, `service_role`, SECURITY DEFINER functions
-- (restore_version, the company map functions, log_process_import) and referential cascades (deleting a process or a workspace) are
-- not signed-in roles and pass, as in `private.refuse_row_moves`. The security-invoker functions the app calls (open_draft,
-- discard_draft, publish_process, duplicate_version) run as the signed-in role, and every write they make is allowed by these rules.
--
--   * `private.version_rules_guard` and trigger `version_rules_guard` (before insert, update or delete, each row, on
--     `public.process_revisions`): a signed-in caller may insert only a `draft`, delete only a `draft`, and change `status` only
--     draft to published or published to superseded (a published or superseded version is otherwise never edited: an update that
--     leaves it as it was is refused too, as for the company map). A draft may be published only while the process has no other
--     published version (publish_process supersedes the old one first), so a direct update cannot leave two live versions;
--   * `private.process_rules_guard` and trigger `process_rules_guard` (before update of `live_revision_id`, `draft_revision_id`,
--     `created_by`, `created_at`, `source`, each row, on `public.processes`): a signed-in caller cannot change `created_by`,
--     `created_at` or `source`; `live_revision_id` may move only to a published version of the same process and may not be
--     cleared; `draft_revision_id` may move only to a draft of the same process, or be cleared (discard_draft). That is exactly what
--     open_draft, publish_process, discard_draft and duplicate_version do (restore_version is security definer);
--   * `private.version_rules_guard` overlaps `private.company_revision_guard` for the company map; both apply and neither is changed.
--
-- Not covered (noted in docs/supabase-notes.md): a direct draft to published update on a process that has no published version, or a
-- direct published to superseded update, can still be made by an editor; they skip the audit entry and leave the pointer as it was.
-- Closing that needs the status moves to go only through the functions (a marker the invoker functions set), a separate change.
--
-- Preflight (production):
--   1. Nothing of ours is applied past 20261128000000 or this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261128500000';
--   2. 20261127500000 (company_map_editing) is applied, so private.refuse_row_moves exists. Expect one row, true:
--        select count(*) = 1 from pg_proc where pronamespace = 'private'::regnamespace and proname = 'refuse_row_moves';
--   3. The two functions are not there yet. Expect 0:
--        select count(*) from pg_proc where pronamespace = 'private'::regnamespace and proname in ('version_rules_guard', 'process_rules_guard');
--   4. The functions the guards rely on are as reviewed: the four the app calls as the signed-in caller are security invoker, and
--      restore_version is security definer. Expect 5 rows: duplicate_version, discard_draft, open_draft, publish_process false; restore_version true:
--        select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname in ('open_draft', 'discard_draft', 'publish_process', 'duplicate_version', 'restore_version') order by 1;
--   5. For information (the guards only act on future writes): processes whose live pointer is not a published version of the
--      process. Expect 0 rows (a row here is an old oddity the guard will refuse to repeat, not to repair):
--        select p.id from public.processes p where p.live_revision_id is not null and not exists (select 1 from public.process_revisions r where r.id = p.live_revision_id and r.process_id = p.id and r.status = 'published');
--
-- Post-apply checks:
--   1. The two functions are executable by nobody signed in or anonymous. Expect 0 rows:
--        select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')
--          and routine_name in ('version_rules_guard', 'process_rules_guard');
--   2. The two triggers are there, once each. Expect 1, then 1:
--        select count(*) from pg_trigger where tgrelid = 'public.process_revisions'::regclass and tgname = 'version_rules_guard' and not tgisinternal;
--        select count(*) from pg_trigger where tgrelid = 'public.processes'::regclass and tgname = 'process_rules_guard' and not tgisinternal;
--   3. Nothing was changed by applying it: the row counts of the two tables are as before (note them first):
--        select (select count(*) from public.processes), (select count(*) from public.process_revisions);
--
-- Rollback (run in one transaction; no app change is needed, the app never relies on the refusals):
--
--   begin;
--   drop trigger process_rules_guard on public.processes;
--   drop trigger version_rules_guard on public.process_revisions;
--   drop function private.process_rules_guard();
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
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new version starts as a draft' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published versions are kept: they are the history of the process' using errcode = '55000';
    end if;
    return old;
  end if;
  if not ((old.status = 'draft' and new.status in ('draft', 'published')) or (old.status = 'published' and new.status = 'superseded')) then
    raise exception 'A version can''t change status that way: publishing and restoring do it' using errcode = '55000';
  end if;
  if old.status = 'draft' and new.status = 'published'
     and exists (select 1 from public.process_revisions r where r.process_id = new.process_id and r.status = 'published' and r.id <> new.id) then
    raise exception 'A process has one published version: publish the draft to replace it' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.version_rules_guard() from public, anon, authenticated;

create trigger version_rules_guard before insert or update or delete on public.process_revisions
  for each row execute function private.version_rules_guard();

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

create trigger process_rules_guard before update of live_revision_id, draft_revision_id, created_by, created_at, source on public.processes
  for each row execute function private.process_rules_guard();
$mig$]);

commit;
