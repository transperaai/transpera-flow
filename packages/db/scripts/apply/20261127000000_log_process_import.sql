-- Production apply file for 20261127000000_log_process_import (B13 slice 1, issue #166). One function; no dependencies beyond
-- `can_edit_workspace` and `audit_log`. Run the preflight in the migration's header first (expect 0, 0 rows, one row listing 'import').
--
-- Post-apply grant check (authenticated may execute it; anon and PUBLIC may not):
--        select grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'log_process_import' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1;
--        select proacl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_process_import';
--   Expect: one row, authenticated EXECUTE; and an ACL with an `authenticated=X/...` entry and no `anon=` and no `=X/...`.

begin;
set local lock_timeout = '5s';

-- Audit entry for an uploaded process (issue #166, ticket B13, slice 1 of 2).
--
-- "Upload process" on the Processes page creates a new process with a draft from a file (or, in slice 2, a link). The change
-- log must say where it came from: "Imported from <file name | link>". `audit_log` is written only by SECURITY DEFINER
-- functions and triggers (clients have no INSERT), so this adds the one function that writes that entry:
--
--   * `public.log_process_import(target_process, import_source)`: SECURITY DEFINER with an empty search_path. It writes one
--     `audit_log` row (action `import`, target `processes`, diff `{source, text}`) for a process the caller may edit
--     (`can_edit_workspace`). It is not a general-purpose logger. The process must be one made by an import
--     (`processes.source = 'import'`), made by the caller (`created_by = auth.uid()`) in the last ten minutes, and not logged
--     yet; the row is locked (`for update`) while that is checked, so two calls at once cannot both write. So it cannot put text
--     on someone else's process, on an old one, or repeat an entry. The source text is cut to 300 characters. The actor kind is
--     `mcp` for an API-token request and `user` otherwise. (A process made a moment ago by the caller's own MCP `import_process`
--     also passes: the caller can write one entry saying where it came from, about their own new process.)
--
-- STRICTLY ADDITIVE: one function. No table, column, constraint, trigger or existing function is changed.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. The function does not exist yet. Expect 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_process_import';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261127000000';
--   3. `processes.source` allows 'import'. Expect one row whose definition lists 'import':
--        select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.processes'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%source%';
--
-- Post-apply grant check (authenticated may execute it; anon and PUBLIC may not):
--        select grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'log_process_import' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1;
--        select proacl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_process_import';
--   Expect: one row, authenticated EXECUTE; and an ACL with an `authenticated=X/...` entry and no `anon=` and no `=X/...` (an entry
--   with an empty grantee is PUBLIC).
--
-- Rollback (run as one transaction; nothing existing was changed):
--
--   begin;
--   drop function if exists public.log_process_import(uuid, text);
--   delete from supabase_migrations.schema_migrations where version = '20261127000000';
--   commit;
--
-- Entries already written stay in `audit_log` (it keeps entries beyond the things they describe).
--
-- Production data: none needed.

create function public.log_process_import(target_process uuid, import_source text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  proc public.processes;
  label text := left(trim(coalesce(import_source, '')), 300);
begin
  select p.* into proc from public.processes p where p.id = target_process for update;
  -- Not found, not allowed, someone else's and too old all look the same.
  if not found
    or not coalesce(public.can_edit_workspace(proc.workspace_id), false)
    or proc.created_by is distinct from auth.uid()
    or proc.created_at < now() - interval '10 minutes' then
    raise exception 'log_process_import: no such process' using errcode = '42501';
  end if;
  if proc.source <> 'import' then
    raise exception 'log_process_import: that process was not made by an import' using errcode = '22023';
  end if;
  if label = '' then
    raise exception 'log_process_import: say where it was imported from' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.audit_log l
    where l.workspace_id = proc.workspace_id and l.target_table = 'processes' and l.target_id = proc.id and l.action = 'import'
  ) then
    raise exception 'log_process_import: this import is already logged' using errcode = '22023';
  end if;
  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    proc.workspace_id,
    auth.uid(),
    case when coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then 'mcp' else 'user' end,
    'import',
    'processes',
    proc.id,
    jsonb_build_object('source', label, 'text', 'Imported from ' || label)
  );
end;
$$;

revoke all on function public.log_process_import(uuid, text) from public, anon;
grant execute on function public.log_process_import(uuid, text) to authenticated;

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261127000000', 'log_process_import', array[$mig$-- Audit entry for an uploaded process (issue #166, ticket B13, slice 1 of 2).
--
-- "Upload process" on the Processes page creates a new process with a draft from a file (or, in slice 2, a link). The change
-- log must say where it came from: "Imported from <file name | link>". `audit_log` is written only by SECURITY DEFINER
-- functions and triggers (clients have no INSERT), so this adds the one function that writes that entry:
--
--   * `public.log_process_import(target_process, import_source)`: SECURITY DEFINER with an empty search_path. It writes one
--     `audit_log` row (action `import`, target `processes`, diff `{source, text}`) for a process the caller may edit
--     (`can_edit_workspace`). It is not a general-purpose logger. The process must be one made by an import
--     (`processes.source = 'import'`), made by the caller (`created_by = auth.uid()`) in the last ten minutes, and not logged
--     yet; the row is locked (`for update`) while that is checked, so two calls at once cannot both write. So it cannot put text
--     on someone else's process, on an old one, or repeat an entry. The source text is cut to 300 characters. The actor kind is
--     `mcp` for an API-token request and `user` otherwise. (A process made a moment ago by the caller's own MCP `import_process`
--     also passes: the caller can write one entry saying where it came from, about their own new process.)
--
-- STRICTLY ADDITIVE: one function. No table, column, constraint, trigger or existing function is changed.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. The function does not exist yet. Expect 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_process_import';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261127000000';
--   3. `processes.source` allows 'import'. Expect one row whose definition lists 'import':
--        select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.processes'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%source%';
--
-- Post-apply grant check (authenticated may execute it; anon and PUBLIC may not):
--        select grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'log_process_import' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1;
--        select proacl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_process_import';
--   Expect: one row, authenticated EXECUTE; and an ACL with an `authenticated=X/...` entry and no `anon=` and no `=X/...` (an entry
--   with an empty grantee is PUBLIC).
--
-- Rollback (run as one transaction; nothing existing was changed):
--
--   begin;
--   drop function if exists public.log_process_import(uuid, text);
--   delete from supabase_migrations.schema_migrations where version = '20261127000000';
--   commit;
--
-- Entries already written stay in `audit_log` (it keeps entries beyond the things they describe).
--
-- Production data: none needed.

create function public.log_process_import(target_process uuid, import_source text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  proc public.processes;
  label text := left(trim(coalesce(import_source, '')), 300);
begin
  select p.* into proc from public.processes p where p.id = target_process for update;
  -- Not found, not allowed, someone else's and too old all look the same.
  if not found
    or not coalesce(public.can_edit_workspace(proc.workspace_id), false)
    or proc.created_by is distinct from auth.uid()
    or proc.created_at < now() - interval '10 minutes' then
    raise exception 'log_process_import: no such process' using errcode = '42501';
  end if;
  if proc.source <> 'import' then
    raise exception 'log_process_import: that process was not made by an import' using errcode = '22023';
  end if;
  if label = '' then
    raise exception 'log_process_import: say where it was imported from' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.audit_log l
    where l.workspace_id = proc.workspace_id and l.target_table = 'processes' and l.target_id = proc.id and l.action = 'import'
  ) then
    raise exception 'log_process_import: this import is already logged' using errcode = '22023';
  end if;
  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    proc.workspace_id,
    auth.uid(),
    case when coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then 'mcp' else 'user' end,
    'import',
    'processes',
    proc.id,
    jsonb_build_object('source', label, 'text', 'Imported from ' || label)
  );
end;
$$;

revoke all on function public.log_process_import(uuid, text) from public, anon;
grant execute on function public.log_process_import(uuid, text) to authenticated;
$mig$]);

commit;
