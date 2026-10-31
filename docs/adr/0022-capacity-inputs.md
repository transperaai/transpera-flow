# 22. Capacity inputs: the engine's agreement with the client's calculator

Date: 31 Oct 2026 · Status: accepted · `docs/plans/capacity/p23-interface-brief.md`, `docs/plans/client-build-handover.md`, requirements sections 4, 6 and 7 (D5–D8, D13, D17, D26, D27, D32)

## Context

The client's capacity app (prototype: `docs/prototypes/client-capacity-app.PROTOTYPE.html`) needs inputs the engine doesn't have: tiers with
their own deliverables, named and counted clients together, per-client overrides, steps whose frequency follows the tier, team time, a
new starter's ramp, and steps with a work split that changes act on. P1 (database and Set up) and P2/P3 (engine behaviour) are built
apart, so they need one agreed shape and one agreed meaning before either starts.

## Decision

- **Types in `model.ts`, meanings in `capacity-inputs.ts`.** Every new field is optional; unset, the engine behaves as it did.
  at the time of this ADR `simulate.ts` and `flatten.ts` read nothing new and no golden moved. P2 (1.15.0) and P3 (1.16.0) made the engine read
  the fields and bumped the version.
- **Pure functions define each field**, so the engine and the web's derived figures (busy share, "can take", hiring advice) can't
  drift apart: `effectiveDeliverables`, `tasksPerMonth`, `rampShare`, `availableShare`, `stepParts`, `stepTimeFactor`.
- **`checkCapacityInputs(model)`** names bad inputs in plain English (`CapacityProblem`: code, path, message). It isn't wired into
  `simulate`; P2 decides where it runs.
- **Random streams don't move.** New behaviour scales a drawn time after the draw (as `capacityFactor` does) and adds tasks only from
  new streams. `stepTimeFactor` is the number to scale by, and is exactly 1 when nothing is set.
- **Engine units are working hours.** Words, links, ticket hours and tasks are labels and rates, turned into step hours outside the engine.

## The fields, and why they sit where they do

| Field | Where | Why there |
|---|---|---|
| `department`, `tier`, `deliverables`, `adhoc` | `EngineService` | A service is one tier of one department ("Organic Tier 1"). `tier` is the key both departments share; each tier has its own values. |
| `overrides`, `handHoldingHours`, `manager` | `EngineClient` | A named client's own values replace its tier's. Counted clients have none; their manager comes from `portfolio`. |
| `portfolio`, `reservedShare`, `ramp`, `tiers` | `EnginePerson` | They're about one person's hours and clients. |
| `toClientManager` | `EngineStep` | The step goes to the client's manager (D32), falling back to `role`'s pool. |
| `split`, `tierMultiplier`, `sources` | `EngineStep` | Base values keyed once and corrected over time (section 7). |
| `changes` | `EngineModel` | A change points at parts of steps and is never a new time; scenarios list changes. |
| `clientMix`, `placeNewClients` | `EngineModel` | How the two kinds of client combine, and where won clients go. |
| `unit` | `EngineRole` | Display unit for a shared team (D27). `perHour` is blank until Joe keys it (D35). Reporting only. |
| `driver` recurrence | `Recurrence` | `{ perMonth, driver, per? }`: tasks a month = `perMonth × value ÷ (per ?? 1)`. `"adhoc"` reads `chance × requests`. |

**Names used** (what P1 maps its columns to): `TierDeliverables` = `words`, `links`, `techHours`, `meetings`, `builds`, `creativeSets`,
`channels`; `ServiceAdhoc` = `{ chance, requests }`; `ClientOverrides` = the same deliverable keys plus `adhocChance`, `adhocRequests`,
`adhocHours` (hours per request) and `stepFactor` (a number, or a number per step id); `SourceLabel` = `interview | calculator |
measured | estimate`; `EngineStepChange` as in the brief, with its effects typed `StepChangeEffect`. **Differences from the brief:**
the override keys `adhoc.chance` and `adhoc.requests` are flat (`adhocChance`, `adhocRequests`) so an override stays one level deep;
`tasksPerMonth` takes `(recurrence, deliverables, adhoc)` with no `hoursPerWeek`, because a month is 52/12 weeks whatever the
working week; `rampShare` and `availableShare` take an optional third argument, the hours in a month (`52/12 × hoursPerWeek`), to
turn `from` (simulation hours) into a month; the problem type is `CapacityProblem`.

