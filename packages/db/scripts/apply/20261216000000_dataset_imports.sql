-- Production apply file for 20261216000000_dataset_imports (C1, issue #40). One column (`datasets.details`), three check constraints
-- (`datasets_details`, `datasets_details_known`, `datasets_column_map_labels`), three `private` helper functions (`column_map_ok`,
-- `import_numbers_ok`, `import_details_ok`), two new public functions (`record_dataset`, `record_calibration_import`) and
-- `public.record_client_calibration` replaced with a full copy of row 57's that takes a kind and details; no policy or table grant
-- changes. Needs rows 50 (20261202000000) and 57 (20261208000000); this is row 62 (after B20's row 59, B5's row 60 and B21's row 61;
-- none of them touches `datasets` or `record_client_calibration`). Preflight, post-apply check and rollback are in the migration's
-- own header, repeated below. Apply BEFORE deploying the app (the Historical data page calls the new functions).

begin;
set local lock_timeout = '5s';

-- Import wizard with column mapping (issue #40, C1; PRD §4.1 Company model, §5 `datasets`, §6.6, D45; docs/plans/c1-brief.md).
--
-- A person imports a file of historical data on Settings → Historical data: a stage history, deals, time logs, leads, a clients
-- file, a servicing log, jobs or tickets, or invoices. The app parses it in a Web Worker, lets the person match its columns to
-- the kind's columns and check the rows, converts deals and time logs into a step log and jobs into a servicing log (C2's
-- calibrations), and records the import under its own kind. Rows, files, client ids, person names, amounts and unmatched names
-- never reach the database: the page sends header names, counts and model ids (D27, #30). Records are insert-only, so a second
-- import of a kind adds a record and the first stays listed.
--
-- ADDITIVE: it adds one column, two public functions, three `private` helper functions and two check constraints, and replaces
-- `record_client_calibration` (row 57) with a full copy of its
-- latest definition that takes a kind and `details`, signature unchanged (the same rule as `save_fields`: the latest definition,
-- copied; the added lines are marked `-- C1`). It does NOT touch `save_fields`, `record_calibration`, `apply_calibration`,
-- `calibration_payload_problem`, the `calibrations` trigger, `datasets_kind` (it already allows the eight kinds; row 50 reserved
-- five for C1 and row 57 added two), or any policy or grant on the tables.
--
--   * `datasets.details` (jsonb object, at most 20,000 bytes, default `{}`): counts only: the delimiter, encoding, header row,
--     date order, lines, rows kept and left out, how many rows matched a name in the model, the window, and for leads and
--     invoices a summary (lead source ids and numbers; counts). No string from the file. Table grants are table-level
--     (select, insert), so the column is covered; it is insert-only like the rest of the row (no update grant).
--   * `datasets.details` holds only the known keys, in the known types: `private.import_details_ok(jsonb)` (whole counts up to 10
--     million, dates up to the year 2100, the delimiter, encoding and date-order enums, uuid lead source ids). So a client's name, a person's or an amount can't be stored even by a
--     caller that skips the app. The app's own rebuild (`storedImportDetails`) is the first line; this is the second.
--   * `datasets.column_map` holds short labels: `private.column_map_ok(jsonb)` allows only the kinds' column ids as keys (lower-case
--     letters, at most 20) and text of up to 60 characters as values. The page stores a position (`Column 4`) unless the header is the
--     column's own name or alias, because a file with no header row makes its first data row the "headers". Added NOT VALID (as
--     `datasets_column_map_labels`): records made before it are not checked.
--   * New objects: `private.column_map_ok(jsonb)`, `private.import_numbers_ok(jsonb, text[], text[], numeric, numeric)` and
--     `private.import_details_ok(jsonb)` (execute for `authenticated` only: a check constraint runs as the inserting role), and the
--     constraints `datasets_details`, `datasets_details_known` and `datasets_column_map_labels` (the first of them with the column).
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
--   4. The new functions don't exist. Expect five nulls:
--        select to_regprocedure('public.record_dataset(uuid, text, text, jsonb, integer, jsonb)'),
--               to_regprocedure('public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])'),
--               to_regprocedure('private.column_map_ok(jsonb)'),
--               to_regprocedure('private.import_numbers_ok(jsonb, text[], text[], numeric, numeric)'),
--               to_regprocedure('private.import_details_ok(jsonb)');
--      And neither new constraint exists. Expect 0:
--        select count(*) from pg_constraint where conname in ('datasets_details', 'datasets_details_known', 'datasets_column_map_labels');
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
--   select conname from pg_constraint where conname in ('datasets_details', 'datasets_details_known', 'datasets_column_map_labels') order by 1;  -- 3 rows
--   The three private functions refuse anon and allow authenticated. Expect f, t for each:
--   select p.proname, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'private' and p.proname in ('column_map_ok', 'import_numbers_ok', 'import_details_ok') order by 1;
--   select version from supabase_migrations.schema_migrations where version = '20261216000000';  -- 1 row
--
-- ROLLBACK (one transaction; roll the app back first):
--   begin;
--   drop function if exists public.record_dataset(uuid, text, text, jsonb, integer, jsonb);
--   drop function if exists public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]);
--   -- Put back row 57's record_client_calibration: re-run its `create function ... $$;` block from
--   -- 20261208000000_client_calibration.sql as `create or replace`, with its revoke and grant.
--   alter table public.datasets drop constraint if exists datasets_details_known;
--   alter table public.datasets drop constraint if exists datasets_column_map_labels;
--   drop function if exists private.import_details_ok(jsonb);
--   drop function if exists private.import_numbers_ok(jsonb, text[], text[], numeric, numeric);
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

