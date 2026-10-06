-- Per-person privacy in the database (issue #30, B1 part 2 of 3, slice 2a; docs/plans/b1-brief.md).
--
-- Until now every reader of a workspace reads every person: names, emails, notes, pay, leave, skills and client
-- assignments. Austin's decision of 6 Oct (option A'): agency admins, `agency_admin` members, owners and editors see every
-- person as before. Members and viewers see their OWN person's rows (when their membership is linked to a person), and get
-- the whole team's simulation inputs only through `public.team_capacity`, under neutral labels ("Team member 3") with each
-- cost rate replaced by the average for the person's role. Their simulated numbers are otherwise the same as an editor's.
--
-- Additive, except that nine select policies are dropped and re-created under the same names, and `public.revision_history`
-- is replaced (same signature, result columns and grants). It does NOT touch `save_fields`, any insert, update or delete
-- policy, or any grant on a table.
--
--   * `public.can_see_people(ws)` (SECURITY INVOKER): `can_edit_workspace(ws)`.
--   * `public.can_see_person(ws, person)` (SECURITY INVOKER): `can_see_people(ws)`, or `person` is the caller's own person
--     (`my_person_id(ws)`, from 20261206000000). Reused later by C2 for its per-person factors table: keep name and signature.
--   * Select policies (same names): `people`, `person_roles`, `person_skills`, `person_leave`, `client_assignments` use
--     `can_see_person`; `runs` and `robustness_results` use `can_see_people` (only owners and editors read saved runs);
--     `suggestions` hides a suggestion about a person (`target_table = 'people'`) from those who can't see that person;
--     `ai_runs` (which stores the name of whoever ran an analysis) is read by those who see people, or by the runner.
--   * `public.team_capacity(ws) returns jsonb` (SECURITY DEFINER, empty search_path): the one way a caller gets the whole
--     team's simulation inputs. It raises 42501 unless the caller can read `ws`. Callers who see everyone get the stored
--     values. Everyone else gets: the caller's own person under their real name and every other person as
--     'Team member N' (N = rank by (created_at, id) over ALL people, active or not, so labels are stable); `provenance` {};
--     and cost rates replaced by hours-weighted role averages (a role is averaged only when at least 3 rated, active people
--     hold it; otherwise the workspace average, again only with at least 3; otherwise null, and the engine then uses the
--     role's default rate). A person with no rate of their own stays null. Never returned: email, notes, a leave note,
--     person_skills.efficiency and person_skills.provenance. Ids are the real ids.
--     Shape: { sees_everyone, own_person_id,
--              people: [{id, workspace_id, name, fte, capacity_hours_week, cost_rate, active, start_date, end_date, provenance}],
--              person_roles: [{person_id, role_id, workspace_id}], person_skills: [{person_id, step_id, workspace_id}],
--              person_leave: [{id, person_id, workspace_id, start_date, end_date}],
--              client_assignments: [{client_id, role_id, person_id, workspace_id}] }
--   * `public.revision_history`: a full copy of 20261127500000's, with one change (marked B1 (2/3)): the author's person name
--     shows only to those who can see that person, so a member sees null (the app says "A team member") for others' versions.
--
-- KNOWN LIMIT, accepted by Austin: a member using browser dev tools can still read anonymous hours and leave dates (that is
-- what simulating in the browser needs). A per-workspace "no simulated numbers for members" setting (option C) is a
-- possible follow-up.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--   0. Row 53 applied, nothing at or after this version. Expect 20261206000000 (and 20261207000000 if B10 2b went first),
--      nothing >= 20261207500000:
--        select version from supabase_migrations.schema_migrations where version >= '20261206000000' order by 1;
--   1. my_person_id exists; nothing of this migration does. Expect not null, null, null, null:
--        select to_regprocedure('public.my_person_id(uuid)'), to_regprocedure('public.can_see_people(uuid)'),
--               to_regprocedure('public.can_see_person(uuid, uuid)'), to_regprocedure('public.team_capacity(uuid)');
--   2. revision_history is 20261127500000's. Expect one row: true, true
--        select pg_get_function_result(oid) like '%note text%', prosrc not like '%can_see_person%'
--        from pg_proc where pronamespace = 'public'::regnamespace and proname = 'revision_history';
--   3. The nine select policies are as this migration expects. Expect 9 rows, each qual public.can_read_workspace(workspace_id) / can_read_workspace(workspace_id):
--        select tablename, policyname, qual from pg_policies
--        where schemaname = 'public' and cmd = 'SELECT' and (tablename, policyname) in (
--          ('people', 'read people'), ('person_roles', 'read person_roles'), ('person_skills', 'read person_skills'),
--          ('person_leave', 'read person_leave'), ('client_assignments', 'read client_assignments'), ('runs', 'read runs'),
--          ('robustness_results', 'read robustness results'), ('suggestions', 'read suggestions'), ('ai_runs', 'read ai_runs'))
--        order by 1;
--   4. No person is linked to two active memberships (1/3 enforces it in setMemberPerson, not the database). Expect no rows;
--      if any, two people would see the same record: unlink one on Settings -> Access before applying.
--        select workspace_id, person_id, count(*) from public.memberships
--        where person_id is not null and active group by 1, 2 having count(*) > 1;
--   5. For the log: members and viewers who will see their own record, per workspace.
--        select w.slug, count(*) filter (where m.person_id is not null) as linked, count(*) as members_and_viewers
--        from public.workspaces w join public.memberships m on m.workspace_id = w.id
--        where m.active and m.role in ('member', 'viewer') group by 1 order by 1;
--
-- POST-APPLY CHECK:
--   - Re-run preflight 3: the five per-person tables and `suggestions` now mention can_see_person; `runs`,
--     `robustness_results` and `ai_runs` mention can_see_people.
--   - select proname, prosecdef, proconfig from pg_proc where proname in ('can_see_people', 'can_see_person',
--     'team_capacity', 'revision_history');  -- prosecdef false, false, true, true; {search_path=""} on all four.
--   - has_function_privilege('authenticated', f, 'execute') true and has_function_privilege('anon', f, 'execute') false for
--     public.can_see_people(uuid), public.can_see_person(uuid, uuid) and public.team_capacity(uuid).
--   - select prosrc like '%can_see_person%' from pg_proc where proname = 'revision_history';  -- true
--   - Smoke test, rolled back. Production Northbeam has no owner, so act as an agency admin (any user id; the flag is in
--     the claims):
--       begin; set local role authenticated;
--       select set_config('request.jwt.claims', '{"sub":"<user id>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);
--       select (public.team_capacity('<northbeam id>') ->> 'sees_everyone'), jsonb_array_length(public.team_capacity('<northbeam id>') -> 'people');
--       rollback;
--     Expect true and Northbeam's head count.
--
-- Rollback (run as one transaction):
--   begin;
--     drop policy "read people" on public.people;
--     create policy "read people" on public.people for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read person_roles" on public.person_roles;
--     create policy "read person_roles" on public.person_roles for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read person_skills" on public.person_skills;
--     create policy "read person_skills" on public.person_skills for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read person_leave" on public.person_leave;
--     create policy "read person_leave" on public.person_leave for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read client_assignments" on public.client_assignments;
--     create policy "read client_assignments" on public.client_assignments for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read runs" on public.runs;
--     create policy "read runs" on public.runs for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read robustness results" on public.robustness_results;
--     create policy "read robustness results" on public.robustness_results for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read suggestions" on public.suggestions;
--     create policy "read suggestions" on public.suggestions for select to authenticated using (public.can_read_workspace(workspace_id));
--     drop policy "read ai_runs" on public.ai_runs;
--     create policy "read ai_runs" on public.ai_runs for select to authenticated using (public.can_read_workspace(workspace_id));
--     -- revision_history: re-run the `create function public.revision_history ... $$;` block from
--     -- 20261127500000_company_map_editing.sql with `create` changed to `create or replace` (same signature, grants kept)
--     drop function public.team_capacity(uuid);
--     drop function public.can_see_person(uuid, uuid);
--     drop function public.can_see_people(uuid);
--     delete from supabase_migrations.schema_migrations where version = '20261207500000';
--   commit;

-- 1. Helpers

create function public.can_see_people(ws uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select public.can_edit_workspace(ws);
$$;

create function public.can_see_person(ws uuid, person uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select public.can_see_people(ws) or (person is not null and person = public.my_person_id(ws));
$$;

revoke execute on function public.can_see_people(uuid), public.can_see_person(uuid, uuid) from public, anon;
grant execute on function public.can_see_people(uuid), public.can_see_person(uuid, uuid) to authenticated;

-- 2. Select policies

drop policy "read people" on public.people;
create policy "read people" on public.people for select to authenticated
  using (public.can_see_person(workspace_id, id));

drop policy "read person_roles" on public.person_roles;
create policy "read person_roles" on public.person_roles for select to authenticated
  using (public.can_see_person(workspace_id, person_id));

drop policy "read person_skills" on public.person_skills;
create policy "read person_skills" on public.person_skills for select to authenticated
  using (public.can_see_person(workspace_id, person_id));

drop policy "read person_leave" on public.person_leave;
create policy "read person_leave" on public.person_leave for select to authenticated
  using (public.can_see_person(workspace_id, person_id));

drop policy "read client_assignments" on public.client_assignments;
create policy "read client_assignments" on public.client_assignments for select to authenticated
  using (public.can_see_person(workspace_id, person_id));

drop policy "read runs" on public.runs;
create policy "read runs" on public.runs for select to authenticated
  using (public.can_see_people(workspace_id));

drop policy "read robustness results" on public.robustness_results;
create policy "read robustness results" on public.robustness_results for select to authenticated
  using (public.can_see_people(workspace_id));

-- A suggestion about a person is a change to one person (a new person has a null target_id, which only editors see).
drop policy "read suggestions" on public.suggestions;
create policy "read suggestions" on public.suggestions for select to authenticated
  using (public.can_read_workspace(workspace_id)
         and (target_table <> 'people' or public.can_see_person(workspace_id, target_id)));

-- user_name is a stored copy of the name of whoever ran an analysis.
drop policy "read ai_runs" on public.ai_runs;
create policy "read ai_runs" on public.ai_runs for select to authenticated
  using (public.can_read_workspace(workspace_id)
         and (public.can_see_people(workspace_id) or user_id = auth.uid()));

-- 3. team_capacity

create function public.team_capacity(ws uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  everyone boolean;
  own uuid;
  week numeric;
  result jsonb;
begin
  if ws is null or not public.can_read_workspace(ws) then
    raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
  end if;
  everyone := public.can_see_people(ws);
  own := public.my_person_id(ws);
  select case when jsonb_typeof(w.settings -> 'hours_per_week') = 'number' then (w.settings ->> 'hours_per_week')::numeric end
    into week from public.workspaces w where w.id = ws;
  week := coalesce(week, 40);

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
           pe.end_date, pe.provenance,
           coalesce(pe.capacity_hours_week, pe.fte * week) as hours,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  held as (
    select r.person_id, r.role_id, count(*) over (partition by r.person_id) as roles_held
    from public.person_roles r where r.workspace_id = ws
  ),
  pool as (
    select h.role_id, p.id, p.cost_rate, p.hours / h.roles_held as weight
    from p join held h on h.person_id = p.id
    where p.active and p.cost_rate is not null
  ),
  role_rate as (
    select pool.role_id,
           coalesce(sum(pool.cost_rate * pool.weight) / nullif(sum(pool.weight), 0), avg(pool.cost_rate)) as rate
    from pool group by pool.role_id
    having count(distinct pool.id) >= 3
  ),
  ws_rate as (
    select coalesce(sum(p.cost_rate * p.hours) / nullif(sum(p.hours), 0), avg(p.cost_rate)) as rate
    from p where p.active and p.cost_rate is not null
    having count(*) >= 3
  ),
  shown as (
    select p.*,
      case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
      case
        when everyone then p.cost_rate
        when p.cost_rate is null then null
        else round(coalesce(
          (select avg(rr.rate) from held h join role_rate rr on rr.role_id = h.role_id where h.person_id = p.id),
          (select ws_rate.rate from ws_rate)), 4)
      end as shown_rate
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
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke execute on function public.team_capacity(uuid) from public, anon;
grant execute on function public.team_capacity(uuid) to authenticated;

-- 4. revision_history

-- A full copy of 20261127500000's, changed on the author line only (B1 (2/3)). Dropped and re-created as that migration did,
-- so the same signature, result columns and grants hold.
drop function public.revision_history(uuid);

create function public.revision_history(target_process uuid)
returns table (
  revision_id uuid,
  number integer,
  status text,
  published_at timestamptz,
  author_kind text,
  author_name text,
  changes jsonb,
  note text
)
language sql stable security definer
set search_path = ''
as $$
  select
    r.id,
    r.number,
    r.status,
    r.published_at,
    a.actor_kind,
    -- B1 (2/3): a person's name only to those who can see that person.
    coalesce(case when public.can_see_person(r.workspace_id, per.id) then per.name end,
             case when public.can_manage_workspace(r.workspace_id) then u.email end),
    -- Against the published version before it; none for the first.
    case when prev.id is not null then private.revision_change_counts(prev.id, r.id) end,
    a.note
  from public.processes p
  join public.process_revisions r on r.process_id = p.id
  left join auth.users u on u.id = r.published_by
  left join public.memberships m on m.user_id = r.published_by and m.workspace_id = r.workspace_id
  left join public.people per on per.id = m.person_id and per.workspace_id = r.workspace_id
  left join lateral (
    select l.actor_kind, l.diff ->> 'note' as note
    from public.audit_log l
    where l.workspace_id = r.workspace_id
      and l.target_table = 'processes' and l.target_id = p.id and l.action = 'publish' and l.diff ->> 'revision_id' = r.id::text
    order by l.created_at desc
    limit 1
  ) a on true
  left join lateral (
    select q.id from public.process_revisions q
    where q.process_id = p.id and q.status in ('published', 'superseded') and q.number < r.number
    order by q.number desc
    limit 1
  ) prev on true
  where p.id = target_process
    and public.can_read_workspace(p.workspace_id)
    and r.status in ('published', 'superseded')
  order by r.number desc;
$$;

revoke execute on function public.revision_history(uuid) from public, anon;
grant execute on function public.revision_history(uuid) to authenticated;
