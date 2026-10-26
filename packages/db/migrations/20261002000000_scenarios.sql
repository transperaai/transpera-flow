-- Scenarios: named sets of parameter patches on top of the baseline
-- (docs/PRD.md §3, §4.1 "Levers and scenarios", §5; decision D10; issue #15).
--
-- A patch is {path, op, value}: `op` is set | multiply | add, `value` a
-- number, and `path` addresses the model in the stored rows' vocabulary
-- (`steps.<step_id>.work_hours`, `people.<person_id>.fte`,
-- `roles.<role_id>.headcount`, `demand.leads_per_week`, `finances.retainer`,
-- ...). The grammar lives in packages/engine/src/scenario.ts; the check below
-- enforces the same shape so nothing malformed is stored. Whether a path's
-- target still exists is decided when the scenario is applied to a model, and
-- a missing one is reported there ("needs attention"), never dropped.
--
-- Every workspace gets a small library (hire, automate a step, more leads,
-- downturn) when it is created, from a trigger on `workspaces`: workspaces are
-- created in SQL (seed, SQL editor, a future admin screen), so the database is
-- the one place that sees every new workspace. The library uses selectors
-- (`roles.@busiest`, `steps.@heaviest`) that resolve against the model when
-- applied, because a new workspace has no roles or steps to name yet.
--
-- Strictly additive: one new table, three functions in `private`, one trigger.
--
-- Rollback (run in this order):
--   drop trigger if exists seed_scenario_library on public.workspaces;
--   drop table if exists public.scenarios;
--   drop function if exists private.seed_scenario_library();
--   drop function if exists private.scenario_library();
--   drop function if exists private.is_scenario_patch(jsonb);
--   delete from supabase_migrations.schema_migrations where version = '20261002000000';

-- ---------------------------------------------------------------------------
-- Patch shape
-- ---------------------------------------------------------------------------

-- True when `patch` is an array of at most 200 {path, op, value} objects with
-- exactly those keys, a known op, a numeric value and a path in the grammar.
-- Mirrors parsePatches() in packages/engine/src/scenario.ts (tested against it).
create function private.is_scenario_patch(patch jsonb) returns boolean
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
                                || '|services\.[^.[:space:]]{1,100}\.(price|mix_share)'
                                || '|roles\.[^.[:space:]]{1,100}\.(headcount|cost_rate|ongoing_hours)'
                                || '|people\.[^.[:space:]]{1,100}\.fte'
                                || '|steps\.[^.[:space:]]{1,100}\.(work_hours|wait_hours|rework_rate))$')
          -- An id starting with @ must be a known selector.
          or ((p ->> 'path') ~ '^[a-z]+\.@' and (p ->> 'path') !~ '^(roles\.@busiest|steps\.@heaviest)\.')
      end
    );
$$;

revoke all on function private.is_scenario_patch(jsonb) from public, anon;
grant execute on function private.is_scenario_patch(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null constraint scenarios_name_length check (char_length(btrim(name)) between 1 and 120),
  description text constraint scenarios_description_length check (char_length(description) <= 2000),
  -- [{path, op: set|multiply|add, value}], applied in order.
  patch jsonb not null default '[]' constraint scenarios_patch_shape check (private.is_scenario_patch(patch)),
  -- The scenario this one was duplicated from, if any.
  parent_scenario_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  foreign key (parent_scenario_id, workspace_id) references public.scenarios (id, workspace_id) on delete set null (parent_scenario_id)
);

create index on public.scenarios (workspace_id);

create trigger set_updated_at before update on public.scenarios for each row execute function public.set_updated_at();

-- Everyone in the workspace can read and apply scenarios; editors, owners and
-- agency admins can save, change and delete them.
alter table public.scenarios enable row level security;

create policy "read scenarios" on public.scenarios for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert scenarios" on public.scenarios for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update scenarios" on public.scenarios for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete scenarios" on public.scenarios for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.scenarios to authenticated;
revoke all on public.scenarios from anon;

-- ---------------------------------------------------------------------------
-- Library for every workspace
-- ---------------------------------------------------------------------------

-- The library every new workspace starts with.
create function private.scenario_library() returns table (name text, description text, patch jsonb)
language sql immutable
set search_path = ''
as $$
  values
    ('Hire into the busiest role',
     'One more full-time person in the role with the most work for its capacity.',
     '[{"path": "roles.@busiest.headcount", "op": "add", "value": 1}]'::jsonb),
    ('Automate the heaviest step',
     'Hands-on time down 60% on the step that takes the most hours each week, as automation or templates would.',
     '[{"path": "steps.@heaviest.work_hours", "op": "multiply", "value": 0.4}]'::jsonb),
    ('More leads',
     '25% more leads every week.',
     '[{"path": "demand.leads_per_week", "op": "multiply", "value": 1.25}]'::jsonb),
    ('Downturn',
     '30% fewer leads a week, and client churn up by half.',
     '[{"path": "demand.leads_per_week", "op": "multiply", "value": 0.7}, {"path": "demand.churn_monthly", "op": "multiply", "value": 1.5}]'::jsonb)
$$;

-- Security definer so the library is seeded however the workspace is
-- created; it writes only rows for the new workspace.
create function private.seed_scenario_library() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.scenarios (workspace_id, name, description, patch)
  select new.id, l.name, l.description, l.patch from private.scenario_library() as l;
  return null;
end;
$$;

revoke all on function private.scenario_library() from public, anon;
revoke all on function private.seed_scenario_library() from public, anon, authenticated;

create trigger seed_scenario_library after insert on public.workspaces
  for each row execute function private.seed_scenario_library();

-- Workspaces that already exist get the library too.
insert into public.scenarios (workspace_id, name, description, patch)
select w.id, l.name, l.description, l.patch
from public.workspaces as w cross join private.scenario_library() as l;
