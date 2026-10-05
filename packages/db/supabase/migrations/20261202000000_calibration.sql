-- Calibration from historical data, part 1 (issue #41, C2; PRD §5 `datasets` and `calibrations`, §6.6).
--
-- A person pastes or uploads a step log for one process on the Calibration page (one row per item per step: item, step,
-- started, finished, and optionally hours and lead source). The app parses it in the browser and computes proposals
-- (packages/engine/src/calibration.ts): hands-on time and spread, waits, redo rates, branch odds and qualified leads a
-- week. The person ticks the ones to apply. Nothing is applied without that: this is how calibration proposes and a
-- person accepts. The raw rows are never stored; only what the PRD's `datasets` row records about the file (name,
-- column map, row count) and the calibration's results (every proposal, current and proposed, with its sample size).
--
-- STRICTLY ADDITIVE: two new tables and two new functions. Nothing existing is changed.
--
--   * `public.datasets`: workspace, `kind` (`step_log` now; the PRD's `leads`, `deals`, `jobs`, `time_logs`, `invoices`
--     are allowed for C1's wizard, #40), the process it is about (if any), `file_name`, `column_map` (which column of the
--     file holds item, step, started, ...), `row_count`, `imported_at`. Insert-only: nobody updates or deletes one; it
--     is the record a measured value points at (`provenance.dataset_id`).
--   * `public.calibrations`: workspace, dataset, process, `results` (the proposals as computed: {proposals: [{key, kind,
--     target: {table, id}, n, enough, set, before, ...}], ...}), and what was applied (`applied`, `applied_keys`,
--     `applied_at`, `applied_by`). What was proposed never changes; only `applied_keys` is updatable, and only from
--     inside `apply_calibration` (the trigger sets the other three).
--   * `public.apply_calibration(p_calibration uuid, p_keys text[])` (SECURITY INVOKER: row-level security decides):
--     applies the chosen proposals in one transaction, each on its own terms:
--       - a step's value (hands-on time and spread, wait and spread, redo rate) and a step's branch odds go into the
--         process's DRAFT (opened from live with `open_draft` if there is none), so nothing reaches the live model until
--         someone publishes it, as with every other change to a process (PRD §7.1b, D18);
--       - a lead source's leads a week change live, as a person's edit to demand does (D19);
--       - every value written gets provenance `{source: "measured", at, by, dataset_id, calibration_id, n}`, keeping any
--         evidence it cited and marking a conflict it had as settled by the measurement (as typing a value does);
--       - a value that changed since the calibration was computed (`before` no longer matches) is skipped and reported as
--         `changed`, never overwritten; so are a step or edge no longer in the draft (`not_found`) and a key applied
--         before (`already_applied`).
--     Returns {status: 'ok', draft: {revision_id, number, created} | null, results: [{key, status}]}. An API-token
--     request (the MCP server) is refused: a person applies calibration in the app.
--   * `public.record_calibration(...)` (SECURITY INVOKER): what the page calls. Records the dataset and the calibration
--     and applies the ticked keys in ONE transaction, so a failed or refused apply leaves no record behind and a retry
--     doesn't pile them up. Returns apply_calibration's answer plus `calibration_id` and `dataset_id`.
--   * `private.calibrations_before_write`: a new calibration starts unapplied; what it proposed never changes;
--     `applied_keys` only grows, only inside `apply_calibration` (it sets the transaction-local flag
--     `transpera.applying_calibration` around its one update; any other update of the keys is refused), and when it does
--     `applied` becomes true and `applied_at`/`applied_by` are set to now and the signed-in user; deleting a user may null
--     `created_by`/`applied_by` (that runs as the table owner; a signed-in request may not).
--   * A proposal whose values aren't what the proposal kind needs (a number that isn't one, `work_params` that isn't an
--     object, odds outside 0-1, ...) is skipped as `invalid` with a `reason`, never aborting the call
--     (`private.calibration_payload_problem`).
--
-- Row-level security as `suggestion_proposals`: everyone in the workspace reads; owners and editors insert and apply.
-- Privileges: Supabase gives every new table full rights to anon and authenticated, so this revokes them and grants back
-- select and insert, and on `calibrations` an UPDATE of `applied_keys` only (which `apply_calibration`, running as the
-- caller, needs; the trigger refuses it outside that function). No delete for anyone.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   1. The tables don't exist yet. Expect 0:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('datasets', 'calibrations');
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261202000000';
--   3. The three migrations before it (rows 47-49 of docs/production-migrations.md) are applied. Expect 3:
--        select count(*) from supabase_migrations.schema_migrations where version in ('20261130000000', '20261130500000', '20261201000000');
--   4. The helpers it calls exist. Expect 5 rows:
--        select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where (n.nspname = 'public' and p.proname in ('open_draft', 'can_read_workspace', 'can_edit_workspace', 'set_updated_at'))
--           or (n.nspname = 'private' and p.proname = 'has_open_conflict');
--   5. The tables it references exist. Expect 5 rows:
--        select table_name from information_schema.tables where table_schema = 'public' and table_name in ('workspaces', 'processes', 'steps', 'edges', 'lead_sources');
--
-- POST-APPLY CHECK (authenticated: INSERT and SELECT on both tables, UPDATE on calibrations' applied_keys only; anon:
-- nothing; the functions: not SECURITY DEFINER, empty search_path, no anon EXECUTE):
--        select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ('datasets', 'calibrations') and grantee in ('anon', 'authenticated') order by 1, 2, 3;
--        select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'calibrations' and grantee = 'authenticated' and privilege_type = 'UPDATE' order by 1;
--        select prosecdef, proconfig, has_function_privilege('anon', p.oid, 'execute') from pg_proc p where proname in ('apply_calibration', 'record_calibration');
--   Expect: authenticated INSERT and SELECT on each (no UPDATE row at table level); UPDATE column applied_keys only;
--   f, {search_path=""}, f for each function.
--
-- ROLLBACK (one transaction; nothing existing was changed, so nothing to put back):
--
--   begin;
--   drop function if exists public.record_calibration(uuid, uuid, text, jsonb, integer, jsonb, text[]);
--   drop function if exists public.apply_calibration(uuid, text[]);
--   drop table if exists public.calibrations;   -- its indexes, triggers and policies go with it
--   drop table if exists public.datasets;
--   drop function if exists private.calibrations_before_write();
--   drop function if exists private.calibration_payload_problem(text, jsonb, jsonb);
--   delete from supabase_migrations.schema_migrations where version = '20261202000000';
--   commit;
--
-- Rolling back deletes every dataset record and calibration. Values already applied keep their numbers and their
-- `measured` provenance, whose `dataset_id` then points at nothing (the app shows them as measured without a link).
--
-- Production data: none needed.

