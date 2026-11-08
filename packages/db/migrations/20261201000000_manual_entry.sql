-- Everything can be added by hand, part 1 (issue #182, B19 1/2; PRD D27 and D42): clients one by one, deleting a solution,
-- and the workspace's name and currency.
--
-- The tables already exist (`clients`, `client_services`, `client_assignments` from 20261012000000; `solutions` and
-- `solution_issues` from 20261122000000), and their row-level security already lets owners and editors write and stops
-- viewers. What was missing, and what this adds:
--
--   * `private.never_delete_clients` and the trigger `never_delete_clients` (before delete on `public.clients`): a client is
--     never deleted by anyone signed in (`authenticated` or `anon`, so the app and the MCP server alike). A client who
--     leaves is marked inactive: hidden in the app and left out of simulations, with their record kept (the standing rule,
--     PRD D42). Deleting the whole workspace still takes its clients with it (the cascade runs as the table owner, and the
--     workspace is gone by then), as does anything the operator does with the service role.
--   * `private.log_solution_delete` and the trigger `log_solution_delete` (before delete on `public.solutions`): deleting a
--     solution writes one `audit_log` row (action `delete`, target `solutions`) with the solution's name, process, base
--     version, lever changes and every issue link it had (verdicts, how often it held, notes), and adds an `edited` entry
--     `{"solution_deleted": {solution_id, solution}}` to the history of each issue it was linked to. An issue in Testing
--     solutions (stored `in_progress`) that this leaves with no solution linked goes back to Open; its history gets ONE
--     entry, the status change `issue_log` writes with `solution_deleted` folded into its detail. Resolved and won't-fix
--     issues, and issues still linked to another solution, keep their status. The links themselves still go with the
--     solution (`on delete cascade`); the copy of the map is not kept in the log. Nothing is logged when the workspace
--     itself is being deleted.
--   * Two checks on `public.workspaces`, added NOT VALID (existing rows are not re-checked; the preflight shows there are
--     none to fix): the name is 1 to 200 characters once trimmed, and `settings.currency`, when set, is a three-letter code
--     such as AUD, as `create_workspace` already insists. An owner can now change both from Settings, through `save_fields`
--     (which already accepts `workspaces`; row-level security limits workspace updates to owners and agency admins).
--
-- STRICTLY ADDITIVE: two trigger functions, two triggers and two NOT VALID check constraints. No table, column, policy,
-- grant or existing function changes. Data: none to move.
--
-- ORDER: apply after 20261130500000 (row 48 of docs/production-migrations.md).
--
-- PREFLIGHT (read-only; each must return the stated result before applying):
--   0. The migration before this one is applied. Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261130500000';
--   1. Nothing later is applied. Expect 0:
--        select count(*) from supabase_migrations.schema_migrations where version >= '20261201000000';
--   2. The tables this builds on exist. Expect 5:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('clients', 'solutions', 'solution_issues', 'issue_events', 'audit_log');
--   3. Nothing this migration creates exists yet. Expect 0 rows from each:
--        select tgname from pg_trigger where tgname in ('never_delete_clients', 'log_solution_delete') and not tgisinternal;
--        select proname from pg_proc where pronamespace = 'private'::regnamespace and proname in ('never_delete_clients', 'log_solution_delete');
--        select conname from pg_constraint where conname in ('workspaces_name_length', 'workspaces_currency_code');
--   4. No workspace breaks the new checks. Expect 0:
--        select count(*) from public.workspaces where char_length(btrim(name)) not between 1 and 200
--          or (settings ? 'currency' and not (jsonb_typeof(settings -> 'currency') = 'string' and (settings ->> 'currency') ~ '^[A-Z]{3}$'));
--
-- POST-APPLY CHECK:
--   1. Both triggers exist and are enabled. Expect 2 rows, tgenabled 'O':
--        select tgname, tgenabled from pg_trigger where tgname in ('never_delete_clients', 'log_solution_delete') and not tgisinternal;
--   2. Both checks exist, not validated. Expect 2 rows, convalidated false:
--        select conname, convalidated from pg_constraint where conname in ('workspaces_name_length', 'workspaces_currency_code');
--   3. The functions have an empty search_path and no EXECUTE for anon or authenticated. Expect 2 rows with {search_path=""}, then 0:
--        select proname, proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname in ('never_delete_clients', 'log_solution_delete');
--        select count(*) from information_schema.routine_privileges where routine_schema = 'private' and routine_name in ('never_delete_clients', 'log_solution_delete') and grantee in ('anon', 'authenticated', 'PUBLIC');
--
-- ROLLBACK (run as one transaction; audit rows and history entries already written stay):
--
--   begin;
--   drop trigger if exists never_delete_clients on public.clients;
--   drop function if exists private.never_delete_clients();
--   drop trigger if exists log_solution_delete on public.solutions;
--   drop function if exists private.log_solution_delete();
--   alter table public.workspaces drop constraint if exists workspaces_name_length;
--   alter table public.workspaces drop constraint if exists workspaces_currency_code;
--   delete from supabase_migrations.schema_migrations where version = '20261201000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Clients are hidden, never deleted
-- ---------------------------------------------------------------------------

create function private.never_delete_clients() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Signed-in roles only: a workspace's own deletion cascades as the table owner (and the workspace row is gone by then).
  if current_user in ('authenticated', 'anon') and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    raise exception 'Clients are never deleted: mark them inactive instead' using errcode = '55000';
  end if;
  return old;
end;
$$;

revoke all on function private.never_delete_clients() from public, anon, authenticated;

create trigger never_delete_clients before delete on public.clients
  for each row execute function private.never_delete_clients();

-- ---------------------------------------------------------------------------
-- Deleting a solution keeps its issue links in the audit log and the issues' history
-- ---------------------------------------------------------------------------

-- Security definer: nobody signed in writes `audit_log` or `issue_events` directly. Runs before the row goes, so the links
-- (deleted by the cascade afterwards) can still be read.
create function private.log_solution_delete() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  links jsonb;
  extra jsonb;
  r record;
  ev_id uuid;
  last_seq bigint;
  kind text := case when coalesce(auth.jwt(), '{}') ? 'api_token_id' then 'mcp' when auth.uid() is null then 'system' else 'user' end;
begin
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'issue_id', l.issue_id, 'auto_verdict', l.auto_verdict, 'holds_pct', l.holds_pct, 'auto_note', l.auto_note,
      'user_verdict', l.user_verdict, 'user_notes', l.user_notes, 'linked_at', l.created_at, 'linked_by', l.created_by)
      order by l.created_at, l.issue_id), '[]')
    into links
    from public.solution_issues l where l.solution_id = old.id and l.workspace_id = old.workspace_id;

  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (old.workspace_id, auth.uid(), kind, 'delete', 'solutions', old.id, jsonb_build_object(
    'old', jsonb_build_object('name', old.name, 'notes', old.notes, 'process_id', old.process_id,
      'base_revision_id', old.base_revision_id, 'changed_step_ids', old.changed_step_ids, 'lever_changes', old.lever_changes,
      'created_at', old.created_at, 'created_by', old.created_by),
    'issue_links', links));

  extra := jsonb_build_object('solution_deleted', jsonb_build_object('solution_id', old.id, 'solution', old.name));
  for r in
    select l.issue_id, i.status
    from public.solution_issues l
    join public.issues i on i.id = l.issue_id and i.workspace_id = l.workspace_id
    where l.solution_id = old.id and l.workspace_id = old.workspace_id
    order by l.created_at, l.issue_id
  loop
    ev_id := null;
    -- Testing solutions with nothing left to test: back to Open. `issue_log` writes that change; the deletion joins its entry.
    if r.status = 'in_progress' and not exists (
      select 1 from public.solution_issues o
      where o.issue_id = r.issue_id and o.workspace_id = old.workspace_id and o.solution_id <> old.id
    ) then
      select coalesce(max(e.seq), 0) into last_seq from public.issue_events e where e.issue_id = r.issue_id;
      update public.issues set status = 'open' where id = r.issue_id and workspace_id = old.workspace_id;
      select e.id into ev_id from public.issue_events e
        where e.issue_id = r.issue_id and e.seq > last_seq and e.detail ? 'from' order by e.seq desc limit 1;
    end if;
    if ev_id is not null then
      update public.issue_events set detail = detail || extra where id = ev_id;
    else
      insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
        values (r.issue_id, old.workspace_id, 'edited', auth.uid(), extra);
    end if;
  end loop;
  return old;
end;
$$;

revoke all on function private.log_solution_delete() from public, anon, authenticated;

create trigger log_solution_delete before delete on public.solutions
  for each row execute function private.log_solution_delete();

-- ---------------------------------------------------------------------------
-- The workspace's name and currency, as an owner edits them in Settings
-- ---------------------------------------------------------------------------

alter table public.workspaces add constraint workspaces_name_length
  check (char_length(btrim(name)) between 1 and 200) not valid;
alter table public.workspaces add constraint workspaces_currency_code
  check (not (settings ? 'currency') or (jsonb_typeof(settings -> 'currency') = 'string' and (settings ->> 'currency') ~ '^[A-Z]{3}$')) not valid;
