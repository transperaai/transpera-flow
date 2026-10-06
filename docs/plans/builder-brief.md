# Builder brief (for agents building redesign tickets)

You are building one ticket of the Transpera Flow redesign (Milestone A, #96–#123). Read this whole brief first.

## Read before coding

1. `CLAUDE.md`, `apps/web/AGENTS.md` (Next.js 16: read the bundled docs before writing Next code) and the operations
   section of `docs/HANDOVER.md`.
2. Your ticket on GitHub (transperaai/transpera-flow), including its acceptance criteria and blockers.
3. `docs/plans/redesign-plan.md`, plus `docs/analysis-rules.md` and `docs/research/first-principles.md` if relevant.
4. The prototype screen your ticket names, in `apps/web/prototype/app-flow.html` (live:
   https://claude.ai/artifact/KqK4DAsAYLk4EnzbBGvLjr). Match its layout, wording and behaviour. The prototype is a
   throwaway reference: never import from it or ship it.

## GitHub

There is no `gh` CLI. Use the GitHub MCP tools. Load them with ToolSearch, e.g.
`select:mcp__github__issue_read,mcp__github__add_issue_comment,mcp__github__create_pull_request,mcp__github__pull_request_read`.

- When you start, comment on your ticket: "Started on branch `<branch>`."
- Every comment and PR body ends with the attribution lines given to you below.
- **Do not merge your PR.** The orchestrator reviews it, applies migrations and merges.

## Branch

Create `claude/<a-number>-<short-slug>` (e.g. `claude/a32-remove-old-features`) from the base the orchestrator names.
Commit and push after every meaningful step (`git push -u origin <branch>`, retry on network errors). A container
restart can lose unpushed work.

## Rules

- **Plain language:** wording follows the prototype. Every setting, lever and rule gets an (i) with a plain-English
  description and an example, using the (i) help component once A33 has built it.
- **Engine numbers:** read `docs/engine-versioning.md`. Any change that moves golden outputs needs an `ENGINE_VERSION`
  bump and `pnpm --filter @transpera-flow/engine golden:approve`. The PR explains why the numbers moved. Never use
  `Math.log` or `Math.exp` in the engine (use `det-math.ts`). The performance tests must still pass.
- **Migrations:**
  - Use the version number the orchestrator gives you.
  - Additive only.
  - Put full rollback SQL in the header comment.
  - If you redefine `save_fields`, copy the **latest** definition and append to its allow-list.
  - After changing fixtures or migrations, run `pnpm --filter @transpera-flow/db gen:seed`, `gen:bootstrap` and
    `gen:types`.
  - Write a production apply file at `packages/db/scripts/apply/<version>_<name>.sql`: `begin;`, the migration SQL,
    the `insert into supabase_migrations.schema_migrations …` row (see HANDOVER), then `commit;`.
  - Also list any preflight queries in the PR body.
- **Anything verified only against plain Postgres** goes in `docs/supabase-notes.md`.
- **Never** skip, disable or loosen a test to get green.

## Before opening the PR

Start Postgres and run everything (commands from HANDOVER):

```sh
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgtest/data -o '-p 5432 -k /tmp' -l /var/tmp/pgtest/log start"
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
export CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build
```

If `/var/tmp/pgtest/data` doesn't exist, run `initdb` there as `postgres` and set the password to `postgres`. If
Postgres is already running (another agent started it), use a different port and database for yours, or reuse it with
your own database name, so you don't clash.

**Known local-only failures:** in this container, `apps/web/test/format.test.ts` ("formats money") and
`apps/web/test/narration.test.ts` ("keeps names out") fail because of the container's number formatting ("£27.4K" vs
"£27.4k"). They pass in CI. Don't change them.

For UI tickets, run the app in demo mode (no Supabase env vars, `next dev`) and take Playwright screenshots of your
screens in light and dark, at 1440 px and 400 px. Use Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
and `/opt/node-tools/node_modules/playwright`. Attach what you saw to the PR as text evidence: what you checked and that
it rendered without console errors.

UI changes: if the `visual` job fails, look at its report, and if the change is intended push an empty commit with
`[visual-update]` in the subject (see `docs/visual-regression.md`).

## PR

Write the body with the `pr` skill's template (`.claude/skills/pr/SKILL.md`): Summary, Evidence, Merge Danger. Include:

- `Closes #<ticket>`;
- the migration version and apply file path, if any;
- golden or engine changes, if any.

## Report back

When the PR is open and your local checks are green, report:

- the PR number and branch;
- what you built, and anything in the acceptance criteria you couldn't do, with the reason;
- migrations and the apply file path;
- engine version changes;
- anything the orchestrator must do before merging.
