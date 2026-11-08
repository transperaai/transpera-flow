-- Three roles: Owner, Agency admin, Viewer (docs/plans/cut-list.md item 9; strip brief S3).
--
-- They replace both the sign-in roles (admin, editor, viewer) and the per-workspace roles (agency_admin, owner, editor, member,
-- viewer). Names, because the stored words and the product words no longer line up:
--
--   product word  | sign-in list (deployment_access.role) | memberships.role | JWT
--   Owner         | owner                                 | (none needed)    | app_metadata.agency_admin = true (public.is_agency_admin())
--   Agency admin  | agency_admin                          | owner            |
--   Viewer        | viewer                                | viewer           |
--
-- public.is_agency_admin() and the claim `app_metadata.agency_admin` keep their names (renaming them would touch every policy and
-- the MCP token path); they now mean "is the Owner". A memberships row of role 'owner' means "Agency admin" in that workspace.
--
-- What each can do (the model every can_* function now has):
--   Owner         everything, in every workspace, with or without a membership.
--   Agency admin  edits everything (can_edit_workspace, can_manage_workspace), sees every person and individual pay
--                 (can_see_people), uses the sandbox, creates share links, manages who can sign in (not Owner rules).
--   Viewer        reads everything except individual pay (B1 privacy: sees only the person their membership is linked to), edits
--                 nothing.
--
-- The deployment's "Who can sign in" list is the only access list. The per-workspace email lists and domain joins
-- (workspace_access_emails, workspace_domains, reconcile_access, resolve_my_access, ADR 0003) are gone, and so is the
-- "workspace keeps an owner" guard (it protected a per-workspace owner list that no longer exists). memberships stays as the table
-- RLS reads; the sign-in sync (private.sync_deployment_access) writes it, and it is now the single source of truth: it raises or
-- LOWERS a membership to match the list, and reactivates a deactivated one.
--
-- This runs on a database full of real rows (the production copy is imported at row 76, then this runs on it).
--
-- Rollback: not offered. The old per-workspace lists, the editor/member distinction and the keep-an-owner guard are not recoverable
-- from the new shape; restore from the pre-migration backup (docs/production-migrations.md).

