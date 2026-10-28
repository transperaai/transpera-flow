# Sandbox phase 1: build brief

Opus brief, 28 Oct 2026. Source decisions: `docs/plans/sandbox-design.md` (Austin, 27–28 Oct; "Suggested build order",
phase 1) and `docs/plans/cut-list.md` items 4, 8 and 9. Built on `claude/supabase-migration-plan-mzchlf`. One builder.
Opus reviews. Read `CLAUDE.md`, `apps/web/AGENTS.md` and the design first.

**Phase 1 in one line:** one table, `sandbox_scenarios`, replaces `forecast_plans` and `scenarios`. The Forecast page
becomes the Sandbox, where you save, run and compare scenarios. Each change applies to the whole run or from a month.
Every change uses a mechanism that exists today: patches, people over time, or splicing. The engine does not change and
ENGINE is not bumped.

## Rules

- **Migrations transform real data.** At cutover the production copy is imported at `20261231000000` and the later
  migrations then run on it. The phase 1 migration is `20270106000000_sandbox_scenarios.sql`, and it must work on a
  database full of real rows. The test below proves it.
- **Remove what is replaced, don't hide it.** This covers the plan code, `forecast_plans`, `scenarios`,
  `private.is_scenario_patch`, the Forecast route and its components. List every deleted test in the report.
- **Generated files.** After the SQL, run `pnpm --filter @transpera-flow/db gen:types` and
  `pnpm --filter @transpera-flow/db gen:seed`.
- **Done** means `pnpm lint && pnpm typecheck && pnpm test` are green with
  `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`. The known `format.test.ts` ICU failure is ignored.

The SQL below was run on local Postgres 16. It ran against the seeded database (`packages/db/seed.sql`) plus extra rows:
every patch family, the selectors, a duplicate-from link, names that clash, and plans with each marker kind. The migration,
the name de-duplication, the validator cases, the parent rules and the library trigger all behaved as described. Treat it as
the reference and check it again in the tests.

---

## 1. Data model and migration

### What exists today (verified)

- **`public.scenarios`** (`20261002000000_scenarios.sql`, with the grammar widened in `20261017000000_health_patches.sql`).
  - Columns: `id, workspace_id, name, description, patch, parent_scenario_id, created_at, updated_at, created_by`.
  - `patch` is checked by `private.is_scenario_patch(jsonb)`. Names are not unique.
  - `parent_scenario_id` means "duplicated from". The copy already holds its own copy of the patches, so it does **not**
    mean "build on".
  - RLS: read is `can_read_workspace`; write is `can_edit_workspace`.
  - The `audit_mcp` trigger is on it.
  - The `seed_scenario_library` trigger on `workspaces` gives every new workspace 4 library rows
    (`private.scenario_library()`). These use the selectors `roles.@busiest` and `steps.@heaviest`.
  - What depends on it:
    - `issues.scenario_id` and `runs.scenario_id`, both FKs to `(id, workspace_id)` with `on delete set null (scenario_id)`;
    - `public.import_workspace_bundle` (its latest body is in `20270104000000_strip_followups.sql`). It uses
      `scenarios` for the "empty" check, the library skip and the `scenarios` write section;
    - `packages/db/src/seed.ts`, `workspace-bundle.ts`, `workspace-import.ts` and `share.ts` (`ProcessShare.scenarios`);
    - MCP `compare_scenarios`, `check_robustness` and `list_issues` (through `loadScenarios`).
- **`public.forecast_plans`** (`20261219000000_forecast_plans.sql`).
  - Columns: `id, workspace_id, name, markers, created_at, updated_at, created_by`.
  - Names are unique per workspace, ignoring case and spaces. There are at most 50 plans and 40 markers.
  - Markers are `hire {role_id, fte 0.1–2, name?}` on the 1st, `leave {person_id, weeks 1–52}` on a Monday, and
    `solution {solution_id}` on the 1st, with at most 4 solutions.
  - RLS: read and write are both `can_edit_workspace`, so Viewers read nothing.
  - Nothing else references it: no FK, no backup, no share link, no MCP.
- **Roles after the strip** (`20270103000000`, `20270105000000`):
  - `can_edit_workspace(ws)` = `is_agency_admin() or workspace_role(ws) = 'owner'`. That is the Owner and Agency admins.
  - `can_manage_workspace(ws)` is the same.
  - `can_see_people(ws)` = `can_edit_workspace(ws)`.
  - `can_read_workspace(ws)` adds Viewers.
  - `workspace_role(ws)` answers nothing for a guest.
  - `team_capacity(ws)` gives a Viewer every person's id, FTE, dates, roles and leave. Names are "Team member N", except
    their own. There is no pay and there are no capacity factors.
  - `roles.default_cost_rate` is readable by every member.

### The new table

```sql
create table public.sandbox_scenarios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 120),
  description text check (pg_catalog.length(description) <= 2000),
  -- "Build on": this scenario's changes apply on top of its parent's (effective changes, parent first).
  parent_id uuid,
  changes jsonb not null default '[]' constraint sandbox_scenarios_changes check (private.is_sandbox_changes(changes)),
  horizon_months smallint not null default 12 check (horizon_months between 1 and 24),
  -- Null: the run starts today. Phase 1 never writes it (F2 is later); the runner honours it if set.
  start_date date check (start_date is null or pg_catalog.date_part('day', start_date) = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  constraint sandbox_scenarios_not_own_parent check (parent_id is distinct from id),
  -- NO ACTION, not RESTRICT: deleting a parent alone is refused (23503); deleting the workspace (both rows in one
  -- statement) is not. Checked locally: parent delete refused, workspace delete cascades.
  constraint sandbox_scenarios_parent foreign key (parent_id, workspace_id)
    references public.sandbox_scenarios (id, workspace_id) on delete no action
);
create unique index sandbox_scenarios_workspace_name_key
  on public.sandbox_scenarios (workspace_id, pg_catalog.lower(pg_catalog.btrim(name)));
create index sandbox_scenarios_parent_idx on public.sandbox_scenarios (parent_id) where parent_id is not null;
create trigger set_updated_at before update on public.sandbox_scenarios
  for each row execute function public.set_updated_at();
```

**A change** (one element of `changes`):

```ts
{ id: uuid, lever: "A1" | … , target: string | null, op: "set" | "multiply" | "add", value: number,
  from?: "YYYY-MM" | "YYYY-MM-DD" /* a Monday, leave (D3) only */, params?: { name: string } /* hire (D1) only */ }
```

- With no `from`, a change applies to the whole run.
- `until` is reserved. Phase 1 refuses it, and a later phase widens the validator with `create or replace`.
- Ids inside `target` are not foreign keys. A missing target makes the change "needs attention" at run time.

### The change validator (mirror of the TypeScript registry, §2)

