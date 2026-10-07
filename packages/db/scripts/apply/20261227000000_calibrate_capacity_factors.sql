-- Production apply file for 20261227000000_calibrate_capacity_factors (issue #227, C6 follow-up). One table (`capacity_factor_proposals`) and FOUR replaced
-- functions: `private.calibration_payload_problem`, `public.apply_calibration`, `public.record_calibration_import` and
-- `public.team_capacity` (each a full copy of its latest body plus marked `-- #227` lines). This is row 72 of
-- docs/production-migrations.md; apply it after rows 57, 62, 67 and 71 (20261226000000), else renumber per HANDOVER.
-- APPLY BEFORE DEPLOYING THE APP (the page sends `capacity_factors`; the old `record_calibration_import` would store them in
-- `results`, which members read). Preflight, post-apply checks and rollback are in the migration's own header, repeated below.
-- Sets `lock_timeout` to 5 s.

begin;
set local lock_timeout = '5s';

-- Per-person times, measured (issue #227, C6 follow-up; docs/plans/c6-227-brief.md).
--
-- A stage history (step log) or a time log can name who did each visit. For owners, editors and agency admins, with Per-person
-- times switched on, calibration then measures each person's hands-on time on each step against that step's normal time and
-- proposes a per-person time (a factor, 0.5 to 2) with its sample size, from 10 visits (PRD section 6.3.7). The person ticks what
-- to apply; the same Apply button and the same record-and-apply call write it, as a `measured` value linked to the dataset and
-- the calibration. Members and viewers never see a per-person proposal, and nothing is ranked or put side by side (PRD D20).
--
-- Decisions (verbatim, from the brief):
--   Austin, 6 Oct (#41 decision 4): "Per-person times: calibration proposes capacity factors only when the workspace has per-person
--     times switched on."
--   #227: "Then calibration can propose a time per person-step as a suggestion, with provenance.factor.source = 'measured', and
--     personFactors can set measuredItems. Never ranked or compared across people."
--   PRD D20: "Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only
--     when measured, visible to the person, never ranked; no role-median benchmark."
--   Orchestrator's scope: "Privacy: only owners and editors see or apply per-person proposals. Members never do."
--
-- Privacy design. `calibrations.results` and `calibrations.applied_keys` are read by EVERY member of the workspace, so per-person
-- proposals can't live there. They go to a new table, `public.capacity_factor_proposals`, which only owners, editors and agency
-- admins read (`can_see_people`). The calibration's `results` holds no person id, name or per-person number, and an applied factor
-- key in `applied_keys` is `factor:<proposal row id>`, an id members can't resolve, never `factor:<person>:<step>`.
--
-- What changes. STRICTLY ADDITIVE apart from four `create or replace`s with the same signatures, each a full copy of its latest
-- body plus marked `-- #227` lines (same settings and grants):
--   * Table `public.capacity_factor_proposals` (calibration_id, workspace_id, person_id, step_id, proposal jsonb, created_at,
--     created_by). RLS: select and insert through `can_see_people`; no update or delete for anyone (frozen, like `calibrations`);
--     authenticated holds SELECT and INSERT only, anon nothing. Trigger `needs_review` (an API token can't write). Not in Realtime.
--   * `private.calibration_payload_problem(text, jsonb, jsonb)`: one more kind, `capacity_factor` (a factor from 0.5 to 2).
--     Replaces the body of 20261208000000 (md5 d4da9751d6d050289a7dc5f07eb3c414); new md5 35670c65c2998138df67edcb691c1f33.
--   * `public.apply_calibration(uuid, text[])`: a `factor:` key's proposal is read from the new table, and a `capacity_factor`
--     branch writes `person_capacity_factors` live, as a person's edit, kept `measured` with the dataset and calibration (only while
--     Per-person times are switched on; compare-and-set on `before.factor`). Replaces the body of 20261208000000
--     (md5 28fcf1c8c13a5f2e4b4b9c5d7f3feadb); new md5 a0dee83e87244d89864d1e6534abaab4.
--   * `public.record_calibration_import(...)`: per-person proposals travel in `p_results.capacity_factors`; they are refused (42501)
--     for anyone who can't see people and (22023) when the switch is off, stored in the new table, and the call's keys are mapped
--     to `factor:<row id>` and back. Replaces the body of 20261216000000 (md5 f1a66685c4bbaeb3c212e5babeea9a6e); new md5 fe662ce28581be4541d5903507b1ed25.
--   * `public.team_capacity(uuid)`: each factor item gains `items`, how many visits a measured time rests on (null when entered).
--     Replaces the body of 20261223000000 (md5 a8dcb5d1bddaf549ecef591a3c1b5ae0); new md5 8beae978ee431f5f3e50d17c71c3c056.
-- Not touched: `save_fields`, `record_calibration`, `record_client_calibration`, the `calibrations` trigger, any policy or grant on
-- an existing table, `share_team_capacity`.
--
-- ORDER: after 20261223000000 (C6, row 67), 20261216000000 (C1, row 62), 20261208000000 (C2 part 2, row 57) and after row 71
-- (20261226000000). Independent of #230 (20261225000000) and #228 (20261226000000), which replace other functions; if this file
-- is applied before either, that one is renumbered above it. This is row 72 of docs/production-migrations.md.
-- APPLY BEFORE DEPLOYING THE APP: the page sends `capacity_factors`; the old `record_calibration_import` would store them in
-- `results`, which members read.
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time):
--   0. Rows 57, 62 and 67 are applied and nothing is at or past this one. Expect the three:
--        select version from supabase_migrations.schema_migrations where version in ('20261208000000', '20261216000000', '20261223000000') or version >= '20261227000000' order by 1;
--   1. The four bodies are as expected. Expect public.apply_calibration 28fcf1c8c13a5f2e4b4b9c5d7f3feadb,
--      private.calibration_payload_problem d4da9751d6d050289a7dc5f07eb3c414,
--      public.record_calibration_import f1a66685c4bbaeb3c212e5babeea9a6e and public.team_capacity a8dcb5d1bddaf549ecef591a3c1b5ae0:
--        select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;
--   2. Nothing created yet. Expect null:
--        select to_regclass('public.capacity_factor_proposals');
--   3. No calibration so far holds a person-level key (sanity). Expect 0:
--        select count(*) from public.calibrations where results ? 'capacity_factors' or exists (select 1 from unnest(applied_keys) k where k like 'factor:%');
--   4. For the log: workspaces with the switch on:
--        select slug from public.workspaces where settings -> 'capacity_factor_enabled' = 'true'::jsonb;
--
-- POST-APPLY CHECK:
--   1. RLS on and two policies (select and insert, both can_see_people). Expect t, 2, then the two quals:
--        select relrowsecurity from pg_class where oid = 'public.capacity_factor_proposals'::regclass;
--        select count(*) from pg_policies where schemaname = 'public' and tablename = 'capacity_factor_proposals';
--        select cmd, qual, with_check from pg_policies where tablename = 'capacity_factor_proposals' order by cmd;
--   2. authenticated holds only INSERT and SELECT, anon nothing. Expect two rows, no anon:
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public'
--          and table_name = 'capacity_factor_proposals' and grantee in ('anon', 'authenticated') order by 1, 2;
--   3. The trigger needs_review is on the table. Expect one row:
--        select tgname from pg_trigger where tgrelid = 'public.capacity_factor_proposals'::regclass and not tgisinternal order by 1;
--   4. The four functions: apply_calibration f, record_calibration_import f, calibration_payload_problem f, team_capacity t; all
--      {search_path=""}:
--        select n.nspname || '.' || p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;
--      and their new md5s: apply_calibration a0dee83e87244d89864d1e6534abaab4, calibration_payload_problem 35670c65c2998138df67edcb691c1f33,
--      record_calibration_import fe662ce28581be4541d5903507b1ed25, team_capacity 8beae978ee431f5f3e50d17c71c3c056:
--        select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;
--   5. anon can't execute the three public ones. Expect f, f, f:
--        select has_function_privilege('anon', 'public.apply_calibration(uuid, text[])', 'execute'),
--               has_function_privilege('anon', 'public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])', 'execute'),
--               has_function_privilege('anon', 'public.team_capacity(uuid)', 'execute');
--   6. Smoke test, ROLLED BACK, as the Northbeam owner: the factor list is empty.
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<user id>","role":"authenticated"}', true);
--        select public.team_capacity('<northbeam id>') -> 'person_capacity_factors';   -- []
--        rollback;
--   7. Live check (Austin): switch Per-person times on, read a time log with a person column on Historical data, match the people,
--      apply one per-person time. Settings -> People shows it "measured from N visits". A member sees no per-person part on
--      Historical data.
--
-- ROLLBACK (one transaction; the four functions go back to their previous bodies, written out in full below so it can be run as it
-- stands, and the table is dropped). Roll the app back first. Times already applied stay, measured; their `calibration_id` still
-- names the calibration, whose per-person proposals are gone:
--   begin;
--   drop table if exists public.capacity_factor_proposals;
--   -- private.calibration_payload_problem back to 20261208000000's body (md5 d4da9751d6d050289a7dc5f07eb3c414):
--   create or replace function private.calibration_payload_problem(kind text, setv jsonb, beforev jsonb) returns text
--   language plpgsql
--   immutable
--   set search_path = ''
--   as $$
--   declare
--     p text;
--     v jsonb;
--   begin
--     -- `before` holds what the value was: a number, or null when it had none.
--     if kind = 'arrivals' then
--       if (case when jsonb_typeof(setv -> 'volume_week') = 'number' then (setv ->> 'volume_week')::numeric < 0 else true end) then
--         return 'volume_week is not a number of leads';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> 'volume_week'), 'null') not in ('number', 'null') then
--         return 'the earlier volume_week is not a number';
--       end if;
--       return null;
--     end if;
--     if kind = 'rework' then
--       if (case when jsonb_typeof(setv -> 'rework_rate') = 'number' then (setv ->> 'rework_rate')::numeric not between 0 and 1 else true end) then
--         return 'rework_rate is not a share from 0 to 1';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> 'rework_rate'), 'null') not in ('number', 'null') then
--         return 'the earlier rework_rate is not a number';
--       end if;
--       return null;
--     end if;
--     if kind in ('work', 'wait') then
--       p := kind;
--       if (case when jsonb_typeof(setv -> (p || '_hours')) = 'number' then (setv ->> (p || '_hours'))::numeric < 0 else true end) then
--         return p || '_hours is not a number of hours';
--       end if;
--       if coalesce(jsonb_typeof(setv -> (p || '_dist')), '') <> 'string' or setv ->> (p || '_dist') not in ('constant', 'triangular', 'lognormal') then
--         return p || '_dist is not a distribution';
--       end if;
--       if coalesce(jsonb_typeof(setv -> (p || '_params')), '') <> 'object' then
--         return p || '_params is not an object';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> (p || '_hours')), 'null') not in ('number', 'null')
--          or coalesce(jsonb_typeof(beforev -> (p || '_params_cv')), 'null') not in ('number', 'null')
--          or coalesce(jsonb_typeof(beforev -> (p || '_dist')), 'null') not in ('string', 'null') then
--         return 'the earlier values are not numbers';
--       end if;
--       return null;
--     end if;
--     if kind = 'routing' then
--       if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
--         return 'probabilities is not an object';
--       end if;
--       for p, v in select e.key, e.value from jsonb_each(setv -> 'probabilities') e loop
--         if p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
--           return 'a way out is not an edge id';
--         end if;
--         if (case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric not between 0 and 1 else true end) then
--           return 'odds are not shares from 0 to 1';
--         end if;
--       end loop;
--       if coalesce(jsonb_typeof(beforev -> 'probabilities'), '') <> 'object' then
--         return 'the earlier odds are not an object';
--       end if;
--       for v in select e.value from jsonb_each(beforev -> 'probabilities') e loop
--         if jsonb_typeof(v) not in ('number', 'null') then
--           return 'the earlier odds are not numbers';
--         end if;
--       end loop;
--       return null;
--     end if;
--     -- C2 part 2: a client group's normal churn, back-solved from a clients file.
--     if kind = 'churn' then
--       if (case when jsonb_typeof(setv -> 'churn_monthly') = 'number' then (setv ->> 'churn_monthly')::numeric not between 0 and 1 else true end) then
--         return 'churn_monthly is not a share from 0 to 1';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> 'churn_monthly'), 'null') not in ('number', 'null') then
--         return 'the earlier churn_monthly is not a number';
--       end if;
--       return null;
--     end if;
--     return null;
--   end;
--   $$;
--   revoke all on function private.calibration_payload_problem(text, jsonb, jsonb) from public, anon;
--   grant execute on function private.calibration_payload_problem(text, jsonb, jsonb) to authenticated;
--   -- public.apply_calibration back to 20261208000000's body (md5 28fcf1c8c13a5f2e4b4b9c5d7f3feadb):
--   create or replace function public.apply_calibration(p_calibration uuid, p_keys text[]) returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     cal public.calibrations;
--     k text;
--     prop jsonb;
--     pkind text;
--     target_id uuid;
--     setv jsonb;
--     beforev jsonb;
--     opened jsonb := null;
--     draft_id uuid := null;
--     st public.steps;
--     ls public.lead_sources;
--     cg public.client_groups; -- C2 part 2
--     cols text[];
--     col text;
--     prov jsonb;
--     entry jsonb;
--     newprov jsonb;
--     stamp jsonb;
--     had_assumption boolean;
--     left_assumption boolean;
--     had_conflict boolean;
--     left_conflict boolean;
--     edge_ids uuid[];
--     matches boolean;
--     keys text[];
--     problem text;
--     done text[] := '{}';
--     results jsonb := '[]';
--   begin
--     if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
--       raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
--     end if;
--     if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 2000 then
--       raise exception 'Give between 1 and 2000 proposals' using errcode = '22023';
--     end if;
--   
--     -- RLS: a calibration the user can't update (not an editor of its workspace) is not found.
--     select * into cal from public.calibrations c where c.id = p_calibration for update;
--     if cal.id is null then
--       return jsonb_build_object('status', 'not_found');
--     end if;
--   
--     stamp := jsonb_build_object('source', 'measured', 'at', now(), 'dataset_id', cal.dataset_id, 'calibration_id', cal.id)
--       || case when auth.uid() is null then '{}'::jsonb else jsonb_build_object('by', auth.uid()) end;
--   
--     keys := array(select distinct x from unnest(p_keys) x where x is not null order by x);
--     foreach k in array keys loop
--       select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
--       if prop is null or coalesce(jsonb_typeof(prop -> 'set'), '') <> 'object' or coalesce(jsonb_typeof(prop -> 'before'), '') <> 'object' then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--         continue;
--       end if;
--       if k = any (cal.applied_keys) then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'already_applied'));
--         continue;
--       end if;
--       pkind := coalesce(prop ->> 'kind', '');
--       setv := prop -> 'set';
--       beforev := prop -> 'before';
--       begin
--         target_id := (prop -> 'target' ->> 'id')::uuid;
--       exception when others then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--         continue;
--       end;
--       -- Values that aren't what this kind needs are skipped with why, never cast (and so never abort the call).
--       problem := private.calibration_payload_problem(pkind, setv, beforev);
--       if problem is not null then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'invalid', 'reason', problem));
--         continue;
--       end if;
--   
--       -- A lead source's leads a week: live, as a person's edit to demand.
--       if pkind = 'arrivals' and prop -> 'target' ->> 'table' = 'lead_sources' then
--         select * into ls from public.lead_sources l where l.id = target_id and l.workspace_id = cal.workspace_id for update;
--         if ls.id is null then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--           continue;
--         end if;
--         if ls.volume_week is distinct from (beforev ->> 'volume_week')::numeric then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--           continue;
--         end if;
--         entry := stamp || jsonb_build_object('n', prop -> 'n');
--         if jsonb_typeof(ls.provenance -> 'volume_week' -> 'evidence') = 'array' then
--           entry := entry || jsonb_build_object('evidence', ls.provenance -> 'volume_week' -> 'evidence');
--         end if;
--         update public.lead_sources l
--         set volume_week = (setv ->> 'volume_week')::numeric,
--             provenance = l.provenance || jsonb_build_object('volume_week', entry)
--         where l.id = ls.id;
--         done := done || k;
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--         continue;
--       end if;
--   
--       -- C2 part 2: a client group's normal churn, back-solved from a clients file: live, as a person's edit to the group.
--       -- Provenance is set in the same statement, so the stamp_provenance trigger keeps it `measured` (it stamps `entered` only
--       -- when the column changes and its provenance entry doesn't).
--       if pkind = 'churn' and prop -> 'target' ->> 'table' = 'client_groups' then
--         select * into cg from public.client_groups g where g.id = target_id and g.workspace_id = cal.workspace_id for update;
--         if cg.id is null then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--           continue;
--         end if;
--         if cg.churn_monthly is distinct from (beforev ->> 'churn_monthly')::numeric then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--           continue;
--         end if;
--         entry := stamp || jsonb_strip_nulls(jsonb_build_object(
--           'n', prop -> 'n',
--           'leavers', case when jsonb_typeof(prop -> 'leavers') = 'number' then prop -> 'leavers' end,
--           'measured', case when jsonb_typeof(prop -> 'measured') = 'number' then prop -> 'measured' end,
--           'multiplier', case when jsonb_typeof(prop -> 'multiplier') = 'number' then prop -> 'multiplier' end));
--         if jsonb_typeof(cg.provenance -> 'churn_monthly' -> 'evidence') = 'array' then
--           entry := entry || jsonb_build_object('evidence', cg.provenance -> 'churn_monthly' -> 'evidence');
--         end if;
--         update public.client_groups g
--         set churn_monthly = (setv ->> 'churn_monthly')::numeric,
--             provenance = g.provenance || jsonb_build_object('churn_monthly', entry)
--         where g.id = cg.id;
--         done := done || k;
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--         continue;
--       end if;
--   
--       if pkind not in ('work', 'wait', 'rework', 'routing') or coalesce(prop -> 'target' ->> 'table', '') <> 'steps' or cal.process_id is null then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--         continue;
--       end if;
--   
--       -- A step's values go into the process's draft, opened from live if there is none.
--       if draft_id is null then
--         opened := public.open_draft(cal.process_id);
--         if opened ->> 'status' <> 'ok' then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--           opened := null;
--           continue;
--         end if;
--         draft_id := (opened ->> 'revision_id')::uuid;
--       end if;
--   
--       select * into st from public.steps s where s.revision_id = draft_id and s.id = target_id for update;
--       if st.id is null or cardinality(st.replaced_by) > 0 then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--         continue;
--       end if;
--       prov := case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end;
--   
--       if pkind = 'routing' then
--         -- The ways out must be the ones measured, each still at the odds it had.
--         if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--           continue;
--         end if;
--         select array_agg(x::uuid order by x) into edge_ids from jsonb_object_keys(setv -> 'probabilities') x;
--         select coalesce(bool_and(e.probability is not distinct from (beforev -> 'probabilities' ->> e.id::text)::numeric), false)
--           and count(*) = coalesce(cardinality(edge_ids), 0)
--           and coalesce(bool_and(e.id = any (edge_ids)), false)
--           into matches
--         from public.edges e where e.revision_id = draft_id and e.from_step_id = st.id;
--         if not coalesce(matches, false) then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--           continue;
--         end if;
--         update public.edges e set probability = (setv -> 'probabilities' ->> e.id::text)::numeric
--         where e.revision_id = draft_id and e.from_step_id = st.id;
--         -- Edges carry no provenance: the step records what was measured, so a later edit to the odds shows as no longer measured.
--         -- Odds an upload left out (`branch_odds`) are filled in now.
--         update public.steps s
--         set provenance = (prov - 'branch_odds') || jsonb_build_object('routing', stamp || jsonb_build_object('n', prop -> 'n', 'probabilities', setv -> 'probabilities'))
--         where s.revision_id = draft_id and s.id = st.id;
--         done := done || k;
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--         continue;
--       end if;
--   
--       if pkind = 'rework' then
--         matches := st.rework_rate is not distinct from (beforev ->> 'rework_rate')::numeric;
--         cols := array['rework_rate'];
--       elsif pkind = 'work' then
--         matches := st.work_hours is not distinct from (beforev ->> 'work_hours')::numeric
--           and st.work_dist is not distinct from (beforev ->> 'work_dist')
--           and (case when jsonb_typeof(st.work_params -> 'cv') = 'number' then (st.work_params ->> 'cv')::numeric end)
--             is not distinct from (beforev ->> 'work_params_cv')::numeric;
--         cols := array['work_hours', 'work_dist', 'work_params'];
--       else
--         matches := st.wait_hours is not distinct from (beforev ->> 'wait_hours')::numeric
--           and st.wait_dist is not distinct from (beforev ->> 'wait_dist')
--           and (case when jsonb_typeof(st.wait_params -> 'cv') = 'number' then (st.wait_params ->> 'cv')::numeric end)
--             is not distinct from (beforev ->> 'wait_params_cv')::numeric;
--         cols := array['wait_hours', 'wait_dist', 'wait_params'];
--       end if;
--       if not coalesce(matches, false) then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--         continue;
--       end if;
--   
--       -- Each value's entry: measured, keeping the evidence it cited, and a conflict it had marked settled by the measurement.
--       newprov := prov;
--       foreach col in array cols loop
--         entry := stamp || jsonb_build_object('n', prop -> 'n');
--         if jsonb_typeof(prov -> col -> 'evidence') = 'array' then
--           entry := entry || jsonb_build_object('evidence', prov -> col -> 'evidence');
--         end if;
--         if jsonb_typeof(prov -> col -> 'conflict') = 'object' then
--           entry := entry || jsonb_build_object('conflict', case
--             when coalesce(prov -> col -> 'conflict' -> 'resolved', 'null') <> 'null' then prov -> col -> 'conflict'
--             else (prov -> col -> 'conflict') || jsonb_build_object('resolved', jsonb_build_object('at', now(), 'choice', 'measured')) end);
--         end if;
--         newprov := newprov || jsonb_build_object(col, entry);
--       end loop;
--   
--       -- The step's flags follow, as when a person types the values: settled here, and none left open elsewhere.
--       had_assumption := exists (select 1 from unnest(cols) c where (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
--       left_assumption := exists (select 1 from unnest(array['work_hours', 'wait_hours', 'rework_rate', 'current_wip', 'sla_hours']) c
--         where c <> all (cols) and (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
--       had_conflict := private.has_open_conflict(prov) and not private.has_open_conflict(newprov);
--       left_conflict := private.has_open_conflict(newprov);
--   
--       update public.steps s
--       set work_hours = case when pkind = 'work' then (setv ->> 'work_hours')::numeric else s.work_hours end,
--           work_dist = case when pkind = 'work' then setv ->> 'work_dist' else s.work_dist end,
--           work_params = case when pkind = 'work' then s.work_params || (setv -> 'work_params') else s.work_params end,
--           wait_hours = case when pkind = 'wait' then (setv ->> 'wait_hours')::numeric else s.wait_hours end,
--           wait_dist = case when pkind = 'wait' then setv ->> 'wait_dist' else s.wait_dist end,
--           wait_params = case when pkind = 'wait' then s.wait_params || (setv -> 'wait_params') else s.wait_params end,
--           rework_rate = case when pkind = 'rework' then (setv ->> 'rework_rate')::numeric else s.rework_rate end,
--           provenance = newprov,
--           assumption = s.assumption and not (had_assumption and not left_assumption),
--           conflict = s.conflict and not (had_conflict and not left_conflict)
--       where s.revision_id = draft_id and s.id = st.id;
--       done := done || k;
--       results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--     end loop;
--   
--     if cardinality(done) > 0 then
--       -- The trigger sets applied, applied_at and applied_by, and accepts the keys only while this flag is on.
--       perform set_config('transpera.applying_calibration', 'on', true);
--       update public.calibrations c set applied_keys = c.applied_keys || done where c.id = cal.id;
--       perform set_config('transpera.applying_calibration', 'off', true);
--     end if;
--   
--     return jsonb_build_object(
--       'status', 'ok',
--       'draft', case when opened is null then null else jsonb_build_object(
--         'revision_id', opened -> 'revision_id', 'number', opened -> 'number', 'created', opened -> 'created') end,
--       'results', results);
--   end;
--   $$;
--   revoke all on function public.apply_calibration(uuid, text[]) from public, anon, authenticated;
--   grant execute on function public.apply_calibration(uuid, text[]) to authenticated;
--   -- public.record_calibration_import back to 20261216000000's body (md5 f1a66685c4bbaeb3c212e5babeea9a6e):
--   create or replace function public.record_calibration_import(
--     p_workspace uuid,
--     p_process uuid,
--     p_kind text,
--     p_file_name text,
--     p_column_map jsonb,
--     p_row_count integer,
--     p_details jsonb,
--     p_results jsonb,
--     p_keys text[]
--   ) returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     ds uuid;
--     cal uuid;
--     out jsonb;
--   begin
--     if p_kind is null or p_kind not in ('step_log', 'deals', 'time_logs') then
--       raise exception 'That kind of file isn''t calibrated against a process' using errcode = '22023';
--     end if;
--     -- Row-level security refuses a viewer's or a stranger's insert; apply_calibration refuses an API token. Either way
--     -- the whole call rolls back, records included.
--     insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count, details)
--     values (
--       p_workspace,
--       p_kind,
--       p_process,
--       p_file_name,
--       coalesce(p_column_map, '{}'),
--       p_row_count,
--       coalesce(case when jsonb_typeof(p_details) = 'object' then p_details end, '{}'))
--     returning id into ds;
--     insert into public.calibrations (workspace_id, dataset_id, process_id, results)
--     values (p_workspace, ds, p_process, p_results)
--     returning id into cal;
--     out := public.apply_calibration(cal, p_keys);
--     return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
--   end;
--   $$;
--   revoke all on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) from public, anon, authenticated;
--   grant execute on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) to authenticated;
--   -- public.team_capacity back to 20261223000000's body (md5 a8dcb5d1bddaf549ecef591a3c1b5ae0):
--   create or replace function public.team_capacity(ws uuid) returns jsonb
--   language plpgsql stable security definer
--   set search_path = ''
--   as $$
--   declare
--     everyone boolean;
--     own uuid;
--     result jsonb;
--   begin
--     if ws is null or not public.can_read_workspace(ws) then
--       raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
--     end if;
--     everyone := public.can_see_people(ws);
--     own := public.my_person_id(ws);
--   
--     with p as (
--       select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
--              pe.end_date, pe.provenance,
--              row_number() over (order by pe.created_at, pe.id) as n
--       from public.people pe where pe.workspace_id = ws
--     ),
--     shown as (
--       select p.*,
--         case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
--         -- No pay for anyone but the caller's own person (and those who see everyone).
--         case when everyone or p.id = own then p.cost_rate end as shown_rate
--       from p
--     )
--     select jsonb_build_object(
--       'sees_everyone', everyone,
--       'own_person_id', own,
--       'people', coalesce((select jsonb_agg(jsonb_build_object(
--           'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
--           'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
--           'start_date', s.start_date, 'end_date', s.end_date,
--           'provenance', case when everyone then s.provenance else '{}'::jsonb end)
--         order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
--       'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
--           'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
--         from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
--       'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
--           'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
--         from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
--       'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
--           'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
--           order by l.person_id, l.start_date, l.id)
--         from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
--       'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
--           'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
--         from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb),
--       -- C6: per-person times. Everyone's for those who see everyone; only the caller's own person's otherwise (none when
--       -- unlinked). Never provenance (it holds who entered it); `source` says entered or measured.
--       'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
--           'workspace_id', f.workspace_id, 'factor', f.factor,
--           'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'))
--           order by f.person_id, f.step_id nulls first)
--         from public.person_capacity_factors f
--         where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
--     ) into result;
--     return result;
--   end;
--   $$;
--   revoke execute on function public.team_capacity(uuid) from public, anon;
--   grant execute on function public.team_capacity(uuid) to authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261227000000';
--   commit;

