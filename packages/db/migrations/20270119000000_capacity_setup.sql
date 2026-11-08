-- Capacity Set up (docs/plans/capacity/p1-setup-brief.md, work package P1; decisions D3-D5, D13, D16-D19, D23, D26, D27, D35-D37).
--
-- Where Joe (the Owner) and Agency admins key in everything the capacity figures need: departments and tiers, each tier's
-- deliverables, named clients with their own overrides, counted clients through each person's portfolio, people's team time and
-- salary, and roles' department, kind, line, rule of thumb and unit.
--
-- THIS ONLY STORES. It changes nothing the engine is given: `toEngineModel` reads none of the new columns and tables
-- (packages/db/test/engine-model-snapshot.test.ts holds the model from before this migration). P2 wires them in.
--
-- Strictly additive: new tables, new nullable or defaulted columns, new check constraints on the new columns, and two typed
-- workspace settings keys. Two data touches, both inside this file: the two departments for every workspace that has none, and
-- `provenance` for the columns that start with a default (`services.price_rise_churn`, `roles.line`: `estimate`).
--
-- New tables (all: row-level security like the neighbouring client_groups: members read, the Owner and Agency admins write
-- (public.can_edit_workspace); the MCP server can't write them and every write is audited, like the rest of the company model):
--   departments       Organic (SEO) and Performance. Seeded for every workspace that has none and for each new workspace.
--   tiers             "T1", "Tier 1", sort, and `both_count`: counted clients taking both services (D23).
--   person_tiers      the tiers a person can serve.
--   person_portfolio  counted clients a person looks after, per service (D4).
-- A service with department_id and tier_id both set IS that tier of that department (one active service per pair).
-- A service is already a service to the engine: one that becomes a tier (department_id and tier_id set) changes nothing it is given, but a tier made
-- NEW (add_tier, the capacity starter) brings new services, which enter the model like any other service until P2 decides how tiers feed it.
--
-- Provenance: every editable number keeps `{column: {source, at, by}}`. The source is `entered` when a person changes it, or
-- `interview | calculator | measured | estimate`; seeded defaults are `estimate`. private.stamp_entered() stamps like
-- public.stamp_provenance() but never stamps a null (a deliverable nobody has keyed in is "missing", not "entered"), and
-- leaves a column that starts with a default (named '=column') unstamped on insert: the seeds and the starter say `estimate` themselves.
--
-- Functions: public.add_tier(workspace) copies the last tier's values for each department (no clients, no counts);
-- public.remove_tier(tier) refuses, in plain words, the last remaining tier and a tier that still has clients, a portfolio, counted
-- clients or servicing steps. public.save_fields is redefined (a full copy of the 20261111000000 body) with `departments`, `tiers`
-- and `person_portfolio` added to its allow-list; public.save_links is redefined (a full copy of the 20261012000000 body) with
-- `person_tiers` added. public.import_workspace_bundle is redefined (a full copy of the 20270118000000
-- body) so a backup restores the new tables and columns; IMPORT_COLUMNS in packages/db/src/workspace-import.ts is its twin.
--
-- Runs on a database full of real rows (the production copy imported at 20261231000000, then every later migration): adding
-- nullable or defaulted columns rewrites no data; the backfills touch only the departments (new rows) and two provenance keys.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270119000000';` expect 0.
--   Record: select count(*) from public.services; select count(*) from public.roles; select count(*) from public.workspaces;
-- Post-apply checks:
--   -- every workspace has two departments; no service, client, person or role changed except the two provenance keys
--   select count(*) from public.workspaces w where (select count(*) from public.departments d where d.workspace_id = w.id) <> 2; -- 0
--   select count(*) from public.tiers; -- 0 (no tier is invented for an existing workspace)
--
-- ROLLBACK (run as one transaction):
--
--   begin;
--   drop trigger if exists seed_departments on public.workspaces;
--   drop function if exists private.seed_departments();
--   drop function if exists public.add_tier(uuid);
--   drop function if exists public.remove_tier(uuid);
--   drop function if exists private.tier_blocker(uuid);
--   drop trigger stamp_entered on public.services;
--   drop trigger stamp_entered on public.clients;
--   drop trigger stamp_entered on public.people;
--   drop trigger stamp_entered on public.roles;
--   alter table public.workspaces drop constraint if exists workspaces_ramp_default;
--   alter table public.workspaces drop constraint if exists workspaces_dler_includes_leadership;
--   drop table public.person_portfolio;
--   drop table public.person_tiers;
--   alter table public.services drop column department_id, drop column tier_id, drop column words, drop column links,
--     drop column tech_hours, drop column meetings, drop column builds, drop column creative_sets, drop column channels,
--     drop column adhoc_chance, drop column adhoc_requests, drop column price_rise_churn;
--   alter table public.clients drop column channels, drop column hand_holding_hours, drop column adhoc_chance,
--     drop column adhoc_requests, drop column adhoc_hours, drop column meetings, drop column words, drop column links,
--     drop column tech_hours, drop column builds, drop column creative_sets, drop column step_factor;
--   alter table public.people drop column reserved_share, drop column salary_monthly, drop column label, drop column ramp;
--   alter table public.roles drop column department_id, drop column kind, drop column line, drop column rule_of_thumb, drop column unit;
--   drop table public.tiers;
--   drop table public.departments;
--   drop function if exists private.stamp_entered();
--   -- Restore the previous bodies: re-run `create or replace function public.save_fields ...` from 20261111000000_client_groups.sql,
--   -- `public.save_links` from 20261012000000_clients.sql and `public.import_workspace_bundle` from 20270118000000_capacity_cuts.sql.
--   update public.workspaces set settings = settings - 'ramp_default' - 'dler_includes_leadership';
--   delete from public.schema_migrations where version = '20270119000000';
--   commit;

-- An automated change, audited as the system's.
select set_config('transpera.actor_kind', 'system', true);

-- ---------------------------------------------------------------------------
-- Provenance stamping for the new columns
-- ---------------------------------------------------------------------------

create function private.stamp_entered() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  arg text;
  col text;
  defaulted boolean;
  prov jsonb := coalesce(new.provenance, '{}');
  new_row jsonb := to_jsonb(new);
  old_row jsonb;
  entered jsonb := jsonb_strip_nulls(jsonb_build_object('source', 'entered', 'at', now(), 'by', auth.uid()));
begin
  if tg_op = 'UPDATE' then
    old_row := to_jsonb(old);
  end if;
  foreach arg in array tg_argv loop
    -- A name starting with "=" is a column that starts with a default: an insert leaves it unstamped (seeds and the starter say
    -- `estimate` themselves), a change stamps it like any other.
    defaulted := left(arg, 1) = '=';
    col := case when defaulted then substr(arg, 2) else arg end;
    if tg_op = 'INSERT' then
      if not defaulted and not prov ? col and new_row -> col is distinct from 'null'::jsonb then
        prov := prov || jsonb_build_object(col, entered);
      end if;
    elsif new_row -> col is distinct from old_row -> col
      and prov -> col is not distinct from coalesce(old_row -> 'provenance', '{}') -> col then
      -- Cleared back to "not entered": the provenance goes with the number.
      if new_row -> col is not distinct from 'null'::jsonb then
        prov := prov - col;
      else
        prov := prov || jsonb_build_object(col, entered);
      end if;
    end if;
  end loop;
  new.provenance := prov;
  return new;
end;
$$;
revoke all on function private.stamp_entered() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null constraint departments_name check (char_length(btrim(name)) between 1 and 100),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);
create unique index departments_workspace_name_key on public.departments (workspace_id, lower(btrim(name)));
create index on public.departments (workspace_id);

