-- Production apply file for 20261213000000_forecast_plans (B7, issue #36). One new table, `public.forecast_plans`, with its
-- trigger function, two triggers, four policies and grants; strictly additive; applies after row 56 (20261207700000,
-- B1 2b); this is row 57 (renumber if another migration merges first). Preflight, post-apply checks and rollback are in
-- the migration's own header, repeated below. Apply BEFORE deploying the app (the Forecast page reads the table for
-- owners, editors and agency admins). Sets `lock_timeout` to 5 s.

begin;
set local lock_timeout = '5s';

-- Forecast plans (issue #36, ticket B7; docs/plans/b7-brief.md).
--
-- A plan is a named set of forecast markers: hires, leave and solutions going live from a month. It never changes the live
-- model; the forecast re-runs with the markers in it. This adds ONE table, `public.forecast_plans`, with its indexes (the
-- primary key, `unique (id, workspace_id)` and a unique name per workspace ignoring case and spaces), one trigger
-- function (`private.forecast_plans_before_write`), two triggers (`set_updated_at` and `forecast_plans_before_write`),
-- four policies and its grants.
--
-- STRICTLY ADDITIVE: no existing table, column, function, policy or grant changes. `save_fields` is untouched (plans are
-- written whole, by their own policies).
--
-- Who reads and writes: owners, editors and agency admins (`public.can_edit_workspace`) read and write plans (select,
-- insert, update of `name` and `markers`, delete). Members and viewers read nothing and write nothing: a hypothetical
-- leave names a person, which is per-person data they don't see (B1). `anon` has no access.
--
-- Marker shape (`markers`, a jsonb array of at most 40, at most 20000 characters; at most 4 solution markers; dates are
-- absolute ISO dates):
--   { "id": uuid, "kind": "hire",     "date": "YYYY-MM-DD", "role_id": uuid,     "fte": 0.1 to 2, "name"?: text up to 120 }
--   { "id": uuid, "kind": "leave",    "date": "YYYY-MM-DD", "person_id": uuid,   "weeks": 1 to 52 whole weeks }
--   { "id": uuid, "kind": "solution", "date": "YYYY-MM-DD", "solution_id": uuid }
-- The ids inside `markers` (role, person, solution) are checked against the plan's workspace at write time, but they are
-- NOT foreign keys: a role, person or solution deleted later leaves its marker "needs attention" in the app, never an
-- error. A workspace keeps at most 50 plans; the count is not locked, so two concurrent inserts can reach 51 (a soft cap,
-- accepted).
--
-- Preflight (run one file at a time with `prod-sql.sh -f`):
--
--     -- 0. Nothing at or past this version. Expect 0:
--     select count(*) from supabase_migrations.schema_migrations where version >= '20261213000000';
--     -- 1. The table doesn't exist. Expect null:
--     select pg_catalog.to_regclass('public.forecast_plans');
--     -- 2. The trigger function doesn't exist. Expect 0:
--     select count(*) from pg_proc where proname = 'forecast_plans_before_write';
--     -- 3. Helpers present. Expect 2 rows:
--     select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_edit_workspace', 'set_updated_at');
--     -- 4. Referenced tables have id and workspace_id. Expect 6 rows:
--     select table_name, column_name from information_schema.columns
--      where table_schema = 'public' and table_name in ('roles', 'people', 'solutions') and column_name in ('id', 'workspace_id');
--
-- Post-apply checks:
--
--     -- RLS on. Expect t:
--     select relrowsecurity from pg_class where oid = 'public.forecast_plans'::regclass;
--     -- Four policies, each on can_edit_workspace. Expect 4 rows (r, a, w, d):
--     select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) from pg_policy where polrelid = 'public.forecast_plans'::regclass order by polcmd;
--     -- Grants: authenticated DELETE, INSERT, SELECT only; anon nothing. Expect 3 rows:
--     select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'forecast_plans' and grantee in ('anon', 'authenticated') order by 1, 2;
--     -- Column UPDATE: markers and name for authenticated. Expect 2 rows:
--     select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'forecast_plans' and privilege_type = 'UPDATE' and grantee = 'authenticated' order by 1;
--     -- Triggers enabled. Expect forecast_plans_before_write O, set_updated_at O:
--     select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.forecast_plans'::regclass and not tgisinternal order by 1;
--     -- Function: not SECURITY DEFINER, empty search_path, no client EXECUTE. Expect f, t, f, f:
--     select p.prosecdef, p.proconfig = array['search_path=""'],
--            has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
--       from pg_proc p where p.proname = 'forecast_plans_before_write';
--     -- The version row. Expect 1:
--     select count(*) from supabase_migrations.schema_migrations where version = '20261213000000';
--
-- Rollback (one transaction; roll the app back first). Rolling back loses every saved plan. Production data: none needed.
--
--     begin;
--     drop table if exists public.forecast_plans;   -- its triggers, policies and indexes go with it
--     drop function if exists private.forecast_plans_before_write();
--     delete from supabase_migrations.schema_migrations where version = '20261213000000';
--     commit;

