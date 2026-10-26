-- Client groups (docs/PRD.md §3 "Client group", decisions D21 and D27; issue #120,
-- ticket A55). Clients are counted per service instead of named: one row per
-- service with the number of clients, their average fee a month, normal churn
-- a month, typical stay in months and starting health (0 to 100). The engine
-- simulates that many unnamed clients from these numbers, so late or missed
-- servicing work still lowers health and drives churn. A workspace with client
-- groups no longer simulates its named clients.
--
-- The named-client tables (`clients`, `client_services`, `client_assignments`)
-- are untouched: the app stops showing them, the data stays (nothing is
-- deleted), and a workspace with no client groups still simulates its named
-- clients exactly as before.
--
-- Backfill (additive insert only): every service that has active named clients
-- gets one group, so existing workspaces keep their numbers when they switch
-- to groups. Count: the active named clients taking the service. Fee: their
-- average MRR, a client's MRR split evenly across its services. Clients with a
-- start date in the future are left out. Starting health: their average health
-- (the workspace's `health_initial` setting, else 80, when none is entered).
-- A count above 2,000 is capped at 2,000. Normal churn and typical stay: the service's own base churn and
-- expected tenure. Services with no named clients get no row (their group
-- shows blank in Settings and is created on the first edit). Existing groups
-- are never changed (`on conflict do nothing`).
--
-- The benchmark the People page compares company client health against
-- (for example 70 to 80 for a small agency) is two optional keys of
-- `workspaces.settings`, `client_health_benchmark_low` and
-- `client_health_benchmark_high` (0 to 100): no schema change.
--
-- A group is a company-model fact, like the service it belongs to: the MCP
-- server can't write it directly (it suggests; decision D19) and every write
-- is audited, with `private.company_needs_review` and
-- `private.audit_company_write` (20261015000000_suggestions.sql, the former
-- redefined in 20261021000000_roles_and_workspaces.sql).
--
-- Strictly additive: one new table with its triggers, policies and grants,
-- the backfill insert, and `save_fields` redefined with `client_groups`
-- appended to its allow-list (nothing else in it changes).
--
-- Rollback (run as one transaction):
--
--   begin;
--   -- (dropping the table drops its triggers and policies)
--   drop table public.client_groups;
--   -- Restore save_fields' previous allow-list: re-run the `create or replace
--   -- function public.save_fields ... $$;` block from 20261016000000_servicing.sql.
--   -- (Or leave it: with the table gone, a save to it just errors.)
--   delete from supabase_migrations.schema_migrations where version = '20261111000000';
--   commit;
--
--   Optionally remove the benchmark keys:
--   update public.workspaces set settings = settings - 'client_health_benchmark_low' - 'client_health_benchmark_high';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.client_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  service_id uuid not null,
  -- How many clients the service has today.
  -- At most 2,000: what the engine expands a group to (MAX_GROUP_CLIENTS in packages/engine/src/clients.ts).
  client_count integer not null default 0 check (client_count >= 0 and client_count <= 2000),
  -- What one client pays a month, in the workspace currency.
  fee numeric not null default 0 check (fee >= 0),
  -- Share of clients that leave each month when everything is going well (0 to 1).
  churn_monthly numeric not null default 0 check (churn_monthly >= 0 and churn_monthly <= 1),
  -- How long a client usually stays, in months.
  stay_months numeric not null default 12 check (stay_months >= 0 and stay_months <= 1200),
  -- How happy the clients are today, 0 to 100.
  starting_health numeric not null default 80 check (starting_health >= 0 and starting_health <= 100),
  -- Provenance of the five numbers, {column: {source, at, by}}: stamped `entered` when a person changes one.
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  -- One group per service.
  unique (service_id),
  foreign key (service_id, workspace_id) references public.services (id, workspace_id) on delete cascade
);

create index on public.client_groups (workspace_id);

create trigger set_updated_at before update on public.client_groups for each row execute function public.set_updated_at();

create trigger stamp_provenance before insert or update on public.client_groups
  for each row execute function public.stamp_provenance('client_count', 'fee', 'churn_monthly', 'stay_months', 'starting_health');

-- Row-level security: members read, owners and editors write (as for services).
alter table public.client_groups enable row level security;

create policy "read client_groups" on public.client_groups for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert client_groups" on public.client_groups for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update client_groups" on public.client_groups for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete client_groups" on public.client_groups for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.client_groups to authenticated;
revoke all on public.client_groups from anon;

-- Company model (issue #25): the MCP server suggests changes rather than making them, and every write is audited.
create trigger needs_review before insert or update or delete on public.client_groups
  for each row execute function private.company_needs_review();
create trigger audit_company after insert or update or delete on public.client_groups
  for each row execute function private.audit_company_write();

-- ---------------------------------------------------------------------------
-- Backfill from the named clients (additive insert only)
-- ---------------------------------------------------------------------------

-- Provenance: these are estimates rolled up from the named clients, not values a person entered.
insert into public.client_groups (workspace_id, service_id, client_count, fee, churn_monthly, stay_months, starting_health, provenance)
select
  s.workspace_id,
  s.id,
  least(count(*), 2000)::integer,
  round(avg(c.mrr / n.services), 2),
  s.churn_monthly_base,
  s.tenure_months,
  coalesce(
    round(avg(c.health), 1),
    (select least(100, greatest(0, (w.settings ->> 'health_initial')::numeric)) from public.workspaces w
     where w.id = s.workspace_id and w.settings ->> 'health_initial' is not null), -- greatest(0, null) is 0, not null
    80
  ),
  (
    select jsonb_object_agg(col, jsonb_build_object('source', 'estimated', 'at', now(), 'note', 'Rolled up from named clients'))
    from unnest(array['client_count', 'fee', 'churn_monthly', 'stay_months', 'starting_health']) as col
  )
from public.services s
join public.client_services cs on cs.service_id = s.id and cs.workspace_id = s.workspace_id
join public.clients c on c.id = cs.client_id and c.workspace_id = s.workspace_id and c.active
  and (c.start_date is null or c.start_date <= current_date)
cross join lateral (
  select count(*)::numeric as services from public.client_services x where x.client_id = c.id
) n
group by s.workspace_id, s.id, s.churn_monthly_base, s.tenure_months
on conflict (service_id) do nothing;

-- ---------------------------------------------------------------------------
-- Per-field saves: `client_groups` joins save_fields' allow-list
-- ---------------------------------------------------------------------------

-- Copied from 20261016000000_servicing.sql (the latest to redefine it, #19); the
-- only change is 'client_groups' at the end of `editable`. This is now the
-- last migration to redefine save_fields, so its list must be the union of
-- every earlier one. `create or replace` keeps the grants made there.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services',
    'lead_sources', 'seasonality', 'demand_settings', 'issues', 'sources', 'clients', 'client_assignments', 'service_servicing', 'client_groups'];
  fixed constant text[] := array['id', 'workspace_id', 'created_at', 'updated_at', 'created_by'];
  key_match text;
  stored jsonb;
  typed_base jsonb;
  typed_changes jsonb;
  patch jsonb := '{}';
  conflicts jsonb := '{}';
  field text;
  col text;
  sub text;
  seen jsonb;
  mine jsonb;
  theirs jsonb;
  set_cols text;
  from_cols text;
begin
  if target is null or not (target = any (editable)) then
    raise exception 'save_fields: table % is not editable', target using errcode = '42501';
  end if;
  if jsonb_typeof(key) is distinct from 'object' or key = '{}' then
    raise exception 'save_fields: key must be a non-empty object' using errcode = '22023';
  end if;
  if jsonb_typeof(changes) is distinct from 'object' or changes = '{}' then
    raise exception 'save_fields: changes must be a non-empty object' using errcode = '22023';
  end if;
  if jsonb_typeof(base) is distinct from 'object' then
    raise exception 'save_fields: base must be an object' using errcode = '22023';
  end if;

  select string_agg(format('t.%1$I = k.%1$I', kc.name), ' and ') into key_match from jsonb_object_keys(key) as kc(name);

  -- Lock the row. RLS applies: a row the user may not update is not found.
  execute format(
    'select to_jsonb(t) from public.%1$I t, jsonb_populate_record(null::public.%1$I, $1) k where %2$s for update of t',
    target, key_match)
  into stored using key;
  if stored is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Round-trip top-level values through the column types so "1.50" and 1.5, or
  -- two spellings of a date, compare equal.
  execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', target) into typed_base using base;
  execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', target) into typed_changes using changes;

  for field in select jsonb_object_keys(changes) loop
    -- A field is a column, or `column.key` for one key of a jsonb column (e.g. settings.availability_floor).
    col := split_part(field, '.', 1);
    sub := nullif(substr(field, length(col) + 2), '');
    if col = any (fixed) or key ? col or not stored ? col or position('.' in coalesce(sub, '')) > 0 then
      raise exception 'save_fields: % cannot be saved', field using errcode = '42501';
    end if;
    if not base ? field then
      raise exception 'save_fields: no base value for %', field using errcode = '22023';
    end if;

    if sub is null then
      seen := typed_base -> col;
      mine := typed_changes -> col;
      theirs := stored -> col;
    else
      if jsonb_typeof(stored -> col) not in ('object', 'null') then
        raise exception 'save_fields: % is not a json object', col using errcode = '42501';
      end if;
      seen := coalesce(base -> field, 'null');
      mine := coalesce(changes -> field, 'null');
      theirs := coalesce(stored -> col -> sub, 'null');
    end if;

    if theirs is distinct from seen and theirs is distinct from mine then
      conflicts := conflicts || jsonb_build_object(field, theirs);
    elsif theirs is distinct from mine then
      if sub is null then
        patch := patch || jsonb_build_object(col, mine);
      else
        patch := patch || jsonb_build_object(col,
          coalesce(patch -> col, nullif(stored -> col, 'null'), '{}') || jsonb_build_object(sub, mine));
      end if;
    end if;
  end loop;

  if patch <> '{}' then
    select string_agg(quote_ident(pc.name), ', '), string_agg('p.' || quote_ident(pc.name), ', ')
      into set_cols, from_cols from jsonb_object_keys(patch) as pc(name);
    execute format(
      'update public.%1$I t set (%3$s) = (select %4$s from jsonb_populate_record(null::public.%1$I, $2) p)
       from jsonb_populate_record(null::public.%1$I, $1) k where %2$s returning to_jsonb(t)',
      target, key_match, set_cols, from_cols)
    into stored using key, patch;
  end if;

  return jsonb_build_object(
    'status', case when conflicts = '{}' then 'saved' else 'conflict' end,
    'row', stored,
    'conflicts', conflicts);
end;
$$;

-- Production data alignment (run once, by hand, after the migration):
--
-- Austin asked for the Northbeam example to be tidied under client groups, and
-- production Northbeam is that example. This sets its two groups to the seed's
-- values (NORTHBEAM_CLIENT_GROUPS in packages/engine/src/fixtures/northbeam-roster.ts):
-- SEO retainer 17 clients at 3,456 a month, 3% normal churn, 18 months, health 83;
-- PPC management 12 clients at 4,229, 4%, 12 months, health 52 (the group that is
-- at risk). Scoped by workspace slug 'northbeam' and service name; touches only
-- client_groups rows that already exist (the backfill makes them); idempotent:
-- rows already at these values are left alone, so a second run changes nothing.
--
-- begin;
-- update public.client_groups g
-- set client_count = v.client_count, fee = v.fee, churn_monthly = v.churn_monthly, stay_months = v.stay_months, starting_health = v.starting_health
-- from (values
--   ('SEO retainer', 17, 3456, 0.03, 18, 83),
--   ('PPC management', 12, 4229, 0.04, 12, 52)
-- ) as v (service_name, client_count, fee, churn_monthly, stay_months, starting_health)
-- join public.services s on s.name = v.service_name
-- join public.workspaces w on w.id = s.workspace_id and w.slug = 'northbeam'
-- where g.service_id = s.id
--   and (g.client_count, g.fee, g.churn_monthly, g.stay_months, g.starting_health)
--     is distinct from (v.client_count, v.fee, v.churn_monthly, v.stay_months, v.starting_health);
-- commit;
