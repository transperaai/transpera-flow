-- Creates (or updates) the login the app's query pool connects with: `authenticator`, which can do nothing by itself and can
-- only become `anon` or `authenticated` (the ClaimsDriver switches to one with set_config('role', ...) for every transaction).
-- The password is passed in, never written to git; run it as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v app_password="$APP_PASSWORD" -f packages/db/scripts/create-app-login.sql
-- (or `db-sql.sh -v app_password=... -f ...`). Then APP_DATABASE_URL is DATABASE_URL with this user and password.
-- Safe to run again: it sets the password and re-grants.
\if :{?app_password}
\else
  \echo 'app_password is not set: pass it with -v app_password=...'
  -- Fails (exit status 3 under ON_ERROR_STOP), so a script that runs this one stops too.
  select 1 / 0 as app_password_is_not_set;
  \quit
\endif

select exists (select 1 from pg_roles where rolname = 'authenticator') as present \gset
\if :present
  alter role authenticator with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'app_password';
\else
  create role authenticator with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'app_password';
\endif

-- Run again on a role made some other way (Supabase's authenticator is also a member of service_role): no other membership,
-- and no grant of anon or authenticated (from whichever grantor) that is inherited or carries admin.
select format('revoke %I from authenticator granted by %I', g.rolname, gr.rolname)
from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles gr on gr.oid = m.grantor
where m.member = 'authenticator'::regrole and g.rolname not in ('anon', 'authenticated') \gexec
select format('revoke %s option for %I from authenticator granted by %I', o, g.rolname, gr.rolname)
from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles gr on gr.oid = m.grantor,
     lateral (values ('inherit', m.inherit_option), ('admin', m.admin_option)) as x(o, held)
where m.member = 'authenticator'::regrole and x.held \gexec

-- Not inherited (so it has none of their privileges until it switches), but it may SET ROLE to either.
grant anon, authenticated to authenticator with inherit false, set true;
