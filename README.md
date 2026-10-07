# Transpera Flow

Process-map simulator: turns a company's workflows into a runnable
discrete-event Monte Carlo model. Product spec and decisions: [`docs/PRD.md`](docs/PRD.md).
Work is tracked as GitHub issues (milestone parents #1–#3). Picking this up? Start with [`docs/HANDOVER.md`](docs/HANDOVER.md).

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js 16 app (App Router, Tailwind v4, React Flow) |
| `packages/engine` | Simulation engine, shared by the browser (Web Worker) and Node |
| `packages/db` | Supabase migrations, seed, row types, row → engine model mapping |
| `packages/mcp` | MCP server: tools and the `/api/mcp` request handler (see below) |
| `prototype/` | The original single-file prototype; the engine port is tested against it |

## Develop

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm dev            # http://localhost:3000
```

Without Supabase settings the app runs in **demo mode** (`/demo`), showing the
Northbeam sample from the seed fixtures. To use a database, copy
`apps/web/.env.example` to `apps/web/.env.local` and fill it in; see
[`docs/supabase-notes.md`](docs/supabase-notes.md).

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test           # database tests need Postgres, see below
pnpm --filter @transpera-flow/web build && pnpm --filter @transpera-flow/web e2e
```

`e2e` (needs a finished build, made without Supabase settings so the app is in demo mode) opens every demo page at
400, 768 and 1024 px and in dark mode: no sideways scroll, nothing past the edge, phones read only, no light surface in
dark mode. It runs in CI's `check` job after the build.

`pnpm test` runs the PRD §6.7 timing tests (tagged `perf`) last, on their own, so
the other suites don't share the CPU with them. A package's own `pnpm test` leaves
them out; run them there with `pnpm test:perf`.

Database tests create a throwaway database on the Postgres at `DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/postgres`) and load a
small stand-in for Supabase auth, the migrations and the seed.

After changing the fixtures, regenerate the seed with `pnpm --filter @transpera-flow/db gen:seed`.

The engine's golden models fail on any change that moves a snapshotted number. If the change is meant to,
approve the new baselines, which bumps `ENGINE_VERSION`:
`pnpm --filter @transpera-flow/engine golden:approve "why the numbers moved"` (see `docs/engine-versioning.md`).

The MCP end-to-end suites (`packages/mcp/test/postgrest*.test.ts`) also need
PostgREST; it is skipped locally unless `POSTGREST_URL` and
`POSTGREST_JWT_SECRET` are set. CI prepares its database with
`packages/mcp/test/postgrest-db.ts` and then starts PostgREST (see
`.github/workflows/ci.yml`). To run it beside another checkout, set
`POSTGREST_DATABASE` to a database name of your own for both steps.

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

Tools: `list_workspaces`, `set_active_workspace`, `get_workspace_summary`,
`get_process`, `run_scenario`, and the analysis tools `save_scenario`,
`compare_scenarios`, `check_robustness` (time-capped; a capped check is flagged
`partial`), `get_bottlenecks` (with the shadow price: extra completions per
quarter from one more FTE in the top bottleneck role; see
`packages/engine/src/shadow-price.ts`), `log_issue` and `list_issues`, and the
process-building tools `add_source` (it needs `links`, or `link_later: true` when the next call cites it), `link_source`, `create_process`, `add_step`,
`update_step`, `remove_step`, `connect_steps`, `set_routing`, `import_process`,
`publish_process`, `discard_draft`, `list_templates` and `create_from_template`, and the first-principles tools `get_first_principles`
and `update_first_principles` (Claude fills them in from transcripts, into the draft).
Building tools write only into a process's draft (`open_draft`), never live;
left-out numbers become assumptions, cited numbers keep their evidence, and
values someone entered are flagged as conflicts instead of overwritten
(`packages/mcp/src/building.ts`). Every MCP row write is audit-logged with
`actor_kind = 'mcp'`. The company-model tools are `set_company`, `upsert_service`,
`upsert_person`, `upsert_client`, `upsert_role`, `set_demand` and
`list_suggestions`: they create suggestions a person accepts on the Suggestions
page, and the database refuses company-model writes made with a token, roles
included. A missing role is suggested with `upsert_role` and can be used in
`import_process` once accepted. The endpoint acts as the token's user under
RLS and uses only `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; no extra environment variables. How it
does that without the service-role key:
[`docs/adr/0002-mcp-acts-as-user-via-pre-request.md`](docs/adr/0002-mcp-acts-as-user-via-pre-request.md).

To turn interview transcripts into a draft process, use the `/extract-process` skill: [`docs/extraction/README.md`](docs/extraction/README.md).

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
