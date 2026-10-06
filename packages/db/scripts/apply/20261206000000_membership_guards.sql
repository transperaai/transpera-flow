-- Production apply file for 20261206000000_membership_guards (B1 part 1 of 3, issue #30). Strictly additive: two helpers
-- (`public.my_person_id`, `private.list_owner_is_last`), two trigger functions (`private.memberships_keep_owner`,
-- `private.access_emails_keep_owner`) and their two triggers; applies after row 52 (20261205000000, B17). Preflight, post-apply check and rollback are in the
-- migration's own header, repeated below. Apply BEFORE deploying the app (the Access page maps the guard's error
-- message, so the guard should be live first).

begin;
set local lock_timeout = '5s';

-- Keep an owner, and link a member to their person (issue #30, B1 part 1 of 3; docs/plans/b1-brief.md).
--
-- Today an owner can demote or remove the only owner of a workspace, themselves included, and leave it with nobody who can
-- manage access. This migration stops that, and adds the helper the per-person privacy slice (B1 2/3) and the Access page
-- need to know which person the signed-in user is.
--
-- STRICTLY ADDITIVE: two helpers, two trigger functions and two triggers. No table, policy, grant or existing function is
-- changed (`save_fields` and `reconcile_access` are untouched).
--
--   * `public.my_person_id(ws)`: the person record linked to the caller's active membership in `ws`, or null. SECURITY
--     DEFINER with an empty search_path, for the same reason as `workspace_role`: policies can call it without recursing
--     into `memberships`. Executable by `authenticated`, not by `anon`.
--   * `private.memberships_keep_owner()` (trigger `keep_an_owner`, before update or delete on `memberships`, SECURITY
--     INVOKER): refuses to demote, deactivate or delete a workspace's last active owner, or to change that row's `source`
--     or `workspace_id` (an owner could otherwise change their own `source` and let `resolve_my_access` drop them). It applies only to people: it
--     returns at once unless `current_user = 'authenticated'` (a signed-in session or an API token, after the Data API's
--     `set local role authenticated`) and the caller is not an agency admin. Reconciliation (`reconcile_access` and
--     `reconcile_after_access_change` are SECURITY DEFINER, so they run as their owner), foreign-key cascades (deleting a
--     workspace or an auth user) and SQL run as another role pass. Agency admins may leave a workspace with no owner
--     (offboarding). Both guards take a per-workspace advisory lock (transaction level) before counting owners, so two owners
--     demoting each other at the same moment can't leave none. A workspace with no owner at all (agency-created, owner not yet added) is fine: the rule only stops
--     going from one owner to none. Refusal: errcode 23514, message `workspace_keeps_an_owner: ...`.
--   * `private.access_emails_keep_owner()` (trigger `keep_an_owner`, before update or delete on `workspace_access_emails`,
--     SECURITY INVOKER): removing or changing an owner's pre-assigned email reconciles at trigger depth 2 as the function
--     owner, which the first guard lets through, so this guards the list row itself. Like the first guard it returns at
--     once unless `current_user = 'authenticated'` (so support SQL as another role passes), and also when
--     `pg_trigger_depth() > 1` (a workspace delete cascading) or for an agency admin. It refuses (same exception) when the
--     row is an owner row, the change removes it (delete, a role other than owner, a different email or a different
--     workspace), a signed-in owner with source 'access_list' holds it, and no other active owner exists. It reads
--     `auth.users` through `private.list_owner_is_last(ws, email)`, SECURITY DEFINER, executable by `authenticated`.
--
-- KNOWN GAPS (follow-ups): an owner who joined by DOMAIN and was then promoted loses their membership when the domain is
-- removed, and an owner who deletes the domain they joined by does the same. Both reconciliations run as the function owner,
-- so they are not guarded. That is rare, and an agency admin can fix it.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--   0. Row 52 applied, nothing later. Expect exactly one row, 20261205000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;
--   1. Nothing created yet. Expect all four null:
--        select to_regprocedure('public.my_person_id(uuid)'), to_regprocedure('private.memberships_keep_owner()'),
--               to_regprocedure('private.access_emails_keep_owner()'),
--               to_regprocedure('private.list_owner_is_last(uuid, text)');
--   2. The reconcile functions run as a role other than authenticated (guard 2 relies on it). Expect prosecdef true and
--      owner postgres on all three rows:
--        select proname, prosecdef, proowner::regrole from pg_proc
--        where proname in ('reconcile_access', 'reconcile_after_access_change', 'resolve_my_access');
--   3. Owners per workspace today (for the log; zero owners is allowed):
--        select w.slug, count(m.id) filter (where m.role = 'owner' and m.active) as owners
--        from public.workspaces w left join public.memberships m on m.workspace_id = w.id group by 1 order by 1;
--
-- POST-APPLY CHECK:
--   - both triggers exist and are enabled. Expect two rows, keep_an_owner with 'O':
--        select tgrelid::regclass, tgname, tgenabled::text from pg_trigger where tgname = 'keep_an_owner' and not tgisinternal;
--   - all four functions have an empty search_path. Expect four rows of {search_path=""}:
--        select proname, proconfig from pg_proc where proname in ('my_person_id', 'memberships_keep_owner', 'access_emails_keep_owner', 'list_owner_is_last');
--   - my_person_id is executable by authenticated and not by anon. Expect t, f:
--        select has_function_privilege('authenticated', 'public.my_person_id(uuid)', 'execute'),
--               has_function_privilege('anon', 'public.my_person_id(uuid)', 'execute');
--
-- Rollback:
--   drop trigger if exists keep_an_owner on public.memberships;
--   drop trigger if exists keep_an_owner on public.workspace_access_emails;
--   drop function if exists private.memberships_keep_owner();
--   drop function if exists private.access_emails_keep_owner();
--   drop function if exists private.list_owner_is_last(uuid, text);
--   drop function if exists public.my_person_id(uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261206000000';

create function public.my_person_id(ws uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.person_id from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid() and m.active;
$$;

revoke execute on function public.my_person_id(uuid) from public, anon;
grant execute on function public.my_person_id(uuid) to authenticated;

create function private.list_owner_is_last(ws uuid, address text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = ws and m.role = 'owner' and m.active and m.source = 'access_list'
      and u.email_confirmed_at is not null and lower(u.email) = address)
  and not exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = ws and m.role = 'owner' and m.active and lower(u.email) <> address);
$$;

create function private.memberships_keep_owner() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- Only people: reconciliation, cascades and other roles pass, and so do agency admins.
  if current_user <> 'authenticated' or public.is_agency_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- One owner check at a time per workspace, so two owners can't demote each other at the same moment.
  perform pg_advisory_xact_lock(hashtextextended(old.workspace_id::text, 0));

  if old.role = 'owner' and old.active
     and (tg_op = 'DELETE' or new.role <> 'owner' or not new.active
          or new.source <> old.source or new.workspace_id <> old.workspace_id)
     and not exists (
       select 1 from public.memberships m
       where m.workspace_id = old.workspace_id and m.role = 'owner' and m.active and m.id <> old.id)
  then
    raise exception 'workspace_keeps_an_owner: a workspace needs at least one owner' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function private.access_emails_keep_owner() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- Only people (as the membership guard), and not a workspace delete cascading, nor an agency admin.
  if current_user <> 'authenticated' or pg_trigger_depth() > 1 or public.is_agency_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(old.workspace_id::text, 0));

  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.email <> old.email or new.workspace_id <> old.workspace_id)
     and private.list_owner_is_last(old.workspace_id, old.email)
  then
    raise exception 'workspace_keeps_an_owner: a workspace needs at least one owner' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.memberships_keep_owner(), private.access_emails_keep_owner(), private.list_owner_is_last(uuid, text) from public, anon, authenticated;
