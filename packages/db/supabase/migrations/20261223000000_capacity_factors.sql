-- Per-person times, a.k.a. capacity factors (issue #198, C6; docs/plans/c6-brief.md).
--
-- One person can be faster or slower than their role's normal time on a step. An owner or editor types a factor for the
-- person (1 is the role's normal time, 0.8 is 20% faster, 1.25 is 25% slower; 0.5 to 2): one optional factor for every step
-- they do (their default) and one optional factor per step, which wins over the default. The simulation multiplies the hands-on
-- time the person takes on the step by it. The switch is the existing `settings.capacity_factor_enabled` key (off unless true).
-- It is NOT `person_skills.efficiency`: any `person_skills` row limits the person to the listed steps.
--
-- What this adds. Strictly additive, with ONE exception: `public.team_capacity(uuid)` is replaced (`create or replace`, same
-- signature, return type and grants; a full copy of 20261207500000's body plus one key). Not changed: `save_fields`,
-- `share_team_capacity`, `private.share_snapshot_problem`, `import_workspace_bundle`, and every existing policy and grant.
--   * Table `public.person_capacity_factors` (person_id, workspace_id, step_id null = the person's default, factor 0.5 to 2,
--     provenance, created_at, updated_at, created_by). No primary key: two partial unique indexes are the identity (one
--     default and one factor per step, per person), which avoids NULLS NOT DISTINCT (Postgres 15). RLS: read through
--     `can_see_person` (everyone's for those who see everyone, a member's or viewer's own person's only), insert, update and
--     delete through `can_edit_workspace`. Triggers: `set_updated_at`, `stamp_provenance('factor')`, `audit_company`
--     (the change log) and `needs_review` (an API token, i.e. the MCP server, can't write factors). Not in the Realtime publication.
--   * `public.save_capacity_factor(person, step, base, value)` (SECURITY INVOKER, empty search_path): compare-and-set of one
--     factor, so RLS decides who writes. `step` null is the default; `value` null removes the factor.
--     Returns {"status": "saved", "value": n|null} | {"status": "conflict", "theirs": n|null} | {"status": "not_found"}.
--     Errors: 23514 (a value outside 0.5 to 2), 22023 (a step that is not in the person's workspace).
--   * `public.save_capacity_factor_switch(ws, base, changes)` (SECURITY DEFINER, empty search_path): owners AND editors switch
--     `settings.capacity_factor_enabled` (true, false or null; null and false are the same). A copy of `save_health_rules`
--     (20261209000000) that can write nothing else, because `save_fields('workspaces')` is owner-only. The UPDATE still fires
--     `stamp_settings_provenance`, `audit_company` and `needs_review`.
--   * `public.team_capacity(ws)`, one new key (marked C6): `person_capacity_factors`, every factor for callers who see
--     everyone, and only the caller's own person's for everyone else (`[]` when unlinked). Never provenance or created_by.
--     Shape: { sees_everyone, own_person_id,
--              people: [{id, workspace_id, name, fte, capacity_hours_week, cost_rate, active, start_date, end_date, provenance}],
--              person_roles: [{person_id, role_id, workspace_id}], person_skills: [{person_id, step_id, workspace_id}],
--              person_leave: [{id, person_id, workspace_id, start_date, end_date}],
--              client_assignments: [{client_id, role_id, person_id, workspace_id}],
--              person_capacity_factors: [{person_id, step_id, workspace_id, factor, source}] }
--   * `private.share_links_no_speeds()` + trigger `share_links_no_speeds` on `share_links`: no link snapshot may hold a
--     per-person time (`personCapacityFactors`, `person_capacity_factors` or `capacityFactor` anywhere), whatever its toggles
--     (D20: only the person and owners and editors see them). `share_team_capacity` has no such key, so a link's team has none.
--
-- ORDER: after 20261220000000 (B3, row 64; needed: `share_links`), 20261220500000 (a bug fix, row 65) and 20261221000000 (B4, row 66).
-- If either of those two has not been applied when this is, renumber per HANDOVER. This is row 67 of docs/production-migrations.md.
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time):
--   0. Latest applied versions. Expect 20261220000000, 20261220500000 and 20261221000000 (B4, the latest) and nothing >= 20261223000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261220000000' order by 1;
--   1. Nothing exists yet. Expect null x4:
--        select to_regclass('public.person_capacity_factors'),
--               to_regprocedure('public.save_capacity_factor(uuid, uuid, numeric, numeric)'),
--               to_regprocedure('public.save_capacity_factor_switch(uuid, jsonb, jsonb)'),
--               to_regprocedure('private.share_links_no_speeds()');
--   2. `team_capacity` is 20261207500000's, unchanged since. Expect one row: t, f, d07292f9554ca24ba8a418b316d76099 (the md5 of its body;
--      this migration replaces exactly that body, and its rollback puts it back):
--        select prosrc like '%Team member%', prosrc like '%person_capacity_factors%', md5(prosrc)
--        from pg_proc where pronamespace = 'public'::regnamespace and proname = 'team_capacity';
--   3. The helpers exist. Expect 7 rows (the first four in public, the next two in private, then share_links):
--        select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--          where (n.nspname, p.proname) in (('public', 'can_see_person'), ('public', 'can_edit_workspace'), ('public', 'set_updated_at'),
--            ('public', 'stamp_provenance'), ('private', 'audit_company_write'), ('private', 'company_needs_review'))
--        union all select 'table ' || to_regclass('public.share_links')::text where to_regclass('public.share_links') is not null
--        order by 1;
--   4. The workspaces triggers the switch function relies on are enabled. Expect 3 rows, all 'O':
--        select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.workspaces'::regclass
--          and tgname in ('stamp_settings_provenance', 'audit_company', 'needs_review');
--   5. For the log: workspaces that already have the key. Expect 0 rows. If one has `true`, nothing moves, because there are
--      no factors yet:
--        select slug, settings -> 'capacity_factor_enabled' from public.workspaces where settings ? 'capacity_factor_enabled';
--
-- POST-APPLY CHECK:
--   1. RLS on and four policies, the select qual mentioning can_see_person. Expect t, 4, then the select policy's qual:
--        select relrowsecurity from pg_class where oid = 'public.person_capacity_factors'::regclass;
--        select count(*) from pg_policies where schemaname = 'public' and tablename = 'person_capacity_factors';
--        select qual from pg_policies where tablename = 'person_capacity_factors' and cmd = 'SELECT';
--   2. anon holds nothing on the table; authenticated has DELETE, INSERT, SELECT, UPDATE. Expect no anon rows, then four:
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public'
--          and table_name = 'person_capacity_factors' and grantee in ('anon', 'authenticated') order by 1, 2;
--   3. Expect (save_capacity_factor, f, {search_path=""}), (save_capacity_factor_switch, t, same), (team_capacity, t, same);
--      then (share_links_no_speeds, f, same); then team_capacity's new md5, a8dcb5d1bddaf549ecef591a3c1b5ae0:
--        select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace
--          and proname in ('save_capacity_factor', 'save_capacity_factor_switch', 'team_capacity') order by 1;
--        select proname, prosecdef, proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname = 'share_links_no_speeds';
--        select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'team_capacity';
--   4. Expect anon f, f and authenticated t, t:
--        select has_function_privilege('anon', 'public.save_capacity_factor(uuid, uuid, numeric, numeric)', 'execute'),
--               has_function_privilege('anon', 'public.save_capacity_factor_switch(uuid, jsonb, jsonb)', 'execute'),
--               has_function_privilege('authenticated', 'public.save_capacity_factor(uuid, uuid, numeric, numeric)', 'execute'),
--               has_function_privilege('authenticated', 'public.save_capacity_factor_switch(uuid, jsonb, jsonb)', 'execute');
--   5. Triggers: on the table set_updated_at, stamp_provenance, audit_company, needs_review (4 rows); on share_links
--      share_links_no_speeds (1 row); both partial unique indexes exist (2 rows):
--        select tgname from pg_trigger where tgrelid = 'public.person_capacity_factors'::regclass and not tgisinternal order by 1;
--        select tgname from pg_trigger where tgrelid = 'public.share_links'::regclass and tgname = 'share_links_no_speeds';
--        select indexname from pg_indexes where tablename = 'person_capacity_factors'
--          and indexname in ('person_capacity_factors_step', 'person_capacity_factors_default');
--   6. Smoke test, ROLLED BACK, as an agency admin (as 20261207500000's): the new key is an empty list.
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<user id>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);
--        select public.team_capacity('<northbeam id>') -> 'person_capacity_factors';   -- []
--        rollback;
--   7. On the real project: as an editor, switch Per-person times on in Settings -> Simulation and set one factor on a
--      person (Settings -> People). The owner's change log names the editor. Switch it off again.
--
-- ROLLBACK (one transaction; the only thing existing that changed is `team_capacity`, which goes back to 20261207500000's body,
-- written out in full below so it can be run as it stands). It deletes every stored per-person time:
--   begin;
--   drop trigger if exists share_links_no_speeds on public.share_links;
--   drop function if exists private.share_links_no_speeds();
--   drop function if exists public.save_capacity_factor_switch(uuid, jsonb, jsonb);
--   drop function if exists public.save_capacity_factor(uuid, uuid, numeric, numeric);
--   -- team_capacity back to 20261207500000's body (create or replace; the md5 of its body is d07292f9554ca24ba8a418b316d76099):
--   create or replace function public.team_capacity(ws uuid) returns jsonb
--   language plpgsql stable security definer
--   set search_path = ''
--   as $$
--   declare
--     everyone boolean;
--     own uuid;
--     result jsonb;
--   begin
--     if ws is null or not public.can_read_workspace(ws) then
--       raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
--     end if;
--     everyone := public.can_see_people(ws);
--     own := public.my_person_id(ws);
--   
--     with p as (
--       select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
--              pe.end_date, pe.provenance,
--              row_number() over (order by pe.created_at, pe.id) as n
--       from public.people pe where pe.workspace_id = ws
--     ),
--     shown as (
--       select p.*,
--         case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
--         -- No pay for anyone but the caller's own person (and those who see everyone).
--         case when everyone or p.id = own then p.cost_rate end as shown_rate
--       from p
--     )
--     select jsonb_build_object(
--       'sees_everyone', everyone,
--       'own_person_id', own,
--       'people', coalesce((select jsonb_agg(jsonb_build_object(
--           'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
--           'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
--           'start_date', s.start_date, 'end_date', s.end_date,
--           'provenance', case when everyone then s.provenance else '{}'::jsonb end)
--         order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
--       'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
--           'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
--         from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
--       'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
--           'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
--         from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
--       'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
--           'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
--           order by l.person_id, l.start_date, l.id)
--         from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
--       'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
--           'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
--         from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb)
--     ) into result;
--     return result;
--   end;
--   $$;
--   drop table if exists public.person_capacity_factors;
--   delete from supabase_migrations.schema_migrations where version = '20261223000000';
--   commit;
--
-- Production data: none needed (no factors exist yet; the switch stays off wherever it is).

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.person_capacity_factors (
  person_id uuid not null,
  workspace_id uuid not null,
  -- Null: the person's factor for every step they do (their default). A step id: that step only (wins over the default).
  -- Step ids are stable across a process's versions (as person_skills.step_id); no foreign key, as for person_skills.
  step_id uuid,
  -- Their time on the step as a multiple of the role's normal time: 0.8 is 20% faster, 1.25 is 25% slower.
  factor numeric not null check (factor >= 0.5 and factor <= 2),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);

-- One default and one factor per step, per person (two partial indexes: a null step_id is the default). There is no
-- primary key; `audit_company_write` falls back to `person_id` as the target, which is what the change log wants.
create unique index person_capacity_factors_step on public.person_capacity_factors (person_id, step_id) where step_id is not null;
create unique index person_capacity_factors_default on public.person_capacity_factors (person_id) where step_id is null;
create index on public.person_capacity_factors (workspace_id);

create trigger set_updated_at before update on public.person_capacity_factors
  for each row execute function public.set_updated_at();
-- A person entering a factor records a fact (D19): provenance.factor = {source: 'entered', at, by}.
create trigger stamp_provenance before insert or update on public.person_capacity_factors
  for each row execute function public.stamp_provenance('factor');
create trigger audit_company after insert or update or delete on public.person_capacity_factors
  for each row execute function private.audit_company_write();
-- The MCP server (an API token) can't write factors, not even through save_capacity_factor.
create trigger needs_review before insert or update or delete on public.person_capacity_factors
  for each row execute function private.company_needs_review();

alter table public.person_capacity_factors enable row level security;

create policy "read person_capacity_factors" on public.person_capacity_factors for select to authenticated
  using (public.can_see_person(workspace_id, person_id));
create policy "insert person_capacity_factors" on public.person_capacity_factors for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update person_capacity_factors" on public.person_capacity_factors for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete person_capacity_factors" on public.person_capacity_factors for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.person_capacity_factors to authenticated;
revoke all on public.person_capacity_factors from anon;

-- ---------------------------------------------------------------------------
-- 2. Saving one factor
-- ---------------------------------------------------------------------------

-- Compare-and-set for one factor. SECURITY INVOKER, so RLS and the table's triggers decide who writes and what is logged.
create function public.save_capacity_factor(person uuid, step uuid, base numeric, value numeric) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ws uuid;
  stored numeric;
  had boolean;
begin
  if value is not null and (value < 0.5 or value > 2) then
    raise exception 'save_capacity_factor: a factor is from 0.5 to 2' using errcode = '23514';
  end if;

  -- RLS applies: a member sees only their own person. The same answer save_fields gives under RLS to a caller who can't write.
  select pe.workspace_id into ws from public.people pe where pe.id = person;
  if ws is null or not coalesce(public.can_edit_workspace(ws), false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if step is not null and not exists (select 1 from public.steps s where s.id = step and s.workspace_id = ws) then
    raise exception 'save_capacity_factor: that step is not in this workspace' using errcode = '22023';
  end if;

  select f.factor into stored from public.person_capacity_factors f
    where f.person_id = person and f.step_id is not distinct from step for update;
  had := found;

  if stored is distinct from base and stored is distinct from value then
    return jsonb_build_object('status', 'conflict', 'theirs', stored);
  end if;

  if stored is distinct from value then
    if value is null then
      delete from public.person_capacity_factors f where f.person_id = person and f.step_id is not distinct from step;
    elsif had then
      update public.person_capacity_factors f set factor = value where f.person_id = person and f.step_id is not distinct from step;
    else
      begin
        insert into public.person_capacity_factors (person_id, workspace_id, step_id, factor) values (person, ws, step, value);
      exception when unique_violation then
        -- Someone else inserted first: report what is stored now, once.
        select f.factor into stored from public.person_capacity_factors f
          where f.person_id = person and f.step_id is not distinct from step;
        return jsonb_build_object('status', 'conflict', 'theirs', stored);
      end;
    end if;
  end if;

  select f.factor into stored from public.person_capacity_factors f
    where f.person_id = person and f.step_id is not distinct from step;
  return jsonb_build_object('status', 'saved', 'value', stored);
end;
$$;

revoke execute on function public.save_capacity_factor(uuid, uuid, numeric, numeric) from public, anon;
grant execute on function public.save_capacity_factor(uuid, uuid, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Owners and editors switch Per-person times
-- ---------------------------------------------------------------------------

-- A copy of `public.save_health_rules` (20261209000000) with these changes only: the one allowed key; the value must be true,
-- false or null; null and false are the same (absent means off); the error prefix.
create function public.save_capacity_factor_switch(ws uuid, base jsonb, changes jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed constant text[] := array['capacity_factor_enabled'];
  k text;
  v jsonb;
  stored jsonb;
  theirs jsonb;
  seen jsonb;
  patch jsonb := '{}';
  conflicts jsonb := '{}';
  result jsonb := '{}';
begin
  if base is null or jsonb_typeof(base) <> 'object' then
    raise exception 'save_capacity_factor_switch: base must be a json object' using errcode = '22023';
  end if;
  if changes is null or jsonb_typeof(changes) <> 'object' or changes = '{}' then
    raise exception 'save_capacity_factor_switch: changes must be a non-empty json object' using errcode = '22023';
  end if;

  for k, v in select * from jsonb_each(changes) loop
    if not (k = any (allowed)) then
      raise exception 'save_capacity_factor_switch: % cannot be saved', k using errcode = '42501';
    end if;
    if not base ? k then
      raise exception 'save_capacity_factor_switch: % has no base value', k using errcode = '22023';
    end if;
    if not (jsonb_typeof(v) in ('null', 'boolean')) then
      raise exception 'save_capacity_factor_switch: % must be true, false or null', k using errcode = '23514';
    end if;
  end loop;

  -- The same answer save_fields gives under RLS to a caller who can't write.
  if ws is null or not coalesce(public.can_edit_workspace(ws), false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select w.settings into stored from public.workspaces w where w.id = ws for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  stored := coalesce(stored, '{}');

  for k, v in select * from jsonb_each(changes) loop
    -- Absent, null and false all mean off.
    seen := coalesce(nullif(base -> k, 'null'), 'false');
    theirs := coalesce(nullif(stored -> k, 'null'), 'false');
    if theirs is distinct from seen and theirs is distinct from coalesce(nullif(v, 'null'), 'false') then
      conflicts := conflicts || jsonb_build_object(k, coalesce(stored -> k, 'null'));
    elsif theirs is distinct from coalesce(nullif(v, 'null'), 'false') then
      patch := patch || jsonb_build_object(k, v);
    end if;
  end loop;

  if patch <> '{}' then
    update public.workspaces w set settings = coalesce(w.settings, '{}') || patch where w.id = ws returning w.settings into stored;
  end if;

  for k in select jsonb_object_keys(changes) loop
    result := result || jsonb_build_object(k, coalesce(stored -> k, 'null'));
  end loop;

  return jsonb_build_object(
    'status', case when conflicts <> '{}' then 'conflict' else 'saved' end,
    'row', jsonb_build_object('settings', result),
    'conflicts', conflicts);
end;
$$;

revoke execute on function public.save_capacity_factor_switch(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_capacity_factor_switch(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. team_capacity: everyone's factors for those who see everyone, the caller's own otherwise
-- ---------------------------------------------------------------------------

-- A full copy of 20261207500000's body (the only definition) with one change, marked C6. Same signature, return type and grants.
create or replace function public.team_capacity(ws uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
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
    -- unlinked). Never provenance (it holds who entered it); `source` says entered or measured.
    'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
        'workspace_id', f.workspace_id, 'factor', f.factor,
        'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'))
        order by f.person_id, f.step_id nulls first)
      from public.person_capacity_factors f
      where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke execute on function public.team_capacity(uuid) from public, anon;
grant execute on function public.team_capacity(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Share links refuse per-person times
-- ---------------------------------------------------------------------------

-- A separate trigger, so B3's functions stay as they are. `share_links_before_write` raises its leak problems with
-- errcode 23514 and the problem as the message; this matches.
create function private.share_links_no_speeds() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- C6: no link carries anyone's per-person times, whatever its toggles (D20: only the person and owners and editors see them).
  if new.snapshot is not null and (
       jsonb_path_exists(new.snapshot, 'lax $.**.personCapacityFactors[*]')
    or jsonb_path_exists(new.snapshot, 'lax $.**.person_capacity_factors[*]')
    or jsonb_path_exists(new.snapshot, 'lax $.**.capacityFactor')) then
    raise exception 'The snapshot contains per-person times.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.share_links_no_speeds() from public, anon, authenticated;

create trigger share_links_no_speeds before insert or update of snapshot on public.share_links
  for each row execute function private.share_links_no_speeds();
