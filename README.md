# Transpera Flow

Process-map simulator: turns a company's workflows into a runnable
discrete-event Monte Carlo model. Product spec and decisions: [`docs/PRD.md`](docs/PRD.md).
Work is tracked as GitHub issues (milestone parents #1–#3). Picking this up? Start with [`docs/HANDOVER.md`](docs/HANDOVER.md).

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js 16 app (App Router, Tailwind v4, React Flow) |
| `packages/engine` | Simulation engine, shared by the browser (Web Worker) and Node |
| `packages/db` | Postgres migrations and runner, seed, generated types, the Kysely `createDb`, row → engine model mapping |
| `packages/mcp` | MCP server: tools and the `/api/mcp` request handler (see below) |
| `prototype/` | The original single-file prototype; the engine port is tested against it |

## Develop

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm dev            # http://localhost:3000
```

Without `DATABASE_URL` and `BETTER_AUTH_SECRET` the app runs in **demo mode** (`/demo`), showing the
Northbeam sample from the seed fixtures. To use a database, copy
`apps/web/.env.example` to `apps/web/.env.local` and fill it in.

## Stack and database

The database is [Neon](https://neon.tech) Postgres (Sydney, AWS ap-southeast-2); the app is hosted on Vercel. Sign-in is
[Better Auth](https://www.better-auth.com) with Google (`/api/auth/*`), kept in the `better_auth` schema of the same
database. Queries go through Kysely and a `pg` pool as the database role `authenticated` (or `anon` when signed out), with the
user's claims set for each transaction, so the row-level security policies and SECURITY DEFINER functions decide what each
request sees (`packages/db/src/client.ts`, ADR [0019](docs/adr/0019-neon-and-better-auth.md)). Statements are cut off after
3 s for `anon` and 8 s for `authenticated`, and a function that sets its own `statement_timeout` gets it.

| Variable | What |
|---|---|
| `DATABASE_URL` | The database owner's connection string. Migrations, Better Auth and the sign-in access functions use it. |
| `APP_DATABASE_URL` | The `authenticator` login the app's queries use. Optional locally (falls back to `DATABASE_URL`). |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `OAUTH_PROXY_SECRET`, `PREVIEW_ALIAS_URL` | Better Auth's secret, the deployment's URL, the preview-alias proxy secret, and the stable preview alias previews sign in through. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. `AUTH_PROVIDERS` also accepts `microsoft`, which needs `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT_ID`. |
| `ACCESS_ADMIN_EMAILS` | Addresses that sign in as Admin, so a new deployment's first admin can get in. |

```sh
pnpm --filter @transpera-flow/db migrate [--dry-run]   # apply new migrations to DATABASE_URL (--dry-run lists them)
bash packages/db/scripts/db-sql.sh -c "select 1"    # psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
bash packages/db/scripts/db-sql.sh -v app_password="$APP_PASSWORD" -f packages/db/scripts/create-app-login.sql
pnpm --filter @transpera-flow/db gen:types          # db-types.ts, json-columns.ts, function-types.ts (needs local Postgres)
```

`create-app-login.sql` creates the `authenticator` login (no privileges of its own; it can only become `anon` or
`authenticated`) with the password you pass. Put it in `APP_DATABASE_URL`; the password never goes in git. The migration log
and production steps are in [`docs/production-migrations.md`](docs/production-migrations.md); notes on what was checked only
against plain Postgres are in [`docs/supabase-notes.md`](docs/supabase-notes.md).

Standing up a deployment for a new client (Vercel project, Neon database, Google or Microsoft sign-in): follow
[`docs/new-client.md`](docs/new-client.md); `bash scripts/new-client.sh` walks the dashboard steps.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test           # database tests need Postgres, see below
pnpm --filter @transpera-flow/web build && pnpm --filter @transpera-flow/web e2e
```

`e2e` (needs a finished build, served without a database or auth secret, so the app is in demo mode) opens every demo page at
400, 768 and 1024 px and in dark mode: no sideways scroll, nothing past the edge, phones read only, no light surface in
dark mode. It runs in CI's `check` job after the build.

`pnpm test` runs the PRD §6.7 timing tests (tagged `perf`) last, on their own, so
the other suites don't share the CPU with them. A package's own `pnpm test` leaves
them out; run them there with `pnpm test:perf`.

Database tests create a throwaway database on the Postgres at `DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/postgres`) and load a
small stand-in for the `auth` schema and roles that policies read, the migrations and the seed.

After changing the fixtures, regenerate the seed with `pnpm --filter @transpera-flow/db gen:seed`.

The engine's golden models fail on any change that moves a snapshotted number. If the change is meant to,
approve the new baselines, which bumps `ENGINE_VERSION`:
`pnpm --filter @transpera-flow/engine golden:approve "why the numbers moved"` (see `docs/engine-versioning.md`).

## Storybook and visual tests

`pnpm storybook` opens Storybook (stories in `apps/web/stories/`). Playwright screenshots every story in both themes and
CI compares them with committed baselines; to approve an intended visual change, push a commit whose subject contains
`[visual-update]`. See [`docs/visual-regression.md`](docs/visual-regression.md).

## MCP server

`/api/mcp` is a Streamable HTTP MCP endpoint (PRD §7.1). Create a personal
token under **API tokens** in the app (shown once; only its hash is stored),
then connect Claude Code:

```sh
claude mcp add --transport http transpera-flow https://<host>/api/mcp \
  --header "Authorization: Bearer tf_…"
```

The server is **read-only**: Claude and ChatGPT query and report, and nothing they call writes company data, sources, issues,
drafts or processes (docs/plans/cut-list.md item 5). Tools: `list_workspaces`, `set_active_workspace` (the only state it
changes: the token's own active-workspace setting), `get_workspace_summary`, `get_process`, `get_facts`, `get_first_principles`,
`list_issues`, `list_solutions`, `list_sources`, `list_templates`, `run_scenario`, `compare_scenarios`, `check_robustness`
(time-capped; a capped check is flagged `partial`) and `get_bottlenecks` (with the shadow price: extra completions per quarter
from one more FTE in the top bottleneck role; see `packages/engine/src/shadow-price.ts`). `run_scenario` and
`compare_scenarios` take their changes as arguments and save nothing. The database also refuses company-model writes made with a
token. The endpoint acts as the token's user under RLS through the same database pool as the web app; no extra environment
variables. How it checks the token and acts as its owner:
[`docs/adr/0018-mcp-tokens-checked-in-app-code.md`](docs/adr/0018-mcp-tokens-checked-in-app-code.md).

To turn interview transcripts into a process, use the `process-file` skill and upload the files in the app:
[`docs/import/README.md`](docs/import/README.md). The upload code lives in `packages/db/src/process-import`.

## Narration (Claude)

"Explain this run" can be drafted by Claude
(`claude-opus-5-5`), server-side only, when `ANTHROPIC_API_KEY` is set in the
server's environment (Vercel: Production and Preview). Without it the templated
text prints and the UI says narration needs the key. Every number in a draft is
checked against the run's figures; one redraft, then the template. Tests use
fakes and never call the API. The public `/demo` uses a stand-in writer, never
the API. See [`docs/adr/0011-narration.md`](docs/adr/0011-narration.md).

## Error reporting (Sentry)

Errors from the browser, the Node server and the edge runtime go to Sentry when
`NEXT_PUBLIC_SENTRY_DSN` is set (Vercel: Production and Preview). Without it
nothing is initialised or sent, the build is exactly the one without Sentry, and
the browser bundle holds none of the SDK (the DSN is read at build, so a change
needs a redeploy).
Source maps (so stack traces read as our TypeScript) are made and uploaded at
build only when all of `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`
are set too; they are deleted after upload, and a failed upload warns without
failing the build. A local `next dev` never sends. Copy `apps/web/.env.example`
for the names.

Nothing personal is sent: no names, emails, pay, workspace contents, share-link
snapshots or tokens, headers, cookies or query strings. One tested scrubber
(`apps/web/src/lib/monitoring/scrub.ts`) rebuilds every event, and error
messages are cut down to a fixed vocabulary. See
[`docs/adr/0017-error-reporting.md`](docs/adr/0017-error-reporting.md).

After setting the variables and redeploying, sign in as an agency admin and open
`/monitoring-check` (linked from nowhere) to send a test error from the browser
and one from the server. The steps in Sentry and Vercel are in
[`docs/plans/c5-sentry-brief.md`](docs/plans/c5-sentry-brief.md), "What Austin does".
