-- Better Auth and deployment access (row 73; docs/plans/supabase-exit-brief.md, step 2).
--
-- 1. Schema `better_auth` holds Better Auth's own tables. The DDL below is what `npx auth generate` (Better Auth 1.7.13, Kysely
--    adapter, `schemaName: "better_auth"`, `advanced.database.generateId: "uuid"`) emits for the Postgres dialect, unchanged
--    apart from the comments. Only the database owner (the app's auth pool) touches it; nothing is granted to anon/authenticated.
-- 2. `better_auth.sync_auth_user()` mirrors every Better Auth user into `auth.users`, so the 62 foreign keys to it, and every
--    policy that reads auth.uid(), keep working.
-- 3. `public.deployment_access` is the deployment's sign-in list (domains and named emails, each with a role), and two
--    SECURITY DEFINER functions apply it: `private.deployment_role` decides a role, `private.sync_deployment_access` applies it
--    once per sign-in. Neither is executable by anon or authenticated; the app calls them on its owner connection.

-- ---------------------------------------------------------------------------
-- Better Auth tables (generated)
-- ---------------------------------------------------------------------------

create schema if not exists "better_auth";

create table "better_auth"."user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "better_auth"."session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" uuid not null references "better_auth"."user" ("id") on delete cascade);

create table "better_auth"."account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "accountId" text not null, "providerId" text not null, "userId" uuid not null references "better_auth"."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "better_auth"."verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index "session_userId_idx" on "better_auth"."session" ("userId");

create index "account_userId_idx" on "better_auth"."account" ("userId");

create index "verification_identifier_idx" on "better_auth"."verification" ("identifier");

revoke all on schema better_auth from public, anon, authenticated;
revoke all on all tables in schema better_auth from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Mirror into auth.users
-- ---------------------------------------------------------------------------

-- Insert or update of a Better Auth user upserts auth.users under the same id. email_confirmed_at is set the first time the
-- email is verified and cleared if it stops being. raw_app_meta_data (the agency-admin flag) is never touched here.
create function better_auth.sync_auth_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into auth.users as u (id, email, email_confirmed_at, raw_user_meta_data)
  values (
    new."id",
    new."email",
    case when new."emailVerified" then now() end,
    jsonb_strip_nulls(jsonb_build_object('full_name', new."name", 'avatar_url', new."image"))
  )
  on conflict (id) do update
    set email = excluded.email,
        email_confirmed_at = case when new."emailVerified" then coalesce(u.email_confirmed_at, now()) end,
        raw_user_meta_data = excluded.raw_user_meta_data;
  return null;
end;
$$;

create trigger sync_auth_user after insert or update on better_auth."user"
  for each row execute function better_auth.sync_auth_user();

revoke execute on function better_auth.sync_auth_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who can sign in
-- ---------------------------------------------------------------------------

create table public.deployment_access (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('domain', 'email')),
  -- Stored lower-case. A domain is the exact part after the last @, never a parent or subdomain.
  value text not null
    constraint deployment_access_value_format check (
      value = lower(btrim(value))
      and case kind
            when 'email' then value ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
            else value ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and not public.is_free_mail_domain(value)
          end),
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create unique index deployment_access_kind_value_key on public.deployment_access (kind, lower(value));

alter table public.deployment_access enable row level security;

-- Agency admins only, in both directions.
create policy "read deployment_access" on public.deployment_access for select to authenticated using (public.is_agency_admin());
create policy "insert deployment_access" on public.deployment_access for insert to authenticated with check (public.is_agency_admin());
create policy "update deployment_access" on public.deployment_access for update to authenticated
  using (public.is_agency_admin()) with check (public.is_agency_admin());
create policy "delete deployment_access" on public.deployment_access for delete to authenticated using (public.is_agency_admin());

grant select, insert, update, delete on public.deployment_access to authenticated;
revoke all on public.deployment_access from anon;

create trigger audit after insert or update or delete on public.deployment_access
  for each row execute function public.audit_access_change();

-- The role an address gets, or null for "refuse". A named email beats its domain; ACCESS_ADMIN_EMAILS (p_bootstrap_admins)
-- counts as named-email admin rules and beats the table, so an admin can't lock themselves out. An unverified email gets null.
create function private.deployment_role(p_email text, p_email_verified boolean, p_bootstrap_admins text[] default '{}')
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  found text;
begin
  -- Exactly one @, and the address confirmed by the provider.
  if not coalesce(p_email_verified, false) or length(e) - length(replace(e, '@', '')) <> 1 then
    return null;
  end if;
  if exists (select 1 from unnest(coalesce(p_bootstrap_admins, '{}')) a where lower(btrim(a)) = e) then
    return 'admin';
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

-- Applies a user's access, once per sign-in, in the caller's transaction. Returns the role, or null (changing nothing) when the
-- address is no longer on the list:
--   * admin: auth.users.raw_app_meta_data.agency_admin = true, as make-agency-admin.sql does; any other role clears the flag.
--   * editor / viewer: a membership at that role in every workspace. An existing one is never lowered (an owner stays owner),
--     never removed and never reactivated; a lower one is raised and detached from the access lists (source 'manual'), so
--     reconcile_access doesn't put it back.
--   * records the provider accounts in auth.identities (p_identities: [{provider, provider_id, hd?, tid?}]), which is where the
--     per-workspace domain joins (ADR 0003) read Google's hosted-domain claim. Only a provider's own ID token reaches it.
--   * first runs public.reconcile_access(user), the per-workspace lists and domain joins that /auth/callback used to trigger.
create function private.sync_deployment_access(p_user uuid, p_bootstrap_admins text[] default '{}', p_identities jsonb default '[]')
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
  new_role := private.deployment_role(user_email, user_confirmed, p_bootstrap_admins);
  if new_role is null then
    return null;
  end if;

  perform set_config('transpera.actor_kind', 'system', true);

  update auth.users u
  set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('agency_admin', new_role = 'admin'),
      last_sign_in_at = now()
  where u.id = p_user;

  -- What the old /auth/callback did after every sign-in (ADR 0003): per-workspace pre-assigned emails and domain joins. It runs
  -- first, so a workspace's own list entry (say owner) is in place before the deployment role is added without lowering it.
  -- It touches only 'access_list' and 'domain' memberships.
  perform public.reconcile_access(p_user);

  if new_role in ('editor', 'viewer') then
    -- The enum is declared agency_admin, owner, editor, member, viewer, so a smaller role is a stronger one.
    insert into public.memberships as m (workspace_id, user_id, role, source)
    select w.id, p_user, new_role::public.membership_role, 'manual' from public.workspaces w
    on conflict (workspace_id, user_id) do update
      set role = excluded.role, source = 'manual'
      where m.active and excluded.role < m.role;
  end if;

  for i in
    select * from jsonb_to_recordset(coalesce(p_identities, '[]'::jsonb)) as x (provider text, provider_id text, hd text, tid text)
  loop
    continue when i.provider not in ('google', 'microsoft') or coalesce(i.provider_id, '') = '';
    insert into auth.identities as ident (user_id, provider, provider_id, identity_data, last_sign_in_at)
    values (
      p_user, i.provider, i.provider_id,
      jsonb_strip_nulls(jsonb_build_object(
        'sub', i.provider_id,
        'email', user_email,
        'custom_claims', case
          when nullif(i.hd, '') is not null then jsonb_build_object('hd', i.hd)
          when nullif(i.tid, '') is not null then jsonb_build_object('tid', i.tid)
        end)),
      now())
    on conflict (provider_id, provider) do update
      set identity_data = excluded.identity_data, last_sign_in_at = now(), updated_at = now()
      where ident.user_id = excluded.user_id;
  end loop;

  perform set_config('transpera.actor_kind', '', true);
  return new_role;
end;
$$;

-- Functions are executable by PUBLIC by default. The sync takes any user id, so only the owner connection may call these.
revoke execute on function private.deployment_role(text, boolean, text[]) from public, anon, authenticated;
revoke execute on function private.sync_deployment_access(uuid, text[], jsonb) from public, anon, authenticated;