-- ---------------------------------------------------------------------------
-- tiers
-- ---------------------------------------------------------------------------

create table public.tiers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- "T1": shared by both departments (Tiers are shared by both departments).
  key text not null constraint tiers_key check (key ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,19}$'),
  name text not null constraint tiers_name check (char_length(btrim(name)) between 1 and 100),
  sort integer not null default 0,
  -- Counted clients taking both services in this tier (D23): feeds the unique-clients figure only.
  both_count integer not null default 0 check (both_count >= 0 and both_count <= 100000),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  unique (workspace_id, key)
);
create index on public.tiers (workspace_id);

-- ---------------------------------------------------------------------------
-- services: a service with both set is that tier of that department
-- ---------------------------------------------------------------------------

alter table public.services
  add column department_id uuid,
  add column tier_id uuid,
  -- What one client of the tier gets in a month (null: not entered).
  add column words numeric check (words >= 0),
  add column links numeric check (links >= 0),
  add column tech_hours numeric check (tech_hours >= 0),
  add column meetings numeric check (meetings >= 0),
  add column builds numeric check (builds >= 0),
  add column creative_sets numeric check (creative_sets >= 0),
  add column channels numeric check (channels >= 0),
  -- D26: the share of the tier's clients who ask in a month, and the requests from a client who asks.
  add column adhoc_chance numeric check (adhoc_chance >= 0 and adhoc_chance <= 1),
  add column adhoc_requests numeric check (adhoc_requests >= 0),
  -- D36: extra churn for each 10% price rise, for 3 months, as a share (0.5 = churn x 1.5). Stored only; the Sandbox (P7) uses it.
  add column price_rise_churn numeric not null default 0.5 constraint services_price_rise_churn check (price_rise_churn >= 0 and price_rise_churn <= 10);

