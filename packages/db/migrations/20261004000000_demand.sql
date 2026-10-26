-- Demand: lead sources, a 12-month seasonality curve and a monthly growth
-- assumption, which model resolution turns into each process's arrival rate
-- (docs/PRD.md §4.1 Company model, §5, §6.2, §6.3.2; issue #13). Every value
-- carries provenance (estimated, entered or measured) in its row's
-- `provenance` jsonb, keyed by column. Strictly additive: three new tables, a
-- trigger function that stamps provenance, and `save_fields` redefined with
-- the three tables added to its allow-list (nothing else in it changes).
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop table public.lead_sources, public.seasonality, public.demand_settings;
--   drop function public.stamp_provenance();
--   -- Restore save_fields' previous allow-list: re-run the `create or replace
--   -- function public.save_fields ... $$;` block from 20261001000000_services.sql.
--   -- (Or leave it: with the tables gone, a save to them just errors.)
--   delete from supabase_migrations.schema_migrations where version = '20261004000000';
--   commit;

-- Provenance of the value columns named in the trigger's arguments, kept in
-- `provenance` as {column: {source, at, by}} (the §5 provenance shape, one per
-- value). A person changing a value is entering a fact (decision D19), so:
--   insert: a value with no provenance given is `entered`;
--   update: a value that changes while its provenance doesn't becomes
--           `entered`, now, by the current user.
-- Writers that know better (the seed's estimates, calibration's `measured`,
-- an accepted suggestion's evidence) set the provenance in the same statement
-- and it is kept as given.
create function public.stamp_provenance() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
  prov jsonb := coalesce(new.provenance, '{}');
  new_row jsonb := to_jsonb(new);
  old_row jsonb;
  entered jsonb := jsonb_strip_nulls(jsonb_build_object('source', 'entered', 'at', now(), 'by', auth.uid()));
begin
  if tg_op = 'UPDATE' then
    old_row := to_jsonb(old);
  end if;
  foreach col in array tg_argv loop
    if tg_op = 'INSERT' then
      if not prov ? col then
        prov := prov || jsonb_build_object(col, entered);
      end if;
    elsif new_row -> col is distinct from old_row -> col
      and prov -> col is not distinct from coalesce(old_row -> 'provenance', '{}') -> col then
      prov := prov || jsonb_build_object(col, entered);
    end if;
  end loop;
  new.provenance := prov;
  return new;
end;
$$;

-- Where qualified leads come from. The arrival rate is Σ volume_week ×
-- conversion_to_qualified, split between processes by the services mix.
create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  -- Leads a week from this source.
  volume_week numeric not null default 0 check (volume_week >= 0),
  -- Share of them that become qualified leads (0–1).
  conversion_to_qualified numeric not null default 1 check (conversion_to_qualified >= 0 and conversion_to_qualified <= 1),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create index on public.lead_sources (workspace_id);

-- The seasonality curve: a multiplier on the arrival rate per calendar month.
-- A month with no row is 1 (no seasonal effect).
create table public.seasonality (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- 1 = January.
  month int not null check (month between 1 and 12),
  multiplier numeric not null default 1 check (multiplier >= 0 and multiplier <= 100),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (workspace_id, month)
);

-- One row per workspace; none means no growth. (The PRD's horizon_weeks stays
-- in workspaces.settings, where the simulation already reads it.)
create table public.demand_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  -- Compound change in the arrival rate per month (0.02 is +2% a month).
  growth_monthly numeric not null default 0 check (growth_monthly > -1 and growth_monthly <= 10),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create trigger set_updated_at before update on public.lead_sources for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.seasonality for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.demand_settings for each row execute function public.set_updated_at();

create trigger stamp_provenance before insert or update on public.lead_sources
  for each row execute function public.stamp_provenance('volume_week', 'conversion_to_qualified');
create trigger stamp_provenance before insert or update on public.seasonality
  for each row execute function public.stamp_provenance('multiplier');
create trigger stamp_provenance before insert or update on public.demand_settings
  for each row execute function public.stamp_provenance('growth_monthly');

-- Row-level security: members read, owners and editors write (as for services).
alter table public.lead_sources enable row level security;
alter table public.seasonality enable row level security;
alter table public.demand_settings enable row level security;

create policy "read lead sources" on public.lead_sources for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert lead sources" on public.lead_sources for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update lead sources" on public.lead_sources for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete lead sources" on public.lead_sources for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

create policy "read seasonality" on public.seasonality for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert seasonality" on public.seasonality for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update seasonality" on public.seasonality for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete seasonality" on public.seasonality for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

create policy "read demand settings" on public.demand_settings for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert demand settings" on public.demand_settings for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update demand settings" on public.demand_settings for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete demand settings" on public.demand_settings for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.lead_sources, public.seasonality, public.demand_settings to authenticated;
revoke all on public.lead_sources, public.seasonality, public.demand_settings from anon;

-- save_fields, exactly as in 20261001000000_services.sql except that
-- `lead_sources`, `seasonality` and `demand_settings` join the allow-list.
-- `create or replace` keeps its grants.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services',
    'lead_sources', 'seasonality', 'demand_settings'];
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
