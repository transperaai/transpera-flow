-- Services: what the business sells, how each is priced, and which path its
-- clients follow (docs/PRD.md §5 `services`, §6.4 revenue rules, decision D8;
-- issue #12). Strictly additive: one new table, and `save_fields` redefined
-- with `services` added to its allow-list (nothing else in it changes).
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop table public.services;
--   -- Restore save_fields' previous allow-list: re-run the `create function
--   -- public.save_fields ... $$;` block from 20260930000000_field_saves.sql
--   -- with `create function` changed to `create or replace function`. (Or
--   -- leave it: with the table gone, a save to 'services' just errors.)
--   delete from supabase_migrations.schema_migrations where version = '20261001000000';
--   commit;

create table public.services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  pricing_model text not null default 'retainer' check (pricing_model in ('retainer', 'one_off', 'hourly')),
  -- Monthly fee (retainer), whole fee (one-off) or hourly rate, in the workspace currency.
  price numeric not null default 0 check (price >= 0),
  -- Gross margin as a share of price.
  margin numeric not null default 0 check (margin >= 0 and margin <= 1),
  -- Expected tenure of a retainer client, in months.
  tenure_months numeric not null default 12 check (tenure_months >= 0),
  churn_monthly_base numeric not null default 0 check (churn_monthly_base >= 0 and churn_monthly_base <= 1),
  -- How strongly poor client health raises churn (§6.3.5). Not simulated yet.
  churn_health_sensitivity numeric not null default 3 check (churn_health_sensitivity >= 0),
  -- Relative share of arrivals; normalised over the active services entering a process.
  mix_share numeric not null default 1 check (mix_share >= 0),
  -- Process this service's arrivals enter; null means the workspace's pipeline.
  entry_process_id uuid,
  -- Condition tags this service's entities follow (edges.condition_tag).
  path_tags text[] not null default '{}',
  -- {role_id: hours_per_month} when no servicing process is mapped (§6.3.4). Not simulated yet.
  fallback_ongoing_load jsonb not null default '{}' check (jsonb_typeof(fallback_ongoing_load) = 'object'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  -- Only entry_process_id is cleared when the process goes (a column list needs Postgres 15+).
  foreign key (entry_process_id, workspace_id) references public.processes (id, workspace_id) on delete set null (entry_process_id)
);

create index on public.services (workspace_id);
create index on public.services (entry_process_id);

create trigger set_updated_at before update on public.services for each row execute function public.set_updated_at();

alter table public.services enable row level security;

create policy "read services" on public.services for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert services" on public.services for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update services" on public.services for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete services" on public.services for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.services to authenticated;
revoke all on public.services from anon;

-- save_fields, exactly as in 20260930000000_field_saves.sql except that
-- `services` joins the allow-list. `create or replace` keeps its grants.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services'];
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