create table public.datasets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null constraint datasets_kind check (kind in ('step_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices')),
  -- The process a step log is about. Processes are archived rather than deleted; if one is deleted, the record stays.
  process_id uuid,
  file_name text not null constraint datasets_file_name check (char_length(btrim(file_name)) between 1 and 300),
  -- Which column of the file holds what: {item: "Deal ID", step: "Stage", started: "Start", ...}.
  column_map jsonb not null default '{}' constraint datasets_column_map check (
    jsonb_typeof(column_map) = 'object' and octet_length(column_map::text) <= 10000),
  row_count integer not null constraint datasets_row_count check (row_count between 0 and 1000000),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete set null (process_id)
);

create index on public.datasets (workspace_id, imported_at desc);
create index on public.datasets (process_id) where process_id is not null;

create table public.calibrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  dataset_id uuid not null,
  process_id uuid,
  -- The proposals as computed, current and proposed with sample sizes: {proposals: [...], rows, items, window, ...}.
  results jsonb not null constraint calibrations_results check (coalesce(
    jsonb_typeof(results) = 'object' and jsonb_typeof(results -> 'proposals') = 'array'
    and jsonb_array_length(results -> 'proposals') <= 2000 and octet_length(results::text) <= 2000000, false)),
  applied boolean not null default false,
  applied_keys text[] not null default '{}' constraint calibrations_applied_keys check (cardinality(applied_keys) <= 2000),
  applied_at timestamptz,
  applied_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint calibrations_applied check (applied = (applied_at is not null)),
  unique (id, workspace_id),
  foreign key (dataset_id, workspace_id) references public.datasets (id, workspace_id) on delete cascade,
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete set null (process_id)
);

