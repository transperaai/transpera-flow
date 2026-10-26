-- Solution page: resolve an issue with the solution that fixed it, and log your verdicts (issue #115, ticket A50 slice 1;
-- decisions D18, D24, D38).
--
-- A48 left "A solution fixed it" without saying which solution. This stores the pick and logs the verdicts a person gives
-- a solution on the solution page:
--
--   * `public.issues.resolved_solution_id`: the solution that fixed the issue, set only when `resolved_how` is 'solution'.
--     A composite foreign key (with the workspace) so it cannot cross workspaces; deleting the solution clears the pick
--     (`on delete set null (resolved_solution_id)`, so the workspace stays) and the history keeps its name. A check keeps
--     it null unless the issue was resolved by a solution. A new before-write trigger (`issues_resolved_solution`) clears
--     it whenever the issue is not resolved by a solution (reopened), and refuses a solution that is not linked to the
--     issue, for every writer, with a plain message.
--   * `public.resolve_issue(uuid, uuid, text, text, text, uuid)`: a NEW overload with a sixth argument, the solution. The
--     existing five-argument function is not touched, so the app deployed today keeps resolving issues between applying
--     this and deploying the new app. The new app calls the six-argument one only when a solution was picked.
--   * `private.log_issue_change` redefined as a copy of the 20261121500000 definition: a `resolved` entry's detail now also
--     carries `solution_id` and `solution` (the name, as it was then) when a solution fixed it.
--   * `private.solution_verdict_logged` and its trigger on `public.solution_issues`: when a person's verdict or note on a
--     solution changes, an `edited` entry is added to that issue's history, `{"solution_verdict": {solution_id, solution,
--     verdict, was, notes_changed}}`. The notes themselves are not copied into the history. (No new event kind: the
--     `issue_events_kind` check is not widened.)
--
-- STRICTLY ADDITIVE: one nullable column with its constraints, one overload, one new trigger on `issues`, one on
-- `solution_issues`, two new trigger functions, and one function redefined with extra detail. No existing signature,
-- column, constraint or status value changes; the old app keeps working before and after the apply.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the app. The app's ISSUE_COLUMNS selects `resolved_solution_id`, so
-- an app deployed first fails every issue load. Rolling this back AFTER the app is deployed breaks issue loads the same
-- way: roll the app back first (or at the same time).
--
-- Preflight (run first, each should be as described):
--   1. The column does not exist yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'issues' and column_name = 'resolved_solution_id';
--   2. A48 and A49 are applied. Expect 2:
--        select count(*) from supabase_migrations.schema_migrations where version in ('20261121500000', '20261122000000');
--   3. This one is not applied. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261125000000';
--   4. The five-argument resolve_issue exists and the six-argument one does not. Expect 1, then 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_issue' and pronargs = 5;
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_issue' and pronargs = 6;
--   5. Postgres is 15 or later (`on delete set null (column)` needs it). Expect true:
--        select current_setting('server_version_num')::int >= 150000;
--   6. private.log_issue_change is still A48's version, the one this migration copies and the rollback restores. Expect e3c4a1341119b086f90da1414f467edc:
--        select md5(prosrc) from pg_proc where pronamespace = 'private'::regnamespace and proname = 'log_issue_change';
--   7. Nothing this migration creates exists yet. Expect 0 rows from each:
--        select tgname from pg_trigger where tgname in ('issues_resolved_solution', 'solution_verdict_logged') and not tgisinternal;
--        select proname from pg_proc where pronamespace = 'private'::regnamespace and proname in ('issues_resolved_solution_before_write', 'solution_verdict_logged');
--        select conname from pg_constraint where conname in ('issues_resolved_solution_fkey', 'issues_resolved_solution_check');
--        select indexname from pg_indexes where schemaname = 'public' and indexname = 'issues_resolved_solution_idx';
--
-- Unlinking: removing the link between a solution and an issue AFTER the issue was resolved by that solution does not clear the
-- pick. The issue still says which solution fixed it (the link rows are only the test results; deleting the solution itself does
-- clear the pick, and the history keeps the name). Changing the pick of an issue that is already resolved is refused: reopen it first.
--
-- Post-apply check:
--   1. The column exists. Expect 1 row:
--        select column_name from information_schema.columns where table_schema = 'public' and table_name = 'issues' and column_name = 'resolved_solution_id';
--   2. Both resolve_issue overloads exist. Expect 5 and 6:
--        select pronargs from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_issue' order by 1;
--   3. Only authenticated may run them (anon and public nothing). Expect 2 rows, both authenticated:
--        select grantee, specific_name from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'resolve_issue' and grantee in ('anon', 'public', 'authenticated');
--   4. The two triggers exist. Expect 2 rows:
--        select tgname from pg_trigger where tgname in ('issues_resolved_solution', 'solution_verdict_logged') and not tgisinternal;
--
-- Rollback (run as one transaction; it loses which solution fixed each issue, and the log entries keep their detail):
--
--   begin;
--   drop trigger if exists solution_verdict_logged on public.solution_issues;
--   drop function if exists private.solution_verdict_logged();
--   drop function if exists public.resolve_issue(uuid, uuid, text, text, text, uuid);
--   drop trigger if exists issues_resolved_solution on public.issues;
--   drop function if exists private.issues_resolved_solution_before_write();
--   -- put back A48's private.log_issue_change() (from 20261121500000_issue_resolution.sql) in full, BEFORE dropping the column:
--   create or replace function private.log_issue_change() returns trigger
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     fields text[];
--     ui_old text;
--     ui_new text;
--   begin
--     if tg_op = 'INSERT' then
--       -- A dismissed insight is not an issue: nothing to log until it is acknowledged.
--       if new.status <> 'dismissed' then
--         insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
--           values (new.id, new.workspace_id, 'created', auth.uid(), jsonb_build_object('status', private.issue_ui_status(new.status, new.resolution)));
--       end if;
--       return null;
--     end if;
--     if old.status = 'dismissed' then
--       -- Dismissed again (a new revision), or acknowledged: the issue is born now.
--       if new.status <> 'dismissed' then
--         insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
--           values (new.id, new.workspace_id, 'created',
--             auth.uid(), jsonb_build_object('status', private.issue_ui_status(new.status, new.resolution), 'acknowledged', true));
--       end if;
--       return null;
--     end if;
--
--     -- process_id, step_id and owner_person_id mirror the link tables, which log their own changes.
--     select coalesce(array_agg(f order by f), '{}') into fields from (
--       select 'title' f where new.title is distinct from old.title
--       union all select 'type' where new.type is distinct from old.type
--       union all select 'severity' where new.severity is distinct from old.severity
--       union all select 'evidence' where new.evidence is distinct from old.evidence
--       union all select 'scenario_id' where new.scenario_id is distinct from old.scenario_id
--       union all select 'role_id' where new.role_id is distinct from old.role_id
--       union all select 'person_id' where new.person_id is distinct from old.person_id
--       union all select 'client_id' where new.client_id is distinct from old.client_id
--       union all select 'target_measure' where new.target_measure is distinct from old.target_measure
--       union all select 'target_now' where new.target_now is distinct from old.target_now
--       union all select 'target_goal' where new.target_goal is distinct from old.target_goal
--     ) changed;
--
--     ui_old := private.issue_ui_status(old.status, old.resolution);
--     ui_new := private.issue_ui_status(new.status, new.resolution);
--     if ui_new is distinct from ui_old then
--       insert into public.issue_events (issue_id, workspace_id, kind, actor, detail) values (
--         new.id, new.workspace_id,
--         case
--           when ui_new = 'testing' and ui_old = 'open' then 'solution_tested'
--           when ui_new in ('resolved', 'wont_fix') and ui_old not in ('resolved', 'wont_fix') then 'resolved'
--           when ui_old in ('resolved', 'wont_fix') and ui_new in ('open', 'testing') then 'reopened'
--           else 'edited'
--         end,
--         auth.uid(),
--         jsonb_build_object('from', ui_old, 'to', ui_new)
--           || case when ui_new in ('resolved', 'wont_fix') and ui_old not in ('resolved', 'wont_fix')
--                then jsonb_strip_nulls(jsonb_build_object('how', new.resolved_how, 'note', new.resolution_note)) else '{}'::jsonb end);
--     end if;
--     if cardinality(fields) > 0 then
--       insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
--         values (new.id, new.workspace_id, 'edited', auth.uid(), jsonb_build_object('fields', to_jsonb(fields)));
--     end if;
--     return null;
--   end;
--   $$;
--   -- then drop the column (its foreign key and check go with it):
--   drop index if exists public.issues_resolved_solution_idx;
--   alter table public.issues drop constraint if exists issues_resolved_solution_check, drop constraint if exists issues_resolved_solution_fkey,
--     drop column if exists resolved_solution_id;
--   delete from supabase_migrations.schema_migrations where version = '20261125000000';
--   commit;
--
-- Production data: none needed (no resolved issue has a solution picked yet).

alter table public.issues add column resolved_solution_id uuid;

-- With the workspace, so the solution must be in the issue's workspace; on delete only the pick is cleared (workspace_id is
-- not nullable). The solutions table already has unique (id, workspace_id).
alter table public.issues
  add constraint issues_resolved_solution_fkey foreign key (resolved_solution_id, workspace_id)
    references public.solutions (id, workspace_id) on delete set null (resolved_solution_id),
  add constraint issues_resolved_solution_check check (resolved_solution_id is null or resolved_how = 'solution');

-- Deleting a solution looks up the issues that name it (to clear the pick): without this that is a scan of issues.
create index issues_resolved_solution_idx on public.issues (resolved_solution_id) where resolved_solution_id is not null;

-- Not resolved by a solution (open, reopened, resolved another way): nothing to record. Named to run after
-- `issues_resolved_how` (before triggers run in name order), which clears `resolved_how` first. A solution that is not linked
-- to the issue is refused, whoever writes it. Security definer so it can read the link whatever the caller can see.
create function private.issues_resolved_solution_before_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'done' or new.resolved_how is distinct from 'solution' then
    new.resolved_solution_id := null;
  end if;
  if new.resolved_solution_id is null or (tg_op = 'UPDATE' and new.resolved_solution_id is not distinct from old.resolved_solution_id) then
    return new;
  end if;
  -- This runs before row-level security and reads across the link table, so it must say nothing to someone who can't edit the
  -- workspace: they are let through here and row-level security refuses the write with its own plain error.
  -- A request role is held to this even when its token has no user (`auth.uid()` null); only a trusted connection (service_role,
  -- postgres, a migration or test session) goes on to the check. `role` is the role the session switched to: current_user is the
  -- function's owner inside a security definer function.
  if (auth.uid() is not null or coalesce(current_setting('role', true), '') in ('authenticated', 'anon'))
    and not coalesce(public.can_edit_workspace(new.workspace_id), false) then
    return new;
  end if;
  -- Once resolved, the pick stays as it was. (Clearing it, as deleting the solution does, is allowed.) Reopen to change it.
  if tg_op = 'UPDATE' and old.status = 'done' then
    raise exception 'issues: the solution that fixed a resolved issue can''t be changed. Reopen the issue first.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.solution_issues l
    where l.solution_id = new.resolved_solution_id and l.issue_id = new.id and l.workspace_id = new.workspace_id
  ) then
    raise exception 'issues: that solution is not linked to this issue' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.issues_resolved_solution_before_write() from public, anon, authenticated;

create trigger issues_resolved_solution before insert or update on public.issues
  for each row execute function private.issues_resolved_solution_before_write();

create or replace function private.log_issue_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fields text[];
  ui_old text;
  ui_new text;
begin
  if tg_op = 'INSERT' then
    -- A dismissed insight is not an issue: nothing to log until it is acknowledged.
    if new.status <> 'dismissed' then
      insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
        values (new.id, new.workspace_id, 'created', auth.uid(), jsonb_build_object('status', private.issue_ui_status(new.status, new.resolution)));
    end if;
    return null;
  end if;
  if old.status = 'dismissed' then
    -- Dismissed again (a new revision), or acknowledged: the issue is born now.
    if new.status <> 'dismissed' then
      insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
        values (new.id, new.workspace_id, 'created',
          auth.uid(), jsonb_build_object('status', private.issue_ui_status(new.status, new.resolution), 'acknowledged', true));
    end if;
    return null;
  end if;

  -- process_id, step_id and owner_person_id mirror the link tables, which log their own changes.
  select coalesce(array_agg(f order by f), '{}') into fields from (
    select 'title' f where new.title is distinct from old.title
    union all select 'type' where new.type is distinct from old.type
    union all select 'severity' where new.severity is distinct from old.severity
    union all select 'evidence' where new.evidence is distinct from old.evidence
    union all select 'scenario_id' where new.scenario_id is distinct from old.scenario_id
    union all select 'role_id' where new.role_id is distinct from old.role_id
    union all select 'person_id' where new.person_id is distinct from old.person_id
    union all select 'client_id' where new.client_id is distinct from old.client_id
    union all select 'target_measure' where new.target_measure is distinct from old.target_measure
    union all select 'target_now' where new.target_now is distinct from old.target_now
    union all select 'target_goal' where new.target_goal is distinct from old.target_goal
  ) changed;

  ui_old := private.issue_ui_status(old.status, old.resolution);
  ui_new := private.issue_ui_status(new.status, new.resolution);
  if ui_new is distinct from ui_old then
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail) values (
      new.id, new.workspace_id,
      case
        when ui_new = 'testing' and ui_old = 'open' then 'solution_tested'
        when ui_new in ('resolved', 'wont_fix') and ui_old not in ('resolved', 'wont_fix') then 'resolved'
        when ui_old in ('resolved', 'wont_fix') and ui_new in ('open', 'testing') then 'reopened'
        else 'edited'
      end,
      auth.uid(),
      jsonb_build_object('from', ui_old, 'to', ui_new)
        || case when ui_new in ('resolved', 'wont_fix') and ui_old not in ('resolved', 'wont_fix')
             then jsonb_strip_nulls(jsonb_build_object('how', new.resolved_how, 'note', new.resolution_note,
               'solution_id', new.resolved_solution_id,
               'solution', (select s.name from public.solutions s where s.id = new.resolved_solution_id and s.workspace_id = new.workspace_id)))
             else '{}'::jsonb end);
  end if;
  if cardinality(fields) > 0 then
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
      values (new.id, new.workspace_id, 'edited', auth.uid(), jsonb_build_object('fields', to_jsonb(fields)));
  end if;
  return null;
end;
$$;

-- Mark an issue resolved with how, a note and (when a solution fixed it) which solution, in one write (so one history
-- entry). Security invoker, as the five-argument one: row-level security applies and the caller must be able to edit the
-- workspace. A new overload, not a change: the five-argument function is left as it is. `p_solution` has no default, so a
-- call with five named arguments still finds only the old function.
create function public.resolve_issue(p_workspace uuid, p_id uuid, p_how text, p_note text, p_status text, p_solution uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result jsonb;
  v_status text;
begin
  if not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'resolve_issue: you cannot change issues in this workspace' using errcode = '42501';
  end if;
  if p_how is null or p_how not in ('solution', 'process_change', 'not_a_problem') then
    raise exception 'resolve_issue: how must be solution, process_change or not_a_problem' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('resolved', 'wont_fix') then
    raise exception 'resolve_issue: status must be resolved or wont_fix' using errcode = '22023';
  end if;
  if p_solution is not null and p_how <> 'solution' then
    raise exception 'resolve_issue: a solution can only be named when a solution fixed it' using errcode = '22023';
  end if;
  if p_solution is not null and p_status = 'wont_fix' then
    raise exception 'resolve_issue: an issue marked won''t fix wasn''t fixed by a solution' using errcode = '22023';
  end if;
  select i.status into v_status from public.issues i where i.id = p_id and i.workspace_id = p_workspace for update;
  if v_status is null or v_status = 'dismissed' then
    raise exception 'resolve_issue: no such issue' using errcode = '42501';
  end if;
  if v_status = 'done' then
    raise exception 'resolve_issue: that issue is already resolved' using errcode = '22023';
  end if;
  if p_solution is not null and not exists (
    select 1 from public.solution_issues l where l.solution_id = p_solution and l.issue_id = p_id and l.workspace_id = p_workspace
  ) then
    raise exception 'resolve_issue: that solution is not linked to this issue' using errcode = '22023';
  end if;
  update public.issues
    set status = 'done',
        resolution = case when p_status = 'wont_fix' then 'wont_fix' end,
        resolved_how = p_how,
        resolved_solution_id = p_solution,
        resolution_note = nullif(btrim(p_note), '')
    where id = p_id and workspace_id = p_workspace;
  select to_jsonb(i) into result from public.issues i where i.id = p_id;
  return result;
end;
$$;

revoke all on function public.resolve_issue(uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.resolve_issue(uuid, uuid, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Your verdict and notes on a solution are logged on the issue's history
-- ---------------------------------------------------------------------------

create function private.solution_verdict_logged() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  st text;
  sol_name text;
begin
  select i.status into st from public.issues i where i.id = new.issue_id and i.workspace_id = new.workspace_id;
  -- A dismissed insight is not an issue: nothing to log.
  if st is null or st = 'dismissed' then
    return null;
  end if;
  select s.name into sol_name from public.solutions s where s.id = new.solution_id and s.workspace_id = new.workspace_id;
  insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
    values (new.issue_id, new.workspace_id, 'edited', auth.uid(), jsonb_build_object('solution_verdict', jsonb_build_object(
      'solution_id', new.solution_id, 'solution', sol_name, 'verdict', new.user_verdict, 'was', old.user_verdict,
      'notes_changed', new.user_notes is distinct from old.user_notes)));
  return null;
end;
$$;
revoke all on function private.solution_verdict_logged() from public, anon, authenticated;

create trigger solution_verdict_logged after update of user_verdict, user_notes on public.solution_issues
  for each row when (new.user_verdict is distinct from old.user_verdict or new.user_notes is distinct from old.user_notes)
  execute function private.solution_verdict_logged();
