-- Company-model suggestions, the audit log for company-model edits, and saved
-- runs (docs/PRD.md §4.1 Company model, §5 `suggestions`, `runs`, §7.1,
-- §7.1c; decision D19; issue #25).
--
-- Human edits to the company model (settings, services, people, clients,
-- demand) apply live. The MCP server can't write those tables: its company
-- tools create `suggestions` (target, patch, evidence), and a person in the
-- app accepts or rejects them with `review_suggestions`. Accepting applies the
-- patch as that person (RLS decides) and stamps each value's provenance as an
-- estimate carrying the suggestion's evidence (docs/adr/0007-*). Every write to
-- the company-model tables is written to `audit_log` with its actor kind
-- (user or mcp) and, for an accepted suggestion, the suggestion's id. Saved
-- runs keep a snapshot of the model they ran, so opening one later can list
-- what has changed since (the app diffs the snapshot; no SQL here).
--
-- Strictly additive:
--   * tables `suggestions` and `runs` (RLS, grants, anon revoked, updated_at);
--   * a nullable-free `provenance jsonb default '{}'` column on `workspaces`,
--     `people` and `services` (keyed by column; `settings.<key>` for the
--     workspace settings), stamped `entered` when a person changes a value,
--     as lead sources and clients already are;
--   * trigger functions `private.stamp_settings_provenance`,
--     `private.suggestions_before_write`, `private.company_needs_review`,
--     `private.audit_company_write`, the review RPC
--     `public.review_suggestions` and its helper `private.apply_suggestion`,
--     and triggers on the company-model tables.
-- `save_fields` and `save_links` are unchanged.
--
-- Rollback (run as one transaction; newest migration first):
--
--   begin;
--   drop function if exists public.review_suggestions(uuid[], text, text);
--   drop function if exists private.apply_suggestion(public.suggestions);
--   drop table if exists public.runs, public.suggestions;
--   do $$
--   declare t text;
--   begin
--     foreach t in array array['workspaces', 'roles', 'services', 'people', 'person_roles', 'person_skills',
--       'person_leave', 'clients', 'client_services', 'client_assignments', 'lead_sources', 'seasonality',
--       'demand_settings'] loop
--       execute format('drop trigger if exists audit_company on public.%I', t);
--       execute format('drop trigger if exists needs_review on public.%I', t);
--     end loop;
--   end $$;
--   drop trigger if exists stamp_provenance on public.people;
--   drop trigger if exists stamp_provenance on public.services;
--   drop trigger if exists stamp_settings_provenance on public.workspaces;
--   drop function if exists private.audit_company_write();
--   drop function if exists private.company_needs_review();
--   drop function if exists private.suggestions_before_write();
--   drop function if exists private.stamp_settings_provenance();
--   alter table public.workspaces drop column if exists provenance;
--   alter table public.people drop column if exists provenance;
--   alter table public.services drop column if exists provenance;
--   delete from supabase_migrations.schema_migrations where version = '20261015000000';
--   commit;
--
-- Rolling back deletes every suggestion and saved run. Audit entries it wrote
-- stay in audit_log.
--
-- Production data: none needed. Existing rows get `provenance = '{}'` (no
-- entry reads as an estimate until someone edits the value), and there are no
-- suggestions or runs to carry over.

-- ---------------------------------------------------------------------------
-- Provenance on the remaining company-model values
-- ---------------------------------------------------------------------------

alter table public.workspaces
  add column provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object');
alter table public.people
  add column provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object');
alter table public.services
  add column provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object');

-- A person changing a value records a fact (D19), as for lead sources and clients.
create trigger stamp_provenance before insert or update on public.people
  for each row execute function public.stamp_provenance('fte', 'capacity_hours_week', 'cost_rate', 'start_date', 'end_date');
create trigger stamp_provenance before insert or update on public.services
  for each row execute function public.stamp_provenance('pricing_model', 'price', 'margin', 'tenure_months', 'churn_monthly_base',
    'churn_health_sensitivity', 'mix_share');

-- The workspace settings are keys of one jsonb column, so their provenance is
-- keyed `settings.<key>` (the field name save_fields uses). A key whose value
-- changes while its provenance doesn't becomes `entered`, now, by the user.
create function private.stamp_settings_provenance() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k text;
  prov jsonb := coalesce(new.provenance, '{}');
  entered jsonb := jsonb_strip_nulls(jsonb_build_object('source', 'entered', 'at', now(), 'by', auth.uid()));
begin
  for k in
    select jsonb_object_keys(coalesce(new.settings, '{}')) union select jsonb_object_keys(coalesce(old.settings, '{}'))
  loop
    if new.settings -> k is distinct from old.settings -> k
      and prov -> ('settings.' || k) is not distinct from coalesce(old.provenance, '{}') -> ('settings.' || k) then
      prov := prov || jsonb_build_object('settings.' || k, entered);
    end if;
  end loop;
  new.provenance := prov;
  return new;
end;
$$;

create trigger stamp_settings_provenance before update of settings, provenance on public.workspaces
  for each row execute function private.stamp_settings_provenance();

-- ---------------------------------------------------------------------------
-- Suggestions
-- ---------------------------------------------------------------------------

create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The company-model table the change is to.
  target_table text not null constraint suggestions_target_table check (target_table in
    ('workspaces', 'services', 'people', 'clients', 'lead_sources', 'seasonality', 'demand_settings')),
  -- The row it changes; null: a new row (for workspaces and demand_settings,
  -- the workspace's own row). No foreign key: the row may go before review.
  target_id uuid,
  -- {set: {column: value}, roles?: [role_id], services?: [service_id],
  --  assignments?: {role_id: person_id | null}, leave?: [{start_date, end_date, note?}]}
  -- For workspaces, `set` holds settings keys.
  patch jsonb not null constraint suggestions_patch check (coalesce(
    jsonb_typeof(patch) = 'object' and jsonb_typeof(patch -> 'set') = 'object'
    and (not patch ? 'roles' or jsonb_typeof(patch -> 'roles') = 'array')
    and (not patch ? 'services' or jsonb_typeof(patch -> 'services') = 'array')
    and (not patch ? 'assignments' or jsonb_typeof(patch -> 'assignments') = 'object')
    and (not patch ? 'leave' or jsonb_typeof(patch -> 'leave') = 'array')
    and octet_length(patch::text) <= 20000, false)),
  -- Citations, as in provenance: [{source_id, speaker, quote, timestamp, value}].
  evidence jsonb not null default '[]' constraint suggestions_evidence check (
    jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 20 and octet_length(evidence::text) <= 50000),
  -- The suggester's reasoning, shown to the reviewer and kept in the provenance.
  note text constraint suggestions_note check (char_length(note) <= 2000),
  status text not null default 'pending' constraint suggestions_status check (status in ('pending', 'accepted', 'rejected')),
  created_via text not null default 'mcp' constraint suggestions_created_via check (created_via in ('mcp')),
  -- What accepting changed: {target_id, before: {...}, after: {...}}.
  applied jsonb,
  review_note text constraint suggestions_review_note check (char_length(review_note) <= 2000),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint suggestions_reviewed check ((status = 'pending') = (reviewed_at is null))
);

create index on public.suggestions (workspace_id, status, created_at desc);

create trigger set_updated_at before update on public.suggestions for each row execute function public.set_updated_at();

-- New suggestions start pending, by whoever made them. Afterwards only the
-- review may change them (pending → accepted or rejected, once), and what was
-- suggested never changes.
create function private.suggestions_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.target_table is distinct from old.target_table
    or new.target_id is distinct from old.target_id or new.patch is distinct from old.patch
    or new.evidence is distinct from old.evidence or new.note is distinct from old.note
    or new.created_via is distinct from old.created_via or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'A suggestion can''t be changed, only accepted or rejected' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing', true), '') <> 'on' then
      raise exception 'Suggestions are accepted or rejected with review_suggestions' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger before_write before insert or update on public.suggestions
  for each row execute function private.suggestions_before_write();

-- Everyone in the workspace sees its suggestions; editors (and the MCP server
-- acting as one) make them, and editors review them. No deletes: rejected
-- suggestions are the record of what was turned down.
alter table public.suggestions enable row level security;

create policy "read suggestions" on public.suggestions for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert suggestions" on public.suggestions for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update suggestions" on public.suggestions for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));