create table public.forecast_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 120),
  markers jsonb not null default '[]'
    check (
      pg_catalog.jsonb_typeof(markers) = 'array'
      and pg_catalog.jsonb_array_length(markers) <= 40
      and pg_catalog.octet_length(markers::text) <= 20000
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create unique index forecast_plans_workspace_name_key on public.forecast_plans (workspace_id, pg_catalog.lower(pg_catalog.btrim(name)));

create trigger set_updated_at before update on public.forecast_plans
  for each row execute function public.set_updated_at();

-- Checks every writer meets, with plain messages. Security invoker: a caller who can't edit the workspace gets a plain
-- permission error first (a plain database connection, as in migrations and tests, has no user and is not asked).
-- Fires only on the columns a person writes, so the foreign key's `on delete set null` of created_by passes untouched.
create function private.forecast_plans_before_write() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  m jsonb;
  k text;
  d date;
  seen text[] := '{}';
  solutions integer := 0;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if auth.uid() is not null and not coalesce(public.can_edit_workspace(new.workspace_id), false) then
    raise exception 'forecast_plans: you cannot edit this workspace' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if (select pg_catalog.count(*) from public.forecast_plans p where p.workspace_id = new.workspace_id) >= 50 then
      raise exception 'forecast_plans: a workspace keeps at most 50 plans' using errcode = '23514';
    end if;
  elsif new.workspace_id is distinct from old.workspace_id then
    raise exception 'forecast_plans: a plan stays in its workspace' using errcode = '23514';
  end if;
  for m in select e.value from pg_catalog.jsonb_array_elements(new.markers) e loop
    if pg_catalog.jsonb_typeof(m) is distinct from 'object' then
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
    k := m ->> 'kind';
    if coalesce(m ->> 'id', '') !~ uuid_re or (m ->> 'id') = any (seen) then
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
    seen := seen || (m ->> 'id');
    if coalesce(m ->> 'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end if;
    begin
      d := (m ->> 'date')::date;
    exception when others then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end;
    if d < date '2000-01-01' or d > date '2100-12-31' then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end if;
    if k = 'hire' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'role_id', 'fte', 'name')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'role_id', '') !~ uuid_re
        or not exists (select 1 from public.roles r where r.id = (m ->> 'role_id')::uuid and r.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: a hire needs a role of this workspace' using errcode = '23514';
      end if;
      if pg_catalog.jsonb_typeof(m -> 'fte') is distinct from 'number' then
        raise exception 'forecast_plans: a hire''s FTE must be between 0.1 and 2' using errcode = '23514';
      end if;
      if (m ->> 'fte')::numeric < 0.1 or (m ->> 'fte')::numeric > 2 then
        raise exception 'forecast_plans: a hire''s FTE must be between 0.1 and 2' using errcode = '23514';
      end if;
      if m ? 'name' then
        if pg_catalog.jsonb_typeof(m -> 'name') is distinct from 'string' then
          raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
        end if;
        if pg_catalog.length(m ->> 'name') > 120 then
          raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
        end if;
      end if;
    elsif k = 'leave' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'person_id', 'weeks')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'person_id', '') !~ uuid_re
        or not exists (select 1 from public.people p where p.id = (m ->> 'person_id')::uuid and p.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: leave needs a person of this workspace' using errcode = '23514';
      end if;
      if pg_catalog.jsonb_typeof(m -> 'weeks') is distinct from 'number' or (m ->> 'weeks') !~ '^[0-9]+$' then
        raise exception 'forecast_plans: leave lasts 1 to 52 whole weeks' using errcode = '23514';
      end if;
      if (m ->> 'weeks')::integer not between 1 and 52 then
        raise exception 'forecast_plans: leave lasts 1 to 52 whole weeks' using errcode = '23514';
      end if;
    elsif k = 'solution' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'solution_id')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'solution_id', '') !~ uuid_re
        or not exists (select 1 from public.solutions s where s.id = (m ->> 'solution_id')::uuid and s.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: a solution marker needs a solution of this workspace' using errcode = '23514';
      end if;
      solutions := solutions + 1;
    else
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
  end loop;
  if solutions > 4 then
    raise exception 'forecast_plans: a plan has at most 4 solutions' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.forecast_plans_before_write() from public, anon, authenticated;

create trigger forecast_plans_before_write before insert or update of name, markers, workspace_id on public.forecast_plans
  for each row execute function private.forecast_plans_before_write();

alter table public.forecast_plans enable row level security;

-- Supabase gives every new public table full privileges for anon, authenticated and service_role, so revoke first; a
-- column grant only restricts anything once the table-level UPDATE is gone (as 20261122000000 does).
revoke all on public.forecast_plans from anon, authenticated;
grant select, insert, delete on public.forecast_plans to authenticated;
grant update (name, markers) on public.forecast_plans to authenticated;

-- Plans are planning by the people who run the workspace (Q1): a hypothetical leave names a person, which is per-person
-- data members and viewers don't see (B1). Owners, editors and agency admins read and write; nobody else reads.
create policy "read forecast_plans" on public.forecast_plans for select to authenticated
  using (public.can_edit_workspace(workspace_id));
create policy "insert forecast_plans" on public.forecast_plans for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update forecast_plans" on public.forecast_plans for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete forecast_plans" on public.forecast_plans for delete to authenticated
  using (public.can_edit_workspace(workspace_id));
insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261213000000', 'forecast_plans', array[$mig$-- Forecast plans (issue #36, ticket B7; docs/plans/b7-brief.md).
--
-- A plan is a named set of forecast markers: hires, leave and solutions going live from a month. It never changes the live
-- model; the forecast re-runs with the markers in it. This adds ONE table, `public.forecast_plans`, with its indexes (the
-- primary key, `unique (id, workspace_id)` and a unique name per workspace ignoring case and spaces), one trigger
-- function (`private.forecast_plans_before_write`), two triggers (`set_updated_at` and `forecast_plans_before_write`),
-- four policies and its grants.
--
-- STRICTLY ADDITIVE: no existing table, column, function, policy or grant changes. `save_fields` is untouched (plans are
-- written whole, by their own policies).
--
-- Who reads and writes: owners, editors and agency admins (`public.can_edit_workspace`) read and write plans (select,
-- insert, update of `name` and `markers`, delete). Members and viewers read nothing and write nothing: a hypothetical
-- leave names a person, which is per-person data they don't see (B1). `anon` has no access.
--
-- Marker shape (`markers`, a jsonb array of at most 40, at most 20000 characters; at most 4 solution markers; dates are
-- absolute ISO dates):
--   { "id": uuid, "kind": "hire",     "date": "YYYY-MM-DD", "role_id": uuid,     "fte": 0.1 to 2, "name"?: text up to 120 }
--   { "id": uuid, "kind": "leave",    "date": "YYYY-MM-DD", "person_id": uuid,   "weeks": 1 to 52 whole weeks }
--   { "id": uuid, "kind": "solution", "date": "YYYY-MM-DD", "solution_id": uuid }
-- The ids inside `markers` (role, person, solution) are checked against the plan's workspace at write time, but they are
-- NOT foreign keys: a role, person or solution deleted later leaves its marker "needs attention" in the app, never an
-- error. A workspace keeps at most 50 plans; the count is not locked, so two concurrent inserts can reach 51 (a soft cap,
-- accepted).
--
-- Preflight (run one file at a time with `prod-sql.sh -f`):
--
--     -- 0. Nothing at or past this version. Expect 0:
--     select count(*) from supabase_migrations.schema_migrations where version >= '20261213000000';
--     -- 1. The table doesn't exist. Expect null:
--     select pg_catalog.to_regclass('public.forecast_plans');
--     -- 2. The trigger function doesn't exist. Expect 0:
--     select count(*) from pg_proc where proname = 'forecast_plans_before_write';
--     -- 3. Helpers present. Expect 2 rows:
--     select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_edit_workspace', 'set_updated_at');
--     -- 4. Referenced tables have id and workspace_id. Expect 6 rows:
--     select table_name, column_name from information_schema.columns
--      where table_schema = 'public' and table_name in ('roles', 'people', 'solutions') and column_name in ('id', 'workspace_id');
--
-- Post-apply checks:
--
--     -- RLS on. Expect t:
--     select relrowsecurity from pg_class where oid = 'public.forecast_plans'::regclass;
--     -- Four policies, each on can_edit_workspace. Expect 4 rows (r, a, w, d):
--     select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) from pg_policy where polrelid = 'public.forecast_plans'::regclass order by polcmd;
--     -- Grants: authenticated DELETE, INSERT, SELECT only; anon nothing. Expect 3 rows:
--     select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'forecast_plans' and grantee in ('anon', 'authenticated') order by 1, 2;
--     -- Column UPDATE: markers and name for authenticated. Expect 2 rows:
--     select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'forecast_plans' and privilege_type = 'UPDATE' and grantee = 'authenticated' order by 1;
--     -- Triggers enabled. Expect forecast_plans_before_write O, set_updated_at O:
--     select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.forecast_plans'::regclass and not tgisinternal order by 1;
--     -- Function: not SECURITY DEFINER, empty search_path, no client EXECUTE. Expect f, t, f, f:
--     select p.prosecdef, p.proconfig = array['search_path=""'],
--            has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
--       from pg_proc p where p.proname = 'forecast_plans_before_write';
--     -- The version row. Expect 1:
--     select count(*) from supabase_migrations.schema_migrations where version = '20261213000000';
--
-- Rollback (one transaction; roll the app back first). Rolling back loses every saved plan. Production data: none needed.
--
--     begin;
--     drop table if exists public.forecast_plans;   -- its triggers, policies and indexes go with it
--     drop function if exists private.forecast_plans_before_write();
--     delete from supabase_migrations.schema_migrations where version = '20261213000000';
--     commit;

