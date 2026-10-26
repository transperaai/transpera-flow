-- The parts of Supabase the migrations rely on, so the schema runs on any Postgres (Neon in production, plain Postgres in
-- tests): the roles RLS is written against, and auth.users / auth.identities with auth.uid(), auth.jwt() and auth.role()
-- reading the same request.jwt.claims setting Supabase's PostgREST sets. createDb (src/client.ts) sets role and claims per
-- query. Idempotent: scripts/migrate.ts applies it on every run.

-- Roles are cluster-wide, and test files run in parallel, so tolerate another session creating the same role at the same
-- moment. service_role bypasses RLS, which only a role that has the attribute itself (or a superuser) may grant.
do $$
declare
  r text;
  can_bypass boolean;
begin
  select rolsuper or rolbypassrls into can_bypass from pg_roles where rolname = current_user;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      if not exists (select from pg_roles where rolname = r) then
        if r = 'service_role' and not can_bypass then
          raise notice 'service_role created without bypassrls: % may not grant it', current_user;
          create role service_role nologin;
        else
          execute format('create role %I nologin%s', r, case when r = 'service_role' then ' bypassrls' else '' end);
        end if;
      end if;
    exception when unique_violation or duplicate_object then
      null;
    end;
    -- So the app login can `set role`. A concurrent grant of the same membership fails with an internal error; the
    -- other session's grant is the one we wanted.
    begin
      if not exists (
        select from pg_auth_members m
        where m.roleid = to_regrole(r) and m.member = to_regrole(current_user)
      ) then
        execute format('grant %I to current_user', r);
      end if;
    exception when internal_error then
      null;
    end;
  end loop;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  email_confirmed_at timestamptz default now(),
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}',
  banned_until timestamptz
);

-- One row per linked provider account; identity_data is written only by sign-in.
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_id text not null,
  identity_data jsonb not null default '{}',
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider_id, provider)
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated;
