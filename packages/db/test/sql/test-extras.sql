-- What the old auth shim granted beyond compat.sql, kept for tests that read auth.users or call auth functions as
-- service_role. Test-only: production grants none of this.
grant usage on schema auth to service_role;
grant select on auth.users to authenticated;