**Conventions.** Month indexes in the functions are 0-based (0 is the first month of the run); `EngineStepChange.startMonth` is 1-based
("starts in month 2"). A person's ramp starts in the month their `from` falls in; with no `from` it starts at month 0.

**Counted "taking both"** is not an engine input. It only feeds the derived "unique clients" figure; the engine already counts a
client of two services through two services.

## Per-step frequency becomes per-process frequency

The prototype puts a frequency on each step. The engine keeps frequency on the servicing link (`service → process → recurrence`), so a
step with its own driver lives in a servicing process of its own. Tiers are services, so a frequency that differs by tier (the
strategy review is a third of a month for Tier 1, a sixth for the others) is the same process linked to each tier's service with a
different recurrence. The prototype's steps group like this (see `fixtures/capacity.ts`):

| Process | Recurrence | Organic | Performance |
|---|---|---|---|
| Client meetings | `meetings` | o1, o2 | p6, p7 |
| Content, per 1,000 words | `words`, per 1000 | o3, o4, o5, o6 | |
| Links, per link | `links` | o7, o8, o9 | |
| Technical tickets | `techHours` | o10 | |
| Pacing and hygiene, per channel | `channels` | | p1, p2, p13 |
| Builds | `builds` | | p3, p4, p5 |
| Creative sets | `creativeSets` | | p12 |
| Monthly work | monthly | o11, o12 | p8 |
| Strategy review / quarterly review | every month × 1/3 or 1/6, by tier | o13 | p9 |
| Ad-hoc requests | `adhoc` | o14 | p10 |
| Tracking troubleshooting | monthly × 0.15 (Organic), 0.3 (Performance) | o15 | p11 |

Onboarding (`ob1`–`ob6`, `pb1`–`pb6`) runs once per new client and belongs to the pipeline's hand-off, not to servicing; it is not in the
fixture. Steps inside one process run in order for each task, so "per 1,000 words" means briefs, writing, editing and upload for each thousand.

## What stays out of the engine

Salary, DLER, contractor and offshore labels, the busy-share line per role, the rule of thumb, and "taking both" counts. They are
database-only and feed the derived figures. Fee is `price` and base churn is `churnMonthly`, as today; the price-rise churn rate (D36) is P7's.

## Where the prototype's calculator and the engine can't agree

The prototype is a monthly average with no queues (its own banner says so). P2/P3 and the app should expect these differences, and
the app should say which of the two a figure comes from.

1. **Queues and variance.** Busy share in the prototype is need ÷ available. The engine adds waiting, rework, lognormal spread and
   shared pools, so late and missed work and overtime appear before the average reaches 100%. Busy share from the engine is the
   truth; the calculator's is the plan.
2. **Section 7's arithmetic.** The text says "with 80% adoption the step is about 23 min". By the formula the handover and the brief give
   (`a × (1 − remove × ad) + residual × ad`) 23.35 min is the result at **full** adoption (38.5 → 6.85, plus 11 and 5.5); at 80% it is 29.68.
   The functions follow the formula, and the tests assert both numbers. The "about 32 min saved, 7.5 h for 14 clients" figures are the full-adoption ones
   (31.65 min, 7.4 h).
3. **Month length.** The capacity functions use 52/12 weeks; `tasksPerWeek` in `servicing.ts` and the churn tick use 4.33. Tasks
   differ by 0.08%. A driver recurrence gives 0 from `tasksPerWeek` (it needs deliverables); P2 resolves it with `tasksPerMonth`.
4. **Speed.** The prototype divides a person's need by `speed`; the engine multiplies a drawn time by `capacityFactor`. The fixture uses 1 ÷ speed.
   Shared teams: the prototype pools a team's hours weighted by speed; the engine queues each task for people, so a team reads busier when uneven.
