-- Production apply file for 20261208000000_client_calibration (C2 part 2, issue #41). One check widened (`datasets_kind` allows
-- `clients` and `servicing_log`), two of row 50's functions replaced with full copies that each add one branch
-- (`private.calibration_payload_problem`, `public.apply_calibration`) and one new function (`public.record_client_calibration`);
-- no table, column, policy or grant changes. Needs row 50 (20261202000000, C2 part 1) and `client_groups` (20261111000000); this is
-- row 56 (rows 53-55 are applied; independent of 20261207700000 and 20261209000000). Preflight, post-apply check and rollback are
-- in the migration's own header, repeated below. Apply BEFORE deploying the app (the Historical data page calls the new function).

begin;
set local lock_timeout = '5s';

-- Calibration from historical data, part 2 (issue #41, C2; PRD §5 `datasets` and `calibrations`, §6.6, D44; docs/plans/c2-2-brief.md).
--
-- A person pastes or uploads a CLIENTS FILE (client, service, started, ended) and/or a SERVICING LOG (task, client, due, done) on
-- Settings → Historical data. The app parses them in the browser and computes, with packages/engine/src/client-calibration.ts:
--   * each client group's NORMAL CHURN, back-solved so that today's simulated churn (normal churn x driver pressure) matches the
--     churn measured in the clients file (Austin's answer 1 on #41: otherwise the drivers count today's late work twice);
--   * three CHECKS shown beside the simulated values (late or missed share, response time to ad-hoc requests, onboarding speed),
--     which are never applied.
-- The person ticks the churn proposals to apply; nothing is applied without that. Client ids, and service and task names that
-- match nothing, never reach the database: the page sends counts, the proposals (service names and numbers) and the checks
-- (D27). The raw rows are never stored.
--
-- ADDITIVE: it widens one check, replaces two of row 50's functions with full copies that each add one branch (the same rule as
-- `save_fields`: the latest definition, copied; the added lines are marked `-- C2 part 2`), and adds one function. No table,
-- column, policy or grant changes. It does NOT touch `save_fields`, `record_calibration` or the `calibrations` trigger.
--
--   * `datasets_kind` also allows `clients` and `servicing_log` (precedent: `sources_kind` in row 48).
--   * `private.calibration_payload_problem(kind, set, before)` knows the kind `churn`: `churn_monthly` must be a share from 0 to 1
--     and the earlier one a number or null; otherwise the proposal is skipped as `invalid`, with a reason.
--   * `public.apply_calibration(p_calibration, p_keys)` applies a `churn` proposal targeting `client_groups` LIVE, as a person's
--     edit to the group (like leads a week, D19): `client_groups.churn_monthly` is set and its provenance entry is `measured`
--     with `at`, `by`, `dataset_id`, `calibration_id`, `n`, `leavers`, `measured` and `multiplier`. The provenance is written in
--     the same statement, so `stamp_provenance` doesn't turn it `entered`. A group whose churn changed since the proposal
--     (`before` no longer matches) is `changed`, another workspace's or a missing group is `not_found`, a key applied before is
--     `already_applied`. `audit_company_write` logs the change as for any edit; the API-token refusal at the top applies.
--   * `public.record_client_calibration(p_workspace, p_clients, p_log, p_results, p_keys)` (SECURITY INVOKER): what the page
--     calls. `p_clients` and `p_log` are each null or {file_name, column_map, row_count}. It records one dataset per file given
--     (`kind` `clients` / `servicing_log`, no process), one calibration (`results.datasets` holds both dataset ids) and applies
--     the ticked keys, in ONE transaction: a failed or refused apply leaves no record behind. With no keys it records the
--     checks and applies nothing. Refuses an API token (42501) and a call with neither file (22023). Returns apply_calibration's
--     answer (or {status: 'ok', draft: null, results: []}) plus `calibration_id` and `datasets`.
-- Row-level security and grants are row 50's: everyone in the workspace reads; owners and editors insert and apply.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   0. Nothing at or past this version. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261208000000';
--   1. Row 50 (part 1) is applied. Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261202000000';
--   2. The two functions this replaces are row 50's, unchanged. Expect these two md5s (computed on a local database migrated
--      to 20261205000000; none of the later migrations touches either):
--        private.calibration_payload_problem | e8583ea0b5b46f08bb0c7f4f79e6f88e
--        public.apply_calibration            | cee525a1f74c702cb70048abfa716ad6
--        select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem')) order by 1;
--   3. Only step logs recorded so far. Expect only step_log (or no rows):
--        select kind, count(*) from public.datasets group by 1;
--   4. Nothing created yet. Expect null:
--        select to_regprocedure('public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[])');
--   5. The columns the new branch writes exist. Expect 2 rows:
--        select column_name from information_schema.columns where table_schema = 'public' and table_name = 'client_groups'
--          and column_name in ('churn_monthly', 'provenance');
--
-- POST-APPLY CHECK:
--   * `pg_get_constraintdef` of `datasets_kind` lists the two new kinds:
--        select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_kind';
--   * `record_client_calibration` is not SECURITY DEFINER, has an empty search_path, is executable by authenticated and not anon;
--     `apply_calibration` and `calibration_payload_problem` keep the same:
--        select proname, prosecdef, proconfig = array['search_path=""'], has_function_privilege('authenticated', p.oid, 'execute'),
--               has_function_privilege('anon', p.oid, 'execute')
--        from pg_proc p where proname in ('record_client_calibration', 'apply_calibration', 'calibration_payload_problem') order by 1;
--     Expect: f, t, t, f for the first two; for `calibration_payload_problem` f, t, t, f too (row 50 grants it to authenticated).
--
-- ROLLBACK (one transaction; roll the app back first):
--
--   begin;
--   drop function if exists public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[]);
--   -- Put back row 50's apply_calibration and calibration_payload_problem: re-run their
--   -- `create function ... $$;` blocks from 20261202000000_calibration.sql as `create or replace`, with their grants.
--   delete from public.datasets where kind in ('clients', 'servicing_log');  -- cascades to their calibrations
--   alter table public.datasets drop constraint datasets_kind,
--     add constraint datasets_kind check (kind in ('step_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices'));
--   delete from supabase_migrations.schema_migrations where version = '20261208000000';
--   commit;
--
-- Rolling back deletes the clients and servicing-log records. Applied churn keeps its number and its `measured` provenance,
-- whose `dataset_id` then points at nothing (the app shows it as measured without a link).
--
-- Production data: none needed.