alter table public.services
  -- Deferred (as the steps' role and person references are): deleting a workspace deletes its departments and tiers before its services, and an
  -- immediate check would stop it. A tier or department with services still can't be deleted: the check fails at commit.
  add constraint services_department_fkey foreign key (department_id, workspace_id) references public.departments (id, workspace_id) deferrable initially deferred,
  add constraint services_tier_fkey foreign key (tier_id, workspace_id) references public.tiers (id, workspace_id) deferrable initially deferred,
  add constraint services_department_and_tier check ((department_id is null) = (tier_id is null));
create unique index services_department_tier_key on public.services (department_id, tier_id) where active and tier_id is not null;
create index on public.services (tier_id) where tier_id is not null;

comment on column public.services.department_id is 'With tier_id: this service is that tier of that department (Set up, Tiers & clients).';
comment on column public.services.price_rise_churn is 'D36: extra churn for each 10% rise for 3 months, as a share (0.5 = churn x 1.5). Stored only until the Sandbox uses it.';

create trigger stamp_entered before insert or update on public.services
  for each row execute function private.stamp_entered('words', 'links', 'tech_hours', 'meetings', 'builds', 'creative_sets', 'channels',
    'adhoc_chance', 'adhoc_requests', '=price_rise_churn');

-- ---------------------------------------------------------------------------
-- clients: a named client's own values, each replacing its tier's (null uses the tier)
-- ---------------------------------------------------------------------------

alter table public.clients
  add column channels numeric check (channels >= 0),
  add column hand_holding_hours numeric check (hand_holding_hours >= 0),
  add column adhoc_chance numeric check (adhoc_chance >= 0 and adhoc_chance <= 1),
  add column adhoc_requests numeric check (adhoc_requests >= 0),
  -- Hands-on hours per request (the Set up screen shows minutes).
  add column adhoc_hours numeric check (adhoc_hours >= 0),
  add column meetings numeric check (meetings >= 0),
  add column words numeric check (words >= 0),
  add column links numeric check (links >= 0),
  add column tech_hours numeric check (tech_hours >= 0),
  add column builds numeric check (builds >= 0),
  add column creative_sets numeric check (creative_sets >= 0),
  -- Times every step's time for this client.
  add column step_factor numeric check (step_factor > 0 and step_factor <= 20);

create trigger stamp_entered before insert or update on public.clients
  for each row execute function private.stamp_entered('channels', 'hand_holding_hours', 'adhoc_chance', 'adhoc_requests', 'adhoc_hours',
    'meetings', 'words', 'links', 'tech_hours', 'builds', 'creative_sets', 'step_factor');

-- ---------------------------------------------------------------------------
-- people
-- ---------------------------------------------------------------------------

alter table public.people
  -- Team time: the share of their hours kept for leading, mentoring and reviews.
  add column reserved_share numeric not null default 0 constraint people_reserved_share check (reserved_share >= 0 and reserved_share <= 0.9),
  add column salary_monthly numeric constraint people_salary_monthly check (salary_monthly >= 0),
  add column label text constraint people_label check (label in ('contractor', 'offshore')),
  -- Share of full capacity in each month from the start date, e.g. [0.4, 0.6, 0.8]; null uses the workspace default.
  add column ramp jsonb constraint people_ramp check (
    ramp is null or (jsonb_typeof(ramp) = 'array' and jsonb_array_length(ramp) between 1 and 12
      and not jsonb_path_exists(ramp, '$[*] ? (@.type() != "number" || @ < 0 || @ > 1)')));

create trigger stamp_entered before insert or update on public.people
  for each row execute function private.stamp_entered('=reserved_share', 'salary_monthly', 'ramp');

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------

alter table public.roles
  add column department_id uuid,
  add column kind text not null default 'client_facing' constraint roles_kind check (kind in ('client_facing', 'shared')),
  -- D17: the busy share a role counts as full.
  add column line numeric not null default 0.85 constraint roles_line check (line > 0 and line <= 1.5),
  -- The rule of thumb: most clients one person holds, shown as a line.
  add column rule_of_thumb integer constraint roles_rule_of_thumb check (rule_of_thumb > 0 and rule_of_thumb <= 10000),
  -- D27: the unit a shared team works in (words, links, ticket hours, tasks, set-ups and incidents). No rates here (D35).
  add column unit text constraint roles_unit check (char_length(btrim(unit)) between 1 and 60);
alter table public.roles
  add constraint roles_department_fkey foreign key (department_id, workspace_id) references public.departments (id, workspace_id) on delete set null (department_id);

create trigger stamp_entered before insert or update on public.roles
  for each row execute function private.stamp_entered('=kind', '=line', 'rule_of_thumb', 'unit');

-- ---------------------------------------------------------------------------
-- person_tiers, person_portfolio
-- ---------------------------------------------------------------------------

create table public.person_tiers (
  person_id uuid not null,
  tier_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (person_id, tier_id),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade,
  foreign key (tier_id, workspace_id) references public.tiers (id, workspace_id) on delete cascade
);
create index on public.person_tiers (workspace_id);
create index on public.person_tiers (tier_id);

create table public.person_portfolio (
  person_id uuid not null,
  service_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- D4: counted clients this person looks after, for this service (a service is a tier of a department).
  client_count integer not null default 0 check (client_count >= 0 and client_count <= 100000),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (person_id, service_id),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade,
  foreign key (service_id, workspace_id) references public.services (id, workspace_id) on delete cascade
);
create index on public.person_portfolio (workspace_id);
create index on public.person_portfolio (service_id);

create trigger stamp_entered before insert or update on public.tiers
  for each row execute function private.stamp_entered('both_count');
create trigger stamp_entered before insert or update on public.person_portfolio
  for each row execute function private.stamp_entered('client_count');

-- ---------------------------------------------------------------------------
-- Triggers, row-level security and grants for the new tables (as client_groups)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['departments', 'tiers', 'person_tiers', 'person_portfolio'] loop
    if t in ('departments', 'tiers', 'person_portfolio') then
      execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "read %1$s" on public.%1$I for select to authenticated using (public.can_read_workspace(workspace_id))', t);
    execute format('create policy "insert %1$s" on public.%1$I for insert to authenticated with check (public.can_edit_workspace(workspace_id))', t);
    execute format('create policy "update %1$s" on public.%1$I for update to authenticated using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id))', t);
    execute format('create policy "delete %1$s" on public.%1$I for delete to authenticated using (public.can_edit_workspace(workspace_id))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    -- Company model: the MCP server can't write them and every write is audited.
    execute format('create trigger needs_review before insert or update or delete on public.%I for each row execute function private.company_needs_review()', t);
    execute format('create trigger audit_company after insert or update or delete on public.%I for each row execute function private.audit_company_write()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Workspace settings keys: ramp_default (a list of 1 to 12 shares from 0 to 1) and dler_includes_leadership (true or false)
-- ---------------------------------------------------------------------------

alter table public.workspaces add constraint workspaces_ramp_default check (
  case
    when not (settings ? 'ramp_default') then true
    when jsonb_typeof(settings -> 'ramp_default') = 'null' then true
    when jsonb_typeof(settings -> 'ramp_default') <> 'array' then false
    else jsonb_array_length(settings -> 'ramp_default') between 1 and 12
      and not jsonb_path_exists(settings -> 'ramp_default', '$[*] ? (@.type() != "number" || @ < 0 || @ > 1)')
  end) not valid;
alter table public.workspaces add constraint workspaces_dler_includes_leadership check (
  case
    when not (settings ? 'dler_includes_leadership') then true
    else jsonb_typeof(settings -> 'dler_includes_leadership') in ('boolean', 'null')
  end) not valid;

-- ---------------------------------------------------------------------------
-- Departments for new workspaces, and for the ones that exist (only where there are none)
-- ---------------------------------------------------------------------------

create function private.seed_departments() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.departments (workspace_id, name, sort) values (new.id, 'Organic (SEO)', 1), (new.id, 'Performance', 2)
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function private.seed_departments() from public, anon, authenticated;

create trigger seed_departments after insert on public.workspaces
  for each row execute function private.seed_departments();

insert into public.departments (workspace_id, name, sort)
select w.id, d.name, d.sort
from public.workspaces w
cross join (values ('Organic (SEO)', 1), ('Performance', 2)) as d (name, sort)
where not exists (select 1 from public.departments x where x.workspace_id = w.id)
on conflict do nothing;

-- Seeded defaults are estimates: the two columns that start with a default say so. Existing rows' updated_at stays as it was.
alter table public.services disable trigger set_updated_at;
alter table public.roles disable trigger set_updated_at;
update public.services
set provenance = provenance || jsonb_build_object('price_rise_churn', jsonb_build_object('source', 'estimate', 'at', now()))
where not provenance ? 'price_rise_churn';
update public.roles
set provenance = provenance || jsonb_build_object('line', jsonb_build_object('source', 'estimate', 'at', now()))
where not provenance ? 'line';
alter table public.services enable trigger set_updated_at;
alter table public.roles enable trigger set_updated_at;

-- ---------------------------------------------------------------------------
-- Adding and removing tiers
-- ---------------------------------------------------------------------------

-- Why a tier can't go, in plain words; null when it can. The last remaining tier, then clients, a portfolio, counted clients, servicing.
create function private.tier_blocker(p_tier uuid) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  t public.tiers;
  n integer;
begin
  select * into t from public.tiers where id = p_tier;
  if not found then
    return 'That tier doesn''t exist.';
  end if;
  if (select count(*) from public.tiers x where x.workspace_id = t.workspace_id) <= 1 then
    return 'You can''t remove the last tier: every workspace keeps at least one.';
  end if;
  select count(distinct cs.client_id) into n from public.client_services cs join public.services s on s.id = cs.service_id where s.tier_id = p_tier;
  if n > 0 then
    return format('%s named client%s still take%s %s. Move or remove %s first.', n, case when n = 1 then '' else 's' end, case when n = 1 then 's' else '' end, t.key, case when n = 1 then 'that client' else 'those clients' end);
  end if;
  select count(*) into n from public.person_portfolio pp join public.services s on s.id = pp.service_id where s.tier_id = p_tier and pp.client_count > 0;
  if n > 0 then
    return format('%s has clients in people''s portfolios. Set those counts to 0 first.', t.key);
  end if;
  select coalesce(sum(g.client_count), 0) into n from public.client_groups g join public.services s on s.id = g.service_id where s.tier_id = p_tier;
  if n > 0 then
    return format('%s still has %s counted client%s. Set that count to 0 first.', t.key, n, case when n = 1 then '' else 's' end);
  end if;
  if exists (select 1 from public.service_servicing ss join public.services s on s.id = ss.service_id where s.tier_id = p_tier) then
    return format('%s has servicing steps set up. Remove those first.', t.key);
  end if;
  return null;
end;
$$;
revoke all on function private.tier_blocker(uuid) from public, anon;
grant execute on function private.tier_blocker(uuid) to authenticated;

-- A new tier starts as a copy of the last one's values, for each department; its counts start at 0. Invoker: RLS decides who may.
create function public.add_tier(p_workspace uuid) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  last_tier public.tiers;
  new_id uuid;
  n integer;
begin
  if p_workspace is null or not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'Only Agency admins and the Owner can change tiers.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tiers:' || p_workspace::text, 0));
  select * into last_tier from public.tiers where workspace_id = p_workspace order by sort desc, created_at desc limit 1;
  select coalesce(max((regexp_match(key, '^T([0-9]{1,6})$'))[1]::integer), 0) + 1 into n from public.tiers where workspace_id = p_workspace;
  insert into public.tiers (workspace_id, key, name, sort) values (p_workspace, 'T' || n, 'Tier ' || n, coalesce(last_tier.sort, 0) + 1) returning id into new_id;
  insert into public.services (workspace_id, name, pricing_model, price, margin, tenure_months, churn_monthly_base, churn_health_sensitivity, mix_share,
    price_low, price_high, department_id, tier_id, words, links, tech_hours, meetings, builds, creative_sets, channels, adhoc_chance, adhoc_requests,
    price_rise_churn, provenance)
  select p_workspace, regexp_replace(d.name, '\s*\(.*\)\s*$', '') || ' Tier ' || n,
    coalesce(s.pricing_model, 'retainer'), coalesce(s.price, 0), coalesce(s.margin, 0), coalesce(s.tenure_months, 12), coalesce(s.churn_monthly_base, 0),
    coalesce(s.churn_health_sensitivity, 3), coalesce(s.mix_share, 1), s.price_low, s.price_high, d.id, new_id,
    s.words, s.links, s.tech_hours, s.meetings, s.builds, s.creative_sets, s.channels, s.adhoc_chance, s.adhoc_requests,
    coalesce(s.price_rise_churn, 0.5), coalesce(s.provenance, '{}')
  from public.departments d
  left join public.services s on s.department_id = d.id and s.tier_id = last_tier.id and s.active
  where d.workspace_id = p_workspace
  order by d.sort, d.name;
  return new_id;
end;
$$;
revoke all on function public.add_tier(uuid) from public, anon;
grant execute on function public.add_tier(uuid) to authenticated;

create function public.remove_tier(p_tier uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  t public.tiers;
  why text;
begin
  select * into t from public.tiers where id = p_tier;
  if not found then
    raise exception 'That tier doesn''t exist.' using errcode = 'P0002';
  end if;
  if not coalesce(public.can_edit_workspace(t.workspace_id), false) then
    raise exception 'Only Agency admins and the Owner can change tiers.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tiers:' || t.workspace_id::text, 0));
  why := private.tier_blocker(p_tier);
  if why is not null then
    raise exception '%', why using errcode = '23514', hint = 'tier_in_use';
  end if;
  delete from public.services where tier_id = p_tier;
  delete from public.tiers where id = p_tier;
