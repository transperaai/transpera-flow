# Handover

Updated 5 Oct 2026 (evening AEST). Milestone A is done (only A24, #27, open). The Milestone B redesign tickets (B11–B19) are
merged and applied to production; only the map node redesign is left, to be designed with Austin. Start a new session with:

> Read `CLAUDE.md` and `docs/HANDOVER.md`, then carry on from "Next steps".

## Where things stand

**Milestone A** (redesign A31–A58, #96–#123): merged as #125–#160; see git history and #1 for the per-ticket log.

**Milestone B redesign.** Austin's decisions: B12 links processes and never edits them; B14 skill; B15 Overview spec;
B16 process page; B17 hybrid analysis; B18 sources library and tour; B19 manual entry; stay on Supabase Free. Merged
(rows refer to `docs/production-migrations.md`):

| Ticket | Migrations |
|---|---|
| B11 company map (#163) | rows 40, 42 |
| B13 process upload (#166) | rows 41, 43 |
| Harden versions (#171) | row 44 |
| B14 import bundle, part 1 (#167) | row 45 |
| B12 process library (#164), parts 1 and 2 | rows 46, 47 |
| B18 sources library and tour (#176) | row 48 |
| B19 manual entry (#182), part 1 and part 2 (#194) | rows 49, 51 |
| C2 calibration, part 1 (#41) | row 50 |
| B6, B10 part 1, B16 process page, B15 Overview (#193) | none |
| B17 analysis rework (#175, PR #195) | row 52 |

**Production database:** applied up to `20261205000000` (row 52), each checked before and after. No PRs are open.

**Design calls Claude made, for Austin to confirm:**
- When a process is placed inside an ordinary process, the company map "gives way" (B12 part 2, #188).
- Workspace name and currency are owner-only (#190).
- Levers and the forecast are not on the Overview; the Settings help says so.
- An archived process opens read-only with a banner.
- A person's Pass verdict counts as Verified, with the simulation result shown too.

**Waiting on Austin:**
- **#39:** B10 part 2 (import), 4 questions.
- **#41:** C2 part 2, 5 questions.
- **#175:** B17, 4 questions: does Accept create the issue? First principles company-wide? Can MCP propose findings? What
  happens to the old rule settings? (Production had 0 `analysis_rules` rows, so removing the rules editor moved no numbers.)
- **Live checks after B19 part 2 (#182):** a real source file upload works and Supabase sets `storage.objects.owner_id`; a
  PDF's text is read on Vercel (`unpdf` ships via `outputFileTracingIncludes` in `apps/web/next.config.ts`, untested there).
- C5 is Austin's.

**Still open from Milestone A:**
- **CI timing tests:** the PRD §6.7 tests (`scenarios.test.ts`, `servicing.test.ts`) use absolute limits that shared
  GitHub runners miss by 15–20% now and then, even after #148. Options: a separate perf job with one retry, or
  budgets relative to a baseline measured on the same runner. Tests have not been loosened.
- **AI analysis sources (A46):** "read linked sources and quotes" defaults off (it would send interview quotes to
  Anthropic). Switch on per workspace in Settings → AI analysis if wanted.
- **D38 sign-off:** a resolved issue stays off the map; a re-detection shows as an insight (recorded in the PRD; treated
  as accepted).
- **MCP `link_later`:** `add_source` may skip links only for transcripts that `import_process` / `add_step` /
  `update_step` will cite; the extract-process skill then links each transcript to the process. Kept on the
  reviewer's advice.
- **24-month speed:** a slider move on full Northbeam at 24 months takes about 360–440 ms, against the 250 ms
  13-week target (A58 tests against the target scaled by horizon).

**Follow-ups noted:** an exact per-month MRR series from the engine (A35's range covers new-client revenue only);
an MCP client-groups tool; rule 9 in settings; the horizon picker on more pages; block delete/rename; ~~the flaky
`map-browser.test.ts` "does not move the view when a highlight changes"~~ (fixed: the harness mounted a read-only map in a
bare flex row, so it shrink-wrapped to its toolbar and refit when the "drag the map" hint resized it; it now sits in a block,
as in the app).

## How we work

- **Austin approves waves; within a wave, carry on without waiting.** Tell him when each wave finishes and go
  straight to the next unless he says otherwise.
- **Delegate building to agents** to save the main session's context. Model policy (Austin's, 5 Oct): **Opus scopes every
  ticket first** into a precise brief (exact files and functions, data model and migration spec, patterns to copy, edge cases,
  tests, out of scope, done criteria, Austin's decisions quoted verbatim); **Sonnet builds strictly from that brief** and asks
  rather than guesses; **Opus does an adversarial review** before merge. Give routine work (merges, small fixes) to Sonnet or do it
  directly. Tell agents to **commit and push after every step**: a container restart once lost unpushed agent work.
- **Keep GitHub issues current:** comment on a ticket when work starts (name the branch), put `Closes #N` in the
  PR, and post a progress comment on the milestone parent issue after each wave.
- **Production migrations: apply as we go** (Austin approved this). Additive only; verify after each, and log
  it in `docs/production-migrations.md`. Anything destructive, or any other production-affecting action, needs
  Austin's go-ahead first.
- Austin would rather Claude runs commands than he does. Never paste API keys or tokens into chat.
- If the auto-mode classifier blocks an action, stop and ask Austin; never work around it.
- **Parked for later** (Austin): performance optimisation (see below), and refining the flow after his review.

## Operations

**Production SQL** (Supabase project `vgsjkpwvxkpqvyazwcyq`, via the Management API; allowed in
`.claude/settings.json`):

```sh
bash packages/db/scripts/prod-sql.sh -c "select 1"
bash packages/db/scripts/prod-sql.sh -f apply.sql
```

**Applying a migration:**
1. Before merging the PR, write an apply file:
   - `begin;`
   - the migration's SQL
   - `insert into supabase_migrations.schema_migrations (version, name, statements) values ('<version>', '<name>', array[$mig$<the migration SQL>$mig$]);`
   - `commit;`
2. Run preflight queries for anything that could fail on real data.
3. Apply the file.
4. Verify: tables, row-level security, policies, and the `schema_migrations` row.
5. Merge the PR, then update the log.

- **Migration order:** migrations apply in file-name order. A migration landing after a later-numbered one
  must be renumbered.
- **`save_fields`:** each migration that redefines `save_fields` must copy the **latest** definition and
  append to its allow-list, because the last definition wins.

**CI:**
- The GitHub `check` job runs lint, typecheck, tests, the build, and the PostgREST end-to-end tests. Each PR
  also gets a Vercel preview.
- In the cloud container there is no `gh`; use the GitHub MCP tools. Squash-merge with the full head SHA as
  `expectedHeadSha`. Branch protection requires the `check` status: merging while it runs returns 405.
- Per ticket: build, Opus review, fixes, merge `origin/main` (regenerate `bootstrap.sql` with
  `pnpm --filter @transpera-flow/db gen:bootstrap`, never by hand), CI green, production preflight, apply
  (`prod-sql.sh -f <apply file>`, which sets `lock_timeout`), post-apply checks, mark the row applied and push, CI, merge,
  comment on the issue.
- `prod-sql.sh` gotchas: errors come back as curl exit 22 with a 400; `[]` means success. Write SQL to a file first. Function
  bodies store `can''t`, so a `like` against them needs `can''''t`; cast `"char"` columns (`tgenabled::text`); compare
  `proconfig` with `array['search_path=""']`.
- `apps/web/test/format.test.ts` (£27.4K) fails only in the cloud container (ICU); it passes in CI.

**Local tests in the cloud container** (Postgres 16 and Chromium are preinstalled):

```sh
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgtest/data -o '-p 5432 -k /tmp' -l /var/tmp/pgtest/log start"
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
export CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
pnpm lint && pnpm typecheck && pnpm test
```

If `/var/tmp/pgtest/data` doesn't exist after a container reset, run `initdb` there as `postgres` and set the
password to `postgres`.

**Secrets:**
- `SUPABASE_ACCESS_TOKEN` is set in the cloud environment.
- `ANTHROPIC_API_KEY` is set in Vercel (Production and Preview) for narration (#29). Without it, "explain this run" prints
  the templated text.

## Next steps

1. Austin's answers above (#39, #41, #175) and his live checks of B19 part 2.
2. Build queue, each Opus-scoped then Sonnet-built: B1 (roles and visibility), then B3 and B4; B7 (forecast planning,
   builds on B6); check B2 (People page) against B19; C1 (CSV import wizard); C4 (Storybook). B10 part 2 waits on #39,
   C2 part 2 on #41.
3. The map node redesign, designed with Austin.
4. A24 (#27): needs Austin's transcripts.

Follow-ups from Milestone B: other source pickers still load full source text; four older PostgREST suites fail when
re-run on the same database.

## Decisions from Austin (30 Sep)

- **Google sign-in only** stays (the #4 ticket said magic link; the app has "Continue with Google").
- **Most real audits:** Austin will usually give Claude the process structure (nodes, often from a diagram) over MCP
  and fill in times and percentages on the canvas. Transcripts are one input, not the only one.
- **Scenarios should come from analysis, not a preset library.** Today every workspace is seeded with four generic
  scenarios (`private.scenario_library()`: hire into the busiest role, automate the heaviest step, more leads,
  downturn; `@busiest` / `@heaviest` resolve at run time) and Northbeam has two example ones. Austin's vision:
  simulate the current state, then derive options from the results (bottleneck, shadow price, queues, issues) and
  an **AI analysis mode** that reads a range of simulated factors (robustness sensitivities, narration facts) and
  proposes and tests changes, ranked with ranges. He wants to play with the current version first: **don't build
  until he decides**; it's a candidate Milestone B ticket.

## Open items for Austin's QA

- The lost-revenue definition, and the starter scenarios (see the decision above).
- Larkspur (the second sample workspace) is not seeded in production; it's only at `/demo/larkspur`.
- The /privacy wording added with #29 (narration sends model numbers to Anthropic).
- A live narration check on production (the API key is set).
- The two-browser Realtime test: presence plus live changes.
- #27: the timed Copperleaf run.

## Performance (parked until the end of the build)

PRD §6.7 targets:
- Pipeline-only Northbeam, re-run after a lever change: < 150 ms.
- Full seeded Northbeam with its client roster and servicing: < 250 ms. It's roughly twice the cost because
  servicing simulates the 26 clients' ongoing work as well as the pipeline.

Both are tested in `apps/web/test/scenarios.test.ts`. The engine was optimised twice during #19, with
byte-identical results. Further work, starting with profiling the servicing
simulation, waits for Austin's end-of-build review.

## Follow-ups (not ticketed yet; raise with Austin when planning)

- "Open in Editor" on a saved solution starts a new solution from live; loading the saved copy needs the Editor's
  solution session to seed from a stored copy (A50).
- The play-link Proposals queue (B4, #33): A52's schema supports it (`created_via='play_link'`, proposer fields).
- A46's service-role writer for AI analyses (Austin adds the key in Vercel himself; never in chat).

- MCP editing tools (`add_step`, `update_step`, …) open a draft (`beginEdit`) before validating names; a failed call
  leaves a harmless copy of live as a draft. `import_process` was fixed in #91 to write nothing on failure.
- `applyPlan` in `packages/mcp` isn't transactional: a DB error mid-write can leave a partial draft.
- Roles settings count usage from all step revisions via PostgREST (max 1000 rows), so a big workspace could
  under-count; the `in_use` trigger still refuses a bad delete. A count RPC would fix it.
- The services fallback-load editor and the client-assignment roster still list inactive roles.
- Extraction: routing (edge) probabilities have no evidence or provenance, so routing conflicts aren't tracked;
  register the skill as an MCP prompt so Claude desktop needs no install; add clients, services and lead sources to
  `get_workspace_summary`; a `list_sources` tool; range citations (`value_min`/`value_max`).
- The extraction fixture lint doesn't check new steps inside a `target` import (the e2e test does).
- The `suggestions` table (20261015000000) has the same bug A52 fixed for `suggestion_proposals`: deleting an auth user
  who created or reviewed a suggestion fails, because the foreign key's `ON DELETE SET NULL` trips the
  `suggestions_before_write` guard ("Suggestions are accepted or rejected with review_suggestions"). Fix it with a new
  migration that lets a depth > 1 change of only `created_by` or `reviewed_by` to null through (see
  `private.suggestion_proposals_before_write`).
- Source links (A53, #118), follow-ups:
  - Taking an issue's removed sources' links away is done in the app's `write()` (issue-actions.ts) after `save_issue`, so it
    isn't atomic with it. Move it into `save_issue` with a migration (delete the issue links of the sources it removes from
    `issue_sources`).
  - MCP `add_source` / `link_source` check an insight link's key only for its shape, not that the analysis ever produced it.
  - MCP resolves step names against the live revision only (`loadLinkTargets` falls back to the draft only for a
    never-published process), so a step that exists only in a draft can't be linked by name.
  - A writer that removes sources through `save_issue` directly (not the app) leaves the issue's links; the issue still shows
    the source until it is removed on the issue page.

## Other open items

- [ ] Upgrade Supabase and Vercel to Pro before real client data (PRD D2).
- [ ] DPA clause in the retainer contract (PRD D20).
- [ ] Custom SMTP for Supabase auth emails before inviting clients.

## Things worth knowing

- **Next.js 16:** `proxy.ts` replaces middleware, and request APIs are async. Read `apps/web/AGENTS.md` and the
  bundled docs before writing Next code.
- **Demo mode:** without Supabase env vars, the app redirects to `/demo`, which runs Northbeam from the fixtures.
- **Engine determinism:** never use `Math.log`/`Math.exp` in the engine; use `det-math.ts`. Any change that moves
  golden-model numbers needs an `ENGINE_VERSION` bump and `golden:approve` (see `docs/engine-versioning.md`).
- **Fixtures are the source of truth for sample data:** after changing them or a migration, run
  `pnpm --filter @transpera-flow/db gen:seed` and `gen:bootstrap`. CI fails if either is stale.
- **Plain Postgres vs Supabase:** anything verified only against plain Postgres goes in `docs/supabase-notes.md`.
