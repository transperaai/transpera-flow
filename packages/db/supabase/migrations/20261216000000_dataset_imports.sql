-- Import wizard with column mapping (issue #40, C1; PRD §4.1 Company model, §5 `datasets`, §6.6, D45; docs/plans/c1-brief.md).
--
-- A person imports a file of historical data on Settings → Historical data: a stage history, deals, time logs, leads, a clients
-- file, a servicing log, jobs or tickets, or invoices. The app parses it in a Web Worker, lets the person match its columns to
-- the kind's columns and check the rows, converts deals and time logs into a step log and jobs into a servicing log (C2's
-- calibrations), and records the import under its own kind. Rows, files, client ids, person names, amounts and unmatched names
-- never reach the database: the page sends header names, counts and model ids (D27, #30). Records are insert-only, so a second
-- import of a kind adds a record and the first stays listed.
--
-- ADDITIVE: it adds one column and two functions, and replaces `record_client_calibration` (row 57) with a full copy of its
-- latest definition that takes a kind and `details`, signature unchanged (the same rule as `save_fields`: the latest definition,
-- copied; the added lines are marked `-- C1`). It does NOT touch `save_fields`, `record_calibration`, `apply_calibration`,
-- `calibration_payload_problem`, the `calibrations` trigger, `datasets_kind` (it already allows the eight kinds; row 50 reserved
-- five for C1 and row 57 added two), or any policy or grant on the tables.
--
--   * `datasets.details` (jsonb object, at most 20,000 bytes, default `{}`): counts only: the delimiter, encoding, header row,
--     date order, lines, rows kept and left out, how many rows matched a name in the model, the window, and for leads and
--     invoices a summary (lead source ids and numbers; counts). No string from the file. Table grants are table-level
--     (select, insert), so the column is covered; it is insert-only like the rest of the row (no update grant).
--   * `datasets.column_map` values are short labels: `private.column_map_ok(jsonb)` allows only text of up to 60 characters. The page stores
--     a position (`Column 4`) for client, person, id and amount columns, never the header text, because a file with no header row
--     makes its first data row the "headers". Added NOT VALID: records made before it are not checked.
--   * `public.record_dataset(p_workspace, p_kind, p_file_name, p_column_map, p_row_count, p_details)` (SECURITY INVOKER): records
--     an import that has no calibration: `leads` or `invoices`, with no process. Refuses an API token (42501) and any other kind
--     (22023). Row-level security refuses viewers, members and strangers (insert policy `can_edit_workspace`). Returns the id.
--   * `public.record_calibration_import(p_workspace, p_process, p_kind, p_file_name, p_column_map, p_row_count, p_details,
--     p_results, p_keys)` (SECURITY INVOKER): row 50's `record_calibration` with the kind and `details` passed in. `step_log`,
--     `deals` and `time_logs` are calibrated against a process; any other kind is refused (22023). The dataset, the
--     calibration and the apply (which refuses an API token) are one transaction, as before. `record_calibration` stays as it is.
--   * `public.record_client_calibration(p_workspace, p_clients, p_log, p_results, p_keys)`: row 57's, plus `p_log.kind`
--     (`servicing_log`, the default, or `jobs`; anything else is 22023) and `details` on both files. The clients file's kind
--     stays `clients`. `results.datasets` and the return value keep the key `servicing_log` for the log's dataset id, even for a
--     jobs file, because `apps/web/src/lib/calibration/client-data.ts` reads it.
-- Row-level security and grants are row 50's: everyone in the workspace reads; owners and editors insert.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   0. Nothing at or past this version. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261216000000';
--   1. Rows 50 and 57 are applied. Expect 2:
--        select count(*) from supabase_migrations.schema_migrations where version in ('20261202000000', '20261208000000');
--   2. record_client_calibration is row 57's, unchanged. Expect md5 bfe7a2c887fe6251c9ea41aa4c021c97 (computed on a local
--      database migrated to origin/main; no later migration touches it):
--        select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname = 'record_client_calibration';
--   3. No details column yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'datasets' and column_name = 'details';
--   4. The new functions don't exist. Expect null, null:
--        select to_regprocedure('public.record_dataset(uuid, text, text, jsonb, integer, jsonb)'),
--               to_regprocedure('public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])');
--   5. datasets_kind already allows the eight kinds. Expect one row listing step_log, clients, servicing_log, leads, deals, jobs, time_logs, invoices:
--        select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_kind';
--   6. For the record (the column add is metadata-only with a constant default): select count(*) from public.datasets;
--
-- POST-APPLY:
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--     where table_schema = 'public' and table_name = 'datasets' and column_name = 'details';   -- jsonb, NO, '{}'::jsonb
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_details';    -- the check
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_column_map_labels';  -- the check (not validated)
--   select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in ('record_dataset', 'record_calibration_import', 'record_client_calibration') order by 1;
--     -- each: f, {search_path=""}, f, t
--   select version from supabase_migrations.schema_migrations where version = '20261216000000';  -- 1 row
--
-- ROLLBACK (one transaction; roll the app back first):
--   begin;
--   drop function if exists public.record_dataset(uuid, text, text, jsonb, integer, jsonb);
--   drop function if exists public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]);
--   -- Put back row 57's record_client_calibration: re-run its `create function ... $$;` block from
--   -- 20261208000000_client_calibration.sql as `create or replace`, with its revoke and grant.
--   alter table public.datasets drop constraint if exists datasets_column_map_labels;
--   drop function if exists private.column_map_ok(jsonb);
--   alter table public.datasets drop column if exists details;
--   delete from supabase_migrations.schema_migrations where version = '20261216000000';
--   commit;
-- Records of the new kinds stay: datasets_kind always allowed them. Only their `details` go with the column. Measured
-- values from them keep their numbers and their dataset_id.
--
-- Production data: none needed.