```sql
-- One row per lever. A test keeps this equal to SANDBOX_LEVERS (packages/db/src/sandbox-levers.ts).
create function private.sandbox_levers()
returns table (id text, target text, selector text, ops text[], whole_run boolean, timed text, timing text, capped boolean)
language sql immutable
set search_path = ''
as $$
  values
    ('A1', 'none',       null,        array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('A6', 'id',         null,        array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('B1', 'none',       null,        array['set', 'multiply', 'add'], true,  'no',     null,     false),
    ('B2', 'id_or_none', null,        array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('B3', 'none',       null,        array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('C1', 'id',         '@busiest',  array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('D1', 'id',         null,        array['set'],                    true,  'people', 'month',  false),
    ('D2', 'id',         null,        array['set'],                    true,  'people', 'month',  false),
    ('D3', 'id',         null,        array['set'],                    false, 'people', 'monday', false),
    ('D4', 'id',         null,        array['set', 'multiply', 'add'], true,  'people', 'month',  true),
    ('D5', 'id',         '@busiest',  array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('E1', 'id',         '@heaviest', array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('E2', 'id',         '@heaviest', array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('E3', 'id',         '@heaviest', array['set', 'multiply', 'add'], true,  'splice', 'month',  true),
    ('E6', 'id',         null,        array['set'],                    true,  'splice', 'month',  true),
    ('X1', 'health',     null,        array['set', 'multiply', 'add'], true,  'no',     null,     false),
    ('X2', 'id',         '@busiest',  array['set', 'multiply', 'add'], true,  'no',     null,     false),
    ('X3', 'id',         null,        array['set', 'multiply', 'add'], true,  'no',     null,     false)
$$;
revoke all on function private.sandbox_levers() from public, anon, authenticated;

-- A real date that is a Monday, without raising (a check constraint must not throw). Defined before its caller:
-- SQL-language bodies are checked at creation.
create function private.is_monday(d text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  return pg_catalog.to_char(d::date, 'YYYY-MM-DD') = d and pg_catalog.date_part('isodow', d::date) = 1;
exception when others then
  return false;
end;
$$;

create function private.is_sandbox_change(c jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce((
    select
      not exists (select 1 from pg_catalog.jsonb_object_keys(c) k where k not in ('id', 'lever', 'target', 'op', 'value', 'from', 'params'))
      and coalesce(c ->> 'id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and pg_catalog.jsonb_typeof(c -> 'op') = 'string' and (c ->> 'op') = any (l.ops)
      and pg_catalog.jsonb_typeof(c -> 'value') = 'number' and abs((c ->> 'value')::numeric) <= 1000000000
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
        when 'D1' then (c ->> 'value')::numeric between 0.1 and 2
        when 'D2' then (c ->> 'value')::numeric = 0
        when 'D3' then (c ->> 'value') ~ '^[0-9]{1,2}$' and (c ->> 'value')::integer between 1 and 52
        when 'E6' then (c ->> 'value')::numeric = 1
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
$$;

-- The list: at most 200 changes and 100,000 characters, unique change ids, at most 4 solutions (E6), at most 6 distinct
-- `from` months among capped levers (each costs one extra run; D4 counts because it can fall back to a splice).
create function private.is_sandbox_changes(changes jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(changes) = 'array'
    and pg_catalog.jsonb_array_length(changes) <= 200
    and pg_catalog.octet_length(changes::text) <= 100000
    and not exists (select 1 from pg_catalog.jsonb_array_elements(changes) e where not private.is_sandbox_change(e))
    and (select pg_catalog.count(distinct e ->> 'id') = pg_catalog.count(*) from pg_catalog.jsonb_array_elements(changes) e)
    and (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(changes) e where e ->> 'lever' = 'E6') <= 4
    and (select pg_catalog.count(distinct e ->> 'from') from pg_catalog.jsonb_array_elements(changes) e
         join private.sandbox_levers() l on l.id = e ->> 'lever' where l.capped and e ? 'from') <= 6;
$$;
revoke all on function private.is_sandbox_change(jsonb), private.is_monday(text), private.is_sandbox_changes(jsonb) from public, anon;
grant execute on function private.is_sandbox_change(jsonb), private.is_monday(text), private.is_sandbox_changes(jsonb) to authenticated;
```

**SQL checks shape and only sanity bounds** (`|value| ≤ 1e9`). Today `scenarios` accepts any finite number, and migrated
rows must pass. The exact UI ranges are in the TypeScript registry. The engine clamps as it does today (`applyPatches`
reports `clamped`). The only exact ranges in SQL are the marker-derived ones that plans already enforced: D1 FTE 0.1–2,
D3 1–52 whole weeks, D2 value 0, E6 value 1.

**Limits in SQL:**

- 200 changes, 100,000 characters, 4 solutions and 6 capped change months per row;
- names up to 120 characters and unique per workspace, ignoring case and spaces;
- descriptions up to 2,000 characters;
- 900 scenarios per workspace, the same as the restore's limit, so a restore never trips it;
- a parent chain at most 5 deep.

**The caps on effective changes** (own plus inherited: 6 months and 4 solutions) are checked by the save action and the
runner, not by SQL. Editing a parent could push a child over them. The runner then shows an error for the child instead of
running it.

### Trigger, RLS and grants

```sql
create function private.sandbox_scenarios_before_write() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  at uuid;
  depth integer := 0;
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    -- The cap applies to people only: the migration and the library trigger run with no user.
    if auth.uid() is not null
      and (select pg_catalog.count(*) from public.sandbox_scenarios s where s.workspace_id = new.workspace_id) >= 900 then
      raise exception 'sandbox_scenarios: a workspace keeps at most 900 scenarios' using errcode = '23514';
    end if;
  elsif new.workspace_id is distinct from old.workspace_id then
    raise exception 'sandbox_scenarios: a scenario stays in its workspace' using errcode = '23514';
  end if;
  at := new.parent_id;
  while at is not null loop
    depth := depth + 1;
    if at = new.id then
      raise exception 'sandbox_scenarios: a scenario cannot build on itself' using errcode = '23514';
    end if;
    if depth > 5 then
      raise exception 'sandbox_scenarios: scenarios build on each other at most 5 deep' using errcode = '23514';
    end if;
    select s.parent_id into at from public.sandbox_scenarios s where s.id = at;
  end loop;
  return new;
end;
$$;
revoke all on function private.sandbox_scenarios_before_write() from public, anon, authenticated;
create trigger sandbox_scenarios_before_write before insert or update of parent_id, workspace_id on public.sandbox_scenarios
  for each row execute function private.sandbox_scenarios_before_write();

alter table public.sandbox_scenarios enable row level security;
revoke all on public.sandbox_scenarios from anon, authenticated;
grant select, insert, delete on public.sandbox_scenarios to authenticated;
grant update (name, description, parent_id, changes, horizon_months, start_date) on public.sandbox_scenarios to authenticated;

-- Viewers open and run saved scenarios; the Owner and Agency admins save (cut list item 9).
create policy "read sandbox_scenarios" on public.sandbox_scenarios for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert sandbox_scenarios" on public.sandbox_scenarios for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update sandbox_scenarios" on public.sandbox_scenarios for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete sandbox_scenarios" on public.sandbox_scenarios for delete to authenticated
  using (public.can_edit_workspace(workspace_id));
```

**Why the trigger has no permission check.** `forecast_plans_before_write` has one, but this trigger must not. The library
trigger below is SECURITY DEFINER and inserts rows while a user creates a workspace. At that moment `auth.uid()` is set, but
the creator may not have a membership yet. RLS already decides who may write.

**No `audit_mcp` trigger.** MCP is read-only (cut list item 5).

**Pay (B1).**

- No phase 1 lever stores an individual's pay.
- C1 is a role's rate (`roles.default_cost_rate`), which every member already reads.
- A Viewer's bundle names other people "Team member N" (`team_capacity`), so a person-targeted change shows a label to them.
- A typed hire name (`params.name`) is visible to Viewers.
- Read is therefore `can_read_workspace`. This deliberately relaxes `forecast_plans`, which hid plans from members because
  leave named a person. Viewers already read everyone's leave dates through `team_capacity`.
- A later lever that stores an individual's pay must be flagged `pay: "individual"` in the registry. Before it ships, its
  amount must be read through a SECURITY DEFINER reader that redacts it (the `team_capacity` pattern), not through this
  table's plain select.

### Data migration

Ids are kept: `scenarios.id` and `forecast_plans.id` become `sandbox_scenarios.id`. That keeps `issues.scenario_id` and
`runs.scenario_id` valid, and `?plan=<id>` bookmarks still resolve. The migration refuses to run if a scenario and a plan
share an id.

