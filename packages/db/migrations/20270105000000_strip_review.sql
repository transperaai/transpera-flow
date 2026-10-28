-- Strip review (docs/plans/strip-briefs.md; three roles, docs/plans/cut-list.md item 9): closes three gaps 20270103000000 left
-- between "Who can sign in is the single source of truth" and what an open session or an API token could still do.
--
-- 1. A change to the list reaches memberships AT ONCE. The sign-in sync only runs at sign-in, so an Agency admin made a Viewer kept
--    their 'owner' memberships (pay, editing, and is_sign_in_admin, so they could put themselves back) on their open session and
--    their API tokens until they next signed in. A statement trigger on deployment_access now applies the list to everyone it lets
--    in as an Agency admin or a Viewer, exactly as the sync does (private.apply_list_memberships, shared by both). Someone the list
--    no longer lets in is left alone, as before: every web request and MCP call already refuses them (apps/web/src/lib/auth/access.ts
--    currentAccess), and their memberships come back as they were if they are let in again. The Owner flag is unchanged here:
--    currentAccess already honours it only while the list says owner.
--
-- 2. A guest gets nothing from memberships. A guest is someone signed in only for a restricted share link (the claims carry
--    app_metadata.guest); someone taken off the list who is also listed on such a link signs in as a guest and kept every active
--    membership they had (workspace_role read them by auth.uid() alone). workspace_role, my_person_id and is_sign_in_admin now
--    answer nothing for a guest.
--
-- 3. Only the Owner makes or unmakes an Owner. An email rule beats its domain rule (private.deployment_role), so an Agency admin
--    could add an email rule for an address in an owner domain (demoting that Owner) or change or remove one there (making its
--    address an Owner), though the policies stop them touching owner rules themselves. A before-write trigger refuses an email rule
--    in an owner domain to anyone but the Owner. (ACCESS_ADMIN_EMAILS beats every rule and isn't affected.)
--
-- Runs on a database full of real rows: it replaces function bodies and adds triggers; it changes no data.
-- Rollback: drop the two triggers and their functions, and re-run workspace_role and my_person_id from 20260930030000 and
-- 20261007000000, is_sign_in_admin and sync_deployment_access from 20270103000000.

-- A guest, by the claims the app builds (apps/web/src/lib/db/claims.ts).
create function private.is_guest() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'guest')::boolean, false);
$$;

-- Read only inside the SECURITY DEFINER functions below.
revoke execute on function private.is_guest() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Nothing from memberships for a guest
-- ---------------------------------------------------------------------------