-- ---------------------------------------------------------------------------
-- 1. The table: per-person proposals, read by owners, editors and agency admins only
-- ---------------------------------------------------------------------------

create table public.capacity_factor_proposals (
  id uuid primary key default gen_random_uuid(),
  calibration_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  person_id uuid not null,
  -- Step ids are stable across a process's versions (as person_capacity_factors.step_id); no foreign key.
  step_id uuid not null,
  -- The proposal as computed (PersonTimeProposal): current, proposed, sample sizes, note. Frozen once written.
  proposal jsonb not null constraint capacity_factor_proposals_proposal check (
    jsonb_typeof(proposal) = 'object' and proposal ->> 'kind' = 'capacity_factor'
    and proposal -> 'target' ->> 'table' = 'person_capacity_factors'
    and proposal -> 'target' ->> 'id' = person_id::text and proposal -> 'target' ->> 'step_id' = step_id::text
    and octet_length(proposal::text) <= 10000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (calibration_id, person_id, step_id),
  foreign key (calibration_id, workspace_id) references public.calibrations (id, workspace_id) on delete cascade,
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);
create index on public.capacity_factor_proposals (workspace_id);

-- The MCP server (an API token) can't write them, as for the company model.
create trigger needs_review before insert on public.capacity_factor_proposals
  for each row execute function private.company_needs_review();

alter table public.capacity_factor_proposals enable row level security;
-- Per-person data: owners, editors and agency admins only. Never members or viewers, not even their own (#227).
create policy "read capacity_factor_proposals" on public.capacity_factor_proposals for select to authenticated
  using (public.can_see_people(workspace_id));
create policy "insert capacity_factor_proposals" on public.capacity_factor_proposals for insert to authenticated
  with check (public.can_see_people(workspace_id));
revoke all on public.capacity_factor_proposals from anon, authenticated;
grant select, insert on public.capacity_factor_proposals to authenticated;

-- ---------------------------------------------------------------------------
-- 2. private.calibration_payload_problem: a full copy of 20261208000000 plus the capacity_factor kind (marked #227)
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
  -- #227: a person's time on a step, a multiple of the step's normal time, within what person_capacity_factors allows.
  if kind = 'capacity_factor' then
    if (case when jsonb_typeof(setv -> 'factor') = 'number' then (setv ->> 'factor')::numeric not between 0.5 and 2 else true end) then
      return 'factor is not a per-person time from 0.5 to 2';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'factor'), 'null') not in ('number', 'null') then
      return 'the earlier factor is not a number';
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
-- 3. apply_calibration: a full copy of 20261208000000 plus a lookup hunk and a capacity_factor branch (marked #227)
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
  pcf public.person_capacity_factors; -- #227
  step_ref uuid; -- #227
  raced boolean; -- #227
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
    -- #227: a per-person proposal is kept apart, where only owners, editors and agency admins read it; its key is its row id.
    if k like 'factor:%' then
      select f.proposal into prop from public.capacity_factor_proposals f where f.calibration_id = cal.id and 'factor:' || f.id::text = k;
    else
      select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
    end if;
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

    -- #227: a person's time on a step, measured from a log that names people: live, as a person's edit, kept `measured`
    -- (provenance set in the same statement, so stamp_provenance keeps it). Only while Per-person times are switched on.
    if pkind = 'capacity_factor' and prop -> 'target' ->> 'table' = 'person_capacity_factors' then
      begin
        step_ref := (prop -> 'target' ->> 'step_id')::uuid;
      exception when others then
        step_ref := null;
      end;
      if step_ref is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
        continue;
      end if;
      if not exists (select 1 from public.workspaces w where w.id = cal.workspace_id and w.settings -> 'capacity_factor_enabled' = 'true'::jsonb) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'switched_off'));
        continue;
      end if;
      if not exists (select 1 from public.people pe where pe.id = target_id and pe.workspace_id = cal.workspace_id)
         or not exists (select 1 from public.steps s where s.id = step_ref and s.workspace_id = cal.workspace_id) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      select * into pcf from public.person_capacity_factors f where f.person_id = target_id and f.step_id = step_ref for update;
      if pcf.factor is distinct from (beforev ->> 'factor')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      raced := false;
      if pcf.person_id is null then
        begin
          insert into public.person_capacity_factors (person_id, workspace_id, step_id, factor, provenance)
          values (target_id, cal.workspace_id, step_ref, (setv ->> 'factor')::numeric, jsonb_build_object('factor', entry));
        exception when unique_violation then
          raced := true;
        end;
      else
        update public.person_capacity_factors f
        set factor = (setv ->> 'factor')::numeric, provenance = f.provenance || jsonb_build_object('factor', entry)
        where f.person_id = target_id and f.step_id = step_ref;
      end if;
      if raced then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
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
-- 4. record_calibration_import: a full copy of 20261216000000 plus the per-person proposals (marked #227)
-- ---------------------------------------------------------------------------

create or replace function public.record_calibration_import(
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
  -- #227: per-person proposals travel in p_results.capacity_factors and are kept apart from the calibration's results,
  -- which everyone in the workspace reads.
  factors jsonb := case when jsonb_typeof(p_results -> 'capacity_factors') = 'array' then p_results -> 'capacity_factors' else '[]'::jsonb end;
  keys text[]; -- #227
begin
  if p_kind is null or p_kind not in ('step_log', 'deals', 'time_logs') then
    raise exception 'That kind of file isn''t calibrated against a process' using errcode = '22023';
  end if;
  -- #227: only owners, editors and agency admins, only with Per-person times switched on (#41 decision 4).
  if jsonb_array_length(factors) > 0 then
    if not coalesce(public.can_see_people(p_workspace), false) then
      raise exception 'Only owners and editors can apply per-person times' using errcode = '42501';
    end if;
    if jsonb_array_length(factors) > 2000 then
      raise exception 'Give at most 2000 per-person times' using errcode = '22023';
    end if;
    if not exists (select 1 from public.workspaces w where w.id = p_workspace and w.settings -> 'capacity_factor_enabled' = 'true'::jsonb) then
      raise exception 'Per-person times are switched off in this workspace' using errcode = '22023';
    end if;
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
  values (p_workspace, ds, p_process, p_results - 'capacity_factors') -- #227: never per-person data in what members read
  returning id into cal;
  -- #227: each per-person proposal where only owners, editors and agency admins read it; a ticked `factor:<person>:<step>` becomes
  -- `factor:<its row id>`, so the calibration's applied keys (which members read) name no person.
  insert into public.capacity_factor_proposals (calibration_id, workspace_id, person_id, step_id, proposal)
  select cal, p_workspace, (f.value -> 'target' ->> 'id')::uuid, (f.value -> 'target' ->> 'step_id')::uuid, f.value
  from jsonb_array_elements(factors) f;
  keys := array(
    select coalesce((select 'factor:' || x.id::text from public.capacity_factor_proposals x
                     where x.calibration_id = cal and u.k = 'factor:' || x.person_id::text || ':' || x.step_id::text), u.k)
    from unnest(p_keys) with ordinality u(k, o) order by u.o);
  out := public.apply_calibration(cal, keys);
  -- #227: and back to the page's own keys.
  if out ? 'results' then
    out := out || jsonb_build_object('results', coalesce((
      select jsonb_agg(case when x.id is null then r.value
                            else r.value || jsonb_build_object('key', 'factor:' || x.person_id::text || ':' || x.step_id::text) end order by r.o)
      from jsonb_array_elements(out -> 'results') with ordinality r(value, o)
      left join public.capacity_factor_proposals x on x.calibration_id = cal and r.value ->> 'key' = 'factor:' || x.id::text), '[]'::jsonb));
  end if;
  return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
end;
$$;

revoke all on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. team_capacity: a full copy of 20261223000000 plus `items` on each factor (marked #227)
-- ---------------------------------------------------------------------------

create or replace function public.team_capacity(ws uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  everyone boolean;
  own uuid;
  result jsonb;
begin
  if ws is null or not public.can_read_workspace(ws) then
    raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
  end if;
  everyone := public.can_see_people(ws);
  own := public.my_person_id(ws);

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
           pe.end_date, pe.provenance,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  shown as (
    select p.*,
      case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
      -- No pay for anyone but the caller's own person (and those who see everyone).
      case when everyone or p.id = own then p.cost_rate end as shown_rate
    from p
  )
  select jsonb_build_object(
    'sees_everyone', everyone,
    'own_person_id', own,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
        'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
        'start_date', s.start_date, 'end_date', s.end_date,
        'provenance', case when everyone then s.provenance else '{}'::jsonb end)
      order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
    'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
        'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
      from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
    'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
        'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
      from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
    'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
        'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
        order by l.person_id, l.start_date, l.id)
      from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
    'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
        'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb),
    -- C6: per-person times. Everyone's for those who see everyone; only the caller's own person's otherwise (none when
    -- unlinked). Never provenance (it holds who entered it); `source` says entered or measured.
    'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
        'workspace_id', f.workspace_id, 'factor', f.factor,
        'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'),
        -- #227: how many visits a measured time rests on (PRD §6.3.7 shows a measured time only from 10); null when entered.
        'items', case when f.provenance -> 'factor' ->> 'source' = 'measured' and jsonb_typeof(f.provenance -> 'factor' -> 'n') = 'number'
          then round((f.provenance -> 'factor' ->> 'n')::numeric)::int end)
        order by f.person_id, f.step_id nulls first)
      from public.person_capacity_factors f
      where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke execute on function public.team_capacity(uuid) from public, anon;