```sql
-- Patch → change. Every path the old grammar allowed maps to one lever; anything else stops the migration.
create function private.sandbox_change_from_patch(p jsonb) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  parts text[] := pg_catalog.string_to_array(p ->> 'path', '.');
  lever text;
  target text;
begin
  if pg_catalog.array_length(parts, 1) = 2 then
    lever := case p ->> 'path'
      when 'demand.leads_per_week' then 'A1'
      when 'demand.active_clients' then 'B1'
      when 'demand.churn_monthly' then 'B3'
      when 'finances.retainer' then 'B2'
      else case when parts[1] = 'health' then 'X1' end
    end;
    target := case when parts[1] = 'health' then parts[2] end;
  else
    target := parts[2];
    lever := case parts[1] || '.' || parts[3]
      when 'services.price' then 'B2'
      when 'services.mix_share' then 'A6'
      when 'services.churn_health_sensitivity' then 'X3'
      when 'roles.headcount' then 'D5'
      when 'roles.cost_rate' then 'C1'
      when 'roles.ongoing_hours' then 'X2'
      when 'people.fte' then 'D4'
      when 'steps.work_hours' then 'E1'
      when 'steps.wait_hours' then 'E2'
      when 'steps.rework_rate' then 'E3'
    end;
  end if;
  if lever is null then
    raise exception 'sandbox migration: no lever for the scenario path %', p ->> 'path';
  end if;
  return pg_catalog.jsonb_build_object('id', gen_random_uuid(), 'lever', lever, 'target', target, 'op', p -> 'op', 'value', p -> 'value');
end;
$$;

-- Marker → change, lossless: hire and solution dates are the 1st (→ 'YYYY-MM'); leave keeps its Monday.
create function private.sandbox_change_from_marker(m jsonb) returns jsonb
language sql
set search_path = ''
as $$
  select case m ->> 'kind'
    when 'hire' then pg_catalog.jsonb_build_object('id', m -> 'id', 'lever', 'D1', 'target', m -> 'role_id', 'op', 'set', 'value', m -> 'fte',
        'from', pg_catalog.left(m ->> 'date', 7))
      || case when pg_catalog.length(pg_catalog.btrim(coalesce(m ->> 'name', ''))) > 0
           then pg_catalog.jsonb_build_object('params', pg_catalog.jsonb_build_object('name', pg_catalog.btrim(m ->> 'name'))) else '{}'::jsonb end
    when 'leave' then pg_catalog.jsonb_build_object('id', m -> 'id', 'lever', 'D3', 'target', m -> 'person_id', 'op', 'set', 'value', m -> 'weeks',
        'from', m ->> 'date')
    when 'solution' then pg_catalog.jsonb_build_object('id', m -> 'id', 'lever', 'E6', 'target', m -> 'solution_id', 'op', 'set', 'value', 1,
        'from', pg_catalog.left(m ->> 'date', 7))
  end;
$$;

do $$
declare
  r record;
  candidate text;
  n integer;
  expected bigint := (select pg_catalog.count(*) from public.scenarios) + (select pg_catalog.count(*) from public.forecast_plans);
begin
  if exists (select 1 from public.scenarios s join public.forecast_plans p on p.id = s.id) then
    raise exception 'sandbox migration: a scenario and a plan share an id';
  end if;
  -- Per workspace: scenarios first, then plans, each oldest first. A name already taken (ignoring case and spaces)
  -- gets " (2)", " (3)", …, cut so the whole stays within 120 characters.
  for r in
    select s.id, s.workspace_id, pg_catalog.btrim(s.name) as name, s.description,
           coalesce((select pg_catalog.jsonb_agg(private.sandbox_change_from_patch(e.value) order by e.ordinality)
                     from pg_catalog.jsonb_array_elements(s.patch) with ordinality e), '[]'::jsonb) as changes,
           s.created_at, s.updated_at, s.created_by, 1 as source
      from public.scenarios s
    union all
    select p.id, p.workspace_id, pg_catalog.btrim(p.name), null,
           coalesce((select pg_catalog.jsonb_agg(private.sandbox_change_from_marker(e.value) order by e.ordinality)
                     from pg_catalog.jsonb_array_elements(p.markers) with ordinality e), '[]'::jsonb),
           p.created_at, p.updated_at, p.created_by, 2
      from public.forecast_plans p
    order by 2, 9, 6, 1
  loop
    candidate := r.name;
    n := 1;
    while exists (select 1 from public.sandbox_scenarios x
                  where x.workspace_id = r.workspace_id and pg_catalog.lower(pg_catalog.btrim(x.name)) = pg_catalog.lower(candidate)) loop
      n := n + 1;
      candidate := pg_catalog.left(r.name, 120 - pg_catalog.length(' (' || n || ')')) || ' (' || n || ')';
    end loop;
    -- parent_id is null: the old parent_scenario_id meant "copied from" (the copy holds the patches already), so
    -- turning it into "build on" would apply them twice.
    insert into public.sandbox_scenarios (id, workspace_id, name, description, parent_id, changes, horizon_months, created_at, updated_at, created_by)
    values (r.id, r.workspace_id, candidate, r.description, null, r.changes, 12, r.created_at, r.updated_at, r.created_by);
  end loop;
  if (select pg_catalog.count(*) from public.sandbox_scenarios) <> expected then
    raise exception 'sandbox migration: % rows expected', expected;
  end if;
end;
$$;
drop function private.sandbox_change_from_patch(jsonb);
drop function private.sandbox_change_from_marker(jsonb);

-- Links follow the ids.
alter table public.issues drop constraint issues_scenario_id_workspace_id_fkey;
alter table public.issues add constraint issues_scenario_id_workspace_id_fkey
  foreign key (scenario_id, workspace_id) references public.sandbox_scenarios (id, workspace_id) on delete set null (scenario_id);
alter table public.runs drop constraint runs_scenario_id_workspace_id_fkey;
alter table public.runs add constraint runs_scenario_id_workspace_id_fkey
  foreign key (scenario_id, workspace_id) references public.sandbox_scenarios (id, workspace_id) on delete set null (scenario_id);
```

**The library.** Keep seeding new workspaces, now into `sandbox_scenarios`. The change ids are fixed, so the restore's
library check can compare `changes` exactly. **They must not start with `00000000-0000-4000-8000-`**: that is
`PLACEHOLDER_PREFIX` (`packages/db/src/workspace-import.ts`), and the restore rewrites every occurrence of it.

```sql
drop trigger seed_scenario_library on public.workspaces;
create function private.sandbox_library() returns table (name text, description text, changes jsonb)
language sql immutable
set search_path = ''
as $$
  values
    ('Hire into the busiest role', 'One more full-time person in the role with the most work for its capacity.',
     '[{"id": "5a0d1b00-0000-4000-8000-000000000001", "lever": "D5", "target": "@busiest", "op": "add", "value": 1}]'::jsonb),
    ('Automate the heaviest step', 'Hands-on time down 60% on the step that takes the most hours each week, as automation or templates would.',
     '[{"id": "5a0d1b00-0000-4000-8000-000000000002", "lever": "E1", "target": "@heaviest", "op": "multiply", "value": 0.4}]'::jsonb),
    ('More leads', '25% more leads every week.',
     '[{"id": "5a0d1b00-0000-4000-8000-000000000003", "lever": "A1", "target": null, "op": "multiply", "value": 1.25}]'::jsonb),
    ('Downturn', '30% fewer leads a week, and client churn up by half.',
     '[{"id": "5a0d1b00-0000-4000-8000-000000000004", "lever": "A1", "target": null, "op": "multiply", "value": 0.7},
       {"id": "5a0d1b00-0000-4000-8000-000000000005", "lever": "B3", "target": null, "op": "multiply", "value": 1.5}]'::jsonb)
$$;
create function private.seed_sandbox_library() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.sandbox_scenarios (workspace_id, name, description, changes)
  select new.id, l.name, l.description, l.changes from private.sandbox_library() as l;
  return null;
end;
$$;
revoke all on function private.sandbox_library(), private.seed_sandbox_library() from public, anon, authenticated;
create trigger seed_sandbox_library after insert on public.workspaces
  for each row execute function private.seed_sandbox_library();
```

Rows that were migrated from the old library keep random change ids, so the restore's skip only matches libraries seeded
after this migration. That is harmless: the skip only avoids a duplicate on restore.

**`public.import_workspace_bundle` is REWRITTEN.** It must be a full copy of the body in `20270104000000_strip_followups.sql`,
changed only as follows, and it must be rewritten **before** `scenarios` is dropped:

- `allow`: the `scenarios` key becomes `sandbox_scenarios` with
  `["id","parent_id","name","description","changes","horizon_months","start_date","created_at"]`.
- `ref_cols`: `scenarios.parent_scenario_id` becomes `sandbox_scenarios.parent_id`. `issues.scenario_id` stays.
- `sections` and `list_sections`: `scenarios` becomes `sandbox_scenarios`.
- The limit check reads `p_plan -> 'sandbox_scenarios'`. The message keeps "900 scenarios".
- "Every scenario needs an id" reads `sandbox_scenarios`.
- The empty check reads `public.sandbox_scenarios s … not exists (select 1 from private.sandbox_library() l where l.name =
  s.name and l.changes = s.changes)`.
- The library skip loop matches on `s.name = sc ->> 'name' and s.changes = sc -> 'changes'`.
- The write section inserts into `public.sandbox_scenarios` with `jsonb_populate_recordset(null::public.sandbox_scenarios, $1)`.
  It is one statement, so the NO ACTION parent FK is checked at its end.
- The result key `skipped.scenarios` keeps its name, because the web restore screen reads it.

Then drop `private.scenario_library()`.

