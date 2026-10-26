# Moving off Supabase: migration brief

Opus brief, 26 Oct 2026. Implements decisions 2–7 of `docs/plans/rework-direction.md` (read it first). **No feature
cuts** (Austin, 26 Oct): port everything that exists. The only removals are the ones already decided: file uploads
become References, and live editing (Realtime and presence) goes. The multi-tenant machinery (workspaces, agency admin,
per-workspace roles, share links) stays until Austin's strip list.

Builders work strictly from their step's section. If something isn't covered, ask rather than guess. Commit and push
after every step.

## Facts this brief rests on (checked 26 Oct)

- Supabase project `vgsjkpwvxkpqvyazwcyq` (ap-southeast-2, Postgres 17.6) is `ACTIVE_HEALTHY`, and production is at
  migration row 72. Nothing below changes it until cutover.
- Vercel project `transpera-flow` (root `apps/web`, functions in `syd1`, production branch `main`, domain
  `transpera-flow.vercel.app`). Its env vars are `ANTHROPIC_API_KEY` and `NEXT_PUBLIC_SUPABASE_URL`/`_PUBLISHABLE_KEY`.
- Neon: the API key in this environment reaches one org, **"Vercel: Transpera AI"** (`org-jolly-moon-20532257`, free,
  managed by Vercel). It holds `founder-squared-db` and `factory-db`, and there is no Flow database yet. A Neon database in
  this org is created from the Vercel dashboard (Storage), which also writes `DATABASE_URL` into the Vercel project.
- Data access has one seam: `export type Db = SupabaseClient<Database>` in `packages/db/src/queries.ts`. There are 400
  `.from()` and 75 `.rpc()` calls outside tests, in about 70 files (`apps/web/src/app/w/[slug]` 16 files,
  `packages/db/src` 11, `packages/mcp/src` 11, and the rest in `apps/web/src/lib/*`). Only 2 selects embed a relation. 120 sites
  read `error.code`, and 13 use `count`/`head`.
- The browser Supabase client (`apps/web/src/lib/supabase/browser.ts`) exists only for Realtime.
- The SQL uses no extensions. In the migrations, `auth.jwt()` is read for exactly three things: `sub` (via `auth.uid()`),
  `app_metadata.agency_admin` and `api_token_id` (the MCP token, ADR 0002). Reads of `auth.users` use `id`, `email`,
  `email_confirmed_at` and `raw_app_meta_data.agency_admin`. Workspace domain joins read
  `auth.identities.identity_data.custom_claims.hd` (`20260930030000_workspace_access.sql`). `storage.*` and `realtime.*`
  appear only in the upload, branding and realtime migrations.
- The DB tests already run every migration on plain Postgres. They first load `packages/db/test/sql/auth-shim.sql`,
  `storage-shim.sql` and `realtime-shim.sql`, and `harness.ts` `as()` does exactly what production will do:
  `set local role authenticated` and `set_config('request.jwt.claims', …, true)` inside a transaction.

## Target architecture

```
Browser ──> Next.js (Vercel, syd1)
              ├─ Better Auth (/api/auth/*) ── pg Pool ──> Neon: schema better_auth (user, session, account, verification)
              └─ server code ── Kysely + ClaimsDriver ── pg Pool ──> Neon: public.* with RLS, as role authenticated/anon
MCP client ──> /api/mcp ── token checked in app code ──> same ClaimsDriver, claims carry api_token_id
```

**Authorization stays in Postgres during the move.** The existing RLS policies and SECURITY DEFINER functions (B1
per-person pay privacy, share-link redaction, role matrix) keep enforcing access. Every query runs as `authenticated`
or `anon` with Supabase-shaped claims, so `auth.uid()`/`auth.jwt()` keep working unchanged. Decision 4 ("authorization
lives in app code") is the end state for after the strip list. Rewriting the privacy rules in TypeScript now would
re-implement features we're told not to touch, and would lose their tests. The new deployment-level roles (Admin,
Editor, Viewer) are enforced in app code at sign-in and mapped onto the existing model (step 2).

