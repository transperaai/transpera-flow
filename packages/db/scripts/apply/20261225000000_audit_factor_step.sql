-- Production apply file for 20261225000000_audit_factor_step (issue #230). ONE replaced function, `private.audit_company_write()`:
-- a full copy of 20261015000000's body plus two `-- #230` lines (a per-person time's log entry names its step). No table, no data.
-- This is row 69 of docs/production-migrations.md; apply any time after row 67 (20261223000000); renumber per HANDOVER if #228
-- (20261226000000) or #227 (20261227000000) is applied first. Preflight, post-apply checks and rollback are in the migration's own
-- header, repeated below. The app reads either diff, so there is no deploy order. Sets `lock_timeout` to 5 s.

begin;
set local lock_timeout = '5s';

-- The change log names the step of a per-person time (issue #230; docs/plans/c6-230-brief.md; follows C6, #198/#229).
--
-- Today the owner's change log (Suggestions -> "Recent changes to the company model") says "Sam Patel: a per-person time
-- changed" and can't say which step. `private.audit_company_write` adds `step_id` to the diff only for `person_skills`, and an
-- UPDATE's diff holds only the columns that changed (`factor`, `provenance`). The decision (#230, as filed): "add
-- `person_capacity_factors` to the `step_id` case in a new migration that redefines the function (a full copy of its latest body
-- plus that line), then say the step in the change-log text (never the number)".
--
-- What this does. ONE `create or replace` of `private.audit_company_write()`: same signature, SECURITY DEFINER, `search_path = ''`
-- and grants; a full copy of its only definition (20261015000000_suggestions.sql, md5 e936352b8a20cdd8fd374756e4fa4439) plus two
-- marked lines (`-- #230`). For `person_capacity_factors` the diff gains `step_id` (the row's step; read from the whole row, so
-- it is there on an UPDATE that changed only `factor`) or `every_step: true` (the row is the person's time for every step: its
-- `step_id` is null, which `jsonb_strip_nulls` would drop, so the key says it). `person_skills` gets exactly what it gets today.
-- The function is shared by 18 tables (workspaces, roles, services, people, person_roles, person_skills, person_leave, clients,
-- client_services, client_assignments, lead_sources, seasonality, demand_settings, suggestions, service_servicing, client_groups,
-- churn_drivers, person_capacity_factors); for the other 17 both new expressions are SQL null and `jsonb_strip_nulls` removes them,
-- so their diffs are unchanged. It doesn't redefine `save_fields` or anything else. Strictly additive in effect: existing log
-- entries keep their diffs (`audit_log` is append-only); the app reads either.
--
-- ORDER: after 20261223000000 (row 67, which made `person_capacity_factors`). This is row 69 of docs/production-migrations.md.
-- Independent of #228 (20261226000000, `import_workspace_bundle`) and #227 (20261227000000, `apply_calibration` and others):
-- neither touches this function. If either is applied first, renumber this file above it (HANDOVER "Migration order").
-- Apply any time after row 67 (the app reads either diff).
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time):
--   0. Row 67 applied, nothing at or past this one. Expect 20261223000000 among the rows and nothing >= 20261225000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261223000000' order by 1;
--   1. The function is still 20261015000000's. Expect e936352b8a20cdd8fd374756e4fa4439, t, {search_path=""}:
--        select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'private.audit_company_write()'::regprocedure;
--   2. The 18 triggers that call it, all enabled. Expect 18 rows, all 'O':
--        select c.relname, t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
--          where t.tgfoid = 'private.audit_company_write()'::regprocedure and not t.tgisinternal order by 1;
--   3. For the log: how many factor entries exist (they keep their old diffs). Expect a small number:
--        select action, count(*) from public.audit_log where target_table = 'person_capacity_factors' group by 1 order by 1;
--
-- POST-APPLY CHECK:
--   1. Expect t, {search_path=""} and the new md5, 038f5fb5746a37c5086a16574eed4d3a:
--        select prosecdef, proconfig, md5(prosrc) from pg_proc where oid = 'private.audit_company_write()'::regprocedure;
--   2. Expect f, f (anon and authenticated cannot execute it):
--        select has_function_privilege('anon', 'private.audit_company_write()', 'execute'),
--               has_function_privilege('authenticated', 'private.audit_company_write()', 'execute');
--   3. Still 18 triggers, all 'O' (preflight 2 again).
--   4. Smoke test, ROLLED BACK, as the Northbeam owner (as C6's post-apply 6): set the claims, save a factor for a step and
--      change it, then read the log. Expect `insert` and `update`, both with the step id and no every_step:
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<owner user id>","role":"authenticated"}', true);
--        select public.save_capacity_factor('<person id>', '<a step id>', null, 0.8);
--        select public.save_capacity_factor('<person id>', '<the step id>', 0.8, 0.9);
--        reset role;
--        select action, diff -> 'step_id', diff -> 'every_step' from public.audit_log
--          where target_table = 'person_capacity_factors' and created_at = now() order by action;
--        rollback;
--   5. On the real project (Austin's live check): an editor changes one factor; the owner's change log names the step.
--
-- ROLLBACK (one transaction; puts 20261015000000's whole statement back, written out in full so it can be run as it stands;
-- the md5 of its body is e936352b8a20cdd8fd374756e4fa4439). Entries logged while this was applied keep their `step_id` /
-- `every_step`; the app reads them either way:
--   begin;
--   create or replace function private.audit_company_write() returns trigger
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     claims jsonb := coalesce(auth.jwt(), '{}');
--     row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
--     row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
--     target jsonb := coalesce(row_new, row_old);
--     changed_old jsonb;
--     changed_new jsonb;
--     action text := lower(tg_op);
--     suggestion text := nullif(current_setting('transpera.suggestion_id', true), '');
--   begin
--     if auth.uid() is null or pg_catalog.pg_trigger_depth() > 1 then
--       return null;
--     end if;
--     if tg_op = 'UPDATE' then
--       select jsonb_object_agg(n.key, row_old -> n.key), jsonb_object_agg(n.key, n.value)
--         into changed_old, changed_new
--       from jsonb_each(row_new) n
--       where n.key <> 'updated_at' and (row_old -> n.key) is distinct from n.value;
--       if changed_new is null then
--         return null;
--       end if;
--       row_old := changed_old;
--       row_new := changed_new;
--       if tg_table_name = 'suggestions' and changed_new ? 'status' then
--         action := changed_new ->> 'status';
--       end if;
--     end if;
--   
--     insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
--     values (
--       coalesce((target ->> 'workspace_id')::uuid, case when tg_table_name = 'workspaces' then (target ->> 'id')::uuid end),
--       auth.uid(),
--       case when claims ? 'api_token_id' then 'mcp' else 'user' end,
--       action,
--       tg_table_name,
--       coalesce((target ->> 'id')::uuid, (target ->> 'person_id')::uuid, (target ->> 'client_id')::uuid,
--         (target ->> 'workspace_id')::uuid),
--       jsonb_strip_nulls(jsonb_build_object(
--         'old', row_old,
--         'new', row_new,
--         -- Link rows: which member of the set.
--         'role_id', case when tg_table_name in ('person_roles', 'client_assignments') then target -> 'role_id' end,
--         'service_id', case when tg_table_name = 'client_services' then target -> 'service_id' end,
--         'step_id', case when tg_table_name = 'person_skills' then target -> 'step_id' end,
--         'suggestion_id', case when tg_table_name <> 'suggestions' then to_jsonb(suggestion) end,
--         'api_token_id', claims -> 'api_token_id')));
--     return null;
--   end;
--   $$;
--   revoke all on function private.audit_company_write() from public, anon, authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261225000000';
--   commit;
--
-- Production data: none needed.

create or replace function private.audit_company_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(auth.jwt(), '{}');
  row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  target jsonb := coalesce(row_new, row_old);
  changed_old jsonb;
  changed_new jsonb;
  action text := lower(tg_op);
  suggestion text := nullif(current_setting('transpera.suggestion_id', true), '');
begin
  if auth.uid() is null or pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, row_old -> n.key), jsonb_object_agg(n.key, n.value)
      into changed_old, changed_new
    from jsonb_each(row_new) n
    where n.key <> 'updated_at' and (row_old -> n.key) is distinct from n.value;
    if changed_new is null then
      return null;
    end if;
    row_old := changed_old;
    row_new := changed_new;
    if tg_table_name = 'suggestions' and changed_new ? 'status' then
      action := changed_new ->> 'status';
    end if;
  end if;

  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    coalesce((target ->> 'workspace_id')::uuid, case when tg_table_name = 'workspaces' then (target ->> 'id')::uuid end),
    auth.uid(),
    case when claims ? 'api_token_id' then 'mcp' else 'user' end,
    action,
    tg_table_name,
    coalesce((target ->> 'id')::uuid, (target ->> 'person_id')::uuid, (target ->> 'client_id')::uuid,
      (target ->> 'workspace_id')::uuid),
    jsonb_strip_nulls(jsonb_build_object(
      'old', row_old,
      'new', row_new,
      -- Link rows: which member of the set.
      'role_id', case when tg_table_name in ('person_roles', 'client_assignments') then target -> 'role_id' end,
      'service_id', case when tg_table_name = 'client_services' then target -> 'service_id' end,
      -- #230: a per-person time names its step, or says it is the person's time for every step (its step_id is null, which
      -- jsonb_strip_nulls would otherwise drop at every depth).
      'step_id', case when tg_table_name in ('person_skills', 'person_capacity_factors') then target -> 'step_id' end,
      'every_step', case when tg_table_name = 'person_capacity_factors' and target -> 'step_id' = 'null'::jsonb then 'true'::jsonb end,
      'suggestion_id', case when tg_table_name <> 'suggestions' then to_jsonb(suggestion) end,
      'api_token_id', claims -> 'api_token_id')));
  return null;