**The old tables are dropped in this migration,** after the count check:

```sql
drop table public.scenarios;          -- its audit_mcp and set_updated_at triggers and policies go with it
drop table public.forecast_plans;
drop function private.seed_scenario_library();
drop function private.forecast_plans_before_write();
drop function private.is_scenario_patch(jsonb);   -- only scenarios_patch_shape used it (verified at head)
drop function private.scenario_library();         -- after import_workspace_bundle no longer calls it
```

Why they are dropped:

- Every reader and writer moves in this phase, so a kept copy would only drift.
- Two homes would break "one scenario model".
- Nothing outside the list above references either table (verified with `pg_proc`, `pg_constraint` and `pg_trigger` at head).
- A frozen copy can't serve a rollback either: new scenarios with timed changes have no shape in the old tables.

**Rollback** is the Neon branch taken just before `migrate`, as the cutover and preview runbooks already do. Say so in the
header, with the full drop list for a database that holds no data worth keeping.

**Migration header.** Follow `20261219000000_forecast_plans.sql`.

- **Preflight:**
  - Nothing at or past `20270106000000`.
  - Count scenarios, plans, linked issues and linked runs per workspace.
  - Expect 0 rows from:
    `select distinct p ->> 'path' from scenarios, jsonb_array_elements(patch) p where (p ->> 'path') !~ '^(demand|finances|health|services|roles|people|steps)\.'`.
  - Expect 0 rows from `select s.id from scenarios s join forecast_plans p using (id)`.
  - Preview the renames with a `count(*) … group by workspace_id, lower(btrim(name)) having count(*) > 1` over the union.
- **Post-apply checks:**
  - RLS is on.
  - There are 4 policies.
  - The grants are as above.
  - Both FKs point at `sandbox_scenarios`.
  - `to_regclass('public.scenarios')` and `to_regclass('public.forecast_plans')` are null.
  - A new workspace gets 4 library rows.

Add the row to `docs/production-migrations.md`.

### The migration test

Add `packages/db/test/sandbox-migration.test.ts`, in the style of `three-roles-migration.test.ts`: `createTestDb({ upTo:
"20261231000000" })`, insert rows, `applyMigrations(db.client)`.

At the base, insert:

- scenarios with every path family: `demand.*`, `finances.retainer`, `health.*`, `services.*.{price,mix_share,churn_health_sensitivity}`,
  `roles.*.{headcount,cost_rate,ongoing_hours}`, `people.*.fte` and `steps.*.{work_hours,wait_hours,rework_rate}`;
- both selectors;
- an empty patch;
- a `parent_scenario_id` copy;
- two scenarios named `Downturn`, a plan named ` downturn `, and two 120-character names that differ only in case;
- plans with a hire with a name, a hire without one, a leave and a solution marker (insert a solution row first);
- an issue and a run linked to a scenario.

Assert:

- the count;
- that ids are kept;
- the exact `changes` of each row (except the random ids of patch-derived changes);
- that marker ids are kept;
- that `parent_id` is null;
- the renamed names and that they stay at or under 120 characters;
- that the issue and run links survive;
- that the old tables and functions are gone;
- that the rewritten restore still restores the Northbeam backup (`import-bundle.test.ts` covers the rest);
- that a new workspace gets the library;
- that a Viewer reads the migrated plans.

---

## 2. The lever registry

**Where.** One file, `packages/db/src/sandbox-levers.ts`, exported from `packages/db/src/index.ts`.

- The database package already carries the lever-kind ids (`LEVER_KIND_IDS` in `share.ts`).
- Both `apps/web` and `packages/mcp` import it.
- A database test can compare it with `private.sandbox_levers()`.
- Nothing else defines levers for the sandbox. `lib/scenarios/levers.ts` (`buildLevers`) stays the process-page slider
  generator. Each of its `Lever.path` values maps to a registry id through `leverOfPath` below.

**Types:**

```ts
export type SandboxLeverId = "A1" | "A6" | "B1" | "B2" | "B3" | "C1" | "D1" | "D2" | "D3" | "D4" | "D5" | "E1" | "E2" | "E3" | "E6" | "X1" | "X2" | "X3";
export interface SandboxChange { id: string; lever: SandboxLeverId; target: string | null; op: PatchOp; value: number; from?: string; params?: { name: string } }
export interface SandboxLever {
  id: SandboxLeverId;
  group: "A" | "B" | "C" | "D" | "E" | "X";     // design groups; X = kept for migrated rows, never offered
  label: string; description: string;
  target: "none" | "service" | "service_or_none" | "role" | "person" | "step" | "solution" | "health_rule";
  selector?: "@busiest" | "@heaviest";
  ops: readonly PatchOp[];
  /** UI ranges per op (the app clamps; SQL only sanity-checks). */
  range: Partial<Record<PatchOp, { min: number; max: number; step: number }>>;
  unit: "per_week" | "clients" | "share" | "money" | "people" | "fte" | "hours" | "weeks" | "none";
  wholeRun: boolean;
  timed: false | "people" | "splice";               // later phases add "channel"
  timing?: "month" | "monday";
  capped: boolean;                                  // its timed months count toward the 6
  /** How it reaches the engine. */
  patchPath?: (target: string | null) => string;     // whole-run patch (and the spliced segment's patch)
  people?: "hire" | "leaver" | "leave" | "fte";      // the people-over-time edit
  solution?: true;
  kind: string | null;                              // Settings → Levers hide-list id (LEVER_KIND_IDS), null = always shown
  pay: "none" | "role" | "individual";
  offered: boolean;                                 // false: runs when saved, never offered for a new change
  /** Why it would not move the result in this model, or null (design suggestion 8). */
  applies?: (model: EngineModel) => string | null;
}
export const SANDBOX_LEVERS: readonly SandboxLever[];
export function parseChanges(input: unknown): { ok: true; changes: SandboxChange[] } | { ok: false; error: string };
export function changesFromPatch(patches: readonly ScenarioPatch[]): SandboxChange[];   // seed, restore planner, process-page store
export function patchOf(change: SandboxChange): ScenarioPatch | null;                   // for patch levers
export function leverOfPath(path: string): { lever: SandboxLeverId; target: string | null } | null;
```

`parseChanges` mirrors `private.is_sandbox_changes` exactly. The test runs the same table of cases through both.

### Every lever available today, mapped to the design's ids

