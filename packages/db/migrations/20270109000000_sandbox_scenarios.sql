-- Sandbox phase 1 (docs/plans/sandbox-design.md, docs/plans/sandbox-p1-brief.md): ONE scenario model.
--
-- `public.sandbox_scenarios` replaces `public.scenarios` (the process page's whole-run lever scenarios) and
-- `public.forecast_plans` (the Forecast page's hire, leave and solution markers). A scenario is a named list of CHANGES; a
-- change is one lever with a value, applied to the whole run or from a month:
--   { "id": uuid, "lever": "A1".."X3", "target": text|null, "op": "set"|"multiply"|"add", "value": number,
--     "from"?: "YYYY-MM" (or "YYYY-MM-DD", a Monday, for leave D3), "params"?: { "name": text } (a hire D1) }
-- `parent_id` is "build on": the scenario's changes apply on top of its parent's. `horizon_months` is the horizon it opens on;
-- `start_date` (the 1st of a month, or null for today) is reserved for a later phase. The lever table is
-- `private.sandbox_levers()`; `SANDBOX_LEVERS` (packages/db/src/sandbox-levers.ts) is its twin and a test keeps them equal.
--
-- THIS MIGRATION TRANSFORMS REAL DATA. The production copy is imported at 20261231000000 and every later migration then runs on it
-- (packages/db/test/copy-from-supabase.test.ts proves it). In one transaction it:
--   1. creates the table, its checks, trigger, policies and grants, and the library;
--   2. copies every scenario and every plan into it, keeping the ids (so `issues.scenario_id`, `runs.scenario_id` and `?plan=<id>`
--      bookmarks stay valid). A patch becomes one change; a plan marker becomes one change (hire D1, leave D3, solution E6)
--      with its date as `from` and its own id as the change id. A name already taken in the workspace (ignoring case and spaces)
--      gets " (2)", " (3)", ... (scenarios first, then plans, each oldest first). `parent_id` is null: the old
--      `parent_scenario_id` meant "copied from" (the copy already holds the patches), so reading it as "build on" would apply
--      them twice. The row count is checked at the end. A scenario and a plan sharing an id, or a patch path with no lever,
--      stops the migration;
--   3. points `issues` and `runs` at the new table;
--   4. replaces the scenario library trigger and seeds new workspaces into the new table;
--   5. REWRITES `public.import_workspace_bundle` (a full copy of its body in 20270104000000_strip_followups.sql, with only the
--      scenario parts changed: section `sandbox_scenarios`, `parent_id`, `changes`);
--   6. drops `scenarios`, `forecast_plans`, `private.seed_scenario_library`, `private.scenario_library` and
--      `private.forecast_plans_before_write`.
-- `private.is_scenario_patch` STAYS: `public.save_solution` (20261221000000_play_links.sql) still checks a solution's lever changes
-- with it, and phase 2 widens it for `finances.overhead_monthly`. Only the `scenarios_patch_shape` check that used it goes with
-- the table.
--
-- Who: Viewers read scenarios now (`can_read_workspace`); the Owner and Agency admins insert, update and delete
-- (`can_edit_workspace`) (cut list item 9). No lever stores an individual's pay: C1 is a role's rate, which every member reads.
-- No `audit_mcp` trigger (MCP is read-only).
--
-- Preflight (psql on the owner's connection, `bash packages/db/scripts/db-sql.sh -c "..."`):
--     -- 0. Nothing at or past this version. Expect 0:
--     select count(*) from public.schema_migrations where version >= '20270109000000';
--     -- 1. Counts to compare with the post-apply count (scenarios + plans), and the links:
--     select (select count(*) from scenarios) as scenarios, (select count(*) from forecast_plans) as plans,
--            (select count(*) from issues where scenario_id is not null) as issues_linked,
--            (select count(*) from runs where scenario_id is not null) as runs_linked;
--     -- 2. Every patch path is in the grammar. Expect 0 rows:
--     select distinct p ->> 'path' from scenarios, jsonb_array_elements(patch) p where (p ->> 'path') !~ '^(demand|finances|health|services|roles|people|steps)\.';
--     -- 3. A scenario and a plan share no id. Expect 0 rows:
--     select s.id from scenarios s join forecast_plans p using (id);
--     -- 4. No patch value beyond the sanity bound the new check enforces. Expect 0 rows:
--     select s.id from scenarios s, jsonb_array_elements(patch) p where abs((p ->> 'value')::numeric) > 1000000000;
--     -- 5. Names that will be renamed (case and spaces ignored). Expect: only the clashes you accept:
--     select workspace_id, lower(btrim(name)), count(*) from (select workspace_id, name from scenarios union all select workspace_id, name from forecast_plans) u
--      group by 1, 2 having count(*) > 1;
--
-- Post-apply checks:
--     -- RLS on. Expect t:  select relrowsecurity from pg_class where oid = 'public.sandbox_scenarios'::regclass;
--     -- 4 policies:        select polname, polcmd from pg_policy where polrelid = 'public.sandbox_scenarios'::regclass order by polcmd;
--     -- Grants: authenticated DELETE, INSERT, SELECT (and column UPDATE on name, description, parent_id, changes, horizon_months, start_date); anon nothing.
--     select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'sandbox_scenarios' and grantee in ('anon', 'authenticated') order by 1, 2;
--     -- Both links point at the new table. Expect 2 rows:
--     select conname, confrelid::regclass from pg_constraint where conname in ('issues_scenario_id_workspace_id_fkey', 'runs_scenario_id_workspace_id_fkey');
--     -- The old tables are gone. Expect null, null:
--     select to_regclass('public.scenarios'), to_regclass('public.forecast_plans');
--     -- The count. Expect scenarios + plans from the preflight:  select count(*) from public.sandbox_scenarios;  (new workspaces add 4 library rows each)
--
-- Rollback: take a Neon branch just before `migrate` (as the cutover and preview runbooks do) and restore from it. The old
-- tables cannot be rebuilt from this table (a scenario with changes from a month has no shape there). For a database that holds
-- nothing worth keeping, the drop list is:
--     drop table public.sandbox_scenarios;  drop function private.sandbox_library(), private.seed_sandbox_library(), private.sandbox_changes_shape(jsonb),
--       private.sandbox_scenarios_before_write(), private.sandbox_scenario_count(uuid), private.is_sandbox_changes(jsonb), private.is_sandbox_change(jsonb),
--       private.is_monday(text), private.sandbox_levers();
--     -- then re-create scenarios, forecast_plans, import_workspace_bundle from 20261002000000, 20261219000000 and 20270104000000.

-- ---------------------------------------------------------------------------
-- The lever table and the change checks
-- ---------------------------------------------------------------------------

-- One row per lever. A test keeps this equal to SANDBOX_LEVERS (packages/db/src/sandbox-levers.ts). A later phase adds a lever
-- with `create or replace` of this function (one row) and, where it needs a value rule, one `when` in is_sandbox_change.
--   target: none | id | id_or_none | health   selector: the one @selector the lever accepts
--   timed: no | people | splice   timing: month | monday   capped: its `from` months count toward the 6-month cap
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
-- The check constraint calls it as the person writing, so authenticated may execute it (as the other check helpers below).
revoke all on function private.sandbox_levers() from public, anon;
grant execute on function private.sandbox_levers() to authenticated;

-- A real date that is a Monday, without raising (a check constraint must not throw).
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

-- One change. Shape and sanity bounds only (|value| <= 1e9): the UI ranges are in the TypeScript registry and the engine clamps,
-- as it does for a scenario patch today. The exact ranges here are the ones plans already enforced: D1 FTE 0.1 to 2, D2 value 0,
-- D3 whole weeks 1 to 52, E6 value 1. Every cast is inside a CASE that has checked the type first.
create function private.is_sandbox_change(c jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce((
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

-- The list: at most 200 changes and 100,000 characters, unique change ids, at most 4 solutions (E6), and at most 6 distinct `from`
-- months among capped levers (each costs one more run; D4 counts because it can fall back to a splice).
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

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table public.sandbox_scenarios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 120),
  description text check (pg_catalog.length(description) <= 2000),
  -- "Build on": this scenario's changes apply on top of its parent's (effective changes, parent first).
  parent_id uuid,
  changes jsonb not null default '[]' constraint sandbox_scenarios_changes check (private.is_sandbox_changes(changes)),
  horizon_months smallint not null default 12 check (horizon_months between 1 and 24),
  -- Null: the run starts today. Phase 1 never writes it (a later phase offers a start month); the runner honours it if set.
  start_date date check (start_date is null or pg_catalog.date_part('day', start_date) = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  constraint sandbox_scenarios_not_own_parent check (parent_id is distinct from id),
  -- NO ACTION, not RESTRICT: deleting a parent alone is refused (23503); deleting the workspace (every row in one statement) is not.
  constraint sandbox_scenarios_parent foreign key (parent_id, workspace_id)
    references public.sandbox_scenarios (id, workspace_id) on delete no action
);
create unique index sandbox_scenarios_workspace_name_key
  on public.sandbox_scenarios (workspace_id, pg_catalog.lower(pg_catalog.btrim(name)));
create index sandbox_scenarios_parent_idx on public.sandbox_scenarios (parent_id) where parent_id is not null;
create trigger set_updated_at before update on public.sandbox_scenarios
  for each row execute function public.set_updated_at();

-- How many scenarios a workspace has, whoever asks. SECURITY DEFINER so the count does not run the read policy on every row it scans: a
-- restore of 900 scenarios counted the rows already inserted for each new row, as the user, and the policy made that 20 seconds.
create function private.sandbox_scenario_count(ws uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select pg_catalog.count(*)::integer from public.sandbox_scenarios s where s.workspace_id = ws
$$;
revoke all on function private.sandbox_scenario_count(uuid) from public, anon;
grant execute on function private.sandbox_scenario_count(uuid) to authenticated;

-- The parent chain (at most 5 deep, no cycle), the workspace stays put, and the cap of 1000 scenarios a workspace for people (a restore at its limit of 900 lands beside the library's 4). No permission check here: the
-- library trigger below is SECURITY DEFINER and inserts while a user creates a workspace (auth.uid() is set, the membership may
-- not be yet). RLS decides who may write. The cap applies to people only: the migration and the library trigger run with no user.
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
    if auth.uid() is not null
      and private.sandbox_scenario_count(new.workspace_id) >= 1000 then
      raise exception 'sandbox_scenarios: a workspace keeps at most 1000 scenarios' using errcode = '23514';
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
-- Supabase gave every new public table full privileges; revoke first, so the column grant restricts (as 20261122000000 does).
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

-- ---------------------------------------------------------------------------
-- The data
-- ---------------------------------------------------------------------------

-- Patch -> change. Every path the old grammar allowed maps to one lever; anything else stops the migration.
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

-- Marker -> change, lossless: hire and solution dates are the 1st (-> 'YYYY-MM'); leave keeps its Monday.
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
  -- Per workspace: scenarios first, then plans, each oldest first. A name already taken (ignoring case and spaces) gets
  -- " (2)", " (3)", ..., cut so the whole stays within 120 characters.
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
    -- parent_id is null: the old parent_scenario_id meant "copied from" (the copy holds the patches already).
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

-- ---------------------------------------------------------------------------
-- The library: every new workspace still starts with four scenarios, now in the new table.
-- ---------------------------------------------------------------------------

-- The change ids are fixed so the restore's library check can compare `changes` exactly. They must not start with
-- 00000000-0000-4000-8000- (the restore's PLACEHOLDER_PREFIX, which it rewrites).
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
revoke all on function private.sandbox_library() from public, anon;
grant execute on function private.sandbox_library() to authenticated;
revoke all on function private.seed_sandbox_library() from public, anon, authenticated;
create trigger seed_sandbox_library after insert on public.workspaces
  for each row execute function private.seed_sandbox_library();

-- The changes without their ids. The restore tells a library scenario from one that only has its name by name and this: the
-- change ids of a library row differ between workspaces migrated from the old table (random ids) and seeded after it (fixed ids).
create function private.sandbox_changes_shape(changes jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(t.e - 'id' order by t.o), '[]'::jsonb) from pg_catalog.jsonb_array_elements(changes) with ordinality t(e, o)
$$;
-- import_workspace_bundle is SECURITY INVOKER: the caller runs these two (as they ran private.scenario_library()).
revoke all on function private.sandbox_changes_shape(jsonb) from public, anon;
grant execute on function private.sandbox_changes_shape(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The restore
-- ---------------------------------------------------------------------------

-- REWRITTEN before `scenarios` is dropped: a full copy of the body in 20270104000000_strip_followups.sql with only the scenario
-- parts changed (section `sandbox_scenarios`, `parent_id`, `changes`, `horizon_months`, `start_date`; the limit, id, empty and
-- library checks; the write). The result key `skipped.scenarios` keeps its name: the web restore screen reads it.
CREATE OR REPLACE FUNCTION public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET statement_timeout TO '40s'
AS $$
declare
  -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
  -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
  -- #228: person_capacity_factors is in this list, in ref_cols, in sections and in list_sections.
  allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"first_principles":["deletes","improvements","job_done","job_progress","job_situation","job_who","measures","requirements","root_cause","statements","why_chain","why_problem"],"sandbox_scenarios":["id","parent_id","name","description","changes","horizon_months","start_date","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"person_capacity_factors":["person_id","step_id","factor","provenance"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"]}'::jsonb;
  -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
  -- column in `allow` is checked on `id` too.
  -- #228
  ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','sandbox_scenarios.parent_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','market_schedule.condition_id','person_capacity_factors.person_id','person_capacity_factors.step_id'];
  step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
  -- The order the sections are written in.
  -- #228
  sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','sandbox_scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links','archive','log'];
  -- #228
  list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','sandbox_scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links'];
  one_sections constant text[] := array['settings','demand_settings','lever_settings','analysis_rules'];
  placeholder constant text := '00000000-0000-4000-8000-';
  placeholder_re constant text := '^00000000-0000-4000-8000-[0-9a-f]{12}$';
  max_plan_chars constant integer := 19660800;

  pl jsonb;
  txt text;
  prefix text;
  label text := left(nullif(btrim(coalesce(p_label, '')), ''), 300);
  sec text;
  col text;
  tbl text;
  rows jsonb;
  node jsonb;
  sc jsonb;
  cols text;
  sets text;
  n integer;
  total integer;
  existing uuid;
  skip_ids uuid[] := '{}';
  skipped jsonb := '{}';
  counts jsonb := '{}';
  proc uuid;
  rev uuid;
  draft jsonb;
  revs jsonb := '{}';
  made jsonb := '[]';
  arch uuid[] := '{}';
  step_total integer := 0;
  edge_total integer := 0;
  settings_result text := 'none';
  what text;
  has_rows boolean;
  bad integer;
  chars bigint;
begin
  -- 1. Who. Before the plan is read, so a refusal says nothing about it.
  if coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then
    raise exception 'Backups are restored in the app.' using errcode = '42501';
  end if;
  if p_workspace is null or not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'Only Agency admins and the Owner can restore a backup.' using errcode = '42501';
  end if;

  -- 2. Shape and limits.
  if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object' or p_plan ->> 'format' is distinct from 'transpera-workspace-import/1' then
    raise exception 'import_workspace_bundle: p_plan is not a transpera-workspace-import/1 plan' using errcode = '22023';
  end if;
  -- #228: a plan made before per-person times were restored (an app deployed before this migration) has no such section:
  -- it restores as an empty one.
  if not p_plan ? 'person_capacity_factors' then
    p_plan := p_plan || '{"person_capacity_factors": []}'::jsonb;
  end if;
  if char_length(p_plan::text) > max_plan_chars then
    raise exception 'import_workspace_bundle: the plan is too big (at most 15 MB)' using errcode = '22023';
  end if;
  foreach sec in array list_sections loop
    if jsonb_typeof(p_plan -> sec) is distinct from 'array' then
      raise exception 'import_workspace_bundle: % must be a list', sec using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_plan -> sec) e where jsonb_typeof(e.value) is distinct from 'object') then
      raise exception 'import_workspace_bundle: every row of % must be an object', sec using errcode = '22023';
    end if;
  end loop;
  foreach sec in array one_sections loop
    if p_plan -> sec is not null and jsonb_typeof(p_plan -> sec) not in ('object', 'null') then
      raise exception 'import_workspace_bundle: % must be an object or null', sec using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'processes') p
    where jsonb_typeof(p.value -> 'steps') is distinct from 'array' or jsonb_typeof(p.value -> 'edges') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(p.value -> 'steps') e where jsonb_typeof(e.value) is distinct from 'object')
      or exists (select 1 from jsonb_array_elements(p.value -> 'edges') e where jsonb_typeof(e.value) is distinct from 'object')
      or (p.value -> 'first_principles' is not null and jsonb_typeof(p.value -> 'first_principles') not in ('object', 'null'))
      or (p.value -> 'layout' is not null and jsonb_typeof(p.value -> 'layout') not in ('object', 'null'))
  ) then
    raise exception 'import_workspace_bundle: every process needs lists of steps and edges' using errcode = '22023';
  end if;
  select coalesce(sum(jsonb_array_length(p.value -> 'steps')), 0), coalesce(sum(jsonb_array_length(p.value -> 'edges')), 0)
    into step_total, edge_total from jsonb_array_elements(p_plan -> 'processes') p;
  select coalesce(sum(char_length(coalesce(s.value ->> 'body', ''))), 0) into chars from jsonb_array_elements(p_plan -> 'sources') s;
  if jsonb_array_length(p_plan -> 'processes') > 150 or step_total > 1500 or edge_total > 3000
    or jsonb_array_length(p_plan -> 'sources') > 600 or chars > 4500000
    or jsonb_array_length(p_plan -> 'issues') > 900 or jsonb_array_length(p_plan -> 'people') > 1500
    or jsonb_array_length(p_plan -> 'clients') > 3000 or jsonb_array_length(p_plan -> 'sandbox_scenarios') > 900
    or jsonb_array_length(p_plan -> 'blocks') > 900
    or jsonb_array_length(p_plan -> 'person_roles') > 1200 or jsonb_array_length(p_plan -> 'person_skills') > 3000
    or jsonb_array_length(p_plan -> 'client_assignments') > 1200 or jsonb_array_length(p_plan -> 'source_links') > 3000
    or jsonb_array_length(p_plan -> 'client_services') > 3000 or jsonb_array_length(p_plan -> 'person_leave') > 1500
    -- #228
    or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000
    or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
      + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
      + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
    -- #228
    raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times)' using errcode = '22023';
  end if;
  -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
  if exists (select 1 from jsonb_array_elements(p_plan -> 'sandbox_scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
    raise exception 'import_workspace_bundle: every scenario needs an id' using errcode = '22023';
  end if;

  -- 3. Lock: one restore (or upload) at a time per workspace.
  if not pg_try_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0)) then
    raise exception 'A restore into this workspace is already running.' using errcode = '55P03', hint = 'busy';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));

  -- 4. Empty.
  for tbl, col in
    select t.a, t.b from (values
      ('processes', 'not is_company'), ('roles', 'true'), ('people', 'true'), ('services', 'true'), ('client_groups', 'true'),
      ('clients', 'true'), ('lead_sources', 'true'), ('churn_drivers', 'true'), ('market_schedule', 'true'), ('issues', 'true'),
      ('sources', 'true'), ('blocks', 'true'), ('solutions', 'true'),
      ('market_conditions', 'preset is null')
    ) as t(a, b)
  loop
    execute format('select exists (select 1 from public.%I where workspace_id = $1 and %s)', tbl, col) into has_rows using p_workspace;
    if has_rows then
      what := replace(tbl, '_', ' ');
      exit;
    end if;
  end loop;
  if what is null and exists (
    select 1 from public.sandbox_scenarios s where s.workspace_id = p_workspace
      and not exists (select 1 from private.sandbox_library() l where l.name = s.name and private.sandbox_changes_shape(l.changes) = private.sandbox_changes_shape(s.changes))
  ) then
    what := 'scenarios of its own';
  end if;
  if what is not null then
    raise exception 'This workspace isn''t empty: it already has %. Backups restore only into a new, empty workspace.', what
      using errcode = '23514', hint = 'not_empty';
  end if;

  -- 5. Ids: every id and reference column of the plan holds a placeholder (or null) before anything is replaced.
  foreach sec in array list_sections loop
    if sec = 'processes' then continue; end if;
    for col in
      select c from (
        select 'id' as c where allow -> sec ? 'id'
        union all select split_part(r, '.', 2) from unnest(ref_cols) r where split_part(r, '.', 1) = sec
      ) q
    loop
      select count(*) into bad from jsonb_array_elements(p_plan -> sec) r
      where r.value -> col is not null and jsonb_typeof(r.value -> col) <> 'null'
        and (jsonb_typeof(r.value -> col) <> 'string' or (r.value ->> col) !~ placeholder_re);
      if bad > 0 then
        raise exception 'import_workspace_bundle: % holds an id that is not a placeholder in %', col, sec using errcode = '22023';
      end if;
    end loop;
  end loop;
  select count(*) into bad from jsonb_array_elements(p_plan -> 'issues') i
  where exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) x
      where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) x
      where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
      where jsonb_typeof(l.value) <> 'object'
        or (l.value ->> 'process_id') !~ placeholder_re
        or (jsonb_typeof(l.value -> 'step_id') <> 'null' and l.value ->> 'step_id' is not null and (l.value ->> 'step_id') !~ placeholder_re));
  if bad > 0 then
    raise exception 'import_workspace_bundle: an issue link, owner or source holds an id that is not a placeholder' using errcode = '22023';
  end if;
  select count(*) into bad from jsonb_array_elements(p_plan -> 'processes') p
  where (p.value ->> 'id') is null or (p.value ->> 'id') !~ placeholder_re
    or (jsonb_typeof(p.value -> 'parent_process_id') <> 'null' and p.value ->> 'parent_process_id' is not null and (p.value ->> 'parent_process_id') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(p.value -> 'steps') s, unnest(array['id'] || step_ref_cols) c
      where s.value -> c is not null and jsonb_typeof(s.value -> c) <> 'null' and (jsonb_typeof(s.value -> c) <> 'string' or (s.value ->> c) !~ placeholder_re))
    or exists (
      select 1 from jsonb_array_elements(p.value -> 'edges') e, unnest(array['id', 'from_step_id', 'to_step_id']) c
      where e.value -> c is not null and jsonb_typeof(e.value -> c) <> 'null' and (jsonb_typeof(e.value -> c) <> 'string' or (e.value ->> c) !~ placeholder_re));
  if bad > 0 then
    raise exception 'import_workspace_bundle: a process, step or edge holds an id that is not a placeholder' using errcode = '22023';
  end if;

  -- The real ids: one random prefix per restore replaces the placeholder prefix.
  loop
    prefix := substr(md5(gen_random_uuid()::text), 1, 20);
    exit when prefix <> '00000000000000000000';
  end loop;
  prefix := substr(prefix, 1, 8) || '-' || substr(prefix, 9, 4) || '-' || substr(prefix, 13, 4) || '-' || substr(prefix, 17, 4) || '-';
  -- Two plain replacements (a regular expression took 13 times as long on a big plan): every placeholder gets the fresh
  -- prefix, then rank 0 (the old workspace), now `<prefix>000000000000`, becomes the real workspace. The prefix is never
  -- all zeros (the loop above), so no other id can take rank 0's place.
  txt := replace(p_plan::text, placeholder, prefix);
  txt := replace(txt, prefix || '000000000000', p_workspace::text);

  -- A scenario equal (name and changes) to one the workspace already has (the seeded library) is skipped: its children and the
  -- issues that use it are re-pointed at the existing row.
  for sc in select value from jsonb_array_elements((txt::jsonb) -> 'sandbox_scenarios') loop
    select s.id into existing from public.sandbox_scenarios s
    where s.workspace_id = p_workspace and s.name = sc ->> 'name' and private.sandbox_changes_shape(s.changes) = private.sandbox_changes_shape(sc -> 'changes')
    order by s.id limit 1;
    if found then
      txt := replace(txt, sc ->> 'id', existing::text);
      skip_ids := skip_ids || existing;
    end if;
  end loop;
  pl := txt::jsonb;
  txt := null;
  skipped := jsonb_build_object('scenarios', cardinality(skip_ids));

  -- 6. Write.
  foreach sec in array sections loop
    begin
      n := 0;
      if sec = 'settings' then
        if jsonb_typeof(pl -> 'settings') = 'object' and pl -> 'settings' <> '{}'::jsonb then
          -- Whoever may restore (can_edit_workspace, checked first) manages the workspace too, so the settings are applied.
          update public.workspaces set settings = settings || (pl -> 'settings') where id = p_workspace;
          settings_result := 'applied';
        end if;
        continue;
      end if;

      if sec in ('demand_settings', 'lever_settings', 'analysis_rules') then
        -- One row per workspace: written over any row the workspace already has.
        if jsonb_typeof(pl -> sec) = 'object' then
          select string_agg(quote_ident(c), ', '), string_agg(format('%1$I = excluded.%1$I', c), ', ') into cols, sets
          from jsonb_array_elements_text(allow -> sec) c where (pl -> sec) ? c;
          if cols is not null then
            execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (workspace_id) do update set %3$s', sec, cols, sets)
              using pl -> sec, p_workspace;
            n := 1;
          end if;
        end if;

      elsif sec = 'market_schedule' then
        -- A row that points at one of the backup's presets points at this workspace's preset with the same key.
        insert into public.market_schedule (workspace_id, id, condition_id, from_month, to_month, created_at)
        select p_workspace, coalesce(x.id, gen_random_uuid()),
          coalesce(x.condition_id, (select m.id from public.market_conditions m where m.workspace_id = p_workspace and m.preset = r.value ->> 'condition_preset')),
          x.from_month, x.to_month, coalesce(x.created_at, now())
        from jsonb_array_elements(pl -> 'market_schedule') with ordinality r(value, ord)
        cross join lateral jsonb_populate_record(null::public.market_schedule, r.value) x
        order by r.ord;
        get diagnostics n = row_count;

      elsif sec = 'processes' then
        -- Every process first (parents first, as the plan is ordered), each opened as a draft, so a holder step can point at any of them.
        for node in select value from jsonb_array_elements(pl -> 'processes') loop
          proc := (node ->> 'id')::uuid;
          insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
          values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_process_id')::uuid);
          draft := public.open_draft(proc);
          if draft ->> 'status' is distinct from 'ok' then
            raise exception 'could not open a draft of %', node ->> 'name' using errcode = '42501';
          end if;
          rev := (draft ->> 'revision_id')::uuid;
          revs := revs || jsonb_build_object(proc::text, rev);
          if jsonb_typeof(node -> 'layout') = 'object' then
            update public.process_revisions set layout = node -> 'layout' where id = rev;
          end if;
          if coalesce((node ->> 'archived')::boolean, false) then
            arch := arch || proc;
          end if;
          made := made || jsonb_build_object('id', proc, 'name', node ->> 'name', 'revision_id', rev, 'archived', coalesce((node ->> 'archived')::boolean, false));
          n := n + 1;
        end loop;

      elsif sec = 'sandbox_scenarios' then
        select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
        from jsonb_array_elements(pl -> 'sandbox_scenarios') with ordinality r(value, ord)
        where not ((r.value ->> 'id')::uuid = any (skip_ids));
        n := jsonb_array_length(rows);
        if n > 0 then
          -- A row without a horizon gets the default (populating a record from json would give it null, not the column default).
          select jsonb_agg(case when r.value ? 'horizon_months' and jsonb_typeof(r.value -> 'horizon_months') = 'number' then r.value else r.value || '{"horizon_months": 12}'::jsonb end order by r.ord)
            into rows from jsonb_array_elements(rows) with ordinality r(value, ord);
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          -- One statement, so the parent foreign key (no action) is checked at its end, whatever the order of the rows.
          execute format('insert into public.sandbox_scenarios (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.sandbox_scenarios, $1)', cols) using rows, p_workspace;
        end if;

      elsif sec = 'issues' then
        rows := pl -> 'issues';
        n := jsonb_array_length(rows);
        if n > 0 then
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          -- In plan order: the trigger numbers them 1, 2, 3 ... in the old order.
          execute format('insert into public.issues (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.issues, $1)', cols) using rows, p_workspace;
          -- `issue_seed_links` and `link_issue_source` may have added some already.
          insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
          select (i.value ->> 'id')::uuid, p_workspace, (l.value ->> 'process_id')::uuid, (l.value ->> 'step_id')::uuid
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
          on conflict do nothing;
          insert into public.issue_owners (issue_id, person_id, workspace_id)
          select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) o
          on conflict do nothing;
          insert into public.issue_sources (issue_id, source_id, workspace_id)
          select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) o
          on conflict do nothing;
        end if;

      elsif sec = 'steps' then
        -- The steps and edges of each draft (an entry step is set once all the steps are in), then its first principles.
        for node in select value from jsonb_array_elements(pl -> 'processes') loop
          proc := (node ->> 'id')::uuid;
          rev := (revs ->> proc::text)::uuid;
          select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null, 'created_by', auth.uid())), '[]'::jsonb)
            into rows from jsonb_array_elements(node -> 'steps') s;
          if jsonb_array_length(rows) > 0 then
            select string_agg(quote_ident(k), ', ') into cols from (
              select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
              where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'steps') ? k
            ) q;
            execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows;
            update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
            from jsonb_array_elements(node -> 'steps') s
            where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
            n := n + jsonb_array_length(rows);
          end if;
          select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'created_by', auth.uid())), '[]'::jsonb)
            into rows from jsonb_array_elements(node -> 'edges') e;
          if jsonb_array_length(rows) > 0 then
            select string_agg(quote_ident(k), ', ') into cols from (
              select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
              where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'edges') ? k
            ) q;
            execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows;
          end if;
          if jsonb_typeof(node -> 'first_principles') = 'object' then
            select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> 'first_principles') c where (node -> 'first_principles') ? c;
            if cols is not null then
              execute format('insert into public.first_principles (workspace_id, process_id, revision_id, %1$s) select $2, $3, $4, %1$s from jsonb_populate_record(null::public.first_principles, $1)', cols)
                using node -> 'first_principles', p_workspace, proc, rev;
            end if;
          end if;
        end loop;
        counts := counts || jsonb_build_object('edges', edge_total);

      elsif sec = 'archive' then
        if cardinality(arch) > 0 then
          update public.processes set archived_at = now() where id = any (arch);
          get diagnostics n = row_count;
        end if;

      elsif sec = 'log' then
        for node in select value from jsonb_array_elements(made) loop
          perform public.log_process_import((node ->> 'id')::uuid, 'Restored from a workspace backup' || coalesce(' (' || label || ')', ''));
          n := n + 1;
        end loop;

      else
        -- A flat section: one insert, the plan's order, only the columns of the allow-list that the rows carry.
        tbl := sec;
        rows := pl -> sec;
        if sec = 'market_conditions' then
          -- The presets are read-only and the workspace has them already: the plan carries custom conditions only, and no `preset`.
          null;
        elsif sec = 'source_links' then
          -- A step link needs its step in the process's restored draft (the trigger refuses it otherwise).
          select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
          from jsonb_array_elements(rows) with ordinality r(value, ord)
          where r.value ->> 'kind' is distinct from 'step' or exists (
            select 1 from public.steps s where s.workspace_id = p_workspace and s.process_id = (r.value ->> 'process_id')::uuid and s.id = (r.value ->> 'step_id')::uuid);
          skipped := skipped || jsonb_build_object('step_links', jsonb_array_length(pl -> sec) - jsonb_array_length(rows));
        end if;
        n := jsonb_array_length(rows);
        if n > 0 then
          -- A source link's id can't be given by a signed-in caller (the insert grant on the table is by column, and leaves `id`
          -- and `created_at` out): the database makes it.
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c) and not (sec = 'source_links' and c = 'id');
          if cols is null then
            raise exception 'the rows have none of the columns a restore accepts' using errcode = '22023';
          end if;
          execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s', tbl, cols,
            case when sec = 'source_links' then ' on conflict do nothing' else '' end)
            using rows, p_workspace;
        end if;
      end if;
      counts := counts || jsonb_build_object(sec, n);
    exception when others then
      raise exception 'import_workspace_bundle: % could not be restored: %', sec, sqlerrm using errcode = sqlstate, hint = 'section:' || sec;
    end;
  end loop;

  return jsonb_build_object('id_prefix', prefix, 'processes', made, 'counts', counts, 'skipped', skipped, 'settings', settings_result);
end;
$$;

-- ---------------------------------------------------------------------------
-- Drop what is replaced
-- ---------------------------------------------------------------------------

drop table public.scenarios;          -- its audit_mcp and set_updated_at triggers, policies and scenarios_patch_shape go with it
drop table public.forecast_plans;
drop function private.seed_scenario_library();
drop function private.forecast_plans_before_write();
drop function private.scenario_library();   -- after import_workspace_bundle no longer calls it