**Query layer: Kysely**, not Drizzle. Drizzle needs a TypeScript schema for 60 tables that would duplicate the SQL
migrations. Kysely takes generated types (`kysely-codegen` against a database built from the migrations), its builder
reads close to postgrest-js, and Better Auth's built-in adapter is Kysely too.

**Driver: `pg` (node-postgres)** against Neon's pooled connection string. It works on Vercel Fluid compute (use
`attachDatabasePool` from `@vercel/functions`) and in tests against local Postgres. One Pool per process, from
`DATABASE_URL`.

**ClaimsDriver** (the heart of step 1). `createDb(claims | null)` returns a `Kysely<DB>` whose driver wraps Kysely's
`PostgresDriver`:
- `acquireConnection`: take a pool client and send one simple-protocol round trip:
  `begin; select set_config('role', '<authenticated|anon>', true), set_config('request.jwt.claims', <quoted json>, true)`.
  Quote with `pg`'s `escapeLiteral`.
- `releaseConnection`: send `commit` (Postgres turns a commit of an aborted transaction into a rollback), then release.
  If the client errored or broke, release it with `release(err)` so the pool drops it.
- `beginTransaction`/`commitTransaction`: no-ops, because the connection is already in a transaction.
  `rollbackTransaction`: `rollback`. This lets `db.transaction().execute()` work, and a rollback really rolls back.
- So every statement outside `db.transaction()` is its own short transaction under the caller's claims (three round
  trips, a few ms each between syd1 and Neon Sydney; measure in step 1). Nothing exported runs as the owner role, except the Better Auth Pool and
  `packages/db/scripts`.

**Type parsing must match PostgREST**, or values change type all over the app: set `pg.types` parsers so that
`numeric` (1700) and `int8` (20) parse to `number`, and `timestamptz` (1184), `timestamp` (1114) and `date` (1082) stay
**strings**. `json`/`jsonb` already parse. Check with a test that loads a row of each type through `createDb`.

**Claims** are built in exactly one place (`apps/web/src/lib/db/claims.ts`):
`{ sub, role: "authenticated", email, app_metadata: { agency_admin } }` for a signed-in user, plus `api_token_id` for MCP.
Signed out it's `null` (role `anon`).

## Order of work

Everything lands on the integration branch `claude/supabase-migration-plan-mzchlf`, one commit series per step. Opus
reviews each step before the next starts. `main` (production on Supabase) is untouched until the cutover PR. Vercel
builds a preview of the branch on every push, and Austin points its Preview env at Neon (setup steps below).

| Step | What | Needs Neon/Google? |
|---|---|---|
| 1 | Neon schema: compat SQL, migration runner, `createDb` + ClaimsDriver, generated Kysely types | no |
| 2 | Better Auth: Google now, Microsoft-ready, deployment access (domains/emails → Admin/Editor/Viewer) | live test only |
| 3 | Port supabase-js to Kysely in one parallel wave (3a–3e by package and folder; MCP token auth moves into app code) | no |
| 4 | References replace uploads; logo in the database; drop Storage | no |
| 5 | Drop Realtime and presence | no |
| 6 | Ops: `psql "$DATABASE_URL"` scripts, migration log, remove `@supabase/*` | no |
| 7 | Data copy from Supabase and cutover | yes, plus Austin's go-ahead |
| 8 | Per-client deployment template | yes |

Step 3 runs as one wave of parallel builders after step 2, because every call site needs `getDb()`. Steps 4 and 5 come
after 3, since they edit files that 3 ports.

## Step 1: Neon schema, compat layer and `createDb`

**Files**
- `packages/db/sql/compat.sql` (new): the production version of `test/sql/auth-shim.sql`. It creates roles `anon`,
  `authenticated` and `service_role` if missing (nologin; `service_role` gets `bypassrls` only if the current role is
  allowed to grant it, otherwise it skips and raises a notice), then `grant anon, authenticated, service_role to current_user`,
  so the app login can `set role`. It creates schema `auth` with tables `auth.users` and `auth.identities` (same columns as the
  shim) and functions `auth.uid()`, `auth.jwt()` and `auth.role()` (same bodies as the shim), and grants `usage` on schema
  `auth` and `execute` on those functions to `anon` and `authenticated`.
  It is idempotent (`if not exists` / `create or replace`).