| ID | Today | Target | Ops (UI range) | Whole run | Timed | Hide-list kind | Pay | Offered in phase 1 |
|---|---|---|---|---|---|---|---|---|
| A1 Opportunities | patch `demand.leads_per_week` (qualified leads a week, the lead sources' total) | none | set 0–10,000 a week, entered a month (×52/12); × 0–5 | patch | splice | `demand.enquiries` | none | yes |
| A6 Traffic by type | patch `services.<id>.mix_share` (no slider today) | service | set ≥ 0, shown as % of all types; × 0–5 | patch | splice | none (always shown) | none | when there are 2 or more services |
| B1 Clients on the book | patch `demand.active_clients` | none | set 0–100,000 whole | patch | no | `clients.count` | none | only without a client roster (`roster ? 0 : model.activeClients`, simulate.ts) |
| B2 Fees | patch `services.<id>.price`, or `finances.retainer` with no services | service, or none | set 0–10,000,000; × 0–5 | patch | splice | `finances.prices` | none | yes. New clients' fee only: client-group clients keep `client_groups.fee` (`withClientGroups`, clients.ts) |
| B3 Base churn | patch `demand.churn_monthly` | none | set 0–1 (shown %); × 0–5 | patch | splice | `clients.churn` | none | only without a client roster |
| C1 Role cost | patch `roles.<id>.cost_rate` | role or `@busiest` | set ≥ 0; × 0–5 | patch | splice | `finances.roleCost` | role | **no**: no phase 1 output uses cost. It is offered in phase 2 with labour cost |
| D1 Hire | plan marker `hire` | role | set = FTE 0.1–1.5 (0.1–2 accepted) | person from the start | people over time | `people.starters` | none | yes |
| D2 Someone leaves | (new as a lever; the mechanism is `people.end_date` → `until`) | person | set 0 | gone from the start | people over time | `people.headcount` | none | yes, with named people |
| D3 Leave | plan marker `leave` | person | set = 1–52 weeks | — | people over time, on a Monday | `people.leave` | none | yes, with named people |
| D4 FTE change | patch `people.<id>.fte` | person | set 0–1.5; × 0–2 | patch | two person rows (splice fallback) | `people.hours` | none | yes, with named people |
| D5 Headcount by role | patch `roles.<id>.headcount` | role or `@busiest` | set 0 – (count + 20); + | patch | splice | `people.headcount` | none | yes |
| E1 Step time | patch `steps.<id>.work_hours` | step or `@heaviest` | × 0.1–2; set ≥ 0 h | patch | splice | `process.time` | none | yes |
| E2 Waiting time | patch `steps.<id>.wait_hours` | step | × 0.1–2; set 0–80 h | patch | splice | `process.wait` | none | yes |
| E3 Rework | patch `steps.<id>.rework_rate` | step | × 0.1–2; set 0–0.95 | patch | splice | `process.rework` | none | yes |
| E6 Solution goes live | plan marker `solution` (D46/D48) | solution | set 1 | live from the start (one segment) | splice | none (always shown) | none | yes, at most 4 |
| X1 Client health rules | patch `health.<field>` | `initial`, `recover`, `late_penalty`, `missed_penalty` | as saved | patch | no | — | none | no (Austin: health is not a lever) |
| X2 Client hours per client | patch `roles.<id>.ongoing_hours` | role or `@busiest` | as saved | patch | no | — | none | no (delivery hours are not a lever) |
| X3 Churn sensitivity to health | patch `services.<id>.churn_health_sensitivity` | service | as saved | patch | no | — | none | no (it becomes part of B4) |

- Every `PATCH_FIELDS` path (`packages/engine/src/scenario.ts`) maps to exactly one row, and the test asserts that this
  is exhaustive.
- The UI ranges come from today's sliders (`buildLevers` in `lib/scenarios/levers.ts`, `PLAY_CAPS`) and the engine clamps
  (`MAX_REWORK`, FTE 0–2).

**Settings → Levers.**

- A hidden kind is not offered for a new change.
- A saved change of a hidden kind still applies and shows "hidden in Settings → Levers". Otherwise hiding a kind would
  quietly change saved scenarios.
- A lever with `kind: null` (A6, E6) is always shown, as `isLeverShown` treats a lever with no kind today.
- No new kind ids in phase 1. Adding one means changing `LEVER_KINDS`, `LEVER_KIND_IDS`, `private.lever_kind_ids()`
  and their tests.
- `LeverControl` gets `"sandbox"`, meaning "changed in the Sandbox". `people.starters`, `people.leave` and
  `finances.roleCost` move from `"later"` to it. `levers-settings.tsx` shows the new control.

**Design levers NOT available in phase 1:**

- A1 per lead source; A2 lead quality; A3 conversion rate (it needs the `conv` channel and new outputs); A4 sales cycle;
  A5 client value ranges; A7 seasonality; A8 growth; A9 a scenario's own market schedule.
- B1 per type (`client_groups` count); B2 for existing clients' fees; B3 per type; B4 churn drivers as chances; B5 price
  rise with its churn risk and the trade-off view. A B2 change from a month is the price change without the churn effect.
- C1 is not offered (see above); C2 overheads; C3 hourly billing.
- D1 ramp-up; D5 timed through hires and leavers (phase 1 splices it); D6 working week; D7 speed; D8 skills;
  D9 hiring delay; D10 pay inflation.
- E4 routing; E5 who does a step; E7 work in progress at the start; E8 variability.
- F2 start month in the UI (the column exists); F3 precision.
- Monthly channels for any timed lever. Time by purpose (G). Profit and the new outputs. Goal seek, tornado, exports,
  share links to a scenario, and MCP `list_scenarios`.

**How later phases plug in.**

- **A new lever** needs:
  - a registry row;
  - a `PATCH_FIELDS` field, plus its `applyPatches` case, where it is a patch;
  - a `private.sandbox_levers()` row, by `create or replace`;
  - the mirror test.
- **A channel-timed lever** sets `timed: "channel"`. The runner writes its month values into the scenario's market-factor
  copy instead of adding a segment, so no extra run is needed. The cap only counts `capped` levers, so channel levers cost
  nothing against it.
- **Extras per lever** go in `params`. Examples: A5 `{low, mode, high}`, B4 `{chance, effect}`, D1 `{ramp_months}`. Each
  widens the `params` case in `is_sandbox_change`.
- `until` is enabled by relaxing one `case` branch.
- F3 can be a `reps` column added later.
- **Profit, time by purpose and goal seek** need new engine outputs and a new view, not a new table shape. Goal seek writes
  an ordinary change.
- **When an individual-pay lever arrives**, it needs a redacting reader (see "Pay" above).

---

## 3. The runner

A scenario runs against today's live model (`loadLiveProcess`), never a stored result. Put it in a new folder,
`apps/web/src/lib/sandbox/`, and move code there with `git mv` where it is reused.

1. **Effective changes.** `effectiveChanges(scenarioId, rows)` walks `parent_id` up to the root (at most 5 deep; a cycle or
   missing parent is an error). It returns the changes root first, each tagged with the scenario it came from. This is
   what runs, and what the change list shows (inherited changes are read-only).
2. **People over time.** `applyPeopleChanges(bundle, changes, startDate)` replaces `applyPlanPeople` (`lib/forecast/plan.ts`)
   and keeps its behaviour for hires and leave:
   - **D1:** a `PersonRow` with id = change id, `start_date` = the 1st of `from` (null when whole-run), `fte` = value and
     the name from `hireNames`, plus one `person_roles` row.
   - **D3:** a `person_leave` row from `from` to `leaveEnd(from, weeks)`, merged with overlapping leave as today.
   - **D2:** the person's `end_date` becomes the day before the 1st of `from` (whole-run: the day before the start date,
     which drops them from the model). An earlier `end_date` is kept.
   - **D4 timed:** the person's `end_date` becomes the day before the month. A copy row, with id = change id, starts on the
     1st with the new FTE (`set`, `multiply` or `add` on the old FTE, clamped to 0–2). It copies their `person_roles`,
     `person_skills`, `personCapacityFactors` and the leave that falls after the month.
   - **D4 fallback.** If the person is pinned to a step (`steps.person_id`) or has `clientAssignments`, D4 timed is not
     split. It becomes a spliced `people.<id>.fte` patch instead, which is why D4 is `capped`.
   - **D4 whole-run** is the patch.
   - Missing or inactive targets become `ChangeProblem { changeId, message }` and are skipped, as markers are today.
3. **Segments.** `scenarioSegments(bundle, changes, solutions, startDate, bounds, hoursPerWeek)` replaces `planSegments`.
   - Classify each change by registry `timed` and `from`. The month index comes from `from` → `${from}-01` →
     `hoursToDate` → `bounds`, the same rule `planSegments` uses.
   - A `from` on or before the start month is month 0, the whole run. One at or after the horizon goes in `later` and is
     left out.
   - Segment starts are {0} ∪ {month of each capped timed change in the horizon}. If there are more than 7 segments, the
     result is an error, "more than 6 change months", and nothing runs.
   - Each segment's bundle is the people-applied bundle with every solution live by its start (`withSolution`; for one
     process the latest wins, as now).
   - Each segment's patches, in change order (parent's first): every whole-run patch, every timed patch whose month is at
     or before the segment's start, and each winning solution's `lever_changes` at its E6 change's position.
   - The segment records `patchChangeIds` alongside, so engine issues map back to changes.
