-- Sandbox phase 1 review fixes (docs/plans/sandbox-p1-brief.md). 20270109000000_sandbox_scenarios.sql is already applied on Preview,
-- so its fixes land here. No table, column, policy or grant changes; no data changes.
--
-- 1. The change check is about 9 times faster. A restore of 900 scenarios spent about 0.8 s in the `sandbox_scenarios_changes` check
--    (the restore's budget is 15 s and it was at 14 to 14.6 s of database CPU, against 13.0 s before the Sandbox), because:
--      * `private.sandbox_levers()` had `set search_path`, so Postgres could not inline it: every change it checked ran the function
--        and built its 19 rows again. It holds nothing but literals, so it needs no search_path; without it the VALUES are inlined.
--      * `private.is_sandbox_change` was a SQL function called once per change from inside `private.is_sandbox_changes`, which
--        parses and plans its body again on every call. As PL/pgSQL its plan is kept for the session. The body is the same
--        expression, unchanged (`return` in place of `select`), and keeps its empty search_path.
--    Measured on local Postgres 16: 900 one-change lists 780 ms -> 89 ms; fifty 200-change lists 2.2 s -> 0.72 s.
-- 2. `private.sandbox_scenario_count(ws)` is SECURITY DEFINER (so the cap does not run the read policy on every row it counts) and
--    authenticated may execute it, so it told anyone signed in how many scenarios ANY workspace has. It now answers only for a
--    workspace the caller can edit, which is everyone RLS lets insert a scenario, so the 1000 cap is unchanged; anyone else gets 0.
--    (No one could call it from the app, which reaches only public functions, but a definer function should not need that.)
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270111000000';` expect 0; and 20270109000000 applied.
-- Post-apply checks:
--     -- Expect: sandbox_levers sql null; is_sandbox_change plpgsql {search_path=""}; sandbox_scenario_count sql t {search_path=""}:
--     select p.proname, l.lanname, p.prosecdef, p.proconfig from pg_proc p join pg_language l on l.oid = p.prolang
--      where p.pronamespace = 'private'::regnamespace and p.proname in ('sandbox_levers', 'is_sandbox_change', 'sandbox_scenario_count');
--     -- Every saved scenario still passes the check. Expect 0:
--     select count(*) from public.sandbox_scenarios where not private.is_sandbox_changes(changes);
-- Rollback: re-run the three function definitions from 20270109000000_sandbox_scenarios.sql (create or replace; for
-- `is_sandbox_change`, drop nothing: create or replace may change the language) and
-- `alter function private.sandbox_levers() set search_path = '';`.

-- 1. The change check.
alter function private.sandbox_levers() reset search_path;

create or replace function private.is_sandbox_change(c jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  return coalesce((
    select
      not exists (select 1 from pg_catalog.jsonb_object_keys(c) k where k not in ('id', 'lever', 'target', 'op', 'value', 'from', 'params'))
      and coalesce(c ->> 'id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and pg_catalog.jsonb_typeof(c -> 'op') = 'string' and (c ->> 'op') = any (l.ops)
      and case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then abs((c ->> 'value')::numeric) <= 1000000000 else false end
      and case
        when coalesce(pg_catalog.jsonb_typeof(c -> 'target'), 'null') = 'null' then l.target in ('none', 'id_or_none')
        when pg_catalog.jsonb_typeof(c -> 'target') <> 'string' or l.target = 'none' then false
        when l.target = 'health' then (c ->> 'target') in ('initial', 'recover', 'late_penalty', 'missed_penalty')
        when (c ->> 'target') like '@%' then (c ->> 'target') = l.selector
        else (c ->> 'target') ~ '^[^.[:space:]]{1,100}$'
      end
      and case
        when not (c ? 'from') then l.whole_run
        when l.timed = 'no' or pg_catalog.jsonb_typeof(c -> 'from') <> 'string' then false
        when l.timing = 'month' then (c ->> 'from') ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$'
        else (c ->> 'from') ~ '^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$' and private.is_monday(c ->> 'from')
      end
      and case l.id
        when 'D1' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric between 0.1 and 2 else false end
        when 'D2' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric = 0 else false end
        when 'D3' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' and (c ->> 'value') ~ '^[0-9]{1,2}$' then (c ->> 'value')::integer between 1 and 52 else false end
        when 'E6' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric = 1 else false end
        when 'C2' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'op') = 'add' or (c ->> 'value')::numeric >= 0 else false end
        else true
      end
      and case
        when not (c ? 'params') then true
        when l.id <> 'D1' or pg_catalog.jsonb_typeof(c -> 'params') <> 'object' then false
        else not exists (select 1 from pg_catalog.jsonb_object_keys(c -> 'params') k where k <> 'name')
          and pg_catalog.jsonb_typeof(c -> 'params' -> 'name') = 'string'
          and pg_catalog.length(c -> 'params' ->> 'name') between 1 and 120
      end
    from private.sandbox_levers() l
    where pg_catalog.jsonb_typeof(c) = 'object' and l.id = c ->> 'lever'
  ), false);
end;
$$;

-- 2. The count, for editors only.
create or replace function private.sandbox_scenario_count(ws uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select case when coalesce(public.can_edit_workspace(ws), false)
    then (select pg_catalog.count(*)::integer from public.sandbox_scenarios s where s.workspace_id = ws)
    else 0 end
$$;
