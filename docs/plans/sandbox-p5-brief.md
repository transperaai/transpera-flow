# Sandbox phase 5: extras (build brief)

Opus brief, 29 Oct 2026. Source: `docs/plans/sandbox-design.md` "Other suggestions" 1–8 and build order phase 5 ("goal seek,
tornado chart, exports, the read-only share link, MCP `list_scenarios`/`run_scenario`"); `docs/plans/cut-list.md` items 5, 7 and 9
(MCP read-only, play links stay, three roles); the built phases 1–3 (`sandbox-p1-brief.md`, `sandbox-p2-brief.md`,
`sandbox-p3-brief.md`) and phase 4 (`sandbox-p4-brief.md` with its "Decisions", being built in `.claude/worktrees/p4`). Built on
`claude/supabase-migration-plan-mzchlf` **after phase 4 merges**; rebase on it, never hand-merge. Read `CLAUDE.md`,
`apps/web/AGENTS.md`, `docs/adr/0016-share-links.md`, `docs/adr/0021-one-scenario-model.md` and the four earlier briefs first.

**Phase 5 in one line:** the Sandbox's runner moves into `packages/db` so the web and MCP run identical code; MCP gains
`list_scenarios` and runs saved scenarios (timed changes included); each change carries a note; a scenario or a comparison exports
as CSV and prints to one A4 page; the Sandbox says when capacity runs out and when a hire pays for itself; goal seek and a "what
matters most" chart search and rank levers; a saved scenario can be shared read-only through the share-link machinery.

**It is two builds.** One build would touch the runner, MCP, a migration, exports, three new analyses and the share-link security
model at once, and the share link deserves its own review. Order and reason:

- **5a: the shared runner, MCP, notes, exports, timing, the silent-lever leftover.** The runner move is the riskiest refactor and
  everything else in phase 5 calls it (MCP runs it on the server, the share snapshot needs `effectiveChanges` in `packages/db`, goal
  seek and the tornado build on its prepare/run split). Landing it first, alone with small additive features, keeps the diff
  reviewable. Notes are a data change that exports (5a) and the share link (5b) both show.
- **5b: goal seek, the tornado chart, the scenario share link.** Two pool-heavy analyses on the 5a API, and the security work.

## Rules

- **Nothing simulated moves.** No engine change, no ENGINE bump, no golden change (§3). The runner move is `git mv` plus import
  changes; a parity test proves the moved code gives byte-identical results (§2.5).
- **Migrations run on real data** (the production copy imported at `20261231000000`, then every later migration). Phase 5's are
  `20270114000000_sandbox_change_notes.sql` (5a) and `20270115000000_scenario_share_links.sql` (5b), assuming phase 4 took
  `20270113000000`; if anything later is present at build time, take the next free timestamps. Both only widen checks: every
  existing row passes before and after.
- **Remove what is replaced.** Moved modules leave no copy behind; importers are updated (list in §2.3).
- **Generated files:** after each migration, `pnpm --filter @transpera-flow/db gen:types` (and `gen:seed` if `seed.sql` changes).
- **Done** = `pnpm lint && pnpm typecheck && pnpm test` green with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`
  (the known `format.test.ts` ICU failure ignored), perf recorded, per build.

---

## 0. What exists today (verified at `93f67f9a`, plus phase 4's stated outputs)

- **Runner** (`apps/web/src/lib/sandbox/`): `run.ts` (`applyPeopleChanges`, `withSolution`, `scenarioSegments`, `scenarioModel`,
  `prepareScenario` → `PreparedScenario {segments, pair, riseMonths, start, monthStarts, markersModel, planPeople, problems, later,
  error}`, `warmupOf`, `hireNames`, `monthWord`, `MAX_SEGMENTS` 7), `channels.ts` (`channelsOf`, `isChannelChange`,
  `overheadsCarried`), `edits.ts` (`applyBundleChanges`, `applyModelChanges`, `hasClientRoster`, `combine`, `withPriceDriver`),
  `effective.ts` (`effectiveChanges`, `effectiveLimitProblem`, `descendantsOf`), `price-rise.ts` (`priceRiseTradeoff`). The hook
  `use-scenario-run.ts` (`useScenarioRun`; private `joinRun`; the price-rise inputs `clientMonthsAfter`/`monthlyFee` are computed
  inline in its effect) runs segments and the B5 pair on `sharedSimPool()` (`lib/forecast/sim-pool.ts`: `REPS` 30, `SEED` 1,
  `POOL_SIZE` 3, `CACHE_LIMIT` 48, `runKey`, `SimPool.request(model, monthStarts, start)`, `runSegments`). Joined by
  `spliceMonthly`/`spliceSamples` (`lib/forecast/splice.ts`).
- **The runner's web-only imports:** `calendarMonthStarts` (`lib/forecast/timeline.ts`, which also imports `@/lib/viewer` for other
  functions), `addDays`, `addMonths`, `hoursToDate`, `monthBounds` (`lib/forecast/positions.ts`, which imports `dateAtHour` from
  `timeline.ts`), `horizonWeeks` (`lib/horizon.ts`), `retiredSteps` (`lib/scenarios/broken.ts`, pure, but the file imports
  `@/lib/viewer`), `bundleFromSolution` (`lib/solutions/bundle.ts`, imports a `DraftDiff` type only). Everything else it imports is
  `@transpera-flow/db` or `@transpera-flow/engine`. `packages/db` already depends on the engine; `packages/mcp` depends on db and
  engine and cannot import `apps/web`.
- **The page** (`app/w/[slug]/sandbox/page.tsx`) runs `loadLiveProcess(slug)` = `loadLiveProcessBySlug` → `loadProcessBySlug(db, slug,
  {draft: false}).live` (the first top-level live process, with `otherProcesses`), `loadWorkspaceSolutions(ws).solutions`,
  `loadWorkspaceSandboxScenarios(ws)`. `SandboxView` (`mode: "live" | "demo" | "readonly"`) starts runs on `today()`
  (`lib/forecast/forecast.ts`, UTC ISO date); `sandbox_scenarios.start_date` is never read by the page. "No changes" runs
  `forecastModel(live, months, start)` through `useSimulation` and seeds the pool, so a scenario's unchanged segment 0 is free.
  Alerts use `ANALYSIS_DEFAULTS`; the busy cut-offs are `[0.7, 0.85, 0.95]` (`packages/engine/src/ratings.ts`), "too busy" is
  `isTooBusy` and `firstCrossing` (`packages/engine/src/forecast.ts`).
- **Compare** (`components/sandbox/sandbox-compare.tsx`, `MAX_COMPARE` 3): four `useScenarioRun` calls; `compareSandbox`
  (`lib/sandbox/compare.ts`) makes rows and tiles. It shows no changes or notes. Phase 4 adds `time` rows and two tiles.
- **Changes** (`packages/db/src/sandbox-levers.ts`): `SandboxChange {id, lever, target, op, value, from?, params?}`; `changeProblem`
  (keys `KEYS` = id, lever, target, op, value, from, params), `paramsProblem`, `changesProblem` (200 changes, `MAX_CHANGES_CHARS`
  100,000), `parseChanges`, `offeredLevers`, `sandboxLever`. SQL twin `private.is_sandbox_change` (latest body
  `20270112000000_churn_chances_and_fee_ranges.sql`, PL/pgSQL, same key list). `targetName`, `whenOf`, `describeChange` word a change
  (`lib/sandbox/describe.ts`, which imports `@/lib/format` and `@/lib/viewer`).
- **Exports:** CSV text through `csvText`/`csvCell` (`lib/export/csv.ts`, CSV-injection safe, BOM, CRLF); downloads through
  `downloadBlob`/`exportFileName` (`lib/export/map-image.ts`); the Issues CSV (`lib/issues/csv.ts`) is the pattern.
  `app/w/[slug]/export/bundle` is the JSON backup. **There is no PDF capability today:** ADR 0010's Chromium pipeline
  (`puppeteer-core`, `@sparticuz/chromium`, `lib/report/*`) was removed in A32 (D22), no package in `apps/web/package.json` makes
  PDFs (`playwright-core` is a test dependency), and nothing in `apps/web/src` uses `@media print`, `print:` or `window.print`.
- **Share links** (ADR 0016; `packages/db/src/share.ts`): `ShareKind` = overview | process | issue | solution (`SHARE_KINDS`);
  `loadShareData` builds through `shareReaderDb`, `redactShareSnapshot` redacts (every bundle: `payHidden: true`, `cost_rate`
  null, people labelled unless People is on, clients "Client N", `personCapacityFactors` []; Financials off: role rates and margins
  0, `overhead_monthly`/`target_margin` dropped, rate patches `isRatePatch` dropped from `patch`/`lever_changes`, money in text
  hidden), `shareSnapshotLeaks` checks; default deny on strings outside `SHARE_NON_TEXT_REASONS`. Database: `share_links_kind` check
  (`20261220000000_share_links.sql`), `private.share_links_before_write` (latest body `20261221000000_play_links.sql`: per-kind target
  check, play links process-only), `private.share_snapshot_problem` (latest body `20270104000000_strip_followups.sql`; **phase 4
  re-creates it with `purpose` in `non_text_keys`**), `private.share_links_no_speeds` (`20261223000000`), `public.open_share_link`
  (returns `kind`, unchanged by kind). App: `share-actions.ts` (`createShareLink`, `refreshShareLink`, `buildSnapshot`),
  `lib/share/input.ts` (`parseShareInput`), `lib/share/list.ts` (`ShareLinkRow.kind` union, a name per kind),
  `components/share/share-dialog.tsx` (`ShareButton`), `components/share/shared-view.tsx` (`Screen` switch on `snapshot.kind`).
  Visitors simulate in their own browser from the snapshot.
- **MCP** (`packages/mcp/src`): `run_scenario` (`tools.ts`) takes `overrides` (patches), `horizon_weeks`, runs
  `loadProcessBundle` + `toEngineModel` + `simulate(model, reps, seed)` (not monthly) and returns `summarizeRun`.
  `compare_scenarios`/`check_robustness` (`analysis-tools.ts`) resolve names through `resolveScenarios`: `matchNamed`
  (`analysis.ts`) over **every** Sandbox scenario (`loadSandboxScenarios`), refusing non-whole-run ones with `sandbox_only`
  (phase 1 review). `TOOL_NAMES` lists tools; `test/read-only.test.ts` has an `argsFor` entry per tool. Route
  `apps/web/src/app/api/mcp/route.ts`, `maxDuration` 300.
- **Phase 4 outputs this phase reads** (assumed present): `MonthlyResult.time` (`TimeSplit` per role, person, team);
  `lib/sandbox/time.ts` `timeView(monthly, months, categories, scope)`; `workspacePurposes`, `PurposeCategory`, `resolvePurpose`,
  `loadDeleteCandidates`, `ProcessBundle.deleteCandidates?` (`packages/db/src/purposes.ts`, `first-principles.ts`);
  `ModelOptions.purposes` set in `scenarioModel`'s `toEngineModel(bundle, { startDate, planned: true, purposes: true })`;
  `compareSandbox` `time` rows and `totals.fixingHours`/`removableHours`; `spliceMonthly` treats `time` as flows; `steps.purpose` in
  `SHARE_NON_TEXT_REASONS` and `non_text_keys`. Decisions: post-sale pipeline steps default to "Moves the client's job forward";
  ongoing client hours are their own fixed row "Client upkeep"; a Viewer sees their own row and "Everyone else".
- **Segment cost:** a Sandbox segment of seeded Northbeam at 12 months is about 0.7 s against its 1 s budget (phase 3 §0,
  `apps/web/test/sandbox-performance.test.ts`).

## 1. Design suggestions 7 and 8: what is left

- **7, make the finance real:** done in phase 2 (C2 overheads, C3 hourly billing, labour, overtime cost, profit) and phase 3 (timed
  role cost and overheads). Left by decision, not in phase 5: `target_margin` unread (p2 Q5), no overtime premium (p2 Q4),
  `services.margin` unused (p2 §1.6), the market's `pay` (late payments) unwired.
- **8, fix the silent levers:** done in the Sandbox (phase 3: B1/B3 act on rosters; `applies`/`changeApplies` and
  `lib/sandbox/greyed.ts` grey and explain). **Left:** the process page's lever panel, and so play links, still offer "Active
  clients" (`demand.active_clients`) and "Monthly churn" (`demand.churn_monthly`) from `buildLevers` (`lib/scenarios/levers.ts`) on a
  workspace with client groups or a named roster, where the engine ignores both. **5a fixes it:** `buildLevers` leaves the two out
  when `hasClientRoster(model)` (moved to `packages/db/src/sandbox/edits.ts`, §2.3), and `lever-panel.tsx` shows one line under
  Clients: "Clients and churn are set per client type here: change them in the Sandbox or Settings, Clients." Play links follow
  (same `buildLevers`); `private.play_patch_problem` is gone (20270102000000), so no SQL changes. Test in `scenarios.test.ts` (web):
  Northbeam groups → no such levers; a pooled model → both.

---

# Phase 5a

## 2. The runner moves to `packages/db` (`@transpera-flow/db/sandbox`)

### 2.1 Where, and why not a new package

`packages/db/src/sandbox/`, exported as the subpath `"./sandbox": "./src/sandbox/index.ts"` in `packages/db/package.json` (as
`./process-import` is). Not re-exported from `src/index.ts`, so the main entry stays light and nothing imports the runner by
accident. Reasons for `packages/db` over a new package: phase 1 Q13 already chose it; the registry (`sandbox-levers.ts`), the model
builder (`model.ts`) and `ProcessBundle` live there; a new package needs workspace, tsconfig, eslint, vitest and
`transpilePackages` plumbing for no gain (`apps/web/next.config.ts` already transpiles `@transpera-flow/db`). Inside the folder,
import siblings by relative path (`../model`, `../sandbox-levers`, `../types`), never `@transpera-flow/db`, so there is no cycle.

### 2.2 What it exposes

```ts
// packages/db/src/sandbox/index.ts
export * from "./run";          // applyPeopleChanges, withSolution, scenarioSegments, scenarioModel, prepareScenario, warmupOf, hireNames, monthWord, fromDate, leaveEnd, MAX_SEGMENTS, ChangeProblem, PreparedScenario, PreparedSegment
export * from "./channels";     // channelsOf, isChannelChange, overheadsCarried
export * from "./edits";        // applyBundleChanges, applyModelChanges, hasClientRoster, combine, withPriceDriver, …
export * from "./effective";    // effectiveChanges, effectiveLimitProblem, descendantsOf, EffectiveChange
export * from "./price-rise";   // priceRiseTradeoff, PriceRiseTradeoff
export * from "./splice";       // spliceMonthly, spliceSamples
export * from "./months";       // calendarMonthStarts, dateAtHour, horizonWeeks, addDays, addMonths, hoursToDate, monthBounds, … (positions)
export * from "./solution";     // bundleFromSolution
export * from "./execute";      // SANDBOX_REPS, SANDBOX_SEED, joinRun, priceRiseOf, simulateScenario, ScenarioRun
```

**New in `execute.ts`** (pure except `simulateScenario`, which calls the engine synchronously):

```ts
export const SANDBOX_REPS = 30;   // sim-pool.ts REPS and SEED become re-exports of these, so the browser and the server can't drift
export const SANDBOX_SEED = 1;
export interface ScenarioRun { model: EngineModel; result: SimulationResult; markersModel: EngineModel; planPeople: Set<string>; spliced: boolean }
/** The hook's private joinRun, moved verbatim: months spliced, the first segment's other figures. */
export function joinRun(prepared: PreparedScenario, segments: PreparedSegment[], results: SimulationResult[]): ScenarioRun;
/** The price-rise trade-off from a run and its pair: the inline block of useScenarioRun's effect (clientMonthsAfter, monthlyFee), moved verbatim. */
export function priceRiseOf(prepared: PreparedScenario, run: ScenarioRun, pair: ScenarioRun): PriceRiseTradeoff | null;
/** Every segment (and the pair) through simulate(model, SANDBOX_REPS, SANDBOX_SEED, { monthly: true, monthStarts, initialState: start }),
 *  exactly the options workers/simulate.worker.ts passes. For MCP and tests. */
export function simulateScenario(prepared: PreparedScenario, o?: { pair?: boolean }): { run: ScenarioRun; priceRise: PriceRiseTradeoff | null };
```

`prepareScenario` gains an optional last argument `{ pair?: boolean }` (default true): false skips building the B5 pair (goal seek,
the tornado and timing don't need it, §7–8). `useScenarioRun` keeps its shape and calls `joinRun` and `priceRiseOf` from the
package.

### 2.3 File plan (all `git mv` unless marked)

| From (`apps/web/src/lib/…`) | To (`packages/db/src/sandbox/…`) | Notes |
|---|---|---|
| `sandbox/run.ts` | `run.ts` | imports become relative; `retiredSteps` from `../retired`, `bundleFromSolution` from `./solution`, `horizonWeeks`/`calendarMonthStarts`/positions from `./months` |
| `sandbox/channels.ts`, `sandbox/edits.ts`, `sandbox/effective.ts`, `sandbox/price-rise.ts` | same names | relative imports only |
| `forecast/splice.ts` | `splice.ts` | unchanged |
| `forecast/positions.ts` | `months.ts` (with the next two rows) | `dateAtHour` import becomes local |
| `forecast/timeline.ts`: `calendarMonthStarts`, `MIN_PART_DAYS`, `dateAtHour` (cut, not the file) | `months.ts` | `timeline.ts` imports them back from `@transpera-flow/db/sandbox` |
| `horizon.ts`: `horizonWeeks` (cut) | `months.ts` | `horizon.ts` re-exports it (`export { horizonWeeks } from "@transpera-flow/db/sandbox"`): its other importers stay as they are, one source |
| `scenarios/broken.ts`: `retiredSteps` (cut) | `packages/db/src/retired.ts` (beside `partitionSteps`, exported from `index.ts`) | `broken.ts` imports it |
| `solutions/bundle.ts`: `bundleFromSolution` (cut) | `solution.ts` | `bundle.ts` keeps `solutionCopy`, `changedStepIds`, `solutionProblem` |
| (new) | `execute.ts`, `index.ts` | §2.2 |

**Stay in `apps/web`:** `use-scenario-run.ts` (React, workers), `sim-pool.ts`, `compare.ts` (uses `timelineMonths`), `describe.ts`,
`traffic.ts`, `today.ts`, `lane.ts`, `validate.ts`, `greyed.ts`, `explain.ts`, `demo.ts`, `time.ts` (phase 4), every component.
**Importers to update** (a grep for each moved name; at `93f67f9a` the files importing these modules are): `components/sandbox/*`
(change-dialog, change-list, compare-chart, price-rise, sandbox-compare, sandbox-view), `components/forecast/{forecast-money,
forecast-panel,forecast-timeline}.tsx`, `components/{overview/overview,editor/editor-view,people-page,process-page,process-view,
issues-page,horizon-picker,solutions/solution-compare}.tsx`, `lib/editor/modes.ts`, `lib/forecast/{demo,forecast}.ts`,
`lib/overview/impact.ts`, `lib/scenarios/scenarios.ts`, `lib/sandbox/{compare,describe,lane,validate,use-scenario-run}.ts`, and the
tests `sandbox-{run,channels,edits,months-before,pay,performance,polish,compare}.test.ts`, `price-rise{,-demo}.test.ts`,
`broken-scenarios`, `editor-modes`, `forecast`, `horizon-performance`, `lever-catalogue`, `overview-b15`, `overview-performance`,
`solution-levers`, `solutions{,-compare,-db,-page,-save}.test.ts`, the overview, overview-page and share harnesses. Tests stay in
`apps/web/test` (they use web demo bundles) with new import paths; nothing is deleted. Phase 4's changes inside these files
(`purposes: true`, `time` in `spliceMonthly`) move with them.

### 2.4 MCP and web use one bundle loader

A saved scenario on MCP runs on exactly the page's inputs: `loadProcessBySlug(ctx.db, ws.slug, { draft: false })` → `.live`
(not `resolveProcess` + `loadProcessBundle`), `loadSolutions(ctx.db, ws.id)` and `loadSandboxScenarios(ctx.db, ws.id)`, as the token's
user (RLS, `team_capacity`; a Viewer token gets `viewer` and so `payHidden`, as the page does). Phase 4's `deleteCandidates` are added
to the bundle the same way the Sandbox page adds them (phase 4 §1.3), so the time split matches.

### 2.5 Parity test

`packages/db/test/sandbox-execute.test.ts`: for seeded Northbeam and three saved scenarios (whole-run patches; a D1 hire + B5 +8% from
a month; an E6 from a month, so two segments and a pair), `simulateScenario(prepareScenario(…))` deep-equals the result of running each
`PreparedSegment` the way the worker does (`simulate(model, 30, 1, {monthly, monthStarts, initialState})`) and joining with
`joinRun`/`priceRiseOf`; and `prepareScenario(bundle, [], …)`'s single segment and start equal `forecastModel`'s model and its own
`initialState` (so MCP's "No changes" is the page's). Plus the existing web suites green on new paths.

## 3. Engine

**No change.** Goal seek, the tornado and timing are sets of ordinary runs; the payback month uses monthly means (per-replication
monthly profit would need `monthlySamples.profit`, an engine change: not in phase 5, open question 9). ENGINE stays at phase 4's
version; goldens untouched; `browser-determinism.test.ts` unchanged.

## 4. MCP: `list_scenarios` and `run_scenario` for saved scenarios

### 4.1 `list_scenarios` (new, `analysis-tools.ts`, in `ANALYSIS_TOOL_NAMES`, `readOnlyHint: true`)

Input: `workspace`. Output, by name: `{ workspace, scenarios: [{ id, name, description, parent: {id, name} | null, horizon_months,
updated_at, runs_in: "sandbox" | "anywhere" /* "anywhere": a standalone whole-run patch scenario that compare_scenarios and
check_robustness take (loadScenarios) */, changes: [{ id, lever, lever_label, target, target_name, op, value, from, params, note,
inherited_from: {id, name} | null }] /* effective changes, parents first (effectiveChanges) */, problem: string | null /* a broken
chain or limit (effectiveChanges / effectiveLimitProblem) */ }], text }`. `target_name` from the token user's bundle (labels for a
Viewer: `team_capacity` names), "gone" when missing; no run. Description: "Saved Sandbox scenarios: each one's changes (lever, target,
value, from which month, and the note saying why), what it builds on, and whether compare_scenarios can take it. Read-only; run one
with run_scenario."

### 4.2 `run_scenario` gains a saved-scenario mode (`tools.ts`)

New args: `scenario` (id or name, `matchNamed` over `loadSandboxScenarios`, or `"No changes"`), `months` (1–24, default the scenario's
`horizon_months`, else 12), `include_baseline` (default true), `include_people` (default false). With `scenario`, `process`,
`revision`, `overrides` and `horizon_weeks` are refused (`invalid_args`: "With a saved scenario, the run is the Sandbox's: the live
company model, month by month."). `start_date` keeps its meaning (default today, as the page). Without `scenario` the tool is exactly
today's (whole-run, `overrides`).

Run: §2.4 inputs → `effectiveChanges` → `prepareScenario(bundle, changes, solutions, months, startDate)` → `simulateScenario`. With
`include_baseline`, also `prepareScenario(bundle, [], …)` (one run). An `error` → `ToolError("scenario_error", error)`.

Output: `{ workspace, scenario: {id, name, parent}, start_date, months, engine_version, reps: 30, seed: 1, segments, spliced,
changes (as 4.1), problems: [{change_id, message, note}], later: [change ids], month_starts: ["2026-11-02", …] /* dateAtHour */,
series: { revenue, mrr, opportunities, won, lost, conversion, clients_won, clients_lost, at_risk /* summed over groups */,
late_tasks, overtime_hours, profit /* null when pay is hidden */, labour /* labour + overtime cost, null likewise */ } /* each
[{mean, p10, p90}] per month */, roles: {<id>: {name, busy: [{mean,p10,p90}|null], uncovered: [hours|null]}}, people /* only with
include_people: as named for the token user */, time: { categories: [{key, name}], team: …, roles: … } /* phase 4: hours per category
(Client upkeep, Fixing, Idle, Uncovered as phase 4's rows), per month, means */, totals: { revenue, profit, clients_lost,
too_busy_months } /* Σ monthly means; too busy by isTooBusy at the default cut-offs */, price_rise /* PriceRiseTradeoff | null */,
baseline: { series, roles, totals } | null, diff: { totals } | null, duration_ms }`. `assumptions` lists defaults and "Months before
a timed change are the No changes run exactly (pinned warm-up)." `kpi` is not returned in this mode (whole-run figures of a spliced
run are the first segment's; the months are the truth).

`scenarioRefs`' description and the `sandbox_only` message in `resolveScenarios` add: "run_scenario with `scenario` runs it month by
month." Nothing writes; `set_active_workspace` stays the only non-read tool.

**Cost on the server:** segments + pair + baseline, synchronously, in the route's function: a typical scenario is 2 runs (about 1.5 s
at 12 months), the worst (7 segments, a B5 pair of 7, baseline) 15 runs (about 11 s at 12 months, 22 s at 24), inside `maxDuration`
300. No time cap needed; `duration_ms` reported.

## 5. Assumptions log: a note per change

### 5.1 Data (`20270114000000_sandbox_change_notes.sql`)

A change gains an optional `note` (the design: "a short note per change"), stored **in the change** (`sandbox_scenarios.changes`), not
a new column: it travels with the change through duplicate, build-on (inherited changes show their parent's note), restore
(`changes` is restored whole; `sandbox-import.ts` keeps it), the demo store and the share snapshot, with no new join. The scenario's
`description` stays the scenario-level note.

```sql
select set_config('transpera.actor_kind', 'system', true);
-- private.is_sandbox_change: the 20270112000000 body verbatim, with 'note' added to the allowed keys and one more AND:
--   and case when not (c ? 'note') then true
--            when pg_catalog.jsonb_typeof(c -> 'note') <> 'string' then false
--            else pg_catalog.char_length(c ->> 'note') between 1 and 280 and (c ->> 'note') = pg_catalog.btrim(c ->> 'note') end
create or replace function private.is_sandbox_change(c jsonb) returns boolean /* … */;
```

Header as `20270112000000`: preflight `select count(*) from public.sandbox_scenarios where not private.is_sandbox_changes(changes)` =
0 before and after, post-apply the same plus a probe insert with a note in a rolled-back transaction; rollback re-runs the
`20270112000000` body. Real-data safe: it only widens (no stored change has `note`). 280 characters keeps a full scenario (200 changes,
each noted) inside the 100,000-character list limit for ordinary text; a list that exceeds it gets the existing "That scenario is too
big." Grants, `is_sandbox_changes`, the restore's `allow` and `share_snapshot_problem` need nothing.

**TS twins:** `SandboxChange.note?: string`; `KEYS` gains `"note"`; `changeProblem` refuses a non-string, empty, untrimmed or over
`MAX_CHANGE_NOTE` (280, exported) note ("A note can have up to 280 characters."); `sandbox-scenarios.test.ts`'s shared SQL/TS case table
gains them. `updateScenarioPatch` (`app/w/[slug]/scenario-actions.ts`) carries each old change's `id` and `note` over to the new change
with the same patch path (`patchOf(c).path`, first match in order), so a process-page edit doesn't drop notes.

### 5.2 UI

- **Change dialog** (`change-dialog.tsx`): "Why (optional)", a textarea, 280 characters with a counter, help "What this change assumes,
  in a sentence. It's shown with the change, in compare, in exports and on share links." Example "Assumes the Q3 campaign doubles
  leads." Trimmed on save.
- **Change list** (`change-list.tsx`): the note in muted text under each change; inherited changes show their parent's, read-only.
- **Compare** (`sandbox-compare.tsx`): a section "Changes and notes" after the tiles: per column, its effective changes worded
  (`describeChange` + `whenOf`) with their notes; "No changes" says "The live model as it is."
- **Demo:** one demo change gets a note (`lib/sandbox/demo.ts`).
- Viewers read notes, never edit them (as changes).

## 6. Exports: CSV and a one-page print

### 6.1 Recommendation: print CSS and the browser's "Save as PDF", no server rendering

ADR 0010's server PDF cost about 75 MB of Chromium per function, a 1–2 s cold start, stored PDFs and a signed-URL route, and was removed
(D22). A one-page summary of numbers already on screen needs none of that: the browser prints exactly what it shows, charts stay vector
SVG, and nothing new runs on the server. Cost: the user clicks "Save as PDF" in the print dialog; output differs slightly between
browsers. MCP gets data (§4), not a PDF; Claude or ChatGPT can make their own document from it.

### 6.2 What is exported

Both from the runs already on screen (no extra run): a single scenario exports as two columns, "No changes" and the scenario (so the
difference is in the file); a comparison exports its columns.

- **Numbers CSV** (`lib/sandbox/export.ts`, new, pure: `sandboxCsv(columns: { name; monthly: MonthlyResult; priceRise }[], months:
  TimelineMonth[], model, o: { currency; costs: boolean; categories: PurposeCategory[] })`, through `csvText`). Tidy rows, one per
  scenario × measure × group × month: `Scenario, Measure, Group, Month, Average, Low (10%), High (90%), Unit`, then a "Whole run" row
  per series where a total is meaningful (Σ means; no range, as the tiles). Measures: opportunities, wins, losses, conversion; billed
  revenue (total, recurring, one-off, hourly, from new clients, lost to churn, from rises); MRR; clients by type; clients won and lost;
  clients at risk by group; busy share by role (and uncovered hours); late tasks; overtime hours; **costs only when `costs`**: labour
  with overtime, overheads, profit; price-rise gained, lost, net, extra leavers; phase 4's time split for the team and per role (hours
  and % per category, Idle, Uncovered), via `timeView`. **Never** per-person rows, labour by role or labour by person, even for admins
  (an export is for sending; a one-person role's labour is that person's pay).
- **Changes CSV** (`changesCsv`): `Scenario, Change, When, Note, From scenario` per effective change (worded by `describeChange`).
- **Print summary** (`components/sandbox/print-summary.tsx`, new): one A4 portrait page. Header (workspace, scenario or "Comparison",
  printed date, start month, horizon, "30 runs, seed 1, engine <version>"); up to 6 tiles (profit over the run when costs are shown,
  billed revenue, MRR in the last month, clients at risk, months too busy, the timing line of §6.4); one chart (profit per month if
  shown, else MRR) with each column's 10–90% band (`compare-chart.tsx`); the changes with notes (at most 10, then "and N more: see the
  changes CSV"); a footnote explaining averages and ranges. Rendered hidden on screen and shown in print.
- **Print CSS** (`app/globals.css`): `@media print { @page { size: A4 portrait; margin: 12mm } body * { visibility: hidden }
  [data-print-root], [data-print-root] * { visibility: visible } [data-print-root] { position: absolute; inset: 0 } }`, so the shell,
  sidebar and controls need no per-component print classes. The summary uses fixed print sizes (`print:` variants of Tailwind 4).
- **Where:** an Export menu (`components/sandbox/export-menu.tsx`, modelled on `components/export/export-menu.tsx`) in the page
  header's actions beside the horizon picker, and in compare: "Numbers (CSV)", "Changes and notes (CSV)", "Print or save as PDF"
  (`window.print()`). Admins get a checkbox "Include costs and profit" (default on); Viewers' runs have no costs (`money` null), so the
  rows are absent. File names through `exportFileName("<workspace> <scenario>", "csv", date)`. Disabled while a run is running, with
  the reason. Phone: CSV only.

### 6.3 Viewers and pay (B1)

Everything exported is what the reader sees on screen. Viewers: no cost rows (the engine returns none), team and role time only.
Admins: totals only (labour with overtime, overheads, profit), never per person or per role.

### 6.4 Break-even and timing (design suggestion 3)

`lib/sandbox/timing.ts` (new, pure) and a section **"When"** (`components/sandbox/timing.tsx`) after "Month by month":

- **Capacity runs out** (no extra run): for the run on screen, the earliest `firstCrossing(roles[id], cutoffs).average` over roles (and
  the first month with uncovered work), as one line: "Capacity runs out in March 2027: Designers are 88% busy on average." Else "Not
  within these 12 months" with a link to 24 months when shorter. "At current growth" is the run itself: it already carries demand
  growth, seasonality and the market schedule. The alerts list stays; this is their headline.
- **A hire pays for itself** (admins and the Owner; needs profit): for each D1 hire and D5 increase in the scenario (at most 4, by
  the button "Work out when each hire pays for itself"), a second `useScenarioRun` with that change removed (often free: with the hire
  as the only change it is the live run). `paybackMonth(withHire, withoutHire, fromMonth)`: Δ = profit mean with − without per month
  from the hire's month, cumulative; the first month after which it stays ≥ 0. "The PPC hire in January pays for itself by August 2027
  (+£4,100 by the horizon)", or "Not within these 12 months: −£9,800 by September 2027." Means only, labelled ("on average"); no range
  (open question 9). Viewers see "Shown to Agency admins and the Owner."
- Help in `SANDBOX_HELP` (`lib/forecast/help.ts`), plain words, with those examples.

## 7. Tests (5a)

- **DB:** `sandbox-execute.test.ts` (§2.5); `sandbox-scenarios.test.ts` (note cases through SQL and TS; every stored row still passes);
  new `sandbox-notes-migration.test.ts` (`createTestDb({ upTo: "20270113000000" })`, real-shaped rows incl. a library row and a
  build-on chain, migrate, every row passes, a note is accepted, 281 characters, `""`, `" x"` and a number refused through a direct
  update; a restore round-trips a note); `sandbox-import.test.ts` (a note survives the plan).
- **MCP:** new `list-scenarios.test.ts` and `run-saved-scenario.test.ts` (seeded Northbeam: by name and id; ambiguous and unknown
  names; a timed scenario's months before its change equal the baseline's exactly; a B5 scenario returns `price_rise`; a Viewer token
  gets `profit` null and labelled people; mixing `scenario` with `overrides` refused; numbers equal `simulateScenario` on the same
  inputs); `read-only.test.ts` gains `list_scenarios` in `argsFor` (and still finds no write); `end-to-end.test.ts` lists the tool.
- **Web:** `sandbox-export.test.ts` (`sandboxCsv` rows, units, costs on/off, no per-person or per-role labour, a Viewer's run has no
  cost rows, CSV injection in a scenario name and a note); `sandbox-timing.test.ts` (`paybackMonth` never/at once/after a dip,
  capacity crossing from `firstCrossing`); `actions-database.test.ts` (save with notes; `updateScenarioPatch` keeps notes);
  `scenarios.test.ts` (§1 silent levers); `stories-coverage.test.ts` (stories for `print-summary`, `export-menu`, `timing`).
- **Browser** (`sandbox-browser.test.ts`, 1440/640/400 px, no console errors): add a note, see it in the list and in compare; download
  both CSVs; `page.emulateMedia({ media: "print" })` → the summary is the only visible element and its height fits one A4 page (≤ 1047
  CSS px at 96 dpi); a Viewer exports without cost rows; "When" shows the capacity line and, as admin, a payback.

## 8. Docs (5a)

PRD §7.1 (`list_scenarios`; `run_scenario`'s saved mode), §9 (dated note: scenario CSV and print-to-PDF; ADR 0010's server PDF stays
removed), §13 (payback month, capacity runs out); `docs/production-migrations.md` row; ADR 0021 dated note (notes in changes; runner in
`@transpera-flow/db/sandbox`); `CONTEXT.md` "Note (of a change)".

---

# Phase 5b

## 9. Goal seek (design suggestion 1)

**What:** pick one target and one lever with a range; the Sandbox searches the range on top of the scenario on screen (its effective
changes, or none) and answers the boundary: "At least 3 more Designers keep every role under 85% busy every month", "Up to +12% keeps
monthly churn under 3%".

**Targets first** (`lib/sandbox/measures.ts`, new, pure; shared with §10): 
1. **Busy:** every role (or one role) at most X% busy in every month (default 85%, `cutoffs[1]`), on the average or "in 9 of 10 runs"
   (`MonthBusy.p90`).
2. **Churn:** monthly churn over the run at most X%: Σ `clientsLost` means ÷ Σ client-months (`clients` means). Average only (a ratio of
   means has no range).
3. **Profit:** over the run at least £Y (Σ `money.profit` means), or in month N at least £Y (`money.profit[N]`, mean or p10). Admins and
   the Owner only (`money` null for Viewers: not offered).

Later (not 5b): clients at risk, a phase 4 purpose share ("Fixing under 10% of hours").

**Levers first** (whole run, or from a month the user picks): D5 headcount by role (`add`, whole people 0 to +10), D6 hours available
(× 0.8–1.3), E1 step time (× 0.3–1.5, a step or `@heaviest`), A1 opportunities (× 0.5–3), B5 price rise (−20% to +50%, step 1 point),
B2 fees (× 0.5–2, `who` as chosen). Ranges default to these, narrowable, within the registry range.

**Search** (`lib/sandbox/goal-seek.ts`, new, pure state machine: `startSearch(spec)`, `nextProbes(state)`, `addResult(state, x,
value)`, `answer(state)`):
1. Probe both ends at once (2 runs). Both meet the target: "Already met across the range; the least change is <end nearest today's
   value>." Neither: "Not reachable in this range; closest was <value> at <x>." Otherwise the target flips inside: bisect.
2. Bisection, one probe at a time: whole-number levers until the ends are 1 apart (D5 over 0–10: at most 4 more); others until the
   width is the lever's UI step or 6 more probes. **At most 8 runs per search.** The answer is the boundary on the side that meets the
   target, rounded to the step.
3. **Monotonicity check:** probes sorted by x must move one way, from f(lo) to f(hi), within a tolerance of 1% of |f(hi) − f(lo)|
   (0.5 percentage point for shares). Same seed and pinned warm-up for every probe keep the noise low but not zero. When it fails the
   answer still shows, flagged: "<Measure> doesn't move steadily with <lever> across this range (it rose between 2 and 3 more people),
   so a smaller value may also work. Narrow the range or look at the points below." Every probe is listed (x, value, meets or not).

**Runs:** each probe is `prepareScenario(bundle, [...effective, probeChange], solutions, months, start, { pair: false })` (B5 then
measures churn with the forced price driver, as the scenario would), run with `runSegments` on `sharedSimPool()`. **Pool cost:** at
most 8 runs × the scenario's segments; segments before a timed probe's month are cached (same model, same key), so a probe from a month
usually costs one new run. Two runs at once at the start, then one at a time: two of the page's three workers stay free. Wall time at
12 months about 5–6 s (≈ 0.7 s × 7 rounds), at 24 months about double. Before it starts the dialog says "about N runs".
`SimPool.request` gains an optional `{ cache: false }` so probes don't push the page's runs out of the 48-run cache (they still share
runs in flight).

**UI:** "Find a value" in the scenario bar's menu opens `components/sandbox/goal-seek-dialog.tsx`: target (kind, scope, comparator
fixed by kind, threshold, average/9-in-10), lever (lever, target, whole run or from month, range), Start. Progress "Run 3 of at most 8"
with a Cancel that releases every request (`runSegments(...).cancel`); closing the dialog or changing the scenario cancels. Result: the
sentence, the probe table, and **"Add as a change"** (admins and the Owner): an ordinary change into the working draft, note pre-filled
"Goal seek: <target sentence> (<date>)". Viewers see the result only (open question 1).

## 10. What matters most: the tornado chart (design suggestion 2)

**What:** around the scenario on screen, each lever moved down and up once, ranked by its effect on one chosen measure.

**Measures** (`measures.ts`): profit over the run (admins), clients at risk in the last month, peak busy (highest monthly average of any
role), months too busy (`isTooBusy`), clients lost over the run, and phase 4's share of hours on one purpose category over the run
(`timeView(…, { kind: "team" }).rows[key].runShare`).

**Levers and steps** (`lib/sandbox/tornado.ts`, new, pure: `tornadoVariants(model, bundle, hiddenKinds, measure)` →
`{ leverId, label, low: SandboxChange, high: SandboxChange, lowLabel, highLabel }[]`; `rankTornado(base, results)`): only levers in
`offeredLevers(hiddenKinds)` whose `applies` is null, one representative target each:

| Lever | Target | Low / high |
|---|---|---|
| A1 opportunities, A3 conversion, B3 base churn, D6 hours available | none | × 0.9 / × 1.1 |
| B5 price (with its churn) | none | −10% / +10% (against the scenario with the price driver on: one extra run, as the trade-off pairs) |
| B2 fees, new clients | none | × 0.9 / × 1.1 |
| E1 step time, E2 waiting, E3 rework | `@heaviest` | × 0.9 / × 1.1 (E3 skipped when that step has no rework) |
| D5 headcount | `@busiest` | −1 / +1 person (counts move by one, not 10%) |
| C1 role cost (`@busiest`), C2 overheads | | × 0.9 / × 1.1, **profit only** (they move nothing else) |

Left out: B1 (a starting stock; named rosters can't shrink it), A5, A6, B4, D1–D4, D9, E6, X1–X3 (ranges, people, structural changes:
no "±10%"). 8–12 levers in practice.

**Cost and speed, honestly:** 2 runs per lever, 16–24 runs (plus one for B5), on all three workers: about 6 s at 12 months and 12 s at
24 for seeded Northbeam; the scenario itself is cached. It runs only when asked ("Work out what matters most"), shows bars as they
arrive, and cancels like goal seek. **It keeps 30 runs each.** Fewer (10) would be about three times faster, but each bar would then be
a different number from what the same change shows once saved, and small effects would be noise; recommended no "quick" mode (open
question 3). Every bar uses the same seed and warm-up, so differences are paired, not independent; effects under 1% of the scenario's
value are greyed "about no change" (the help says why). `{ cache: false }` as goal seek.

**Shown** (`components/sandbox/tornado.tsx`): horizontal bars from the scenario's value, low side and high side in two colours, sorted by
the larger |effect|, the top 10, each labelled with its step ("−1 person / +1 person", "−10% / +10%") and the measure's unit; a table
with the same numbers (screen readers, phone); a "Use this" link per bar opening the change dialog pre-filled (admins). Plain SVG as
`compare-chart.tsx` draws. Help: "Each lever moved a little each way, one at a time, on top of this scenario. The longest bars are where
a change moves <measure> most."

## 11. A read-only share link to a scenario (design suggestion 6)

### 11.1 Snapshot

`ShareKind` and `SHARE_KINDS` gain `"scenario"`; `target_id` is the `sandbox_scenarios.id`. View mode only (play stays
process-only).

```ts
export interface ScenarioShare extends ShareSnapshotBase {
  kind: "scenario";
  scenarioId: string;
  /** The Sandbox's bundle: loadProcessBySlug(rdb, slug, { draft: false }).live, with phase 4's deleteCandidates. */
  bundle: ProcessBundle;
  /** The scenario and the chain it builds on, root first: only id, name, description, parent_id, changes, horizon_months. */
  scenarios: Pick<SandboxScenarioRow, "id" | "name" | "description" | "parent_id" | "changes" | "horizon_months">[];
  /** Only the solutions its E6 changes name. */
  solutions: SolutionRow[];
  /** Frozen with the copy: the run starts here, so the visitor sees the numbers the copy was made with (today's engine aside). */
  startDate: string;
  months: number;
}
```

`loadShareData`'s new branch: `loadSandboxScenarios(rdb, ws)` → the target (else `ShareBuildError("That scenario isn't here any
more.")`) → `effectiveChanges` (an error → `ShareBuildError` with it) → the bundle (unpublished → "Publish a process first.") →
solutions by E6 target → `startDate = today()`, `months = horizon_months`. Then the usual `redactShareSnapshot` plus three rules in it
(scenario changes only):
- **People off:** a D1 change loses `params.name` (it may be a candidate's name; the visitor sees "New <role>", `hireNames`'s default).
- **Financials off:** C1 and C2 changes are dropped (a role rate or an overhead amount), as `isRatePatch` drops rate patches; the visitor
  reads "1 change about costs is hidden on this link." (count kept in the snapshot as `hiddenCostChanges: number`).
- Notes, names and descriptions are free text: scrubbed as every string is.

**Update copy** rebuilds from today's live model and today's scenario (edits included) with a new `startDate`. A deleted scenario keeps
its last copy (ADR 0016).

### 11.2 Leak check rules (both twins: `shareSnapshotLeaks` and `private.share_snapshot_problem`)

New non-text keys, each **checked by format at every depth** (like `hiddenLevers`), so a free-text value can't hide under one:

| Key | Format (refused otherwise) |
|---|---|
| `lever` | `^[A-EX][0-9]$` |
| `target` (string values) | a uuid, `@busiest`, `@heaviest`, a health rule (`initial`, `recover`, `late_penalty`, `missed_penalty`), a built-in driver id (`BUILTIN_CHURN_DRIVER_IDS`: late, resp, onb, rework, load, handoff, results, tenure, price, market) or `custom:<uuid>` |
| `from` | `^(20[0-9]{2}\|2100)-(0[1-9]\|1[0-2])(-[0-9]{2})?$` |
| `parent_id`, `scenarioId` | a uuid |
| `startDate` | `^\d{4}-\d{2}-\d{2}$` |

Kind `scenario` also needs: `scenarios` an array of 1–6 objects whose `changes` pass `private.is_sandbox_changes` (so `op`, `value`,
`params` shapes are the database's); with People off no D1 change has `params.name`; with Financials off no change has lever C1 or C2;
`hiddenCostChanges` a whole number ≥ 0 (non-text, numeric). `who` (B2's `new`/`all`) stays free text, because `who` is free text in
first principles (`FP_JOB_WHY_TEXT`): if a person's name token were "new" or "all", the scrub would break the change and the link is
refused (fails closed; accepted, ADR note). `share-field-classes.test.ts` gets a typed map of `ScenarioShare` and the change shape; if
any new key is text in another shape, it fails, and the snapshot key is renamed instead.

### 11.3 Migration `20270115000000_scenario_share_links.sql`

```sql
select set_config('transpera.actor_kind', 'system', true);
-- 1. A scenario can be shared. Widening: every row passes.
alter table public.share_links drop constraint share_links_kind;
alter table public.share_links add constraint share_links_kind check (kind in ('overview', 'process', 'issue', 'solution', 'scenario'));
-- 2. private.share_links_before_write: the 20261221000000 body verbatim, with one more arm in the target check:
--      when 'scenario' then exists (select 1 from public.sandbox_scenarios s where s.id = new.target_id and s.workspace_id = new.workspace_id)
-- 3. private.share_snapshot_problem: the LATEST body (phase 4's, which added 'purpose') verbatim, plus the six keys of §11.2 in
--    non_text_keys, their format checks at every depth beside the hiddenLevers check (step 1), and the kind = 'scenario' checks of §11.2.
```

Header as the share migrations: preflight (`select kind, count(*) from public.share_links group by 1`), post-apply (the constraint, a
probe insert of a clean scenario snapshot and of each refused shape in a rolled-back transaction), rollback (the previous constraint and
the two previous bodies; refused while any `scenario` row exists). `open_share_link`, grants and `share_links_no_speeds` unchanged.
`share-migration-order.test.ts` reads the newest `share_snapshot_problem` definition: extend it to this file. Anything only checked on
plain Postgres goes in `docs/supabase-notes.md`.

### 11.4 What a visitor sees

`shared-view.tsx` `Screen` case `"scenario"` renders `SandboxView` with a new `mode: "share"` (read-only, plus): the scenario's name and
description; its effective changes and notes, inherited ones tagged "from <parent>"; the run at the frozen `startDate` and `months`
(horizon fixed, open question 6) with "Compare with No changes" (one more run in their browser); Who gets too busy and when (no
acknowledge, no issues); Sales and money **without costs or profit** (the bundle is `payHidden`, whatever the toggles: Financials on
shows role rates in the changes, never pay); the price-rise trade-off; phase 4's time split for team and roles (no per-person scope);
"When" (capacity line only); Print and the numbers CSV (no costs). No scenario picker, no goal seek, no tornado, no Settings or share
links. Footer as other links: "A copy made on <date>".

**Making it:** `ShareButton kind="scenario"` in the scenario bar for admins and the Owner, on a saved scenario with no unsaved edits
("Save first to share it."). `lib/share/list.ts` names the row by the scenario (or "A deleted scenario"); the Share links table shows
kind "Scenario".

## 12. Viewers and pay (B1), all of phase 5

| | Owner, Agency admin | Viewer | Share visitor |
|---|---|---|---|
| Notes | edit, read | read | read (scrubbed) |
| CSV / print | yes; costs optional; never per person or role labour | yes; no costs | yes; no costs |
| Capacity runs out | yes | yes | yes |
| Hire payback | yes | no (needs profit) | no |
| Goal seek | yes, "Add as a change" | run only (open question 1) | no |
| Tornado | yes | yes, no money measures or C1/C2 | no |
| MCP | everything the token user reads | `payHidden`: profit, labour null; people labelled | n/a |

No phase 5 lever stores individual pay; C1 is a role rate (`pay: "role"`).

## 13. Performance

Targets unchanged (PRD §6.7, the Sandbox segment < 1 s at 12 months). New: `sandbox-performance.test.ts` (perf tag) gains "a goal seek
over D5 0–10 is at most 8 runs and under 8 s sequential at 12 months" and "a tornado on seeded Northbeam is at most 25 runs, under 25 s
sequential (under 9 s on 3 workers)"; MCP `run_scenario` saved mode under 3 s for a 2-run scenario at 12 months (server, alone). Record
in `docs/engine-versioning.md` beside the Sandbox timings. The 5a move must leave `test:perf` (engine and web) within 5% or 10 ms.

## 14. Tests (5b)

- **DB:** `share-snapshot.test.ts` (scenario snapshot: redaction, People-off hire names, Financials-off C1/C2, notes scrubbed, the
  format rules for every new key at any depth, in TS and SQL from one case table); `share-links.test.ts` (insert/update a scenario
  link; another workspace's scenario refused; play refused); `share-field-classes.test.ts` (typed `ScenarioShare` map; lists equal);
  new `scenario-share-migration.test.ts` (build to `20270114000000`, existing links of every kind, migrate, all still open; the probes
  of §11.3).
- **Web:** `sandbox-goal-seek.test.ts` (state machine on fabricated measures: both ends met, none met, integer and continuous
  bisection within 8, a non-monotone sequence flagged, rounding to step); `sandbox-tornado.test.ts` (variants per model: groups vs
  pooled, hidden kinds, E3 skipped at 0 rework, money levers only for profit; ranking; greyed under 1%); `sandbox-measures.test.ts`;
  `share-actions.test.ts` (scenario link made, refreshed, refused for an unsaved/missing scenario, Viewer refused);
  `sim-pool.test.ts` (`cache: false` neither stored nor evicting); stories for the dialog and chart.
- **Browser:** `sandbox-browser.test.ts` (goal seek over D5 in the demo answers and "Add as a change" adds it; cancel stops runs; the
  tornado draws and ranks; a Viewer sees goal seek without "Add"); `share-browser.test.ts` (a scenario link: changes and notes, the
  run, compare with No changes, no costs with Financials on, People off shows "New <role>" and labels); 1440/640/400 px, no console
  errors.

## 15. Docs (5b)

ADR 0016 dated amendment (scenario links: snapshot, the six format-checked keys, `who` accepted limit, C1/C2 and hire names hidden);
PRD §9 (scenario links), §8 (goal seek, What matters most), §13 (goal seek's boundary, the tornado's step); `production-migrations.md`
row; `SANDBOX_HELP` entries.

## 16. Out of scope

Engine changes (per-replication monthly profit, a whole-run range for payback); a server PDF; MCP exports or share links (MCP makes
none, ADR 0016); goal seek over two levers, or over A5, A6, B4, people-by-name (D1–D4) or E6; targets on clients at risk or purpose
shares in goal seek; a "quick" tornado; play mode or editing on scenario links; per-person time or busy in exports and links; moving
`describe.ts`/`format.ts` to `packages/db` (open question 8); `target_margin` lines, an overtime premium, late payments.

## 17. Done when

- **5a:** the runner lives in `@transpera-flow/db/sandbox` with no copy in `apps/web`; the parity test passes; MCP `list_scenarios`
  lists Northbeam's scenarios with notes, and `run_scenario` with `scenario: "Hire in March"` returns the same monthly numbers the
  Sandbox shows for it (checked on the seeded demo workspace by hand and in the test); notes save, show in the list and compare, and
  survive Duplicate, Build on, a process-page edit and a restore; both CSVs download and the print is one A4 page in Chrome and Safari;
  "When" shows capacity and (admin) payback; the process page no longer offers the two silent sliders on Northbeam; the notes migration
  runs on a throwaway Neon branch of Preview (count of scenarios equal, `is_sandbox_changes` holds for all).
- **5b:** goal seek answers "how many more Designers to stay under 85% every month" in the demo in ≤ 8 runs, and flags a
  non-monotone case; the tornado ranks levers for profit and for peak busy; a scenario share link opens for an outside visitor with
  the redactions of §11, Update copy refreshes it, and the database refuses each leaky shape; the share migration runs on a throwaway
  Neon branch with existing links still opening.
- Both: `pnpm lint && pnpm typecheck && pnpm test` green; perf recorded; generated files regenerated; docs updated.

## 18. Open questions for Opus (recommended defaults)

1. **Can Viewers run goal seek and the tornado?** They try values that aren't saved; phase 1 Q6 said Viewers "open, run and compare
   only". *Default: yes, as read-only analysis (nothing saved; play-link visitors already try levers), without money measures and
   without "Add as a change".* **For Austin**, since it widens what Viewers do.
2. **Where notes live.** *Default: a `note` key inside each change (≤ 280 characters),* not a column or a separate notes map.
3. **Tornado precision.** *Default: 30 runs per bar, no quick mode;* run on demand, cancellable.
4. **Tornado and goal seek around what?** *Default: the scenario on screen (its effective changes); "No changes" when none is open.*
5. **Export costs.** *Default: admins choose "Include costs and profit" (on); never per-person or per-role labour.*
6. **Scenario links: horizon.** *Default: fixed at the scenario's saved horizon and the frozen start;* the visitor can't change it.
   Alternative: let them pick 1–24 (runs locally, nothing saved).
7. **Scenario links: what the visitor can export.** *Default: print and the numbers CSV, no costs.*
8. **MCP change wording.** *Default: structured fields (`lever_label`, `target_name`, `from`, `note`), no sentence;* moving
   `describe.ts` would also move `format.ts` (43 importers). Revisit if Claude's reports read poorly.
9. **Payback range.** *Default: means only, labelled.* A 10–90% payback month needs `monthlySamples.profit` (an engine change and a
   minor bump).
10. **Goal seek "9 in 10" targets.** *Default: offered for busy and month-profit targets* (p90/p10 of the month); not for churn or run
    totals (no per-replication values).
11. **Runner location.** *Default: `packages/db/src/sandbox` behind the `./sandbox` subpath;* a new `packages/sandbox` costs plumbing for
    no gain.
12. **Split.** *Default: 5a then 5b as above;* one build only if Opus prefers a single review and accepts the share-link risk in a large
    diff.