4. **Model.** `scenarioModel(bundle, months, startDate, patches)` is `forecastModel` (`lib/forecast/forecast.ts`) without
   `withLeverChanges` dropping problems.
   - It calls `toEngineModel(bundle, { startDate, planned: true })`, then `applyPatches`, then `horizonWeeks(months)` and
     `calendarMonthStarts`.
   - It returns `issues` mapped to change ids. A `missing_target` or `invalid` change is skipped and listed (design: "shows
     that change as broken and skips it, with a note"). A `clamped` one is noted.
   - `forecastModel` stays as it is for the People page and the Overview.
   - Retired steps (`retiredSteps` in `lib/scenarios/broken.ts`) name what replaced a missing step in the note, using
     `checkScenario`.
5. **Runs.** `useScenarioRun({ bundle, changes, solutions, months, startDate })` replaces `usePlanForecast`
   (`lib/forecast/use-plan-forecast.ts`) with the same shape (`status`, `run`, `problems`, `later`, `error`, `progress`).
   - It calls `runSegments(sharedSimPool(), …)` (`lib/forecast/sim-pool.ts`) and then `spliceMonthly`
     (`lib/forecast/splice.ts`), both unchanged.
   - Same seed (`SEED` 1, `REPS` 30) as the live run, so differences come from the scenario.
   - The live run is seeded into the pool (`runKey`), so "No changes" and any segment equal to it cost nothing.

**Performance (PRD §6.7).** The per-run targets are unchanged: 12 months of the large model in under 5 s, and the 13-week
targets scaled by horizon as `horizon-performance.test.ts` does. A scenario costs one run per segment.

- **No capped timed changes:** 1 run, within the PRD target.
- **Worst case (6 change months):** 7 runs on the page's 3 workers (`POOL_SIZE`), about 3 rounds. For seeded Northbeam at
  12 months that is about 4 × 250 ms per run, so about 3 s.
- **Compare of 3 at the worst case:** 21 runs plus the free live run, about 7 rounds.

How the budget is met:

- the 6-month cap;
- shared and cached runs (`runKey`). Raise `CACHE_LIMIT` in `sim-pool.ts` from 24 to 40 so a full compare stays cached;
- people over time instead of splicing for D1–D4;
- debounce (150 ms, as now) and cancelling stale runs;
- progress shown per column.

Add `apps/web/test/sandbox-performance.test.ts`, tagged `perf`. Build a Northbeam scenario with 6 capped months plus
D1–D3 changes, run its 7 segments with `simulate(model, 30, 1, { monthly: true, monthStarts })`, and assert:

- each run takes less than 4 × 250 ms at 12 months;
- the 7 runs together take less than 7 s sequentially (under 3 s on 3 workers).

Record the numbers in `docs/engine-versioning.md` next to "24-month horizon".

---

## 4. UI

### Routes and files

- **`app/w/[slug]/sandbox/page.tsx`** and **`loading.tsx`** replace `app/w/[slug]/forecast/*`.
  - The server component keeps today's "nothing published" branch (`NotPublished`, `createProcess` for editors).
  - Then, in one `Promise.all`, it loads:
    - `loadWorkspaceIssues`, `loadWorkspaceSources` and `canEditWorkspace`;
    - `loadWorkspaceSandboxScenarios(ws)` (new in `lib/data.ts`, replacing `loadWorkspaceForecastPlans`), **for every
      role**;
    - `loadWorkspaceSolutions(ws)`, for every role, since Viewers read solutions under RLS;
    - `loadWorkspaceLeverSettings(ws)`;
    - `loadWorkspaceAnalysisRules(ws)`, new in `lib/data.ts`: `loadAnalysisRules(await getDb(), ws)` with the defaults on
      error.
  - It passes `mode={canEdit ? "live" : "readonly"}`.
- **`app/demo/sandbox/page.tsx`** replaces `app/demo/forecast/page.tsx`.
- **Redirects.** Add to `redirects` in `next.config.ts`, as the `library` → `blocks` redirect does:
  `/w/:slug/forecast` → `/w/:slug/sandbox` and `/demo/forecast` → `/demo/sandbox`, both `permanent: false`. The query
  string carries over.
- **Nav.** In `lib/shell/nav.ts`, `key: "sandbox"`, label "Sandbox", path `/sandbox`. Rename the `forecast` icon as you
  like.
- **Links.** Point `forecastHref` (`workspace-overview.tsx`, `demo-overview.tsx`) and the People page's
  `forecast={{ href }}` at `/sandbox`.
- **Monitoring.** Add "sandbox" and "scenario(s)" to the allowed words in `lib/monitoring/words.ts` if they aren't there.

### Components

Put them in a new folder, `components/sandbox/`.

- **`sandbox-view.tsx`** replaces `components/forecast/forecast-view.tsx` and keeps its structure:
  - **Header:** `PageHeader` "Sandbox", with the horizon picker in `actions`.
  - **Scenario bar.** `scenario-bar.tsx` comes from `plan-bar.tsx`; keep `ConfirmDialog` and `NameDialog`.
    - It has a picker ("No changes", then the saved scenarios by name).
    - For admins it adds New, Rename, Duplicate, Build on, Delete, Save, Save as new and Compare.
    - "Duplicate" copies the changes and the parent. "Build on" makes a new scenario with `parent_id` set to this one and no
      changes.
    - Delete with children is refused, naming them.
  - **Changes.** `change-list.tsx` is new.
    - Inherited changes come first, read-only and tagged "from <parent>". Then own changes, each with edit and remove.
    - "Needs attention" lists broken changes with the reason. "After the horizon" lists `later`.
    - "Add change" opens `change-dialog.tsx`, which replaces `plan-marker-dialog.tsx`. It has the lever by group (A–E,
      offered and shown kinds only, each with its `applies` reason when greyed), the target, the op and value with the
      registry range, and **When**: "Whole run" or "From [month]" (Monday for leave). The month options and defaults are
      the ones `monthOptions` builds today.
  - **Who gets too busy, and when.** `InsightsSection` with `forecastInsights(model, result, rules, start)`. `rules` is
    the workspace's own; drop `const rules = ANALYSIS_DEFAULTS` in the view.
    - Below it, "With this scenario": the `withThisPlan` logic, renamed.
    - The Help text "You can change it in Settings, Analysis rules" goes, because no such page exists.
  - **Month by month.** `ForecastTimeline`, `TimelineLegend` and `PlanLane` (`forecast-timeline.tsx`), reused.
    - The lane shows every timed change. `laneMarkers` moves to `lib/sandbox/lane.ts` and takes changes.
    - It can be dragged by admins, except on a phone. Dragging moves `from`: month snap, or week snap for leave.
- **`sandbox-compare.tsx`** replaces `plan-compare.tsx`. It shows up to 3 scenarios plus "No changes", which is always the
  first column.
  - **Tiles:** last month's MRR, clients at risk, months too busy and late tasks. Each shows the column's value and its
    difference from "No changes".
  - **Charts,** one per measure: MRR, active clients per type, clients at risk per group, and busy per role.
  - `compare-chart.tsx` generalises `PlanCompareChart` from `a`/`b` to `series: { name, values }[]` (up to 4 bands).
  - `lib/sandbox/compare.ts` (`compareSandbox`) generalises `comparePlans` to N columns, with `diff` against column 0.
    `cutoffs` come from the workspace rules.
  - A column that fails shows its error and the others still show.
- **Horizon.** Extend `HorizonPicker` with optional `options` (default `HORIZON_MONTHS`) and `custom?: { min: 1; max: 24 }`.
  The sandbox passes `[3, 6, 12, 24]` and the custom option, a number field from 1 to 24. Other pages are unchanged. Update
  its story (`stories-coverage.test.ts` lists it).
- **Delete:** `forecast-view.tsx`, `plan-bar.tsx`, `plan-compare.tsx`, `plan-compare-chart.tsx` and
  `plan-marker-dialog.tsx`.
- **Keep:** `forecast-timeline.tsx`, and `forecast-panel.tsx` (People page).
- **Library code.**
  - Move `lib/forecast/{plan,lane,compare,use-plan-forecast,plan-save,plans-demo}.ts` to `lib/sandbox/` as described.
  - Keep `lib/forecast/{forecast,timeline,positions,splice,sim-pool,demo,help}.ts`.
  - `parsePlanInput` and the plan limits go; `parseSandboxInput` is in `lib/sandbox/validate.ts`.

### URL state

- `?scenario=<id>` opens a scenario. It also reads the old `?plan=<id>`, since ids were kept.
- `?compare=<id>[,<id>[,<id>]]` lists up to 3 saved ids. "No changes" is implicit.
- `?horizon=<1–24>`. Without it, the open scenario's `horizon_months`, else 12.
- Unknown or deleted ids are dropped silently, as today.
- Writes use the existing `writeUrl` (`router.replace(…, { scroll: false })`).

### Empty states

- **Nothing published:** `NotPublished`, as today.
- **No scenarios:**
  - Admins see "No scenarios yet. Start one to try a change: a hire, a price change, a solution going live." with
    **New scenario**.
  - Viewers see "No saved scenarios yet. An Agency admin can save one for you to run."
- **A scenario with no changes:** "No changes yet" with **Add change** for admins. Viewers see "This scenario has no
  changes".
- **Compare with no saved scenarios:** disabled, with the reason.
- **A model that can't be simulated:** today's `built.error` card.

### What Viewers see

- **They can:** pick and open any saved scenario, see its changes read-only, run it at any horizon including custom, and
  compare up to 3 with "No changes". They see the alerts but can't acknowledge them (`canEdit={false}`).
- **They can't:** New, Rename, Duplicate, Build on, Delete, Save, Add change, or drag on the lane.
- **What they're shown:** people as their bundle names them (labels), and no pay anywhere.
- **Different numbers:** their numbers can differ slightly from an admin's, because their bundle carries no capacity factors
  (`usesCapacityFactors`). That is true on the Forecast today. Say so in a Help line.

### Next 16 notes

Read `node_modules/next/dist/docs/` for anything new.

- Pages take `PageProps<"/w/[slug]/sandbox">` and `await props.params`, as `forecast/page.tsx` does.
- Redirects belong in `next.config.ts` `redirects`. No `proxy.ts` change.
- A `"use server"` file may export only async functions. Error mapping goes in `lib/sandbox/save-errors.ts`, as
  `plan-save.ts` does today.
- `useSearchParams` on the prerendered `/demo/sandbox` renders the tree on the client up to the nearest `Suspense`
  (`01-app/03-api-reference/04-functions/use-search-params.md`). Keep today's behaviour, or wrap the view in `Suspense`
  with the page skeleton. Check the build output for the warning either way.
- Server actions return plain results. Nothing calls `refresh`, because the view updates its own list, as plans do.

---

## 5. Actions, MCP and demo

**`app/w/[slug]/sandbox-actions.ts`** replaces `forecast-plan-actions.ts`. It runs as the signed-in user through RLS.

- **`saveSandboxScenario(workspaceId, scenarioId | null, input, expectedUpdatedAt)`**
  - `input = { name, description, parent_id, changes, horizon_months }`.
  - It returns `{ status: "ok"; scenario } | { status: "error"; message }`.
  - Checks, in order, as `savePlan` does: `isId`; `getSessionUser`, or the signed-out message; `getDb`.
  - It loads the workspace's `solutions(id, process_id)` and `processes(id, name)`, for "two solutions for one process in
    one month", as `savePlan` does. It also loads `sandbox_scenarios(id, parent_id, changes)`, for the effective-cap
    check on this scenario and its descendants and for parent validity.
  - It runs `parseSandboxInput`.
  - An update is compare-and-set: `.where("updated_at", "=", expectedUpdatedAt)`. No row back gives
    `CHANGED_ELSEWHERE`.
  - Rename, Duplicate and Build on are all saves.
- **`deleteSandboxScenario(workspaceId, id)`.** A 23503 error means "Other scenarios build on this one: <names>. Delete
  them or change what they build on first."
- **`sandboxFailure(error)`** maps database errors:
  - 23505 → "A scenario with that name already exists."
  - 23514 → the limit's own words: 900 scenarios, 6 months, 4 solutions, 5 deep, building on itself.
  - 42501 → "You don't have permission to change scenarios here."
- **The process page keeps its lever panel and library,** now backed by `sandbox_scenarios`.
  - `scenario-actions.ts` `createScenario`, `deleteScenario` and `updateScenarioPatch` keep their names and signatures.
  - They write `changes = changesFromPatch(patch)`, with `parent_id` null.
  - `updateScenarioPatch` only touches rows with no parent and only patch changes.
  - In `scenario-panel.tsx`, `onDuplicate` passes `parent_scenario_id: null`, so a copy no longer becomes "build on".
  - `loadScenarios` (`packages/db/src/queries.ts`) keeps its `ScenarioRow[]` return. It now reads `sandbox_scenarios` and
    returns only **standalone whole-run scenarios**: no parent, every change a patch lever with no `from`.
    `patch = changes.map(patchOf)` and `parent_scenario_id: null`.
  - This keeps the issues register (`lib/issues/register.ts`), broken-scenario issues (`process-issues.tsx`,
    `newlyBroken`), share snapshots (`ProcessShare.scenarios`, so `share_snapshot_problem` is unchanged) and the
    MCP tools unchanged.
  - The library panel gets an "Open in Sandbox" link.
- **Settings → Levers.** `SavedScenarios` goes from `settings/levers/page.tsx`, because the Sandbox manages scenarios. Put a
  one-line link to the Sandbox in its place.
- **Backups.**
  - `BUNDLE_TABLES` (`workspace-bundle.ts`): `scenarios` becomes `sandbox_scenarios: T("sandbox_scenarios")`.
  - `IMPORT_COLUMNS` and `IMPORT_REFS`: `sandbox_scenarios` with `R("parent_id", "sandbox_scenarios", "null")`, ordered
    parents first. `issues.scenario_id` refs `sandbox_scenarios`.
  - `planWorkspaceImport` converts an older backup's `scenarios` (patch rows) with `changesFromPatch`, sets `parent_id`
    null and de-duplicates names as the migration does.
  - It drops E6 changes, because solutions are not restored, and warns.
  - Ids inside `changes` are remapped by the planner's existing UUID replacement.
  - `checkWorkspaceBundle` accepts either section.
- **Seed.** `seed.ts` writes `sandbox_scenarios`. `northbeamScenarios()` stays as `ScenarioRow[]` for the demo process
  page. Add `northbeamSandboxScenarios()` (the four converted, plus the two demo plans converted) and regenerate
  `seed.sql`.

**MCP.**

- Phase 1 adds no tool and keeps every tool read-only.
- `list_scenarios` does not exist today. `run_scenario` (`packages/mcp/src/tools.ts`) takes `overrides` (patches) and
  never reads saved scenarios. Both stay as they are. A saved-sandbox `run_scenario` and `list_scenarios` are phase 5,
  when the pure runner moves to `packages/db`.
- `compare_scenarios`, `check_robustness` and `list_issues` (`analysis-tools.ts`) keep working through the `loadScenarios`
  adapter. Add to `scenarioRefs`' description: "(a whole-run scenario; one with changes from a month runs only in the
  Sandbox)".
