-- Sources, evidence and conflicts (docs/PRD.md §3 Source, §4.1 "Sources and
-- evidence", §5 `sources` and `provenance jsonb`, §7.1b, decision D17; issue #21).
--
-- Transcripts, notes and screenshots from the audit are stored per workspace
-- as `sources` (speakers and date). Parameters cite them in their existing
-- per-column provenance (`steps.provenance.<column>.evidence[]`: source_id,
-- speaker, quote, timestamp, and the value stated); no new column is needed
-- for that. When citations disagree, the column's provenance gets
-- `conflict: {values: [{value, source_id, speaker}]}` and the step is flagged
-- `conflict` (the app turns an estimate into a triangular range; see
-- packages/db/src/evidence.ts). Two triggers on `steps` make that hold for
-- every writer (canvas, MCP, import):
--
--   - `flag_conflicts` (before insert/update) sets `steps.conflict` while any
--     value has an unresolved conflict, so publish_process's gate (which
--     refuses a draft with assumption or conflict steps) counts it even if a
--     writer forgot the flag. It only ever turns the flag on.
--   - `log_perception_gaps` (after insert/update, security definer) logs a
--     `perception_gap` issue when an unresolved conflict's values differ by
--     2× or more (docs/PRD.md §4.1). It is stored as a tracked detection
--     (`source = 'promoted'`, `detected_key = perception_gap:step:<step id>.<column>`)
--     so people can work and close it like any tracked issue (rows with
--     `source = 'detected'` are read-only), and the register's unique key keeps
--     it to one row per value, however often the step is saved or copied into a
--     draft. Title and evidence text match `perceptionGaps()` in evidence.ts.
--   Both skip retired rows (`replaced_by` set, issue #16): a split step's old row
--   is neither flagged (publishing would count it) nor logged.
--
-- Files: a screenshot or recording is linked by `file_url` for now; uploads
-- to Supabase Storage (a `sources` bucket and its policies) come later, see
-- docs/supabase-notes.md.
--
-- Strictly additive: one new table, three private functions and two triggers
-- on `steps`; `save_fields` gains `sources` in its allow-list.
--
-- Rollback (run in this order):
--   drop trigger if exists log_perception_gaps on public.steps;
--   drop trigger if exists flag_conflicts on public.steps;
--   drop function if exists private.log_perception_gaps();
--   drop function if exists private.flag_conflicts();
--   drop function if exists private.has_open_conflict(jsonb);
--   drop table if exists public.sources;
--   -- then restore save_fields' previous allow-list: re-run the
--   -- `create or replace function public.save_fields` from the latest earlier
--   -- migration that defines it (20261005000000_issues.sql).
--   -- Perception-gap issues it logged stay in public.issues (type perception_gap).
--   delete from supabase_migrations.schema_migrations where version = '20261009000000';

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null default 'transcript' constraint sources_kind check (kind in ('transcript', 'notes', 'screenshot')),
  title text not null constraint sources_title_length check (char_length(btrim(title)) between 1 and 200),
  speakers text[] not null default '{}' constraint sources_speakers check (cardinality(speakers) <= 50),
  -- The day the conversation or notes are from.
  recorded_at date,
  body text constraint sources_body_length check (char_length(body) <= 500000),
  file_url text constraint sources_file_url check (file_url ~ '^https?://[^[:space:]]+$' and char_length(file_url) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create index on public.sources (workspace_id, recorded_at);

create trigger set_updated_at before update on public.sources for each row execute function public.set_updated_at();

-- Everyone in the workspace can read its sources; editors, owners and agency
-- admins add, edit and delete them.
alter table public.sources enable row level security;

create policy "read sources" on public.sources for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert sources" on public.sources for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update sources" on public.sources for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete sources" on public.sources for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.sources to authenticated;
revoke all on public.sources from anon;

-- ---------------------------------------------------------------------------
-- Conflicts: the step flag follows the provenance
-- ---------------------------------------------------------------------------

-- Whether any cited value in a step's provenance has an unresolved conflict:
-- at least two different numbers in `conflict.values` and no `conflict.resolved`.
create function private.has_open_conflict(provenance jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(bool_or(n >= 2), false)
  from (
    select (select count(distinct (v ->> 'value')::numeric)
            from jsonb_array_elements(c -> 'values') v
            where jsonb_typeof(v -> 'value') = 'number') as n
    from unnest(array['work_hours', 'wait_hours', 'rework_rate', 'current_wip', 'sla_hours']) col,
      lateral (select provenance -> col -> 'conflict' as c) x
    where jsonb_typeof(provenance) = 'object'
      and jsonb_typeof(c) = 'object'
      and jsonb_typeof(c -> 'values') = 'array'
      and coalesce(c -> 'resolved', 'null') = 'null'
  ) counts;
$$;

create function private.flag_conflicts() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A retired step (split or replaced, `replaced_by` set; issue #16) is never simulated or published as work: its flag stays as written.
  if not new.conflict and cardinality(new.replaced_by) = 0 and private.has_open_conflict(new.provenance) then
    new.conflict := true;
  end if;
  return new;
end;
$$;

revoke all on function private.has_open_conflict(jsonb) from public, anon;
revoke all on function private.flag_conflicts() from public, anon, authenticated;
-- The trigger runs as the writer, who calls has_open_conflict.
grant execute on function private.has_open_conflict(jsonb) to authenticated;

create trigger flag_conflicts before insert or update on public.steps
  for each row execute function private.flag_conflicts();

-- ---------------------------------------------------------------------------
-- Perception gaps: sources that differ by 2× or more are logged as an issue
-- ---------------------------------------------------------------------------

create function private.log_perception_gaps() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  col text;
  label text;
  c jsonb;
  lo numeric;
  hi numeric;
  n integer;
  said text;
  apart text;
begin
  -- A retired step (split or replaced; issue #16) is no longer part of the process: nothing to log.
  if cardinality(new.replaced_by) > 0 then
    return null;
  end if;
  foreach col in array array['work_hours', 'wait_hours', 'rework_rate', 'current_wip', 'sla_hours'] loop
    c := new.provenance -> col -> 'conflict';
    continue when jsonb_typeof(c) is distinct from 'object'
      or jsonb_typeof(c -> 'values') is distinct from 'array'
      or coalesce(c -> 'resolved', 'null') <> 'null';
    -- Only a conflict that is new or changed: saving other fields doesn't log it again.
    continue when tg_op = 'UPDATE' and (old.provenance -> col -> 'conflict') is not distinct from c;

    select min((v ->> 'value')::numeric), max((v ->> 'value')::numeric), count(distinct (v ->> 'value')::numeric)
      into lo, hi, n
    from jsonb_array_elements(c -> 'values') v
    where jsonb_typeof(v -> 'value') = 'number';
    continue when n < 2 or hi <= 0 or (lo > 0 and hi / lo < 2);

    label := case col
      when 'work_hours' then 'hands-on time'
      when 'wait_hours' then 'wait'
      when 'rework_rate' then 'rework rate'
      when 'current_wip' then 'current WIP'
      else 'SLA' end;
    -- "Maya Collins: 6 h; Rosa Diaz: 12 h", in the order recorded (formatParameter in evidence.ts).
    select string_agg(
        coalesce(v ->> 'speaker', case when v ->> 'source_id' is null then 'Entered value' else 'Unnamed speaker' end) || ': ' ||
        case col
          when 'rework_rate' then trim_scale(round((v ->> 'value')::numeric * 100, 1))::text || '%'
          when 'current_wip' then trim_scale(round((v ->> 'value')::numeric, 2))::text || ' items'
          else trim_scale(round((v ->> 'value')::numeric, 2))::text || ' h' end,
        '; ' order by ord)
      into said
    from jsonb_array_elements(c -> 'values') with ordinality as e(v, ord)
    where jsonb_typeof(v -> 'value') = 'number';
    apart := case when lo > 0 then trim_scale(round(hi / lo, 1))::text || '× apart' else 'one says none' end;

    insert into public.issues (workspace_id, process_id, step_id, role_id, type, severity, title, evidence,
      evidence_metrics, evidence_sources, source, detected_key)
    values (
      new.workspace_id,
      new.process_id,
      new.id,
      new.role_id,
      'perception_gap',
      'warning',
      left('Sources disagree on ' || new.name || ': ' || label, 200),
      left(said || ' (' || apart || '). Measure it before relying on it.', 5000),
      jsonb_strip_nulls(jsonb_build_object('min', lo, 'max', hi, 'ratio', case when lo > 0 then round(hi / lo, 3) end)),
      case when jsonb_typeof(new.provenance -> col -> 'evidence') = 'array' then new.provenance -> col -> 'evidence' else '[]' end,
      'promoted',
      'perception_gap:step:' || new.id || '.' || col)
    on conflict (workspace_id, detected_key) where detected_key is not null do nothing;
  end loop;
  return null;
end;
$$;

revoke all on function private.log_perception_gaps() from public, anon, authenticated;

create trigger log_perception_gaps after insert or update of provenance on public.steps
  for each row execute function private.log_perception_gaps();

-- ---------------------------------------------------------------------------
-- Per-field saves: `sources` joins save_fields' allow-list
-- ---------------------------------------------------------------------------

-- Copied from 20261005000000_issues.sql; the only change is 'sources' at the
-- end of `editable`. This is the last migration to redefine save_fields, so
-- its list must be the union of every earlier one. `create or replace` keeps
-- the grants made there.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services',
    'lead_sources', 'seasonality', 'demand_settings', 'issues', 'sources'];
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
-- Gives an existing Northbeam workspace the seed's two sources and the
-- evidence its sample figures cite (every cited value equals the step's own,
-- so nothing simulates differently). Idempotent: sources are inserted only if
-- missing, and a live step gets evidence only while its provenance is empty.
-- Skipped entirely when there is no Northbeam workspace.
--
-- insert into public.sources (id, workspace_id, kind, title, speakers, recorded_at, body, created_at, updated_at)
-- select v.id::uuid, w.id, v.kind, v.title, v.speakers, v.recorded_at::date, v.body, '2026-09-29T09:00:00Z', '2026-09-29T09:00:00Z'
-- from public.workspaces w,
--   (values
--     ('30000000-0000-4000-8000-000000000001', 'transcript', 'Strategy walkthrough', array['Maya Collins', 'Rosa Diaz']::text[], '2026-09-12',
--      E'[00:14:05] Maya Collins: A proper audit and proposal is a day''s work, call it six hours, if nobody interrupts me.\n[00:16:40] Rosa Diaz: From the time logs it looks more like twelve hours by the time it goes out.\n[00:21:10] Maya Collins: Kickoffs are quicker, half a day.'),
--     ('30000000-0000-4000-8000-000000000002', 'notes', 'Sales team notes', array['Priya Shah', 'Tom Reed']::text[], '2026-09-15',
--      E'Priya: discovery calls get booked within three working days of qualifying.\nPriya: about one proposal in seven comes back from sales review for changes.\nTom: clients take a week to decide, sometimes longer.')
--   ) as v(id, kind, title, speakers, recorded_at, body)
-- where w.id = 'a0000000-0000-4000-8000-000000000001'
-- on conflict (id) do nothing;
--
-- update public.steps s set provenance = v.provenance::jsonb
-- from public.processes p,
--   (values
--     ('e0000000-0000-4000-8000-000000000002', '{"wait_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data","evidence":[{"source_id":"30000000-0000-4000-8000-000000000002","speaker":"Priya Shah","quote":"Discovery calls get booked within three working days of qualifying.","timestamp":null,"value":24}]}}'),
--     ('e0000000-0000-4000-8000-000000000003', '{"work_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data","evidence":[{"source_id":"30000000-0000-4000-8000-000000000001","speaker":"Maya Collins","quote":"A proper audit and proposal is a day''s work, call it six hours.","timestamp":"00:14:05","value":6}]},"rework_rate":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data","evidence":[{"source_id":"30000000-0000-4000-8000-000000000002","speaker":"Priya Shah","quote":"About one proposal in seven comes back from sales review for changes.","timestamp":null,"value":0.15}]}}'),
--     ('e0000000-0000-4000-8000-000000000004', '{"wait_hours":{"source":"estimated","at":"2026-09-29T00:00:00Z","note":"Northbeam sample data","evidence":[{"source_id":"30000000-0000-4000-8000-000000000002","speaker":"Tom Reed","quote":"Clients take a week to decide, sometimes longer.","timestamp":null,"value":40}]}}')
--   ) as v(id, provenance)
-- where p.id = 'c0000000-0000-4000-8000-000000000001'
--   and s.revision_id = p.live_revision_id
--   and s.id = v.id::uuid
--   and s.provenance = '{}'::jsonb
--   and exists (select 1 from public.sources src where src.id = '30000000-0000-4000-8000-000000000001');
