-- Cut Branding (D70), Historical data (D71) and the Change log (D72) from Settings: the database half
-- (docs/plans/capacity/q19-settings-cuts-brief.md, chunks 2 and 4).
--
-- What it does:
--   * Branding: drops the `audit_logo` trigger, `private.audit_workspace_logo_write()`, `public.workspace_logo(uuid)`, the table
--     `public.workspace_logos`, the check `workspaces_branding_shape` and the column `workspaces.branding`.
--   * Historical data: drops `public.apply_calibration`, `record_calibration`, `record_client_calibration`, `record_dataset` and every
--     overload of `record_calibration_import`, their helpers `private.calibrations_before_write()` and
--     `private.calibration_payload_problem(text, jsonb, jsonb)`, and the tables `public.capacity_factor_proposals`,
--     `public.calibrations` and `public.datasets`.
--   * Measured values become ordinary values: every `provenance` entry that calibration stamped (`source = 'measured'` with a
--     `dataset_id` or `calibration_id`) becomes `source = 'entered'` and loses those two keys, in every table's `provenance` column
--     (steps in live, draft and superseded revisions, lead sources, client groups, per-person times, ...) and in the steps held by
--     `blocks.steps` and `solutions.steps`. A per-person time's `factor` entry is rewritten whatever keys it has. A `measured` that a
--     person picked as a step's source label (`steps.provenance.work` and the Set up screens' labels) carries neither key and is
--     kept: that is `StepSourceLabel`, not calibration. Triggers are switched off on each table during the rewrite, so no audit rows,
--     `updated_at` bumps or published-version guards fire. Runs' saved snapshots are history and are left as they are.
--   * Redefines `public.team_capacity(uuid)` (the only function that read calibration's output): the body is the live one (newest
--     definition: 20261227000000_calibrate_capacity_factors.sql) with `source` and `items` removed from the per-person times.
--
-- Kept: `public.audit_log` and everything that writes or reads it (`revision_history`, `restore_version`, `log_process_import`,
-- `map_cards_removed`, `agency_workspace_list`'s Last activity). Nothing else referenced the dropped tables: the backup bundle and
-- `import_workspace_bundle` never listed them.
--
-- Preflight (read-only):
--   select count(*) from public.calibrations; select count(*) from public.datasets; select count(*) from public.workspace_logos;
--   select count(*) from public.steps where provenance::text like '%"measured"%';
-- Locks: ACCESS EXCLUSIVE on the tables dropped and, briefly, on each table with a `provenance` column (trigger switch).
-- Post-apply checks: the tables and functions above are gone; no `provenance` entry has both `"source": "measured"` and a
--   `dataset_id` or `calibration_id`.
--
-- ROLLBACK: none for the data. The dropped tables and the rewritten provenance cannot be rebuilt from this file. Restore from a
-- Neon branch taken before applying.

-- ---------------------------------------------------------------------------
-- 1. What reads calibration's output, redefined without it
-- ---------------------------------------------------------------------------

create or replace function public.team_capacity(ws uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  everyone boolean;
  own uuid;
  result jsonb;
begin
  if ws is null or not public.can_read_workspace(ws) then
    raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
  end if;
  everyone := public.can_see_people(ws);
  own := public.my_person_id(ws);

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
           pe.end_date, pe.provenance,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  shown as (
    select p.*,
      case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
      -- No pay for anyone but the caller's own person (and those who see everyone).
      case when everyone or p.id = own then p.cost_rate end as shown_rate
    from p
  )
  select jsonb_build_object(
    'sees_everyone', everyone,
    'own_person_id', own,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
        'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
        'start_date', s.start_date, 'end_date', s.end_date,
        'provenance', case when everyone then s.provenance else '{}'::jsonb end)
      order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
    'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
        'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
      from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
    'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
        'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
      from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
    'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
        'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
        order by l.person_id, l.start_date, l.id)
      from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
    'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
        'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb),
    -- C6: per-person times. Everyone's for those who see everyone; only the caller's own person's otherwise (none when
    -- unlinked). Never provenance (it holds who entered it). D71: a time is always a person's own entry now, so it has no
    -- `source` or `items`.
    'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
        'workspace_id', f.workspace_id, 'factor', f.factor)
        order by f.person_id, f.step_id nulls first)
      from public.person_capacity_factors f
      where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Measured values become ordinary values
