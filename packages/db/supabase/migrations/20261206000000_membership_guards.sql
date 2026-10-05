-- Keep an owner, and link a member to their person (issue #30, B1 part 1 of 3; docs/plans/b1-brief.md).
--
-- Today an owner can demote or remove the only owner of a workspace, themselves included, and leave it with nobody who can
-- manage access. This migration stops that, and adds the helper the per-person privacy slice (B1 2/3) and the Access page
-- need to know which person the signed-in user is.
--
-- STRICTLY ADDITIVE: one helper, two trigger functions and two triggers. No table, policy, grant or existing function is
-- changed (`save_fields` and `reconcile_access` are untouched).
--
--   * `public.my_person_id(ws)`: the person record linked to the caller's active membership in `ws`, or null. SECURITY
--     DEFINER with an empty search_path, for the same reason as `workspace_role`: policies can call it without recursing
--     into `memberships`. Executable by `authenticated`, not by `anon`.
--   * `private.memberships_keep_owner()` (trigger `keep_an_owner`, before update or delete on `memberships`, SECURITY
--     INVOKER): refuses to demote, deactivate or delete a workspace's last active owner. It applies only to people: it
--     returns at once unless `current_user = 'authenticated'` (a signed-in session or an API token, after the Data API's
--     `set local role authenticated`) and the caller is not an agency admin. Reconciliation (`reconcile_access` and
--     `reconcile_after_access_change` are SECURITY DEFINER, so they run as their owner), foreign-key cascades (deleting a
--     workspace or an auth user) and SQL run as another role pass. Agency admins may leave a workspace with no owner
--     (offboarding). A workspace with no owner at all (agency-created, owner not yet added) is fine: the rule only stops
--     going from one owner to none. Refusal: errcode 23514, message `workspace_keeps_an_owner: ...`.
--   * `private.access_emails_keep_owner()` (trigger `keep_an_owner`, before update or delete on `workspace_access_emails`,
--     SECURITY DEFINER because it reads `auth.users`): removing or changing an owner's pre-assigned email reconciles at
--     trigger depth 2 as the function owner, which the first guard lets through, so this guards the list row itself. It
--     returns at once when `pg_trigger_depth() > 1` (a workspace delete cascading) or for an agency admin, and refuses
--     (same exception) when the row is an owner row, the change removes it (delete, role other than owner, or a different
--     email), a signed-in owner with source 'access_list' holds it, and no other active owner exists.
--
-- KNOWN GAP: an owner who joined by DOMAIN and was then promoted loses their membership when the domain is removed. That
-- reconciliation runs as the function owner, so it is not guarded. That is rare, and an agency admin can fix it.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--   0. Row 52 applied, nothing later. Expect exactly one row, 20261205000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;
--   1. Nothing created yet. Expect all three null:
--        select to_regprocedure('public.my_person_id(uuid)'), to_regprocedure('private.memberships_keep_owner()'),
--               to_regprocedure('private.access_emails_keep_owner()');
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
--   - all three functions have an empty search_path. Expect three rows of {search_path=""}:
--        select proname, proconfig from pg_proc where proname in ('my_person_id', 'memberships_keep_owner', 'access_emails_keep_owner');
--   - my_person_id is executable by authenticated and not by anon. Expect t, f:
--        select has_function_privilege('authenticated', 'public.my_person_id(uuid)', 'execute'),
--               has_function_privilege('anon', 'public.my_person_id(uuid)', 'execute');
--
-- Rollback:
--   drop trigger if exists keep_an_owner on public.memberships;
--   drop trigger if exists keep_an_owner on public.workspace_access_emails;
--   drop function if exists private.memberships_keep_owner();
--   drop function if exists private.access_emails_keep_owner();
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

create function private.memberships_keep_owner() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- Only people: reconciliation, cascades and other roles pass, and so do agency admins.
  if current_user <> 'authenticated' or public.is_agency_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if old.role = 'owner' and old.active
     and (tg_op = 'DELETE' or new.role <> 'owner' or not new.active)
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
language plpgsql security definer
set search_path = ''
as $$
begin
  -- A workspace delete cascading, or an agency admin.
  if pg_trigger_depth() > 1 or public.is_agency_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.email <> old.email)
     and exists (
       select 1
       from public.memberships m
       join auth.users u on u.id = m.user_id
       where m.workspace_id = old.workspace_id and m.role = 'owner' and m.active and m.source = 'access_list'
         and u.email_confirmed_at is not null and lower(u.email) = old.email)
     and not exists (
       select 1
       from public.memberships m
       join auth.users u on u.id = m.user_id
       where m.workspace_id = old.workspace_id and m.role = 'owner' and m.active and lower(u.email) <> old.email)
  then
    raise exception 'workspace_keeps_an_owner: a workspace needs at least one owner' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.memberships_keep_owner(), private.access_emails_keep_owner() from public, anon, authenticated;

create trigger keep_an_owner before update or delete on public.memberships
  for each row execute function private.memberships_keep_owner();
create trigger keep_an_owner before update or delete on public.workspace_access_emails
  for each row execute function private.access_emails_keep_owner();
