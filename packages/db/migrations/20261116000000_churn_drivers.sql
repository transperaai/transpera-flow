-- Churn drivers (docs/PRD.md decisions D21 and D28; issue #121, ticket A56): the
-- reasons clients leave. Base churn per service (the client group's "normal
-- churn", A55) is multiplied by what is going on around each client, and each
-- driver has a weight (0 to 3; 1 is normal, 0 ignores it) and an on/off
-- switch. Ten drivers are built in (the engine measures what it can and takes
-- the rest as a stated assumption you enter); you can add your own, with a
-- name, a one-sentence description and an example.
--
-- One row per driver you have set, per workspace. A built-in with no row is at
-- its default (late work and the market on at weight 1, the rest off), and
-- that default is exactly how the engine churned clients before drivers
-- existed, so a workspace with no rows simulates as it always did. The app
-- creates a built-in's row the first time you change it.
--
--   driver       late, resp, onb, rework, load, handoff, results, tenure,
--                price or market for the ten built-ins; null for your own.
--   name, description, example   your own drivers only.
--   weight       0 to 3.
--   enabled      the on/off switch.
--   value        what you enter, where the driver takes a number: normal first
--                delivery in working days (onb), account manager changes per
--                client a year (handoff), average rating out of 10 (results),
--                times as likely to leave in months 1 to 6 (tenure), planned
--                price rise in percent (price), and for your own driver the
--                extra churn it causes at weight 1, in percent.
--   month        price changes only: the month of the run (1 to 24) the rise
--                takes effect.
--
-- A driver is a company-model fact, like a client group: the MCP server can't
-- write it directly (it suggests; decision D19) and every write is audited,
-- with `private.company_needs_review` and `private.audit_company_write`
-- (20261015000000_suggestions.sql, the former redefined in
-- 20261021000000_roles_and_workspaces.sql). A person changing weight,
-- enabled, value or month stamps its provenance `entered`.
--
-- Strictly additive: one new table with its triggers, policies and grants, and
-- a function and trigger that cap a workspace at 25 drivers of its own.
-- `save_fields` is not touched: a driver is saved as a whole row.
--
-- Rollback (run as one transaction):
--
--   begin;
--   -- (dropping the table drops its triggers and policies)
--   drop table public.churn_drivers;
--   drop function if exists private.check_churn_driver_limit();
--   delete from supabase_migrations.schema_migrations where version = '20261116000000';
--   commit;
--
-- Rolling back deletes every weight, switch and driver of your own.

create table public.churn_drivers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The ten built-ins; null for a driver of your own.
  driver text constraint churn_drivers_driver check (driver in ('late', 'resp', 'onb', 'rework', 'load', 'handoff', 'results', 'tenure', 'price', 'market')),
  -- Your own drivers only: what it's called, what it is in one sentence, and an example.
  name text constraint churn_drivers_name check (char_length(btrim(name)) between 1 and 80),
  description text constraint churn_drivers_description check (char_length(description) <= 300),
  example text constraint churn_drivers_example check (char_length(example) <= 300),
  -- How much this cause matters: 1 is normal, 0 means ignore it, 3 means it matters three times as much.
  weight numeric not null default 1 constraint churn_drivers_weight check (weight >= 0 and weight <= 3),
  enabled boolean not null default true,
  value numeric constraint churn_drivers_value check (value >= 0 and value <= 500),
  month int constraint churn_drivers_month check (month between 1 and 24),
  -- Provenance of weight, enabled, value and month, {column: {source, at, by}}: stamped `entered` when a person changes one.
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  -- A built-in has no name of its own; your own driver must have one.
  constraint churn_drivers_own check (
    (driver is null and name is not null)
    or (driver is not null and name is null and description is null and example is null)
  ),
  constraint churn_drivers_month_only_price check (month is null or driver = 'price')
);

create index on public.churn_drivers (workspace_id);
-- One row per built-in driver per workspace.
create unique index churn_drivers_driver_key on public.churn_drivers (workspace_id, driver) where driver is not null;

create trigger set_updated_at before update on public.churn_drivers for each row execute function public.set_updated_at();

create trigger stamp_provenance before insert or update on public.churn_drivers
  for each row execute function public.stamp_provenance('weight', 'enabled', 'value', 'month');

-- At most 25 drivers of your own, so one workspace can't make the simulation carry thousands.
create function private.check_churn_driver_limit() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.driver is null then
    -- Serialise inserts for one workspace, so two can't both pass the count below.
    perform pg_advisory_xact_lock(hashtextextended('churn_drivers:' || new.workspace_id::text, 0));
    if (select count(*) from public.churn_drivers d where d.workspace_id = new.workspace_id and d.driver is null and d.id <> new.id) >= 25 then
      raise exception 'churn_drivers: a workspace can have at most 25 drivers of its own' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.check_churn_driver_limit() from public, anon;

-- On update too, so a built-in's row can't be turned into one of your own (driver set to null) past the cap.
create trigger check_churn_driver_limit before insert or update of driver on public.churn_drivers
  for each row execute function private.check_churn_driver_limit();

-- Row-level security: members read, owners and editors write (as for client groups).
alter table public.churn_drivers enable row level security;

create policy "read churn_drivers" on public.churn_drivers for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert churn_drivers" on public.churn_drivers for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update churn_drivers" on public.churn_drivers for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete churn_drivers" on public.churn_drivers for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.churn_drivers to authenticated;
revoke all on public.churn_drivers from anon;

-- Company model (issue #25): the MCP server suggests changes rather than making them, and every write is audited.
create trigger needs_review before insert or update or delete on public.churn_drivers
  for each row execute function private.company_needs_review();
create trigger audit_company after insert or update or delete on public.churn_drivers
  for each row execute function private.audit_company_write();
