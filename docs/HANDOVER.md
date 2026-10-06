# Handover

Updated 6 Oct 2026 (overnight run, 20:30 UTC). All agents hit the usage limit at about 13:50 UTC and the container
restarted; work resumed at 19:18 UTC from what was pushed. Merged tonight: #205, #207, #206, #209, #212 (B20), #214, #211
(B2), #213 (B5), #216 (B21), #220 (C4), #221, #218 (C1), #222, #217 (B7). Production is at row 63 (`20261219000000`).
Open: B3 (#215, fourth review round), then B4. Status table under "Next steps". Start a new session with:

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

**Merged 6 Oct evening** (each Sonnet-built from an Opus brief and Opus-reviewed; applied with preflight and post-apply
checks, logged in `docs/production-migrations.md`):

| PR | Ticket | Migration |
|---|---|---|
| #209 | Restore round-trip test compares means over 16 runs (6 standard errors) | none |
| #205 | B1 (2/3b) privacy on screen; no pay or names in saved text (#30); ENGINE 1.8.0 | row 56 `20261207700000` |
| #207 | C2 (2/2) client churn back-solve, two CSVs, measured checks; closes #41 | row 57 `20261208000000` |
| #206 | B1 (3/3) agency workspace list; editors change client health rules; closes #30 | row 58 `20261209000000` |

Production had no saved AI text or overtime issues, so row 56's clean-up changed no rows. `database.types.ts` still holds
the hand edits from #205–#207 (they match the generator); regenerate when a linked machine is available.

**Production database:** applied up to `20261219000000` (row 63).

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
- B3 (#32): restricted share links verify by **Google sign-in**, not magic link (magic link needs custom SMTP). Toggles are
  People and Financials; **no one person's pay is ever in a link** (Financials on shows role rates, margins, overhead and
  insight costs; figures that need one person's pay show "—"). Links are frozen copies with Update copy; the server builds
  the snapshot and Postgres refuses a leaky one (ADR 0016, PRD D47). A visitor without a Google account for the listed
  address can't open a restricted link.

**Waiting on Austin:**
- **Live checks after B19 part 2 (#182):** a real source file upload works and Supabase sets `storage.objects.owner_id`; a
  PDF's text is read on Vercel (`unpdf` ships via `outputFileTracingIncludes` in `apps/web/next.config.ts`, untested there).
- **Supabase token (blocking):** `SUPABASE_ACCESS_TOKEN` in the cloud environment returns `401 Unauthorized` from the
  Management API (6 Oct evening). Austin put a new token in the environment settings on 6 Oct evening; it takes effect in a new session.
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

**Overnight status** (update after every merge). Reserved migration versions follow the planned merge order; renumber
at merge time if the order changes.

| Ticket | Branch / PR | State | Migration (row) |
|---|---|---|---|
| B20 MCP proposes findings (#197) | #212 | **merged**, applied | `20261212000000` (59) |
| B2 People page (#31) | #211 | **merged** | none |
| B5 Client branding (#34) | #213 | **merged**, applied | `20261214000000` (60) |
| B21 Bigger restores (#203) | #216 | **merged**, applied (limits 3x, not 4x) | `20261215000000` (61) |
| C1 CSV import wizard (#40) | #218 | **merged**, applied | `20261216000000` (62) |
| C4 Storybook (#43) | #220 | **merged** (new `visual` CI job; `[visual-update]` approves baselines) | none |
| B7 Forecast planning (#36) | #217 | **merged**, applied; ENGINE 1.9.0 | `20261219000000` (63) |
| B3 Share links (#32) | #215 `claude/b3-share-links` | fourth review round: redaction redesigned (free-text keys, token matching); fixing uuid-vs-currency false positives, first-principles keys, client whole-name matching; PRD D47 | `20261220000000` (64) |
| B4 Play links (#33) | `claude/b4-play-links` (brief only) | build after B3 merges; renumber to follow B3 | `20261221000000` (65) |

B3 must stay security-reviewed until a verification round finds nothing blocking: it is the only public, unauthenticated surface. Each review comment and fix list is on its PR.

**Tooling:** `prod-sql.sh -f` now sends the file through `jq --rawfile` (#216); a 140 KB apply file overflowed `--arg`.
**Bug found (not ticketed):** deleting any workspace fails, even as superuser, on `steps_role_id_workspace_id_fkey` (found
while scoping B21).

Still for Austin (live checks and confirmations):
- Re-run Analyse in each workspace and check accepted AI findings (#205, Q11).
- B5: upload a logo on the real project (storage). B21: a preview restore at the limits (the 40 s function timeout is
  verified only on plain PostgREST).
- Defaults taken overnight are listed on each issue (#31, #34, #197, #203); confirm or change them.
- On the live site, an editor changes a client health rule and the owner's change log names them (#206).

### Overnight run (Austin, 6 Oct): finish everything that doesn't need him

Austin is asleep for this run. The aim is to finish Milestones B and C as far as they can go without him. The usual
two-or-three-tickets rule is relaxed for this run only: keep the main session's context small by delegating everything,
and update this handover (a docs-only PR, merged when green) **after every merged ticket**, so a restart loses nothing.

**Order** (dependencies from each issue's "Blocked by"; after the three PRs above have merged):

| # | Ticket | Notes |
|---|---|---|
| 1 | B2 People page (#31) | Unblocked once #30 closes. Check it against what B19 and B1 2b already built; the member view must stay own-row only |
| 2 | B3 View-only share links with redacted snapshots (#32) | Redaction must follow #30's rules: no pay, no names beyond labels |
| 3 | B4 Play links, proposals into Suggestions (#33) | Blocked by B3. A52's schema already supports `created_via='play_link'` |
| 4 | B20 Claude outside the app proposes findings (#197) | MCP; Austin's #175 decision: "MCP may propose findings" |
| 5 | B7 Forecast planning: drag markers, compare two plans (#36) | |
| 6 | B5 Client branding (#34) | |
| 7 | B21 Restore bigger workspaces (#203) | Raises the restore limits in "Follow-ups" |
| 8 | C1 CSV import wizard with column mapping (#40) | C2 (#41) is built; check what it already parses before building |
| 9 | C4 Storybook and visual regression (#43) | Last: least product risk |

Not tonight: C5 (#44, Austin's), C6 (#198, parked), the map node redesign (needs Austin), performance (parked).

**Per ticket** (as in "How we work"):
1. Comment on the issue that work has started, naming the branch.
2. An Opus agent writes `docs/plans/<ticket>-brief.md`. It covers exact files, the data model and migration spec, patterns
   to copy, edge cases, tests, what's out of scope, and done criteria. It quotes Austin's decisions verbatim and lists
   open questions, **each with a default**.
3. A Sonnet agent builds from the brief on its own branch, `claude/<ticket>-…`, and opens a draft PR. It commits and pushes
   after every step.
4. An Opus agent does an adversarial review; Sonnet fixes every finding, each with a test. Re-review if the fixes are
   large.
5. Get CI green, then apply the migration with preflight and post-apply checks (additive only), then merge.
6. Comment on the issue and on the milestone parent (#2 or #3), then update this handover.

Two independent tickets may be built in parallel in separate worktrees. Number migrations in merge order, and
regenerate `bootstrap.sql` after each merge of `main`.

**Rules while Austin is away:**
- **Open questions:** take the brief's default. Record each default on the issue and under "Design calls Claude made,
  for Austin to confirm". Never block waiting for an answer.
- **Stop and skip** (note it here and move on to the next ticket) for:
  - anything destructive in production: dropping or rewriting data, other than an additive clean-up a brief specifies
    and a review has passed;
  - anything needing a new secret or a paid service;
  - anything needing a design decision only Austin can make.
- **Never weaken a test to get green.** A test that is flaky by chance gets made robust in its own small PR.
- If the token, the auto-mode classifier or a permission prompt blocks a production step, stop the production steps,
  carry on building and reviewing the other tickets, and say so at the top of this handover.
- **End of run:** a summary comment on #2 and #3, and this handover rewritten for Austin's morning: what merged, what's
  open, decisions he needs to confirm, and anything skipped.

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