-- 1. A clients file and a servicing log are recorded as datasets too.
alter table public.datasets drop constraint datasets_kind,
  add constraint datasets_kind check (kind in ('step_log', 'clients', 'servicing_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices'));

-- ---------------------------------------------------------------------------
-- 2. What is wrong with a proposal's values: row 50's function with one more kind (C2 part 2 lines marked)
-- ---------------------------------------------------------------------------

create or replace function private.calibration_payload_problem(kind text, setv jsonb, beforev jsonb) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  p text;
  v jsonb;
begin
  -- `before` holds what the value was: a number, or null when it had none.
  if kind = 'arrivals' then
    if (case when jsonb_typeof(setv -> 'volume_week') = 'number' then (setv ->> 'volume_week')::numeric < 0 else true end) then
      return 'volume_week is not a number of leads';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'volume_week'), 'null') not in ('number', 'null') then
      return 'the earlier volume_week is not a number';
    end if;
    return null;
  end if;
  if kind = 'rework' then
    if (case when jsonb_typeof(setv -> 'rework_rate') = 'number' then (setv ->> 'rework_rate')::numeric not between 0 and 1 else true end) then
      return 'rework_rate is not a share from 0 to 1';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'rework_rate'), 'null') not in ('number', 'null') then
      return 'the earlier rework_rate is not a number';
    end if;
    return null;
  end if;
  if kind in ('work', 'wait') then
    p := kind;
    if (case when jsonb_typeof(setv -> (p || '_hours')) = 'number' then (setv ->> (p || '_hours'))::numeric < 0 else true end) then
      return p || '_hours is not a number of hours';
    end if;
    if coalesce(jsonb_typeof(setv -> (p || '_dist')), '') <> 'string' or setv ->> (p || '_dist') not in ('constant', 'triangular', 'lognormal') then
      return p || '_dist is not a distribution';
    end if;
    if coalesce(jsonb_typeof(setv -> (p || '_params')), '') <> 'object' then
      return p || '_params is not an object';
    end if;
    if coalesce(jsonb_typeof(beforev -> (p || '_hours')), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(beforev -> (p || '_params_cv')), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(beforev -> (p || '_dist')), 'null') not in ('string', 'null') then
      return 'the earlier values are not numbers';
    end if;
    return null;
  end if;
  if kind = 'routing' then
    if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
      return 'probabilities is not an object';
    end if;
    for p, v in select e.key, e.value from jsonb_each(setv -> 'probabilities') e loop
      if p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return 'a way out is not an edge id';
      end if;
      if (case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric not between 0 and 1 else true end) then
        return 'odds are not shares from 0 to 1';
      end if;
    end loop;
    if coalesce(jsonb_typeof(beforev -> 'probabilities'), '') <> 'object' then
      return 'the earlier odds are not an object';
    end if;
    for v in select e.value from jsonb_each(beforev -> 'probabilities') e loop
      if jsonb_typeof(v) not in ('number', 'null') then
        return 'the earlier odds are not numbers';
      end if;
    end loop;
    return null;
  end if;
  -- C2 part 2: a client group's normal churn, back-solved from a clients file.
  if kind = 'churn' then
    if (case when jsonb_typeof(setv -> 'churn_monthly') = 'number' then (setv ->> 'churn_monthly')::numeric not between 0 and 1 else true end) then
      return 'churn_monthly is not a share from 0 to 1';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'churn_monthly'), 'null') not in ('number', 'null') then
      return 'the earlier churn_monthly is not a number';
    end if;
    return null;
  end if;
  return null;
end;
$$;