-- Counts only: an object whose keys are among `allowed` and whose values are numbers from lo to hi (whole numbers for `whole_keys`).
create function private.import_numbers_ok(o jsonb, allowed text[], whole_keys text[], lo numeric, hi numeric) returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(o) = 'object' and not exists (
    select 1 from jsonb_each(o) e
    where e.key <> all (allowed)
       or jsonb_typeof(e.value) <> 'number'
       or (e.value #>> '{}')::numeric not between lo and hi
       or (e.key = any (whole_keys) and (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric)));
$$;

-- What `details` may hold (apps/web/src/lib/calibration/import-request.ts rebuilds it from the same fields). Counts are whole numbers
-- up to 10 million; dates are epoch milliseconds up to the year 2100; a lead source is a uuid. So it can't carry text, even as digits.
create function private.import_details_ok(d jsonb) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  s jsonb;
  src jsonb;
begin
  if jsonb_typeof(d) <> 'object' then
    return false;
  end if;
  for k, v in select e.key, e.value from jsonb_each(d) e loop
    if k in ('headerRow', 'lines', 'rows', 'leftOut') then
      if not private.import_numbers_ok(jsonb_build_object(k, v), array[k], array[k], 0, 10000000) then return false; end if;
    elsif k = 'delimiter' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in (',', ';', E'\t', '|') then return false; end if;
    elsif k = 'encoding' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('utf-8', 'utf-16', 'windows-1252') then return false; end if;
    elsif k = 'dateOrder' then
      if jsonb_typeof(v) <> 'null' and (jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('dmy', 'mdy')) then return false; end if;
    elsif k = 'nameMatches' then
      if not private.import_numbers_ok(v, array['matched', 'leftOut'], array['matched', 'leftOut'], 0, 10000000) then return false; end if;
    elsif k = 'window' then
      if jsonb_typeof(v) <> 'null' and not private.import_numbers_ok(v, array['from', 'to'], array['from', 'to'], 0, 4200000000000) then return false; end if;
    elsif k = 'summary' then
      if jsonb_typeof(v) = 'null' then continue; end if;
      if jsonb_typeof(v) <> 'object' then return false; end if;
      s := v - 'sources' - 'blocked' - 'paidLate' - 'kind';
      if not private.import_numbers_ok(
        s,
        array['weeks', 'leads', 'unmatched', 'invoices', 'clients', 'withDue', 'unpaidPastDue', 'withAmount'],
        array['leads', 'unmatched', 'invoices', 'clients', 'withDue', 'unpaidPastDue', 'withAmount'],
        0,
        10000000) then
        return false;
      end if;
      if coalesce(v ->> 'kind', '') not in ('leads', 'invoices') then return false; end if;
      if v ? 'blocked' and jsonb_typeof(v -> 'blocked') <> 'boolean' then return false; end if;
      if v ? 'paidLate' and not (jsonb_typeof(v -> 'paidLate') = 'null' or private.import_numbers_ok(jsonb_build_object('paidLate', v -> 'paidLate'), array['paidLate'], array[]::text[], 0, 1)) then
        return false;
      end if;
      if v ? 'sources' then
        if jsonb_typeof(v -> 'sources') <> 'array' or jsonb_array_length(v -> 'sources') > 500 then return false; end if;
        for src in select x from jsonb_array_elements(v -> 'sources') x loop
          if jsonb_typeof(src) <> 'object'
             or jsonb_typeof(src -> 'leadSourceId') <> 'string'
             or (src ->> 'leadSourceId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             or not private.import_numbers_ok(src - 'leadSourceId', array['leads', 'perWeek', 'current'], array['leads'], 0, 10000000) then
            return false;
          end if;
        end loop;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke all on function private.import_numbers_ok(jsonb, text[], text[], numeric, numeric) from public, anon;
grant execute on function private.import_numbers_ok(jsonb, text[], text[], numeric, numeric) to authenticated;
revoke all on function private.import_details_ok(jsonb) from public, anon;
grant execute on function private.import_details_ok(jsonb) to authenticated;

alter table public.datasets add constraint datasets_details_known check (private.import_details_ok(details));

-- A column map holds short labels (a header name, or a position such as `Column 4`) under the kinds' column ids (lower-case letters,
-- at most 20), never a long value from a file.
create function private.column_map_ok(m jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(m) = 'object' and not exists (
    select 1 from jsonb_each(m) e
    where e.key !~ '^[a-z]{1,20}$' or jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 60);
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

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261216000000', 'dataset_imports', array[$mig$-- Import wizard with column mapping (issue #40, C1; PRD §4.1 Company model, §5 `datasets`, §6.6, D45; docs/plans/c1-brief.md).
--
-- A person imports a file of historical data on Settings → Historical data: a stage history, deals, time logs, leads, a clients
-- file, a servicing log, jobs or tickets, or invoices. The app parses it in a Web Worker, lets the person match its columns to
-- the kind's columns and check the rows, converts deals and time logs into a step log and jobs into a servicing log (C2's
-- calibrations), and records the import under its own kind. Rows, files, client ids, person names, amounts and unmatched names
-- never reach the database: the page sends header names, counts and model ids (D27, #30). Records are insert-only, so a second
-- import of a kind adds a record and the first stays listed.
--
-- ADDITIVE: it adds one column, two public functions, three `private` helper functions and two check constraints, and replaces
-- `record_client_calibration` (row 57) with a full copy of its
-- latest definition that takes a kind and `details`, signature unchanged (the same rule as `save_fields`: the latest definition,
-- copied; the added lines are marked `-- C1`). It does NOT touch `save_fields`, `record_calibration`, `apply_calibration`,
-- `calibration_payload_problem`, the `calibrations` trigger, `datasets_kind` (it already allows the eight kinds; row 50 reserved
-- five for C1 and row 57 added two), or any policy or grant on the tables.
--
--   * `datasets.details` (jsonb object, at most 20,000 bytes, default `{}`): counts only: the delimiter, encoding, header row,
--     date order, lines, rows kept and left out, how many rows matched a name in the model, the window, and for leads and
--     invoices a summary (lead source ids and numbers; counts). No string from the file. Table grants are table-level
--     (select, insert), so the column is covered; it is insert-only like the rest of the row (no update grant).
--   * `datasets.details` holds only the known keys, in the known types: `private.import_details_ok(jsonb)` (whole counts up to 10
--     million, dates up to the year 2100, the delimiter, encoding and date-order enums, uuid lead source ids). So a client's name, a person's or an amount can't be stored even by a
--     caller that skips the app. The app's own rebuild (`storedImportDetails`) is the first line; this is the second.
--   * `datasets.column_map` holds short labels: `private.column_map_ok(jsonb)` allows only the kinds' column ids as keys (lower-case
--     letters, at most 20) and text of up to 60 characters as values. The page stores a position (`Column 4`) unless the header is the
--     column's own name or alias, because a file with no header row makes its first data row the "headers". Added NOT VALID (as
--     `datasets_column_map_labels`): records made before it are not checked.
--   * New objects: `private.column_map_ok(jsonb)`, `private.import_numbers_ok(jsonb, text[], text[], numeric, numeric)` and
--     `private.import_details_ok(jsonb)` (execute for `authenticated` only: a check constraint runs as the inserting role), and the
--     constraints `datasets_details`, `datasets_details_known` and `datasets_column_map_labels` (the first of them with the column).
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
--   4. The new functions don't exist. Expect five nulls:
--        select to_regprocedure('public.record_dataset(uuid, text, text, jsonb, integer, jsonb)'),
--               to_regprocedure('public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])'),
--               to_regprocedure('private.column_map_ok(jsonb)'),
--               to_regprocedure('private.import_numbers_ok(jsonb, text[], text[], numeric, numeric)'),
--               to_regprocedure('private.import_details_ok(jsonb)');
--      And neither new constraint exists. Expect 0:
--        select count(*) from pg_constraint where conname in ('datasets_details', 'datasets_details_known', 'datasets_column_map_labels');
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
--   select conname from pg_constraint where conname in ('datasets_details', 'datasets_details_known', 'datasets_column_map_labels') order by 1;  -- 3 rows
--   The three private functions refuse anon and allow authenticated. Expect f, t for each:
--   select p.proname, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'private' and p.proname in ('column_map_ok', 'import_numbers_ok', 'import_details_ok') order by 1;
--   select version from supabase_migrations.schema_migrations where version = '20261216000000';  -- 1 row
--
-- ROLLBACK (one transaction; roll the app back first):
--   begin;
--   drop function if exists public.record_dataset(uuid, text, text, jsonb, integer, jsonb);
--   drop function if exists public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]);
--   -- Put back row 57's record_client_calibration: re-run its `create function ... $$;` block from
--   -- 20261208000000_client_calibration.sql as `create or replace`, with its revoke and grant.
--   alter table public.datasets drop constraint if exists datasets_details_known;
--   alter table public.datasets drop constraint if exists datasets_column_map_labels;
--   drop function if exists private.import_details_ok(jsonb);
--   drop function if exists private.import_numbers_ok(jsonb, text[], text[], numeric, numeric);
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

