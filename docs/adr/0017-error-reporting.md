# 17. Error reporting: Sentry, errors only, scrubbed in the app before sending

Date: 7 Oct 2026 · Status: accepted · Issue: #44 (C5) · Decision D49 · Builds on ADR 0016 (what a snapshot leaves out), the #30 rule "members and viewers get no pay data", B3's "no one person's pay is ever in a link"

## Context

The app reports nothing when it breaks: no `instrumentation.ts`, no `error.tsx`, no `global-error.tsx`. An uncaught render
error shows Next's default page and leaves no trace for us. #44 asks that "Sentry captures client and server errors, with
source maps", and PRD §7 names Sentry for errors.

Sentry is a third party and **stores what it receives**. What an error can carry here is personal: Supabase and Postgres
errors are rethrown with their text (about 40 places), and our SQL puts process, role, service and step names into its
messages with no quotes (`% is client work for %. Unlink it from that in Settings, Services, then archive it.`), and a
process name can name a client. Postgres key detail repeats a value (`Key (email)=(x@y.z) already exists`). Addresses carry
share tokens (`/s/<43 characters>`, a secret by ADR 0016), auth codes and the company's slug (`/w/<slug>`); Supabase REST
addresses carry filter values in their query strings. Headers and cookies hold the session and the MCP bearer token;
breadcrumbs record console output and UI click selectors (`button[aria-label="Delete Maya Collins"]`); server stack frames
can carry local variables; server action arguments hold names and rates.

## Decision

- **Errors only.** No tracing, session replay, user feedback, logs or profiling: none of their options is set, and the
  client's default integrations for tracing, replay, feedback and profiling are filtered out.
- **Nothing personal leaves.** One tested module, `apps/web/src/lib/monitoring/scrub.ts`, is `beforeSend` and
  `beforeBreadcrumb` in every runtime. `scrubEvent` **rebuilds** the event from an allow-list of fields (so a field the SDK
  adds later is not sent until someone lists it), then runs every remaining string through `scrubText` as a backstop.
  - `sendDefaultPii: false`; **no user at all** (not even a pseudonymous id: it would need an amendment to this ADR); no
    request headers, cookies, body or query string (a request is only its method and a scrubbed address); no local
    variables; no `extra`, `modules`, spans or attachments; contexts only for runtime, OS, browser, device (minus its
    name), app (minus its name) and Next's route.
  - **Addresses** lose their query and fragment; `/s/<token>` becomes `/s/[token]` and `/w/<slug>` becomes `/w/[slug]`;
    ids stay (ADR 0016, "Real ids stay").
  - **Breadcrumbs:** only navigation and HTTP ones, with scrubbed addresses; console, clicks, input and custom ones are
    dropped.
  - **Error messages are cut to allow-listed words.** Any word that is not on a fixed vocabulary
    (`lib/monitoring/words.ts`) becomes "…" and runs of them collapse. A regular expression can't find a name our SQL
    puts in unquoted, so the list says what *may* stay, not what must go. Before that step, text loses emails, money
    (the patterns B3 and B20 share, `packages/db/src/money.ts`), quoted text, long opaque tokens and
    addresses. Code identifiers (`import_workspace_bundle`, `NEXT_REDIRECT`, `toFixed`), numbers, uuids and SQLSTATE codes
    stay. The vocabulary holds **no names**: a test fails if a fixture's person or client name, or one of more than 200 common first
    names that are also words, is added. Tag values go through the same rule.
  - Dropped events: Next's control flow (`NEXT_REDIRECT`, `NEXT_NOT_FOUND`, `NEXT_HTTP_ERROR_FALLBACK`), a cancelled fetch
    (`AbortError`) and `SimulationCancelled`.
- **Off without a DSN.** With no `NEXT_PUBLIC_SENTRY_DSN` nothing is initialised or sent and `next.config.ts` is not wrapped.
  Without all of `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`, errors are reported but **no source maps are made**:
  with maps on, the SDK turns on `productionBrowserSourceMaps` and deletes the files after upload, so without a token to
  upload with they would be served publicly. A failed upload warns and never fails the build. A local `next dev` never
  sends (`enabled` only in production builds).
- **`@sentry/nextjs` is pinned at exactly `10.76.1`.** It supports Next 16 and Turbopack builds (maps are uploaded after the
  compile, and deleted after upload). 11.x (11.0.0 was published on 23 Sep 2026) turns on build-time server-dependency
  instrumentation by default, which changes the server bundle more than we need: **11.x waits until it has had a month**, then
  moves in its own small PR. `withSentryConfig` is imported from `@sentry/nextjs/config` (the root export is deprecated).
- **Where it runs.** Browser (`instrumentation-client.ts`, a static import, so errors during hydration are caught), Node
  and edge (`instrumentation.ts`, with `onRequestError` for rendering, route handlers, server actions and the proxy). Every
  route runs on Node today; the edge config costs nothing and loads only when `NEXT_RUNTIME` is "edge". No tunnel route
  (it would pass through `proxy.ts`, which redirects signed-out visitors, and adds server load).
- **Error screens** use the existing tokens and classes only (Austin does the visual design later): `global-error.tsx`, and
  `error.tsx` for the workspace and demo segments. A segment's screen reports only an error with no digest (one with a
  digest came from the server, which `onRequestError` already reported).
- **A check page**, `/monitoring-check`, for agency admins only and linked from nowhere, sends one test error from the browser
  and one from the server.
- **Region:** the default is the European Union (Germany), chosen at sign-up (Sentry has no Australian region; it can't be
  changed later), and /privacy says so.

## Consequences

- Messages read "… is archived" rather than the process name, and some are less clear than the original. Tag values
  and the transaction keep their route pattern, not what was in it.
- A name that is also a common word can't pass, because the list holds no names; a common word that is somebody's name is
  kept out of the list by the guard test. A word that is merely unfamiliar reads "…", which is the safe way to be wrong.
- Code identifiers containing an underscore pass as they are (`save_fields`), and so would a name typed with one. Accepted:
  names in our messages come from `%` in SQL, which are free text, not identifiers.
- The SDK is in the browser bundle even without a DSN (it does nothing); a dynamic import would miss errors during
  hydration.
- Web Workers (`src/workers/`) are not covered: they report failures to the page as rejected promises, which the UI shows.
- Server actions that return `{ status: "error" }` are expected and are not reported; only thrown ones are.
- Ad blockers stop `*.ingest.sentry.io` for some visitors; those errors are lost.
- Sentry's own server-side scrubbing (Austin turns on "Prevent Storing of IP Addresses" and adds sensitive fields) is a
  second layer. The scrubber in the app is the one we rely on.
- Release health sessions (the SDK's default) are not turned off; they carry the release, environment and browser, no user.
- Free-plan quota (5,000 errors a month) is Sentry's to limit: a spike limit can be set in the project's settings.
