# Engine versioning and golden models

The engine's numbers are the product, so none may move unnoticed (docs/PRD.md §6.9 layer 3, decision D16;
issue #22; ADR 0009). Five golden models are run at a fixed seed on every push, their key outputs are compared
exactly with approved baselines, and every change that moves one needs a new baseline and a new `ENGINE_VERSION`,
which every run records.

## What is locked

| Golden model | Fixture | What it covers |
|---|---|---|
| `northbeam` | `northbeamModel()` | The prototype's model, re-baselined after the §6.8 fixes: pooled head-counts, one implicit retainer, automatic warm-up. |
| `northbeam-seeded` | `northbeamWithServicing()` | Northbeam with its 26 named clients (the seed now counts clients per service: see `northbeam-groups`): SEO and PPC services with condition-tag routing, 11 named people, the 26-client roster, a 10% overtime cap, and two servicing processes whose late and missed tasks move health and churn. |
| `northbeam-groups` | `northbeamWithClientGroups()` | Northbeam with its clients counted per service (17 SEO clients at health 83, 12 PPC clients at health 52, from `NORTHBEAM_CLIENT_GROUPS`) and simulated as unnamed clients, with the same servicing (issue #120). |
| `northbeam-drivers` | `northbeamWithChurnDrivers()` | `northbeam-groups` with all ten churn drivers switched on at the prototype's weights and one of the user's own (a competitor undercutting): who the churn is blamed on, and what each cause measured (A56, below). |
| `larkspur` | `larkspurModel()` | Larkspur Creative, the "second, messier sample agency" (§6.9): overloaded designers, a copywriter past her week on overtime, an 18-client named roster whose health drives churn, and the corners Northbeam leaves alone (below). |

Each runs with the app's defaults, 30 replications at seed 1. The outputs kept (`keyOutputs` in
`packages/engine/test/golden.ts`) are throughput (won, lost, done, wins a week), cycle time (mean, P50, P90), new
MRR, billed, LTV added and lost revenue, labour, overtime hours and cost, clients at risk and churned, servicing
touchpoints, the bottleneck role, step and person, utilisation per role (total with its 10–90% range, and its
pipeline, client, servicing and overtime shares) and per person, each step's arrivals, departures, queue, wait,
WIP and SLA breaches, each roster client's final health, churn and at-risk shares, and the rating of every detected
issue with how it was reached (the average's band, a bad month, the bottleneck), so a moved cut-off or escalator shows
as a baseline change. They also lock the absence test (`absenceTest` at its defaults: who is tested, work lost, weeks
to recover, missed client tasks) and each step's visits sent straight to a lost end.

### The absence test and the performance targets

The absence test (docs/analysis-rules.md rule 8) is a separate pass, not part of `simulate`, so the baseline stays
inside docs/PRD.md §6.7. It costs (people tested + 1) × 10 replications: about 60% of a baseline run for the seeded
Northbeam (two people tested: ~160 ms beside a ~270 ms baseline on a loaded machine) and 90% for Larkspur (four).
It is limited to people who are the sole holder of a step, at most 8, and runs in its own worker after the baseline
(`apps/web/src/lib/sim/absence.ts`), so the insight panel shows the other rules first and adds "only one person can do
it" when the pass returns. `new-rules.test.ts` checks the pass alone stays under the seeded target (250 ms).

The baselines are `packages/engine/golden/<model>.json`, one metric per line so a diff reads as a list of what
moved. `golden/versions.json` is the ledger: every approved version, the date, why the numbers moved, and a sha256
of all the baselines' outputs at that version.

**No tolerances.** Comparisons are exact. The engine is deterministic: per-purpose random streams, portable
`log`/`exp` (`det-math.ts`), and otherwise only IEEE arithmetic and `Math.sqrt`, which are correctly rounded
everywhere. `browser-determinism.test.ts` checks every golden model gives byte-identical results in Node and a
Chromium worker. A change that only reorders floating-point sums moves the last digit, and that is still a change
to review: approve it like any other.

### Larkspur's messy corners

Larkspur (`packages/engine/src/fixtures/larkspur-data.ts`, shared with the seed) has a 37.5-hour week; a founder
in two roles pinned to pitch calls; a part-timer, a contractor with their own hours and rate, and a specialist
limited by skills; two people on leave; triangular, constant and custom-spread lognormal distributions; 25–30%
rework; two lost ends; step SLAs; work in progress at two steps instead of a warm-up; seasonality with 1% monthly
growth; a retainer on servicing (monthly calendar, Poisson ad-hoc requests), a retainer on fallback load, and
one-off website builds whose clients keep a care plan; a client with no health entered; and non-default health
rules. `larkspur.test.ts` checks it stays overloaded, on overtime and churning on health, so a later re-baseline
can't quietly make it tidy.

## When a golden test fails

The failure names the model and prints the numbers that differ. Then either:

- **The change was not meant to move numbers.** Fix the change.
- **It was.** Approve the new baseline, from the repo root:

  ```sh
  pnpm --filter @transpera-flow/engine golden:approve "Servicing tasks now queue behind pipeline work at equal priority"
  ```

  This reruns the golden models, prints every value that moved, rewrites `packages/engine/golden/`, bumps
  `ENGINE_VERSION` in `packages/engine/src/version.ts` to the next minor version (1.0.0 → 1.1.0), appends the
  version, the date and your reason to `golden/versions.json`, and reruns the golden tests. Commit the
  baselines, the ledger and `version.ts` in the same commit as the engine change, and say in the PR why the
  numbers moved. Reviewers read the baseline diff.

Options: `golden:approve --bump "why"` bumps even when no snapshotted number moved (an engine change the key outputs
don't show, such as a new result field whose meaning matters). For a major version, raise `ENGINE_VERSION` by hand
first (`2.0.0`), then approve: approval keeps a version above the ledger's last.

Adding or removing a golden model, or changing the outputs kept, also changes the baselines: approve it the same
way.

### What stops a baseline changing without a bump

`golden.test.ts` fails unless all of these hold:

1. Each model's outputs equal its baseline exactly.
2. Each baseline records `engineVersion` equal to `ENGINE_VERSION`.
3. `ENGINE_VERSION` is the ledger's last entry, and the sha256 of the baselines on disk equals the digest recorded
   for it. A baseline edited by hand, or regenerated without approving, no longer matches, so CI fails until it is
   approved, which bumps the version.
4. Ledger versions only increase, and each has a reason.

## Market conditions (engine 1.2.0)

`EngineModel.market` holds a schedule of seven factors per month (`packages/engine/src/market.ts`, decision D29). A
model with no market, or with every factor 1 in every month, runs exactly as before: `activeMarket` returns null and
every code path is the old one, so no golden number moved and 1.2.0 was approved with `golden:approve --bump`.
Enquiries change the arrival rate month by month (`demand.ts`). Enquiries that sign scale, once per path, the
probability of the edges to the sale at the step that decides it: the step whose edges all lead only to a win or
only to a loss (Northbeam's and Larkspur's `decision`); earlier steps, whose edges can still end either way, are
left alone. Time to decide scales external waits at steps before the sale (steps that can still reach a lost end),
not onboarding, delivery or servicing. Prices scale the fee of each client won (new MRR, billed, LTV added). Clients
leaving scale churn. Known limits, which A56 considered (see "Churn drivers" below): `lostRevenue` is valued at
today's price and LTV uses today's tenure (both still true), a roster client's reported `churnMonthly` was its base
rate (fixed in 1.6.0), and the pooled billing estimate uses the churn factor of the month a client is won in (still
true; the pooled month-by-month `mrr`, added in 1.9.0, decays with the pool's `churnMonthly` and follows the `clients[""]`
count, while a won retainer's `billed` uses that service's own `churnMonthly`, so the two can differ when the rates do).
`withMarketCondition` replaces any schedule on the model. The
`northbeam-downturn` golden model runs Northbeam as seeded under Downturn, so a change to this maths shows up in the
golden test. Time to hire and late payments are stored but change
nothing, as the engine has no hiring or cash-flow model yet. To run a model under one condition (the stress test
on solution pages): `simulate(withMarketCondition(model, MARKET_PRESETS.downturn.factors), reps, seed)`.

## Churn drivers (engine 1.6.0)

`EngineModel.churnDrivers` holds the ten built-in drivers' weights (0 to 3) and on/off switches, plus the user's own
(`packages/engine/src/churn-drivers.ts`, decision D28, issue #121). A client's weekly chance of leaving is

    base × (1 + Σ weight × pressure) × (1 + market weight × (churn factor − 1)) ÷ 4.33

where base is its service's normal churn (the client group's), the sum runs over the switched-on drivers other than
the market, and a driver's *pressure* is how much extra churn its cause adds at weight 1 (0 = nothing wrong, 1 =
doubles that client's churn). Late work's pressure is the health term the engine always had (health sensitivity ×
the health lost), so `late` at weight 1 is the old formula. The others are measured per client each week: ad-hoc
requests answered late or missed (`resp`), a client won in the run waiting for its first delivery against a normal
10 working days (`onb`, first six months), the share of its servicing visits redone against a quarter (`rework`),
how busy the people who look after it have been against 85% (`load`), an entered rate of account manager changes
plus weeks its people are away (`handoff`). `results` (a rating out of 10, 8 or more adds nothing), `tenure` (the
multiple in the first six months for a client won in the run), `price` (a planned rise, 20% more churn per 10% for 13
weeks from its month) and your own drivers (extra churn in percent) are what the user enters. The market driver
weighs the whole product.

**Defaults change nothing.** A model with no `churnDrivers` runs with late work and the market on at weight 1 and
everything else off. At weight 1 the multipliers are bit-for-bit the old ones (`1 + 1 × x`, and the plain factor), no
random draw is added or moved, so every number the golden models already kept is unchanged; 1.6.0 was approved
because it adds what the baselines keep: each driver's share, pressure and measured value (`churnCauses`), the new
`northbeam-drivers` model, and the rule 10 issues in `ratings`. Drivers apply to a model with a client roster (named
or counted in groups); the pooled model has no per-client state, so only the market driver acts on it.

**What a run reports** (`SimulationResult.churnCauses`): per driver (switched off ones too, so the screen can show
what they would be), its share of all the clients lost, the clients and monthly fees that is, its average pressure and
the value measured (share late, hours to reply, working days to first delivery, share redone, how busy the busiest
person is, the market's average factor, or the number entered). Shares are of the *expected* clients lost, summed from
each client's weekly chance split by the parts of the product above, so they are smooth (not just the churn events
that happened) and add up, with normal churn, to 1. They are also kept per service for rule 10. The Settings screen
projects churn as the weights move (`projectChurn`) from these pressures without simulating again.

**Rule 10** (`churnCauseIssues`, key `churn_risk:driver:<service>:<driver>`): a driver causing 30% or more of a
group's churn is Bad; Operational risk when the group's health is also under 50. Both numbers are the rule's settings.

Known limits from the market ticket: the per-client `churnMonthly` now includes the drivers and the month's churn
factor (the chance it had at the last tick, with health as it ended). Not changed: `lostRevenue` and LTV still use
today's price and tenure, and the pooled billing estimate still uses the won-month churn factor. Pressures are
measured on the clients that are still active, so a driver that makes clients leave also thins the sample it is
measured on; the share is of expected churn each week, which keeps that small.

## Per-person times (engine 1.10.0, C6)

`EnginePerson.capacityFactor` (`{ default?, steps? }`, `packages/engine/src/simulate.ts` `factorsFor`) multiplies the hands-on time a person takes on a step: `st.work() × factor`, after the draw, so no random stream moves and a model with no factors (or every factor exactly 1) takes the old path with one null check per service start. `steps` wins over `default`; a step in neither is 1; the engine accepts any positive finite number (the database limits 0.5 to 2) and throws, naming the person, for anything else. No fixture has a factor and the app's switch is off by default, so no golden number moved: 1.10.0 was approved with `golden:approve --bump` and the ledger digest equals 1.9.0's. Analytic estimates stay at the role's normal time (`offeredLoad`'s `stepHours`, work at unstaffed steps, the issues' "hands-on X h"). A saved run's `resolvedPeople` echoes the model's people, so it carries the factors of an editor's run (saved runs are editor-only).

## 24-month horizon (A58, no engine change)

The horizon picker (1, 3, 6, 12 or 24 months, `apps/web/src/lib/horizon.ts`) sets `horizonWeeks` to 4, 13, 26, 52 or
104 weeks (52 a year, so 3 months is the 13-week default). The engine already took any horizon from 1 to 104 weeks,
so nothing in it changed: no golden number moved and `ENGINE_VERSION` stays 1.2.0. The market schedule (A57) covers
24 months, so a 24-month run reads every month of it.

PRD §6.7's targets are for 13 weeks. A run costs about as much per week as the one before, so
`apps/web/test/horizon-performance.test.ts` scales them by the horizon: 104 weeks is 8 times 13, so the limits are
8 × 150 ms for the pipeline-only Northbeam and 8 × 250 ms for the full seeded Northbeam and Larkspur, best of three
re-runs after a lever move at 30 replications. Measured on a shared 4-core container (another agent's load was on
it), 30 replications, seed 1:

| 24-month run | Best of 3 | Scaled limit | Unscaled §6.7 target |
| --- | --- | --- | --- |
| Pipeline-only Northbeam | 180 ms | 1,200 ms | 150 ms (over, as expected for 8 times the weeks) |
| Full Northbeam (roster and servicing) | 362 ms | 2,000 ms | 250 ms (over) |
| Full Larkspur | 235 ms | 2,000 ms | 250 ms |
| Full Northbeam, downturn all 24 months | 300 ms | 2,000 ms | 250 ms (over) |

All sit well inside the scaled limits (about a fifth to a sixth), and they are a fraction of the 12-month forecast
target (< 5 s for a 40-step model). The 40-step, 25-person model was not measured at 24 months: its 12-month target
is 5 s, and the numbers above leave plenty of room, but a 24-month run of it should be timed when a model that size
exists to test with. Timing tests can fail on a loaded machine; re-run them alone before concluding.

## Where the version goes

- `SimulationResult.engineVersion` on every run, in the browser worker and on the server.
- Saved runs: `runs.engine_version` (the column has existed since #25; no migration). The run page shows
  "engine 1.0.0" and, when the engine has changed since the run was saved, a note that running the same model again
  can give different numbers. Runs saved before this record none ("engine version not recorded").
- MCP: `run_scenario`, `compare_scenarios`, `check_robustness` and `get_bottlenecks` return `engine_version`.
- Reports: the PDF report (#28) should print `ENGINE_VERSION` on its methodology page.
- Caches: the robustness cache is in memory for one tab, so a deploy clears it. A cache that outlives a deploy must
  include `ENGINE_VERSION` in its key.

## Northbeam, re-baselined

PRD v0.2 expected "strategist ~91%, ~7 wins a quarter at seed 1" from the prototype. After the §6.8 fixes, engine
1.0.0 gives, for `northbeamModel()` at seed 1, 30 replications, 13 weeks:

| | Engine 1.0.0 | Prototype (v0.2) |
|---|---|---|
| Strategist utilisation | 84.5% (range 73–99%) | ~91% |
| Wins a quarter | 10.4 (range 7–14) | ~7 |
| Lost | 78.2 | |
| Cycle time | mean 198 h (≈ 5 weeks), P50 188 h, P90 260 h | |
| New MRR | £39,393 (range £26,600–£53,200) | |
| Bottleneck | Strategist, at Audit & proposal | Strategist, at Audit & proposal |

Why they differ:

1. **7 leads a week, not 12.** At 12 the lone strategist gets about 38 hours of audits and kickoffs a week against
   the 30 left after client work, so the queue grows without bound and every number depends on how long the run
   went on. At 7 the strategist is still the bottleneck but the business reaches a steady state
   (`prototype-parity.test.ts` checks the fixture is otherwise the prototype's `BASE_MODEL`).
2. **A warm-up** (§6.8 item 6): the prototype starts from an empty business, so its first weeks have nothing in
   flight and it under-counts wins. The engine discards an automatic warm-up (430 hours here) first.
3. **Ongoing load from the live client count** (§6.8 item 2): the prototype reported client work from the starting
   26 clients while it used the live count for capacity.
4. **Separate random streams per purpose** (§6.8 item 1): the same seed draws different samples. Over 300
   replications the port still agrees with the prototype run the prototype's way (`prototype-parity.test.ts`).

Northbeam as seeded (`northbeam-seeded`: services, named people, its roster and servicing) gives strategist 82.2%,
11.6 wins, 4.9 clients churned and 1.0 at risk a quarter. Larkspur gives 21.7 wins in 26 weeks, the copywriter at
110% with 105 hours of overtime, designers at 85%, 8.8 clients at risk and 10.3 churned. The baselines hold the
rest.

## Where Larkspur lives

- Engine: `larkspurModel()` from `packages/engine/src/fixtures/larkspur.ts`, built from `larkspur-data.ts`.
- Seed: `larkspurBundle()` in `packages/db/src/fixtures/larkspur.ts`, in `seed.sql` and `bootstrap.sql` beside
  Northbeam (slug `larkspur`), so it loads locally (`supabase db reset`) and on preview branches, which run the
  seed. `packages/db/test/larkspur.test.ts` checks the rows resolve on 5 October 2026 to exactly
  `larkspurModel()`; `database.test.ts` checks the seeded database round-trips to the same model.
- App: `/demo/larkspur`, read-only from the fixtures, on any deployment.
- Production: not loaded. It is a test and demo agency; add it by hand only if wanted.

## Nested models (issue #102)

A step can hold its own steps: a group, or a child process. The engine flattens a nested model to leaf steps before every run
(`flattenModel` in `packages/engine/src/flatten.ts`, called by `simulate`, `runOnce` and `initialState`; a model with no groups comes back
as the same object). A nested model therefore gives exactly the numbers of the same model drawn flat, which `test/nesting.test.ts` and
`packages/db/test/nested-model.test.ts` check, and the golden models (all flat) did not move: introducing groups needed no `ENGINE_VERSION` bump.
Draw a group open or closed, or move a step into one, and no number changes; adding or removing steps still does, as before.