- `packages/mcp/test/read-only.test.ts` must still pass unchanged.

**Demo.**

- `/demo/sandbox` has `mode="demo"` and full admin controls. It saves in the tab only.
- `lib/sandbox/demo.ts` (from `plans-demo.ts`, the `useSyncExternalStore` pattern) is seeded with `DEMO_PLANS`
  converted, keeping their ids ("Hire in January"; "Hire in March" with its solution in April), plus one "build on"
  example: "Hire in March, then more leads".
- `DEMO_FORECAST_START` and `demoForecastBundle()` stay. Update the demo note text. A phone is read-only, as now.

---

## 6. Tests

**Database (`packages/db/test`):**

- **New `sandbox-scenarios.test.ts`.**
  - Run one table of cases through `private.is_sandbox_changes` and `parseChanges` and check they agree. Cover:
    - every lever with whole-run and timed changes;
    - a bad Monday, `2026-02-30`, a `from` on a whole-run-only lever, and a wrong selector;
    - a target on a `none` lever;
    - `params` on a lever other than D1;
    - duplicate change ids, 201 changes, 5 solutions, and 7 capped months (6 plus a D1 month is fine);
    - `until`.
  - `private.sandbox_levers()` equals `SANDBOX_LEVERS`.
  - Names are unique ignoring case and spaces.
  - Parents: another workspace's parent is refused; so are a cycle and a sixth level; deleting a parent with a child gives
    23503; deleting the workspace cascades.
  - The 900 cap applies for a user only.
  - RLS for the Owner, an Agency admin, a Viewer, a guest and anon: read, insert, update (columns) and delete.
  - The library is seeded for a new workspace.
  - Issue and run FKs set null on delete.
- **New `sandbox-migration.test.ts`:** see §1.
- **`role-matrix.test.ts`:** the `forecast_plans` entry becomes `sandbox_scenarios`, read by every member.
- **Go:** `forecast-plans.test.ts`, and in `scenarios.test.ts` the "patch shape" and "a multiply patch survives…" groups
  that test `is_scenario_patch`. Move its "scenario library" and RLS cases into the new file.
- **Update:**
  - `workspace-bundle.test.ts` and `workspace-bundle-reader.test.ts`;
  - `workspace-import.test.ts`, `workspace-import-plan.test.ts`, `workspace-import-plan-db.test.ts` and
    `workspace-import-large.test.ts`, plus an old-backup `scenarios` case;
  - `import-bundle.test.ts` and `issues.test.ts` (the scenario link);
  - `workspaces.test.ts` (the library);
  - `share-field-classes.test.ts`, if it names the table.