grant select, insert, update on public.suggestions to authenticated;
revoke delete, truncate on public.suggestions from authenticated;
revoke all on public.suggestions from anon;

-- ---------------------------------------------------------------------------
-- The MCP server never writes the company model directly (D19)
-- ---------------------------------------------------------------------------

-- A request made with an API token (the MCP server, docs/adr/0002-*) carries
-- `api_token_id` in its claims. Such a request may not insert, change or
-- delete company-model rows; it creates suggestions instead. Writes made by
-- other triggers follow from a write already allowed.
create function private.company_needs_review() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' and pg_catalog.pg_trigger_depth() = 1 then
    raise exception 'The company model changes only by review: use the suggestion tools (set_company, upsert_service, upsert_person, upsert_client, set_demand)'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit log for company-model writes (actor kind user or mcp)
-- ---------------------------------------------------------------------------

-- One entry per row a signed-in person or the MCP server inserts, updates or
-- deletes. Updates record only the columns that changed (and nothing when
-- only `updated_at` did). Writes with no user (the seed, migrations, admin
-- SQL) and writes made by other triggers (cascades) aren't logged: the latter
-- follow from a logged write. An accepted suggestion's writes carry its id.
create function private.audit_company_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(auth.jwt(), '{}');
  row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  target jsonb := coalesce(row_new, row_old);
  changed_old jsonb;
  changed_new jsonb;
  action text := lower(tg_op);
  suggestion text := nullif(current_setting('transpera.suggestion_id', true), '');
