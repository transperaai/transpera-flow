-- A solution's status (capacity Q10, docs/plans/capacity/q10-issue-page-brief.md; decision D43): Idea, Testing, Works, Doesn't work or
-- Adopted, set by a person and shown as a pill on the Solution page and on each "Solutions tried" row of an issue.
--
-- What it does:
--   1. `solutions.status text not null default 'testing'`, checked against idea / testing / works / doesnt_work / adopted.
--      Backfill: `doesnt_work` where any of the solution's links has the user's verdict fail, `works` where it has links and every one
--      has the user's verdict pass, else `testing` (the default). The existing per-issue verdicts stay as they are, as detail.
--   2. `authenticated` may update `solutions.status` (a column grant beside name and notes); row-level security still decides who.
--   3. `issue_events.kind` also allows `solution_status`, and `private.solution_status_logged` (an after-update trigger on
--      `solutions.status`) writes one such event, detail `{solution_id, solution, from, to}`, on each issue the solution is linked to.
--   4. `public.save_fields`: a full copy of the 20270119000000 body with `solutions` added to the table list, so the status saves
--      with the same compare-and-set as the other fields. `EditableTable` in apps/web/src/lib/fields/server.ts is its twin.
--   `public.save_issue` and `public.import_workspace_bundle` are not redefined: save_issue does not touch solutions, and a restore
--   does not restore solutions (they need a published base version; see 20261207000000), so the new column rides in the backup bundle
--   (it exports whole rows) and nothing more is needed on the way in.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270128000000';` expect 0.
--     Locks: the column has a constant default (no rewrite); the check is validated against the existing rows.
-- Post-apply checks: select status, count(*) from public.solutions group by 1;
--
-- ROLLBACK (run as one transaction):
--
--   begin;
--   drop trigger if exists solution_status_logged on public.solutions;
--   drop function if exists private.solution_status_logged();
--   delete from public.issue_events where kind = 'solution_status';
--   alter table public.issue_events drop constraint issue_events_kind;
--   alter table public.issue_events add constraint issue_events_kind check (kind in ('created', 'edited', 'solution_tested', 'resolved', 'reopened'));
--   revoke update (status) on public.solutions from authenticated;
--   alter table public.solutions drop column status;
--   -- Restore the previous body: re-run `create or replace function public.save_fields ...` from 20270119000000_capacity_setup.sql.
--   delete from public.schema_migrations where version = '20270128000000';
--   commit;

-- An automated change, audited as the system's.
select set_config('transpera.actor_kind', 'system', true);

alter table public.solutions
  add column status text not null default 'testing' constraint solutions_status check (status in ('idea', 'testing', 'works', 'doesnt_work', 'adopted'));

update public.solutions s set status = 'doesnt_work'
  where exists (select 1 from public.solution_issues l where l.solution_id = s.id and l.user_verdict = 'fail');
update public.solutions s set status = 'works'
  where s.status = 'testing'
    and exists (select 1 from public.solution_issues l where l.solution_id = s.id)
    and not exists (select 1 from public.solution_issues l where l.solution_id = s.id and l.user_verdict is distinct from 'pass');

grant update (status) on public.solutions to authenticated;

alter table public.issue_events drop constraint issue_events_kind;
alter table public.issue_events add constraint issue_events_kind check (kind in ('created', 'edited', 'solution_tested', 'resolved', 'reopened', 'solution_status'));

create function private.solution_status_logged() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
    select l.issue_id, l.workspace_id, 'solution_status', auth.uid(),
      jsonb_build_object('solution_id', new.id, 'solution', new.name, 'from', old.status, 'to', new.status)
    from public.solution_issues l
    where l.solution_id = new.id and l.workspace_id = new.workspace_id;
  return null;
end;
$$;
revoke all on function private.solution_status_logged() from public, anon, authenticated;

create trigger solution_status_logged after update of status on public.solutions
  for each row when (new.status is distinct from old.status)
  execute function private.solution_status_logged();

-- Copied from 20270119000000_capacity_setup.sql (the latest to redefine it); the only change is `'solutions'` at the end of `editable`.
create or replace function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges', 'services',
    'lead_sources', 'seasonality', 'demand_settings', 'issues', 'sources', 'clients', 'client_assignments', 'service_servicing', 'client_groups',
    'departments', 'tiers', 'person_portfolio', 'solutions'];
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