end;
$$;

revoke all on function private.audit_company_write() from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261225000000', 'audit_factor_step', array[$mig$-- The change log names the step of a per-person time (issue #230; docs/plans/c6-230-brief.md; follows C6, #198/#229).
--
-- Today the owner's change log (Suggestions -> "Recent changes to the company model") says "Sam Patel: a per-person time
-- changed" and can't say which step. `private.audit_company_write` adds `step_id` to the diff only for `person_skills`, and an
-- UPDATE's diff holds only the columns that changed (`factor`, `provenance`). The decision (#230, as filed): "add
-- `person_capacity_factors` to the `step_id` case in a new migration that redefines the function (a full copy of its latest body
-- plus that line), then say the step in the change-log text (never the number)".
--
-- What this does. ONE `create or replace` of `private.audit_company_write()`: same signature, SECURITY DEFINER, `search_path = ''`
-- and grants; a full copy of its only definition (20261015000000_suggestions.sql, md5 e936352b8a20cdd8fd374756e4fa4439) plus two
-- marked lines (`-- #230`). For `person_capacity_factors` the diff gains `step_id` (the row's step; read from the whole row, so
-- it is there on an UPDATE that changed only `factor`) or `every_step: true` (the row is the person's time for every step: its
-- `step_id` is null, which `jsonb_strip_nulls` would drop, so the key says it). `person_skills` gets exactly what it gets today.
-- The function is shared by 18 tables (workspaces, roles, services, people, person_roles, person_skills, person_leave, clients,
-- client_services, client_assignments, lead_sources, seasonality, demand_settings, suggestions, service_servicing, client_groups,
-- churn_drivers, person_capacity_factors); for the other 17 both new expressions are SQL null and `jsonb_strip_nulls` removes them,
-- so their diffs are unchanged. It doesn't redefine `save_fields` or anything else. Strictly additive in effect: existing log
-- entries keep their diffs (`audit_log` is append-only); the app reads either.
--
-- ORDER: after 20261223000000 (row 67, which made `person_capacity_factors`). This is row 69 of docs/production-migrations.md.
-- Independent of #228 (20261226000000, `import_workspace_bundle`) and #227 (20261227000000, `apply_calibration` and others):
-- neither touches this function. If either is applied first, renumber this file above it (HANDOVER "Migration order").
-- Apply any time after row 67 (the app reads either diff).
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time):
--   0. Row 67 applied, nothing at or past this one. Expect 20261223000000 among the rows and nothing >= 20261225000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261223000000' order by 1;
--   1. The function is still 20261015000000's. Expect e936352b8a20cdd8fd374756e4fa4439, t, {search_path=""}:
--        select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'private.audit_company_write()'::regprocedure;
--   2. The 18 triggers that call it, all enabled. Expect 18 rows, all 'O':
--        select c.relname, t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
--          where t.tgfoid = 'private.audit_company_write()'::regprocedure and not t.tgisinternal order by 1;
--   3. For the log: how many factor entries exist (they keep their old diffs). Expect a small number:
--        select action, count(*) from public.audit_log where target_table = 'person_capacity_factors' group by 1 order by 1;
--
-- POST-APPLY CHECK:
--   1. Expect t, {search_path=""} and the new md5, 038f5fb5746a37c5086a16574eed4d3a:
--        select prosecdef, proconfig, md5(prosrc) from pg_proc where oid = 'private.audit_company_write()'::regprocedure;
--   2. Expect f, f (anon and authenticated cannot execute it):
--        select has_function_privilege('anon', 'private.audit_company_write()', 'execute'),
--               has_function_privilege('authenticated', 'private.audit_company_write()', 'execute');
--   3. Still 18 triggers, all 'O' (preflight 2 again).
--   4. Smoke test, ROLLED BACK, as the Northbeam owner (as C6's post-apply 6): set the claims, save a factor for a step and
--      change it, then read the log. Expect `insert` and `update`, both with the step id and no every_step:
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<owner user id>","role":"authenticated"}', true);
--        select public.save_capacity_factor('<person id>', '<a step id>', null, 0.8);
--        select public.save_capacity_factor('<person id>', '<the step id>', 0.8, 0.9);
--        reset role;
--        select action, diff -> 'step_id', diff -> 'every_step' from public.audit_log
--          where target_table = 'person_capacity_factors' and created_at = now() order by action;
--        rollback;
--   5. On the real project (Austin's live check): an editor changes one factor; the owner's change log names the step.
--
-- ROLLBACK (one transaction; puts 20261015000000's whole statement back, written out in full so it can be run as it stands;
-- the md5 of its body is e936352b8a20cdd8fd374756e4fa4439). Entries logged while this was applied keep their `step_id` /
-- `every_step`; the app reads them either way:
--   begin;
--   create or replace function private.audit_company_write() returns trigger
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     claims jsonb := coalesce(auth.jwt(), '{}');
--     row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
--     row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
--     target jsonb := coalesce(row_new, row_old);
--     changed_old jsonb;
--     changed_new jsonb;
--     action text := lower(tg_op);
--     suggestion text := nullif(current_setting('transpera.suggestion_id', true), '');
--   begin
--     if auth.uid() is null or pg_catalog.pg_trigger_depth() > 1 then
--       return null;
--     end if;
--     if tg_op = 'UPDATE' then
--       select jsonb_object_agg(n.key, row_old -> n.key), jsonb_object_agg(n.key, n.value)
--         into changed_old, changed_new
--       from jsonb_each(row_new) n
--       where n.key <> 'updated_at' and (row_old -> n.key) is distinct from n.value;
--       if changed_new is null then
--         return null;
--       end if;
--       row_old := changed_old;
--       row_new := changed_new;
--       if tg_table_name = 'suggestions' and changed_new ? 'status' then
--         action := changed_new ->> 'status';
--       end if;
--     end if;
--   
--     insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
--     values (
--       coalesce((target ->> 'workspace_id')::uuid, case when tg_table_name = 'workspaces' then (target ->> 'id')::uuid end),
--       auth.uid(),
--       case when claims ? 'api_token_id' then 'mcp' else 'user' end,
--       action,
--       tg_table_name,
--       coalesce((target ->> 'id')::uuid, (target ->> 'person_id')::uuid, (target ->> 'client_id')::uuid,
--         (target ->> 'workspace_id')::uuid),
--       jsonb_strip_nulls(jsonb_build_object(
--         'old', row_old,
--         'new', row_new,
--         -- Link rows: which member of the set.
--         'role_id', case when tg_table_name in ('person_roles', 'client_assignments') then target -> 'role_id' end,
--         'service_id', case when tg_table_name = 'client_services' then target -> 'service_id' end,
--         'step_id', case when tg_table_name = 'person_skills' then target -> 'step_id' end,
--         'suggestion_id', case when tg_table_name <> 'suggestions' then to_jsonb(suggestion) end,
--         'api_token_id', claims -> 'api_token_id')));
--     return null;
--   end;
--   $$;
--   revoke all on function private.audit_company_write() from public, anon, authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261225000000';
--   commit;
--
-- Production data: none needed.

create or replace function private.audit_company_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(auth.jwt(), '{}');
  row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  target jsonb := coalesce(row_new, row_old);
  changed_old jsonb;
  changed_new jsonb;
  action text := lower(tg_op);
  suggestion text := nullif(current_setting('transpera.suggestion_id', true), '');
begin
  if auth.uid() is null or pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, row_old -> n.key), jsonb_object_agg(n.key, n.value)
      into changed_old, changed_new
    from jsonb_each(row_new) n
    where n.key <> 'updated_at' and (row_old -> n.key) is distinct from n.value;
    if changed_new is null then
      return null;
    end if;
    row_old := changed_old;
    row_new := changed_new;
    if tg_table_name = 'suggestions' and changed_new ? 'status' then
      action := changed_new ->> 'status';
    end if;
  end if;

  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    coalesce((target ->> 'workspace_id')::uuid, case when tg_table_name = 'workspaces' then (target ->> 'id')::uuid end),
    auth.uid(),
    case when claims ? 'api_token_id' then 'mcp' else 'user' end,
    action,
    tg_table_name,
    coalesce((target ->> 'id')::uuid, (target ->> 'person_id')::uuid, (target ->> 'client_id')::uuid,
      (target ->> 'workspace_id')::uuid),
    jsonb_strip_nulls(jsonb_build_object(
      'old', row_old,
      'new', row_new,
      -- Link rows: which member of the set.
      'role_id', case when tg_table_name in ('person_roles', 'client_assignments') then target -> 'role_id' end,
      'service_id', case when tg_table_name = 'client_services' then target -> 'service_id' end,
      -- #230: a per-person time names its step, or says it is the person's time for every step (its step_id is null, which
      -- jsonb_strip_nulls would otherwise drop at every depth).
      'step_id', case when tg_table_name in ('person_skills', 'person_capacity_factors') then target -> 'step_id' end,
      'every_step', case when tg_table_name = 'person_capacity_factors' and target -> 'step_id' = 'null'::jsonb then 'true'::jsonb end,
      'suggestion_id', case when tg_table_name <> 'suggestions' then to_jsonb(suggestion) end,
      'api_token_id', claims -> 'api_token_id')));
  return null;
end;
$$;

revoke all on function private.audit_company_write() from public, anon, authenticated;
$mig$]);

commit;