grant execute on function public.team_capacity(uuid) to authenticated;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261227000000', 'calibrate_capacity_factors', array[$mig$-- Per-person times, measured (issue #227, C6 follow-up; docs/plans/c6-227-brief.md).
--
-- A stage history (step log) or a time log can name who did each visit. For owners, editors and agency admins, with Per-person
-- times switched on, calibration then measures each person's hands-on time on each step against that step's normal time and
-- proposes a per-person time (a factor, 0.5 to 2) with its sample size, from 10 visits (PRD section 6.3.7). The person ticks what
-- to apply; the same Apply button and the same record-and-apply call write it, as a `measured` value linked to the dataset and
-- the calibration. Members and viewers never see a per-person proposal, and nothing is ranked or put side by side (PRD D20).
--
-- Decisions (verbatim, from the brief):
--   Austin, 6 Oct (#41 decision 4): "Per-person times: calibration proposes capacity factors only when the workspace has per-person
--     times switched on."
--   #227: "Then calibration can propose a time per person-step as a suggestion, with provenance.factor.source = 'measured', and
--     personFactors can set measuredItems. Never ranked or compared across people."
--   PRD D20: "Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only
--     when measured, visible to the person, never ranked; no role-median benchmark."
--   Orchestrator's scope: "Privacy: only owners and editors see or apply per-person proposals. Members never do."
--
-- Privacy design. `calibrations.results` and `calibrations.applied_keys` are read by EVERY member of the workspace, so per-person
-- proposals can't live there. They go to a new table, `public.capacity_factor_proposals`, which only owners, editors and agency
-- admins read (`can_see_people`). The calibration's `results` holds no person id, name or per-person number, and an applied factor
-- key in `applied_keys` is `factor:<proposal row id>`, an id members can't resolve, never `factor:<person>:<step>`.
--
-- What changes. STRICTLY ADDITIVE apart from four `create or replace`s with the same signatures, each a full copy of its latest
-- body plus marked `-- #227` lines (same settings and grants):
--   * Table `public.capacity_factor_proposals` (calibration_id, workspace_id, person_id, step_id, proposal jsonb, created_at,
--     created_by). RLS: select and insert through `can_see_people`; no update or delete for anyone (frozen, like `calibrations`);
--     authenticated holds SELECT and INSERT only, anon nothing. Trigger `needs_review` (an API token can't write). Not in Realtime.
--   * `private.calibration_payload_problem(text, jsonb, jsonb)`: one more kind, `capacity_factor` (a factor from 0.5 to 2).
--     Replaces the body of 20261208000000 (md5 d4da9751d6d050289a7dc5f07eb3c414); new md5 35670c65c2998138df67edcb691c1f33.
--   * `public.apply_calibration(uuid, text[])`: a `factor:` key's proposal is read from the new table, and a `capacity_factor`
--     branch writes `person_capacity_factors` live, as a person's edit, kept `measured` with the dataset and calibration (only while
--     Per-person times are switched on; compare-and-set on `before.factor`). Replaces the body of 20261208000000
--     (md5 28fcf1c8c13a5f2e4b4b9c5d7f3feadb); new md5 a0dee83e87244d89864d1e6534abaab4.
--   * `public.record_calibration_import(...)`: per-person proposals travel in `p_results.capacity_factors`; they are refused (42501)
--     for anyone who can't see people and (22023) when the switch is off, stored in the new table, and the call's keys are mapped
--     to `factor:<row id>` and back. Replaces the body of 20261216000000 (md5 f1a66685c4bbaeb3c212e5babeea9a6e); new md5 fe662ce28581be4541d5903507b1ed25.
--   * `public.team_capacity(uuid)`: each factor item gains `items`, how many visits a measured time rests on (null when entered).
--     Replaces the body of 20261223000000 (md5 a8dcb5d1bddaf549ecef591a3c1b5ae0); new md5 8beae978ee431f5f3e50d17c71c3c056.
-- Not touched: `save_fields`, `record_calibration`, `record_client_calibration`, the `calibrations` trigger, any policy or grant on
-- an existing table, `share_team_capacity`.
--
-- ORDER: after 20261223000000 (C6, row 67), 20261216000000 (C1, row 62), 20261208000000 (C2 part 2, row 57) and after row 71
-- (20261226000000). Independent of #230 (20261225000000) and #228 (20261226000000), which replace other functions; if this file
-- is applied before either, that one is renumbered above it. This is row 72 of docs/production-migrations.md.
-- APPLY BEFORE DEPLOYING THE APP: the page sends `capacity_factors`; the old `record_calibration_import` would store them in
-- `results`, which members read.
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time):
--   0. Rows 57, 62 and 67 are applied and nothing is at or past this one. Expect the three:
--        select version from supabase_migrations.schema_migrations where version in ('20261208000000', '20261216000000', '20261223000000') or version >= '20261227000000' order by 1;
--   1. The four bodies are as expected. Expect public.apply_calibration 28fcf1c8c13a5f2e4b4b9c5d7f3feadb,
--      private.calibration_payload_problem d4da9751d6d050289a7dc5f07eb3c414,
--      public.record_calibration_import f1a66685c4bbaeb3c212e5babeea9a6e and public.team_capacity a8dcb5d1bddaf549ecef591a3c1b5ae0:
--        select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;
--   2. Nothing created yet. Expect null:
--        select to_regclass('public.capacity_factor_proposals');
--   3. No calibration so far holds a person-level key (sanity). Expect 0:
--        select count(*) from public.calibrations where results ? 'capacity_factors' or exists (select 1 from unnest(applied_keys) k where k like 'factor:%');
--   4. For the log: workspaces with the switch on:
--        select slug from public.workspaces where settings -> 'capacity_factor_enabled' = 'true'::jsonb;
--
-- POST-APPLY CHECK:
--   1. RLS on and two policies (select and insert, both can_see_people). Expect t, 2, then the two quals:
--        select relrowsecurity from pg_class where oid = 'public.capacity_factor_proposals'::regclass;
--        select count(*) from pg_policies where schemaname = 'public' and tablename = 'capacity_factor_proposals';
--        select cmd, qual, with_check from pg_policies where tablename = 'capacity_factor_proposals' order by cmd;
--   2. authenticated holds only INSERT and SELECT, anon nothing. Expect two rows, no anon:
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public'
--          and table_name = 'capacity_factor_proposals' and grantee in ('anon', 'authenticated') order by 1, 2;
--   3. The trigger needs_review is on the table. Expect one row:
--        select tgname from pg_trigger where tgrelid = 'public.capacity_factor_proposals'::regclass and not tgisinternal order by 1;
--   4. The four functions: apply_calibration f, record_calibration_import f, calibration_payload_problem f, team_capacity t; all
--      {search_path=""}:
--        select n.nspname || '.' || p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;
--      and their new md5s: apply_calibration a0dee83e87244d89864d1e6534abaab4, calibration_payload_problem 35670c65c2998138df67edcb691c1f33,
--      record_calibration_import fe662ce28581be4541d5903507b1ed25, team_capacity 8beae978ee431f5f3e50d17c71c3c056:
--        select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;
--   5. anon can't execute the three public ones. Expect f, f, f:
--        select has_function_privilege('anon', 'public.apply_calibration(uuid, text[])', 'execute'),
--               has_function_privilege('anon', 'public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])', 'execute'),
--               has_function_privilege('anon', 'public.team_capacity(uuid)', 'execute');
--   6. Smoke test, ROLLED BACK, as the Northbeam owner: the factor list is empty.
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<user id>","role":"authenticated"}', true);
--        select public.team_capacity('<northbeam id>') -> 'person_capacity_factors';   -- []
--        rollback;
--   7. Live check (Austin): switch Per-person times on, read a time log with a person column on Historical data, match the people,
--      apply one per-person time. Settings -> People shows it "measured from N visits". A member sees no per-person part on
--      Historical data.
--
-- ROLLBACK (one transaction; the four functions go back to their previous bodies, written out in full below so it can be run as it
-- stands, and the table is dropped). Roll the app back first. Times already applied stay, measured; their `calibration_id` still
-- names the calibration, whose per-person proposals are gone:
--   begin;
--   drop table if exists public.capacity_factor_proposals;
--   -- private.calibration_payload_problem back to 20261208000000's body (md5 d4da9751d6d050289a7dc5f07eb3c414):
--   create or replace function private.calibration_payload_problem(kind text, setv jsonb, beforev jsonb) returns text
--   language plpgsql
--   immutable
--   set search_path = ''
--   as $$
--   declare
--     p text;
--     v jsonb;
--   begin
--     -- `before` holds what the value was: a number, or null when it had none.
--     if kind = 'arrivals' then
--       if (case when jsonb_typeof(setv -> 'volume_week') = 'number' then (setv ->> 'volume_week')::numeric < 0 else true end) then
--         return 'volume_week is not a number of leads';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> 'volume_week'), 'null') not in ('number', 'null') then
--         return 'the earlier volume_week is not a number';
--       end if;
--       return null;
--     end if;
--     if kind = 'rework' then
--       if (case when jsonb_typeof(setv -> 'rework_rate') = 'number' then (setv ->> 'rework_rate')::numeric not between 0 and 1 else true end) then
--         return 'rework_rate is not a share from 0 to 1';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> 'rework_rate'), 'null') not in ('number', 'null') then
--         return 'the earlier rework_rate is not a number';
--       end if;
--       return null;
--     end if;
--     if kind in ('work', 'wait') then
--       p := kind;
--       if (case when jsonb_typeof(setv -> (p || '_hours')) = 'number' then (setv ->> (p || '_hours'))::numeric < 0 else true end) then
--         return p || '_hours is not a number of hours';
--       end if;
--       if coalesce(jsonb_typeof(setv -> (p || '_dist')), '') <> 'string' or setv ->> (p || '_dist') not in ('constant', 'triangular', 'lognormal') then
--         return p || '_dist is not a distribution';
--       end if;
--       if coalesce(jsonb_typeof(setv -> (p || '_params')), '') <> 'object' then
--         return p || '_params is not an object';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> (p || '_hours')), 'null') not in ('number', 'null')
--          or coalesce(jsonb_typeof(beforev -> (p || '_params_cv')), 'null') not in ('number', 'null')
--          or coalesce(jsonb_typeof(beforev -> (p || '_dist')), 'null') not in ('string', 'null') then
--         return 'the earlier values are not numbers';
--       end if;
--       return null;
--     end if;
--     if kind = 'routing' then
--       if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
--         return 'probabilities is not an object';
--       end if;
--       for p, v in select e.key, e.value from jsonb_each(setv -> 'probabilities') e loop
--         if p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
--           return 'a way out is not an edge id';
--         end if;
--         if (case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric not between 0 and 1 else true end) then
--           return 'odds are not shares from 0 to 1';
--         end if;
--       end loop;
--       if coalesce(jsonb_typeof(beforev -> 'probabilities'), '') <> 'object' then
--         return 'the earlier odds are not an object';
--       end if;
--       for v in select e.value from jsonb_each(beforev -> 'probabilities') e loop
--         if jsonb_typeof(v) not in ('number', 'null') then
--           return 'the earlier odds are not numbers';
--         end if;
--       end loop;
--       return null;
--     end if;
--     -- C2 part 2: a client group's normal churn, back-solved from a clients file.
--     if kind = 'churn' then
--       if (case when jsonb_typeof(setv -> 'churn_monthly') = 'number' then (setv ->> 'churn_monthly')::numeric not between 0 and 1 else true end) then
--         return 'churn_monthly is not a share from 0 to 1';
--       end if;
--       if coalesce(jsonb_typeof(beforev -> 'churn_monthly'), 'null') not in ('number', 'null') then
--         return 'the earlier churn_monthly is not a number';
--       end if;
--       return null;
--     end if;
--     return null;
--   end;
--   $$;
--   revoke all on function private.calibration_payload_problem(text, jsonb, jsonb) from public, anon;
--   grant execute on function private.calibration_payload_problem(text, jsonb, jsonb) to authenticated;
--   -- public.apply_calibration back to 20261208000000's body (md5 28fcf1c8c13a5f2e4b4b9c5d7f3feadb):
--   create or replace function public.apply_calibration(p_calibration uuid, p_keys text[]) returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     cal public.calibrations;
--     k text;
--     prop jsonb;
--     pkind text;
--     target_id uuid;
--     setv jsonb;
--     beforev jsonb;
--     opened jsonb := null;
--     draft_id uuid := null;
--     st public.steps;
--     ls public.lead_sources;
--     cg public.client_groups; -- C2 part 2
--     cols text[];
--     col text;
--     prov jsonb;
--     entry jsonb;
--     newprov jsonb;
--     stamp jsonb;
--     had_assumption boolean;
--     left_assumption boolean;
--     had_conflict boolean;
--     left_conflict boolean;
--     edge_ids uuid[];
--     matches boolean;
--     keys text[];
--     problem text;
--     done text[] := '{}';
--     results jsonb := '[]';
--   begin
--     if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
--       raise exception 'Calibration is applied by a person in the app, not over the API' using errcode = '42501';
--     end if;
--     if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 2000 then
--       raise exception 'Give between 1 and 2000 proposals' using errcode = '22023';
--     end if;
--   
--     -- RLS: a calibration the user can't update (not an editor of its workspace) is not found.
--     select * into cal from public.calibrations c where c.id = p_calibration for update;
--     if cal.id is null then
--       return jsonb_build_object('status', 'not_found');
--     end if;
--   
--     stamp := jsonb_build_object('source', 'measured', 'at', now(), 'dataset_id', cal.dataset_id, 'calibration_id', cal.id)
--       || case when auth.uid() is null then '{}'::jsonb else jsonb_build_object('by', auth.uid()) end;
--   
--     keys := array(select distinct x from unnest(p_keys) x where x is not null order by x);
--     foreach k in array keys loop
--       select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
--       if prop is null or coalesce(jsonb_typeof(prop -> 'set'), '') <> 'object' or coalesce(jsonb_typeof(prop -> 'before'), '') <> 'object' then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--         continue;
--       end if;
--       if k = any (cal.applied_keys) then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'already_applied'));
--         continue;
--       end if;
--       pkind := coalesce(prop ->> 'kind', '');
--       setv := prop -> 'set';
--       beforev := prop -> 'before';
--       begin
--         target_id := (prop -> 'target' ->> 'id')::uuid;
--       exception when others then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--         continue;
--       end;
--       -- Values that aren't what this kind needs are skipped with why, never cast (and so never abort the call).
--       problem := private.calibration_payload_problem(pkind, setv, beforev);
--       if problem is not null then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'invalid', 'reason', problem));
--         continue;
--       end if;
--   
--       -- A lead source's leads a week: live, as a person's edit to demand.
--       if pkind = 'arrivals' and prop -> 'target' ->> 'table' = 'lead_sources' then
--         select * into ls from public.lead_sources l where l.id = target_id and l.workspace_id = cal.workspace_id for update;
--         if ls.id is null then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--           continue;
--         end if;
--         if ls.volume_week is distinct from (beforev ->> 'volume_week')::numeric then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--           continue;
--         end if;
--         entry := stamp || jsonb_build_object('n', prop -> 'n');
--         if jsonb_typeof(ls.provenance -> 'volume_week' -> 'evidence') = 'array' then
--           entry := entry || jsonb_build_object('evidence', ls.provenance -> 'volume_week' -> 'evidence');
--         end if;
--         update public.lead_sources l
--         set volume_week = (setv ->> 'volume_week')::numeric,
--             provenance = l.provenance || jsonb_build_object('volume_week', entry)
--         where l.id = ls.id;
--         done := done || k;
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--         continue;
--       end if;
--   
--       -- C2 part 2: a client group's normal churn, back-solved from a clients file: live, as a person's edit to the group.
--       -- Provenance is set in the same statement, so the stamp_provenance trigger keeps it `measured` (it stamps `entered` only
--       -- when the column changes and its provenance entry doesn't).
--       if pkind = 'churn' and prop -> 'target' ->> 'table' = 'client_groups' then
--         select * into cg from public.client_groups g where g.id = target_id and g.workspace_id = cal.workspace_id for update;
--         if cg.id is null then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--           continue;
--         end if;
--         if cg.churn_monthly is distinct from (beforev ->> 'churn_monthly')::numeric then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--           continue;
--         end if;
--         entry := stamp || jsonb_strip_nulls(jsonb_build_object(
--           'n', prop -> 'n',
--           'leavers', case when jsonb_typeof(prop -> 'leavers') = 'number' then prop -> 'leavers' end,
--           'measured', case when jsonb_typeof(prop -> 'measured') = 'number' then prop -> 'measured' end,
--           'multiplier', case when jsonb_typeof(prop -> 'multiplier') = 'number' then prop -> 'multiplier' end));
--         if jsonb_typeof(cg.provenance -> 'churn_monthly' -> 'evidence') = 'array' then
--           entry := entry || jsonb_build_object('evidence', cg.provenance -> 'churn_monthly' -> 'evidence');
--         end if;
--         update public.client_groups g
--         set churn_monthly = (setv ->> 'churn_monthly')::numeric,
--             provenance = g.provenance || jsonb_build_object('churn_monthly', entry)
--         where g.id = cg.id;
--         done := done || k;
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--         continue;
--       end if;
--   
--       if pkind not in ('work', 'wait', 'rework', 'routing') or coalesce(prop -> 'target' ->> 'table', '') <> 'steps' or cal.process_id is null then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--         continue;
--       end if;
--   
--       -- A step's values go into the process's draft, opened from live if there is none.
--       if draft_id is null then
--         opened := public.open_draft(cal.process_id);
--         if opened ->> 'status' <> 'ok' then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--           opened := null;
--           continue;
--         end if;
--         draft_id := (opened ->> 'revision_id')::uuid;
--       end if;
--   
--       select * into st from public.steps s where s.revision_id = draft_id and s.id = target_id for update;
--       if st.id is null or cardinality(st.replaced_by) > 0 then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
--         continue;
--       end if;
--       prov := case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end;
--   
--       if pkind = 'routing' then
--         -- The ways out must be the ones measured, each still at the odds it had.
--         if coalesce(jsonb_typeof(setv -> 'probabilities'), '') <> 'object' then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
--           continue;
--         end if;
--         select array_agg(x::uuid order by x) into edge_ids from jsonb_object_keys(setv -> 'probabilities') x;
--         select coalesce(bool_and(e.probability is not distinct from (beforev -> 'probabilities' ->> e.id::text)::numeric), false)
--           and count(*) = coalesce(cardinality(edge_ids), 0)
--           and coalesce(bool_and(e.id = any (edge_ids)), false)
--           into matches
--         from public.edges e where e.revision_id = draft_id and e.from_step_id = st.id;
--         if not coalesce(matches, false) then
--           results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--           continue;
--         end if;
--         update public.edges e set probability = (setv -> 'probabilities' ->> e.id::text)::numeric
--         where e.revision_id = draft_id and e.from_step_id = st.id;
--         -- Edges carry no provenance: the step records what was measured, so a later edit to the odds shows as no longer measured.
--         -- Odds an upload left out (`branch_odds`) are filled in now.
--         update public.steps s
--         set provenance = (prov - 'branch_odds') || jsonb_build_object('routing', stamp || jsonb_build_object('n', prop -> 'n', 'probabilities', setv -> 'probabilities'))
--         where s.revision_id = draft_id and s.id = st.id;
--         done := done || k;
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--         continue;
--       end if;
--   
--       if pkind = 'rework' then
--         matches := st.rework_rate is not distinct from (beforev ->> 'rework_rate')::numeric;
--         cols := array['rework_rate'];
--       elsif pkind = 'work' then
--         matches := st.work_hours is not distinct from (beforev ->> 'work_hours')::numeric
--           and st.work_dist is not distinct from (beforev ->> 'work_dist')
--           and (case when jsonb_typeof(st.work_params -> 'cv') = 'number' then (st.work_params ->> 'cv')::numeric end)
--             is not distinct from (beforev ->> 'work_params_cv')::numeric;
--         cols := array['work_hours', 'work_dist', 'work_params'];
--       else
--         matches := st.wait_hours is not distinct from (beforev ->> 'wait_hours')::numeric
--           and st.wait_dist is not distinct from (beforev ->> 'wait_dist')
--           and (case when jsonb_typeof(st.wait_params -> 'cv') = 'number' then (st.wait_params ->> 'cv')::numeric end)
--             is not distinct from (beforev ->> 'wait_params_cv')::numeric;
--         cols := array['wait_hours', 'wait_dist', 'wait_params'];
--       end if;
--       if not coalesce(matches, false) then
--         results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
--         continue;
--       end if;
--   
--       -- Each value's entry: measured, keeping the evidence it cited, and a conflict it had marked settled by the measurement.
--       newprov := prov;
--       foreach col in array cols loop
--         entry := stamp || jsonb_build_object('n', prop -> 'n');
--         if jsonb_typeof(prov -> col -> 'evidence') = 'array' then
--           entry := entry || jsonb_build_object('evidence', prov -> col -> 'evidence');
--         end if;
--         if jsonb_typeof(prov -> col -> 'conflict') = 'object' then
--           entry := entry || jsonb_build_object('conflict', case
--             when coalesce(prov -> col -> 'conflict' -> 'resolved', 'null') <> 'null' then prov -> col -> 'conflict'
--             else (prov -> col -> 'conflict') || jsonb_build_object('resolved', jsonb_build_object('at', now(), 'choice', 'measured')) end);
--         end if;
--         newprov := newprov || jsonb_build_object(col, entry);
--       end loop;
--   
--       -- The step's flags follow, as when a person types the values: settled here, and none left open elsewhere.
--       had_assumption := exists (select 1 from unnest(cols) c where (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
--       left_assumption := exists (select 1 from unnest(array['work_hours', 'wait_hours', 'rework_rate', 'current_wip', 'sla_hours']) c
--         where c <> all (cols) and (prov -> c ->> 'assumption') = 'true' and coalesce(prov -> c ->> 'source', 'estimated') = 'estimated');
--       had_conflict := private.has_open_conflict(prov) and not private.has_open_conflict(newprov);
--       left_conflict := private.has_open_conflict(newprov);
--   
--       update public.steps s
--       set work_hours = case when pkind = 'work' then (setv ->> 'work_hours')::numeric else s.work_hours end,
--           work_dist = case when pkind = 'work' then setv ->> 'work_dist' else s.work_dist end,
--           work_params = case when pkind = 'work' then s.work_params || (setv -> 'work_params') else s.work_params end,
--           wait_hours = case when pkind = 'wait' then (setv ->> 'wait_hours')::numeric else s.wait_hours end,
--           wait_dist = case when pkind = 'wait' then setv ->> 'wait_dist' else s.wait_dist end,
--           wait_params = case when pkind = 'wait' then s.wait_params || (setv -> 'wait_params') else s.wait_params end,
--           rework_rate = case when pkind = 'rework' then (setv ->> 'rework_rate')::numeric else s.rework_rate end,
--           provenance = newprov,
--           assumption = s.assumption and not (had_assumption and not left_assumption),
--           conflict = s.conflict and not (had_conflict and not left_conflict)
--       where s.revision_id = draft_id and s.id = st.id;
--       done := done || k;
--       results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
--     end loop;
--   
--     if cardinality(done) > 0 then
--       -- The trigger sets applied, applied_at and applied_by, and accepts the keys only while this flag is on.
--       perform set_config('transpera.applying_calibration', 'on', true);
--       update public.calibrations c set applied_keys = c.applied_keys || done where c.id = cal.id;
--       perform set_config('transpera.applying_calibration', 'off', true);
--     end if;
--   
--     return jsonb_build_object(
--       'status', 'ok',
--       'draft', case when opened is null then null else jsonb_build_object(
--         'revision_id', opened -> 'revision_id', 'number', opened -> 'number', 'created', opened -> 'created') end,
--       'results', results);
--   end;
--   $$;
--   revoke all on function public.apply_calibration(uuid, text[]) from public, anon, authenticated;
--   grant execute on function public.apply_calibration(uuid, text[]) to authenticated;
--   -- public.record_calibration_import back to 20261216000000's body (md5 f1a66685c4bbaeb3c212e5babeea9a6e):
--   create or replace function public.record_calibration_import(
--     p_workspace uuid,
--     p_process uuid,
--     p_kind text,
--     p_file_name text,
--     p_column_map jsonb,
--     p_row_count integer,
--     p_details jsonb,
--     p_results jsonb,
--     p_keys text[]
--   ) returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     ds uuid;
--     cal uuid;
--     out jsonb;
--   begin
--     if p_kind is null or p_kind not in ('step_log', 'deals', 'time_logs') then
--       raise exception 'That kind of file isn''t calibrated against a process' using errcode = '22023';
--     end if;
--     -- Row-level security refuses a viewer's or a stranger's insert; apply_calibration refuses an API token. Either way
--     -- the whole call rolls back, records included.
--     insert into public.datasets (workspace_id, kind, process_id, file_name, column_map, row_count, details)
--     values (
--       p_workspace,
--       p_kind,
--       p_process,
--       p_file_name,
--       coalesce(p_column_map, '{}'),
--       p_row_count,
--       coalesce(case when jsonb_typeof(p_details) = 'object' then p_details end, '{}'))
--     returning id into ds;
--     insert into public.calibrations (workspace_id, dataset_id, process_id, results)
--     values (p_workspace, ds, p_process, p_results)
--     returning id into cal;
--     out := public.apply_calibration(cal, p_keys);
--     return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
--   end;
--   $$;
--   revoke all on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) from public, anon, authenticated;
--   grant execute on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) to authenticated;
--   -- public.team_capacity back to 20261223000000's body (md5 a8dcb5d1bddaf549ecef591a3c1b5ae0):
--   create or replace function public.team_capacity(ws uuid) returns jsonb
--   language plpgsql stable security definer
--   set search_path = ''
--   as $$
--   declare
--     everyone boolean;
--     own uuid;
--     result jsonb;
--   begin
--     if ws is null or not public.can_read_workspace(ws) then
--       raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
--     end if;
--     everyone := public.can_see_people(ws);
--     own := public.my_person_id(ws);
--   
--     with p as (
--       select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
--              pe.end_date, pe.provenance,
--              row_number() over (order by pe.created_at, pe.id) as n
--       from public.people pe where pe.workspace_id = ws
--     ),
--     shown as (
--       select p.*,
--         case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
--         -- No pay for anyone but the caller's own person (and those who see everyone).
--         case when everyone or p.id = own then p.cost_rate end as shown_rate
--       from p
--     )
--     select jsonb_build_object(
--       'sees_everyone', everyone,
--       'own_person_id', own,
--       'people', coalesce((select jsonb_agg(jsonb_build_object(
--           'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
--           'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
--           'start_date', s.start_date, 'end_date', s.end_date,
--           'provenance', case when everyone then s.provenance else '{}'::jsonb end)
--         order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
--       'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
--           'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
--         from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
--       'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
--           'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
--         from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
--       'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
--           'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
--           order by l.person_id, l.start_date, l.id)
--         from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
--       'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
--           'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
--         from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb),
--       -- C6: per-person times. Everyone's for those who see everyone; only the caller's own person's otherwise (none when
--       -- unlinked). Never provenance (it holds who entered it); `source` says entered or measured.
--       'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
--           'workspace_id', f.workspace_id, 'factor', f.factor,
--           'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'))
--           order by f.person_id, f.step_id nulls first)
--         from public.person_capacity_factors f
--         where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
--     ) into result;
--     return result;
--   end;
--   $$;
--   revoke execute on function public.team_capacity(uuid) from public, anon;
--   grant execute on function public.team_capacity(uuid) to authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261227000000';
--   commit;

