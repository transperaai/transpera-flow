-- Scenario patches for client health and churn (issue #79; docs/PRD.md
-- §6.3.5, §6.5 "including health/churn defaults").
--
-- The robustness check perturbs estimated inputs through scenario patch
-- paths, so the health rules added in #19 need paths of their own:
--   health.initial | health.recover | health.late_penalty | health.missed_penalty
--     (the workspace's `settings.health_<field>`), and
--   services.<id>.churn_health_sensitivity.
-- This redefines private.is_scenario_patch exactly as in
-- 20261002000000_scenarios.sql, with only those paths added to the grammar.
-- It mirrors parsePatches() in packages/engine/src/scenario.ts (tested
-- against it in packages/db/test/scenarios.test.ts).
--
-- Strictly additive: every patch accepted before is still accepted, so the
-- `scenarios_patch_shape` check holds for existing rows. `create or replace`
-- keeps the function's grants. No table, column, policy or data change.
--
-- Rollback (restores the previous definition). Postgres doesn't re-check
-- existing rows when a check's function changes, so first find saved
-- scenarios using the new paths (`select id, name from public.scenarios where
-- patch::text ~ '"(health\.|services\.[^"]*\.churn_health_sensitivity)'`)
-- and edit them: they could not be saved again afterwards.
--   create or replace function private.is_scenario_patch(patch jsonb) returns boolean
--   language sql immutable
--   set search_path = ''
--   as $$
--     select jsonb_typeof(patch) = 'array'
--       and jsonb_array_length(patch) <= 200
--       and not exists (
--         select 1
--         from jsonb_array_elements(patch) as e(p)
--         where case
--           when jsonb_typeof(p) <> 'object' then true
--           else (select array_agg(k order by k) from jsonb_object_keys(p) as k) is distinct from array['op', 'path', 'value']
--             or jsonb_typeof(p -> 'path') <> 'string'
--             or jsonb_typeof(p -> 'op') <> 'string'
--             or jsonb_typeof(p -> 'value') <> 'number'
--             or (p ->> 'op') not in ('set', 'multiply', 'add')
--             or (p ->> 'path') !~ ('^(demand\.(leads_per_week|active_clients|churn_monthly)'
--                                   || '|finances\.retainer'
--                                   || '|services\.[^.[:space:]]{1,100}\.(price|mix_share)'
--                                   || '|roles\.[^.[:space:]]{1,100}\.(headcount|cost_rate|ongoing_hours)'
--                                   || '|people\.[^.[:space:]]{1,100}\.fte'
--                                   || '|steps\.[^.[:space:]]{1,100}\.(work_hours|wait_hours|rework_rate))$')
--             -- An id starting with @ must be a known selector.
--             or ((p ->> 'path') ~ '^[a-z]+\.@' and (p ->> 'path') !~ '^(roles\.@busiest|steps\.@heaviest)\.')
--         end
--       );
--   $$;
--   delete from supabase_migrations.schema_migrations where version = '20261017000000';

create or replace function private.is_scenario_patch(patch jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select jsonb_typeof(patch) = 'array'
    and jsonb_array_length(patch) <= 200
    and not exists (
      select 1
      from jsonb_array_elements(patch) as e(p)
      where case
        when jsonb_typeof(p) <> 'object' then true
        else (select array_agg(k order by k) from jsonb_object_keys(p) as k) is distinct from array['op', 'path', 'value']
          or jsonb_typeof(p -> 'path') <> 'string'
          or jsonb_typeof(p -> 'op') <> 'string'
          or jsonb_typeof(p -> 'value') <> 'number'
          or (p ->> 'op') not in ('set', 'multiply', 'add')
          or (p ->> 'path') !~ ('^(demand\.(leads_per_week|active_clients|churn_monthly)'
                                || '|finances\.retainer'
                                || '|health\.(initial|recover|late_penalty|missed_penalty)'
                                || '|services\.[^.[:space:]]{1,100}\.(price|mix_share|churn_health_sensitivity)'
                                || '|roles\.[^.[:space:]]{1,100}\.(headcount|cost_rate|ongoing_hours)'
                                || '|people\.[^.[:space:]]{1,100}\.fte'
                                || '|steps\.[^.[:space:]]{1,100}\.(work_hours|wait_hours|rework_rate))$')
          -- An id starting with @ must be a known selector.
          or ((p ->> 'path') ~ '^[a-z]+\.@' and (p ->> 'path') !~ '^(roles\.@busiest|steps\.@heaviest)\.')
      end
    );
$$;