revoke all on function private.calibration_payload_problem(text, jsonb, jsonb) from public, anon;
-- apply_calibration runs as the caller.
grant execute on function private.calibration_payload_problem(text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. apply_calibration: row 50's function with one more branch (C2 part 2 lines marked)
-- ---------------------------------------------------------------------------

create or replace function public.apply_calibration(p_calibration uuid, p_keys text[]) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cal public.calibrations;
  k text;
  prop jsonb;
  pkind text;
  target_id uuid;
  setv jsonb;
  beforev jsonb;
  opened jsonb := null;
  draft_id uuid := null;
  st public.steps;
  ls public.lead_sources;
  cg public.client_groups; -- C2 part 2
  cols text[];
  col text;
  prov jsonb;
  entry jsonb;
  newprov jsonb;
  stamp jsonb;
  had_assumption boolean;
  left_assumption boolean;
  had_conflict boolean;
  left_conflict boolean;
  edge_ids uuid[];
  matches boolean;
  keys text[];
  problem text;
  done text[] := '{}';
  results jsonb := '[]';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
  end if;
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 2000 then
    raise exception 'Give between 1 and 2000 proposals' using errcode = '22023';
  end if;

  -- RLS: a calibration the user can't update (not an editor of its workspace) is not found.
  select * into cal from public.calibrations c where c.id = p_calibration for update;
  if cal.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  stamp := jsonb_build_object('source', 'measured', 'at', now(), 'dataset_id', cal.dataset_id, 'calibration_id', cal.id)
    || case when auth.uid() is null then '{}'::jsonb else jsonb_build_object('by', auth.uid()) end;

  keys := array(select distinct x from unnest(p_keys) x where x is not null order by x);
  foreach k in array keys loop
    select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
    if prop is null or coalesce(jsonb_typeof(prop -> 'set'), '') <> 'object' or coalesce(jsonb_typeof(prop -> 'before'), '') <> 'object' then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
      continue;
    end if;
    if k = any (cal.applied_keys) then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'already_applied'));
      continue;
    end if;
    pkind := coalesce(prop ->> 'kind', '');
    setv := prop -> 'set';
    beforev := prop -> 'before';
    begin
      target_id := (prop -> 'target' ->> 'id')::uuid;
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
      continue;
    end;
    -- Values that aren't what this kind needs are skipped with why, never cast (and so never abort the call).
    problem := private.calibration_payload_problem(pkind, setv, beforev);
    if problem is not null then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'invalid', 'reason', problem));
      continue;
    end if;

    -- A lead source's leads a week: live, as a person's edit to demand.
    if pkind = 'arrivals' and prop -> 'target' ->> 'table' = 'lead_sources' then
      select * into ls from public.lead_sources l where l.id = target_id and l.workspace_id = cal.workspace_id for update;
      if ls.id is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      if ls.volume_week is distinct from (beforev ->> 'volume_week')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      if jsonb_typeof(ls.provenance -> 'volume_week' -> 'evidence') = 'array' then
        entry := entry || jsonb_build_object('evidence', ls.provenance -> 'volume_week' -> 'evidence');
      end if;
      update public.lead_sources l
      set volume_week = (setv ->> 'volume_week')::numeric,
          provenance = l.provenance || jsonb_build_object('volume_week', entry)
      where l.id = ls.id;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;

    -- C2 part 2: a client group's normal churn, back-solved from a clients file: live, as a person's edit to the group.
    -- Provenance is set in the same statement, so the stamp_provenance trigger keeps it `measured` (it stamps `entered` only
    -- when the column changes and its provenance entry doesn't).
    if pkind = 'churn' and prop -> 'target' ->> 'table' = 'client_groups' then
      select * into cg from public.client_groups g where g.id = target_id and g.workspace_id = cal.workspace_id for update;
      if cg.id is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      if cg.churn_monthly is distinct from (beforev ->> 'churn_monthly')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_strip_nulls(jsonb_build_object(
        'n', prop -> 'n',
        'leavers', case when jsonb_typeof(prop -> 'leavers') = 'number' then prop -> 'leavers' end,
        'measured', case when jsonb_typeof(prop -> 'measured') = 'number' then prop -> 'measured' end,
        'multiplier', case when jsonb_typeof(prop -> 'multiplier') = 'number' then prop -> 'multiplier' end));
      if jsonb_typeof(cg.provenance -> 'churn_monthly' -> 'evidence') = 'array' then
        entry := entry || jsonb_build_object('evidence', cg.provenance -> 'churn_monthly' -> 'evidence');
      end if;
      update public.client_groups g
      set churn_monthly = (setv ->> 'churn_monthly')::numeric,
          provenance = g.provenance || jsonb_build_object('churn_monthly', entry)
      where g.id = cg.id;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;

    if pkind not in ('work', 'wait', 'rework', 'routing') or coalesce(prop -> 'target' ->> 'table', '') <> 'steps' or cal.process_id is null then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
      continue;
    end if;

    -- A step's values go into the process's draft, opened from live if there is none.
    if draft_id is null then
      opened := public.open_draft(cal.process_id);
      if opened ->> 'status' <> 'ok' then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        opened := null;
        continue;
      end if;
      draft_id := (opened ->> 'revision_id')::uuid;
    end if;

    select * into st from public.steps s where s.revision_id = draft_id and s.id = target_id for update;
    if st.id is null or cardinality(st.replaced_by) > 0 then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
      continue;
    end if;
    prov := case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end;

    if pkind = 'routing' then
      -- The ways out must be the ones measured, each still at the odds it had.
      if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
        continue;
      end if;
      select array_agg(x::uuid order by x) into edge_ids from jsonb_object_keys(setv -> 'probabilities') x;
      select coalesce(bool_and(e.probability is not distinct from (beforev -> 'probabilities' ->> e.id::text)::numeric), false)
        and count(*) = coalesce(cardinality(edge_ids), 0)
        and coalesce(bool_and(e.id = any (edge_ids)), false)
        into matches
      from public.edges e where e.revision_id = draft_id and e.from_step_id = st.id;
      if not coalesce(matches, false) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      update public.edges e set probability = (setv -> 'probabilities' ->> e.id::text)::numeric
      where e.revision_id = draft_id and e.from_step_id = st.id;
      -- Edges carry no provenance: the step records what was measured, so a later edit to the odds shows as no longer measured.
      -- Odds an upload left out (`branch_odds`) are filled in now.
      update public.steps s
      set provenance = (prov - 'branch_odds') || jsonb_build_object('routing', stamp || jsonb_build_object('n', prop -> 'n', 'probabilities', setv -> 'probabilities'))
      where s.revision_id = draft_id and s.id = st.id;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;

    if pkind = 'rework' then
      matches := st.rework_rate is not distinct from (beforev ->> 'rework_rate')::numeric;
      cols := array['rework_rate'];
    elsif pkind = 'work' then
      matches := st.work_hours is not distinct from (beforev ->> 'work_hours')::numeric
        and st.work_dist is not distinct from (beforev ->> 'work_dist')
        and (case when jsonb_typeof(st.work_params -> 'cv') = 'number' then (st.work_params ->> 'cv')::numeric end)
          is not distinct from (beforev ->> 'work_params_cv')::numeric;
      cols := array['work_hours', 'work_dist', 'work_params'];
    else
      matches := st.wait_hours is not distinct from (beforev ->> 'wait_hours')::numeric
        and st.wait_dist is not distinct from (beforev ->> 'wait_dist')
        and (case when jsonb_typeof(st.wait_params -> 'cv') = 'number' then (st.wait_params ->> 'cv')::numeric end)
          is not distinct from (beforev ->> 'wait_params_cv')::numeric;
      cols := array['wait_hours', 'wait_dist', 'wait_params'];
    end if;
    if not coalesce(matches, false) then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
      continue;
    end if;

    -- Each value's entry: measured, keeping the evidence it cited, and a conflict it had marked settled by the measurement.
    newprov := prov;
    foreach col in array cols loop
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      if jsonb_typeof(prov -> col -> 'evidence') = 'array' then
        entry := entry || jsonb_build_object('evidence', prov -> col -> 'evidence');
      end if;
      if jsonb_typeof(prov -> col -> 'conflict') = 'object' then
        entry := entry || jsonb_build_object('conflict', case
          when coalesce(prov -> col -> 'conflict' -> 'resolved', 'null') <> 'null' then prov -> col -> 'conflict'
          else (prov -> col -> 'conflict') || jsonb_build_object('resolved', jsonb_build_object('at', now(), 'choice', 'measured')) end);
      end if;
      newprov := newprov || jsonb_build_object(col, entry);
    end loop;

    -- The step's flags follow, as when a person types the values: settled here, and none left open elsewhere.
    had_assumption := exists (select 1 from unnest(cols) c where (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
    left_assumption := exists (select 1 from unnest(array['work_hours', 'wait_hours', 'rework_rate', 'current_wip', 'sla_hours']) c
      where c <> all (cols) and (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
    had_conflict := private.has_open_conflict(prov) and not private.has_open_conflict(newprov);
    left_conflict := private.has_open_conflict(newprov);

    update public.steps s
    set work_hours = case when pkind = 'work' then (setv ->> 'work_hours')::numeric else s.work_hours end,
        work_dist = case when pkind = 'work' then setv ->> 'work_dist' else s.work_dist end,
        work_params = case when pkind = 'work' then s.work_params || (setv -> 'work_params') else s.work_params end,
        wait_hours = case when pkind = 'wait' then (setv ->> 'wait_hours')::numeric else s.wait_hours end,
        wait_dist = case when pkind = 'wait' then setv ->> 'wait_dist' else s.wait_dist end,
        wait_params = case when pkind = 'wait' then s.wait_params || (setv -> 'wait_params') else s.wait_params end,
        rework_rate = case when pkind = 'rework' then (setv ->> 'rework_rate')::numeric else s.rework_rate end,
        provenance = newprov,
        assumption = s.assumption and not (had_assumption and not left_assumption),
        conflict = s.conflict and not (had_conflict and not left_conflict)
    where s.revision_id = draft_id and s.id = st.id;
    done := done || k;
    results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
  end loop;

  if cardinality(done) > 0 then
    -- The trigger sets applied, applied_at and applied_by, and accepts the keys only while this flag is on.
    perform set_config('transpera.applying_calibration', 'on', true);
    update public.calibrations c set applied_keys = c.applied_keys || done where c.id = cal.id;
    perform set_config('transpera.applying_calibration', 'off', true);
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'draft', case when opened is null then null else jsonb_build_object(
      'revision_id', opened -> 'revision_id', 'number', opened -> 'number', 'created', opened -> 'created') end,
    'results', results);
end;
$$;

revoke all on function public.apply_calibration(uuid, text[]) from public, anon, authenticated;
grant execute on function public.apply_calibration(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- record_client_calibration: one or two dataset records, the calibration and the apply, in one transaction
-- ---------------------------------------------------------------------------

create function public.record_client_calibration(
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
begin
  -- With no keys apply_calibration isn't called, so the API-token refusal is repeated here.
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
  end if;
  if p_clients is null and p_log is null then
    raise exception 'Give a clients file or a servicing log' using errcode = '22023';
  end if;
  -- Row-level security refuses a viewer's or a stranger's insert, and apply_calibration an API token. Either way the whole
  -- call rolls back, records included.
  if p_clients is not null then
    insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count)
    values (p_workspace, 'clients', null, p_clients ->> 'file_name', coalesce(p_clients -> 'column_map', '{}'), (p_clients ->> 'row_count')::integer)
    returning id into clients_ds;
  end if;
  if p_log is not null then
    insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count)
    values (p_workspace, 'servicing_log', null, p_log ->> 'file_name', coalesce(p_log -> 'column_map', '{}'), (p_log ->> 'row_count')::integer)
    returning id into log_ds;
  end if;
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

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261208000000', 'client_calibration', array[$mig$-- Calibration from historical data, part 2 (issue #41, C2; PRD §5 `datasets` and `calibrations`, §6.6, D44; docs/plans/c2-2-brief.md).
--
-- A person pastes or uploads a CLIENTS FILE (client, service, started, ended) and/or a SERVICING LOG (task, client, due, done) on
-- Settings → Historical data. The app parses them in the browser and computes, with packages/engine/src/client-calibration.ts:
--   * each client group's NORMAL CHURN, back-solved so that today's simulated churn (normal churn x driver pressure) matches the
--     churn measured in the clients file (Austin's answer 1 on #41: otherwise the drivers count today's late work twice);
--   * three CHECKS shown beside the simulated values (late or missed share, response time to ad-hoc requests, onboarding speed),
--     which are never applied.
-- The person ticks the churn proposals to apply; nothing is applied without that. Client ids, and service and task names that
-- match nothing, never reach the database: the page sends counts, the proposals (service names and numbers) and the checks
-- (D27). The raw rows are never stored.
--
-- ADDITIVE: it widens one check, replaces two of row 50's functions with full copies that each add one branch (the same rule as
-- `save_fields`: the latest definition, copied; the added lines are marked `-- C2 part 2`), and adds one function. No table,
-- column, policy or grant changes. It does NOT touch `save_fields`, `record_calibration` or the `calibrations` trigger.
--
--   * `datasets_kind` also allows `clients` and `servicing_log` (precedent: `sources_kind` in row 48).
--   * `private.calibration_payload_problem(kind, set, before)` knows the kind `churn`: `churn_monthly` must be a share from 0 to 1
--     and the earlier one a number or null; otherwise the proposal is skipped as `invalid`, with a reason.
--   * `public.apply_calibration(p_calibration, p_keys)` applies a `churn` proposal targeting `client_groups` LIVE, as a person's
--     edit to the group (like leads a week, D19): `client_groups.churn_monthly` is set and its provenance entry is `measured`
--     with `at`, `by`, `dataset_id`, `calibration_id`, `n`, `leavers`, `measured` and `multiplier`. The provenance is written in
--     the same statement, so `stamp_provenance` doesn't turn it `entered`. A group whose churn changed since the proposal
--     (`before` no longer matches) is `changed`, another workspace's or a missing group is `not_found`, a key applied before is
--     `already_applied`. `audit_company_write` logs the change as for any edit; the API-token refusal at the top applies.
--   * `public.record_client_calibration(p_workspace, p_clients, p_log, p_results, p_keys)` (SECURITY INVOKER): what the page
--     calls. `p_clients` and `p_log` are each null or {file_name, column_map, row_count}. It records one dataset per file given
--     (`kind` `clients` / `servicing_log`, no process), one calibration (`results.datasets` holds both dataset ids) and applies
--     the ticked keys, in ONE transaction: a failed or refused apply leaves no record behind. With no keys it records the
--     checks and applies nothing. Refuses an API token (42501) and a call with neither file (22023). Returns apply_calibration's
--     answer (or {status: 'ok', draft: null, results: []}) plus `calibration_id` and `datasets`.
-- Row-level security and grants are row 50's: everyone in the workspace reads; owners and editors insert and apply.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   0. Nothing at or past this version. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261208000000';
--   1. Row 50 (part 1) is applied. Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261202000000';
--   2. The two functions this replaces are row 50's, unchanged. Expect these two md5s (computed on a local database migrated
--      to 20261205000000; none of the later migrations touches either):
--        private.calibration_payload_problem | e8583ea0b5b46f08bb0c7f4f79e6f88e
--        public.apply_calibration            | cee525a1f74c702cb70048abfa716ad6
--        select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem')) order by 1;
--   3. Only step logs recorded so far. Expect only step_log (or no rows):
--        select kind, count(*) from public.datasets group by 1;
--   4. Nothing created yet. Expect null:
--        select to_regprocedure('public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[])');
--   5. The columns the new branch writes exist. Expect 2 rows:
--        select column_name from information_schema.columns where table_schema = 'public' and table_name = 'client_groups'
--          and column_name in ('churn_monthly', 'provenance');
--
-- POST-APPLY CHECK:
--   * `pg_get_constraintdef` of `datasets_kind` lists the two new kinds:
--        select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_kind';
--   * `record_client_calibration` is not SECURITY DEFINER, has an empty search_path, is executable by authenticated and not anon;
--     `apply_calibration` and `calibration_payload_problem` keep the same:
--        select proname, prosecdef, proconfig = array['search_path=""'], has_function_privilege('authenticated', p.oid, 'execute'),
--               has_function_privilege('anon', p.oid, 'execute')
--        from pg_proc p where proname in ('record_client_calibration', 'apply_calibration', 'calibration_payload_problem') order by 1;
--     Expect: f, t, t, f for the first two; for `calibration_payload_problem` f, t, t, f too (row 50 grants it to authenticated).
--
-- ROLLBACK (one transaction; roll the app back first):
--
--   begin;
--   drop function if exists public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[]);
--   -- Put back row 50's apply_calibration and calibration_payload_problem: re-run their
--   -- `create function ... $$;` blocks from 20261202000000_calibration.sql as `create or replace`, with their grants.
--   delete from public.datasets where kind in ('clients', 'servicing_log');  -- cascades to their calibrations
--   alter table public.datasets drop constraint datasets_kind,
--     add constraint datasets_kind check (kind in ('step_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices'));
--   delete from supabase_migrations.schema_migrations where version = '20261208000000';
--   commit;
--
-- Rolling back deletes the clients and servicing-log records. Applied churn keeps its number and its `measured` provenance,
-- whose `dataset_id` then points at nothing (the app shows it as measured without a link).
--
-- Production data: none needed.

-- 1. A clients file and a servicing log are recorded as datasets too.
alter table public.datasets drop constraint datasets_kind,
  add constraint datasets_kind check (kind in ('step_log', 'clients', 'servicing_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices'));

-- ---------------------------------------------------------------------------
-- 2. What is wrong with a proposal's values: row 50's function with one more kind (C2 part 2 lines marked)
-- ---------------------------------------------------------------------------

create or replace function private.calibration_payload_problem(kind text, setv jsonb, beforev jsonb) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  p text;
  v jsonb;
begin
  -- `before` holds what the value was: a number, or null when it had none.
  if kind = 'arrivals' then
    if (case when jsonb_typeof(setv -> 'volume_week') = 'number' then (setv ->> 'volume_week')::numeric < 0 else true end) then
      return 'volume_week is not a number of leads';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'volume_week'), 'null') not in ('number', 'null') then
      return 'the earlier volume_week is not a number';
    end if;
    return null;
  end if;
  if kind = 'rework' then
    if (case when jsonb_typeof(setv -> 'rework_rate') = 'number' then (setv ->> 'rework_rate')::numeric not between 0 and 1 else true end) then
      return 'rework_rate is not a share from 0 to 1';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'rework_rate'), 'null') not in ('number', 'null') then
      return 'the earlier rework_rate is not a number';
    end if;
    return null;
  end if;
  if kind in ('work', 'wait') then
    p := kind;
    if (case when jsonb_typeof(setv -> (p || '_hours')) = 'number' then (setv ->> (p || '_hours'))::numeric < 0 else true end) then
      return p || '_hours is not a number of hours';
    end if;
    if coalesce(jsonb_typeof(setv -> (p || '_dist')), '') <> 'string' or setv ->> (p || '_dist') not in ('constant', 'triangular', 'lognormal') then
      return p || '_dist is not a distribution';
    end if;
    if coalesce(jsonb_typeof(setv -> (p || '_params')), '') <> 'object' then
      return p || '_params is not an object';
    end if;
    if coalesce(jsonb_typeof(beforev -> (p || '_hours')), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(beforev -> (p || '_params_cv')), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(beforev -> (p || '_dist')), 'null') not in ('string', 'null') then
      return 'the earlier values are not numbers';
    end if;
    return null;
  end if;
  if kind = 'routing' then
    if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
      return 'probabilities is not an object';
    end if;
    for p, v in select e.key, e.value from jsonb_each(setv -> 'probabilities') e loop
      if p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return 'a way out is not an edge id';
      end if;
      if (case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric not between 0 and 1 else true end) then
        return 'odds are not shares from 0 to 1';
      end if;
    end loop;
    if coalesce(jsonb_typeof(beforev -> 'probabilities'), '') <> 'object' then
      return 'the earlier odds are not an object';
    end if;
    for v in select e.value from jsonb_each(beforev -> 'probabilities') e loop
      if jsonb_typeof(v) not in ('number', 'null') then
        return 'the earlier odds are not numbers';
      end if;
    end loop;
    return null;
  end if;
  -- C2 part 2: a client group's normal churn, back-solved from a clients file.
  if kind = 'churn' then
    if (case when jsonb_typeof(setv -> 'churn_monthly') = 'number' then (setv ->> 'churn_monthly')::numeric not between 0 and 1 else true end) then
      return 'churn_monthly is not a share from 0 to 1';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'churn_monthly'), 'null') not in ('number', 'null') then
      return 'the earlier churn_monthly is not a number';
    end if;
    return null;
  end if;
  return null;