-- ---------------------------------------------------------------------------
-- 1. The table: per-person proposals, read by owners, editors and agency admins only
-- ---------------------------------------------------------------------------

create table public.capacity_factor_proposals (
  id uuid primary key default gen_random_uuid(),
  calibration_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  person_id uuid not null,
  -- Step ids are stable across a process's versions (as person_capacity_factors.step_id); no foreign key.
  step_id uuid not null,
  -- The proposal as computed (PersonTimeProposal): current, proposed, sample sizes, note. Frozen once written.
  proposal jsonb not null constraint capacity_factor_proposals_proposal check (
    jsonb_typeof(proposal) = 'object' and proposal ->> 'kind' = 'capacity_factor'
    and proposal -> 'target' ->> 'table' = 'person_capacity_factors'
    and proposal -> 'target' ->> 'id' = person_id::text and proposal -> 'target' ->> 'step_id' = step_id::text
    and octet_length(proposal::text) <= 10000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (calibration_id, person_id, step_id),
  foreign key (calibration_id, workspace_id) references public.calibrations (id, workspace_id) on delete cascade,
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);
create index on public.capacity_factor_proposals (workspace_id);

-- The MCP server (an API token) can't write them, as for the company model.
create trigger needs_review before insert on public.capacity_factor_proposals
  for each row execute function private.company_needs_review();

alter table public.capacity_factor_proposals enable row level security;
-- Per-person data: owners, editors and agency admins only. Never members or viewers, not even their own (#227).
create policy "read capacity_factor_proposals" on public.capacity_factor_proposals for select to authenticated
  using (public.can_see_people(workspace_id));
create policy "insert capacity_factor_proposals" on public.capacity_factor_proposals for insert to authenticated
  with check (public.can_see_people(workspace_id));
revoke all on public.capacity_factor_proposals from anon, authenticated;
grant select, insert on public.capacity_factor_proposals to authenticated;

-- ---------------------------------------------------------------------------
-- 2. private.calibration_payload_problem: a full copy of 20261208000000 plus the capacity_factor kind (marked #227)
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
  -- #227: a person's time on a step, a multiple of the step's normal time, within what person_capacity_factors allows.
  if kind = 'capacity_factor' then
    if (case when jsonb_typeof(setv -> 'factor') = 'number' then (setv ->> 'factor')::numeric not between 0.5 and 2 else true end) then
      return 'factor is not a per-person time from 0.5 to 2';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'factor'), 'null') not in ('number', 'null') then
      return 'the earlier factor is not a number';
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
-- 3. apply_calibration: a full copy of 20261208000000 plus a lookup hunk and a capacity_factor branch (marked #227)
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
  pcf public.person_capacity_factors; -- #227
  step_ref uuid; -- #227
  raced boolean; -- #227
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
    -- #227: a per-person proposal is kept apart, where only owners, editors and agency admins read it; its key is its row id.
    if k like 'factor:%' then
      select f.proposal into prop from public.capacity_factor_proposals f where f.calibration_id = cal.id and 'factor:' || f.id::text = k;
    else
      select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
    end if;
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

    -- #227: a person's time on a step, measured from a log that names people: live, as a person's edit, kept `measured`
    -- (provenance set in the same statement, so stamp_provenance keeps it). Only while Per-person times are switched on.
    if pkind = 'capacity_factor' and prop -> 'target' ->> 'table' = 'person_capacity_factors' then
      begin
        step_ref := (prop -> 'target' ->> 'step_id')::uuid;
      exception when others then
        step_ref := null;
      end;
      if step_ref is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
        continue;
      end if;
      if not exists (select 1 from public.workspaces w where w.id = cal.workspace_id and w.settings -> 'capacity_factor_enabled' = 'true'::jsonb) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'switched_off'));
        continue;
      end if;
      if not exists (select 1 from public.people pe where pe.id = target_id and pe.workspace_id = cal.workspace_id)
         or not exists (select 1 from public.steps s where s.id = step_ref and s.workspace_id = cal.workspace_id) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      select * into pcf from public.person_capacity_factors f where f.person_id = target_id and f.step_id = step_ref for update;
      if pcf.factor is distinct from (beforev ->> 'factor')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      raced := false;
      if pcf.person_id is null then
        begin
          insert into public.person_capacity_factors (person_id, workspace_id, step_id, factor, provenance)
          values (target_id, cal.workspace_id, step_ref, (setv ->> 'factor')::numeric, jsonb_build_object('factor', entry));
        exception when unique_violation then
          raced := true;
        end;
      else
        update public.person_capacity_factors f
        set factor = (setv ->> 'factor')::numeric, provenance = f.provenance || jsonb_build_object('factor', entry)
        where f.person_id = target_id and f.step_id = step_ref;
      end if;
      if raced then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
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
-- 4. record_calibration_import: a full copy of 20261216000000 plus the per-person proposals (marked #227)
-- ---------------------------------------------------------------------------

create or replace function public.record_calibration_import(
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
  -- #227: per-person proposals travel in p_results.capacity_factors and are kept apart from the calibration's results,
  -- which everyone in the workspace reads.
  factors jsonb := case when jsonb_typeof(p_results -> 'capacity_factors') = 'array' then p_results -> 'capacity_factors' else '[]'::jsonb end;
  keys text[]; -- #227
begin
  if p_kind is null or p_kind not in ('step_log', 'deals', 'time_logs') then
    raise exception 'That kind of file isn''t calibrated against a process' using errcode = '22023';
  end if;
  -- #227: only owners, editors and agency admins, only with Per-person times switched on (#41 decision 4).
  if jsonb_array_length(factors) > 0 then
    if not coalesce(public.can_see_people(p_workspace), false) then
      raise exception 'Only owners and editors can apply per-person times' using errcode = '42501';
    end if;
    if jsonb_array_length(factors) > 2000 then
      raise exception 'Give at most 2000 per-person times' using errcode = '22023';
    end if;
    if not exists (select 1 from public.workspaces w where w.id = p_workspace and w.settings -> 'capacity_factor_enabled' = 'true'::jsonb) then
      raise exception 'Per-person times are switched off in this workspace' using errcode = '22023';
    end if;
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
  values (p_workspace, ds, p_process, p_results - 'capacity_factors') -- #227: never per-person data in what members read
  returning id into cal;
  -- #227: each per-person proposal where only owners, editors and agency admins read it; a ticked `factor:<person>:<step>` becomes
  -- `factor:<its row id>`, so the calibration's applied keys (which members read) name no person.
  insert into public.capacity_factor_proposals (calibration_id, workspace_id, person_id, step_id, proposal)
  select cal, p_workspace, (f.value -> 'target' ->> 'id')::uuid, (f.value -> 'target' ->> 'step_id')::uuid, f.value
  from jsonb_array_elements(factors) f;
  keys := array(
    select coalesce((select 'factor:' || x.id::text from public.capacity_factor_proposals x
                     where x.calibration_id = cal and u.k = 'factor:' || x.person_id::text || ':' || x.step_id::text), u.k)
    from unnest(p_keys) with ordinality u(k, o) order by u.o);
  out := public.apply_calibration(cal, keys);
  -- #227: and back to the page's own keys.
  if out ? 'results' then
    out := out || jsonb_build_object('results', coalesce((
      select jsonb_agg(case when x.id is null then r.value
                            else r.value || jsonb_build_object('key', 'factor:' || x.person_id::text || ':' || x.step_id::text) end order by r.o)
      from jsonb_array_elements(out -> 'results') with ordinality r(value, o)
      left join public.capacity_factor_proposals x on x.calibration_id = cal and r.value ->> 'key' = 'factor:' || x.id::text), '[]'::jsonb));
  end if;
  return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
end;
$$;

revoke all on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. team_capacity: a full copy of 20261223000000 plus `items` on each factor (marked #227)
-- ---------------------------------------------------------------------------

create or replace function public.team_capacity(ws uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  everyone boolean;
  own uuid;
  result jsonb;
begin
  if ws is null or not public.can_read_workspace(ws) then
    raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
  end if;
  everyone := public.can_see_people(ws);
  own := public.my_person_id(ws);

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
           pe.end_date, pe.provenance,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  shown as (
    select p.*,
      case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
      -- No pay for anyone but the caller's own person (and those who see everyone).
      case when everyone or p.id = own then p.cost_rate end as shown_rate
    from p
  )
  select jsonb_build_object(
    'sees_everyone', everyone,
    'own_person_id', own,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
        'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
        'start_date', s.start_date, 'end_date', s.end_date,
        'provenance', case when everyone then s.provenance else '{}'::jsonb end)
      order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
    'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
        'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
      from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
    'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
        'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
      from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
    'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
        'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
        order by l.person_id, l.start_date, l.id)
      from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
    'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
        'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb),
    -- C6: per-person times. Everyone's for those who see everyone; only the caller's own person's otherwise (none when
    -- unlinked). Never provenance (it holds who entered it); `source` says entered or measured.
    'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
        'workspace_id', f.workspace_id, 'factor', f.factor,
        'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'),
        -- #227: how many visits a measured time rests on (PRD §6.3.7 shows a measured time only from 10); null when entered.
        'items', case when f.provenance -> 'factor' ->> 'source' = 'measured' and jsonb_typeof(f.provenance -> 'factor' -> 'n') = 'number'
          then round((f.provenance -> 'factor' ->> 'n')::numeric)::int end)
        order by f.person_id, f.step_id nulls first)
      from public.person_capacity_factors f
      where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke execute on function public.team_capacity(uuid) from public, anon;
grant execute on function public.team_capacity(uuid) to authenticated;
$mig$]);

commit;