-- 1. What an import holds: counts and model ids only.
alter table public.datasets add column details jsonb not null default '{}'
  constraint datasets_details check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 20000);

-- A column map holds short labels (a header name, or a position such as `Column 4`), never a long value from a file.
create function private.column_map_ok(m jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select not exists (select 1 from jsonb_each(m) e where jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 60);
$$;

revoke all on function private.column_map_ok(jsonb) from public, anon;
grant execute on function private.column_map_ok(jsonb) to authenticated;

alter table public.datasets add constraint datasets_column_map_labels check (private.column_map_ok(column_map)) not valid;

-- ---------------------------------------------------------------------------
-- 2. record_dataset: an import with no calibration (leads, invoices)
-- ---------------------------------------------------------------------------

create function public.record_dataset(
  p_workspace uuid,
  p_kind text,
  p_file_name text,
  p_column_map jsonb,
  p_row_count integer,
  p_details jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ds uuid;
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Data is imported by a person in the app, not over the API' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('leads', 'invoices') then
    raise exception 'Stage histories, deals, time logs, clients files, servicing logs and jobs are recorded with their calibration' using errcode = '22023';
  end if;
  -- Row-level security refuses a viewer's, a member's or a stranger's insert.
  insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count, details)
  values (
    p_workspace,
    p_kind,
    null,
    p_file_name,
    coalesce(p_column_map, '{}'),
    p_row_count,
    coalesce(case when jsonb_typeof(p_details) = 'object' then p_details end, '{}'))
  returning id into ds;
  return ds;
end;
$$;

revoke all on function public.record_dataset(uuid, text, text, jsonb, integer, jsonb) from public, anon, authenticated;
grant execute on function public.record_dataset(uuid, text, text, jsonb, integer, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. record_calibration_import: row 50's record_calibration, with the kind and details passed in
-- ---------------------------------------------------------------------------

create function public.record_calibration_import(
  p_workspace uuid,
  p_process uuid,
  p_kind text,
  p_file_name text,
  p_column_map jsonb,
  p_row_count integer,
  p_details jsonb,
  p_results jsonb,
  p_keys text[]
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ds uuid;
  cal uuid;
  out jsonb;
begin
  if p_kind is null or p_kind not in ('step_log', 'deals', 'time_logs') then
    raise exception 'That kind of file isn''t calibrated against a process' using errcode = '22023';
  end if;
  -- Row-level security refuses a viewer's or a stranger's insert; apply_calibration refuses an API token. Either way
  -- the whole call rolls back, records included.
  insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count, details)
  values (
    p_workspace,
    p_kind,
    p_process,
    p_file_name,
    coalesce(p_column_map, '{}'),
    p_row_count,
    coalesce(case when jsonb_typeof(p_details) = 'object' then p_details end, '{}'))
  returning id into ds;
  insert into public.calibrations (workspace_id, dataset_id, process_id, results)
  values (p_workspace, ds, p_process, p_results)
  returning id into cal;
  out := public.apply_calibration(cal, p_keys);
  return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
end;
$$;

revoke all on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. record_client_calibration: row 57's function, with a kind for the log and details on both files (C1 lines marked)
-- ---------------------------------------------------------------------------

create or replace function public.record_client_calibration(
  p_workspace uuid,
  p_clients jsonb,
  p_log jsonb,
  p_results jsonb,
  p_keys text[]
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  clients_ds uuid := null;
  log_ds uuid := null;
  cal uuid;
  out jsonb;
  log_kind text := coalesce(p_log ->> 'kind', 'servicing_log'); -- C1
begin
  -- With no keys apply_calibration isn't called, so the API-token refusal is repeated here.
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
  end if;
  if p_clients is null and p_log is null then
    raise exception 'Give a clients file or a servicing log' using errcode = '22023';
  end if;
  -- C1: a servicing log is a servicing log or a file of jobs or tickets read as one.
  if p_log is not null and log_kind not in ('servicing_log', 'jobs') then
    raise exception 'That kind of file isn''t a servicing log' using errcode = '22023';
  end if;
  -- Row-level security refuses a viewer's or a stranger's insert, and apply_calibration an API token. Either way the whole
  -- call rolls back, records included.
  if p_clients is not null then
    insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count, details) -- C1: details
    values (
      p_workspace,
      'clients',
      null,
      p_clients ->> 'file_name',
      coalesce(p_clients -> 'column_map', '{}'),
      (p_clients ->> 'row_count')::integer,
      coalesce(case when jsonb_typeof(p_clients -> 'details') = 'object' then p_clients -> 'details' end, '{}')) -- C1
    returning id into clients_ds;
  end if;
  if p_log is not null then
    insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count, details) -- C1: kind and details
    values (
      p_workspace,
      log_kind, -- C1
      null,
      p_log ->> 'file_name',
      coalesce(p_log -> 'column_map', '{}'),
      (p_log ->> 'row_count')::integer,
      coalesce(case when jsonb_typeof(p_log -> 'details') = 'object' then p_log -> 'details' end, '{}')) -- C1
    returning id into log_ds;
  end if;
  -- C1: the key stays `servicing_log` for the log's dataset id, even for a jobs file: client-data.ts reads it.
  insert into public.calibrations (workspace_id, dataset_id, process_id, results)
  values (
    p_workspace,
    coalesce(clients_ds, log_ds),
    null,
    p_results || jsonb_build_object('datasets', jsonb_build_object('clients', clients_ds, 'servicing_log', log_ds)))
  returning id into cal;
  if coalesce(cardinality(p_keys), 0) > 0 then
    out := public.apply_calibration(cal, p_keys);
  else
    -- The checks are recorded without applying anything.
    out := jsonb_build_object('status', 'ok', 'draft', null, 'results', '[]'::jsonb);
  end if;
  return out || jsonb_build_object('calibration_id', cal, 'datasets', jsonb_build_object('clients', clients_ds, 'servicing_log', log_ds));
end;
$$;

revoke all on function public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[]) to authenticated;