- `packages/db/sql/legacy-shims.sql` (new): the storage and realtime stand-ins, copied from `test/sql/storage-shim.sql` and
  `realtime-shim.sql`, so rows 1–72 apply unchanged. Steps 4 and 5 add migrations that drop what depends on them.
- Move `packages/db/supabase/migrations/` → `packages/db/migrations/` (git mv; keep file names). Move `seed.sql` and
  `bootstrap.sql` next to them, and update every path that reads them (`grep -rn "supabase/migrations\|supabase/seed\|supabase/bootstrap"`).
  Delete `packages/db/supabase/config.toml`.
- `packages/db/scripts/migrate.ts` (new; run with `node --experimental-strip-types`, like the other scripts). It connects to
  `DATABASE_URL`, applies `compat.sql` and `legacy-shims.sql` (idempotent), then each file in `migrations/` not yet in
  `public.schema_migrations (version text primary key, applied_at timestamptz default now())`, each in its own
  transaction, and records it. Flags: `--dry-run` lists the pending files; `--seed` also loads `seed.sql` (for local dev
  and tests only). Add `"migrate": "node --experimental-strip-types scripts/migrate.ts"` to `packages/db/package.json`.
- `packages/db/test/harness.ts`: build the test database by calling the same apply function the runner uses (export it
  from `migrate.ts` or from a small `src/migrations.ts`), so tests and Neon run identical SQL. Keep the
  `supabaseDefaultPrivileges` and `realtime` options working (the realtime shim now always loads; the option can become a
  no-op). The existing auth shim's extras that tests rely on stay available in tests.
- `packages/db/src/client.ts` (new): `createPool(url)`, `createDb(pool, claims)` and the ClaimsDriver, as specified above,
  plus the type parsers. Export from `src/index.ts`. Add `kysely` and `pg` as dependencies (pg moves from dev to normal).
- `packages/db/src/db-types.ts` (generated) and a `gen:types` script that rebuilds a throwaway database with the runner
  and runs `kysely-codegen --dialect postgres --include-pattern 'public.*'` (pin versions). Keep `database.types.ts` for
  now: steps 3a–3d still compile against it until the port finishes, and step 6 deletes it.
- Do **not** change `export type Db` yet. Step 3a switches it.

**Tests** (`packages/db/test/client.test.ts`)
- `createDb` with user claims: `auth.uid()` returns the sub, and a table under RLS shows only that user's rows (reuse an
  existing fixture from `access.test.ts`).
- `createDb(null)` runs as `anon`, and an RLS-protected table returns no rows.
- `db.transaction()` that throws rolls back, and claims still apply inside it.
- A failed statement doesn't poison the pool: the next query on the same pool succeeds.
- Type parsing: numeric → number, int8 → number, timestamptz/date → string, jsonb → object.
- The runner applies to an empty database, is a no-op the second time, and `--dry-run` lists nothing after.
- The whole existing DB suite still passes.

**Done when** `pnpm lint && pnpm typecheck && pnpm test` pass, and `node … migrate.ts` against a fresh local database
(`createdb flow_dev`) builds the full schema plus seed.

**Out of scope:** any call-site changes, Better Auth, Neon itself (`docs/supabase-notes.md` gets a line on what was
verified only on plain Postgres).

## Step 2: Better Auth with deployment access

**Packages:** `better-auth` (pin the current version; read its docs for Next.js App Router, the Kysely/pg adapter,
`databaseHooks`, `socialProviders.google` (`hd`, `prompt`), `socialProviders.microsoft` (`tenantId`) and the `oAuthProxy`
plugin for preview URLs).

**Schema** (migration `packages/db/migrations/20261228000000_better_auth.sql`, row 73):
- Schema `better_auth` with Better Auth's tables (`user`, `session`, `account`, `verification`), generated with its CLI
  (`npx auth generate` for Kysely emits SQL) and committed as SQL. `user.id` is `uuid` (`advanced.database.generateId: "uuid"`).