-- The list guard runs as the caller and asks this (it reads auth.users) on their behalf.
grant execute on function private.list_owner_is_last(uuid, text) to authenticated;

create trigger keep_an_owner before update or delete on public.memberships
  for each row execute function private.memberships_keep_owner();
create trigger keep_an_owner before update or delete on public.workspace_access_emails
  for each row execute function private.access_emails_keep_owner();

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261206000000', 'membership_guards', array[$mig$-- Keep an owner, and link a member to their person (issue #30, B1 part 1 of 3; docs/plans/b1-brief.md).
--
-- Today an owner can demote or remove the only owner of a workspace, themselves included, and leave it with nobody who can
-- manage access. This migration stops that, and adds the helper the per-person privacy slice (B1 2/3) and the Access page
-- need to know which person the signed-in user is.
--
-- STRICTLY ADDITIVE: two helpers, two trigger functions and two triggers. No table, policy, grant or existing function is
-- changed (`save_fields` and `reconcile_access` are untouched).
--
--   * `public.my_person_id(ws)`: the person record linked to the caller's active membership in `ws`, or null. SECURITY
--     DEFINER with an empty search_path, for the same reason as `workspace_role`: policies can call it without recursing
--     into `memberships`. Executable by `authenticated`, not by `anon`.
--   * `private.memberships_keep_owner()` (trigger `keep_an_owner`, before update or delete on `memberships`, SECURITY
--     INVOKER): refuses to demote, deactivate or delete a workspace's last active owner, or to change that row's `source`
--     or `workspace_id` (an owner could otherwise change their own `source` and let `resolve_my_access` drop them). It applies only to people: it
--     returns at once unless `current_user = 'authenticated'` (a signed-in session or an API token, after the Data API's
--     `set local role authenticated`) and the caller is not an agency admin. Reconciliation (`reconcile_access` and
--     `reconcile_after_access_change` are SECURITY DEFINER, so they run as their owner), foreign-key cascades (deleting a
--     workspace or an auth user) and SQL run as another role pass. Agency admins may leave a workspace with no owner
--     (offboarding). Both guards take a per-workspace advisory lock (transaction level) before counting owners, so two owners
--     demoting each other at the same moment can't leave none. A workspace with no owner at all (agency-created, owner not yet added) is fine: the rule only stops
--     going from one owner to none. Refusal: errcode 23514, message `workspace_keeps_an_owner: ...`.
--   * `private.access_emails_keep_owner()` (trigger `keep_an_owner`, before update or delete on `workspace_access_emails`,
--     SECURITY INVOKER): removing or changing an owner's pre-assigned email reconciles at trigger depth 2 as the function
--     owner, which the first guard lets through, so this guards the list row itself. Like the first guard it returns at
--     once unless `current_user = 'authenticated'` (so support SQL as another role passes), and also when
--     `pg_trigger_depth() > 1` (a workspace delete cascading) or for an agency admin. It refuses (same exception) when the
--     row is an owner row, the change removes it (delete, a role other than owner, a different email or a different
--     workspace), a signed-in owner with source 'access_list' holds it, and no other active owner exists. It reads
--     `auth.users` through `private.list_owner_is_last(ws, email)`, SECURITY DEFINER, executable by `authenticated`.
--
-- KNOWN GAPS (follow-ups): an owner who joined by DOMAIN and was then promoted loses their membership when the domain is
-- removed, and an owner who deletes the domain they joined by does the same. Both reconciliations run as the function owner,
-- so they are not guarded. That is rare, and an agency admin can fix it.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--   0. Row 52 applied, nothing later. Expect exactly one row, 20261205000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;
--   1. Nothing created yet. Expect all four null:
--        select to_regprocedure('public.my_person_id(uuid)'), to_regprocedure('private.memberships_keep_owner()'),
--               to_regprocedure('private.access_emails_keep_owner()'),
--               to_regprocedure('private.list_owner_is_last(uuid, text)');
--   2. The reconcile functions run as a role other than authenticated (guard 2 relies on it). Expect prosecdef true and
--      owner postgres on all three rows:
--        select proname, prosecdef, proowner::regrole from pg_proc
--        where proname in ('reconcile_access', 'reconcile_after_access_change', 'resolve_my_access');
--   3. Owners per workspace today (for the log; zero owners is allowed):
--        select w.slug, count(m.id) filter (where m.role = 'owner' and m.active) as owners
--        from public.workspaces w left join public.memberships m on m.workspace_id = w.id group by 1 order by 1;
--
-- POST-APPLY CHECK:
--   - both triggers exist and are enabled. Expect two rows, keep_an_owner with 'O':
--        select tgrelid::regclass, tgname, tgenabled::text from pg_trigger where tgname = 'keep_an_owner' and not tgisinternal;
--   - all four functions have an empty search_path. Expect four rows of {search_path=""}:
--        select proname, proconfig from pg_proc where proname in ('my_person_id', 'memberships_keep_owner', 'access_emails_keep_owner', 'list_owner_is_last');
--   - my_person_id is executable by authenticated and not by anon. Expect t, f:
--        select has_function_privilege('authenticated', 'public.my_person_id(uuid)', 'execute'),
--               has_function_privilege('anon', 'public.my_person_id(uuid)', 'execute');
--
-- Rollback:
--   drop trigger if exists keep_an_owner on public.memberships;
--   drop trigger if exists keep_an_owner on public.workspace_access_emails;
--   drop function if exists private.memberships_keep_owner();
--   drop function if exists private.access_emails_keep_owner();
--   drop function if exists private.list_owner_is_last(uuid, text);
--   drop function if exists public.my_person_id(uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261206000000';

create function public.my_person_id(ws uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.person_id from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid() and m.active;
$$;

revoke execute on function public.my_person_id(uuid) from public, anon;
grant execute on function public.my_person_id(uuid) to authenticated;

create function private.list_owner_is_last(ws uuid, address text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = ws and m.role = 'owner' and m.active and m.source = 'access_list'
      and u.email_confirmed_at is not null and lower(u.email) = address)
  and not exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = ws and m.role = 'owner' and m.active and lower(u.email) <> address);
$$;

create function private.memberships_keep_owner() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- Only people: reconciliation, cascades and other roles pass, and so do agency admins.
  if current_user <> 'authenticated' or public.is_agency_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- One owner check at a time per workspace, so two owners can't demote each other at the same moment.
  perform pg_advisory_xact_lock(hashtextextended(old.workspace_id::text, 0));

  if old.role = 'owner' and old.active
     and (tg_op = 'DELETE' or new.role <> 'owner' or not new.active
          or new.source <> old.source or new.workspace_id <> old.workspace_id)
     and not exists (
       select 1 from public.memberships m
       where m.workspace_id = old.workspace_id and m.role = 'owner' and m.active and m.id <> old.id)
  then
    raise exception 'workspace_keeps_an_owner: a workspace needs at least one owner' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function private.access_emails_keep_owner() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- Only people (as the membership guard), and not a workspace delete cascading, nor an agency admin.
  if current_user <> 'authenticated' or pg_trigger_depth() > 1 or public.is_agency_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(old.workspace_id::text, 0));

  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.email <> old.email or new.workspace_id <> old.workspace_id)
     and private.list_owner_is_last(old.workspace_id, old.email)
  then
    raise exception 'workspace_keeps_an_owner: a workspace needs at least one owner' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.memberships_keep_owner(), private.access_emails_keep_owner(), private.list_owner_is_last(uuid, text) from public, anon, authenticated;
-- The list guard runs as the caller and asks this (it reads auth.users) on their behalf.
grant execute on function private.list_owner_is_last(uuid, text) to authenticated;

create trigger keep_an_owner before update or delete on public.memberships
  for each row execute function private.memberships_keep_owner();
create trigger keep_an_owner before update or delete on public.workspace_access_emails
  for each row execute function private.access_emails_keep_owner();
$mig$]);

commit;
