-- Create workspaces and roles from the app and MCP (docs/PRD.md §4.1 Company
-- model, §5 `roles`, §7.1; issue #88; docs/adr/0012-roles-and-new-workspaces.md).
--
-- Roles become company-model facts. People with edit access add, rename and
-- deactivate them in Settings; the MCP server suggests them (`upsert_role`)
-- and a person accepts, so a token can no longer write `roles` directly. A
-- role that steps, people or clients still use can't be deleted (make it
-- inactive instead). Agency admins create a workspace, with its first
-- membership and default settings, in one call: `public.create_workspace`.
--
-- Strictly additive:
--   * columns `active` (default true) and `provenance` (default '{}') and the
--     check `roles_name` on `public.roles`, and the unique index
--     `roles_workspace_name_key` (one name per workspace, ignoring case and
--     surrounding spaces);
--   * trigger function `private.role_in_use` and triggers `in_use` and
--     `needs_review` on `public.roles`;
--   * the `suggestions_target_table` check is widened to accept 'roles' (a
--     superset, so existing rows still pass);
--   * `private.apply_suggestion` and `private.company_needs_review` are
--     redefined as copies of the 20261015000000 versions, with a `roles`
--     branch and `upsert_role` in the message respectively;
--   * trigger `needs_review_insert` on `public.workspaces` and function
--     `public.create_workspace` (authenticated only).
-- `save_fields` and `save_links` are unchanged: `save_fields` accepts any
-- column the stored row has, so `active` needs nothing there.
--
-- Behaviour changes: an API token can no longer insert, update or delete
-- roles, or insert a workspace (trigger `needs_review_insert`; workspaces are
-- created in the app), and a direct delete of a role that is in use now fails
-- (23503) instead of silently removing its person_roles and client_assignments.
--
-- Preflight (run each with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. Duplicate names would fail the unique index. Expect 0 rows:
--        select workspace_id, lower(btrim(name)) n, count(*) from public.roles group by 1,2 having count(*) > 1;
--   2. Blank or overlong names would fail `roles_name`. Expect 0 rows:
--        select id, workspace_id, name from public.roles where char_length(btrim(name)) not between 1 and 200;
--   3. Existing suggestion targets must be within the new list:
--        select distinct target_table from public.suggestions;
--   4. The new columns must not exist yet. Expect 0 rows:
--        select column_name from information_schema.columns
--        where table_schema='public' and table_name='roles' and column_name in ('active','provenance');
--   5. No name clashes. Expect 0 rows from each:
--        select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        where p.proname in ('create_workspace','role_in_use');
--        select indexname from pg_indexes where indexname='roles_workspace_name_key';
--   6. Triggers on roles. Expect only `set_updated_at` and `audit_company`:
--        select tgname from pg_trigger where tgrelid='public.roles'::regclass and not tgisinternal;
--      Triggers on workspaces. Expect `audit_company`, `needs_review`, `seed_scenario_library`, `set_updated_at` and
--      `stamp_settings_provenance`, and no `needs_review_insert`:
--        select tgname from pg_trigger where tgrelid='public.workspaces'::regclass and not tgisinternal;
--   7. Nothing of ours is applied past narration. Expect only `20261020000000`:
--        select version from supabase_migrations.schema_migrations where version >= '20261020000000';
--   8. Informational: anything non-zero means a token has been writing roles and will now be refused:
--        select count(*) from public.audit_log where target_table='roles' and actor_kind='mcp';
--   9. Informational: anything non-zero means a token has been inserting workspaces and will now be refused:
--        select count(*) from public.audit_log where target_table='workspaces' and action='insert' and actor_kind='mcp';
--
-- Rollback (run as one transaction; newest migration first):
--
--   begin;
--   drop function if exists public.create_workspace(text, text, jsonb);
--   drop trigger if exists needs_review_insert on public.workspaces;
--   drop trigger if exists in_use on public.roles;
--   drop trigger if exists needs_review on public.roles;
--   drop function if exists private.role_in_use();
--   -- Restore private.apply_suggestion and private.company_needs_review: re-run their blocks from
--   -- 20261015000000_suggestions.sql with `create or replace function`.
--   delete from public.suggestions where target_table = 'roles';  -- roles they created stay
--   alter table public.suggestions drop constraint suggestions_target_table,
--     add constraint suggestions_target_table check (target_table in
--       ('workspaces', 'services', 'people', 'clients', 'lead_sources', 'seasonality', 'demand_settings'));
--   drop index if exists public.roles_workspace_name_key;
--   alter table public.roles drop constraint if exists roles_name,
--     drop column if exists active, drop column if exists provenance;
--   delete from supabase_migrations.schema_migrations where version = '20261021000000';
--   commit;
--
-- Production data: none needed.

-- ---------------------------------------------------------------------------
-- Roles: active flag, provenance, name rules
-- ---------------------------------------------------------------------------

alter table public.roles
  -- Inactive roles are hidden from pickers; steps, people and clients that already name one keep it, and it still simulates.
  add column active boolean not null default true,
  add column provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  add constraint roles_name check (char_length(btrim(name)) between 1 and 200);
create unique index roles_workspace_name_key on public.roles (workspace_id, lower(btrim(name)));

-- ---------------------------------------------------------------------------
-- A role in use can't be deleted
-- ---------------------------------------------------------------------------

-- Steps (any revision), people, client assignments and a service's fallback
-- load name roles. Deleting the workspace cascades to its roles: that runs
-- inside the workspace's own delete trigger (depth > 1) and must still work.
create function private.role_in_use() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return old;
  end if;
  if exists (select 1 from public.steps s where s.workspace_id = old.workspace_id and s.role_id = old.id)
    or exists (select 1 from public.person_roles pr where pr.workspace_id = old.workspace_id and pr.role_id = old.id)
    or exists (select 1 from public.client_assignments ca where ca.workspace_id = old.workspace_id and ca.role_id = old.id)
    or exists (select 1 from public.services sv where sv.workspace_id = old.workspace_id and sv.fallback_ongoing_load ? old.id::text) then
    raise exception 'Role % is still used by steps, people or clients: make it inactive instead', old.name
      using errcode = '23503';
  end if;
  return old;
end;
$$;

revoke all on function private.role_in_use() from public, anon, authenticated;

create trigger in_use before delete on public.roles
  for each row execute function private.role_in_use();

-- ---------------------------------------------------------------------------
-- The MCP server suggests roles; it doesn't write them
-- ---------------------------------------------------------------------------

create trigger needs_review before insert or update or delete on public.roles
  for each row execute function private.company_needs_review();

create or replace function private.company_needs_review() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' and pg_catalog.pg_trigger_depth() = 1 then
    raise exception 'The company model changes only by review: use the suggestion tools (set_company, upsert_service, upsert_person, upsert_client, upsert_role, set_demand)'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Suggestions may target roles
-- ---------------------------------------------------------------------------

alter table public.suggestions drop constraint suggestions_target_table,
  add constraint suggestions_target_table check (target_table in
    ('workspaces', 'services', 'people', 'clients', 'lead_sources', 'seasonality', 'demand_settings', 'roles'));

-- Copied from 20261015000000_suggestions.sql, with a `roles` branch.
create or replace function private.apply_suggestion(s public.suggestions) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tbl text := s.target_table;
  ws uuid := s.workspace_id;
  sets jsonb := coalesce(s.patch -> 'set', '{}');
  allowed text[];
  -- Columns that are names or notes, not values: no provenance.
  plain constant text[] := array['name', 'notes', 'email', 'active', 'month'];
  entry jsonb;
  prov jsonb := '{}';
  k text;
  cols text;
  rcols text;
  target uuid := s.target_id;
  before_row jsonb;
  after_row jsonb;
  before jsonb := '{}';
  ids uuid[];
  a record;
  l jsonb;
begin
  allowed := case tbl
    when 'workspaces' then array['hours_per_week', 'working_days', 'currency', 'fy_start', 'overhead_monthly', 'target_margin',
      'overtime_cap', 'availability_floor', 'utilisation_threshold', 'capacity_factor_enabled', 'horizon_weeks',
      'leads_per_week', 'active_clients', 'churn_monthly', 'retainer']
    when 'services' then array['name', 'pricing_model', 'price', 'margin', 'tenure_months', 'churn_monthly_base',
      'churn_health_sensitivity', 'mix_share', 'active']
    when 'people' then array['name', 'email', 'fte', 'capacity_hours_week', 'cost_rate', 'active', 'start_date', 'end_date', 'notes']
    when 'clients' then array['name', 'start_date', 'mrr', 'health', 'notes', 'active']
    when 'lead_sources' then array['name', 'volume_week', 'conversion_to_qualified']
    when 'seasonality' then array['month', 'multiplier']
    when 'demand_settings' then array['growth_monthly']
    when 'roles' then array['name']
  end;
  for k in select jsonb_object_keys(sets) loop
    if not k = any (allowed) then
      raise exception '% can''t be suggested for %', k, tbl using errcode = '22023';
    end if;
  end loop;
  if (s.patch ? 'roles' or s.patch ? 'leave') and tbl <> 'people'
    or (s.patch ? 'services' or s.patch ? 'assignments') and tbl <> 'clients' then
    raise exception 'That patch doesn''t apply to %', tbl using errcode = '22023';
  end if;

  -- Each value's provenance: an estimate, with the suggestion's evidence and reasoning.
  entry := jsonb_strip_nulls(jsonb_build_object(
    'source', 'estimated',
    'at', now(),
    'by', auth.uid(),
    'note', s.note,
    'evidence', case when jsonb_array_length(s.evidence) > 0 then s.evidence end,
    'assumption', case when jsonb_array_length(s.evidence) = 0 then true end,
    'suggestion_id', s.id));
  for k in select jsonb_object_keys(sets) loop
    if not k = any (plain) then
      prov := prov || jsonb_build_object(case when tbl = 'workspaces' then 'settings.' || k else k end, entry);
    end if;
  end loop;

  -- Audit entries written from here on name the suggestion.
  perform set_config('transpera.suggestion_id', s.id::text, true);

  if tbl = 'workspaces' then
    select to_jsonb(w) into before_row from public.workspaces w where w.id = ws for update;
    update public.workspaces w set settings = w.settings || sets, provenance = w.provenance || prov where w.id = ws
      returning to_jsonb(w) into after_row;
    if after_row is null then
      raise exception 'You can''t change this workspace''s settings (owners can)' using errcode = '42501';
    end if;
    select coalesce(jsonb_object_agg(x.key, before_row -> 'settings' -> x.key), '{}') into before from jsonb_each(sets) x;
    perform set_config('transpera.suggestion_id', '', true);
    return jsonb_build_object('target_id', ws, 'before', before, 'after', sets);
  end if;

  if tbl = 'demand_settings' then
    select to_jsonb(d) into before_row from public.demand_settings d where d.workspace_id = ws for update;
    if before_row is null then
      insert into public.demand_settings (workspace_id, growth_monthly, provenance)
      select ws, r.growth_monthly, prov from jsonb_populate_record(null::public.demand_settings, sets) r;
    elsif sets <> '{}' then
      update public.demand_settings d set growth_monthly = r.growth_monthly, provenance = d.provenance || prov
      from jsonb_populate_record(null::public.demand_settings, sets) r where d.workspace_id = ws;
    end if;
    select coalesce(jsonb_object_agg(x.key, before_row -> x.key), '{}') into before from jsonb_each(sets) x;
    perform set_config('transpera.suggestion_id', '', true);
    return jsonb_build_object('target_id', ws, 'before', case when before_row is null then null else before end, 'after', sets);
  end if;

  -- A month of the seasonality curve is found by its month.
  if tbl = 'seasonality' and target is null then
    select m.id into target from public.seasonality m where m.workspace_id = ws and m.month = (sets ->> 'month')::int;
  end if;

  select string_agg(quote_ident(x), ', '), string_agg('r.' || quote_ident(x), ', ')
    into cols, rcols from jsonb_object_keys(sets) as x;

  if target is null then
    if cols is null then
      raise exception 'Nothing to create' using errcode = '22023';
    end if;
    execute format(
      'insert into public.%1$I (workspace_id, provenance, %2$s) select $1, $2, %3$s from jsonb_populate_record(null::public.%1$I, $3) r returning id',
      tbl, cols, rcols)
    into target using ws, prov, sets;
    before_row := null;
  else
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.workspace_id = $2 for update', tbl)
      into before_row using target, ws;
    if before_row is null then
      raise exception 'What this suggestion changes no longer exists' using errcode = 'P0002';
    end if;
    if cols is not null then
      execute format(
        'update public.%1$I t set (%2$s, provenance) = (select %3$s, t.provenance || $3 from jsonb_populate_record(null::public.%1$I, $1) r) where t.id = $2',
        tbl, cols, rcols)
      using sets, target, prov;
    end if;
    select coalesce(jsonb_object_agg(x.key, before_row -> x.key), '{}') into before from jsonb_each(sets) x;
  end if;

  if tbl = 'people' and s.patch ? 'roles' then
    select coalesce(array_agg(distinct v::uuid), '{}') into ids from jsonb_array_elements_text(s.patch -> 'roles') v;
    if before_row is not null then
      before := before || jsonb_build_object('roles',
        (select coalesce(jsonb_agg(pr.role_id order by pr.role_id), '[]') from public.person_roles pr where pr.person_id = target));
    end if;
    delete from public.person_roles pr where pr.person_id = target and not pr.role_id = any (ids);
    insert into public.person_roles (person_id, role_id, workspace_id)
    select target, r, ws from unnest(ids) r on conflict do nothing;
  end if;

  if tbl = 'people' and s.patch ? 'leave' then
    for l in select * from jsonb_array_elements(s.patch -> 'leave') loop
      insert into public.person_leave (person_id, workspace_id, start_date, end_date, note)
      select target, ws, (l ->> 'start_date')::date, (l ->> 'end_date')::date, l ->> 'note'
      where not exists (
        select 1 from public.person_leave pl where pl.person_id = target
          and pl.start_date = (l ->> 'start_date')::date and pl.end_date = (l ->> 'end_date')::date);
    end loop;
  end if;

  if tbl = 'clients' and s.patch ? 'services' then
    select coalesce(array_agg(distinct v::uuid), '{}') into ids from jsonb_array_elements_text(s.patch -> 'services') v;
    if before_row is not null then
      before := before || jsonb_build_object('services',
        (select coalesce(jsonb_agg(cs.service_id order by cs.service_id), '[]') from public.client_services cs where cs.client_id = target));
    end if;
    delete from public.client_services cs where cs.client_id = target and not cs.service_id = any (ids);
    insert into public.client_services (client_id, service_id, workspace_id)
    select target, v, ws from unnest(ids) v on conflict do nothing;
  end if;

  if tbl = 'clients' and s.patch ? 'assignments' then
    if before_row is not null then
      before := before || jsonb_build_object('assignments',
        (select coalesce(jsonb_object_agg(ca.role_id, ca.person_id), '{}') from public.client_assignments ca where ca.client_id = target));
    end if;
    for a in select x.key, x.value from jsonb_each(s.patch -> 'assignments') x loop
      if jsonb_typeof(a.value) = 'null' then
        delete from public.client_assignments ca where ca.client_id = target and ca.role_id = a.key::uuid;
      else
        insert into public.client_assignments (client_id, role_id, person_id, workspace_id)
        values (target, a.key::uuid, (a.value #>> '{}')::uuid, ws)
        on conflict (client_id, role_id) do update set person_id = excluded.person_id;
      end if;
    end loop;
  end if;

  perform set_config('transpera.suggestion_id', '', true);
  return jsonb_build_object(
    'target_id', target,
    'before', case when before_row is null then null else before end,
    'after', sets || (s.patch - 'set'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Creating a workspace
-- ---------------------------------------------------------------------------

-- An API token may not insert a workspace directly either: `needs_review` on
-- workspaces covers update and delete only.
create trigger needs_review_insert before insert on public.workspaces
  for each row execute function private.company_needs_review();

-- Agency admins only, and not over an API token. Runs as the caller, so RLS
-- checks both inserts; `returning` passes the select policy for an admin.
create function public.create_workspace(ws_name text, ws_slug text, ws_settings jsonb default '{}')
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ws uuid;
  k text;
  defaults constant jsonb := '{"hours_per_week":40,"horizon_weeks":13,"currency":"GBP","leads_per_week":0,"active_clients":0,"churn_monthly":0,"retainer":0}';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Workspaces are created in the app' using errcode = '42501';
  end if;
  if auth.uid() is null or not public.is_agency_admin() then
    raise exception 'Only agency admins can create workspaces' using errcode = '42501';
  end if;
  if ws_name is null or char_length(btrim(ws_name)) not between 1 and 200 then
    raise exception 'The name must be 1 to 200 characters' using errcode = '22023';
  end if;
  ws_settings := coalesce(ws_settings, '{}');
  if jsonb_typeof(ws_settings) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(ws_settings) loop
    if k not in ('hours_per_week', 'horizon_weeks', 'currency') then
      raise exception '% can''t be set when creating a workspace', k using errcode = '22023';
    end if;
  end loop;
  if ws_settings ? 'hours_per_week' and not (
    jsonb_typeof(ws_settings -> 'hours_per_week') = 'number'
    and (ws_settings ->> 'hours_per_week')::numeric > 0 and (ws_settings ->> 'hours_per_week')::numeric <= 168) then
    raise exception 'hours_per_week must be a number above 0 and at most 168' using errcode = '22023';
  end if;
  if ws_settings ? 'horizon_weeks' and not (
    jsonb_typeof(ws_settings -> 'horizon_weeks') = 'number'
    and (ws_settings ->> 'horizon_weeks')::numeric = trunc((ws_settings ->> 'horizon_weeks')::numeric)
    and (ws_settings ->> 'horizon_weeks')::numeric between 1 and 104) then
    raise exception 'horizon_weeks must be a whole number from 1 to 104' using errcode = '22023';
  end if;
  if ws_settings ? 'currency' and not (
    jsonb_typeof(ws_settings -> 'currency') = 'string' and (ws_settings ->> 'currency') ~ '^[A-Z]{3}$') then
    raise exception 'currency must be a three-letter code such as GBP' using errcode = '22023';
  end if;

  insert into public.workspaces (name, slug, settings)
  values (btrim(ws_name), ws_slug, defaults || ws_settings)
  returning id into ws;

  insert into public.memberships (workspace_id, user_id, role, source)
  values (ws, auth.uid(), 'agency_admin', 'manual');

  return ws;
end;
$$;

revoke all on function public.create_workspace(text, text, jsonb) from public, anon;
grant execute on function public.create_workspace(text, text, jsonb) to authenticated;
