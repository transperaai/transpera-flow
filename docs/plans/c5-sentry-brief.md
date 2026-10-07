# C5 build brief: Sentry error reporting (#44)

Scoped 7 Oct 2026 against `origin/main` at bf61be0e. Read `docs/plans/builder-brief.md` first. This brief adds to it
and wins where they differ. Build strictly from it. If something here doesn't match the code, **ask; don't guess.**
Every open question has a default: use it.

## The short version

Report errors from the browser, the Node server and the edge runtime to Sentry, with source maps uploaded at build so
stack traces read as our TypeScript. **Nothing personal leaves the app:** no names, emails, pay, workspace contents or
share-link snapshots, enforced by one tested scrubber that every event and breadcrumb passes through.

1. **Off by default.** Without `NEXT_PUBLIC_SENTRY_DSN` nothing is initialised, nothing is sent and `next.config.ts` is
   not wrapped: the build is exactly today's. With the DSN but without all of `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
   `SENTRY_PROJECT`, errors are reported but no source maps are made or uploaded. A failed upload warns and never fails
   the build. Austin creates the Sentry account and sets the four variables in Vercel.
2. **`@sentry/nextjs` pinned at exactly `10.76.1`.** It supports Next 16 (peer `^16.0.0-0`) and Turbopack builds
   (source maps uploaded after the compile through `compiler.runAfterProductionCompile`, the default for Turbopack).
   Not 11.x yet (Q1).
3. **Files:** `src/instrumentation.ts` (server and edge, plus `onRequestError`), `src/instrumentation-client.ts`
   (browser), three small `sentry.*.config.ts` files, `src/lib/monitoring/` (shared options and the scrubber),
   `src/app/global-error.tsx`, two segment `error.tsx` files, a shared `ErrorState`, and an admin-only check page.
4. **Privacy (#30, B3, ADR 0016):** errors only (no tracing, no session replay, no user feedback, no logs, no profiling),
   `sendDefaultPii: false`, no user, no request headers, cookies, bodies or query strings, no local variables, only
   navigation and HTTP breadcrumbs (with URLs cut to their path, share tokens and workspace slugs replaced), and every
   error message reduced to **allow-listed words**: any word that isn't on a fixed vocabulary list becomes "…", so a
   name can't get through even when a database error spells it out.
5. **Docs:** the /privacy page lists Sentry; ADR 0017 and PRD D49 record the privacy rules; README, `.env.example` and
   HANDOVER say what to set.

**One PR**, branch `claude/c5-sentry` (this brief is on it; run `git merge origin/main` first). No migrations, no engine
change. Commit and push after each part. The PR doesn't close #44 (the wizard, the backup check and Austin's visual
pass remain); comment on #44 instead.

---

## Decisions (verbatim)

**#44, Austin, 7 Oct**, choosing the C5 parts to build now:
> Empty and loading states

> Dark mode and mobile pass

> Sentry error reporting

> i would like to do a UI pace but thats not a functional blocker