- Trigger `better_auth.sync_auth_user()`, after insert or update on `better_auth."user"`, upserts `auth.users (id, email,
  email_confirmed_at = case when emailVerified then coalesce(existing, now()) end, raw_user_meta_data = {full_name,
  avatar_url})`. Every one of the 62 foreign keys to `auth.users` then keeps working.
- `public.deployment_access`: `(id, kind text check in ('domain','email'), value text, role text check in
  ('admin','editor','viewer'), unique(kind, lower(value)))`, with RLS so that only agency admins can read or write it, plus two
  SECURITY DEFINER helpers. The server checks sign-in with `private.deployment_role(email text, email_verified bool)`
  returning `'admin'|'editor'|'viewer'|null`. The rule: a named email wins over a domain, the domain match is the exact
  part after `@`, and unverified emails get null.
- Bootstrap: env `ACCESS_ADMIN_EMAILS` (comma-separated) counts as named-email `admin` rows, so a new deployment's first
  admin can sign in before the table has rows.

**Mapping onto the existing model** (Opus default, see "Questions for Austin"):
- `admin` → `auth.users.raw_app_meta_data.agency_admin = true` (exactly what `make-agency-admin.sql` does today).
- `editor` / `viewer` → on each sign-in, ensure a membership in every workspace, with role `editor` / `viewer`.
  Never lower an existing membership (an owner stays owner), and never remove one.
- No match → the sign-in is refused (a `databaseHooks.user.create.before` returning false, plus a check in the session
  hook for existing users whose access was removed), and they see "Your account isn't on this workspace's access list".
- Per-workspace domain joins and invites (ADR 0003, ADR 0012) keep working through `auth.identities`. On Google sign-in,
  write an `auth.identities` row `(provider 'google', provider_id = Google sub, identity_data = { email, custom_claims: { hd } })`
  from the ID token (Better Auth's `account` holds the id token; or capture `hd` in `mapProfileToUser`). Do the same for
  `microsoft` with `tid` when it lands.

**Providers** are per deployment: `AUTH_PROVIDERS=google` (default) or `google,microsoft`. Google reads
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, scopes `openid email profile`, `prompt: "select_account"`. Microsoft reads
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_TENANT_ID` (the client's tenant id restricts sign-in to that
tenant). It is wired and unit-tested but not enabled anywhere yet. Secrets: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.

**Preview sign-in.** Google allows only fixed redirect URIs, and production keeps running Supabase code until cutover, so
it can't act as the OAuth proxy yet. The integration branch therefore gets a stable alias, `transpera-flow-next.vercel.app`
(a Vercel project domain bound to the branch; Opus adds it through the Vercel API). Its callback goes on the Google
client, and `BETTER_AUTH_URL` for Preview is that alias. Add the `oAuthProxy` plugin with `productionURL` from
`BETTER_AUTH_URL` and `secret` from `OAUTH_PROXY_SECRET`, and set `trustedOrigins` to the alias plus
`https://transpera-flow-*.vercel.app`, so per-commit preview URLs sign in through the alias. After cutover, production
takes over as the proxy.

**App changes**
- `apps/web/src/lib/auth/server.ts` (new): the `betterAuth()` instance, its own `pg` Pool on `DATABASE_URL`, with
  `database.schemaName: "better_auth"`. Don't use a `search_path` startup option: Neon's pooled connections reject
  startup parameters. `apps/web/src/app/api/auth/[...all]/route.ts`: the Better Auth handler.
- `apps/web/src/lib/auth/session.ts` (new): `getSessionUser()` (cached per request with React `cache`) returns
  `{ id, email, agencyAdmin }` or null. `getDb()` returns `createDb(pool, claimsFor(user))`. This replaces
  `lib/supabase/server.ts` `createClient()` as the thing call sites import (steps 3c and 3d switch them).
- `apps/web/src/proxy.ts`: replace the Supabase refresh with Better Auth's cookie check (`getSessionCookie` for the fast
  redirect; real validation happens in `getSessionUser`). Keep `PUBLIC_PATHS`, the `/api/mcp` bypass, and add `/api/auth`.
