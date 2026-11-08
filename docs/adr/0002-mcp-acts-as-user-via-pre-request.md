# MCP acts as the user through a PostgREST pre-request hook

Date: 5 Oct 2026 · Status: Superseded by 0018 (`0018-mcp-tokens-checked-in-app-code.md`)

The MCP endpoint (`/api/mcp`) must run every query as the API token's owner under RLS and never hold the service-role key (PRD §7.1, §10, D12). Supabase decides who a Data API request is from the request's JWT, and we can't mint JWTs (no JWT signing secret in the app). So the endpoint talks to the Data API with the **publishable key** and sends the caller's token in an `x-api-token` header. A PostgREST **pre-request function** (`private.api_token_pre_request`, registered on the `authenticator` role by migration `20260930040000_api_tokens.sql`) hashes the token, looks it up with a narrow security-definer function that resolves one live token to its owner's claims and nothing else, sets `request.jwt.claims` to those claims and runs `set local role authenticated`. From then on the transaction is the user, exactly as if they were signed in: `auth.uid()`, `app_metadata.agency_admin` and every RLS policy apply unchanged. The Supabase data code (`packages/db/src/queries.ts`) is shared with the web app.

## Why this shape

- **No impersonation key on the server.** The endpoint holds only the publishable key. It can't act as anyone without a valid token, and a token can do no more than its owner. The service-role key and a direct Postgres connection string would each let the server impersonate every user.
- **Real RLS, not re-implemented checks.** The alternative of one security-definer RPC per tool would bypass RLS and duplicate the access rules in every function.
- **Only the hash is stored** (`api_tokens.token_hash`, SHA-256 of a 256-bit random token; a slow hash adds nothing at that entropy).

## Consequences

- The hook runs before **every** Data API request. Without the header it returns immediately. It is not security definer and has no `set` clause, because Postgres forbids `SET ROLE` in security-definer functions and a function-level `set` would undo the transaction-local settings on return. `SET ROLE` is checked against the session user (`authenticator`, a member of `authenticated`), so it works from `anon`. It refuses a token on a request that already carries a session JWT.
- A token also works directly against the Data API (it is a credential for its owner, like a session). Per-token rate limiting (120 requests/minute, `use_api_token`) applies to the MCP endpoint only, because GET requests run read-only and can't count.
- `pgrst.db_pre_request` has one slot. Any future pre-request logic must be added to this function.
- The hook covers the Data API only, not Realtime or Storage; the MCP path uses neither.
- The endpoint is stateless (Vercel functions share no memory), so the active workspace is stored per token (`api_tokens.active_workspace_id`), and every tool also accepts a `workspace` argument.
- If the hook is missing (e.g. the `alter role` did not apply), `use_api_token` reports `acting_as_user: false` and the endpoint returns 503 instead of running queries as `anon`.
