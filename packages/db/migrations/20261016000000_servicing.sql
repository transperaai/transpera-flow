-- Client servicing (docs/PRD.md §5 `processes.kind`, `service_servicing`,
-- §6.3.5; decision D9; issue #19). A service links to servicing processes
-- (`processes.kind = 'servicing'`, which exists since the first migration)
-- with a recurrence: every client on the service generates a task per
-- recurrence, which flows through the process and must be done within its SLA
-- (`sla_hours`); on time it lifts the client's health, late or missed lowers
-- it, and health drives churn. A service with any servicing process no longer
-- uses its fallback ongoing load.
--
-- Deviations from §5: `service_servicing` also has `id` (so a link is edited
-- field by field with `save_fields`), `workspace_id` (RLS), `sla_hours` (a
-- task's SLA: on time within it, missed beyond twice it) and `provenance`
-- ({column: {source, at, by}}, stamped `entered` when a person changes a
-- value, as for lead sources). The recurrence is
-- `{"every": "week"|"month", "times": n}` or `{"poisson_per_month": r}`.
-- Health rules (recover, late and missed penalties, starting health) are
-- optional keys of `workspaces.settings` (`health_recover`,
-- `health_late_penalty`, `health_missed_penalty`, `health_initial`); left out,
-- the PRD's estimated defaults apply. `services.churn_health_sensitivity`
-- (default 3) already exists and is now simulated.
--
-- A link is a company-model fact, like the service it belongs to: the MCP
-- server can't write it directly (it suggests; decision D19) and every write
-- is audited, with #25's `private.company_needs_review` and
-- `private.audit_company_write` triggers (20261015000000_suggestions.sql).
--
-- Strictly additive: one new table with its check function and triggers, a
-- trigger on `processes` that keeps linked processes of kind servicing, and
-- `save_fields` redefined with `service_servicing` appended to its allow-list
-- (nothing else in it changes).
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop trigger if exists servicing_kind on public.processes;
--   -- (dropping the table drops its needs_review, audit_company, stamp_provenance and set_updated_at triggers)
--   drop table public.service_servicing;
--   drop function if exists private.servicing_process_kind();
--   drop function if exists private.servicing_link_kind();
--   drop function if exists private.is_recurrence(jsonb);
--   -- Restore save_fields' previous allow-list: re-run the `create or replace
--   -- function public.save_fields ... $$;` block from 20261012000000_clients.sql.
--   -- (Or leave it: with the table gone, a save to it just errors.)
--   delete from supabase_migrations.schema_migrations where version = '20261016000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Recurrence shape
-- ---------------------------------------------------------------------------

-- True for {"every": "week"|"month", "times": n} with 0 < n <= 100, or
-- {"poisson_per_month": r} with 0 < r <= 1000, and nothing else. Mirrors
-- `parseRecurrence` in packages/db/src/servicing.ts (tested against it).
create function private.is_recurrence(r jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(r) is distinct from 'object' then false
    when (select array_agg(k order by k) from jsonb_object_keys(r) as k) = array['every', 'times'] then
      coalesce(r ->> 'every' in ('week', 'month'), false)
      and case when jsonb_typeof(r -> 'times') = 'number' then (r ->> 'times')::numeric > 0 and (r ->> 'times')::numeric <= 100 else false end
    when (select array_agg(k order by k) from jsonb_object_keys(r) as k) = array['poisson_per_month'] then
      case when jsonb_typeof(r -> 'poisson_per_month') = 'number'
        then (r ->> 'poisson_per_month')::numeric > 0 and (r ->> 'poisson_per_month')::numeric <= 1000 else false end
    else false
  end;
$$;

revoke all on function private.is_recurrence(jsonb) from public, anon;
grant execute on function private.is_recurrence(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

-- Which servicing processes a service's clients run, and how often.
create table public.service_servicing (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  service_id uuid not null,
  process_id uuid not null,
  recurrence jsonb not null default '{"every": "month", "times": 1}'
    constraint service_servicing_recurrence check (private.is_recurrence(recurrence)),
  -- Working hours from a task starting to it being done on time; not done within twice this, it is missed.
  sla_hours numeric not null default 40 check (sla_hours > 0 and sla_hours <= 10000),
  -- Provenance of recurrence and sla_hours, {column: {source, at, by}}.
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (service_id, process_id),
  foreign key (service_id, workspace_id) references public.services (id, workspace_id) on delete cascade,
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete cascade
);

create index on public.service_servicing (workspace_id);
create index on public.service_servicing (process_id);

create trigger set_updated_at before update on public.service_servicing for each row execute function public.set_updated_at();

create trigger stamp_provenance before insert or update on public.service_servicing
  for each row execute function public.stamp_provenance('recurrence', 'sla_hours');

-- Only servicing processes can be linked, and a linked process stays one.
create function private.servicing_link_kind() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.processes p where p.id = new.process_id and p.kind = 'servicing') then
    raise exception 'Only a servicing process can be linked to a service' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger servicing_link_kind before insert or update of process_id on public.service_servicing
  for each row execute function private.servicing_link_kind();

create function private.servicing_process_kind() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind <> 'servicing' and exists (select 1 from public.service_servicing l where l.process_id = new.id) then
    raise exception 'Process % is linked to services as servicing; unlink it first', new.id using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger servicing_kind before update of kind on public.processes
  for each row execute function private.servicing_process_kind();

-- Row-level security: members read, owners and editors write (as for services).
alter table public.service_servicing enable row level security;

create policy "read service_servicing" on public.service_servicing for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert service_servicing" on public.service_servicing for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update service_servicing" on public.service_servicing for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete service_servicing" on public.service_servicing for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.service_servicing to authenticated;
revoke all on public.service_servicing from anon;

-- Company model (issue #25): the MCP server suggests changes rather than making them, and every write is audited.
create trigger needs_review before insert or update or delete on public.service_servicing
  for each row execute function private.company_needs_review();
create trigger audit_company after insert or update or delete on public.service_servicing
  for each row execute function private.audit_company_write();

-- ---------------------------------------------------------------------------
-- Per-field saves: `service_servicing` joins save_fields' allow-list
-- ---------------------------------------------------------------------------

-- Copied from 20261012000000_clients.sql (the latest to redefine it, #18); the
-- only change is 'service_servicing' at the end of `editable`. This is now the
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
    'lead_sources', 'seasonality', 'demand_settings', 'issues', 'sources', 'clients', 'client_assignments', 'service_servicing'];
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

-- Production data alignment (run after the migration):
--
-- Northbeam's two servicing processes (a monthly report and a fortnightly
-- check-in), published, and both linked to its SEO and PPC services, exactly as
-- in seed.sql. Idempotent: rows that exist are left alone (on conflict do
-- nothing), and a process's live revision is only set while it has none. Once
-- linked, the services' fallback load no longer applies (it stays stored).
--
-- begin;
-- insert into public.processes (id, workspace_id, name, kind, entity_name, description) values
--   ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Monthly report', 'servicing', 'report', 'Each client''s month of retainer work, written up and sent with the invoice.'),
--   ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Client check-in', 'servicing', 'check-in', 'A fortnightly call with each client: questions, results, next steps.')
-- on conflict do nothing;
-- insert into public.process_revisions (id, workspace_id, process_id, number, status, published_at) values
--   ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 1, 'published', '2026-09-29T00:00:00Z'),
--   ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 1, 'published', '2026-09-29T00:00:00Z')
-- on conflict do nothing;
-- insert into public.steps (id, revision_id, workspace_id, process_id, name, kind, outcome, role_id, person_id, work_hours, work_dist, work_params, wait_hours, wait_dist, wait_params, rework_rate, rework_to_step_id, tool, notes, sla_hours, current_wip, x, y, assumption, conflict, provenance) values
--   ('e0000000-0000-4000-8000-00000000000d', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Set the month''s priorities', 'task', null, 'b0000000-0000-4000-8000-000000000002', null, 1.5, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, 'Notion', null, null, null, 60, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-00000000000e', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'SEO work & report data', 'task', null, 'b0000000-0000-4000-8000-000000000004', null, 16, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, 'Ahrefs, Looker Studio', null, null, null, 290, -10, false, false, '{}'),
--   ('e0000000-0000-4000-8000-00000000000f', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'PPC optimisation & report data', 'task', null, 'b0000000-0000-4000-8000-000000000005', null, 19, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, 'Google Ads, Looker Studio', null, null, null, 290, 110, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000010', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Write & send the report', 'task', null, 'b0000000-0000-4000-8000-000000000003', null, 3, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, 'Google Docs', null, null, null, 520, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Invoice', 'task', null, 'b0000000-0000-4000-8000-000000000006', null, 1.2, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, 'Xero', null, null, null, 750, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Month starts', 'start', null, null, null, 0, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, null, null, null, null, -150, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000013', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Report sent', 'end', 'done', null, null, 0, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, null, null, null, null, 980, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000014', 'd0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'Check-in call', 'task', null, 'b0000000-0000-4000-8000-000000000003', null, 1.5, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, 'Zoom', null, null, null, 290, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000015', 'd0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'Check-in due', 'start', null, null, null, 0, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, null, null, null, null, 60, 50, false, false, '{}'),
--   ('e0000000-0000-4000-8000-000000000016', 'd0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'Done', 'end', 'done', null, null, 0, 'lognormal', '{}', 0, 'lognormal', '{}', 0, null, null, null, null, null, 520, 50, false, false, '{}')
-- on conflict do nothing;
-- insert into public.edges (id, revision_id, workspace_id, process_id, from_step_id, to_step_id, probability, condition_tag, label) values
--   ('f0000000-0000-4000-8000-00000000000f', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000012', 'e0000000-0000-4000-8000-00000000000d', 1, null, null),
--   ('f0000000-0000-4000-8000-000000000010', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-00000000000d', 'e0000000-0000-4000-8000-00000000000e', 0.55, 'seo', null),
--   ('f0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-00000000000d', 'e0000000-0000-4000-8000-00000000000f', 0.45, 'ppc', null),
--   ('f0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-00000000000e', 'e0000000-0000-4000-8000-000000000010', 1, null, null),
--   ('f0000000-0000-4000-8000-000000000013', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-00000000000f', 'e0000000-0000-4000-8000-000000000010', 1, null, null),
--   ('f0000000-0000-4000-8000-000000000014', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000010', 'e0000000-0000-4000-8000-000000000011', 1, null, null),
--   ('f0000000-0000-4000-8000-000000000015', 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000011', 'e0000000-0000-4000-8000-000000000013', 1, null, null),
--   ('f0000000-0000-4000-8000-000000000016', 'd0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000015', 'e0000000-0000-4000-8000-000000000014', 1, null, null),
--   ('f0000000-0000-4000-8000-000000000017', 'd0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000014', 'e0000000-0000-4000-8000-000000000016', 1, null, null)
-- on conflict do nothing;
-- update public.processes set live_revision_id = 'd0000000-0000-4000-8000-000000000002' where id = 'c0000000-0000-4000-8000-000000000002' and live_revision_id is null;
-- update public.processes set live_revision_id = 'd0000000-0000-4000-8000-000000000003' where id = 'c0000000-0000-4000-8000-000000000003' and live_revision_id is null;
-- insert into public.service_servicing (id, workspace_id, service_id, process_id, recurrence, sla_hours, provenance) values
--   ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', '{"every":"month","times":1}', 40, '{"recurrence":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"sla_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}'),
--   ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', '{"every":"week","times":0.5}', 16, '{"recurrence":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"sla_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}'),
--   ('10000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', '{"every":"month","times":1}', 40, '{"recurrence":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"sla_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}'),
--   ('10000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003', '{"every":"week","times":0.5}', 16, '{"recurrence":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"},"sla_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data"}}')
-- on conflict do nothing;
-- commit;