-- Counts only: an object whose keys are among `allowed` and whose values are numbers from lo to hi (whole numbers for `whole_keys`).
create function private.import_numbers_ok(o jsonb, allowed text[], whole_keys text[], lo numeric, hi numeric) returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(o) = 'object' and not exists (
    select 1 from jsonb_each(o) e
    where e.key <> all (allowed)
       or jsonb_typeof(e.value) <> 'number'
       or (e.value #>> '{}')::numeric not between lo and hi
       or (e.key = any (whole_keys) and (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric)));
$$;

-- What `details` may hold (apps/web/src/lib/calibration/import-request.ts rebuilds it from the same fields). Counts are whole numbers
-- up to 10 million; dates are epoch milliseconds up to the year 2100; a lead source is a uuid. So it can't carry text, even as digits.
create function private.import_details_ok(d jsonb) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  s jsonb;
  src jsonb;
begin
  if jsonb_typeof(d) <> 'object' then
    return false;
  end if;
  for k, v in select e.key, e.value from jsonb_each(d) e loop
    if k in ('headerRow', 'lines', 'rows', 'leftOut') then
      if not private.import_numbers_ok(jsonb_build_object(k, v), array[k], array[k], 0, 10000000) then return false; end if;
    elsif k = 'delimiter' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in (',', ';', E'\t', '|') then return false; end if;
    elsif k = 'encoding' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('utf-8', 'utf-16', 'windows-1252') then return false; end if;
    elsif k = 'dateOrder' then
      if jsonb_typeof(v) <> 'null' and (jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('dmy', 'mdy')) then return false; end if;
    elsif k = 'nameMatches' then
      if not private.import_numbers_ok(v, array['matched', 'leftOut'], array['matched', 'leftOut'], 0, 10000000) then return false; end if;
    elsif k = 'window' then
      if jsonb_typeof(v) <> 'null' and not private.import_numbers_ok(v, array['from', 'to'], array['from', 'to'], 0, 4200000000000) then return false; end if;
    elsif k = 'summary' then
      if jsonb_typeof(v) = 'null' then continue; end if;
      if jsonb_typeof(v) <> 'object' then return false; end if;
      s := v - 'sources' - 'blocked' - 'paidLate' - 'kind';
      if not private.import_numbers_ok(
        s,
        array['weeks', 'leads', 'unmatched', 'invoices', 'clients', 'withDue', 'unpaidPastDue', 'withAmount'],
        array['leads', 'unmatched', 'invoices', 'clients', 'withDue', 'unpaidPastDue', 'withAmount'],
        0,
        10000000) then
        return false;
      end if;
      if coalesce(v ->> 'kind', '') not in ('leads', 'invoices') then return false; end if;
      if v ? 'blocked' and jsonb_typeof(v -> 'blocked') <> 'boolean' then return false; end if;
      if v ? 'paidLate' and not (jsonb_typeof(v -> 'paidLate') = 'null' or private.import_numbers_ok(jsonb_build_object('paidLate', v -> 'paidLate'), array['paidLate'], array[]::text[], 0, 1)) then
        return false;
      end if;
      if v ? 'sources' then
        if jsonb_typeof(v -> 'sources') <> 'array' or jsonb_array_length(v -> 'sources') > 500 then return false; end if;
        for src in select x from jsonb_array_elements(v -> 'sources') x loop
          if jsonb_typeof(src) <> 'object'
             or jsonb_typeof(src -> 'leadSourceId') <> 'string'
             or (src ->> 'leadSourceId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             or not private.import_numbers_ok(src - 'leadSourceId', array['leads', 'perWeek', 'current'], array['leads'], 0, 10000000) then
            return false;
          end if;
        end loop;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke all on function private.import_numbers_ok(jsonb, text[], text[], numeric, numeric) from public, anon;
grant execute on function private.import_numbers_ok(jsonb, text[], text[], numeric, numeric) to authenticated;
revoke all on function private.import_details_ok(jsonb) from public, anon;
grant execute on function private.import_details_ok(jsonb) to authenticated;

alter table public.datasets add constraint datasets_details_known check (private.import_details_ok(details));

-- A column map holds short labels (a header name, or a position such as `Column 4`) under the kinds' column ids (lower-case letters,
-- at most 20), never a long value from a file.
create function private.column_map_ok(m jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(m) = 'object' and not exists (
    select 1 from jsonb_each(m) e
    where e.key !~ '^[a-z]{1,20}$' or jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 60);
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
$mig$]);

commit;