(A UI pass: he'll do the visual design himself later, so the error screens use existing tokens and classes only.)

> skip it for now

(the onboarding wizard.)

**#44's criterion:**
> - [ ] Sentry captures client and server errors, with source maps

**PRD §7 (line 576):**
> - **Observability**: Sentry for errors, `audit_log` for changes, Vercel analytics.

**The privacy rules this must keep** (HANDOVER, Austin's decisions on 6 Oct):
> **#30 (B1):** … members and viewers see "Team member N" labels, only their own row, "A team member" for other names, and
> **no pay data**.

> **Stored keys must hold no names**

> B3 (#32): … **no one person's pay is ever in a link** … Links are frozen copies with Update copy; the server builds
> the snapshot and Postgres refuses a leaky one (ADR 0016, PRD D47).

ADR 0016 ("What is left out of every snapshot"): "Sources and their text, AI summaries, proposed findings, AI ideas,
issue history (it names people), author names, drafts and earlier versions, `provenance` (it holds evidence quotes),
emails and notes."

The orchestrator's instruction for this brief: "Scrub PII before sending: no names, emails, pay or snapshot contents."
Sentry is a third party that **stores** what it receives, so it gets the strictest of these rules: no names of anyone
(team, clients, users, visitors), no emails, no money amounts, no free text from the workspace, no share tokens.

---

## Audit: what exists on `origin/main`

- **No error reporting at all.** No `instrumentation.ts`, no `instrumentation-client.ts`, no `error.tsx`, no
  `global-error.tsx` (only `app/s/[token]/not-found.tsx`). An uncaught render error shows Next's default error page.
- **Runtime:** every route runs on Node. `proxy.ts` runs on Node too (Next 16: "Proxy defaults to using the Node.js
  runtime"). Nothing sets `export const runtime = "edge"`. The edge config is still added (the orchestrator asked for
  it, and it costs nothing), loaded only when `NEXT_RUNTIME === "edge"`.
- **Build:** `next build` (Turbopack, Next 16.3.6). `next.config.ts` has `transpilePackages`,
  `serverExternalPackages: ["unpdf"]`, `outputFileTracingIncludes`, `outputFileTracingRoot`, `headers` (the `/s/:path*`
  no-referrer, no-store, noindex block) and `redirects`. No `productionBrowserSourceMaps`.
- **Hosting:** Vercel, functions in `syd1` (`apps/web/vercel.json`). Supabase in Sydney.
- **Env:** `.gitignore` ignores `.env*` except `.env.example`, and README says "copy `apps/web/.env.example`", **but
  the file doesn't exist.** This PR adds it.
- **Proxy:** `proxy.ts` redirects signed-out requests to `/login` except `PUBLIC_PATHS`; the matcher skips `_next/static`
  etc. Sentry sends from the browser straight to `*.ingest.sentry.io` (no tunnel route, Q4), so the proxy doesn't
  matter. There is no Content-Security-Policy header to update.
- **Where personal data can reach an error:**
  - **Database errors.** About 40 places rethrow a Supabase error or its message (`throw error`, `throw new
    Error(error.message)`: `lib/data.ts`, `lib/access-data.ts`, `packages/db/src/*.ts` and others). Our SQL interpolates
    process, role, service and step names into messages without quotes, e.g. `raise exception '% is client work for %.
    Unlink it from that in Settings, Services, then archive it.'` A process name can name a client.
  - **Postgres detail text** (`Key (email)=(x@y.z) already exists`).
  - **URLs:** `/s/<43-character token>` is a secret (ADR 0016); `/auth/callback?code=…`; `/w/<slug>` names the
    workspace's company; Supabase REST URLs carry filter values in their query string (`?email=eq.…`), which show up
    in HTTP breadcrumbs and server fetch breadcrumbs.
  - **Request headers and cookies** (the Supabase session cookie, `tf_after_sign_in`, the MCP `Authorization` bearer
    token on `/api/mcp`).
  - **Console output** and **UI click selectors** (`button[aria-label="Delete Maya Collins"]`) as breadcrumbs.
  - **Local variables** in server stack frames (off by default in the SDK; must stay off).
  - **Server action arguments** (form data with names and rates): never attached by default; must stay so.
  - **Workers:** the simulation, robustness and other Web Workers (`src/workers/`) report failures back to the page as
    rejected promises, which the UI shows. The browser SDK doesn't run inside workers. Leave it so (Out of scope).

### `@sentry/nextjs` version

Checked on npm on 7 Oct: `latest` is 11.4.0 (11.0.0 published 23 Sep 2026, two weeks ago); the 10.x line's newest is
**10.76.1** (6 Oct 2026), peer `next: ^13.2.0 || ^14.0 || ^15.0.0-rc.0 || ^16.0.0-0`, engines `node >=18`. 10.76.1
detects Turbopack, turns on `productionBrowserSourceMaps` itself when source maps are enabled, uploads them in
`runAfterProductionCompile`, and deletes them after upload (`deleteSourcemapsAfterUpload` defaults to true), so no
`.map` file is served publicly. 11.x adds build-time server-dependency instrumentation, on by default
(`buildTimeInstrumentation`), which changes the server bundle more than we need. **Pin `"@sentry/nextjs": "10.76.1"`**
(exact, no caret) in `apps/web/package.json` `dependencies`, and record in ADR 0017 that 11.x waits until it has had a
month (Q1). Run `pnpm install` and commit `pnpm-lock.yaml`. If pnpm asks to approve build scripts for Sentry's CLI
binary (`@sentry/cli`, pulled in by `@sentry/bundler-plugin-core`), add only that one under a new
`onlyBuiltDependencies:` key in `pnpm-workspace.yaml` (today it has only `ignoredBuiltDependencies: [sharp,
unrs-resolver]`; leave those), check the upload still finds the binary in a Vercel-like clean install, and say so in
the PR. If pnpm doesn't ask (newer CLIs ship the binary as an optional platform package), change nothing.

Read first: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`,
`instrumentation-client.md`, `error.md` (Next 16.3: the error components get **`retry`**, not `reset`, as the main prop),
and `01-getting-started/10-error-handling.md`.

---

## Part 1: dependency and env

1. `apps/web/package.json`: `"@sentry/nextjs": "10.76.1"`.
2. `apps/web/.env.example` (new; README already points at it):

   ```sh
   # Supabase (leave both empty for demo mode)
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
   # Narration and AI analysis (server only; optional)
   ANTHROPIC_API_KEY=
   # Sentry error reporting (optional; nothing is sent while the DSN is empty)
   NEXT_PUBLIC_SENTRY_DSN=
   # Source maps upload at build (all three, or none; build time only)
   SENTRY_AUTH_TOKEN=
   SENTRY_ORG=
   SENTRY_PROJECT=
   ```

   Check the code for any other variable the app reads (`grep -rn "process.env" apps/web/src`) and list it too, with a
   one-line comment. Never put a real value in it.

## Part 2: `src/lib/monitoring/` (the privacy core)

### 2a. `src/lib/monitoring/env.ts`

```ts
/** The Sentry DSN, or null: with no DSN, nothing is initialised or sent (issue #44). */
export function sentryDsn(): string | null
/** Source maps are made and uploaded only with all three build variables. */
export function sourceMapsConfigured(): boolean
/** "production" | "preview" | "development", from NEXT_PUBLIC_VERCEL_ENV (Vercel exposes it), else NODE_ENV. */
export function sentryEnvironment(): string
```

`sentryDsn` reads `process.env.NEXT_PUBLIC_SENTRY_DSN` **literally** (`process.env.NEXT_PUBLIC_SENTRY_DSN`, not
`process.env[name]`), so Next inlines it in the browser bundle. Empty string or whitespace is null.

### 2b. `src/lib/monitoring/words.ts`: the vocabulary

`export const ALLOWED_WORDS: ReadonlySet<string>`: lower-case words that may appear in a reported message. Build it as
one sorted array literal, in these groups (comment each group):

- **English function words and common verbs:** a, an, the, of, to, in, on, at, by, for, from, with, without, into,
  onto, and, or, not, no, is, are, was, were, be, been, has, have, had, can, cannot, can't, could, should, must, may,
  will (only the verb sense is safe here; see the guard below), would, it, its, this, that, these, those, there, then,
  than, as, if, else, when, while, after, before, only, already, still, yet, more, less, at, least, most, one, two,
  first, last, new, old, same, other, another, each, every, all, any, some, none, null, undefined, true, false, nan,
  read, write, reading, writing, set, get, call, called, open, close, take, put, make, made, use, used, find, found,
  move, moving, change, changing, changed, publish, published, publishing, restore, restored, archive, archived,
  remove, removed, unlink, link, linked, choose, choosing, rename, place, placing, hold, holds, held, sit, sits,
  allowed, expected, unexpected, failed, failure, invalid, missing, empty, unknown, too, many, much, long, large, small,
  out, off, up, down, over, under, again, here, where, which, what, who, whose, why, how, because, so, but, also, own.
- **JavaScript, React, Next, network:** error, errors, type, types, typeerror, rangeerror, referenceerror, syntaxerror,
  aborterror, networkerror, chunkloaderror, property, properties, reading, function, object, array, string, number,
  value, values, key, keys, index, length, json, parse, unexpected, token, end, input, fetch, request, response,
  status, timeout, timed, network, load, loading, loaded, chunk, module, import, render, rendering, hydration,
  hydrate, mismatch, component, components, server, client, action, actions, route, routes, page, redirect,
  notfound, digest, promise, rejected, aborted, signal, maximum, call, stack, size, exceeded, memory, worker,
  constructor, prototype, iterable, instance, element, node, document, window, cannot, convert, assign, constant,
  variable, defined, initialized, initialization, permission, denied, forbidden, unauthorized, row, rows, column,
  columns, relation, table, tables, constraint, violates, duplicate, unique, foreign, check, policy, security, level,
  syntax, near, at, character, transaction, aborted, deadlock, detected, lock, timeout, connection, refused, reset,
  jwt, expired, session, user, users, auth, sign, signed, login, storage, bucket, object, upload, uploaded, file,
  files, bytes, mb, kb, limit, limits, rate, exceeded (`rate` here is "rate limit"; money is removed before this step).
- **Product words** (from the app's own UI and SQL messages): workspace, workspaces, process, processes, step, steps,
  role, roles, service, services, servicing, client, clients, group, groups, person, people, team, member, members,
  viewer, viewers, editor, editors, owner, owners, admin, agency, revision, revisions, version, versions, draft,
  drafts, live, map, company, issue, issues, insight, insights, finding, findings, solution, solutions, scenario,
  scenarios, lever, levers, block, blocks, source, sources, suggestion, suggestions, idea, ideas, proposal, proposals,
  share, link, links, snapshot, copy, play, forecast, plan, plans, marker, markers, horizon, simulation, simulate,
  run, runs, engine, model, models, result, results, settings, demand, market, churn, calibration, import, export,
  bundle, backup, placeholder, token, tokens, mcp, api, first, principles, history, analysis, analyse, narration,
  report, decision, wait, terminal, start, end, edge, edges, lane, lanes, parent, child, inside, itself, held.

**Guard:** a test (2e) fails if `ALLOWED_WORDS` contains any first name, surname or client name in the Northbeam and
Larkspur fixtures (`packages/db` exports them; read people and clients from the seed fixtures the tests already use),
or any of a fixed list of 200 common English first names that are also words (the test file holds the list: will,
mark, grace, rose, june, april, may, faith, hope, joy, bill, pat, sue, don, ray, rich, frank, art, guy, jack, …). So
`may` and `will` must come **out** of the list above. Keep the list small: a word you're unsure of stays out (it then
reads "…", which is fine).

### 2c. `src/lib/monitoring/scrub.ts`

Pure functions, no Sentry import except `import type { Breadcrumb, ErrorEvent, Event, EventHint } from "@sentry/nextjs"`.

```ts
/** A URL or path cut to what is safe: no query, no fragment; /s/<token> → /s/[token]; /w/<slug> → /w/[slug]; auth codes gone. */
export function scrubUrl(url: string): string
/** Free text with emails, money, quoted text, long tokens and URLs replaced (used on every string in an event). */
export function scrubText(text: string): string
/** An error message reduced to allow-listed words: scrubText, then every other word becomes "…" (runs collapse). */
export function shapeMessage(message: string): string
/** beforeSend: the event with only what ADR 0017 allows, or null to drop it. */
export function scrubEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null
/** beforeBreadcrumb: navigation and http/fetch/xhr breadcrumbs with scrubbed URLs; everything else is dropped. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null
```

**`scrubUrl`:** parse with `new URL(url, "http://x")` (keep the origin only if the input had one); drop `search` and
`hash`; replace path segments: `/s/<anything>` → `/s/[token]`, `/w/<anything>` → `/w/[slug]`; keep uuids and numbers
(ids carry no data, ADR 0016 "Real ids stay"); on a parse failure return `"[url]"`.

**`scrubText`**, in this order:
1. URLs (`https?://\S+`) → `scrubUrl` of each; then bare paths starting `/s/` or `/w/` → scrubbed.
2. Emails (`/[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g`) → `[email]`.
3. Money: `moneyRegex()` and `shareMoneyRegex()` (on a lower-cased copy, mapping match positions back; or apply
   `shareMoneyRegex` with its `i` flag directly) → `[amount]`. Import them from `@transpera-flow/db/money`: **add**
   `"./money": "./src/money.ts"` to `packages/db/package.json` `exports` (the client bundle must not pull in the whole
   `@transpera-flow/db` index).
4. Postgres key detail `Key \(([^)]*)\)=\(([^)]*)\)` → `Key ([column])=([value])`.
5. Quoted text: `"…"`, `'…'`, `“…”`, `‘…’`, `` `…` `` (non-greedy, on one line) → `[text]`. Apostrophes inside words
   (`can't`) are not quotes: only match a quote that isn't between two letters.
6. Long opaque runs (`[A-Za-z0-9_\-]{24,}` that aren't a uuid) → `[token]` (JWTs, share tokens, API tokens, auth codes).

**`shapeMessage`:** `scrubText`, then split into words on `/[A-Za-z][A-Za-z'’]*/`; keep a word if any of:
- its lower case is in `ALLOWED_WORDS`;
- it is a code identifier: contains `_` (`import_workspace_bundle`, `NEXT_REDIRECT`), or starts lower-case and has an
  upper-case letter later (`toFixed`, `useSimulation`), or ends in `Error` or `Exception`;
- it is one of the placeholders `[email]`, `[amount]`, `[text]`, `[token]`, `[url]`, `[slug]`;

otherwise replace it with `…`, and collapse runs of `…` and spaces into one `…`. Numbers, punctuation, uuids and
SQLSTATE codes (`23514`, `P0001`, `PGRST116`) stay. Example: `Acme Onboarding is client work for Retainers. Unlink it
from that in Settings, Services, then archive it.` → `… is client work for …. Unlink it from that in Settings,
Services, then archive it.` Cap the result at 500 characters.

**`scrubEvent`** returns a **new** object (don't mutate) holding:
- `event_id`, `timestamp`, `level`, `platform`, `environment`, `release`, `dist`, `sdk`, `server_name` (Vercel's is a
  generated host), `fingerprint`, `transaction` (through `scrubUrl`; for a Next route it's a pattern already).
- `exception.values[]`: `type` (kept: a class name), `value` through `shapeMessage`, `mechanism` without `data`,
  `stacktrace.frames[]` with only `filename`, `abs_path` (through `scrubUrl`), `function`, `module`, `lineno`, `colno`,
  `in_app`, `context_line`, `pre_context`, `post_context` (our source code, from the source maps; never data), and
  **no `vars`**.
- `message` and `logentry.message` through `shapeMessage`; `logentry.params` dropped.
- `request`: only `method` and `url` (through `scrubUrl`). No `headers`, `cookies`, `data`, `query_string`, `env`.
- `contexts`: only `runtime`, `os`, `browser`, `device` (each minus `name` on `device` if it holds a user-set device
  name; keep `family`, `model`, `type`), `app` (minus `app_name`), and `nextjs` with its `route_type`, `router_kind`,
  `router_path` and `request_path` (through `scrubUrl`). Drop `trace`'s `data`, keep its ids.
- `tags`: only string values, each through `scrubText`, and only keys from a short allow-list: `runtime`, `handled`,
  `mechanism`, `level`, `transaction`, `url` (scrubbed), `environment`, `release`, `routerKind`, `routePath`,
  `routeType`, `renderSource`, `area` (we set it, below).
- `breadcrumbs`: each through `scrubBreadcrumb` (the SDK applies `beforeBreadcrumb` as they're recorded; apply again
  here because the server records some itself).
- **Dropped:** `user`, `extra`, `modules`, `debug_meta` stays (needed for source maps) but its `images[].code_file`
  through `scrubUrl`; `spans`, `measurements`, `attachments` dropped.
- **Final pass:** walk every remaining string value and apply `scrubText` (not `shapeMessage`: filenames and function
  names must survive), as a backstop for any field this list missed.
- Return `null` (drop) for: events whose exception is Next's control flow (`NEXT_REDIRECT`, `NEXT_NOT_FOUND`,
  `NEXT_HTTP_ERROR_FALLBACK`; the SDK filters these, but check), `AbortError` from a cancelled fetch, and
  `SimulationCancelled` (`lib/sim/client.ts`).

**`scrubBreadcrumb`:** keep `category` `navigation` (with `data.from` and `data.to` through `scrubUrl`) and `fetch`,
`xhr`, `http` (with only `data.method`, `data.url` through `scrubUrl`, `data.status_code`); set `message` to undefined.
Drop every other category: `console`, `ui.click`, `ui.input`, `sentry.*`, custom. Keep `timestamp`, `type`, `level`,
`category`.

### 2d. `src/lib/monitoring/options.ts`

```ts
import type { BrowserOptions, NodeOptions, EdgeOptions } from "@sentry/nextjs";
/** The options every runtime shares (ADR 0017). Null when there is no DSN. */
export function sharedOptions(): (Pick<NodeOptions, "dsn" | "environment" | "release" | "enabled" | "sendDefaultPii" | "beforeSend" | "beforeBreadcrumb" | "beforeSendTransaction" | "maxBreadcrumbs" | "attachStacktrace" | "includeLocalVariables" | "sendClientReports">) | null
```

(Adjust the types to whatever 10.76.1 exports; `includeLocalVariables` is Node-only, so the browser spreads the rest.)
Values:
- `dsn: sentryDsn()`; return `null` when it is null.
- `environment: sentryEnvironment()`.
- `enabled: process.env.NODE_ENV === "production"` (a local `next dev` never sends, even with the DSN in `.env.local`;
  Q5).
- `sendDefaultPii: false`, `includeLocalVariables: false`, `attachStacktrace: false`, `sendClientReports: false`,
  `maxBreadcrumbs: 30`.
- `beforeSend: scrubEvent`, `beforeBreadcrumb: scrubBreadcrumb`, `beforeSendTransaction: () => null`.
- **No** `tracesSampleRate`, `tracesSampler`, `profilesSampleRate`, `replaysSessionSampleRate`,
  `replaysOnErrorSampleRate`, `enableLogs`, `_experiments`. Leaving the trace options unset keeps tracing off.

`release` is left unset: `withSentryConfig` injects the release (the Vercel commit SHA) at build when it wraps the
config; without the wrap there is no release, which is fine.

### 2e. Tests for Part 2: `apps/web/test/monitoring-scrub.test.ts`

Fixtures are **real-shaped Sentry events** (an `ErrorEvent` from the browser with breadcrumbs, request and contexts, and
one from the server as `captureRequestError` builds it with `contexts.nextjs`). Build them by hand in the test file
from the 10.76.1 types; keep them close to what the SDK sends (copy field names from `@sentry/core`'s `Event` type).

1. **Nothing personal survives.** Seed a browser event and a server event with, in every string field you can reach
   (exception value, message, request url, query string, headers, cookies, data, user, extra, tags, contexts, breadcrumb
   messages, breadcrumb urls, frame vars, frame abs_path with a `/s/<token>` URL): every Northbeam and Larkspur person
   name (first, last, full), client name, the emails, `£4,100`, `$85/h`, `4,512€`, `1,200 GBP`, a 43-character share
   token, a Supabase session cookie value, `Bearer <token>`, `?email=eq.maya@northbeam.example`, and a SQL message
   built from a real `raise exception` template with a client name in it. Assert `JSON.stringify(scrubEvent(e))`
   contains **none** of them (case-insensitive for names).
2. **What survives:** exception `type`, frame `filename`/`function`/`lineno`, a uuid, the SQLSTATE code, `TypeError:
   Cannot read properties of undefined` (as `Cannot read properties of undefined ([text])` or similar), the route
   pattern, the environment.
3. `shapeMessage` table tests: the client-work example above; `Failed to fetch`; `Unexpected token '<'`;
   `NEXT_REDIRECT`; `import_workspace_bundle: … could not be restored: …`; a message that is only a name → `…`.
4. `scrubUrl` table tests: `/s/<token>?x=1#y`, `/w/northbeam/p/<uuid>`, `/auth/callback?code=abc`, an absolute
   Supabase REST URL with a filter, garbage → `[url]`.
5. `scrubBreadcrumb`: console, `ui.click`, `ui.input` and a custom category → null; navigation and fetch keep only the
   allowed fields.
6. **The vocabulary guard** (2b): no fixture name and none of the 200 common first names in `ALLOWED_WORDS`; every
   entry is lower case.
7. `scrubEvent` drops `NEXT_REDIRECT`, `AbortError` and `SimulationCancelled` events, and doesn't mutate its input.

## Part 3: wiring the SDK

### 3a. `apps/web/sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts` (new, in `apps/web/`
next to `next.config.ts`)

Each is a few lines:

```ts
import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "@/lib/monitoring/options";

const options = sharedOptions();
if (options) Sentry.init({ ...options /* runtime-specific below */ });
```

- **client:** `integrations: (defaults) => defaults.filter((i) => !["BrowserTracing", "Replay", "ReplayCanvas",
  "Feedback", "BrowserProfiling"].includes(i.name))`. (In 10.76.1 `@sentry/nextjs`'s client adds
  `browserTracingIntegration` to the defaults; it must go. Check the names in
  `node_modules/@sentry/nextjs/build/cjs/client/index.js` and the browser SDK's integration names, and assert in a test
  that the filtered list has none of them.)
- **server:** `includeLocalVariables: false` (already in the shared options; restate nothing else).
- **edge:** the shared options only.

### 3b. `apps/web/src/instrumentation.ts` (new; the app uses `src/`, so the file goes there)

```ts
import type { Instrumentation } from "next";

/** Sentry for the server and edge runtimes (issue #44); nothing loads without a DSN. */
export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  if (process.env.NEXT_RUNTIME === "nodejs") await import("../sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("../sentry.edge.config");
}

/** Server errors from rendering, route handlers, server actions and the proxy. */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
};
```

Check the relative import path from `src/` to the config files resolves under Turbopack (`../sentry.server.config`);
if the config files must sit in `src/` for the `@/` alias to work in them, put all three in `apps/web/src/` and say so.
`captureRequestError` sends the request's headers into the event: `scrubEvent` removes them (test 2e.1 covers it).

### 3c. `apps/web/src/instrumentation-client.ts` (new)

```ts
// Sentry in the browser (issue #44): set up before React hydrates, so errors during hydration are caught too.
import "../sentry.client.config";
```

A static import (only top-level synchronous code is guaranteed to run before hydration,
`instrumentation-client.md`). Without a DSN, `sentry.client.config` calls nothing, but the SDK code is still bundled
(about 30–40 kB gzipped; measure and put the number in the PR). Accepted (Q6). Don't export `onRouterTransitionStart`
(it's for tracing, which is off); set `suppressOnRouterTransitionStartWarning: true` in `withSentryConfig` if the SDK
warns about it.

### 3d. `apps/web/next.config.ts`

Keep `nextConfig` as it is. Change the export:

```ts
import { withSentryConfig } from "@sentry/nextjs";
…
const sourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);

// Sentry (issue #44, ADR 0017): only with a DSN; source maps only with the three build variables, deleted after upload.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      telemetry: false,
      sourcemaps: { disable: !sourceMaps, deleteSourcemapsAfterUpload: true },
      widenClientFileUpload: false,
      errorHandler: (err) => console.warn(`[sentry] source map upload failed; the build carries on: ${err.message}`),
    })
  : nextConfig;
```

(`next.config.ts` can't use the `@/` alias, so it reads the variables directly rather than importing
`lib/monitoring/env.ts`.) Check each option name against 10.76.1's `SentryBuildOptions` type and fix any that moved
(e.g. `sourcemaps.disable` accepts `true`). Don't set `tunnelRoute`, `reactComponentAnnotation` (it writes component
names into the DOM), `automaticVercelMonitors`, or anything under `_experimental`.

**Why `disable` matters:** with source maps on, the SDK sets `productionBrowserSourceMaps: true` and deletes the maps
after upload. Without a token the upload can't happen, so the maps would stay and be served publicly. `disable: true`
when any build variable is missing keeps them from being made.

### 3e. Error screens

**`src/components/shell/error-state.tsx`** (new, no Sentry import, so Storybook can render it):

```tsx
/** What a page shows when it fails (issue #44). `digest` is Next's id for a server error, which matches Sentry and the server logs. */
export function ErrorState({ title = "Something went wrong", digest, onRetry, homeHref }: { title?: string; digest?: string; onRetry?: () => void; homeHref?: string })
```

Classes from `EmptyOverview` (`workspace-overview.tsx`): `mx-auto mt-6 w-full max-w-3xl rounded-token border
border-line p-6`, a `text-base font-bold` title, a `text-fg-2` sentence: "The page couldn't be shown. Try again, and if
it keeps happening, tell us the reference below." Then `Button` "Try again" (`onRetry`), an outline `Button asChild`
link "Go to your workspaces" (`homeHref`, default `/`), and when `digest` is set a `text-xs text-fg-3 font-mono` line
"Reference: {digest}". `role="alert"`.

**`src/app/global-error.tsx`** (new, `"use client"`): must render its own `<html lang="en">` and `<body>`, import
`./globals.css`, and set the same font variables as `layout.tsx` (copy the `Inter` and `IBM_Plex_Mono` setup) so tokens
and fonts work. `useEffect(() => { Sentry.captureException(error) }, [error])`, then `<ErrorState digest={error.digest}
onRetry={retry} />` inside a `<main>`. Title via React's `<title>Something went wrong · Transpera Flow</title>`
(metadata exports aren't allowed here).

**`src/app/w/[slug]/error.tsx`** and **`src/app/demo/error.tsx`** (new, `"use client"`): `{ error, retry }`; capture
with Sentry **only when `!error.digest`** (an error with a digest came from the server and `onRequestError` already
reported it; reporting it again would double-count), then `<div><ShellHeader title="Something went wrong" /><ErrorState
digest={error.digest} onRetry={retry} homeHref="/w/[slug] or /demo" /></div>` so the sidebar stays (`error.tsx` sits
inside the segment's layout). Use `useParams()` for the slug in the workspace one.

Leave `app/s/[token]/not-found.tsx` as it is. Don't add `error.tsx` anywhere else (Q7).

### 3f. Story

`stories/shared/error-state.stories.tsx`, title `Shared/ErrorState`: default, with a digest, tagged `visual-phone`. Add
`["shell/error-state", "ErrorState"]` to `SHARED` in `test/stories-coverage.test.ts`. Approve with `[visual-update]`.

### 3g. The admin check page: `src/app/monitoring-check/page.tsx`

So Austin can prove it works after setting the variables (and see a real event's fields):

- Server component. `await connection()`. If `supabaseEnv()` is null or `!(await isAgencyAdmin())`, `notFound()`
  (`lib/access-data.ts`; the proxy already sends signed-out visitors to `/login`).
- Shows whether a DSN is set (yes/no, never the value) and the environment.
- A client component `MonitoringCheckButtons` with two buttons: **"Send a browser test error"** (an `onClick` that
  throws `new Error("Sentry check from the browser")` inside `setTimeout`, so the global handler catches it) and
  **"Send a server test error"** (calls a server action in `src/app/monitoring-check/actions.ts` that checks
  `isAgencyAdmin()` again and throws `new Error("Sentry check from the server")`).
- Both messages are made of allow-listed words except "Sentry": add `sentry` to `ALLOWED_WORDS` in the JavaScript group.
- Not linked from the UI. Listed in HANDOVER and README.

### 3h. Turn it on in CI? No

CI's `check` job builds without any Sentry variable, which is the "no DSN, no build change" proof. Add one step after the
build that proves the "DSN but no token" path too, without network:

```yaml
- name: Build with a Sentry DSN and no upload variables
  run: NEXT_PUBLIC_SENTRY_DSN=https://public@o0.ingest.sentry.io/0 pnpm --filter @transpera-flow/web build && ! find apps/web/.next/static -name '*.map' | grep -q .
```

(It builds a second time: about two minutes. If that's too slow, put the same check in a vitest that reads
`next.config.ts`'s export for both env cases instead, and say so in the PR; Q8.)

## Part 4: docs

1. **`src/app/privacy/page.tsx`**:
   - `UPDATED` → the day the PR merges (write "7 October 2026" and update it if it merges later).
   - "Technical data" bullet: add "and error reports when something breaks (see Service providers)".
   - "Service providers" list, new item after Vercel: **"Sentry: error reports when something in the app breaks: which
     page, what failed in our code, and the browser and device type. Names, email addresses, pay, the contents of your
     workspace and share links are removed before a report is sent, and IP addresses are not stored. Hosted in the
     European Union (Germany)."** If Austin picks the US region (Q2), say "in the United States".
   - Nothing else changes. Check the wording matches the test in 2e (what's removed is what the scrubber removes).
2. **`docs/adr/0017-error-reporting.md`** (new; "Date: 7 Oct 2026 · Status: accepted · Issue: #44"): context (no
   reporting today; Sentry is a third party that stores events); decision (the bullets of Part 2, the allow-listed
   words approach and why: SQL messages interpolate names unquoted, so a regex can't find them; errors only; no
   user; pinned 10.76.1 and why not 11.x; off without a DSN; maps deleted after upload); consequences (messages read
   "… is archived" rather than the process name; a lower-case name that is also a common word can't pass because the
   list holds no names, and a common word that is someone's name is excluded by the guard test; the bundle carries
   the SDK even without a DSN; workers aren't covered; Sentry's own server-side scrubbing is a second layer, not the
   one we rely on).
3. **`docs/PRD.md`**: a D49 row in the decisions table after D48: "How are errors reported? | **Sentry, errors only,
   scrubbed in the app before sending** (C5, #44; ADR 0017) …" with the defaults from the questions below, marked
   "Claude's defaults, for Austin to confirm" like D47 and D48. In §7 line 576 leave the sentence and add "(ADR 0017)".
4. **`README.md`**: a short "Error reporting (Sentry)" section after "Narration (Claude)": the four variables, off
   without the DSN, maps only with all three build variables, what is never sent (link ADR 0017), `/monitoring-check`.
5. **`docs/HANDOVER.md`**: under "Waiting on Austin", one bullet: "Sentry (C5): create the account and set the four
   variables (see `docs/plans/c5-sentry-brief.md`, 'What Austin does'), redeploy, then open `/monitoring-check`."
6. **`docs/supabase-notes.md`**: nothing (no database change).

---

## What Austin does (put this list in the PR body and in HANDOVER)

**In Sentry** (sentry.io):
1. Sign up and create an organisation. **Choose the data region when asked: European Union (Germany)** (Q2; it can't be
   changed later). Note the organisation slug (Settings → General Settings → Organization Slug).
2. Create a project: platform **Next.js**, name `transpera-flow`, alert frequency "Alert me on every new issue". Skip
   the wizard's code steps (this PR does them). Note the project slug.
3. Copy the **DSN**: Project Settings → Client Keys (DSN).
4. Organisation Settings → **Security & Privacy**: turn on **Prevent Storing of IP Addresses**, keep **Data Scrubber**
   and **Use Default Scrubbers** on, and add `email`, `name`, `rate`, `pay`, `token`, `cookie`, `authorization` to
   **Additional Sensitive Fields**. (A second layer; the app already removes these.)
5. Project Settings → Security & Privacy: the same IP setting; leave "Enhanced Privacy" off (it hides our own source
   code in the stack trace view).
6. Create the **auth token**: Settings → Developer Settings → **Organization Tokens** → Create New Token, name
   `vercel-source-maps`. The default scope (`org:ci`) is enough for source maps and releases. Copy it once.
7. Don't install Sentry's Vercel integration (it would add variables and access we don't need; Q3).

**In Vercel** (the `transpera-flow` project → Settings → Environment Variables):
1. `NEXT_PUBLIC_SENTRY_DSN` = the DSN, for **Production** and **Preview**.
2. `SENTRY_AUTH_TOKEN` = the token, for **Production** and **Preview**, marked **Sensitive**.
3. `SENTRY_ORG` = the organisation slug, Production and Preview.
4. `SENTRY_PROJECT` = the project slug, Production and Preview.
5. Check Settings → Environment Variables → "Automatically expose System Environment Variables" is on (it gives
   `NEXT_PUBLIC_VERCEL_ENV`, which tags events production or preview).
6. Redeploy production (Deployments → the latest → Redeploy, without the build cache). `NEXT_PUBLIC_*` values are fixed
   at build, so the DSN only takes effect after a new build.

**Then check:** open `https://<production>/monitoring-check` signed in as an agency admin, press both buttons, and
in Sentry (Issues) see two events whose stack traces show `.tsx`/`.ts` file names and lines (source maps worked), whose
Request shows only the method and a path, with no User, no cookies and no headers. Tell Claude what you saw; the
orchestrator then ticks "Sentry captures client and server errors, with source maps" on #44.

Never paste the DSN, token or slugs into chat (HANDOVER: "Never paste API keys or tokens into chat"). The DSN is not a
secret (it ships in the browser bundle), but keep the habit.

---

## Patterns to copy

- Pure, tested privacy helpers: `packages/db/src/money.ts` and its users (`share.ts` redaction, B20's check).
- Source-text tests of config: `test/ui-tokens.test.ts`, `test/play-source.test.ts`, `test/share-source.test.ts`.
- Admin gating: `isAgencyAdmin()` in `app/page.tsx`.
- Error-screen layout: `EmptyOverview` in `components/overview/workspace-overview.tsx`.
- Env-gated features: `ANTHROPIC_API_KEY` in `lib/narration/anthropic.ts` (`narrationConfigured`) and the README's
  Narration section.

## Edge cases

- **No DSN:** `register()` returns before any import; `onRequestError` returns; `sentry.client.config` calls nothing;
  `next.config.ts` exports `nextConfig` untouched. `Sentry.captureException` in the error screens is a no-op without a
  client.
- **DSN set, token missing** (e.g. a Preview without the token): errors report, `sourcemaps.disable` is true, no maps
  are made, stack traces show minified code. The build passes.
- **Bad token or org:** the upload fails, `errorHandler` warns, the build passes. Say in the PR that you tried this
  locally with fake values (it can't reach Sentry from the container: the warning path is what's being tested).
- **Local `next dev` with the DSN in `.env.local`:** `enabled` is false, nothing is sent.
- **Share-link visitors** (`/s/[token]`) are outsiders: their errors report too, with the token replaced. Their page
  holds a snapshot; snapshot contents never reach an event because only messages, stack frames and paths are kept and
  messages are reduced to the vocabulary.
- **A server component error** reaches the browser as a generic message with a digest: `onRequestError` reports the
  real one on the server, and the segment `error.tsx` skips it (digest set). The global error screen captures every
  error it gets (it may double-count a server render error in the root layout; accepted, rare).
- **Server actions** that return `{ status: "error" }` aren't exceptions and aren't reported (expected errors). Only
  thrown ones are.
- **Ad blockers** block `*.ingest.sentry.io` for some visitors: those errors are lost (Q4).
- **The MCP endpoint** (`/api/mcp`) errors report through `onRequestError` like any route; its `Authorization` header is
  removed with the rest of the headers.
- **Narration and AI calls** that fail with Anthropic's error text: the message is reduced to allow-listed words.
- **Sentry quota** (free plan 5,000 errors a month): a crash loop could use it. Leave rate limits to Sentry's project
  settings (Austin can set a spike limit; mention it in "What Austin does" step 2 as optional).

## Tests

- `test/monitoring-scrub.test.ts` (Part 2e).
- `test/monitoring-config.test.ts` (source and behaviour):
  - `sharedOptions()` is null with no DSN and with a blank one; with a DSN it has `sendDefaultPii: false`,
    `includeLocalVariables: false`, `beforeSend === scrubEvent`, `beforeBreadcrumb === scrubBreadcrumb`, and none of the
    keys `tracesSampleRate`, `tracesSampler`, `profilesSampleRate`, `replaysSessionSampleRate`,
    `replaysOnErrorSampleRate`, `enableLogs`.
  - The three `sentry.*.config.ts` files call `Sentry.init` only inside `if (options)`, spread `sharedOptions()`, and
    mention no `replayIntegration`, `feedbackIntegration`, `browserTracingIntegration`, `tracesSampleRate`.
  - The client config's integration filter removes `BrowserTracing`, `Replay`, `Feedback` (call the filter function
    with fake integrations named so).
  - `src/instrumentation.ts` returns early without the DSN, imports the server config only for `nodejs` and the edge
    config only for `edge`, and exports `onRequestError`.
  - `next.config.ts`: importing it with the DSN unset gives an object deep-equal to today's config fields (`headers`,
    `redirects`, `serverExternalPackages`, `transpilePackages`, `outputFileTracingIncludes`, `outputFileTracingRoot`)
    and no `productionBrowserSourceMaps`; with the DSN set and no token, `sourcemaps.disable` reached `withSentryConfig`
    as true (assert on the source text if importing the wrapped config needs Next internals).
  - `packages/db/package.json` exports `./money`, and `lib/monitoring/scrub.ts` imports from `@transpera-flow/db/money`,
    not `@transpera-flow/db`.
- The error screens: a browser-harness test (the `bundleHarness` pattern, `test/build-harness.ts`) mounting `ErrorState`
  with a digest shows the reference and calls `onRetry` on "Try again"; Sentry isn't imported by `ErrorState` (source
  test).
- `stories-coverage` with the new `SHARED` entry; `visual` after `[visual-update]`.
- Full run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`, then the build again
  with a fake DSN and no token (no `.map` files under `.next/static`), then with a fake DSN and fake token, org and
  project (build passes, the warning prints). Put the three results in the PR's Evidence.
- In demo mode with a fake DSN pointed at a local catcher (`NEXT_PUBLIC_SENTRY_DSN=http://public@127.0.0.1:9999/1`,
  a 20-line Node server that logs request bodies to a file, `next build && next start`): throw a test error from the
  browser console path you can reach (the check page needs Supabase; instead temporarily add nothing: use
  `window.dispatchEvent(new ErrorEvent("error", { error: new Error("Sentry check from the browser") }))` in Playwright)
  and attach the captured envelope (trimmed) to the PR, showing no names and no headers. Optional if the SDK refuses a
  non-HTTPS DSN; say so if it does.

## Out of scope

- Tracing and performance, session replay, user feedback, Sentry logs, profiling, cron monitors, release health beyond
  what the SDK does by default with the release it injects.
- Errors inside Web Workers (`src/workers/*`): they reach the page as rejected promises and the UI shows them.
- Reporting expected errors (server actions that return `{ status: "error" }`), simulation validation errors and
  `SimulationCancelled`.
- A tunnel route past ad blockers (Q4).
- The MCP package (`packages/mcp`) outside the app's `/api/mcp` route.
- Sentry's Vercel integration, alert rules beyond the default, Slack.
- Loading and empty states, dark mode and phones (`docs/plans/c5-states-brief.md`), the onboarding wizard ("skip it for
  now"), and Austin's visual pass.

## Done when

- [ ] `@sentry/nextjs` is exactly `10.76.1`; the lockfile is committed; `@sentry/cli`'s build script is approved if
      pnpm asked.
- [ ] Without `NEXT_PUBLIC_SENTRY_DSN` the build and the app behave as before (CI's normal build), and nothing calls
      Sentry.
- [ ] With the DSN and no build variables the build passes and emits no `.map` files (CI step or test).
- [ ] With all four variables, source maps upload after the compile and are deleted (Austin verifies on Vercel).
- [ ] Browser errors (global handler, `global-error.tsx`, segment `error.tsx` for client errors) and server errors
      (`onRequestError`: render, route handlers, server actions, proxy) are captured; edge is wired.
- [ ] Every event and breadcrumb passes through `scrubEvent`/`scrubBreadcrumb`; the scrub tests prove no fixture name,
      email, amount, token, cookie, header or query string survives.
- [ ] /privacy lists Sentry; ADR 0017, PRD D49, README, `.env.example` and HANDOVER are written.
- [ ] `/monitoring-check` exists for agency admins only.
- [ ] The PR body has "What Austin does" in full.

## Open questions (each with the default the builder uses)

1. **SDK major:** 10.76.1 or 11.4.0? **Default: 10.76.1**, pinned exactly. 11.0.0 is two weeks old and turns on
   build-time server instrumentation by default; move to 11 in a month as its own small PR.
2. **Sentry data region:** EU (Germany) or US? **Default: EU.** No Australian region exists; the EU gives GDPR terms,
   and the /privacy wording follows the choice. Austin picks it at sign-up.
3. **Sentry's Vercel integration:** **Default: no**; four variables set by hand are less access.
4. **Tunnel route** (send through our own server so ad blockers don't drop events): **Default: no.** It would go
   through `proxy.ts`, which redirects signed-out requests (share-link visitors), and adds server load. Revisit if
   events look thin.
5. **Report from Preview deployments?** **Default: yes**, tagged `preview`, with the same scrubbing. Local `next dev`
   never sends.
6. **Bundle cost without a DSN** (the SDK is bundled but idle): **Default: accept** (Austin is setting the DSN). The
   alternative, a dynamic import, would miss errors during hydration.
7. **Where `error.tsx` goes:** **Default: the workspace segment and the demo segment only**, plus `global-error.tsx`.
   Per-page error screens are a design decision for Austin's pass.
8. **The second CI build** to prove the "DSN without token" path: **Default: the CI step** in 3h. If it makes `check`
   slower than about 12 minutes in total, replace it with the config test and say so.
9. **User id on events** (a pseudonymous uuid would count affected users): **Default: no user at all.** Austin can ask
   for it later; it would need an ADR 0017 amendment.
10. **Allow-listed words versus dropping messages entirely:** **Default: allow-listed words.** Dropping messages loses
    most of the value; a regex scrubber can't find names our SQL puts in unquoted. The vocabulary holds no names, and a
    test keeps it that way.