end;
$$;

revoke all on function private.calibration_payload_problem(text, jsonb, jsonb) from public, anon;
-- apply_calibration runs as the caller.
grant execute on function private.calibration_payload_problem(text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. apply_calibration: row 50's function with one more branch (C2 part 2 lines marked)
-- ---------------------------------------------------------------------------

create or replace function public.apply_calibration(p_calibration uuid, p_keys text[]) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cal public.calibrations;
  k text;
  prop jsonb;
  pkind text;
  target_id uuid;
  setv jsonb;
  beforev jsonb;
  opened jsonb := null;
  draft_id uuid := null;
  st public.steps;
  ls public.lead_sources;
  cg public.client_groups; -- C2 part 2
  cols text[];
  col text;
  prov jsonb;
  entry jsonb;
  newprov jsonb;
  stamp jsonb;
  had_assumption boolean;
  left_assumption boolean;
  had_conflict boolean;
  left_conflict boolean;
  edge_ids uuid[];
  matches boolean;
  keys text[];
  problem text;
  done text[] := '{}';
  results jsonb := '[]';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
  end if;
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 2000 then
    raise exception 'Give between 1 and 2000 proposals' using errcode = '22023';
  end if;

  -- RLS: a calibration the user can't update (not an editor of its workspace) is not found.
  select * into cal from public.calibrations c where c.id = p_calibration for update;
  if cal.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  stamp := jsonb_build_object('source', 'measured', 'at', now(), 'dataset_id', cal.dataset_id, 'calibration_id', cal.id)
    || case when auth.uid() is null then '{}'::jsonb else jsonb_build_object('by', auth.uid()) end;

  keys := array(select distinct x from unnest(p_keys) x where x is not null order by x);
  foreach k in array keys loop
    select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
    if prop is null or coalesce(jsonb_typeof(prop -> 'set'), '') <> 'object' or coalesce(jsonb_typeof(prop -> 'before'), '') <> 'object' then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
      continue;
    end if;
    if k = any (cal.applied_keys) then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'already_applied'));
      continue;
    end if;
    pkind := coalesce(prop ->> 'kind', '');
    setv := prop -> 'set';
    beforev := prop -> 'before';
    begin
      target_id := (prop -> 'target' ->> 'id')::uuid;
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
      continue;
    end;
    -- Values that aren't what this kind needs are skipped with why, never cast (and so never abort the call).
    problem := private.calibration_payload_problem(pkind, setv, beforev);
    if problem is not null then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'invalid', 'reason', problem));
      continue;
    end if;

    -- A lead source's leads a week: live, as a person's edit to demand.
    if pkind = 'arrivals' and prop -> 'target' ->> 'table' = 'lead_sources' then
      select * into ls from public.lead_sources l where l.id = target_id and l.workspace_id = cal.workspace_id for update;
      if ls.id is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      if ls.volume_week is distinct from (beforev ->> 'volume_week')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      if jsonb_typeof(ls.provenance -> 'volume_week' -> 'evidence') = 'array' then
        entry := entry || jsonb_build_object('evidence', ls.provenance -> 'volume_week' -> 'evidence');
      end if;
      update public.lead_sources l
      set volume_week = (setv ->> 'volume_week')::numeric,
          provenance = l.provenance || jsonb_build_object('volume_week', entry)
      where l.id = ls.id;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;

    -- C2 part 2: a client group's normal churn, back-solved from a clients file: live, as a person's edit to the group.
    -- Provenance is set in the same statement, so the stamp_provenance trigger keeps it `measured` (it stamps `entered` only
    -- when the column changes and its provenance entry doesn't).
    if pkind = 'churn' and prop -> 'target' ->> 'table' = 'client_groups' then
      select * into cg from public.client_groups g where g.id = target_id and g.workspace_id = cal.workspace_id for update;
      if cg.id is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      if cg.churn_monthly is distinct from (beforev ->> 'churn_monthly')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_strip_nulls(jsonb_build_object(
        'n', prop -> 'n',
        'leavers', case when jsonb_typeof(prop -> 'leavers') = 'number' then prop -> 'leavers' end,
        'measured', case when jsonb_typeof(prop -> 'measured') = 'number' then prop -> 'measured' end,
        'multiplier', case when jsonb_typeof(prop -> 'multiplier') = 'number' then prop -> 'multiplier' end));
      if jsonb_typeof(cg.provenance -> 'churn_monthly' -> 'evidence') = 'array' then
        entry := entry || jsonb_build_object('evidence', cg.provenance -> 'churn_monthly' -> 'evidence');
      end if;
      update public.client_groups g
      set churn_monthly = (setv ->> 'churn_monthly')::numeric,
          provenance = g.provenance || jsonb_build_object('churn_monthly', entry)
      where g.id = cg.id;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;

    if pkind not in ('work', 'wait', 'rework', 'routing') or coalesce(prop -> 'target' ->> 'table', '') <> 'steps' or cal.process_id is null then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
      continue;
    end if;

    -- A step's values go into the process's draft, opened from live if there is none.
    if draft_id is null then
      opened := public.open_draft(cal.process_id);
      if opened ->> 'status' <> 'ok' then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        opened := null;
        continue;
      end if;
      draft_id := (opened ->> 'revision_id')::uuid;
    end if;

    select * into st from public.steps s where s.revision_id = draft_id and s.id = target_id for update;
    if st.id is null or cardinality(st.replaced_by) > 0 then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
      continue;
    end if;
    prov := case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end;

    if pkind = 'routing' then
      -- The ways out must be the ones measured, each still at the odds it had.
      if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
        continue;
      end if;
      select array_agg(x::uuid order by x) into edge_ids from jsonb_object_keys(setv -> 'probabilities') x;
      select coalesce(bool_and(e.probability is not distinct from (beforev -> 'probabilities' ->> e.id::text)::numeric), false)
        and count(*) = coalesce(cardinality(edge_ids), 0)
        and coalesce(bool_and(e.id = any (edge_ids)), false)
        into matches
      from public.edges e where e.revision_id = draft_id and e.from_step_id = st.id;
      if not coalesce(matches, false) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      update public.edges e set probability = (setv -> 'probabilities' ->> e.id::text)::numeric
      where e.revision_id = draft_id and e.from_step_id = st.id;
      -- Edges carry no provenance: the step records what was measured, so a later edit to the odds shows as no longer measured.
      -- Odds an upload left out (`branch_odds`) are filled in now.
      update public.steps s
      set provenance = (prov - 'branch_odds') || jsonb_build_object('routing', stamp || jsonb_build_object('n', prop -> 'n', 'probabilities', setv -> 'probabilities'))
      where s.revision_id = draft_id and s.id = st.id;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;

    if pkind = 'rework' then
      matches := st.rework_rate is not distinct from (beforev ->> 'rework_rate')::numeric;
      cols := array['rework_rate'];
    elsif pkind = 'work' then
      matches := st.work_hours is not distinct from (beforev ->> 'work_hours')::numeric
        and st.work_dist is not distinct from (beforev ->> 'work_dist')
        and (case when jsonb_typeof(st.work_params -> 'cv') = 'number' then (st.work_params ->> 'cv')::numeric end)
          is not distinct from (beforev ->> 'work_params_cv')::numeric;
      cols := array['work_hours', 'work_dist', 'work_params'];
    else
      matches := st.wait_hours is not distinct from (beforev ->> 'wait_hours')::numeric
        and st.wait_dist is not distinct from (beforev ->> 'wait_dist')
        and (case when jsonb_typeof(st.wait_params -> 'cv') = 'number' then (st.wait_params ->> 'cv')::numeric end)
          is not distinct from (beforev ->> 'wait_params_cv')::numeric;
      cols := array['wait_hours', 'wait_dist', 'wait_params'];
    end if;
    if not coalesce(matches, false) then
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
      continue;
    end if;

    -- Each value's entry: measured, keeping the evidence it cited, and a conflict it had marked settled by the measurement.
    newprov := prov;
    foreach col in array cols loop
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      if jsonb_typeof(prov -> col -> 'evidence') = 'array' then
        entry := entry || jsonb_build_object('evidence', prov -> col -> 'evidence');
      end if;
      if jsonb_typeof(prov -> col -> 'conflict') = 'object' then
        entry := entry || jsonb_build_object('conflict', case
          when coalesce(prov -> col -> 'conflict' -> 'resolved', 'null') <> 'null' then prov -> col -> 'conflict'
          else (prov -> col -> 'conflict') || jsonb_build_object('resolved', jsonb_build_object('at', now(), 'choice', 'measured')) end);
      end if;
      newprov := newprov || jsonb_build_object(col, entry);
    end loop;

    -- The step's flags follow, as when a person types the values: settled here, and none left open elsewhere.
    had_assumption := exists (select 1 from unnest(cols) c where (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
    left_assumption := exists (select 1 from unnest(array['work_hours', 'wait_hours', 'rework_rate', 'current_wip', 'sla_hours']) c
      where c <> all (cols) and (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
    had_conflict := private.has_open_conflict(prov) and not private.has_open_conflict(newprov);
    left_conflict := private.has_open_conflict(newprov);

    update public.steps s
    set work_hours = case when pkind = 'work' then (setv ->> 'work_hours')::numeric else s.work_hours end,
        work_dist = case when pkind = 'work' then setv ->> 'work_dist' else s.work_dist end,
        work_params = case when pkind = 'work' then s.work_params || (setv -> 'work_params') else s.work_params end,
        wait_hours = case when pkind = 'wait' then (setv ->> 'wait_hours')::numeric else s.wait_hours end,
        wait_dist = case when pkind = 'wait' then setv ->> 'wait_dist' else s.wait_dist end,
        wait_params = case when pkind = 'wait' then s.wait_params || (setv -> 'wait_params') else s.wait_params end,
        rework_rate = case when pkind = 'rework' then (setv ->> 'rework_rate')::numeric else s.rework_rate end,
        provenance = newprov,
        assumption = s.assumption and not (had_assumption and not left_assumption),
        conflict = s.conflict and not (had_conflict and not left_conflict)
    where s.revision_id = draft_id and s.id = st.id;
    done := done || k;
    results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
  end loop;

  if cardinality(done) > 0 then
    -- The trigger sets applied, applied_at and applied_by, and accepts the keys only while this flag is on.
    perform set_config('transpera.applying_calibration', 'on', true);
    update public.calibrations c set applied_keys = c.applied_keys || done where c.id = cal.id;
    perform set_config('transpera.applying_calibration', 'off', true);
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'draft', case when opened is null then null else jsonb_build_object(
      'revision_id', opened -> 'revision_id', 'number', opened -> 'number', 'created', opened -> 'created') end,
    'results', results);
end;
$$;

revoke all on function public.apply_calibration(uuid, text[]) from public, anon, authenticated;
grant execute on function public.apply_calibration(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- record_client_calibration: one or two dataset records, the calibration and the apply, in one transaction
-- ---------------------------------------------------------------------------

create function public.record_client_calibration(
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
begin
  -- With no keys apply_calibration isn't called, so the API-token refusal is repeated here.
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
  end if;
  if p_clients is null and p_log is null then
    raise exception 'Give a clients file or a servicing log' using errcode = '22023';
  end if;
  -- Row-level security refuses a viewer's or a stranger's insert, and apply_calibration an API token. Either way the whole
  -- call rolls back, records included.
  if p_clients is not null then
    insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count)
    values (p_workspace, 'clients', null, p_clients ->> 'file_name', coalesce(p_clients -> 'column_map', '{}'), (p_clients ->> 'row_count')::integer)
    returning id into clients_ds;
  end if;
  if p_log is not null then
    insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count)
    values (p_workspace, 'servicing_log', null, p_log ->> 'file_name', coalesce(p_log -> 'column_map', '{}'), (p_log ->> 'row_count')::integer)
    returning id into log_ds;
  end if;
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
