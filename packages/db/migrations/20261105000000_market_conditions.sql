-- Market conditions (docs/PRD.md decision D29, ticket A57 / #122): the outside
-- climate for demand. A condition is seven factors, each a whole percent of
-- today (100 = the same as today); a workspace has four read-only presets
-- (Boom, Stable, Soft, Downturn) and any number of its own. A 24-month
-- schedule says which condition applies in which months, and the engine
-- applies it month by month (`EngineModel.market`).
--
-- Strictly additive: two new tables, three functions in `private`, one
-- trigger on `workspaces`, and a backfill that gives every existing workspace
-- its four presets. `save_fields` is not touched: conditions and schedule
-- entries are saved as whole rows.
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop trigger if exists seed_market_presets on public.workspaces;
--   drop table public.market_schedule;
--   drop table public.market_conditions;
--   drop function if exists private.seed_market_presets();
--   drop function if exists private.market_presets();
--   drop function if exists private.check_market_schedule();
--   delete from supabase_migrations.schema_migrations where version = '20261105000000';
--   commit;
--
-- Rolling back deletes every custom condition and the schedule.

-- ---------------------------------------------------------------------------
-- Conditions
-- ---------------------------------------------------------------------------

create table public.market_conditions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null constraint market_conditions_name_length check (char_length(btrim(name)) between 1 and 80),
  -- boom, stable, soft or downturn for the four read-only presets; null for your own.
  preset text constraint market_conditions_preset check (preset in ('boom', 'stable', 'soft', 'downturn')),
  -- The seven factors, as a whole percent of today (100 = same as today).
  -- Enquiries.
  leads int not null default 100 constraint market_conditions_leads check (leads between 0 and 500),
  -- Enquiries that sign.
  conv int not null default 100 constraint market_conditions_conv check (conv between 0 and 500),
  -- Time to decide.
  cycle int not null default 100 constraint market_conditions_cycle check (cycle between 0 and 500),
  -- Prices you can charge.
  price int not null default 100 constraint market_conditions_price check (price between 0 and 500),
  -- Clients leaving.
  churn int not null default 100 constraint market_conditions_churn check (churn between 0 and 500),
  -- Time to hire.
  hire int not null default 100 constraint market_conditions_hire check (hire between 0 and 500),
  -- Late payments.
  pay int not null default 100 constraint market_conditions_pay check (pay between 0 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create index on public.market_conditions (workspace_id);
-- One of each preset per workspace.
create unique index market_conditions_preset_key on public.market_conditions (workspace_id, preset) where preset is not null;

create trigger set_updated_at before update on public.market_conditions for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- Which condition applies from which month to which, counted from the start of
-- a run (month 1 is the first month). Months no entry covers are Stable.
create table public.market_schedule (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  from_month int not null constraint market_schedule_from check (from_month between 1 and 24),
  to_month int not null constraint market_schedule_to check (to_month between 1 and 24),
  condition_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint market_schedule_order check (to_month >= from_month),
  -- A condition in use can't be deleted until it is taken off the schedule.
  foreign key (condition_id, workspace_id) references public.market_conditions (id, workspace_id)
);

create index on public.market_schedule (workspace_id);

create trigger set_updated_at before update on public.market_schedule for each row execute function public.set_updated_at();

-- Entries don't overlap: one condition applies in any month.
create function private.check_market_schedule() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Serialise changes to one workspace's schedule, so two overlapping inserts can't both pass the check below.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));
  if exists (
    select 1 from public.market_schedule s
    where s.workspace_id = new.workspace_id and s.id <> new.id
      and s.from_month <= new.to_month and s.to_month >= new.from_month
  ) then
    raise exception 'market_schedule: months % to % overlap another change', new.from_month, new.to_month
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

revoke all on function private.check_market_schedule() from public, anon;

create trigger check_market_schedule before insert or update on public.market_schedule
  for each row execute function private.check_market_schedule();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Everyone in the workspace can read; editors, owners and agency admins write.
-- The four presets are read-only: they can't be inserted, changed or deleted
-- through the API (the trigger below creates them as the function owner).
alter table public.market_conditions enable row level security;
alter table public.market_schedule enable row level security;

create policy "read market conditions" on public.market_conditions for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert market conditions" on public.market_conditions for insert to authenticated
  with check (public.can_edit_workspace(workspace_id) and preset is null);
create policy "update market conditions" on public.market_conditions for update to authenticated
  using (public.can_edit_workspace(workspace_id) and preset is null)
  with check (public.can_edit_workspace(workspace_id) and preset is null);
create policy "delete market conditions" on public.market_conditions for delete to authenticated
  using (public.can_edit_workspace(workspace_id) and preset is null);

create policy "read market schedule" on public.market_schedule for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert market schedule" on public.market_schedule for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update market schedule" on public.market_schedule for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete market schedule" on public.market_schedule for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.market_conditions, public.market_schedule to authenticated;
revoke all on public.market_conditions, public.market_schedule from anon;

-- ---------------------------------------------------------------------------
-- Presets for every workspace
-- ---------------------------------------------------------------------------

-- The four presets (the prototype's values; `MARKET_PRESETS` in the engine
-- holds the same numbers, and a test checks they agree).
create function private.market_presets() returns table (preset text, name text, leads int, conv int, cycle int, price int, churn int, hire int, pay int)
language sql immutable
set search_path = ''
as $$
  values
    ('boom',     'Boom',     125, 110,  90, 100,  85, 130,  90),
    ('stable',   'Stable',   100, 100, 100, 100, 100, 100, 100),
    ('soft',     'Soft',      85,  90, 120,  95, 115,  90, 115),
    ('downturn', 'Downturn',  65,  75, 140,  88, 135,  80, 135)
$$;

-- Security definer so the presets exist however the workspace is created; it
-- writes only rows for the new workspace.
create function private.seed_market_presets() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.market_conditions (workspace_id, name, preset, leads, conv, cycle, price, churn, hire, pay)
  select new.id, p.name, p.preset, p.leads, p.conv, p.cycle, p.price, p.churn, p.hire, p.pay from private.market_presets() as p;
  return null;
end;
$$;

revoke all on function private.market_presets() from public, anon;
revoke all on function private.seed_market_presets() from public, anon, authenticated;

create trigger seed_market_presets after insert on public.workspaces
  for each row execute function private.seed_market_presets();

-- Workspaces that already exist get their presets now.
insert into public.market_conditions (workspace_id, name, preset, leads, conv, cycle, price, churn, hire, pay)
select w.id, p.name, p.preset, p.leads, p.conv, p.cycle, p.price, p.churn, p.hire, p.pay
from public.workspaces w cross join private.market_presets() as p
on conflict (workspace_id, preset) where preset is not null do nothing;