create table public.forecast_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 120),
  markers jsonb not null default '[]'
    check (
      pg_catalog.jsonb_typeof(markers) = 'array'
      and pg_catalog.jsonb_array_length(markers) <= 40
      and pg_catalog.octet_length(markers::text) <= 20000
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create unique index forecast_plans_workspace_name_key on public.forecast_plans (workspace_id, pg_catalog.lower(pg_catalog.btrim(name)));

create trigger set_updated_at before update on public.forecast_plans
  for each row execute function public.set_updated_at();

-- Checks every writer meets, with plain messages. Security invoker: a caller who can't edit the workspace gets a plain
-- permission error first (a plain database connection, as in migrations and tests, has no user and is not asked).
-- Fires only on the columns a person writes, so the foreign key's `on delete set null` of created_by passes untouched.
create function private.forecast_plans_before_write() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  m jsonb;
  k text;
  d date;
  seen text[] := '{}';
  solutions integer := 0;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if auth.uid() is not null and not coalesce(public.can_edit_workspace(new.workspace_id), false) then
    raise exception 'forecast_plans: you cannot edit this workspace' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if (select pg_catalog.count(*) from public.forecast_plans p where p.workspace_id = new.workspace_id) >= 50 then
      raise exception 'forecast_plans: a workspace keeps at most 50 plans' using errcode = '23514';
    end if;
  elsif new.workspace_id is distinct from old.workspace_id then
    raise exception 'forecast_plans: a plan stays in its workspace' using errcode = '23514';
  end if;
  for m in select e.value from pg_catalog.jsonb_array_elements(new.markers) e loop
    if pg_catalog.jsonb_typeof(m) is distinct from 'object' then
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
    k := m ->> 'kind';
    if coalesce(m ->> 'id', '') !~ uuid_re or (m ->> 'id') = any (seen) then
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
    seen := seen || (m ->> 'id');
    if coalesce(m ->> 'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end if;
    begin
      d := (m ->> 'date')::date;
    exception when others then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end;
    if d < date '2000-01-01' or d > date '2100-12-31' then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end if;
    if k = 'hire' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'role_id', 'fte', 'name')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'role_id', '') !~ uuid_re
        or not exists (select 1 from public.roles r where r.id = (m ->> 'role_id')::uuid and r.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: a hire needs a role of this workspace' using errcode = '23514';
      end if;
      if pg_catalog.jsonb_typeof(m -> 'fte') is distinct from 'number' then
        raise exception 'forecast_plans: a hire''s FTE must be between 0.1 and 2' using errcode = '23514';
      end if;
      if (m ->> 'fte')::numeric < 0.1 or (m ->> 'fte')::numeric > 2 then
        raise exception 'forecast_plans: a hire''s FTE must be between 0.1 and 2' using errcode = '23514';
      end if;
      if m ? 'name' then
        if pg_catalog.jsonb_typeof(m -> 'name') is distinct from 'string' then
          raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
        end if;
        if pg_catalog.length(m ->> 'name') > 120 then
          raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
        end if;
      end if;
    elsif k = 'leave' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'person_id', 'weeks')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'person_id', '') !~ uuid_re
        or not exists (select 1 from public.people p where p.id = (m ->> 'person_id')::uuid and p.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: leave needs a person of this workspace' using errcode = '23514';
      end if;
      if pg_catalog.jsonb_typeof(m -> 'weeks') is distinct from 'number' or (m ->> 'weeks') !~ '^[0-9]+$' then
        raise exception 'forecast_plans: leave lasts 1 to 52 whole weeks' using errcode = '23514';
      end if;
      if (m ->> 'weeks')::integer not between 1 and 52 then
        raise exception 'forecast_plans: leave lasts 1 to 52 whole weeks' using errcode = '23514';
      end if;
    elsif k = 'solution' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'solution_id')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'solution_id', '') !~ uuid_re
        or not exists (select 1 from public.solutions s where s.id = (m ->> 'solution_id')::uuid and s.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: a solution marker needs a solution of this workspace' using errcode = '23514';
      end if;
      solutions := solutions + 1;
    else
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
  end loop;
  if solutions > 4 then
    raise exception 'forecast_plans: a plan has at most 4 solutions' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.forecast_plans_before_write() from public, anon, authenticated;

create trigger forecast_plans_before_write before insert or update of name, markers, workspace_id on public.forecast_plans
  for each row execute function private.forecast_plans_before_write();

alter table public.forecast_plans enable row level security;

-- Supabase gives every new public table full privileges for anon, authenticated and service_role, so revoke first; a
-- column grant only restricts anything once the table-level UPDATE is gone (as 20261122000000 does).
revoke all on public.forecast_plans from anon, authenticated;
grant select, insert, delete on public.forecast_plans to authenticated;
grant update (name, markers) on public.forecast_plans to authenticated;

-- Plans are planning by the people who run the workspace (Q1): a hypothetical leave names a person, which is per-person
-- data members and viewers don't see (B1). Owners, editors and agency admins read and write; nobody else reads.
create policy "read forecast_plans" on public.forecast_plans for select to authenticated
  using (public.can_edit_workspace(workspace_id));
create policy "insert forecast_plans" on public.forecast_plans for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update forecast_plans" on public.forecast_plans for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete forecast_plans" on public.forecast_plans for delete to authenticated
  using (public.can_edit_workspace(workspace_id));
$mig$]);

commit;
