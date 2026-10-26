# 19. Neon, Better Auth and Kysely replace Supabase; authorization stays in Postgres

Date: 26 Oct 2026 · Status: accepted · Supersedes ADR 0002 (already superseded by ADR 0018 for MCP) · The move off Supabase (`docs/plans/supabase-exit-brief.md`, steps 1 to 6)

## Context

Production ran on Supabase for the database, sign-in (Auth), file storage, Realtime and the Data API (PostgREST). Every deployment
of the product for a new client would need its own Supabase project and its own dashboard setup, and the app used only a part of
what Supabase provides. We want a stack that one script can stand up per client deployment, and that runs the same in tests as
in production.

## Decision

- **Database: Neon Postgres in Sydney (AWS ap-southeast-2)**, created from Vercel Storage; the app is hosted on Vercel (syd1).
  Plain Postgres: no Data API, no Storage, no Realtime. The migrations in `packages/db/migrations/` are unchanged SQL; a runner
  (`pnpm --filter @transpera-flow/db migrate`) applies them and keeps `public.schema_migrations`. A small compat layer
  (`packages/db/sql/compat.sql`) provides the `auth` schema functions and the `anon` and `authenticated` roles the policies use.
- **Sign-in: Better Auth with Google** (Microsoft-ready), running in the app at `/api/auth/*` and storing users in the
  `better_auth` schema. A trigger mirrors each user into `auth.users`, so foreign keys and policies written against it keep
  working, and existing users keep their ids. The deployment's access rules (domains, named emails, Admin/Editor/Viewer) are
  checked at every sign-in.
- **Queries: Kysely over a `pg` pool, with a `ClaimsDriver`.** Every statement runs in a short transaction that sets the role
  (`authenticated`, or `anon` when signed out) and `request.jwt.claims` with `set_config(..., true)`. Types are generated from the
  database (`gen:types`: `db-types.ts` by kysely-codegen, `function-types.ts` from `pg_proc`, which types `rpc()`).
- **Authorization stays in Postgres.** The row-level security policies and SECURITY DEFINER functions (per-person pay privacy,
  share-link redaction, the role matrix) keep enforcing access, unchanged and with their tests. Rewriting them in TypeScript
  would re-implement features we were told not to touch.
- **The app connects as `authenticator`**, a login with no privileges of its own that can only `SET ROLE` to `anon` or
  `authenticated` (`packages/db/scripts/create-app-login.sql`; its password is passed in, never committed). `APP_DATABASE_URL`
  holds it; `DATABASE_URL` is the owner, used only by migrations, Better Auth and the sign-in access functions. Where
  `APP_DATABASE_URL` is unset (local development) the app falls back to the owner, and the driver's claims are then the only guard.
- **Statement time limits are the driver's job now.** PostgREST applied each role's `statement_timeout` (Supabase: `anon` 3 s,
  `authenticated` 8 s) and a function's own `set statement_timeout`; `set_config('role', ...)` applies neither, so the claims
  statement sets 3 s or 8 s, and `rpc()`/`rpcRows()` read a function's `proconfig` timeout from the catalog and set it on the same
  connection and transaction before the call (Postgres starts the clock for the calling statement before a function's own setting
  takes effect, so the function attribute alone does not lengthen it). A heavy function states its limit in SQL; no default is raised.
- **Gone with Supabase:** file storage (sources are references to the original, step 4; the logo lives in the database),
  Realtime and presence (step 5), the `@supabase/*` packages, `lib/supabase`, `prod-sql.sh` and the SQL-editor bootstrap bundle.

## Consequences

- One Postgres is the only service to provision per deployment, plus an OAuth client. The same migrations and tests run on a
  local Postgres and on Neon.
- Neon closes idle connections when its compute suspends; the pool logs an idle client's error instead of crashing, and Vercel's
  Fluid compute drains pools with `attachDatabasePool`.
- A connection costs three round trips per statement outside `db.transaction()` (begin and claims, the statement, commit): a few
  milliseconds between syd1 and Neon Sydney.
- A function that must run longer than its role's limit needs `set statement_timeout` in its SQL, and is called through `rpc()`.
  A direct Kysely query is held to 3 s (`anon`) or 8 s (`authenticated`).
- `docs/production-migrations.md` keeps the Supabase log and starts a Neon log at the cutover.

## Alternatives considered

- **Stay on Supabase.** Works, but ties each client deployment to dashboard steps and a second set of services we barely use.
- **Drizzle.** Needs a TypeScript schema for 60 tables that would duplicate the SQL migrations. Kysely takes generated types and
  is what Better Auth's adapter uses.
- **PostgREST on Neon.** Keeps supabase-js, but adds a service to run per deployment for no gain once queries are in the server.
- **Authorization in app code.** The end state the product decisions point to, but not during the move: it would lose the
  existing policy tests. It remains possible later, because every access path already goes through one place.
