# Handover

Updated 6 Oct 2026 (evening AEST). This session built B1 slices 2b and 3/3 (#30) and C2 part 2 (#41). All three are
reviewed, green or nearly green, and **waiting only on production**: the stored Supabase token now returns 401, so
nothing was applied. Start a new session with:

> Read `CLAUDE.md` and `docs/HANDOVER.md`, then carry on from "Next steps".

## Where things stand

**Milestone A** (redesign A31–A58, #96–#123): merged as #125–#160; see git history and #1 for the per-ticket log.

**Milestone B.** B11–B19 merged on 2–5 Oct (rows 40–52; see `docs/production-migrations.md` and the git log). Earlier on
6 Oct:

| Ticket | PR | Migration |
|---|---|---|
| B1 (1/3) keep an owner, link people, role-matrix tests (#30) | #199 | row 53 |
| B10 (2a) export limited to admins/owners/editors, import planner (#39) | #200 | none |
| B10 (2b) restore a workspace from a backup, closes #39 | #201 | row 54 |
| B1 (2/3a) per-person privacy in the database, no pay data for members (#30) | #202 | row 55, ENGINE 1.7.0 |

**Open PRs (this session, 6 Oct evening).** Each was built by Sonnet from an Opus brief, adversarially reviewed by Opus,
and every finding fixed with a test. Apply and merge **in this order**:

| Order | PR | Branch | Migration | Row | CI |
|---|---|---|---|---|---|
| 1 | #205 B1 (2/3b) privacy on screen; no pay or names in saved text (#30) | `claude/amazing-planck-64op6x` | `20261207700000_saved_text_privacy` | 56 | green; ready for review |
| 2 | #207 C2 (2/2) client churn back-solve, the two CSVs, measured checks; closes #41 | `claude/c2-2-calibration` | `20261208000000_client_calibration` | 57 | test fix pushed (705a258), check CI |
| 3 | #206 B1 (3/3) agency workspace list; editors change client health rules; closes #30 | `claude/b1-3-agency-list` | `20261209000000_agency_list` | 58 | green; draft |

- #205 bumps `ENGINE_VERSION` to 1.8.0 (overtime evidence states hours only; no golden number moved). It had two Opus
  reviews. Its migration also re-keys stored AI keys that hashed real names (Austin's call, below).
- #207 keeps 1.7.0 itself; after #205 merges it sits on 1.8.0. It needs no bump.
- All three hand-edited `packages/db/src/database.types.ts` (`gen:types` needs the linked project). Regenerate once all
  three are applied.

**Production database:** applied up to `20261207500000` (row 55). Rows 56–58 are written, with apply files, preflight
and post-apply checks in each migration's header, and logged in `docs/production-migrations.md` as NOT applied.

**Briefs** (in `docs/plans/`): `b1-brief.md` (all slices built; 2b's section has the leak fixes and "Changes after the
review"), `c2-2-brief.md` (built), `b10-2-brief.md` (done). Every ticket gets one before building.

**Austin's decisions on 6 Oct** (each recorded on its issue):
- **#30 (B1 2b), evening:** Q10 and Q11 defaults stand: an issue title an editor pre-fills from an insight keeps the real
  name (like any typed title); AI text saved before 2b may quote overtime money, so after the migration editors re-run
  Analyse and check accepted AI findings (older revisions too). **Stored keys must hold no names:** `findings.ai_key`, the
  `ai:insight:` issue keys, source-link insight keys and saved insight keys are re-keyed to opaque ids (accepted: a finding
  may be proposed once more; old pre-B17 insights lose their "acknowledged" link). New finding keys hash the title with
  person ids, so they survive roster changes.
- **#39 (B10):** import makes each process a draft of its live version, with no history; the new workspace keeps its own
  company map; hidden clients go in the bundle; only agency admins, owners and editors export or import; one additive
  SECURITY INVOKER function is fine; saved solutions are listed as not restored; a restored workspace's results match the
  original within run-to-run variation (ids feed the random streams, so exact seed equality is impossible).
- **#41 (C2 part 2):** all five recommendations (back-solve churn, measured drivers shown beside the simulated ones, the two
  CSVs, late payments out). Per-person speeds were never built; they moved to C6 (#198), which Austin parked as phase 2
  (not wanted for now).
- **#175 (B17):** Accept doesn't create the issue; company analysis is judged against the main pipeline's first principles;
  old rule settings stay unread; **MCP may propose findings** (new ticket B20, #197).
- **#30 (B1):** Google sign-in only (magic link superseded); invites stay email-free; members and viewers see "Team member N"
  labels, only their own row, "A team member" for other names, and **no pay data**. Overtime cost and person-rate issue
  costs show "—" for them. Averages were rejected because overlapping averages leak an exact rate by subtraction.

**Design calls Claude made, for Austin to confirm:**
- When a process is placed inside an ordinary process, the company map "gives way" (B12 part 2, #188).
- Workspace name and currency are owner-only (#190).
- Levers and the forecast are not on the Overview; the Settings help says so.
- An archived process opens read-only with a banner.
- A person's Pass verdict counts as Verified, with the simulation result shown too.
- B1: a workspace with a single rated person in a role still shows that role's default rate to members (a planning default,
  not a person's pay).
- C2 part 2: a due time of exactly 00:00 with no zone in a servicing log is a date-only due (end of that day); Northbeam
  has no ad-hoc servicing, so the demo's response-time check reads "No servicing work is set to come in as ad-hoc requests"
  (adding one would move goldens).
- B1 3/3: headline numbers are a closed five-key shape; `computed_by`/`computed_at` are stamped by a trigger.

**Waiting on Austin:**
- **Live checks after B19 part 2 (#182):** a real source file upload works and Supabase sets `storage.objects.owner_id`; a
  PDF's text is read on Vercel (`unpdf` ships via `outputFileTracingIncludes` in `apps/web/next.config.ts`, untested there).
- **Supabase token (blocking):** `SUPABASE_ACCESS_TOKEN` in the cloud environment returns `401 Unauthorized` from the
  Management API (6 Oct evening). Austin will put a new token in the environment settings; a new session picks it up.
- **Auto mode:** its safety check blocks `prod-sql.sh` as "Production Reads", even read-only preflight. Austin plans an
  overnight run with access granted; run production steps with auto mode off or a permission rule for `prod-sql.sh`.
- C5 is Austin's.

**Still open from Milestone A:**
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

- **Two or three tickets per session** (Austin, 6 Oct), to protect the context window. End each session with the handover.
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
- **Container restarts** stop background agents mid-task (it happened once this session). Agents that pushed after every
  step lost nothing; re-launch a fresh agent with what's pushed and what's left. Postgres stops too: restart it with the
  command below.
- **CI logs:** the job log tail is only Postgres server output. Download the full log (`get_job_logs` with
  `return_content: false` gives a URL; `curl` it to the scratchpad) and grep for `FAIL` or `::error`.
- **Engine model changes** (a new optional field, a nullable output) take `golden:approve --bump` even when no numbers
  move (1.7.0 for B1's `payHidden`).

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

**Overnight run (Austin, 6 Oct): do everything through to merged, then carry on with the next tickets.** First check the
token: `bash packages/db/scripts/prod-sql.sh -c "select 1"` must return a row, not 401. If it fails, stop and say so.

**#207's CI (as of 6 Oct evening):** after the PostgREST test fix (705a258), one CI run failed in
`packages/db/test/workspace-import.test.ts` ("a restore is a round trip > Northbeam … within run-to-run variation"):
`costPerWin` restored 4038.9 vs source 3337.2, tolerance 655.5. #207 doesn't touch restore. A restored workspace gets new
ids, which feed the random streams, so this check is statistical and can fail by chance (it also failed once locally under
load). Check the second run on the same commit. If this test fails on any branch, make it robust in its own small PR (e.g.
more replications or a tolerance derived from the run-to-run spread), never by skipping it, and merge that first.

For each PR in order (#205, then #207, then #206), follow "Applying a migration" below:
1. Bring `origin/main` into the branch (merge, never rebase). For #207 and #206 that brings the previous migration in:
   regenerate `bootstrap.sql` with `pnpm --filter @transpera-flow/db gen:bootstrap` and fix the
   `docs/production-migrations.md` rows (56, 57, 58). Push; wait for CI to go green.
2. Run the migration header's **preflight** queries one file at a time (`prod-sql.sh -f`; it returns only the last
   statement's result). Record the numbers in the PR. Stop on any surprise.
3. Apply the apply file (`packages/db/scripts/apply/<version>.sql`).
4. Run the **post-apply checks**. #205's check 7 must run **before** its merge deploys the app.
5. Mark the row applied in `docs/production-migrations.md`, push, wait for CI, take the PR out of draft, and squash-merge
   with the full head SHA (`expectedHeadSha`). Merging deploys.
6. Comment on the issue (#30 or #41) with what was applied and checked.

Then:
- After #205 deploys: tell Austin to re-run Analyse in each workspace and check accepted AI findings (Q11).
- After #206: check on the live site that an editor can change a client health rule, and that the owner's change log names
  the editor. Close #30.
- Regenerate `database.types.ts` if a linked machine is available; otherwise leave the hand edits (they match the
  generator's output and order).
- Then the next tickets, two or three per session, each with an Opus brief first: B20 (#197), B3, B4, B7, B5, check B2
  against B19, C1, C4; B21 (#203) raises restore limits; the map node redesign with Austin.

Follow-ups noted this session:
- B1 2b: read-time key masking (`hideAiIssueKey`, `loadIssuesForReader`) stays as defence in depth after the re-key; it
  costs one `can_see_people` rpc per issues load.
- B1 2b: a source link to an AI insight nobody acknowledged is orphaned by the re-key (`ai:insight:<link id>`); delete if
  wanted.
- B1 2b: the engine's first-principles flag text now gets first-name aliasing, so a step whose first word matches a
  person's first name (same capitals) is relabelled inside that flag sent to the model.
- B1 3/3: `agency_workspace_list` scans `process_revisions` without a workspace-first index; fine at agency scale.
- Flaky under load in the cloud container (pass alone): `restore-browser.test.ts` "refuses a file over the size limit",
  `editor-tour-browser`, once `prototype-parity` "double leads" and `workspace-import.test.ts`. Green in CI.
- The owner guard has a known gap: an owner who joined by domain can delete that domain (ADR 0003 addendum).
- A member can join a process presence channel via dev tools and see editors' names (names only).
- `sources.speakers` and transcripts name people (accepted).
- Restore limits are 50 processes, 500 steps, 1,000 edges, 300 issues, 1,000 clients and link-table caps, to stay inside
  3 s; bigger workspaces export with a warning (#203).
- Older: other source pickers still load full source text; four older PostgREST suites fail when re-run on the same database.

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
