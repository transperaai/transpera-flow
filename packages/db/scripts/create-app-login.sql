-- Creates (or updates) the login the app's query pool connects with: `authenticator`, which can do nothing by itself and can
-- only become `anon` or `authenticated` (the ClaimsDriver switches to one with set_config('role', ...) for every transaction).
-- The password is passed in, never written to git; run it as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v app_password="$APP_PASSWORD" -f packages/db/scripts/create-app-login.sql
-- (or `db-sql.sh -v app_password=... -f ...`). Then APP_DATABASE_URL is DATABASE_URL with this user and password.
-- Safe to run again: it sets the password and re-grants.
\if :{?app_password}
\else
  \echo 'app_password is not set: pass it with -v app_password=...'
  \quit
\endif

select exists (select 1 from pg_roles where rolname = 'authenticator') as present \gset
\if :present
  alter role authenticator with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password :'app_password';
\else
  create role authenticator with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password :'app_password';
\endif

-- Not inherited (so it has none of their privileges until it switches), but it may SET ROLE to either.
grant anon, authenticated to authenticator with inherit false, set true;
