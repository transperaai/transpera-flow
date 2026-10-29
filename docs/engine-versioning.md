# Engine versioning and golden models

The engine's numbers are the product, so none may move unnoticed (docs/PRD.md §6.9 layer 3, decision D16;
issue #22; ADR 0009). Ten golden models are run at a fixed seed on every push, their key outputs are compared
exactly with approved baselines, and every change that moves one needs a new baseline and a new `ENGINE_VERSION`,
which every run records.

## What is locked

| Golden model | Fixture | What it covers |
|---|---|---|
| `northbeam` | `northbeamModel()` | The prototype's model, re-baselined after the §6.8 fixes: pooled head-counts, one implicit retainer, automatic warm-up. |
| `northbeam-seeded` | `northbeamWithServicing()` | Northbeam with its 26 named clients (the seed now counts clients per service: see `northbeam-groups`): SEO and PPC services with condition-tag routing, 11 named people, the 26-client roster, a 10% overtime cap, and two servicing processes whose late and missed tasks move health and churn. |
| `northbeam-groups` | `northbeamWithClientGroups()` | Northbeam with its clients counted per service (17 SEO clients at health 83, 12 PPC clients at health 52, from `NORTHBEAM_CLIENT_GROUPS`) and simulated as unnamed clients, with the same servicing (issue #120). |
| `northbeam-drivers` | `northbeamWithChurnDrivers()` | `northbeam-groups` with all ten churn drivers switched on at the prototype's weights and one of the user's own (a competitor undercutting): who the churn is blamed on, and what each cause measured (A56, below). |
| `northbeam-money` | `northbeamWithMoney()` | `northbeam-groups` with 18,000 a month of overheads and PPC priced hourly at 95, run month by month (engine 1.11.0): billed revenue by kind, hourly work, paid labour, overheads, profit, and the monthly sales, revenue and money series. |
| `northbeam-chances` | `northbeamWithChances()` | `northbeam-drivers` with `late` measured as events (effect 0.6, 3 months), `handoff` entered (chance 0.05, effect 1, 2 months), the custom driver at chance 0.1 effect 0.5, a PPC fee range 3,000 to 6,000 and a `fee` channel of PPC +8% from month 4 with the price driver on, run month by month (engine 1.12.0). |
| `northbeam-channels` | `northbeamWithChannels()` | `northbeam-money` with monthly channels from month 3: leads x1.2, conversion x0.9, hands-on time x0.7 on the heaviest step, a wait of 0 to 8 h, rework 0 to 0.1, role cost x1.1, overheads x1.25, one person's capacity x0.9 and base churn x1.3 (engine 1.12.0). |
| `larkspur-time` | `larkspurWithPurposes()` | Larkspur with a purpose on every step (a mapping by step id: `LARKSPUR_PURPOSES`), run month by month for six months of its week-26 horizon: where working time goes (engine 1.14.0), first-pass hands-on hours by purpose, rework, client hours, idle and hours available, for the team and each role. Every other number is `larkspur`'s. |
| `larkspur` | `larkspurModel()` | Larkspur Creative, the "second, messier sample agency" (§6.9): overloaded designers, a copywriter past her week on overtime, an 18-client named roster whose health drives churn, and the corners Northbeam leaves alone (below). |

Each runs with the app's defaults, 30 replications at seed 1 (`northbeam-money`, `northbeam-chances`, `northbeam-channels` and `larkspur-time` also ask for the monthly series). The outputs kept (`keyOutputs` in
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
golden test. Late payments are stored but change nothing, as the engine
has no cash-flow model yet; Time to hire acts through the Sandbox's hiring delay only (below, engine 1.12.0). To run a model under one condition (the stress test
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

## Time by purpose (engine 1.14.0, sandbox phase 4)

Added 29 Oct 2026 (`docs/plans/sandbox-p4-brief.md`). **No existing simulated number moved.** The approved diff of the nine existing golden models is `engineVersion` and nothing else; `larkspur-time` is new. Approved with `golden:approve "Time and what it achieves (sandbox phase 4): ..."`. Beyond the goldens, the full `simulate` output of nine fixture models at two seeds, monthly on and off (8 replications), is byte-identical to the parent commit's once `monthly.time` is taken out (hashed with sha256), and Larkspur with a purpose on every step equals Larkspur without one.

- **`EngineStep.purpose`** is an opaque key (omitted: `""`). The engine never reads it for a decision: nothing draws a random number, reorders a sum or changes an event. The app maps keys to the workspace's categories (names, order and the two mappings below live outside the engine, so a rename or a reorder needs no run).
- **`MonthlyResult.time`** (`purposes`, `roles`, `people`, `team`; each a `TimeSplit` of `Stat`s over replications, hours in the month): `purpose[key]` first-pass hands-on hours; `rework` hands-on hours on repeat passes (a back-edge or a same-step redo, by `repeatLoop`, whatever the step's purpose, never in `purpose`); `ongoing` = max(0, work - sum of purposes - rework): the client hours that are not steps; `idle` = max(0, hours - work); `hours` = hours available + overtime worked, the 100%; `uncovered` (roles and team) = work nobody was there to do. Per replication, purposes + rework + ongoing + idle = max(hours, work). The team is the sum over people (so a person in two roles is counted once); a role is attributed by the step's role, the same as `roleWork`, so a role's split adds up to its busy share's work. A step with no model role counts for the person only.
- **Where it is booked** (`startService`, in the existing `if (mon)` block): from the *final* `handsOn`, after the per-person factor and the step-work channel (`chWork`). `repeatLoop` is pure, so it is now called whether or not `t >= 0` (the run's own `rework` totals keep their `t >= 0` guard). The warm-up and a job straddling the horizon count only their in-window part (`spread` clips). A month's rework therefore differs a little from `rework.roleHours`, which counts a pass whole at its start: documented, not reconciled.
- **The sale side** (`saleSideSteps(model)`, pure, exported): the step where the sale is decided (an edge only to a win and an edge only to a loss) and every step after it that can reach a win but no longer a loss; empty when no lost end is reachable. The app uses it for the Automatic purpose of a pipeline step (Austin, 29 Oct: from the sale on moves the client's job forward).
- **Output size and cost.** `MonthlyResult` grows by keys x (roles + people + 1) x months x 3 numbers; only monthly runs pay.
- **Review fixes (29 Oct, same version: only `time` changed and no golden value moved).** (1) Client hours of someone on leave that no colleague of the role was there to take that month (`MonthlyReplication.roleAwayUnshared`; a one-person role on holiday) were in the role's work but no one's: the role's split showed them as work above its hours ("overtime capped") and the team's dropped them. They are now `uncovered` for the role and the team, and not the role's work in the split (busy shares are unchanged). (2) `TimeSplit.withRework[key]`: each key's first-pass hours plus all rework as one series per replication, so the app's Fixing row (its steps and every repeat pass) has the range of the sum; adding the two ranges is not a range of anything and can be narrower as well as wider. Checked by hand in `time-hand.test.ts` (purposes, the per-person factor, client upkeep, leave with and without a colleague, overtime, a mid-month hire and leaver, rework).

**Timings** (30 replications, seed 1, one container with noise of about 5%, the parent commit `93f67f9a` against this branch, interleaved in separate processes, best of 12 per run, best of 5 runs; budget: no case more than 5% or 10 ms slower). A model without purposes pays only the extra bookings and the larger monthly output:

| Engine case | Before (ms) | After (ms) | Change |
| --- | --- | --- | --- |
| northbeam pipeline 13w | 26 | 27 | +3.5% |
| northbeam groups+servicing 13w | 68 | 74 | +8.9% (+6 ms) |
| northbeam named roster 13w | 38 | 40 | +4.7% |
| larkspur 26w | 63 | 64 | +1.7% |
| large 40 steps 25 people 26w | 606 | 578 | -4.6% |
| northbeam groups 24m, no monthly | 387 | 392 | +1.1% |
| northbeam groups 24m, monthly | 492 | 516 | +4.9% |
| larkspur 24m, monthly | 296 | 312 | +5.4% (+16 ms) |
| northbeam pipeline 12m, monthly | 74 | 83 | +11.9% (+9 ms) |
| large 40 steps 26w, monthly | 661 | 709 | +7.1% (+47 ms) |
| larkspur 24m, monthly, a purpose on every step (new; before = without purposes) | 282 | 299 | +6.3% |

The two cases above the budget in that table are noise, not cost: re-measured alone, interleaved the same way (6 runs of 20), the 40-step monthly case reads 590 and 585 ms (-0.9%), and Larkspur 24m monthly reads between +2.3% (+7 ms) and +9% (+25 ms) from one set of runs to the next. A copy of the engine with the new bookings taken out read between +0.8% and +9% against the parent in the same runs, and a CPU profile of Larkspur 24m monthly (30 runs) totals 390.8 ms a run against 389.8 ms, so the run-to-run spread on this container is as large as the change. Two things keep the cost down: hands-on time is spread to a person, a role, a purpose and an overtime row from one decomposition into months (`spreadParts` / `addParts`, the same values `spread` adds, bit for bit) instead of one per row, and the month-by-month `Stat`s of the split come from typed buffers (`splitFrom`) rather than a sorted copy per series (the first version cost 5 to 14% on the monthly cases). Only monthly runs pay anything.

**Review re-measurement (29 Oct).** Wall-clock timings on this shared container swing ±5-10% even interleaved in one process (the parent against a copy of itself reads -5% to +5%), so the review counted instructions instead (`valgrind --tool=cachegrind --cache-sim=no`, `node --single-threaded`, 3 runs of 30 replications at seed 1 in one process, less the start-up; repeat runs agree to 0.1%). Against the parent: northbeam pipeline 12 months monthly +5.4% (about 4 ms of 75, inside the 10 ms floor; most of it is building the split's `Stat`s, which runs once per `simulate` and mostly unoptimised), Larkspur 24 months monthly +1.9%, the 40-step 25-person 26-week monthly run +4.0%. With the review's fixes (`withRework`, unshared leave hours) and a single-month fast path in the booking (the same additions in the same order), the large run is +2.1%, Larkspur +2.4% and the pipeline +5.9% (about 4.4 ms): every case within budget.

The web app's timing tests (`pnpm --filter @transpera-flow/web test:perf`: `horizon-performance`, `sandbox-performance`, `overview-performance`, `scenarios`; 16 tests) pass on the parent commit and on this branch, run alone, in separate processes, twice each. Their own best-of-3 figures (ms; parent run 1 / run 2, this branch run 1 / run 2; this branch's Sandbox and Overview runs use the model with purposes on):

| Case (limit) | Parent | This branch |
| --- | --- | --- |
| 24 months, pipeline-only Northbeam (1,200) | 238 / 258 | 234 / 227 |
| 24 months, full Northbeam (2,000) | 576 / 756 | 652 / 545 |
| 24 months, full Larkspur (2,000) | 359 / 383 | 395 / 398 |
| 24 months, full Northbeam in a downturn (2,000) | 489 / 442 | 432 / 484 |
| 24 months, full Northbeam, monthly output (2,000) | 668 / 596 | 888 / 619 |
| 24 months, full Larkspur, monthly output (2,000) | 378 / 372 | 498 / 425 |
| 12 months, 2,000 clients a group, 4 reps, weights / three chances (5,000 and 2 x) | 2,276 / 2,516 and 1,741 / 2,722 | 2,051 / 2,802 and 1,521 / 2,366 |
| Sandbox, seven segments at 12 months, total (7,000) | 2,787 / 3,506 | 3,256 / 3,502 |
| Sandbox, channel-heavy, one run (1,000) | 507 / 392 | 373 / 365 |
| Sandbox, price rise, two runs (1,000 each) | 448, 375 / 668, 561 | 700, 642 / 441, 375 |
| Overview runs at 24 months, full Northbeam (2,250) | 647 / 662 | 738 / 646 |
| Overview page work at 24 months (100) | 11.3 / 20.6 | 10.5 / 11.4 |

The run-to-run spread between two runs of the same commit (up to 30%: full Northbeam 576 and 756 on the parent) is larger than any difference between the commits, so the engine table above, interleaved and best of many, is the controlled comparison; every web case is far inside its limit.

## Warm-up hits and three review fixes (engine 1.13.0, sandbox phase 3 review)

Added 29 Oct 2026, from the adversarial review of phase 3. **Only `northbeam-chances` moved** (its two entered chances: account manager
changes and the competitor); every other golden value, and the full `simulate` output of eleven fixture models at two seeds, 52-week
horizons, planned starts, leave, every market preset and calendar months, is 1.11.0's to the last bit, monthly on and off.

- **Hits during the warm-up carry into the window** (brief Q11, which 1.12.0 missed: weekly ticks only run from week 1, so every
  client started the run unhit and an entered chance ramped up over its first `months`). At its first tick in chance mode, a client on
  the book from the start draws, on its own `hit:<driver>:<client>` stream and before the window's draw, one draw for each earlier
  warm-up week whose hit would still last (at most the hit's weeks less one, at most the warm-up). It then starts as likely to be under
  a hit as at any later tick: 1 - (1 - q)^(weeks a hit lasts), checked by hand in `chances-review.test.ts`. Those hits are not counted in
  the reported chance. A driver a channel switches to chance mode from a month starts that month fresh, so the months before it stay
  the run without it. Measured drivers have no warm-up events to draw from (touchpoints, visits and onboarding count from t = 0), so they
  still start unhit.
- **"Same expected churn" is about the same, not the same.** `equivalentEvents` gives the expected churn of a client on the book at the
  start. Over a run a chance-mode driver comes out lower than its weight: hits fall on fewer clients, those clients leave sooner (so the
  ones left are less often hit), and measured causes start unhit. On a 2,000-client group over 12 months with the warm-up's hits: results
  and your own drivers at chance 1 match exactly, the price driver matches exactly, handoff (2.5% a month, +410% for 3 months) gives 82%
  of the weight's extra churn, late work and team overload (measured) 85% and 79%. Settings says so.
- **The price driver's equivalent** was the generic `weight × pressure / exposure`, about a third of the right effect (its pressure is
  averaged over the whole run, its events last only after a rise). It is now `priceEffectOfWeight`: `weight × 2 × 0.1 × 13 / (months ×
  52/12)` per 10% rise (0.2 at weight 1 for 3 months), and `projectChurn` converts a weight-mode price pressure the same way.
- **A churn channel on merged clients:** clients worked out together (a group without servicing) took the market's multiplier for their
  reported churn, not the run's with the channel's factor. Simulated churn was right; the per-client `churnMonthly` now is too.
- **The overtime limit** was multiplied as `cap × (capacity × weeks)` for everyone in 1.12.0, which moves the last bit of overtime (and
  profit) of some models outside the goldens (Northbeam's named roster at seed 7: P90 overtime 39.64915296714574 against 39.64915296714573).
  Without a capacity channel it is `cap × capacity × weeks` again.

## Chances, fee ranges, price rises and channels (engine 1.12.0, sandbox phase 3)

Added 28 Oct 2026 (`docs/plans/sandbox-p3-brief.md`). **No existing simulated number moved.** The approved diff of the seven existing golden models is `engineVersion` and added keys only (`mode`, `chance`, `exposure` on each churn cause, `rise` on the revenue series of `northbeam-money`); `northbeam-chances` and `northbeam-channels` are new. Approved with `golden:approve "Sandbox phase 3: ..."` (`golden/versions.json`). Nothing below changes a draw on a path a model without the new fields takes: new randomness has new stream labels, and every multiplier is applied after the draw.

**Monthly channels** (`EngineModel.channels`, `channels.ts`): per-month values the engine reads while it runs, for leads, conversion, the service mix, the fee a new client pays (`newFee`), the fee every active client pays (`fee`), fee ranges, base churn, churn drivers, hands-on time, external waits, rework, role cost, overheads and capacity. `starts` are the run's month starts, so the Sandbox's months are calendar months (`simulate` throws if `monthly` and `monthStarts` disagree with them); the market keeps its 52/12-week months. `activeChannels` drops every neutral array, and a model whose channels are all neutral takes the old code path, bit for bit (a test runs every golden model with neutral channels). A wait channel on a step with no wait creates its sampler on the step's existing `wait:<id>` label, only when used; a rework channel on a step with no rework builds the redo loop from the largest rework in any month.

**Churn drivers as chances (B4).** A driver with an `effect` runs as events instead of weight x pressure. For each roster client at each weekly tick:

    weekly chance = base x churn(t) x (1 + sum over weight-mode w x p + sum over chance-mode effect x hit) x market(t) / (52/12)

`hit` is 1 while the client is under a hit (a hit at time h lasts `months` x 52/12 weeks; a hit during a hit extends it, effects never stack). An **entered** chance c (handoff, results, custom, price) draws once per tick per active client from the client's own stream `hit:<driver>:<client>`, hit if u < 1 - exp(log(1 - c) / (52/12)); c >= 1 hits every tick with no draw, c <= 0 never. A **measured** driver (late, resp, onb, rework, load) is hit by the event itself (a task finished late or missed, an ad-hoc task late, a servicing visit redone, a first delivery later than normal, a tick above 85% busy) and draws nothing. Run merging is off in any tick where a driver is in chance mode. Tenure and market have no events. A stored driver has no chance or effect (new nullable columns), so every workspace stays in weight mode; Settings pre-fills `equivalentEvents` (the chance and effect that give the same expected churn, in expectation not draw for draw). Each cause reports `mode`, `chance` (hits per active client-month, measured in both modes so Settings can show it before anyone switches) and `exposure` (share of client-weeks under the effect).

**Client value range (A5).** A service with a `priceRange` (low, high) draws each client won on it from a triangular low - price - high on the new stream `fee:<service>`, one draw per win; the engine uses min(low, price) and max(high, price). Lifetime value and lost revenue use the range's mean. Existing clients keep their entered fee; low = high = price draws nothing.

**Price rise (B5) and fees for existing clients.** The `fee` channel multiplies what every active client of a service pays from its month, existing and won; `weeklyBill` stays the base fee so nothing is counted twice with `newFee`. The part above the base fee is booked as `riseRevenue` (`ReplicationResult.revenue.rise`, `MonthlyResult.revenue.rise`). The rise's churn comes through the Price changes driver: in weight mode a rise r adds `2 x r` pressure for 13 weeks from its month (to that service's clients), in chance mode each client is hit with the driver's chance (default 1; stream `hit:price:<client>`) and its churn rises by `effect x r / 0.1` (the effect is per 10% rise) for `months`. A cut has no churn effect. With `monthly`, `SimulationResult.monthlySamples` holds each replication's own months (revenue, rise, clients lost).

**The trade-off is measured, not modelled.** The Sandbox runs the scenario (R) and the same scenario without its B5 changes and without the forced price driver (B), with the same seed, the same pinned warm-up and the same segments. Per replication i and month m: gained G = rise_R, net N = revenue_R - revenue_B, lost L = G - N, extra leavers X = lost_R - lost_B (L includes everything the rise changed besides the higher fees: the work and fees a lost client would have brought). Each is shown as a mean and 10 to 90% range, per month and over the run (summed per replication, then the stat). Break-even = mean G / (sum L / sum X); with fewer than 0.05 extra leavers the loss per leaver is estimated (fee after the rise x half the months left) and labelled. A difference under a millionth of a unit is float noise and reads 0. (`packages/db/src/sandbox/price-rise.ts`.)

**The warm-up finding, and the pinned start.** A scenario's months before a timed change used to move: the automatic warm-up (`autoWarmupHours`) runs a pilot of the whole model, the change included, and sizes the warm-up from its P90 cycle, so a hire from January shifted every arrival of October by a different warm-up (live 1002.81 h, with the hire 1007.05 h). `SimulateOptions.initialState` lets the caller hand `simulate` the start to use; the Sandbox pins one per scenario, `initialState(model with only the scenario's whole-run changes)`, for every segment, the price-rise pair and the compare columns. Goldens do not pass it (`simulate(m, ...)` deep-equals `simulate(m, ..., { initialState: initialState(m) })` for every golden model). Months before any kind of timed change equal the live run (money to the last bits: a stay's fee is spread over its months as amount / length x overlap, so a client who leaves at another time after the change has early months that differ by a rounding; tolerance 1e-12 relative, every case measured under 1e-13 in the review).

**Hiring delay (D9).** Runner only, no engine change: a D9 change delays every scenario hire (D1), whole-run hires included (from the start of the run), by round(delay x the market's Time to hire in the hire's month) months, so Time to hire is now used (only through D9). Late payments (`pay`) are still stored and unused; "pay inflation" is the role-cost channel (C1 from a month), not the market.

**Random streams.**

| Stream | Status |
|---|---|
| arrivals, mix, work, wait, rework, route, churn, servicing, wip (and their warm-up labels) | unchanged count and order on every path without the new fields; with channels the same draws, multiplied after |
| `hit:<driver>:<client>` | new; chance mode with an entered chance < 1; one draw per tick per active client |
| `hit:price:<client>` | new; at a rise with a price chance < 1 |
| `fee:<service>` | new; a ranged service, one draw per win |
| `wait:<step>` for a step with no wait | created only when a `wait` channel gives it a mean |
| `churn:client:sandbox:<change>:<i>` | new; the average clients a Sandbox B1 adds to a named roster |

**Timings** (30 replications, seed 1, one container, the parent commit `e4501cc4` against this branch, interleaved in separate processes, best of 20 per run, best of 4 to 7 runs; budget: no case more than 5% or 10 ms slower). A model without channels or chance mode takes the old paths:

| Engine case | Before (ms) | After (ms) | Change |
| --- | --- | --- | --- |
| northbeam pipeline 13w | 27 | 26 | -3.7% |
| northbeam groups+servicing 13w | 67 | 70 | +3.9% |
| northbeam named roster 13w | 39 | 41 | +4.6% |
| larkspur 26w | 79 | 68 | -13.0% |
| large 40 steps 25 people 26w | 551 | 563 | +2.1% |
| northbeam groups 24m, no monthly | 401 | 415 | +3.4% |
| northbeam groups 24m, monthly | 450 | 464 | +3.0% |
| larkspur 24m, monthly | 291 | 299 | +2.7% |
| northbeam pipeline 12m, monthly | 78 | 76 | -1.9% |
| downturn groups 24m | 296 | 294 | -0.9% |
| named roster 24m (client roster, 1.11 fixture) | 153 | 156 | +1.9% |

The Sandbox's worst case (`apps/web/test/sandbox-performance.test.ts`, seven segments at 12 months, now built from six headcount cuts and a solution going live, the levers that still splice): 473, 574, 327, 325, 384, 319, 299 ms, total 2.7 s (limit 7 s), against about 0.7 s a segment and 4.9 s recorded for phase 1 (another day's load, so not strictly comparable; the engine cases above are the controlled comparison). The margin against the 1 s limit is now about 2x rather than 1.4x. A scenario of channel and people levers is **one** run at any number of months: a channel-heavy scenario (leads in five months, step time, waiting, rework, role cost, overheads, hours, a price rise and four drivers as chances) takes 381 ms; a price rise runs as a pair, 449 and 329 ms (limit 1 s each). Chance mode on 2,000 clients per group with three drivers (12 months, 4 replications): 2.2 to 2.6 s against 1.4 to 1.5 s as weights (1.45 to 1.75 x: chance mode turns run merging off). The brief's "30 replications in 5 s" is not reachable even as weights (about 0.35 s a replication), so the test holds 4 replications under 5 s and under 2 x the weights.

Phase 4 (time by purpose, engine 1.14.0, above) counts its hands-on hours after the `work` channel.

## Profit (engine 1.11.0, sandbox phase 2)

Added 28 Oct 2026 (`docs/plans/sandbox-p2-brief.md`). 1.11.0 adds what a run earns, what its team costs and the profit left, and the monthly sales, revenue and money series the Forecast page and the Sandbox read. **No existing simulated number moved**: nothing below draws a random number or reorders an existing sum, and the approved diff for the six existing golden models is only added keys (`money`, and `engineVersion`); `northbeam-money` is new. Approved with `golden:approve "Profit first (sandbox phase 2): ..."`.

**Revenue by kind** (`ReplicationResult.revenue`, `Kpis.revenue`): total = recurring + one-off + hourly.
- *Recurring*: every active client's fee, pro rata while active in the window. With a client roster (named clients or client groups) it is the amount `bill()` already books, so recurring + one-off equals `billed` (to rounding: the two add in a different order). Without a roster the pool accrues week by week (`accruePooled`) and **includes the interim clients, which `billed` leaves out**; `billed` is kept exactly as it was (the goldens and PRD §13 define it), and the two are documented side by side.
- *One-off*: the price (× the market's) when the job is won.
- *Hourly*: a client's entered fee is its bill. An existing client (a named client's `mrr`, a client group's `fee`) bills that whatever its service's pricing, so nothing already simulated moves and nothing is counted twice. A client **won during the run** on an hourly service bills the rate (service price × the market's price factor in the month it was won) for hands-on hours: (1) post-sale pipeline steps (onboarding and so on, repeat passes included: hours worked), (2) its servicing tasks while it is active, (3) its ongoing (fallback) client hours while it is active (the shape's `parts`, not `uncovered`), and for a model without a roster (4) the ongoing hours of the roles with people on the team, for each hourly client in the pool. Selling time before the win, work for existing clients and wins in the warm-up are not billed. Only the in-window part of a job is added, so nothing is reset at the end of the warm-up. An hourly service whose clients generate no work earns 0 (`hourly[id].hours` is 0 and the Forecast says so).
- `fromNew` is the part from clients won in the run; `mrrLost` (monthly) is the fee of each client that churned, in the month of the tick that closed the week.

**Labour cost** (`labourCost`): contracted capacity × weeks on the team (`presentWeeks`) × `rateOf(p)` (the person's own cost, or the mean of their roles', the rate overtime uses). **Leave is paid**; a planned hire is paid from `from`, a leaver until `until`; role-count models are covered by the synthesised people. Overtime is separate (no premium). `kpi.labour` (pipeline labour, cost per unit) is unchanged. Null when `payHidden`, as are `overtimeCost`, `profit` and the whole `MonthlyResult.money`; revenue and `overheads` are never hidden.

**Overheads and profit**: `overheads = overheadMonthly × weeks × 12 / 52` (so 12 months of a 52-week run cost exactly 12 × the figure; calendar months vary by their working days, about 5%). Profit per replication = total revenue − labour − overtime − overheads; per month the same with that month's figures, and `money.profit[m]` is the spread of each replication's own profit. Overtime is worked out month by month (as `monthlyOut` always did), so the months' profits do not sum exactly to `kpi.profit`. `services.margin` stays recorded and unused: profit comes from the paid hours, so applying a margin as well would count the cost of delivery twice.

**Monthly series** (`MonthlyReplication` and `MonthlyResult`): opportunities, wins, losses and conversion (`ratioStat`), clients won (not one-offs) and lost, revenue by kind, `fromNew`, fees lost to churn, overtime hours, and labour (by role and person), overtime cost, overheads and profit.

**Scenario patches**: `finances.overhead_monthly` (set, multiply, add; never below 0) beside `finances.retainer`, mirrored by `private.is_scenario_patch` in migration `20270108000000_overheads.sql`, which also gives `workspaces.settings.overhead_monthly` its shape check (null, or a number from 0 to 100,000,000).

**Cost of the new work** (30 replications, seed 1, one machine, run alone, best of 3; "before" is the parent commit, "after" this branch): a few array adds per arrival, win, tick and service start, and O(people × months) in `monthlyOut`.

Measured on a shared 4-core container (another agent's tests were running: load average 2 to 15), so the numbers are noisy by about 5 to 10%. Each side's figure is the best of 15 to 40 runs of the case, before and after interleaved in separate processes, the engine bundled from the parent commit (`d19f92ff`) and from this branch. Budget (brief §7): no case more than 5% slower, or 10 ms, whichever is larger.

| Engine case (30 replications, seed 1) | Before (ms) | After (ms) | Change |
| --- | --- | --- | --- |
| northbeam pipeline 13w | 32 | 32 | -0.8% |
| northbeam groups+servicing 13w | 97 | 87 | -9.5% |
| northbeam named roster 13w | 79 | 84 | +6.5% |
| larkspur 26w | 91 | 77 | -15.0% |
| large 40 steps 25 people 26w | 633 | 619 | -2.2% |
| northbeam groups 24m, no monthly | 428 | 429 | +0.1% |
| northbeam groups 24m, monthly | 505 | 510 | +1.0% |
| larkspur 24m, monthly | 329 | 339 | +2.9% |
| northbeam pipeline 12m, monthly | 80 | 86 | +7.8% |
| downturn groups 24m | 333 | 327 | -1.8% |
| downturn named roster 24m | 309 | 315 | +1.9% |
| named roster 24m | 458 | 442 | -3.4% |

Every case is within the budget: the three that read above +5% (the named-roster 13-week run and the 12-month pipeline run with months, +5 and +6 ms, and the same cases re-measured alone at -1.9% and +2.8%) are inside the 10 ms allowance and the noise. The cases that came out faster are noise too: nothing in the change speeds a run up.

The web suite's timing tests (`apps/web/test/horizon-performance.test.ts`, best of 3 each, parent commit against this branch, same noisy machine) read the same: pipeline-only Northbeam at 24 months 266 and 266 ms (limit 1,200), full Northbeam 744 and 651 ms (limit 2,000), full Larkspur 512 and 467 ms, full Northbeam in a downturn 458 and 522 ms, and the new month-by-month cases (the Forecast's own run: calendar months, with the sales, revenue and money series) full Northbeam 691 and 719 ms, full Larkspur 430 and 453 ms (limit 2,000 each). Under heavy load (load average above 10) one case fails on the parent commit and on this branch alike; re-run alone they pass. The engine's `test:perf` passes.

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

## Sandbox scenarios: seven segments (sandbox phase 1, no engine change)

*Since engine 1.12.0 only a solution going live and a headcount cut splice; every other timed lever is a channel in one run (see above). The seven-segment case below is built from those two.*

A scenario with changes from several months runs once per distinct change month, each a full 30-replication run, and the monthly
numbers are spliced (`spliceMonthly`). The most the database allows is six capped change months, so seven runs
(`MAX_SEGMENTS`). The browser spreads them over the page's three workers and keeps finished runs by what they were run from, so a
change that leaves a segment alone does not run it again. `apps/web/test/sandbox-performance.test.ts` (tagged `perf`) builds the
worst scenario on the demo's full Northbeam (five timed patches and a solution going live in six different months, plus a hire, a leave and a leaver in
those months: seven segments), times each segment's `simulate(model, 30, 1, { monthly, monthStarts })` at 12 months one after the other
(the slowest case), and holds each under 4 × 250 ms (the full Northbeam's 250 ms, scaled for a year as the 24-month test scales it)
and the seven together under 7 s. Measured on a quiet 4-core container, engine 1.11.0:

| Run | Segments (ms) | Total | Limit |
| --- | --- | --- | --- |
| 1 | 538, 810, 761, 784, 757, 596, 737 | 4,984 ms | 7,000 ms |
| 2 | 802, 733, 583, 689, 733, 556, 710 | 4,807 ms | 7,000 ms |

Each run is about 0.7 s, inside the 1 s limit but not by a wide margin: with another process using the CPU one segment reached
1.2 s and the test failed, so re-run it alone before concluding. Spliced numbers cost about 4 ms.

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
- Seed: `larkspurBundle()` in `packages/db/src/fixtures/larkspur.ts`, in `seed.sql` beside Northbeam (slug
  `larkspur`), so it loads wherever the seed does (`pnpm --filter @transpera-flow/db migrate --seed`, and the tests). `packages/db/test/larkspur.test.ts` checks the rows resolve on 5 October 2026 to exactly
  `larkspurModel()`; `database.test.ts` checks the seeded database round-trips to the same model.
- App: `/demo/larkspur`, read-only from the fixtures, on any deployment.
- Production: not loaded. It is a test and demo agency; add it by hand only if wanted.

## Nested models (issue #102)

A step can hold its own steps: a group, or a child process. The engine flattens a nested model to leaf steps before every run
(`flattenModel` in `packages/engine/src/flatten.ts`, called by `simulate`, `runOnce` and `initialState`; a model with no groups comes back
as the same object). A nested model therefore gives exactly the numbers of the same model drawn flat, which `test/nesting.test.ts` and
`packages/db/test/nested-model.test.ts` check, and the golden models (all flat) did not move: introducing groups needed no `ENGINE_VERSION` bump.
Draw a group open or closed, or move a step into one, and no number changes; adding or removing steps still does, as before.