create index on public.calibrations (workspace_id, created_at desc);
create index on public.calibrations (dataset_id);
create index on public.calibrations (process_id) where process_id is not null;

create trigger set_updated_at before update on public.calibrations
  for each row execute function public.set_updated_at();

-- A new calibration starts unapplied; what it proposed never changes afterwards.
create function private.calibrations_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.applied := false;
    new.applied_keys := '{}';
    new.applied_at := null;
    new.applied_by := null;
    return new;
  end if;
  if new.results is distinct from old.results or new.dataset_id is distinct from old.dataset_id
     or new.workspace_id is distinct from old.workspace_id or new.created_at is distinct from old.created_at
     -- The process and the creator may only go (their row deleted: the foreign key nulls them, as the table owner).
     or (new.created_by is distinct from old.created_by and (new.created_by is not null or current_user in ('authenticated', 'anon')))
     or (new.process_id is distinct from old.process_id and new.process_id is not null) then
    raise exception 'A calibration''s proposals never change' using errcode = '55000';
  end if;
  if not (new.applied_keys @> old.applied_keys) then
    raise exception 'Applied proposals stay applied' using errcode = '55000';
  end if;
  if new.applied_keys is distinct from old.applied_keys then
    if coalesce(current_setting('transpera.applying_calibration', true), '') <> 'on' then
      raise exception 'Proposals are applied with apply_calibration' using errcode = '55000';
    end if;
    -- Something more was applied: by whom and when is the database's to say.
    new.applied := true;
    new.applied_at := now();
    new.applied_by := auth.uid();
  elsif new.applied is distinct from old.applied or new.applied_at is distinct from old.applied_at
     or (new.applied_by is distinct from old.applied_by and (new.applied_by is not null or current_user in ('authenticated', 'anon'))) then
    raise exception 'Only applying proposals changes what was applied' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.calibrations_before_write() from public, anon, authenticated;

create trigger calibrations_before_write before insert or update on public.calibrations
  for each row execute function private.calibrations_before_write();

alter table public.datasets enable row level security;
alter table public.calibrations enable row level security;

create policy "read datasets" on public.datasets for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert datasets" on public.datasets for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));

create policy "read calibrations" on public.calibrations for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert calibrations" on public.calibrations for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update calibrations" on public.calibrations for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));

revoke all on public.datasets from anon, authenticated;
revoke all on public.calibrations from anon, authenticated;
grant select, insert on public.datasets to authenticated;
grant select, insert on public.calibrations to authenticated;
-- apply_calibration runs as the caller, so it needs this one column; the trigger refuses the update anywhere else.
grant update (applied_keys) on public.calibrations to authenticated;

-- ---------------------------------------------------------------------------
-- What is wrong with a proposal's values, if anything (null: nothing)
-- ---------------------------------------------------------------------------

create function private.calibration_payload_problem(kind text, setv jsonb, beforev jsonb) returns text
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
  return null;
end;
$$;

revoke all on function private.calibration_payload_problem(text, jsonb, jsonb) from public, anon;
-- apply_calibration runs as the caller.
grant execute on function private.calibration_payload_problem(text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- apply_calibration: write the chosen proposals, as the signed-in person
-- ---------------------------------------------------------------------------

create function public.apply_calibration(p_calibration uuid, p_keys text[]) returns jsonb
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
-- record_calibration: the dataset record, the calibration and the apply, in one transaction
-- ---------------------------------------------------------------------------

create function public.record_calibration(
  p_workspace uuid,
  p_process uuid,
  p_file_name text,
  p_column_map jsonb,
  p_row_count integer,
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
  -- Row-level security refuses a viewer's or a stranger's insert; apply_calibration refuses an API token. Either way
  -- the whole call rolls back, records included.
  insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count)
  values (p_workspace, 'step_log', p_process, p_file_name, coalesce(p_column_map, '{}'), p_row_count)
  returning id into ds;
  insert into public.calibrations (workspace_id, dataset_id, process_id, results)
  values (p_workspace, ds, p_process, p_results)
  returning id into cal;
  out := public.apply_calibration(cal, p_keys);
  return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
end;
$$;

revoke all on function public.record_calibration(uuid, uuid, text, jsonb, integer, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.record_calibration(uuid, uuid, text, jsonb, integer, jsonb, text[]) to authenticated;