-- Everything below that touches memberships or deployment_access is an automated change: audit it as the system.
select set_config('transpera.actor_kind', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. Drop the per-workspace access machinery
-- ---------------------------------------------------------------------------

-- The tables go first (their triggers and policies go with them); nothing else references them by foreign key.
drop table public.workspace_access_emails;
drop table public.workspace_domains;

drop trigger keep_an_owner on public.memberships;

drop function public.reconcile_after_access_change();
drop function public.resolve_my_access();
drop function public.reconcile_access(uuid);
drop function public.qualifies_for_domain(uuid, text);
drop function private.list_owner_is_last(uuid, text);
drop function private.access_emails_keep_owner();
drop function private.memberships_keep_owner();

-- ---------------------------------------------------------------------------
-- 2. memberships: the data, then the narrower role check
-- ---------------------------------------------------------------------------

-- agency_admin and editor are Agency admins ('owner' memberships: the Owner needs none); member is a Viewer.
-- (agency_admin was only ever a creator's membership in a workspace they made, and that person is the Owner.)
-- source (manual / access_list / domain) described how a row was made by the lists that are gone; every row is now the sync's.
alter table public.memberships drop constraint memberships_source_check;
update public.memberships
set role = case role
             when 'agency_admin' then 'owner'::public.membership_role
             when 'owner' then 'owner'::public.membership_role
             when 'editor' then 'owner'::public.membership_role
             else 'viewer'::public.membership_role
           end,
    source = 'manual'
where role not in ('owner', 'viewer') or source <> 'manual';
alter table public.memberships add constraint memberships_source_check check (source = 'manual');

-- The enum keeps its five labels (Postgres can't drop a label from a type); the check makes two of them the only usable ones.
alter table public.memberships add constraint memberships_role_check check (role in ('owner', 'viewer'));
comment on type public.membership_role is
  'Only owner (an Agency admin) and viewer are used: memberships_role_check. agency_admin, editor and member are legacy labels.';

-- Memberships are written by the sign-in sync and the workspace trigger below (both SECURITY DEFINER), never by a person. The one
-- thing an Agency admin does to a row is link it to a person record (Settings > Access): so no insert or delete, and update
-- reaches person_id only (a row's workspace, user and role are the list's business).
drop policy "insert memberships" on public.memberships;
drop policy "delete memberships" on public.memberships;
drop policy "update memberships" on public.memberships;
revoke insert, delete, update on public.memberships from authenticated;
grant update (person_id) on public.memberships to authenticated;
create policy "update memberships" on public.memberships for update to authenticated
  using (public.can_manage_workspace(workspace_id)) with check (public.can_manage_workspace(workspace_id));

-- ---------------------------------------------------------------------------
-- 3. The role functions every policy reads
-- ---------------------------------------------------------------------------

-- Edits the model: the Owner, or an Agency admin (an 'owner' membership). A viewer doesn't. (Was: agency_admin, owner, editor.)
create or replace function public.can_edit_workspace(ws uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select public.is_agency_admin() or public.workspace_role(ws) = 'owner';
$$;

-- Manages the workspace's settings, branding and audit trail, and sees emails in history: the same people as can_edit_workspace
-- now (there is no separate per-workspace access to manage). (Was: agency_admin, owner.)
create or replace function public.can_manage_workspace(ws uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select public.is_agency_admin() or public.workspace_role(ws) = 'owner';
$$;

-- can_see_people(ws) is can_edit_workspace(ws) and stays so: the Owner and Agency admins see every person and individual pay; a
-- Viewer sees only their own linked person and no pay (team_capacity, the person_* policies, the engine's payHidden flag). It is
-- redefined here only so the rule reads in one place.
create or replace function public.can_see_people(ws uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select public.can_edit_workspace(ws);
$$;

-- Manages who can sign in: the Owner, or an Agency admin (an 'owner' membership in any workspace). Deployment-wide, so it can't
-- ask about one workspace. SECURITY DEFINER to read memberships without going through their policy.
create function public.is_sign_in_admin() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_agency_admin()
         or exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.role = 'owner' and m.active);
$$;

revoke execute on function public.is_sign_in_admin() from public, anon;
grant execute on function public.is_sign_in_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Who can sign in: three roles, and only the Owner makes an Owner
-- ---------------------------------------------------------------------------

alter table public.deployment_access drop constraint deployment_access_role_check;
-- admin -> owner, editor -> agency_admin, viewer stays.
update public.deployment_access set role = case role when 'admin' then 'owner' when 'editor' then 'agency_admin' else role end
where role <> 'viewer';
alter table public.deployment_access add constraint deployment_access_role_check check (role in ('owner', 'agency_admin', 'viewer'));

drop policy "read deployment_access" on public.deployment_access;
drop policy "insert deployment_access" on public.deployment_access;
drop policy "update deployment_access" on public.deployment_access;
drop policy "delete deployment_access" on public.deployment_access;

-- The Owner reads and writes every rule; an Agency admin reads every rule but touches only agency_admin and viewer rules: not
-- adding an owner rule, not changing one to or from owner, not removing one.
create policy "read deployment_access" on public.deployment_access for select to authenticated using (public.is_sign_in_admin());
create policy "insert deployment_access" on public.deployment_access for insert to authenticated
  with check (public.is_agency_admin() or (public.is_sign_in_admin() and role <> 'owner'));
create policy "update deployment_access" on public.deployment_access for update to authenticated
  using (public.is_agency_admin() or (public.is_sign_in_admin() and role <> 'owner'))
  with check (public.is_agency_admin() or (public.is_sign_in_admin() and role <> 'owner'));
create policy "delete deployment_access" on public.deployment_access for delete to authenticated
  using (public.is_agency_admin() or (public.is_sign_in_admin() and role <> 'owner'));

-- The role an address gets, or null for "refuse". Unchanged except that ACCESS_ADMIN_EMAILS (p_bootstrap_admins) now names Owners.
create or replace function private.deployment_role(p_email text, p_email_verified boolean, p_bootstrap_admins text[] default '{}')
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  found text;
begin
  if not coalesce(p_email_verified, false) or length(e) - length(replace(e, '@', '')) <> 1 then
    return null;
  end if;
  if exists (select 1 from unnest(coalesce(p_bootstrap_admins, '{}')) a where lower(btrim(a)) = e) then
    return 'owner';
  end if;
  select d.role into found from public.deployment_access d where d.kind = 'email' and lower(d.value) = e;
  if found is not null then
    return found;
  end if;
  select d.role into found from public.deployment_access d
  where d.kind = 'domain' and lower(d.value) = substring(e from '[^@]*$');
  return found;
end;
$$;

-- Applies a user's access, once per sign-in, in the caller's transaction (see 20261228000000 for the identities part, unchanged).
--   * owner: auth.users.raw_app_meta_data.agency_admin = true; any other role (guest included) clears the flag. No membership: the
--     Owner passes every policy by the flag.
--   * agency_admin / viewer: an 'owner' / 'viewer' membership in EVERY workspace, made if missing and made to match if not. The list
--     is the single source of truth, so this LOWERS a membership (an Agency admin who was made a Viewer) as readily as it raises
--     one, and reactivates a deactivated one. person_id (the link to a person record) is kept.
--   * guest: nothing else.
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

  if new_role in ('agency_admin', 'viewer') then
    insert into public.memberships as m (workspace_id, user_id, role, source)
    select w.id, p_user, (case new_role when 'viewer' then 'viewer' else 'owner' end)::public.membership_role, 'manual'
    from public.workspaces w
    on conflict (workspace_id, user_id) do update
      set role = excluded.role, active = true
      where (m.role, m.active) is distinct from (excluded.role, true);
  end if;

  perform set_config('transpera.actor_kind', '', true);
  return new_role;
end;
$$;

-- A new workspace is open to everyone who can already sign in: the sync only runs at sign-in, so without this an Agency admin or a
-- Viewer would see a workspace made after their last sign-in only at the next one. Same rule as the sync (the list says who).
create function private.open_workspace_to_the_list() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform set_config('transpera.actor_kind', 'system', true);
  insert into public.memberships (workspace_id, user_id, role, source)
  select new.id, u.id,
         (case private.deployment_role(u.email, u.email_confirmed_at is not null) when 'viewer' then 'viewer' else 'owner' end)::public.membership_role,
         'manual'
  from auth.users u
  where private.deployment_role(u.email, u.email_confirmed_at is not null) in ('agency_admin', 'viewer')
  on conflict (workspace_id, user_id) do nothing;
  perform set_config('transpera.actor_kind', '', true);
  return null;
end;
$$;

create trigger open_to_the_list after insert on public.workspaces
  for each row execute function private.open_workspace_to_the_list();

revoke execute on function private.open_workspace_to_the_list() from public, anon, authenticated;
revoke execute on function private.deployment_role(text, boolean, text[]) from public, anon, authenticated;
revoke execute on function private.sync_deployment_access(uuid, text[], jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Functions that handed out the old roles
-- ---------------------------------------------------------------------------

-- The Access page's list of who has signed in, for the Owner and Agency admins (can_manage_workspace). Now only people the list
-- still lets in (a person taken off the list keeps a stale row until it is cleaned up), and no `source`.
drop function public.workspace_members(uuid);
create function public.workspace_members(ws uuid)
returns table (membership_id uuid, user_id uuid, email text, role public.membership_role, active boolean, person_id uuid,
               last_sign_in_at timestamptz, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select m.id, m.user_id, u.email, m.role, m.active, m.person_id, u.last_sign_in_at, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = ws and public.can_manage_workspace(ws)
    and private.deployment_role(u.email, u.email_confirmed_at is not null) is not null
  order by u.email;
$$;

revoke execute on function public.workspace_members(uuid) from public, anon;
grant execute on function public.workspace_members(uuid) to authenticated;

-- No membership for the creator: they are the Owner (create_workspace refuses anyone else) and pass by the flag; everyone the list
-- lets in got theirs from the trigger above. Otherwise unchanged (20261113000000).
create or replace function public.create_workspace(ws_name text, ws_slug text, ws_settings jsonb default '{}')
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  ws uuid;
  k text;
  defaults constant jsonb := '{"hours_per_week":40,"horizon_weeks":13,"currency":"AUD","leads_per_week":0,"active_clients":0,"churn_monthly":0,"retainer":0}';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Workspaces are created in the app' using errcode = '42501';
  end if;
  if auth.uid() is null or not public.is_agency_admin() then
    raise exception 'Only the Owner can create workspaces' using errcode = '42501';
  end if;
  if ws_name is null or char_length(btrim(ws_name)) not between 1 and 200 then
    raise exception 'The name must be 1 to 200 characters' using errcode = '22023';
  end if;
  ws_settings := coalesce(ws_settings, '{}');
  if jsonb_typeof(ws_settings) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(ws_settings) loop
    if k not in ('hours_per_week', 'horizon_weeks', 'currency') then
      raise exception '% can''t be set when creating a workspace', k using errcode = '22023';
    end if;
  end loop;
  if ws_settings ? 'hours_per_week' and not (
    jsonb_typeof(ws_settings -> 'hours_per_week') = 'number'
    and (ws_settings ->> 'hours_per_week')::numeric > 0 and (ws_settings ->> 'hours_per_week')::numeric <= 168) then
    raise exception 'hours_per_week must be a number above 0 and at most 168' using errcode = '22023';
  end if;
  if ws_settings ? 'horizon_weeks' and not (
    jsonb_typeof(ws_settings -> 'horizon_weeks') = 'number'
    and (ws_settings ->> 'horizon_weeks')::numeric = trunc((ws_settings ->> 'horizon_weeks')::numeric)
    and (ws_settings ->> 'horizon_weeks')::numeric between 1 and 104) then
    raise exception 'horizon_weeks must be a whole number from 1 to 104' using errcode = '22023';
  end if;
  if ws_settings ? 'currency' and not (
    jsonb_typeof(ws_settings -> 'currency') = 'string' and (ws_settings ->> 'currency') ~ '^[A-Z]{3}$') then
    raise exception 'currency must be a three-letter code such as AUD' using errcode = '22023';
  end if;

  insert into public.workspaces (name, slug, settings)
  values (btrim(ws_name), ws_slug, defaults || ws_settings)
  returning id into ws;

  return ws;
end;
$$;

-- Not redefined, but they read the roles through the functions above: every policy and function that calls can_edit_workspace,
-- can_manage_workspace or can_see_people (people, person_roles, person_skills, person_leave, client_assignments, robustness_results,
-- team_capacity, revision_history, share links, scenarios, issues, ...) now has the three-role behaviour.