5. **Leave.** The prototype takes one 8% off everyone; the engine takes leave windows per person. The fixture sets none.
6. **Starters.** The prototype's ramp steps by whole months from a month index; the engine's `from` is in hours, so a start part-way through a month counts from that month.
7. **Ad hoc.** The prototype uses the expected value (`chance × requests`). The engine draws Bernoulli(chance) a month, then that many requests, so a month varies; the
   mean agrees. A client's `adhocHours` replaces the step's time before the split is applied; the prototype scales the minutes after the changes, so the two agree only when no change with a residual applies to the step (a residual is a fixed time, not scaled).
8. **Time reserved for the pipeline.** `availabilityFloor` (8% of a person's time kept for pipeline work) is a separate engine rule and isn't `reservedShare`.
9. **Tier fallback.** The prototype uses the last tier's values for an unknown tier; the engine has no tier fallback, and a service with no `deliverables` makes no driver tasks (the check names it).
10. **Onboarding load** is in the prototype's busy share and, in the engine, is the pipeline's own work after a win.

## Engine 1.16.0 (P3): what the run reads, and what the changes free

`docs/plans/capacity/p3-engine-changes-brief.md`; the full account is in `docs/engine-versioning.md`.

- **What P3 reads.** `EngineStep.split`, `EngineStep.tierMultiplier` and `EngineModel.changes`. Each drawn hands-on time is multiplied, after the
  draw, by `stepTimeFactor`: the tier multiplier of the task's service tier, the split with the changes in force in the month the work starts
  in, and the client's own `stepFactor` (inside the factor, so applied once). `adhocHours` replaces the base time before the split (note 7). Pipeline
  work and work with no client uses no tier (multiplier 1) and no client factor; its split and unfiltered changes still act. With none of the fields
  set the factor is exactly 1 and the path is skipped. A split with no change in force gives exactly 1 too (the engine uses the base time, not the
  sum of the three shares, which can differ in the last digit).
- **Months.** The model's channel months when it has channels, else the calendar months of a monthly run, else 52/12 weeks; the warm-up is month 1.
- **Hours freed.** For a draw `d` of a step, `PersonTime.partHours.before` is the same draw split by the base split (tier multiplier kept, no change),
  `partHours.actual` is after the changes, and hours freed is `before − actual`, exactly, by person, by step and in total. `freed.byChange` credits each
  change. **Ordering rule: changes act in the order of the model's `changes` list, and a change's effects in their order; a change is credited with what
  it takes off a part given the changes before it have already acted.** So the savings add up to the total, and when two changes act on one part the
  earlier one in the list is credited first (an automation with checking time listed first saves more than the same one listed after another that
  already took most of the part). A change can free a negative number of hours (its checking time above the time it removes). The monthly series
  carries the same figures by month.
- **Bad inputs.** The run repairs what `checkCapacityInputs` names rather than throw: a bad split is no split (all manual), adoption is held to 0-1, a
  start month below 1 is 1 (not a number: never starts), a bad ramp is none, `remove` is held to 0-1, a bad residual is 0, a speed-up below 1 is 1.
- **Not done: changes to rework or waiting.** Section 7's optional "also changes rework or waiting" is later; changes act on hands-on time only, and
  rework, waits and routing are as before.
- **Added to `capacity-inputs.ts`:** `stepPartsDetail`, `StepFreed` and `StepPartsDetail`, which `stepParts` now shares a loop with (its numbers are
  unchanged). `stepParts` and `stepTimeFactor` are otherwise as defined. `plannedHours` (the busy share used to place a won client) still uses the
  step's plain `work` × the client's factor and does not yet include the tier multiplier or the split's changes.

## Consequences

- P1 maps columns to these names and stores `TierDeliverables`, overrides and the like as it likes; it never needs the engine to run.
- P2 makes the engine read them and promotes `capacityModel()` to a golden. P3 does the same for splits and changes and applies `stepTimeFactor` after each draw.
- If a name changes, change it here and in `model.ts` together, and tell P1.
