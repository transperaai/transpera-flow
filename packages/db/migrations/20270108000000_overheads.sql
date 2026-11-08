-- Overheads (sandbox phase 2, docs/plans/sandbox-p2-brief.md section 3): `workspaces.settings.overhead_monthly`, the fixed costs a
-- month (rent, tools, insurance) the forecast takes off revenue, with pay, to show profit.
--
-- 1. The key is guarded in share snapshots and listed in COMPANY_FIELDS, but no screen wrote it until now. Nothing in the app
--    writes it today, though the removed Suggestions could have, and a restore merges `settings` wholesale, so rows may hold
--    anything. Normalise what is stored: a plain number from 0 to 100,000,000 stays; a number written as a string becomes a
--    number; JSON null stays (it means "not set"); anything else is removed. CASE, not AND, so no cast runs on a non-number.
-- 2. The shape check, beside workspaces_currency_code. It is validated at once: step 1 made every row pass.
-- 3. Scenario patches may set overheads (sandbox lever C2, `finances.overhead_monthly`): private.is_scenario_patch is the body
--    of 20261017000000_health_patches.sql with one alternative changed, '|finances\.retainer' to '|finances\.(retainer|overhead_monthly)'.
--    Strictly additive: every patch accepted before is still accepted. `create or replace` keeps the function's grants.
--
-- Runs on a database full of real rows (the production copy imported at 20261231000000, then every later migration): step 1
-- rewrites at most the workspaces that hold an unusable value, and the constraint is checked against every row.
-- Rollback: `alter table public.workspaces drop constraint workspaces_overhead_monthly;`, then re-run the
-- private.is_scenario_patch body from 20261017000000_health_patches.sql, then
-- `delete from public.schema_migrations where version = '20270108000000';` (the unusable values step 1 removed
-- are not restored; there were none in the app's own data).

-- Marks step 1's writes as the system's, as 20270103000000_three_roles.sql does.
select set_config('transpera.actor_kind', 'system', true);

-- 1. Normalise what is stored.
update public.workspaces w
set settings = case
    when jsonb_typeof(w.settings -> 'overhead_monthly') = 'string'
         and btrim(w.settings ->> 'overhead_monthly') ~ '^[0-9]{1,8}(\.[0-9]+)?$'
      then jsonb_set(w.settings, '{overhead_monthly}', to_jsonb(btrim(w.settings ->> 'overhead_monthly')::numeric))
    else w.settings - 'overhead_monthly'
  end
where w.settings ? 'overhead_monthly'
  and case jsonb_typeof(w.settings -> 'overhead_monthly')
        when 'null' then false
        when 'number' then not ((w.settings ->> 'overhead_monthly')::numeric between 0 and 100000000)
        else true
      end;

-- 2. The shape check.
alter table public.workspaces add constraint workspaces_overhead_monthly check (
  case
    when not (settings ? 'overhead_monthly') then true
    when jsonb_typeof(settings -> 'overhead_monthly') = 'null' then true
    when jsonb_typeof(settings -> 'overhead_monthly') = 'number'
      then (settings ->> 'overhead_monthly')::numeric between 0 and 100000000
    else false
  end) not valid;
alter table public.workspaces validate constraint workspaces_overhead_monthly;

-- 3. Scenario patches may set overheads.
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
                                || '|finances\.(retainer|overhead_monthly)'
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