begin
  if auth.uid() is null or pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, row_old -> n.key), jsonb_object_agg(n.key, n.value)
      into changed_old, changed_new
    from jsonb_each(row_new) n
    where n.key <> 'updated_at' and (row_old -> n.key) is distinct from n.value;
    if changed_new is null then
      return null;
    end if;
    row_old := changed_old;
    row_new := changed_new;
    if tg_table_name = 'suggestions' and changed_new ? 'status' then
      action := changed_new ->> 'status';
    end if;
  end if;

  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    coalesce((target ->> 'workspace_id')::uuid, case when tg_table_name = 'workspaces' then (target ->> 'id')::uuid end),
    auth.uid(),
    case when claims ? 'api_token_id' then 'mcp' else 'user' end,
    action,
    tg_table_name,
    coalesce((target ->> 'id')::uuid, (target ->> 'person_id')::uuid, (target ->> 'client_id')::uuid,
      (target ->> 'workspace_id')::uuid),
    jsonb_strip_nulls(jsonb_build_object(
      'old', row_old,
      'new', row_new,
      -- Link rows: which member of the set.
      'role_id', case when tg_table_name in ('person_roles', 'client_assignments') then target -> 'role_id' end,
      'service_id', case when tg_table_name = 'client_services' then target -> 'service_id' end,
      'step_id', case when tg_table_name = 'person_skills' then target -> 'step_id' end,
      'suggestion_id', case when tg_table_name <> 'suggestions' then to_jsonb(suggestion) end,
      'api_token_id', claims -> 'api_token_id')));
  return null;
end;
$$;

revoke all on function private.audit_company_write() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['workspaces', 'roles', 'services', 'people', 'person_roles', 'person_skills', 'person_leave',
    'clients', 'client_services', 'client_assignments', 'lead_sources', 'seasonality', 'demand_settings', 'suggestions'] loop
    execute format(
      'create trigger audit_company after insert or update or delete on public.%I for each row execute function private.audit_company_write()', t);
  end loop;
  -- Roles stay writable by the MCP server: process building (issue #24) may need them.
  foreach t in array array['services', 'people', 'person_roles', 'person_skills', 'person_leave',
    'clients', 'client_services', 'client_assignments', 'lead_sources', 'seasonality', 'demand_settings'] loop
    execute format(
      'create trigger needs_review before insert or update or delete on public.%I for each row execute function private.company_needs_review()', t);
  end loop;
  execute 'create trigger needs_review before update or delete on public.workspaces for each row execute function private.company_needs_review()';
end;
$$;

-- ---------------------------------------------------------------------------
-- Reviewing suggestions
-- ---------------------------------------------------------------------------

-- Apply one suggestion's patch as the calling user (security invoker: RLS
-- decides) and return {target_id, before, after}. Raises on anything it can't
-- apply; review_suggestions turns that into a per-suggestion failure.
create function private.apply_suggestion(s public.suggestions) returns jsonb
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

revoke all on function private.apply_suggestion(public.suggestions) from public, anon;
grant execute on function private.apply_suggestion(public.suggestions) to authenticated;

