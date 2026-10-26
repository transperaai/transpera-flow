-- Client roster (docs/PRD.md §4.1 Company model "Clients (roster)", §5
-- `clients`, `client_services`, `client_assignments`, §6.3.4; decisions D7,
-- D13; issue #18). Named clients with their services, start date, MRR,
-- health and notes, and the person looking after each per role. Per-person
-- client counts are derived from the assignments (replacing v0.2's
-- `person_assignments.client_count`, which this schema never had).
--
-- Deviation from §5: health's provenance lives in `provenance` keyed by
-- column ({health: {...}, mrr: {...}}), as for lead sources, so the existing
-- `stamp_provenance` trigger marks a value a person changes as `entered`.
-- `health` is nullable: null means not entered, and the simulation uses the
-- estimated default of 80 (§6.3.5).
--
-- The overtime cap (§5 `workspaces.settings.overtime_cap`, default 0) is a key
-- of the settings jsonb, like `availability_floor`: no schema change.
--
-- Strictly additive: three new tables; a nullable `issues.client_id` linking an
-- issue to a client; `save_fields` redefined with `clients` and
-- `client_assignments` appended to its allow-list, and `save_links` with
-- `client_services` added to its link tables (nothing else in either changes).
--
-- Rollback (run as one transaction):
--
--   begin;
--   alter table public.issues drop column client_id;
--   drop table public.client_assignments, public.client_services, public.clients;
--   -- Restore save_fields' previous allow-list: re-run the `create or replace
--   -- function public.save_fields ... $$;` block from 20261009000000_sources.sql,
--   -- and save_links' from 20260930000000_field_saves.sql with `create function`
--   -- changed to `create or replace function`. (Or leave them: with the tables
--   -- gone, a save to them just errors.)
--   delete from supabase_migrations.schema_migrations where version = '20261012000000';
--   commit;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  -- When they became a client.
  start_date date,
  -- Monthly recurring revenue, in the workspace currency.
  mrr numeric not null default 0 check (mrr >= 0),
  -- 0–100; null: not entered (the simulation starts them at the estimated 80).
  health numeric check (health >= 0 and health <= 100),
  -- Provenance of mrr and health, {column: {source, at, by}}.
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  notes text,
  -- Inactive clients (they left) stay on record but are left out of simulations.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

-- The services a client takes.
create table public.client_services (
  client_id uuid not null,
  service_id uuid not null,
  workspace_id uuid not null,
  -- When they started on this service; null: with the client.
  start_date date,
  created_at timestamptz not null default now(),
  primary key (client_id, service_id),
  foreign key (client_id, workspace_id) references public.clients (id, workspace_id) on delete cascade,
  foreign key (service_id, workspace_id) references public.services (id, workspace_id) on delete cascade
);

-- The person looking after a client, per role. No row: the role's people share it.
create table public.client_assignments (
  client_id uuid not null,
  role_id uuid not null,
  person_id uuid not null,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_id, role_id),
  foreign key (client_id, workspace_id) references public.clients (id, workspace_id) on delete cascade,
  foreign key (role_id, workspace_id) references public.roles (id, workspace_id) on delete cascade,
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);

create index on public.clients (workspace_id);
create index on public.client_services (workspace_id);
create index on public.client_services (service_id);
create index on public.client_assignments (workspace_id);
create index on public.client_assignments (person_id);

create trigger set_updated_at before update on public.clients for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.client_assignments for each row execute function public.set_updated_at();

create trigger stamp_provenance before insert or update on public.clients
  for each row execute function public.stamp_provenance('mrr', 'health');

-- Row-level security: members read, owners and editors write (as for services).
alter table public.clients enable row level security;
alter table public.client_services enable row level security;
alter table public.client_assignments enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['clients', 'client_services', 'client_assignments'] loop
    execute format(
      'create policy "read %1$s" on public.%1$I for select to authenticated using (public.can_read_workspace(workspace_id))', t);
    execute format(
      'create policy "insert %1$s" on public.%1$I for insert to authenticated with check (public.can_edit_workspace(workspace_id))', t);
    execute format(
      'create policy "update %1$s" on public.%1$I for update to authenticated using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id))', t);
    execute format(
      'create policy "delete %1$s" on public.%1$I for delete to authenticated using (public.can_edit_workspace(workspace_id))', t);
  end loop;
end;
$$;

grant select, insert, update, delete on public.clients, public.client_services, public.client_assignments to authenticated;
revoke all on public.clients, public.client_services, public.client_assignments from anon;

-- ---------------------------------------------------------------------------
-- An issue can be about a client (§5 `issues.client_id`: a churn risk, a
-- complaint), linked within the workspace like its other subjects
-- ---------------------------------------------------------------------------

alter table public.issues add column client_id uuid;
alter table public.issues
  add foreign key (client_id, workspace_id) references public.clients (id, workspace_id) on delete set null (client_id);
create index on public.issues (client_id);

-- ---------------------------------------------------------------------------
-- Per-field saves: `clients` and `client_assignments` join save_fields'
-- allow-list; `client_services` joins save_links' link tables
-- ---------------------------------------------------------------------------

-- Copied from 20261009000000_sources.sql (the latest to redefine it, #21); the
-- only change is 'clients' and 'client_assignments' at the end of `editable`.
-- This is now the last migration to redefine save_fields, so its list must be
-- the union of every earlier one. `create or replace` keeps the grants made there.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services',
    'lead_sources', 'seasonality', 'demand_settings', 'issues', 'sources', 'clients', 'client_assignments'];
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

-- Copied from 20260930000000_field_saves.sql (the only migration to define it)
-- with `create or replace`; the only change is `client_services` (member
-- `service_id`) added to `links`: a client's services are saved as one set,
-- like a person's roles. `create or replace` keeps the grants made there.
create or replace function public.save_links(target text, owner jsonb, member text, base jsonb, next jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Link tables and their member column. Keep in sync with `LinkTable` in the app.
  links constant jsonb := '{"person_roles": "role_id", "person_skills": "step_id", "client_services": "service_id"}';
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

-- Production data alignment (run after the migration):
--
-- Northbeam's named roster, its services' fallback load per client and a 10%
-- overtime cap, exactly as in seed.sql. Idempotent: rows that exist are left
-- alone (on conflict do nothing), and the updates only fill values not yet set.
--
-- begin;
-- update public.workspaces set settings = settings || '{"overtime_cap": 0.1}'::jsonb
--   where id = 'a0000000-0000-4000-8000-000000000001' and not settings ? 'overtime_cap';
-- update public.services set fallback_ongoing_load = '{"b0000000-0000-4000-8000-000000000002":1.5,"b0000000-0000-4000-8000-000000000003":6,"b0000000-0000-4000-8000-000000000004":16,"b0000000-0000-4000-8000-000000000006":1.2}'::jsonb
--   where id = '80000000-0000-4000-8000-000000000001' and fallback_ongoing_load = '{}'::jsonb;
-- update public.services set fallback_ongoing_load = '{"b0000000-0000-4000-8000-000000000002":1.5,"b0000000-0000-4000-8000-000000000003":6,"b0000000-0000-4000-8000-000000000005":19,"b0000000-0000-4000-8000-000000000006":1.2}'::jsonb
--   where id = '80000000-0000-4000-8000-000000000002' and fallback_ongoing_load = '{}'::jsonb;
-- insert into public.clients (id, workspace_id, name, start_date, mrr, health, provenance, notes, active) values
--   ('20000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Harbour Lane Dental', '2023-02-01', 3500, 88, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Fenwick & Co Solicitors', '2023-05-15', 4200, 82, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Oakridge Garden Rooms', '2023-06-01', 7700, 76, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'Brightwater Physio', '2023-09-04', 2900, 91, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Greystone Kitchens', '2023-10-02', 4600, 71, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'Calder Valley Joinery', '2024-01-08', 3200, 84, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'Lumen Eyewear', '2024-02-05', 5200, 64, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', 'Thistle Home Care', '2024-03-11', 3500, 79, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'Bramble & Oak Bakery', '2024-04-02', 3400, 86, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'Northgate Motors', '2024-05-20', 8100, 58, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001', 'Willow & Sage Interiors', '2024-06-03', 3100, 90, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000001', 'Swift Courier Co', '2024-07-01', 4200, 47, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', 'Unhappy with lead volume since the spring; renewal call due.', true),
--   ('20000000-0000-4000-8000-00000000000d', 'a0000000-0000-4000-8000-000000000001', 'Kestrel Accountancy', '2024-08-12', 3600, 83, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-00000000000e', 'a0000000-0000-4000-8000-000000000001', 'Elm Street Opticians', '2024-09-02', 3900, 80, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000001', 'Moorland Holiday Cottages', '2024-10-07', 3300, 77, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001', 'Harper Solar', '2024-11-04', 4800, 69, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'Pennine Roofing', '2025-01-13', 3000, 85, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'Nimbus Fitness', '2025-02-03', 4100, 74, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001', 'Ashby Veterinary Group', '2025-03-10', 7900, 81, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000001', 'Riverside Pilates', '2025-04-07', 2800, 92, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000001', 'Copperfield Furniture', '2025-05-06', 4400, 66, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000016', 'a0000000-0000-4000-8000-000000000001', 'Hartley Estate Agents', '2025-06-02', 3700, 87, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000017', 'a0000000-0000-4000-8000-000000000001', 'Birchwood Nurseries', '2025-08-04', 3400, 80, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000018', 'a0000000-0000-4000-8000-000000000001', 'Redwood Wedding Venue', '2025-10-06', 4300, 78, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-000000000019', 'a0000000-0000-4000-8000-000000000001', 'Coastline Kayak Hire', '2026-01-12', 3200, 89, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true),
--   ('20000000-0000-4000-8000-00000000001a', 'a0000000-0000-4000-8000-000000000001', 'Atlas Driving School', '2026-06-01', 3500, 93, '{"mrr":{"source":"entered","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"health":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}', null, true)
-- on conflict do nothing;
-- insert into public.client_services (client_id, service_id, workspace_id, start_date) values
--   ('20000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000006', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000007', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000008', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000009', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000a', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000a', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000b', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000c', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000d', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000e', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000000f', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000011', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000012', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000013', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000013', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000014', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000015', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000016', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000017', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000018', '80000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-000000000019', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null),
--   ('20000000-0000-4000-8000-00000000001a', '80000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null)
-- on conflict do nothing;
-- insert into public.client_assignments (client_id, role_id, person_id, workspace_id) values
--   ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000014', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000014', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000014', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000014', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000015', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000015', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000015', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000015', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000016', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000016', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000016', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000016', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000017', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000017', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000017', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000017', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000018', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000018', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000018', 'b0000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000018', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000019', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000019', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000019', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-000000000019', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000001a', 'b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000001a', 'b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000001a', 'b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001'),
--   ('20000000-0000-4000-8000-00000000001a', 'b0000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001')
-- on conflict do nothing;
-- commit;