- `lib/auth/google-sign-in.ts` → `signIn.social` with `callbackURL`. Delete `app/auth/callback`. `app/auth/signout`
  calls `auth.api.signOut`. The share-link restricted sign-in (B3) returns to the link after sign-in, as today.
- `apps/web/src/lib/access-data.ts` reads `user_metadata` from claims today; read the name from the session user instead.
- Admin UI: Settings → Access gets a "Who can sign in" section for agency admins, listing domain and email rules with their
  roles. Copy the existing access page's patterns.

**Tests:** `private.deployment_role` matrix (email beats domain, case-insensitive, subdomain doesn't match, unverified gets
null); the sync trigger writes `auth.users`; the editor/viewer membership sync never lowers an owner; an unknown email
is refused; a proxy redirect when there's no session cookie. Better Auth's own OAuth flow isn't unit-tested. Austin
checks it live.

## Step 3: port supabase-js to Kysely (one parallel wave)

**Contract first (Opus, one commit before the wave):** `export type Db = Kysely<DB>` in `packages/db/src/queries.ts`
(type-only import, so the package root stays browser-safe). `rpc`/`rpcRows` helpers live in
`@transpera-flow/db/client`. `getDb()` and `getSessionUser()` live in `apps/web/src/lib/auth/session.ts` (step 2), and a
shared test helper builds a `Db` on a throwaway database for given claims (`packages/db/test/harness.ts`, exported for
the other packages' tests). After this commit the tree doesn't typecheck until the wave lands; that's expected on the
integration branch.

**Wave: five Sonnet builders in parallel worktrees, each owning disjoint files.** Every function's signature stays the
same apart from the `db` parameter's type, so their work meets cleanly:

| Builder | Owns (source and its tests) |
|---|---|
| 3a | `packages/db/src/**`, `packages/db/test/**` |
| 3b | `packages/mcp/src/**`, `packages/mcp/test/**`, `apps/web/src/app/api/mcp/**`, `.github/workflows/ci.yml` |
| 3c | `apps/web/src/lib/**` (except `lib/auth`, `lib/realtime`), their tests in `apps/web/test` |
| 3d | `apps/web/src/app/w/[slug]/**/*actions*.ts` and `apps/web/src/app/actions.ts`, their tests |
| 3e | the rest of `apps/web/src/app/**` (pages, layouts, route handlers, `s/[token]`, `settings/tokens`), `apps/web/src/components/**`, `apps/web/stories/**`, their tests |

A builder that needs a change in a file it doesn't own stops and reports it, rather than editing.

Rules for every call site:
- `const supabase = await createClient()` → `const db = await getDb()`. `supabase.auth.getClaims()`/`getUser()` used to
  learn who is signed in → `getSessionUser()`.
- `check(await db.from(t).select(cols)…)` → `await db.selectFrom(t).select([...])…execute()`. Use
  `executeTakeFirst()` for `.maybeSingle()` and `executeTakeFirstOrThrow()` for `.single()`. For `.insert(...).select()`,
  use `returning`. For upserts, use `onConflict(oc => oc.columns([...]).doUpdateSet(...))` with the same conflict columns.
- `.rpc(name, args)` → `rpc(db, name, args)` for scalar functions and `rpcRows(...)` for set-returning ones. Named
  arguments, the same names as today.
- Errors: a thrown `pg` error carries the same SQLSTATE `code` that PostgREST passed through, so `error.code === "23505"`
  checks keep their meaning, but they move from `{ error }` destructuring to try/catch. `PGRST116` → Kysely's
  `NoResultError`. Port each `error.code` site deliberately, and keep the user-facing messages identical.
- `count: "exact", head: true` → `select(eb => eb.fn.countAll<number>().as("count"))`, then `Number(...)`.
- Embedded selects (two of them): an explicit join, or a second query, returning the same shape.
- Values: numbers and JSON come back as they did, and timestamps come back in the same ISO text as PostgREST (step 1's
  parsers). Don't add conversions at call sites.
- Keep each function's return shape exactly. Its callers and tests depend on it.

Tests:
- Tests that fake the supabase-js builder (`vi.mock("@/lib/supabase/server", …)`, 16 web files, plus MCP fakes) are
  rewritten to run against a throwaway Postgres through the shared harness, mocking only `@/lib/auth/session` to return
  a real `Db` for chosen claims. Keep every assertion's intent. Where a fake checked which filters were applied,
  assert the observable result instead.
- The MCP `postgrest-*` end-to-end suites, which skip without PostgREST, run directly against the throwaway database
  through the new handler. So 3b turns about 230 skipped tests into running ones, and CI drops its PostgREST container.

3b also replaces the PostgREST pre-request hook (ADR 0002). `/api/mcp` hashes the bearer token and looks it up with
the existing SQL from `20260930040000_api_tokens.sql` (read the hook function; reuse its checks: expiry, revocation and
last-used stamping). The lookup runs as the owner inside a narrow SECURITY DEFINER function if one doesn't exist.
Then `createDb` builds claims `{ sub: user_id, role: "authenticated", api_token_id }`. Write a short ADR (0018)
superseding 0002.

**After the wave:** Opus merges the five branches, fixes the seams until `pnpm lint && pnpm typecheck && pnpm test` pass,
then reviews adversarially. The review looks hardest at error-code handling, `.single()` semantics, upsert conflict
targets, and anything that ran as `service_role`.

## Step 4: References in place of uploads; logo in the database; no Storage

Facts: `public.sources` already has `file_url` (an http(s) link, 2000 characters at most) next to `title`, `kind`,
`speakers`, `recorded_at` and `body`. Migration `20261204000000` added the uploaded original (`file_path`, `file_name`,
`file_type`, `file_size`) in the private `sources` bucket. The logo lives in the public `branding` bucket, and its path
is in `workspaces.branding` (`20261214000000`). Storage is called from `app/w/[slug]/source-actions.ts`
(`deleteSource`, `attachSourceFile`, `sourceFileLink`), `settings/branding/actions.ts`, `lib/sources/upload.ts` and
`lib/branding/upload.ts`, all marked `// step 4`.

- **A reference is a source's title plus `file_url`.** The UI calls it a link ("Link to the original", opening in a new
  tab), and it is offered wherever the upload was: the sources library, the source form, the evidence pickers and
  MCP `add_source`/`update_source`. Pasted text (`body`) stays exactly as it is, and so does AI analysis over it.
