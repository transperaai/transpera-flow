-- Issues pages: how an issue was resolved, and a note (issue #113, A48).
--
-- A resolved issue records how it was resolved ('solution': a solution fixed it; 'process_change': we changed the
-- process directly; 'not_a_problem': no longer a problem) and a note. `issue_events.detail` is written only by the
-- log trigger, so it cannot hold them from the app: they are two new nullable columns on `issues`, and the trigger
-- that logs a `resolved` event copies them into that event's detail (`how`, `note`), so the history keeps them after
-- the issue is reopened.
--
-- Strictly additive: two nullable columns, a new before-write trigger, a new function, and `private.log_issue_change`
-- redefined (a copy of the 20261120000000 definition, the only change being `how` and `note` in a resolved entry's
-- detail). `save_issue` and `save_fields` are not redefined: resolving goes through the new `public.resolve_issue`,
-- and reopening through the existing `save_issue` (status 'open'), which clears the two columns.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the app. The app's ISSUE_COLUMNS selects `resolved_how` and
-- `resolution_note`, so an app deployed first fails every issue load. Rolling this back AFTER the app is deployed breaks
-- issue loads the same way: roll the app back first (or at the same time).
--
-- Preflight (run first, each should be as described):
--   1. The columns do not exist yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'issues' and column_name in ('resolved_how', 'resolution_note');
--   2. Nothing of ours is applied past 20261120000000. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261121500000';
--
-- Rollback (run as one transaction; loses the recorded how and note on current rows, and the log entries keep theirs):
--
--   begin;
--   drop function if exists public.resolve_issue(uuid, uuid, text, text, text);
--   drop trigger if exists issues_resolved_how on public.issues;
--   drop function if exists private.issues_resolved_how_before_write();
--   -- put back A47's private.log_issue_change() (below, from 20261120000000_issues_v2.sql) BEFORE dropping the columns:
--   -- the version in this migration reads new.resolved_how, so with the columns gone every status change would fail.
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
--         auth.uid(), jsonb_build_object('from', ui_old, 'to', ui_new));
--     end if;
--     if cardinality(fields) > 0 then
--       insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
--         values (new.id, new.workspace_id, 'edited', auth.uid(), jsonb_build_object('fields', to_jsonb(fields)));
--     end if;
--     return null;
--   end;
--   $$;
--   -- then drop the columns:
--   alter table public.issues drop constraint if exists issues_resolved_how_check, drop constraint if exists issues_resolution_note_length,
--     drop column resolved_how, drop column resolution_note;
--   delete from supabase_migrations.schema_migrations where version = '20261121500000';
--   commit;

alter table public.issues
  add column resolved_how text,
  add column resolution_note text,
  add constraint issues_resolved_how_check check (resolved_how in ('solution', 'process_change', 'not_a_problem')),
  add constraint issues_resolution_note_length check (char_length(resolution_note) <= 2000);

-- Reopened (or never resolved): nothing to record. Named to run after `issues_number`; the log trigger is an AFTER
-- trigger, so it sees the values as stored.
create function private.issues_resolved_how_before_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'done' then
    new.resolved_how := null;
    new.resolution_note := null;
  end if;
  return new;
end;
$$;
revoke all on function private.issues_resolved_how_before_write() from public, anon, authenticated;

create trigger issues_resolved_how before insert or update on public.issues
  for each row execute function private.issues_resolved_how_before_write();

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
             then jsonb_strip_nulls(jsonb_build_object('how', new.resolved_how, 'note', new.resolution_note)) else '{}'::jsonb end);
  end if;
  if cardinality(fields) > 0 then
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
      values (new.id, new.workspace_id, 'edited', auth.uid(), jsonb_build_object('fields', to_jsonb(fields)));
  end if;
  return null;
end;
$$;

-- Mark an issue resolved with how and a note, in one write (so one history entry). Security invoker: row-level security
-- applies, and the caller must be able to edit the workspace. `p_status` is 'resolved' or 'wont_fix' as shown.
create function public.resolve_issue(p_workspace uuid, p_id uuid, p_how text, p_note text default null, p_status text default 'resolved')
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
  -- One locked read for both checks: two people resolving at the same moment take turns, so the second sees `done`.
  select i.status into v_status from public.issues i where i.id = p_id and i.workspace_id = p_workspace for update;
  if v_status is null or v_status = 'dismissed' then
    raise exception 'resolve_issue: no such issue' using errcode = '42501';
  end if;
  if v_status = 'done' then
    raise exception 'resolve_issue: that issue is already resolved' using errcode = '22023';
  end if;
  update public.issues
    set status = 'done',
        resolution = case when p_status = 'wont_fix' then 'wont_fix' end,
        resolved_how = p_how,
        resolution_note = nullif(btrim(p_note), '')
    where id = p_id and workspace_id = p_workspace;
  select to_jsonb(i) into result from public.issues i where i.id = p_id;
  return result;
end;
$$;

revoke all on function public.resolve_issue(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.resolve_issue(uuid, uuid, text, text, text) to authenticated;
