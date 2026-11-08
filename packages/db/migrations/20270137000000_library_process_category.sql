-- A new process is made by category (D52): the company map's "New process" chooses one of the five categories, as the Processes page does,
-- and the engine kind follows from it. `public.create_library_process` takes the category as an optional last parameter.
--
-- What this does:
--   1. `public.create_library_process(uuid, text, text, text, text, text, text)`: a full copy of 20261204000000's body (the latest that defines it;
--      20261130000000 made it, 20270126000000 added the category column and its before-insert default trigger but did not touch this function),
--      with `p_category text default null` as the last parameter. When given, it is inserted as the process's category (the table's check
--      constraint refuses one that isn't a category); when null the insert leaves it null and `private.default_process_category` fills it from the
--      kind, exactly as before. A caller that sends six arguments is unchanged.
--   2. The six-argument signature is dropped (Postgres would otherwise keep both overloads, and a call with six arguments would be ambiguous),
--      and the new one gets the same grants: no `public` or `anon`, `authenticated` may execute. It stays SECURITY INVOKER with an empty search_path.
--
-- Safe on a database that holds real data: nothing is rewritten; one transaction.
--
-- Preflight:    select count(*) from public.schema_migrations where version >= '20270137000000' and version < '20270200000000';   -- expect 0
--               select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = 'create_library_process';     -- one row, six arguments
-- Post-apply:   select proname, pg_get_function_identity_arguments(oid), prosecdef from pg_proc where proname = 'create_library_process';  -- one row, seven arguments, f
--               select grantee, privilege_type from information_schema.routine_privileges where routine_name = 'create_library_process';  -- authenticated, EXECUTE (and the owner)
-- ROLLBACK (as the table owner, one transaction): put 20261204000000's six-argument function and its grants back:
--   begin;
--   drop function public.create_library_process(uuid, text, text, text, text, text, text);
--   -- then run the `create or replace function public.create_library_process(...)` of 20261204000000 and:
--   revoke execute on function public.create_library_process(uuid, text, text, text, text, text) from public, anon;
--   grant execute on function public.create_library_process(uuid, text, text, text, text, text) to authenticated;
--   commit;

drop function public.create_library_process(uuid, text, text, text, text, text);

create function public.create_library_process(p_workspace uuid, p_name text, p_kind text, p_entity_name text default null, p_description text default null, p_source text default 'manual', p_category text default null) returns jsonb
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
  insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, category)
  values (pid, p_workspace, clean, p_kind,
    coalesce(nullif(btrim(coalesce(p_entity_name, '')), ''), case when p_kind = 'pipeline' then 'lead' else 'task' end),
    nullif(btrim(coalesce(p_description, '')), ''), p_source, p_category);
  perform set_config('transpera.library_create', '', true);
  return jsonb_build_object('status', 'created', 'process_id', pid);
end;
$$;

revoke execute on function public.create_library_process(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_library_process(uuid, text, text, text, text, text, text) to authenticated;