- **Remove the upload path:** `attachSourceFile`, `sourceFileLink`, file removal in `deleteSource`, `lib/sources/upload.ts`,
  the file UI, the PDF text reading (`unpdf`) and its `outputFileTracingIncludes` entry, and their tests. Removing a test
  is right only where the feature it covers is removed. List each one in the report.
- **Logo in the database:** a new table `public.workspace_logos (workspace_id pk → workspaces on delete cascade, mime text,
  bytes bytea ≤ 256 KB, sha256 text, updated_at)`. RLS: editors of the workspace write (the same rule the branding
  action enforces today; read it). A SECURITY DEFINER `public.workspace_logo(p_workspace uuid)` returns `mime, bytes,
  sha256` and is executable by `anon` and `authenticated`, which matches the public bucket. A route
  `app/api/branding/[workspaceId]/logo/route.ts` serves it with `ETag` = sha256, `Cache-Control: public, max-age=300`, and 304
  on a match. `workspaces.branding` keeps its other keys, and the logo URL the UI uses becomes that route plus `?v=<sha
  prefix>`. Keep the existing type and size checks and the SVG sanitising in `lib/branding/upload.ts`. Only the
  destination changes.
- **Migration** `20261230000000_references_and_logos.sql`: create `workspace_logos` and its function; drop the
  `sources` file constraints and columns and every policy or trigger that reads `storage.objects` (find them in
  `20261204000000` and `20261214000000`), and remove the logo path key from `workspaces.branding`. The legacy shims stay,
  because older migrations still need them to apply.
