# Rework direction (Austin, 26 Oct 2026)

Decisions taken in conversation on 26 Oct 2026. They supersede the multi-tenant, Supabase-based design wherever the two
conflict. Nothing below is built yet. The next session plans the strip list with Austin, then builds in this order:
**strip first, then move off Supabase**, so we never port features that are about to be deleted.

## Why

On 26 Oct the free Supabase project had been paused for inactivity: about 5 weeks unused, and free projects pause after
about 7 days. Claude restored it the same day through the Management API (`POST /v1/projects/{ref}/restore`), and all
data was intact. Austin wants the running cost to be **practically free**, with nothing that pauses and has to be
restored by hand.

## Decisions

1. **One deployment per client.** The app is deployed once for each client, not as one multi-tenant system. The
   machinery for keeping clients apart can go: workspaces as tenants, the agency-admin role, cross-workspace RLS and
   share-link redaction across tenants. Austin will say what else to strip. That list comes first in the next session.
2. **Database: Neon**, one free project per client. The free plan has 0.5 GB of storage and 100 CU-hours per project
   per month. Compute scales to zero after 5 minutes idle and resumes on the next request, so there is no manual
   restore. https://neon.com/docs/introduction/plans
3. **Sign-in: Better Auth**, inside the app, with users stored in the client's own database. It needs no outside
   service and costs nothing.
   - **Google now, Microsoft (Entra ID) later.** Design for both from the start, so adding Microsoft for a client is
     configuration, not a rebuild. The provider list is a per-deployment setting. Verify Better Auth's built-in
     `microsoft` provider (tenant restriction) and its SSO plugin (OIDC/SAML) against the current docs when planning.
   - **Access is role-based**, configured per deployment:
     - **Company domains.** Anyone signing in with a verified address on an allowed domain (for example
       `client.com`) gets in with a default role.
     - **Named emails.** Specific addresses get a specific role, which overrides the domain default.
     - **Roles:** Admin, Editor, Viewer. Anyone not matched is refused.
   - Each client needs an OAuth app registration (Google Cloud and, later, Microsoft Entra). Decide whether one shared
     registration with per-deployment redirect URLs is enough, or whether each client gets its own.
4. **Data access: server-side queries.** The app talks to Postgres directly from server code (for example Drizzle on
   Neon's serverless driver). There is no PostgREST layer, and authorization lives in app code by role. Today there are
   about 420 supabase-js calls (`.from()`/`.rpc()`) in about 70 files. Strip first, so that number shrinks before the
   port.
5. **File uploads are dropped.** They are replaced by **References**: a title plus a link (Google Drive, Notion,
   anything), attached wherever evidence is cited today. Client logos, if they stay, go in the database or become a URL.
6. **Live editing (Supabase Realtime) is removed.** Austin doesn't need it.
7. **Hosting: Vercel**, on the personal (Hobby) plan for now. Before selling, Austin moves to Pro, because Hobby
   forbids commercial use. One Pro seat can host every client deployment.
   https://vercel.com/docs/limits/fair-use-guidelines

## What Supabase does today (audit, 26 Oct)

| Job | Where | Replaced by |
|---|---|---|
| Google sign-in, sessions, `auth.uid()`/`auth.jwt()` in 60 functions and about 15 policies; 62 foreign keys to `auth.users` | `lib/supabase/*`, `proxy.ts`, `auth/callback`, `lib/auth/google-sign-in.ts` | Better Auth (decision 3) |
| PostgREST API: 345 `.from()`, 75 `.rpc()` | apps/web, packages/db, packages/mcp | Server-side queries (decision 4) |
| MCP API tokens via a PostgREST pre-request hook (ADR 0002) | `packages/mcp`, `20260930040000_api_tokens.sql` | Re-decide: keep MCP? If so, tokens are checked in app code |
| Storage: `sources` (private) and `branding` (public) buckets, 6 policies | `lib/sources/upload.ts`, `lib/branding/*` | References and logo-in-DB (decision 5) |
| Realtime: presence plus row changes on steps/edges/processes | `lib/realtime/*`, `20261007000000_realtime.sql` | Removed (decision 6) |
| Ops: `prod-sql.sh` via the Management API; `supabase_migrations` table | `packages/db/scripts` | `psql "$DATABASE_URL"` against Neon |

There are no Edge Functions, webhooks, extensions or auth emails. The SQL already runs on plain Postgres in tests (stand-in
`auth`/`storage`/`realtime` files in `packages/db/test`), so the schema itself ports easily.

## Parked until the rework is planned

- **PR #248** (taller company map and zoom/fit controls): green apart from a final CI run; merge it if the map stays.
- **Issue #249** (drag tiles in place, cleaner self-routing lines, smoother animation): brief written in
  `docs/plans/map-ux-brief.md`. Its row-73 migration (`save_step_positions`) assumes Supabase. Re-plan it on the new
  stack.
- Production is still the Supabase project `vgsjkpwvxkpqvyazwcyq` until the move. It will pause again after about 7 idle
  days; restore it with the Management API or the dashboard.

## Next session

1. Read this file, `CLAUDE.md` and `docs/HANDOVER.md`.
2. Walk Austin through the app section by section, keep or cut, and record the strip list here.
3. Write briefs (Opus), build with agents (Sonnet), review (Opus), in this order: strip → schema port to Neon → Better
   Auth with domain and email roles → server-side queries → References → drop Storage and Realtime → deployment
   template per client.
