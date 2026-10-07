-- Production apply file for 20261224000000_revoke_unused_table_privileges (security hardening; approved by Austin on 7 Oct 2026:
-- "Yes, remove them"). Revokes TRUNCATE, TRIGGER and REFERENCES (and MAINTAIN on Postgres 17) on every public table from anon and
-- authenticated, and from the default privileges for tables made by postgres (and by supabase_admin only if the applier is a
-- member of it; on Supabase it is not, so that step is skipped with a NOTICE). No SELECT, INSERT, UPDATE or DELETE grant changes.
-- This is row 68 of docs/production-migrations.md; apply after row 67 (20261223000000). Run preflight 0 to 4 from the migration's
-- header (repeated below) FIRST and SAVE the output of 1 to 4: 2 is the exact rollback, 4 is what post-apply 2 compares with.
-- The app needs nothing; apply whenever. Sets `lock_timeout` to 5 s.

begin;
set local lock_timeout = '5s';

-- Take TRUNCATE, TRIGGER and REFERENCES (and MAINTAIN, on Postgres 17) away from `anon` and `authenticated` on every table in
-- `public`, and stop new tables getting them (security hardening; approved by Austin on 7 Oct 2026: "Yes, remove them").
--
-- WHY: Supabase's default privileges in `public` grant ALL on every new table to `anon` and `authenticated`
-- (`alter default privileges ... grant all on tables to anon, authenticated, service_role`), so on production both roles hold
-- TRUNCATE, TRIGGER and REFERENCES (and MAINTAIN on Postgres 17) on almost every public table, not only what each migration
-- grants. Nothing uses them: PostgREST has no TRUNCATE, no function runs SQL a user supplies, and the app makes no tables,
-- triggers or foreign keys as a client. They are found while applying row 67; see docs/supabase-notes.md ("Default table
-- grants on Supabase"). Plain Postgres (tests) has no such defaults.
--
-- WHAT CHANGES (privileges only; no table, row, policy or function changes):
--   * Every relation in `public` that can hold these privileges (tables, partitioned tables, views, materialized views and
--     foreign tables: relkind r, p, v, m, f): REVOKE TRUNCATE, TRIGGER, REFERENCES (+ MAINTAIN when server_version_num >= 170000)
--     FROM anon, authenticated. A loop over pg_class, so it covers every table that exists when it runs, whatever its migration.
--     A table-level REVOKE REFERENCES also removes any column-level REFERENCES (Postgres revokes a table-level privilege from each
--     column too); column-level SELECT, INSERT and UPDATE stay.
--   * Default privileges in `public` for tables made by `postgres`: REVOKE the same privileges FROM anon, authenticated, so new
--     tables get only SELECT, INSERT, UPDATE, DELETE from the defaults (what they get today minus the unused ones).
--   * Default privileges for tables made by `supabase_admin`: changed ONLY IF the applying role is a member of `supabase_admin`.
--     Postgres allows ALTER DEFAULT PRIVILEGES FOR ROLE x only for members of x; on Supabase `postgres` is not a member of
--     `supabase_admin` (it is not a superuser), so this step is expected to be SKIPPED with a NOTICE. Preflight 3 shows which
--     happens. That leaves only tables `supabase_admin` itself creates in `public` (Supabase internals; the app's migrations run
--     as `postgres`), and a later run of the loop above (or this migration's post-apply 1) catches any.
--   * Sequences: NOTHING to do. A sequence can only hold USAGE, SELECT and UPDATE (Postgres refuses TRUNCATE, TRIGGER, REFERENCES
--     and MAINTAIN on one: "invalid privilege type ... for sequence"), and those are what inserts into identity columns use
--     (`issues.seq`), so they are left as they are. Post-apply 3 shows the sequence grants are unchanged.
--   * NOT changed: any SELECT, INSERT, UPDATE or DELETE grant (table- or column-level), `service_role`, `postgres`, functions,
--     schemas, RLS and policies. Each table keeps exactly the DML its migrations meant it to have; post-apply 2 compares counts.
--
-- ORDER: after row 67 (20261223000000, the latest applied). Independent of every other migration. Row 68 of
-- docs/production-migrations.md. The app needs nothing; apply whenever. Apply file:
-- packages/db/scripts/apply/20261224000000_revoke_unused_table_privileges.sql (sets `lock_timeout` to 5 s).
-- Tests: packages/db/test/revoke-table-privileges.test.ts (grants Supabase's extra privileges first, then applies this file).
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time; SAVE the output of 1, 2, 3 and 4
-- in the log, because 2 is the exact rollback and 4 is what post-apply 2 compares with):
--   0. Latest applied versions. Expect 20261223000000 (row 67) as the latest and nothing >= 20261224000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261221000000' order by 1;
--   1. For the log: the privileges this removes, per table and role (table-level, then column-level REFERENCES). Expect almost
--      every public table twice (anon and authenticated) with REFERENCES, TRIGGER, TRUNCATE (and MAINTAIN on PG17); then 0 rows:
--        select c.relname, g.grantee::regrole::text as grantee,
--               string_agg(g.privilege_type, ', ' order by g.privilege_type) as privileges
--        from pg_class c cross join lateral aclexplode(c.relacl) g
--        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--          and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN')
--        group by 1, 2 order by 1, 2;
--        select c.relname, a.attname, g.grantee::regrole::text as grantee
--        from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--        cross join lateral aclexplode(a.attacl) g
--        where c.relnamespace = 'public'::regnamespace and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type = 'REFERENCES' order by 1, 2, 3;
--   2. The exact grant-back, for the log and the rollback: one statement per table and role (column-level REFERENCES, if 1
--      listed any, are written out after them). Save the single text value it returns:
--        select string_agg(s, E'\n' order by s) from (
--          select format('grant %s on table %s to %I%s;', string_agg(g.privilege_type, ', ' order by g.privilege_type),
--                        c.oid::regclass, g.grantee::regrole::text, case when g.is_grantable then ' with grant option' else '' end) as s
--          from pg_class c cross join lateral aclexplode(c.relacl) g
--          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--            and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--            and g.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN')
--          group by c.oid, g.grantee, g.is_grantable
--          union all
--          select format('grant references (%I) on table %s to %I;', a.attname, c.oid::regclass, g.grantee::regrole::text)
--          from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--          cross join lateral aclexplode(a.attacl) g
--          where c.relnamespace = 'public'::regnamespace and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--            and g.privilege_type = 'REFERENCES'
--        ) x;
--   3. Default privileges in `public`, who applies, and whether the supabase_admin step will run. Expect `postgres` and
--      `supabase_admin` rows for tables (r) granting anon and authenticated `arwdDxt` (`arwdDxtm` on PG17); then the server
--      version (170000 or later on Supabase), the applying role (`postgres`) and `f` for supabase_admin membership (that step
--      is then skipped; `t` means it runs too); then 0 (every public table owned by a role the applier can act for):
--        select defaclrole::regrole, defaclobjtype, defaclacl from pg_default_acl
--          where defaclnamespace = 'public'::regnamespace order by 1, 2;
--        select current_setting('server_version_num')::int, current_user,
--               pg_has_role(current_user, 'supabase_admin', 'member');
--        select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f')
--          and not pg_has_role(current_user, relowner, 'member');
--      and, for the log, the sequence grants (post-apply 3 expects the same rows; `issues_seq_seq` is the only sequence, and where
--      Supabase's sequence defaults reached it anon and authenticated hold SELECT, UPDATE, USAGE on it):
--        select c.relname, g.grantee::regrole::text, string_agg(g.privilege_type, ', ' order by g.privilege_type)
--        from pg_class c cross join lateral aclexplode(c.relacl) g
--        where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
--          and g.grantee in ('anon'::regrole, 'authenticated'::regrole) group by 1, 2 order by 1, 2;
--   4. The DML grants to keep: per table, how many table-level and column-level grants of SELECT, INSERT, UPDATE and DELETE
--      anon and authenticated hold. Save it; post-apply 2 must return exactly the same rows:
--        with g as (
--          select c.relname, false as col, x.grantee, x.privilege_type
--          from pg_class c cross join lateral aclexplode(c.relacl) x
--          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--          union all
--          select c.relname, true, x.grantee, x.privilege_type
--          from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--          cross join lateral aclexplode(a.attacl) x
--          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--        ), counts as (
--          select relname,
--                 count(*) filter (where grantee = 'anon'::regrole and not col) as anon_table,
--                 count(*) filter (where grantee = 'authenticated'::regrole and not col) as auth_table,
--                 count(*) filter (where grantee = 'anon'::regrole and col) as anon_column,
--                 count(*) filter (where grantee = 'authenticated'::regrole and col) as auth_column
--          from g where privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
--            and grantee in ('anon'::regrole, 'authenticated'::regrole)
--          group by relname
--        )
--        select relname, anon_table, auth_table, anon_column, auth_column from counts order by relname;
--
-- POST-APPLY CHECK:
--   1. Nothing left: no TRUNCATE, TRIGGER, REFERENCES or MAINTAIN for anon or authenticated on any public relation, table- or
--      column-level. Expect 0, then 0:
--        select count(*) from pg_class c cross join lateral aclexplode(c.relacl) g
--        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--          and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
--        select count(*) from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
--        cross join lateral aclexplode(a.attacl) g
--        where c.relnamespace = 'public'::regnamespace and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type = 'REFERENCES';
--      And by name, the same check through the information schema. Expect 0 rows:
--        select table_name, grantee, privilege_type from information_schema.role_table_grants
--        where table_schema = 'public' and grantee in ('anon', 'authenticated')
--          and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
--   2. DML unchanged: run preflight 4 again. Every row must equal the saved output (same tables, same four counts).
--   3. Default privileges: run preflight 3's first query. The `postgres` table row now grants anon and authenticated `arwd`;
--      the `supabase_admin` row is unchanged if preflight 3 said `f` (else `arwd` too). Sequence rows (S) are unchanged. Then
--      run preflight 3's sequence query: the same rows as before (a sequence can't hold the revoked privileges).
--   4. A new table gets no extra privilege. Expect `anon=arwd/postgres` and `authenticated=arwd/postgres` in the ACL (and
--      service_role's and postgres's entries as before), ROLLED BACK:
--        begin; create table public.zz_grants_probe (id int);
--        select relacl from pg_class where oid = 'public.zz_grants_probe'::regclass;
--        rollback;
--   5. The app: sign in and save a field; a share link opens. (DML grants are untouched, so nothing should change.)
--
-- ROLLBACK (one transaction): first run the text saved from preflight 2 (the exact grant-back, one GRANT per table and role),
-- then the block below, which puts Supabase's default privileges back as they were (`grant all` on tables made by `postgres`;
-- SELECT, INSERT, UPDATE and DELETE are already there, so this adds back only what was revoked):
--   begin;
--   -- <paste the text saved from preflight 2 here>
--   alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261224000000';
--   commit;
-- If preflight 3 said `t` (the supabase_admin step ran), also run, inside the transaction:
--   alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated;
-- If preflight 2's text was lost, this grants the privileges back on every public table where the role still holds any
-- table-level privilege (Supabase's default reached those; it may also add them back on a table whose migration revoked
-- everything and granted only SELECT): a fallback, not exact.
--     do $$ declare r record; begin
--       for r in select distinct c.oid::regclass as t, g.grantee::regrole::text as role
--         from pg_class c cross join lateral aclexplode(c.relacl) g
--         where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--           and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--       loop execute format('grant all on table %s to %I', r.t, r.role); end loop; end $$;
--
-- Production data: none changes.

do $$
declare
  privs text := 'truncate, trigger, references';
  rel record;
begin
  -- MAINTAIN exists from Postgres 17 (Supabase runs 17); `grant all` included it there, so take it back too.
  if current_setting('server_version_num')::int >= 170000 then
    privs := privs || ', maintain';
  end if;

  -- 1. Every relation in public that exists now.
  for rel in
    select c.oid::regclass as name, pg_has_role(current_user, c.relowner, 'member') as mine
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by c.relname
  loop
    if rel.mine then
      execute format('revoke %s on table %s from anon, authenticated', privs, rel.name);
    else
      -- Only the owner (or a member of it) can revoke what the owner granted; post-apply 1 lists anything left.
      raise warning 'revoke_unused_table_privileges: % is not owned by a role % can act for; skipped', rel.name, current_user;
    end if;
  end loop;

  -- 2. New tables made by postgres (the app's migrations).
  execute format('alter default privileges for role postgres in schema public revoke %s on tables from anon, authenticated',
                 privs);

  -- 3. New tables made by supabase_admin, only where allowed (a member of supabase_admin; not `postgres` on Supabase).
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    if pg_has_role(current_user, 'supabase_admin', 'member') then
      execute format('alter default privileges for role supabase_admin in schema public revoke %s on tables from anon, authenticated',
                     privs);
    else
      raise notice 'revoke_unused_table_privileges: % is not a member of supabase_admin; its default privileges are unchanged',
                   current_user;
    end if;
  end if;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261224000000', 'revoke_unused_table_privileges', array[$mig$-- Take TRUNCATE, TRIGGER and REFERENCES (and MAINTAIN, on Postgres 17) away from `anon` and `authenticated` on every table in
-- `public`, and stop new tables getting them (security hardening; approved by Austin on 7 Oct 2026: "Yes, remove them").
--
-- WHY: Supabase's default privileges in `public` grant ALL on every new table to `anon` and `authenticated`
-- (`alter default privileges ... grant all on tables to anon, authenticated, service_role`), so on production both roles hold
-- TRUNCATE, TRIGGER and REFERENCES (and MAINTAIN on Postgres 17) on almost every public table, not only what each migration
-- grants. Nothing uses them: PostgREST has no TRUNCATE, no function runs SQL a user supplies, and the app makes no tables,
-- triggers or foreign keys as a client. They are found while applying row 67; see docs/supabase-notes.md ("Default table
-- grants on Supabase"). Plain Postgres (tests) has no such defaults.
--
-- WHAT CHANGES (privileges only; no table, row, policy or function changes):
--   * Every relation in `public` that can hold these privileges (tables, partitioned tables, views, materialized views and
--     foreign tables: relkind r, p, v, m, f): REVOKE TRUNCATE, TRIGGER, REFERENCES (+ MAINTAIN when server_version_num >= 170000)
--     FROM anon, authenticated. A loop over pg_class, so it covers every table that exists when it runs, whatever its migration.
--     A table-level REVOKE REFERENCES also removes any column-level REFERENCES (Postgres revokes a table-level privilege from each
--     column too); column-level SELECT, INSERT and UPDATE stay.
--   * Default privileges in `public` for tables made by `postgres`: REVOKE the same privileges FROM anon, authenticated, so new
--     tables get only SELECT, INSERT, UPDATE, DELETE from the defaults (what they get today minus the unused ones).
--   * Default privileges for tables made by `supabase_admin`: changed ONLY IF the applying role is a member of `supabase_admin`.
--     Postgres allows ALTER DEFAULT PRIVILEGES FOR ROLE x only for members of x; on Supabase `postgres` is not a member of
--     `supabase_admin` (it is not a superuser), so this step is expected to be SKIPPED with a NOTICE. Preflight 3 shows which
--     happens. That leaves only tables `supabase_admin` itself creates in `public` (Supabase internals; the app's migrations run
--     as `postgres`), and a later run of the loop above (or this migration's post-apply 1) catches any.
--   * Sequences: NOTHING to do. A sequence can only hold USAGE, SELECT and UPDATE (Postgres refuses TRUNCATE, TRIGGER, REFERENCES
--     and MAINTAIN on one: "invalid privilege type ... for sequence"), and those are what inserts into identity columns use
--     (`issues.seq`), so they are left as they are. Post-apply 3 shows the sequence grants are unchanged.
--   * NOT changed: any SELECT, INSERT, UPDATE or DELETE grant (table- or column-level), `service_role`, `postgres`, functions,
--     schemas, RLS and policies. Each table keeps exactly the DML its migrations meant it to have; post-apply 2 compares counts.
--
-- ORDER: after row 67 (20261223000000, the latest applied). Independent of every other migration. Row 68 of
-- docs/production-migrations.md. The app needs nothing; apply whenever. Apply file:
-- packages/db/scripts/apply/20261224000000_revoke_unused_table_privileges.sql (sets `lock_timeout` to 5 s).
-- Tests: packages/db/test/revoke-table-privileges.test.ts (grants Supabase's extra privileges first, then applies this file).
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time; SAVE the output of 1, 2, 3 and 4
-- in the log, because 2 is the exact rollback and 4 is what post-apply 2 compares with):
--   0. Latest applied versions. Expect 20261223000000 (row 67) as the latest and nothing >= 20261224000000:
--        select version from supabase_migrations.schema_migrations where version >= '20261221000000' order by 1;
--   1. For the log: the privileges this removes, per table and role (table-level, then column-level REFERENCES). Expect almost
--      every public table twice (anon and authenticated) with REFERENCES, TRIGGER, TRUNCATE (and MAINTAIN on PG17); then 0 rows:
--        select c.relname, g.grantee::regrole::text as grantee,
--               string_agg(g.privilege_type, ', ' order by g.privilege_type) as privileges
--        from pg_class c cross join lateral aclexplode(c.relacl) g
--        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--          and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN')
--        group by 1, 2 order by 1, 2;
--        select c.relname, a.attname, g.grantee::regrole::text as grantee
--        from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--        cross join lateral aclexplode(a.attacl) g
--        where c.relnamespace = 'public'::regnamespace and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type = 'REFERENCES' order by 1, 2, 3;
--   2. The exact grant-back, for the log and the rollback: one statement per table and role (column-level REFERENCES, if 1
--      listed any, are written out after them). Save the single text value it returns:
--        select string_agg(s, E'\n' order by s) from (
--          select format('grant %s on table %s to %I%s;', string_agg(g.privilege_type, ', ' order by g.privilege_type),
--                        c.oid::regclass, g.grantee::regrole::text, case when g.is_grantable then ' with grant option' else '' end) as s
--          from pg_class c cross join lateral aclexplode(c.relacl) g
--          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--            and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--            and g.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN')
--          group by c.oid, g.grantee, g.is_grantable
--          union all
--          select format('grant references (%I) on table %s to %I;', a.attname, c.oid::regclass, g.grantee::regrole::text)
--          from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--          cross join lateral aclexplode(a.attacl) g
--          where c.relnamespace = 'public'::regnamespace and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--            and g.privilege_type = 'REFERENCES'
--        ) x;
--   3. Default privileges in `public`, who applies, and whether the supabase_admin step will run. Expect `postgres` and
--      `supabase_admin` rows for tables (r) granting anon and authenticated `arwdDxt` (`arwdDxtm` on PG17); then the server
--      version (170000 or later on Supabase), the applying role (`postgres`) and `f` for supabase_admin membership (that step
--      is then skipped; `t` means it runs too); then 0 (every public table owned by a role the applier can act for):
--        select defaclrole::regrole, defaclobjtype, defaclacl from pg_default_acl
--          where defaclnamespace = 'public'::regnamespace order by 1, 2;
--        select current_setting('server_version_num')::int, current_user,
--               pg_has_role(current_user, 'supabase_admin', 'member');
--        select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f')
--          and not pg_has_role(current_user, relowner, 'member');
--      and, for the log, the sequence grants (post-apply 3 expects the same rows; `issues_seq_seq` is the only sequence, and where
--      Supabase's sequence defaults reached it anon and authenticated hold SELECT, UPDATE, USAGE on it):
--        select c.relname, g.grantee::regrole::text, string_agg(g.privilege_type, ', ' order by g.privilege_type)
--        from pg_class c cross join lateral aclexplode(c.relacl) g
--        where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
--          and g.grantee in ('anon'::regrole, 'authenticated'::regrole) group by 1, 2 order by 1, 2;
--   4. The DML grants to keep: per table, how many table-level and column-level grants of SELECT, INSERT, UPDATE and DELETE
--      anon and authenticated hold. Save it; post-apply 2 must return exactly the same rows:
--        with g as (
--          select c.relname, false as col, x.grantee, x.privilege_type
--          from pg_class c cross join lateral aclexplode(c.relacl) x
--          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--          union all
--          select c.relname, true, x.grantee, x.privilege_type
--          from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--          cross join lateral aclexplode(a.attacl) x
--          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--        ), counts as (
--          select relname,
--                 count(*) filter (where grantee = 'anon'::regrole and not col) as anon_table,
--                 count(*) filter (where grantee = 'authenticated'::regrole and not col) as auth_table,
--                 count(*) filter (where grantee = 'anon'::regrole and col) as anon_column,
--                 count(*) filter (where grantee = 'authenticated'::regrole and col) as auth_column
--          from g where privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
--            and grantee in ('anon'::regrole, 'authenticated'::regrole)
--          group by relname
--        )
--        select relname, anon_table, auth_table, anon_column, auth_column from counts order by relname;
--
-- POST-APPLY CHECK:
--   1. Nothing left: no TRUNCATE, TRIGGER, REFERENCES or MAINTAIN for anon or authenticated on any public relation, table- or
--      column-level. Expect 0, then 0:
--        select count(*) from pg_class c cross join lateral aclexplode(c.relacl) g
--        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--          and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
--        select count(*) from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
--        cross join lateral aclexplode(a.attacl) g
--        where c.relnamespace = 'public'::regnamespace and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--          and g.privilege_type = 'REFERENCES';
--      And by name, the same check through the information schema. Expect 0 rows:
--        select table_name, grantee, privilege_type from information_schema.role_table_grants
--        where table_schema = 'public' and grantee in ('anon', 'authenticated')
--          and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
--   2. DML unchanged: run preflight 4 again. Every row must equal the saved output (same tables, same four counts).
--   3. Default privileges: run preflight 3's first query. The `postgres` table row now grants anon and authenticated `arwd`;
--      the `supabase_admin` row is unchanged if preflight 3 said `f` (else `arwd` too). Sequence rows (S) are unchanged. Then
--      run preflight 3's sequence query: the same rows as before (a sequence can't hold the revoked privileges).
--   4. A new table gets no extra privilege. Expect `anon=arwd/postgres` and `authenticated=arwd/postgres` in the ACL (and
--      service_role's and postgres's entries as before), ROLLED BACK:
--        begin; create table public.zz_grants_probe (id int);
--        select relacl from pg_class where oid = 'public.zz_grants_probe'::regclass;
--        rollback;
--   5. The app: sign in and save a field; a share link opens. (DML grants are untouched, so nothing should change.)
--
-- ROLLBACK (one transaction): first run the text saved from preflight 2 (the exact grant-back, one GRANT per table and role),
-- then the block below, which puts Supabase's default privileges back as they were (`grant all` on tables made by `postgres`;
-- SELECT, INSERT, UPDATE and DELETE are already there, so this adds back only what was revoked):
--   begin;
--   -- <paste the text saved from preflight 2 here>
--   alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261224000000';
--   commit;
-- If preflight 3 said `t` (the supabase_admin step ran), also run, inside the transaction:
--   alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated;
-- If preflight 2's text was lost, this grants the privileges back on every public table where the role still holds any
-- table-level privilege (Supabase's default reached those; it may also add them back on a table whose migration revoked
-- everything and granted only SELECT): a fallback, not exact.
--     do $$ declare r record; begin
--       for r in select distinct c.oid::regclass as t, g.grantee::regrole::text as role
--         from pg_class c cross join lateral aclexplode(c.relacl) g
--         where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
--           and g.grantee in ('anon'::regrole, 'authenticated'::regrole)
--       loop execute format('grant all on table %s to %I', r.t, r.role); end loop; end $$;
--
-- Production data: none changes.

do $$
declare
  privs text := 'truncate, trigger, references';
  rel record;
begin
  -- MAINTAIN exists from Postgres 17 (Supabase runs 17); `grant all` included it there, so take it back too.
  if current_setting('server_version_num')::int >= 170000 then
    privs := privs || ', maintain';
  end if;

  -- 1. Every relation in public that exists now.
  for rel in
    select c.oid::regclass as name, pg_has_role(current_user, c.relowner, 'member') as mine
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by c.relname
  loop
    if rel.mine then
      execute format('revoke %s on table %s from anon, authenticated', privs, rel.name);
    else
      -- Only the owner (or a member of it) can revoke what the owner granted; post-apply 1 lists anything left.
      raise warning 'revoke_unused_table_privileges: % is not owned by a role % can act for; skipped', rel.name, current_user;
    end if;
  end loop;

  -- 2. New tables made by postgres (the app's migrations).
  execute format('alter default privileges for role postgres in schema public revoke %s on tables from anon, authenticated',
                 privs);

  -- 3. New tables made by supabase_admin, only where allowed (a member of supabase_admin; not `postgres` on Supabase).
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    if pg_has_role(current_user, 'supabase_admin', 'member') then
      execute format('alter default privileges for role supabase_admin in schema public revoke %s on tables from anon, authenticated',
                     privs);
    else
      raise notice 'revoke_unused_table_privileges: % is not a member of supabase_admin; its default privileges are unchanged',
                   current_user;
    end if;
  end if;
end;
$$;
$mig$]);

commit;