- **Data:** none of this touches Supabase. Step 7 lists every Storage object so Austin can re-host what they want
  as links, and copies the current logo into `workspace_logos`.

## Step 5: drop Realtime and presence

- Delete `apps/web/src/lib/realtime/*`, `lib/supabase/browser.ts`, the presence UI (avatars of who else is here) and
  the live-change listeners. Pages keep their normal refresh after their own writes (`revalidatePath`/`router.refresh`).
  The "someone else changed this" conflict handling that comes from per-field saves (ADR 0001) stays, because it's
  database-side.
- **Migration** `20261231000000_drop_realtime.sql`: drop the triggers, functions and `realtime.messages` policies from
  `20261007000000_realtime.sql`, and take the tables out of the publication if they were added. Leave the shim.
- Mark ADR 0005 "Superseded: live editing removed (26 Oct 2026)". Remove the tests for the removed code and list them.

## Step 6: ops and the last of Supabase

- **Function types:** `gen:types` also writes `src/function-types.ts` (each public function's argument names and types, and
  its return type, from `pg_proc`). It replaces `database.types.ts`, which `rpc`/`rpcRows` and a few row types still use.
  Delete `database.types.ts` and the Supabase generator script.
- Remove `@supabase/*` from every package, along with `lib/supabase/*`, `supabaseEnv()`, `NEXT_PUBLIC_SUPABASE_*` reads
  and `packages/db/scripts/prod-sql.sh`. Add `packages/db/scripts/db-sql.sh` (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"`).
  Remove the `supabaseDefaultPrivileges` test option once nothing needs it.
- **App login:** a migration creates no role, because passwords don't belong in migrations. `scripts/create-app-login.sql`
  creates `authenticator` (login, noinherit, member of `anon` and `authenticated` with SET), with its password passed as
  a psql variable. `lib/db/pool.ts` uses `APP_DATABASE_URL` when it is set and falls back to `DATABASE_URL`. Opus
  creates the role on Neon and sets `APP_DATABASE_URL` in Vercel through the API, never printing the password.
- **Docs:** README, CLAUDE.md and `apps/web` docs describe Neon, Better Auth and `pnpm --filter @transpera-flow/db
  migrate`. `docs/production-migrations.md` starts a Neon section. The privacy page names Neon (database, Sydney) and
  Vercel (hosting) instead of Supabase, and says sign-in is Google, handled by the app.
- **Statement time limits (regression found in the step 3 review).** PostgREST applied each role's `statement_timeout`
  (Supabase: anon 3 s, authenticated 8 s) and a function's own `set statement_timeout` from `proconfig` (for example, the
  40 s on `import_workspace_bundle`). `set_config('role', …)` applies neither. The ClaimsDriver's claims statement sets
  `statement_timeout` for the transaction (anon 3 s, authenticated 8 s). `rpc`/`rpcRows` read the function's
  `proconfig` timeout in the same cached catalog lookup as the json arguments, and when there is one, they run
  `set_config('statement_timeout', …, true)` and the call on one connection (`db.connection()`), in that order. Tests:
  `pg_sleep` past the limit is cancelled (57014), and a function with its own longer limit isn't. Heavy tests that
  legitimately run longer get a function-level setting, not a raised default.
- The Supabase environment variables in Vercel are removed after cutover, not in this step.

## Step 7: data copy and cutover

1. **Freeze**: Austin agrees a window. Production shows a read-only banner (env flag), or simply nobody edits.
2. **Export** (needs Austin to allow production reads: auto mode blocks `prod-sql.sh`): for every `public` table,
   plus `auth.users` and `auth.identities`, in dependency order, use `select json_agg(t) from <table> t` via the Management
   API, saved to the scratchpad and never committed. The data is expected to be small; check the database size first.
3. **Import** into Neon with the runner's schema already applied: insert as the owner with
   `session_replication_role = replica` (no triggers or FKs during load), then reset sequences.
   Existing users keep their uuid: `auth.users` rows are copied, and for each, a `better_auth."user"` row with the same
   id plus an `account` row (`providerId 'google'`, `accountId` = the Google sub from `auth.identities.provider_id`), so their
   next Google sign-in lands on the same user.