-- Accept or reject suggestions, as the signed-in user. Each is handled on its
-- own: one that can't be applied (the row is gone, a value is out of range,
-- the user may not make that change) is reported and left pending, and the
-- others still go through. Returns [{id, status, message?, applied?}] in the
-- order given, where status is accepted, rejected, not_found (not visible or
-- not editable), already_reviewed or failed. The MCP server can't review:
-- suggestions exist so that a person decides.
create function public.review_suggestions(ids uuid[], decision text, note text default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sid uuid;
  s public.suggestions;
  outcome jsonb;
  results jsonb := '[]';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Suggestions are reviewed by a person in the app, not over the API' using errcode = '42501';
  end if;
  if decision is null or decision not in ('accept', 'reject') then
    raise exception 'decision must be accept or reject' using errcode = '22023';
  end if;
  if ids is null or cardinality(ids) = 0 or cardinality(ids) > 500 then
    raise exception 'Give between 1 and 500 suggestions' using errcode = '22023';
  end if;

  foreach sid in array ids loop
    s := null;
    -- RLS: a suggestion the user can't update is not found.
    select * into s from public.suggestions x where x.id = sid for update;
    if s.id is null then
      results := results || jsonb_build_array(jsonb_build_object('id', sid, 'status', 'not_found'));
      continue;
    end if;
    if s.status <> 'pending' then
      results := results || jsonb_build_array(jsonb_build_object('id', sid, 'status', 'already_reviewed', 'current', s.status));
      continue;
    end if;

    begin
      outcome := null;
      if decision = 'accept' then
        outcome := private.apply_suggestion(s);
      end if;
      perform set_config('transpera.reviewing', 'on', true);
      update public.suggestions x
        set status = case when decision = 'accept' then 'accepted' else 'rejected' end,
            applied = outcome,
            review_note = nullif(btrim(review_suggestions.note), ''),
            reviewed_by = auth.uid(),
            reviewed_at = now()
      where x.id = sid;
      perform set_config('transpera.reviewing', '', true);
      results := results || jsonb_build_array(
        jsonb_build_object('id', sid, 'status', case when decision = 'accept' then 'accepted' else 'rejected' end)
        || case when outcome is null then '{}'::jsonb else jsonb_build_object('applied', outcome) end);
    exception when others then
      perform set_config('transpera.reviewing', '', true);
      perform set_config('transpera.suggestion_id', '', true);
      results := results || jsonb_build_array(jsonb_build_object('id', sid, 'status', 'failed', 'code', sqlstate, 'message', sqlerrm));
    end;
  end loop;
  return results;
end;
$$;

revoke all on function public.review_suggestions(uuid[], text, text) from public, anon;
grant execute on function public.review_suggestions(uuid[], text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Saved runs
-- ---------------------------------------------------------------------------

-- A run someone saved: the results they saw and a snapshot of the model it ran
-- (`params_snapshot`: the company model and the process revision), so that
-- opening it later can say what has changed since (docs/PRD.md §4.1, D19).
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  process_id uuid,
  name text not null constraint runs_name check (char_length(btrim(name)) between 1 and 200),
  scenario_id uuid,
  -- The process revisions it ran.
  revision_ids uuid[] not null default '{}',
  engine_version text,
  reps int not null constraint runs_reps check (reps between 1 and 10000),
  seed int not null,
  params_snapshot jsonb not null constraint runs_params_snapshot check (
    jsonb_typeof(params_snapshot) = 'object' and octet_length(params_snapshot::text) <= 2000000),
  results jsonb not null default '{}' constraint runs_results check (
    jsonb_typeof(results) = 'object' and octet_length(results::text) <= 500000),
  trace_url text,
  duration_ms int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete cascade,
  foreign key (scenario_id, workspace_id) references public.scenarios (id, workspace_id) on delete set null (scenario_id)
);

create index on public.runs (workspace_id, created_at desc);
create index on public.runs (process_id);

create trigger set_updated_at before update on public.runs for each row execute function public.set_updated_at();

-- Everyone in the workspace reads saved runs; editors save, rename and delete them.
alter table public.runs enable row level security;

create policy "read runs" on public.runs for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert runs" on public.runs for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update runs" on public.runs for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete runs" on public.runs for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.runs to authenticated;
revoke all on public.runs from anon;
