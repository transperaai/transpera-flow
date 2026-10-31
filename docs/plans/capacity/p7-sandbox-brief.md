# P7: the free-play Sandbox

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p7-sandbox`, from `claude/relaxed-babbage-51ysen`.
Migration versions `20270123000000`–`20270123009999`.

Sources:
- the P7 row of `docs/plans/client-build-handover.md`;
- D28, D29, D31, D33, D36 and **D38**, which replaces saved scenarios;
- the prototype's **Sandbox**: `defaultPlay`, `playToChanges`, `verdict`, `lineChart` and `pageSandbox` in
  `docs/prototypes/client-capacity-app.PROTOTYPE.html`, lines ~985–1112;
- the existing Sandbox: `apps/web/src/components/sandbox/*`, the lever registry `packages/db/src/sandbox-levers.ts`,
  `packages/db/src/sandbox/*` and ADR 0021 "one scenario model";
- P5's derived figures in `packages/db/src/capacity-figures.ts` (DLER, busy against line, hiring advice).

## The short version (D38)

The Sandbox becomes free play. There are no saved scenarios: levers reset when you leave the page, and the
save/compare UI is hidden. Stored scenarios stay in the database, untouched. The page has three parts.

1. **Company processes, on top.**
   - The company map with all its controls (D25).
   - For **each process**, a **map version** picker: "Today" or one of its solutions, from a chosen month.
   - Per step, a **block** picker: "As today", or a change that acts on that step, from a chosen month.
2. **Levers, left.**
   - **Market:** conditions from a month; leads %; win rate %.
   - **Win new clients:** Organic and Performance a month, starting month, for how many months, tier or usual mix.
     These are on top of lead flow, placed least-busy.
   - **Lose clients:** churn %, and "a named client leaves in a month".
   - **Prices:** change % by tier, from a month, and "Clients react" Barely / Normally / Strongly (D36).
   - **People:** someone leaves in a month; hire a role from a month, ramped.
   - **Reset levers.**
3. **Results, right.**
   - **"What happens"**, the prototype's verdict sentences, with today's path against this one.
   - **Four charts against today's path** (dashed): clients by department; retainers a month; DLER by department with
     the 4.5 goal line; busy share of the five busiest teams with their lines.

Goal seek and "What matters most" stay hidden (D33).

## 1. Changes as stored objects (`20270123000000_capacity_changes.sql`)

**New table `capacity_changes`:**
- `id, workspace_id, name, kind ('automation'|'augmentation'), effects jsonb, adoption, ramp_months, tiers text[]
  null, cost_monthly null, issue_id null, source label, provenance`;
- `effects` is the engine's `StepChangeEffect[]` with step ids;
- RLS like the neighbouring tables: members read; Owner and Agency admins write (D18);
- include it in the workspace bundle and its restore.

Mapping (`toEngineModel` or the Sandbox model builder): a block swapped in from month m becomes an
`EngineStepChange` with `startMonth = m`. Nothing is swapped in today's model, so `changes` is unset there.

**Editing:**
- a small "Changes" list in the Sandbox's blocks panel (add, edit, remove), with effects picked by step and part;
- the step inspector slot P4 left ("Changes that act on this step") lists them read-only, with a link.

**Example data:** extend P2b's example-workspace loader with the prototype's `LIB` list (13 changes).

## 2. Map version per process (D38)

- Reuse the existing "Solution goes live" lever (E6) and the solution splice (`packages/db/src/sandbox/solution.ts`,
  `splice.ts`). If E6 already takes a month, use it.
- If the engine can't switch maps part-way through a run, run the chosen version for the whole run. Show "from the
  start" as the only month, and report it as a gap. **Don't** build mid-run map switching.
- The picker shows each process's solutions by name, with the issue each one is linked to.

## 3. Levers: reuse first

Map each prototype lever to the existing lever registry: A1 (opportunities), A3 (conversion), B2/B3 (fees, churn),
B5 (price rise), D1 (hire), D2 (someone leaves), and the market schedule. Add only what's missing:

- **"Win new clients" by department, tier and timing (A1).**
  - Extra won clients, injected as arrivals that skip the pipeline, so they go straight to onboarding and servicing.
    Place them least-busy.
  - If the engine has no way to inject won clients, add one. It's an optional `EngineModel` field: unset means no
    change, and goldens stay identical. Bump `ENGINE_VERSION` only if a golden moves.
- **A named client leaves in a month:** that client's end. The roster may already support it; check before adding
  anything.
- **Price reaction (D36):**
  - Barely, Normally and Strongly set the price churn driver's effect to 0.5×, 1× and 2× the tier's
    `price_rise_churn`.
  - The results show the clients lost to the price rise as their own line, from churn causes.
- **Hires** use the workspace's ramp default.

**Free play:** every lever change re-runs, debounced, in the worker, with progress. Use the replication count P5
chose for the 12-month run. Results cache by model hash.

## 4. Verdict and charts

- The verdict is the prototype's `verdict` logic over the engine's monthly series, written as pure functions in
  `packages/db/src/sandbox-verdict.ts` with tests. It covers:
  - clients, retainers and DLER at month 12 against today's path;
  - teams over their line and when, with hiring advice;
  - people going over sooner, and people relieved;
  - the worst month's count of people over their line.
- Use P5's `dler`, `busyShares` and `hiringAdvice`. Don't re-derive them.
- **Charts:** use the existing chart components where they fit. Today's path is dashed, with its legend entry.

## 5. Hide what free play replaces

- The scenario bar's save, rename and duplicate, the scenario list, and compare (up to 3): hide them behind
  `SANDBOX_SCENARIOS_SHOWN = false`, next to P0's `SANDBOX_ANALYSIS_SHOWN`. Keep their code and tests.
- The CSV/print export stays, exporting the current free-play run.
- The old library presets ("Automate the heaviest step" and the rest) are replaced by the changes list.

## Tests

- **Verdict functions:** hand-checked.
- **Lever mapping:** each prototype lever produces the expected change.
- **Win new clients:** N clients a month for k months lands N × k clients, by tier.
- **Price reaction:** Normally doubles Barely's extra churn.
- **Changes table:** RLS, bundle round-trip.
- **Block swap:** the swapped step's hours fall by the `stepParts` amount.
- **Map version:** picking a solution runs its map.
- **Browser:** levers reset on leaving, the verdict renders, no save UI shows, phone width.

## Done when

- `pnpm lint && pnpm typecheck`, the suites for the files you touched, and the web build pass. Goldens are unchanged
  unless the report explains why.
- Screenshots on the example workspace, light and dark, at 1440 and 400 px.
- The report lists every prototype lever and what it maps to, and any gap (for example mid-run map switching).