4. **Verify**: row counts per table match, the DB test suite runs against a Neon branch of the copy, and Austin signs in
   on the preview and checks Northbeam and one client workspace.
5. **Switch**: merge the integration PR to `main`. Production env has `DATABASE_URL`, `BETTER_AUTH_*` and `GOOGLE_*`.
   Redeploy.
6. **Rollback**: Vercel instant rollback to the last Supabase deployment. The Supabase project is untouched, so it's
   immediately consistent; writes made on Neon after the switch would be lost, so keep the watch window short. Keep the
   Supabase project for 30 days after a clean cutover, then Austin deletes it.

## Step 8: per-client deployment template (outline)

A checklist plus a `scripts/new-client.sh` that walks through it: a Vercel project from this repo, a Neon database
from Vercel Storage, env vars (`ACCESS_ADMIN_EMAILS`, `AUTH_PROVIDERS`, Google/Microsoft ids), the redirect URI to add
to the OAuth app, `pnpm --filter @transpera-flow/db migrate`, and a first sign-in.

## What Austin sets up (no keys in chat, ever)

**A. Neon database (5 minutes, after step 1 is reviewed)**
1. Vercel dashboard → team "Transpera AI" → project **transpera-flow** → **Storage** tab → **Create Database** →
   **Neon** (Serverless Postgres) → Continue.
2. Region **Sydney (aws-ap-southeast-2)**, plan **Free**, name `transpera-flow-db` → Create.
3. On "Connect project", choose environments **Development** and **Preview** only (not Production until cutover), and
   leave the prefix empty so the variable is `DATABASE_URL`. If it offers to create a database branch for each preview
   deployment, leave that **off**. → Connect.
4. Tell Claude "Neon is created". Claude finds it through the Neon API that's already connected here, applies the
   migrations, and checks it. You never copy a connection string.

**B. Google OAuth (10 minutes, after step 2 is reviewed)**
Use the Google Cloud project that already holds the OAuth client Supabase uses today.
1. https://console.cloud.google.com/apis/credentials → pick that project → **Create credentials → OAuth client ID** →
   type **Web application**, name `Transpera Flow`.
2. **Authorised JavaScript origins:** `https://transpera-flow.vercel.app` and `http://localhost:3000`.
   Also add `https://transpera-flow-next.vercel.app` (the preview alias for this work).
3. **Authorised redirect URIs:** `https://transpera-flow.vercel.app/api/auth/callback/google`,
   `https://transpera-flow-next.vercel.app/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`.
   Other preview URLs sign in through the alias (Better Auth's OAuth proxy), so they need no URI of their own.
4. **Create**. Leave the dialog open and, in another tab, open Vercel → transpera-flow → Settings → **Environment Variables**:
   add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (tick **Sensitive**) for **Preview** and **Development**. Paste
   them straight from Google into Vercel, not into chat.
5. **OAuth consent screen** (Google Auth Platform → Branding/Audience): app name "Transpera Flow", user type
   **External**, publishing status **In production**. The scopes are only `openid email profile`, so Google needs no
   verification.
6. Tell Claude "Google is set". Claude sets `BETTER_AUTH_SECRET` and `OAUTH_PROXY_SECRET` (random, generated and sent
   straight to Vercel via its API, never printed), `BETTER_AUTH_URL` and `ACCESS_ADMIN_EMAILS=austinsmith1704@gmail.com`.

One OAuth client serves every client deployment: each new deployment adds its own redirect URI (step 8). A client that
wants its own consent-screen name gets its own client later.

## Questions for Austin (defaults used until answered)

1. **Deployment roles vs workspace roles.** Default: Admin = agency admin (sees and manages every workspace). Editor and
   Viewer are added to every workspace at that role on sign-in, never lowering someone already there (an owner stays
   owner). The existing per-workspace invites and domain joins keep working.
2. **MCP** stays (no cuts), with token checks moved into app code (step 3b).
