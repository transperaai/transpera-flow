-- Issues register (docs/PRD.md §3 "Issue", §4.1 "Issues register", §5 `issues`; issue #17).
--
-- One register for every finding, linked to its fix. Audit findings are logged
-- by hand (`source = 'manual'`). The engine detects issues on every run
-- (packages/engine/src/issues.ts); those are regenerated each run and live in
-- memory, not here, and a user can promote one into a tracked issue
-- (`source = 'promoted'`), which keeps its `detected_key` so the next run
-- recognises it instead of listing it twice (one row per key per workspace).
-- `source = 'detected'` is reserved for runs stored server-side later; nobody
-- can insert or edit such rows through the API.
--
-- `step_id` is a step's stable id (docs/PRD.md §4.1 "Stable step IDs"). Steps
-- are keyed by (revision_id, id), so it has no foreign key; the issue keeps
-- pointing at the step across revisions. `role_id` is not in the PRD's column
-- list: detected capacity issues are about a role, and a promoted one keeps
-- it. `client_id` waits for the clients table.
--
-- Rows are edited one field at a time (docs/adr/0001-per-field-saves.md), so
-- `save_fields` is redefined below with `issues` added to its allow-list; the
-- body is otherwise the one from 20260930000000_field_saves.sql, unchanged, and
-- the list keeps every table the earlier migrations added (services, demand).
-- `source`, `detected_key` and `resolved_at` can't be changed by an edit: a
-- trigger keeps the first two fixed and sets `resolved_at` from the status.
--
-- Strictly additive: one new table and its trigger function; `save_fields`
-- gains a table in its allow-list.
--
-- Rollback (run in this order):
--   drop table if exists public.issues;
--   drop function if exists private.issues_before_write();
--   -- then restore save_fields' previous allow-list: re-run the
--   -- `create or replace function public.save_fields` from the latest earlier
--   -- migration that defines it (20261004000000_demand.sql).
--   delete from supabase_migrations.schema_migrations where version = '20261005000000';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  process_id uuid,
  -- Stable step id (no foreign key: steps are keyed by revision).
  step_id uuid,
  role_id uuid,
  person_id uuid,
  type text not null constraint issues_type check (type in (
    'bottleneck', 'spof', 'manual', 'delay', 'failure', 'idea', 'capacity', 'sla',
    'churn_risk', 'perception_gap', 'broken_scenario')),
  severity text not null default 'warning' constraint issues_severity check (severity in ('critical', 'serious', 'warning', 'info')),
  title text not null constraint issues_title_length check (char_length(btrim(title)) between 1 and 200),
  evidence text constraint issues_evidence_length check (char_length(evidence) <= 5000),
  -- Numbers behind the finding (a detected issue's metrics when promoted), {name: number}.
  evidence_metrics jsonb not null default '{}' constraint issues_evidence_metrics_shape check (jsonb_typeof(evidence_metrics) = 'object'),
  -- Source citations [{source_id, speaker, quote, timestamp}] once sources land.
  evidence_sources jsonb not null default '[]' constraint issues_evidence_sources_shape check (jsonb_typeof(evidence_sources) = 'array'),
  owner_person_id uuid,
  status text not null default 'open' constraint issues_status check (status in ('open', 'in_progress', 'done', 'dismissed')),
  -- The fix: a saved scenario that "Run the fix" applies.
  scenario_id uuid,
  source text not null default 'manual' constraint issues_source check (source in ('manual', 'detected', 'promoted')),
  -- The engine's stable key for a detected or promoted issue: <detector>:<subject kind>:<id>.
  detected_key text constraint issues_detected_key_shape check (detected_key ~ '^[a-z_]+:[a-z_]+:[^[:space:]]{1,200}$'),
  -- When it was last marked done or dismissed; null while open or in progress. Set by the trigger.
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  -- Manual issues have no key; detected and promoted ones must.
  constraint issues_detected_key_source check ((source = 'manual') = (detected_key is null)),
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete set null (process_id),
  foreign key (role_id, workspace_id) references public.roles (id, workspace_id) on delete set null (role_id),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete set null (person_id),
  foreign key (owner_person_id, workspace_id) references public.people (id, workspace_id) on delete set null (owner_person_id),
  foreign key (scenario_id, workspace_id) references public.scenarios (id, workspace_id) on delete set null (scenario_id)
);

-- A detection is tracked at most once per workspace: promoting it twice, or
-- promoting it again on the next run, hits this.
create unique index issues_workspace_detected_key on public.issues (workspace_id, detected_key) where detected_key is not null;
create index on public.issues (workspace_id, status);

create trigger set_updated_at before update on public.issues for each row execute function public.set_updated_at();

-- `source` and `detected_key` are fixed once written; `resolved_at` follows the status.
create function private.issues_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.source is distinct from old.source or new.detected_key is distinct from old.detected_key then
      raise exception 'issues: source and detected_key cannot be changed' using errcode = '23514';
    end if;
    if new.status in ('done', 'dismissed') then
      new.resolved_at := case when old.status in ('done', 'dismissed') then old.resolved_at else now() end;
    else
      new.resolved_at := null;
    end if;
  else
    new.resolved_at := case when new.status in ('done', 'dismissed') then now() else null end;
  end if;
  return new;
end;
$$;

revoke all on function private.issues_before_write() from public, anon, authenticated;

create trigger issues_before_write before insert or update on public.issues
  for each row execute function private.issues_before_write();

-- Everyone in the workspace can read the register; editors, owners and agency
-- admins log, edit, close and delete issues. Rows a stored run detected are
-- read-only.
alter table public.issues enable row level security;

create policy "read issues" on public.issues for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert issues" on public.issues for insert to authenticated
  with check (public.can_edit_workspace(workspace_id) and source <> 'detected');
create policy "update issues" on public.issues for update to authenticated
  using (public.can_edit_workspace(workspace_id) and source <> 'detected')
  with check (public.can_edit_workspace(workspace_id) and source <> 'detected');
create policy "delete issues" on public.issues for delete to authenticated
  using (public.can_edit_workspace(workspace_id) and source <> 'detected');

grant select, insert, update, delete on public.issues to authenticated;
revoke all on public.issues from anon;

-- ---------------------------------------------------------------------------
-- Per-field saves: `issues` joins save_fields' allow-list
-- ---------------------------------------------------------------------------

-- Copied from 20261004000000_demand.sql (itself 20260930000000_field_saves.sql
-- plus 'services' from 20261001000000_services.sql and the three demand
-- tables); the only change is 'issues' at the end of `editable`. This is the
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
    'lead_sources', 'seasonality', 'demand_settings', 'issues'];
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