-- ---------------------------------------------------------------------------

-- One level: { column: entry }. `always` rewrites any measured entry (per-person times only calibration wrote); otherwise only
-- the ones calibration stamped, so a person's own "measured" source label stays.
create function private.q19_unmeasured(p jsonb, always boolean) returns jsonb
language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(p) <> 'object' then p else coalesce((
    select jsonb_object_agg(e.key,
      case when jsonb_typeof(e.value) = 'object' and e.value ->> 'source' = 'measured'
                and (always or e.value ? 'dataset_id' or e.value ? 'calibration_id')
        then (e.value - 'dataset_id' - 'calibration_id') || jsonb_build_object('source', 'entered')
        else e.value end)
    from jsonb_each(p) e), p) end
$$;

-- A bundle { steps: [ { ..., provenance } ] }, as blocks and solutions keep their steps.
create function private.q19_unmeasured_bundle(b jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(b -> 'steps') <> 'array' then b else jsonb_set(b, '{steps}', coalesce((
    select jsonb_agg(case when jsonb_typeof(s.value -> 'provenance') = 'object'
        then jsonb_set(s.value, '{provenance}', private.q19_unmeasured(s.value -> 'provenance', false)) else s.value end
      order by s.ordinality)
    from jsonb_array_elements(b -> 'steps') with ordinality s), '[]'::jsonb)) end
$$;

do $$
declare
  t record;
begin
  for t in
    select c.oid::regclass as tbl, c.relname
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where a.attname = 'provenance' and not a.attisdropped and a.atttypid = 'jsonb'::regtype
    order by c.relname
  loop
    execute format('alter table %s disable trigger user', t.tbl);
    execute format(
      'update %s set provenance = private.q19_unmeasured(provenance, %L) where provenance::text like %L and private.q19_unmeasured(provenance, %L) is distinct from provenance',
      t.tbl, t.relname = 'person_capacity_factors', '%"measured"%', t.relname = 'person_capacity_factors');
    execute format('alter table %s enable trigger user', t.tbl);
  end loop;
end $$;

alter table public.blocks disable trigger user;
update public.blocks set steps = private.q19_unmeasured_bundle(steps)
where steps::text like '%"measured"%' and private.q19_unmeasured_bundle(steps) is distinct from steps;
alter table public.blocks enable trigger user;

alter table public.solutions disable trigger user;
update public.solutions set steps = private.q19_unmeasured_bundle(steps)
where steps::text like '%"measured"%' and private.q19_unmeasured_bundle(steps) is distinct from steps;
alter table public.solutions enable trigger user;

drop function private.q19_unmeasured_bundle(jsonb);
drop function private.q19_unmeasured(jsonb, boolean);

-- ---------------------------------------------------------------------------
-- 3. Historical data (D71)
-- ---------------------------------------------------------------------------

drop function public.apply_calibration(uuid, text[]);
drop function public.record_calibration(uuid, uuid, text, jsonb, integer, jsonb, text[]);
drop function public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[]);
drop function public.record_dataset(uuid, text, text, jsonb, integer, jsonb);
-- Every overload, by name.
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'record_calibration_import' loop
    execute format('drop function %s', f);
  end loop;
end $$;

drop table public.capacity_factor_proposals;
drop table public.calibrations;
drop table public.datasets;

drop function private.calibrations_before_write();
drop function private.calibration_payload_problem(text, jsonb, jsonb);

-- ---------------------------------------------------------------------------
-- 4. Branding (D70)
-- ---------------------------------------------------------------------------

drop trigger audit_logo on public.workspace_logos;
drop function private.audit_workspace_logo_write();
drop function public.workspace_logo(uuid);
drop table public.workspace_logos;
alter table public.workspaces drop constraint workspaces_branding_shape;
alter table public.workspaces drop column branding;