end;
$$;
revoke all on function public.remove_tier(uuid) from public, anon;
grant execute on function public.remove_tier(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Per-field saves: departments, tiers and person_portfolio join save_fields' allow-list
-- ---------------------------------------------------------------------------

-- Copied from 20261111000000_client_groups.sql (the latest to redefine it); the only change is the three names at the end of
-- `editable`. This is now the last migration to redefine save_fields, so its list is the union of every earlier one.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services',
    'lead_sources', 'seasonality', 'demand_settings', 'issues', 'sources', 'clients', 'client_assignments', 'service_servicing', 'client_groups',
    'departments', 'tiers', 'person_portfolio'];
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

-- ---------------------------------------------------------------------------
-- Link sets: a person's tiers join save_links' allow-list
-- ---------------------------------------------------------------------------

-- Copied from 20261012000000_clients.sql (the latest to redefine it); the only change is `"person_tiers": "tier_id"` in `links`.
create or replace function public.save_links(target text, owner jsonb, member text, base jsonb, next jsonb) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  -- Link tables and their member column. Keep in sync with `LinkTable` in the app.
  links constant jsonb := '{"person_roles": "role_id", "person_skills": "step_id", "client_services": "service_id", "person_tiers": "tier_id"}';
  owner_match text;
  owner_cols text;
  sorted_base jsonb;
  sorted_next jsonb;
  stored jsonb;