- **Also:** `json-columns.test.ts` and `function-types.test.ts` after `gen:types`.

**Engine:** no change and no ENGINE bump. The goldens are untouched.

**Web unit (`apps/web/test`):**

- **`sandbox-run.test.ts`** comes from `forecast-plan.test.ts`. Keep the `spliceMonthly`, `withSolution` and `positions`
  groups and their "a solution marker applies…" checks. Rewrite the rest for:
  - `effectiveChanges`;
  - `applyPeopleChanges`: D1, D2, D3 merge, D4 split and D4 fallback;
  - `scenarioSegments`: whole-run patches in every segment, a timed patch from its month only, solutions, `later`, and the
    cap error;
  - `scenarioModel` mapping issues to change ids.

  The `parsePlanInput` group goes.
- **`sandbox-levers.test.ts`:**
  - every `PATCH_FIELDS` path maps to one lever;
  - `changesFromPatch` and `patchOf` round-trip;
  - the kinds are a subset of `LEVER_KIND_IDS`;
  - the `applies` reasons;
  - the `loadScenarios` adapter's filter.
- **`sandbox-compare.test.ts`:** from `comparePlans`, for N columns.
- **`actions-database.test.ts`:**
  - the plan and scenario action cases become `saveSandboxScenario`: insert, compare-and-set conflict, a Viewer refused,
    a duplicate name, the effective cap with a parent;
  - `deleteSandboxScenario` with children;
  - the process-page `createScenario` writes a sandbox row.
- **Edits to existing tests:**
  - `role-gating.test.ts`: `["the Sandbox", PAGE("sandbox")]`.
  - `shell-nav.test.ts`: key `sandbox`.
  - `lever-catalogue.test.ts`: the `"sandbox"` control.
  - `horizon-performance.test.ts`: unchanged; the picker's default options stay.
  - `e2e/routes.ts`: `/demo/sandbox`.
  - `stories/shared/skeletons.stories.tsx`: title "Sandbox".
- **Unchanged:** `sim-pool.test.ts` (except the cache limit, if it's asserted), `forecast.test.ts`,
  `broken-scenarios.test.ts` and `scenarios.test.ts` (web).
- **New:** `sandbox-performance.test.ts`, tagged `perf`.

**Browser:**

- `sandbox-browser.test.ts` and `sandbox-harness/entry.tsx` replace `forecast-plan-browser.test.ts` and `forecast-harness`.
- Cases:
  - in the demo: create, rename, duplicate, build on (an inherited change is shown read-only), and delete (refused with a
    child);
  - add a whole-run change and a timed one, and drag the timed one;
  - leave on a Monday;
  - a solution from a month;
  - the horizon presets and custom 1, 24 and 25 (refused);
  - compare 3 plus "No changes", with a failing column;
  - a Viewer: no edit controls, but can run and compare;
  - a phone is read-only;
  - `?plan=` opens the migrated scenario.
- Sizes 1440, 640 and 400 px. No console errors.
- MCP tests that insert into `scenarios` (`end-to-end.test.ts`, `db-manual-entry.test.ts`) insert into `sandbox_scenarios`
  instead.

---

## 7. Out of scope

Leave these alone in phase 1:

- the levers marked NOT available above, and every engine change (channels, new outputs, `hire` and `pay` factors);
- profit;
- time by purpose;
- goal seek, tornado, export and scenario share links;
- the start month UI and precision (F2, F3);
- the MCP `list_scenarios` tool and running saved scenarios through `run_scenario`;
- moving the runner to `packages/db`;
- client health, named clients joining or leaving, and delivery hours as levers;
- the Overview's and People page's alert thresholds (they keep `ANALYSIS_DEFAULTS`; see Q1).

## 8. Done

- The migration `20270106000000_sandbox_scenarios.sql` applies on a fresh database and at base-then-migrate with real-shaped
  rows (test). It is also re-run on a throwaway Neon branch of Preview, which holds the real export: record the scenario and
  plan counts before and the `sandbox_scenarios` count after.
- The generated files (`db-types.ts`, `json-columns.ts`, `function-types.ts`, `seed.sql`) are regenerated.
- `pnpm lint && pnpm typecheck && pnpm test` are green. The perf test passes when run alone.
- A grep finds nothing left of: `forecast_plans`, `ForecastPlanRow`, `ForecastPlanMarker`, `is_scenario_patch`,
  `seed_scenario_library`, `savePlan`, `usePlanForecast`, `planSegments`, `parsePlanInput`, `/forecast` outside the
  redirects, and `from("scenarios")`.
- Clicked through locally as Owner, Agency admin, Viewer and guest: a Viewer runs and compares saved scenarios and cannot
  save; a guest sees nothing.
- **Docs:**
  - `docs/PRD.md` gets dated notes: forecast plans (B7) and process-page scenarios (D10) are one sandbox scenario model;
    Viewers now read scenarios.
  - Add D40's amendment if Q1 stands.
  - `docs/production-migrations.md` gets the new row.
  - A short `docs/adr/0021-one-scenario-model.md`.
  - The "Too busy" Help text loses "Settings, Analysis rules".
- Anything checked only on plain Postgres is noted in `docs/supabase-notes.md`.

## 9. Open questions for Opus

Each has a recommended default. Build to the default unless Opus says otherwise.

1. **Which thresholds are "the workspace's own"?** D40 (PRD) says every workspace uses the documented defaults, and that
   `analysis_rules` is "kept, unread", because no screen edits it. The design asks the alerts to use the workspace's own
   thresholds.
   - **Default:** the Sandbox reads `loadAnalysisRules` and passes it to `toRatingConfig` and `forecastInsights`. Add a
     dated D40 amendment. For a workspace without a row this equals the defaults. The Overview and People page are left
     on defaults (out of scope), and the difference is noted in the PRD.
2. **The process page's saved scenarios.**
   - **Default:** keep the library and levers there as a view of standalone whole-run sandbox scenarios (the
     `loadScenarios` adapter), with "Open in Sandbox".
   - The alternative is to remove the library from the process page, which also changes issues and MCP.
3. **Drop the old tables now?**
   - **Default:** drop both in this migration, after the count check, with rollback through the pre-migrate Neon branch.
   - The alternative is to keep them frozen for one phase. That would need the restore and seed changes anyway and gives no
     usable rollback.
4. **Keep seeding the four library scenarios** into new workspaces?
   - **Default:** yes, with fixed change ids outside `PLACEHOLDER_PREFIX`.
5. **Deleting a parent.**
   - **Default:** refuse while children exist (FK `no action`) and name them.
   - "Detach" (copying the parent's effective changes into each child) waits for a later phase.
6. **Can Viewers try unsaved changes?** Play links let visitors do this.
   - **Default:** no. Viewers open, run and compare only, as the cut list says.
7. **C1 role cost.**
   - **Default:** a role-level rate that Viewers may see (it matches the `roles` RLS).
   - It is not offered in phase 1 because nothing shown uses cost. It is offered in phase 2.
8. **D4 from a month for a pinned or assigned person.**
   - **Default:** fall back to a spliced `people.<id>.fte` patch. D4 always counts toward the 6-month cap, so SQL and the
     runner agree.
9. **Levers without a hide-list kind (A6, E6).**
   - **Default:** always shown.
   - New kind ids come with phase 3's new levers, in one change to the three copies.
10. **Hire FTE range.**
    - **Default:** accept 0.1–2 (what plans stored). The dialog's range is 0.1–1.5, as in the design.
11. **The saved horizon versus the page horizon.**
    - **Default:** `horizon_months` is saved with the scenario and used when it is opened without `?horizon`.
    - Compare uses the page's horizon for every column.
12. **Broken changes.** The process page refuses a broken scenario (`resolveRun` and `resolveScenario`, D10). The design
    says the Sandbox skips the change with a note.
    - **Default:** the Sandbox skips and lists the change (loudly, not silently). The process page keeps refusing.
13. **Where the registry lives.**
    - **Default:** `packages/db/src/sandbox-levers.ts`, with the runner in `apps/web/src/lib/sandbox/`.
    - The pure parts of the runner move to `packages/db` in phase 5 for MCP. It would have to bring `bundleFromSolution`,
      `calendarMonthStarts` and `horizonWeeks` with it.