create or replace function public.workspace_role(ws uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.memberships m
  where m.workspace_id = ws and m.user_id = auth.uid() and m.active and not private.is_guest();
$$;

create or replace function public.my_person_id(ws uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.person_id from public.memberships m
  where m.workspace_id = ws and m.user_id = auth.uid() and m.active and not private.is_guest();
$$;

create or replace function public.is_sign_in_admin() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_agency_admin()
         or (not private.is_guest()
             and exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.role = 'owner' and m.active));
$$;

-- ---------------------------------------------------------------------------
-- 1. The list reaches memberships at once
-- ---------------------------------------------------------------------------

-- An Agency admin's ('owner') or a Viewer's ('viewer') membership in every workspace, made if missing and made to match if not
-- (raised, lowered, reactivated; person_id kept). The body the sync had in 20270103000000, now shared with the trigger below.
create function private.apply_list_memberships(p_user uuid, p_role text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  -- coalesce: an address the list refuses has a null role, and `null not in (...)` is null, not true.
  if coalesce(p_role not in ('agency_admin', 'viewer'), true) then
    return;
  end if;
  insert into public.memberships as m (workspace_id, user_id, role, source)
  select w.id, p_user, (case p_role when 'viewer' then 'viewer' else 'owner' end)::public.membership_role, 'manual'
  from public.workspaces w
  on conflict (workspace_id, user_id) do update
    set role = excluded.role, active = true
    where (m.role, m.active) is distinct from (excluded.role, true);
end;
$$;

revoke execute on function private.apply_list_memberships(uuid, text) from public, anon, authenticated;

create or replace function private.sync_deployment_access(p_user uuid, p_bootstrap_admins text[] default '{}', p_identities jsonb default '[]')
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  user_email text;
  user_confirmed boolean;
  new_role text;
  i record;
begin
  select u.email, u.email_confirmed_at is not null into user_email, user_confirmed from auth.users u where u.id = p_user;
  if not found then
    return null;
  end if;
  new_role := private.may_sign_in(user_email, user_confirmed, p_bootstrap_admins);
  if new_role is null then
    return null;
  end if;

  perform set_config('transpera.actor_kind', 'system', true);

  for i in
    select * from jsonb_to_recordset(coalesce(p_identities, '[]'::jsonb))
      as x (provider text, provider_id text, email text, hd text, tid text)
  loop
    continue when i.provider not in ('google', 'microsoft') or coalesce(i.provider_id, '') = '';
    insert into auth.identities as ident (user_id, provider, provider_id, identity_data, last_sign_in_at)
    values (
      p_user, i.provider, i.provider_id,
      jsonb_strip_nulls(jsonb_build_object(
        'sub', i.provider_id,
        'email', coalesce(nullif(lower(btrim(i.email)), ''), user_email),
        'custom_claims', case
          when nullif(i.hd, '') is not null then jsonb_build_object('hd', i.hd)
          when nullif(i.tid, '') is not null then jsonb_build_object('tid', i.tid)
        end)),
      now())
    on conflict (provider_id, provider) do update
      set identity_data = excluded.identity_data, last_sign_in_at = now(), updated_at = now()
      where ident.user_id = excluded.user_id;
  end loop;

  update auth.users u
  set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('agency_admin', new_role = 'owner'),
      last_sign_in_at = now()
  where u.id = p_user;

  perform private.apply_list_memberships(p_user, new_role);

  perform set_config('transpera.actor_kind', '', true);
  return new_role;
end;
$$;

revoke execute on function private.sync_deployment_access(uuid, text[], jsonb) from public, anon, authenticated;

-- After any change to the list: everyone who has signed in and whom it now lets in as an Agency admin or a Viewer gets the
-- memberships the sync would give them. Audited as the system, like the sync.
create function private.apply_list_after_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  u record;
  prev text := current_setting('transpera.actor_kind', true);
begin
  perform set_config('transpera.actor_kind', 'system', true);
  for u in
    select y.id, y.role from (
      select x.id, private.deployment_role(x.email, x.email_confirmed_at is not null) as role from auth.users x) y
    where y.role in ('agency_admin', 'viewer')
  loop
    perform private.apply_list_memberships(u.id, u.role);
  end loop;
  -- Put back what the statement ran as (a migration that set 'system' stays 'system' for the rest of its transaction).
  perform set_config('transpera.actor_kind', coalesce(prev, ''), true);
  return null;
end;
$$;

revoke execute on function private.apply_list_after_change() from public, anon, authenticated;

create trigger apply_to_memberships after insert or update or delete on public.deployment_access
  for each statement execute function private.apply_list_after_change();

-- ---------------------------------------------------------------------------
-- 3. Only the Owner touches an email rule in an owner domain
-- ---------------------------------------------------------------------------

create function private.deployment_access_guard_owners() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- A signed-in person who isn't the Owner (the database's owner, a migration or the sign-in code has no auth.uid()).
  if auth.uid() is null or public.is_agency_admin() then
    return coalesce(new, old);
  end if;
  if (tg_op in ('UPDATE', 'DELETE') and old.kind = 'email' and exists (
        select 1 from public.deployment_access d
        where d.kind = 'domain' and d.role = 'owner' and d.value = substring(old.value from '[^@]*$')))
     or (tg_op in ('INSERT', 'UPDATE') and new.kind = 'email' and exists (
        select 1 from public.deployment_access d
        where d.kind = 'domain' and d.role = 'owner' and d.value = substring(lower(btrim(new.value)) from '[^@]*$'))) then
    raise exception 'Only the Owner can change who signs in from an Owner''s domain' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke execute on function private.deployment_access_guard_owners() from public, anon, authenticated;

create trigger guard_owners before insert or update or delete on public.deployment_access
  for each row execute function private.deployment_access_guard_owners();
