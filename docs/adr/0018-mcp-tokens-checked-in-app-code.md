# 18. MCP tokens are checked in app code, and every tool query runs under the owner's claims

Date: 26 Oct 2026 · Status: accepted · Supersedes ADR 0002 · Part of the move off Supabase (`docs/plans/supabase-exit-brief.md`, step 3)

## Context

ADR 0002 let the MCP endpoint act as a token's owner by sending the token to PostgREST in `x-api-token`, where a pre-request
hook (`private.api_token_pre_request`) looked it up and switched the transaction to `authenticated` with the owner's claims.
That hook is a PostgREST feature. After the move to Neon there is no PostgREST: the app talks to Postgres through Kysely and
a `ClaimsDriver` that sets the role and `request.jwt.claims` for each statement (step 1).

## Decision

- **The handler checks the token.** `handleMcpRequest` reads the bearer token, rejects anything that is not `tf_` plus 43
  URL-safe characters without touching the database, hashes it (SHA-256, lowercase hex, the same as before) and calls
  `public.mcp_token_lookup(hash)` as `anon`.
- **One narrow SECURITY DEFINER function does what the hook and `use_api_token` did.** It finds one live token (not revoked,
  its owner not banned), stamps `last_used_at`, counts the request in the token's one-minute window (120 a minute) and returns
  the owner's id, email and agency-admin flag, the token's id, its active workspace and whether the request is allowed. An
  unknown or revoked token, or a banned owner, returns no rows. It takes the hash, so the token itself never reaches SQL, and
  only `anon` may execute it. Its answer is a 401 (no rows) or a 429 with `Retry-After`; there is no "hook missing" state.
- **The owner is re-checked against the sign-in list on every request**, as a browser session is (`currentAccess` in
  `apps/web/src/lib/auth/access.ts`, passed as `checkUser`): someone taken off the deployment's list is refused with a 401,
  a demoted admin stops being an agency admin, and a guest's claims say so. `mcp_token_lookup`'s `agency_admin` is only the
  flag the last sign-in recorded.
- **Every tool runs as the owner.** The handler builds claims with the app's own `claimsFor` (the one place claims are made):
  `{ sub, role: "authenticated", email, app_metadata, api_token_id }`, and gives the tools `createDb(pool, claims)`. RLS, the
  SECURITY DEFINER functions and the `api_token_id` checks in SQL (a token may not write the company model directly) apply unchanged. `McpHandlerOptions` takes the pool and `claimsFor` instead of Supabase's
  URL and key; the web route passes `appPool()` and `claimsFor`.
- **Nothing in the MCP path can bypass RLS.** The pool's login is the database owner, so the role switch in the driver is the
  only thing between a statement and RLS-free access. The claims are built for `authenticated` only (a user and a token id, no
  role argument), and a test scans the MCP code path for any elevated-role or secret-key name (D12 stays).

## Consequences

- ADR 0002's hook, `use_api_token` and the `pgrst.db_pre_request` setting are no longer called. They stay in their migrations
  until step 6 removes Supabase; production on Supabase keeps working with the old code until the cutover.
- A token no longer works against a Data API directly, because there is none. It is a credential for `/api/mcp` only.
- The check is two round trips (lookup, then the tools' own statements), and the lookup writes (the stamp and the counter), so
  it runs on every POST, as `use_api_token` did.
- `set_active_workspace` still stores the active workspace on the token row (the endpoint is stateless), now updated through
  the owner's claims under the same RLS.
- Numbers and dates reach the tools as PostgREST sent them (`createPool` parsers), so tool results keep their shape.
- Tests: the MCP end-to-end suites run against a throwaway Postgres through the real handler, with no PostgREST container in CI.

## Amendment, 28 Oct 2026: MCP is read-only

Austin's decision (docs/plans/cut-list.md item 2): Claude and ChatGPT only query. The MCP server has no tool that writes company data,
sources, issues, drafts or processes, and no tool that proposes anything. Every tool is a read, run as the token owner under RLS.
The one thing a token still changes is its own `active_workspace_id` (`set_active_workspace`), which is the token's setting and not
workspace data. The database trigger that stops an API token writing the company model directly stays as a second lock. The upload
code that MCP used to share with the web app's "Upload process" moved to `packages/db/src/process-import` (`@transpera-flow/db/process-import`)
and only the web app calls it.