begin
  if target is null or links ->> target is distinct from member then
    raise exception 'save_links: %.% is not an editable set', target, member using errcode = '42501';
  end if;
  if jsonb_typeof(owner) is distinct from 'object' or not owner ? 'workspace_id' or owner ? member then
    raise exception 'save_links: owner must be an object with workspace_id' using errcode = '22023';
  end if;
  if jsonb_typeof(base) is distinct from 'array' or jsonb_typeof(next) is distinct from 'array' then
    raise exception 'save_links: base and next must be arrays' using errcode = '22023';
  end if;
  -- Deletes of rows RLS hides would silently do nothing, so check up front.
  -- coalesce: the helper returns null, not false, for users with no membership.
  if not coalesce(public.can_edit_workspace((owner ->> 'workspace_id')::uuid), false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select string_agg(format('t.%1$I = k.%1$I', oc.name), ' and '), string_agg(quote_ident(oc.name), ', ')
    into owner_match, owner_cols from jsonb_object_keys(owner) as oc(name);

  -- Serialise edits of the same set (there is no single row to lock).
  perform pg_advisory_xact_lock(hashtextextended(target || owner::text, 0));

  select coalesce(jsonb_agg(distinct e.v order by e.v), '[]') into sorted_base from jsonb_array_elements(base) as e(v);
  select coalesce(jsonb_agg(distinct e.v order by e.v), '[]') into sorted_next from jsonb_array_elements(next) as e(v);
  execute format(
    'select coalesce(jsonb_agg(distinct to_jsonb(t.%3$I) order by to_jsonb(t.%3$I)), ''[]'')
     from public.%1$I t, jsonb_populate_record(null::public.%1$I, $1) k where %2$s',
    target, owner_match, member)
  into stored using owner;

  if stored <> sorted_base and stored <> sorted_next then
    return jsonb_build_object('status', 'conflict', 'members', stored);
  end if;

  if stored <> sorted_next then
    execute format(
      'delete from public.%1$I t using jsonb_populate_record(null::public.%1$I, $1) k
       where %2$s and not ($2 @> to_jsonb(t.%3$I))',
      target, owner_match, member)
    using owner, sorted_next;
    execute format(
      'insert into public.%1$I (%2$s, %3$I)
       select %4$s, r.%3$I from jsonb_array_elements($2) as m(v),
         jsonb_populate_record(null::public.%1$I, $1 || jsonb_build_object(%3$L, m.v)) r
       where not ($3 @> m.v)',
      target, owner_cols, member,
      (select string_agg('r.' || quote_ident(oc.name), ', ') from jsonb_object_keys(owner) as oc(name)))
    using owner, sorted_next, stored;
  end if;

  return jsonb_build_object('status', 'saved', 'members', sorted_next);
end;
$$;

-- ---------------------------------------------------------------------------
-- Restores carry the new tables and columns: the 20270118000000 body of public.import_workspace_bundle with the
-- additions listed at the top of the declare block; nothing else changed.
-- ---------------------------------------------------------------------------

create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 set search_path = ''
 SET statement_timeout TO '40s'
as $$
declare
  -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
  -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
  -- #228: person_capacity_factors is in this list, in ref_cols, in sections and in list_sections.
  allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at","department_id","kind","line","rule_of_thumb","unit"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at","reserved_share","salary_monthly","label","ramp"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","chance","effect","effect_months","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at","channels","hand_holding_hours","adhoc_chance","adhoc_requests","adhoc_hours","meetings","words","links","tech_hours","builds","creative_sets","step_factor"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","purpose","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"sandbox_scenarios":["id","parent_id","name","description","changes","horizon_months","start_date","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","price_high","price_low","pricing_model","tenure_months","provenance","created_at","department_id","tier_id","words","links","tech_hours","meetings","builds","creative_sets","channels","adhoc_chance","adhoc_requests","price_rise_churn"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"person_capacity_factors":["person_id","step_id","factor","provenance"],"departments":["id","name","sort","created_at"],"tiers":["id","key","name","sort","both_count","provenance","created_at"],"person_tiers":["person_id","tier_id","created_at"],"person_portfolio":["person_id","service_id","client_count","provenance","created_at"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"]}'::jsonb;
  -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
  -- column in `allow` is checked on `id` too.
  -- #228
  ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','sandbox_scenarios.parent_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','market_schedule.condition_id','person_capacity_factors.person_id','person_capacity_factors.step_id','person_tiers.person_id','person_tiers.tier_id','person_portfolio.person_id','person_portfolio.service_id','services.department_id','services.tier_id','roles.department_id'];
  step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
  -- The order the sections are written in.
  -- #228
  sections constant text[] := array['settings','departments','tiers','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','sandbox_scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','person_tiers','person_portfolio','source_links','archive','log'];
  -- #228
  list_sections constant text[] := array['departments','tiers','roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','sandbox_scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','person_tiers','person_portfolio','source_links'];
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
  -- Capacity Set up (20270119000000): a plan made before departments, tiers, tiers served and portfolios were restored has none.
  foreach sec in array array['departments','tiers','person_tiers','person_portfolio'] loop
    if not p_plan ? sec then
      p_plan := p_plan || jsonb_build_object(sec, '[]'::jsonb);
    end if;
  end loop;
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
    or jsonb_array_length(p_plan -> 'departments') > 50 or jsonb_array_length(p_plan -> 'tiers') > 100
    or jsonb_array_length(p_plan -> 'person_tiers') > 3000 or jsonb_array_length(p_plan -> 'person_portfolio') > 3000
    or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
      + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
      + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
    -- #228
    raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 50 departments, 100 tiers, 3000 tiers served, 3000 portfolio counts, 3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times)' using errcode = '22023';
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
        if n > 0 and sec in ('departments', 'tiers') then
          -- A new workspace starts with its two departments: the backup's replace them (the workspace is empty, checked above).
          execute format('delete from public.%I where workspace_id = $1', tbl) using p_workspace;
        end if;
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
