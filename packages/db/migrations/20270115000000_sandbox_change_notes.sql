-- A note on a change (sandbox phase 5a, docs/plans/sandbox-p5-brief.md section 5).
--
-- What it does (no row is changed):
--   `private.is_sandbox_change` is a full copy of the 20270112000000 body with one more allowed key, `note`, and one more rule: when
--   present it is a string of 1 to 280 characters with no space, tab or line break at either end. The note lives in the change, inside
--   `sandbox_scenarios.changes`, so it travels with the change through Duplicate, Build on, a restore (`changes` is restored whole) and
--   a share snapshot with no new column or join. `SandboxChange.note` and `changeProblem` (packages/db/src/sandbox-levers.ts) are its
--   TypeScript twins. The restore's `allow` list, `private.is_sandbox_changes` and the grants need nothing.
--   It only widens: no stored change has a `note`, so every saved scenario passes before and after.
--
-- Runs on a database full of real rows (the production copy imported at 20261231000000, then every later migration): a function
-- replacement touches no row.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270115000000';` expect 0, and 20270114000000 applied.
--     Record, for the post-apply comparison: select count(*), max(updated_at) from public.sandbox_scenarios;
--     select count(*) from public.sandbox_scenarios where not private.is_sandbox_changes(changes);   -- expect 0
-- Post-apply checks:
--     -- The same count and updated_at, and every saved scenario still passes. Expect the count, the timestamp, 0:
--     select count(*), max(updated_at) from public.sandbox_scenarios;
--     select count(*) from public.sandbox_scenarios where not private.is_sandbox_changes(changes);
--     -- A note is accepted, and a 281-character, empty, untrimmed or non-string one is not. Expect true, false, false, false, false:
--     select private.is_sandbox_change('{"id":"5b000000-0000-4000-8000-000000000001","lever":"A1","target":null,"op":"multiply","value":1.1,"note":"Assumes the Q3 campaign doubles leads."}'::jsonb);
--     select private.is_sandbox_change(jsonb_build_object('id','5b000000-0000-4000-8000-000000000001','lever','A1','target',null,'op','multiply','value',1.1,'note',repeat('x',281)));
--     select private.is_sandbox_change('{"id":"5b000000-0000-4000-8000-000000000001","lever":"A1","target":null,"op":"multiply","value":1.1,"note":""}'::jsonb);
--     select private.is_sandbox_change('{"id":"5b000000-0000-4000-8000-000000000001","lever":"A1","target":null,"op":"multiply","value":1.1,"note":" x"}'::jsonb);
--     select private.is_sandbox_change('{"id":"5b000000-0000-4000-8000-000000000001","lever":"A1","target":null,"op":"multiply","value":1.1,"note":5}'::jsonb);
-- Rollback (take a Neon branch just before `migrate` as the cutover runbook does; or by hand): remove every `note` from the stored
-- changes first (`update public.sandbox_scenarios set changes = (select coalesce(jsonb_agg(c - 'note'), '[]') from jsonb_array_elements(changes) c);`
-- with the actor set to system), re-run the `is_sandbox_change` body from 20270112000000_churn_chances_and_fee_ranges.sql, then delete
-- the row from public.schema_migrations.

-- Marks any write as the system's, as the migrations since 20270103000000_three_roles.sql do.
select set_config('transpera.actor_kind', 'system', true);

-- One change: the 20270112000000 body verbatim, with `note` an allowed key (a string of 1 to 280 characters, none of space, tab or line break at either end).
create or replace function private.is_sandbox_change(c jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  return coalesce((
    select
      not exists (select 1 from pg_catalog.jsonb_object_keys(c) k where k not in ('id', 'lever', 'target', 'op', 'value', 'from', 'params', 'note'))
      and case
        when not (c ? 'note') then true
        when pg_catalog.jsonb_typeof(c -> 'note') <> 'string' then false
        else pg_catalog.char_length(c ->> 'note') between 1 and 280 and (c ->> 'note') = pg_catalog.btrim(c ->> 'note', E' \t\r\n')
      end
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
        when 'A3' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric between 0 and 5 else false end
        when 'A5' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric >= 0 else false end
        when 'B4' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric between 0 and 5 else false end
        when 'B5' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric between -1 and 4 else false end
        when 'D6' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' then (c ->> 'value')::numeric between 0.1 and 2 else false end
        when 'D9' then case when pg_catalog.jsonb_typeof(c -> 'value') = 'number' and (c ->> 'value') ~ '^[0-6]$' then true else false end
        else true
      end
      and case
        when not (c ? 'params') then l.id <> 'A5'
        when pg_catalog.jsonb_typeof(c -> 'params') <> 'object' then false
        else case l.id
          when 'D1' then
            not exists (select 1 from pg_catalog.jsonb_object_keys(c -> 'params') k where k <> 'name')
            and pg_catalog.jsonb_typeof(c -> 'params' -> 'name') = 'string'
            and pg_catalog.length(c -> 'params' ->> 'name') between 1 and 120
          when 'A5' then
            not exists (select 1 from pg_catalog.jsonb_object_keys(c -> 'params') k where k not in ('low', 'high'))
            and case
              when pg_catalog.jsonb_typeof(c -> 'params' -> 'low') = 'number' and pg_catalog.jsonb_typeof(c -> 'params' -> 'high') = 'number' and pg_catalog.jsonb_typeof(c -> 'value') = 'number'
                then (c -> 'params' ->> 'low')::numeric >= 0 and (c -> 'params' ->> 'low')::numeric <= (c ->> 'value')::numeric
                  and (c ->> 'value')::numeric <= (c -> 'params' ->> 'high')::numeric and (c -> 'params' ->> 'high')::numeric <= 1000000000
              else false
            end
          when 'B4' then
            not exists (select 1 from pg_catalog.jsonb_object_keys(c -> 'params') k where k not in ('chance', 'months'))
            and case
              when not (c -> 'params' ? 'chance') then true
              when pg_catalog.jsonb_typeof(c -> 'params' -> 'chance') = 'number' then (c -> 'params' ->> 'chance')::numeric between 0 and 1
              else false
            end
            and case
              when not (c -> 'params' ? 'months') then true
              when pg_catalog.jsonb_typeof(c -> 'params' -> 'months') = 'number' and (c -> 'params' ->> 'months') ~ '^[0-9]{1,2}$' then (c -> 'params' ->> 'months')::integer between 1 and 24
              else false
            end
          when 'B2' then
            not exists (select 1 from pg_catalog.jsonb_object_keys(c -> 'params') k where k <> 'who')
            and pg_catalog.jsonb_typeof(c -> 'params' -> 'who') = 'string'
            and (c -> 'params' ->> 'who') in ('new', 'all')
          else false
        end
      end
    from private.sandbox_levers() l
    where pg_catalog.jsonb_typeof(c) = 'object' and l.id = c ->> 'lever'
  ), false);
end;
$$;
