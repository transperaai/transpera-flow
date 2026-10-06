# C2 part 2 build brief: churn, servicing checks, per-person times (#41)

Scoped 6 Oct 2026 against `main` at f2ef84f (part 1 merged as #192, a42b0e9; migration `20261202000000`, row 50,
applied). Read `docs/plans/builder-brief.md` first. This brief adds to it and wins where they differ. Follow it strictly.
If something here is unclear or doesn't match the code, **ask; don't guess.**

## The short version

Part 1 (Settings → Historical data) reads a step log for one process and proposes step values, branch odds and leads a
week. Part 2 adds a second, workspace-wide input: a **clients file** and a **servicing log**. From them it:

- **proposes each client group's normal churn**, back-solved so that today's simulated churn (normal churn × driver
  pressure) matches the churn measured in the clients file;
- **shows three checks** beside the simulated values: the share of servicing work done late or missed, the response
  time to ad-hoc requests and the onboarding speed. They are never applied.

Per-person times (capacity factors) need things the app doesn't have yet (see Q1), so they are a separate slice.

| Slice | What | Migration | Engine | Status |
|---|---|---|---|---|
| **C2 (2a)** | Pure estimators and back-solve in the engine; the two file parsers in `packages/db`; unit tests. No UI, no DB | none | new pure module, **no `ENGINE_VERSION` bump** | **Build now** |
| **C2 (2b)** | Migration, record and apply, the Historical data section, demo, history on Churn drivers, DB and PostgREST tests | `20261208000000_client_calibration` | none | Build after 2a merges |
| **C2 (2c)** | Per-person capacity factors | version from the orchestrator | yes (`--bump`, goldens don't move) | **Blocked on Q1** |

Each slice is its own branch and PR (`claude/c2-2a-churn-engine`, `claude/c2-2b-churn-calibration`). 2a and 2b close
nothing. If Austin takes Q1's default (split per-person times out into a new ticket), **2b closes #41** with
`Closes #41`. Otherwise 2c does.

---

## Decisions (verbatim)

**Austin, 6 Oct 2026 (#41, comment 6005455093):**
> Austin's answers on 6 Oct: he agrees with every recommendation.
>
> 1. **Churn per service:** back-solve it, so today's simulated churn (normal churn × driver pressure) matches the measured figure.
> 2. **Measured drivers:** (a). Historical late share, response time and onboarding speed show **beside** the simulated values as a check. They don't replace them.
> 3. **Inputs:** a clients CSV (`client, service, started, ended`) and a servicing log (`task, client, due, done`). Client ids are used for counting only and never stored (D27).
> 4. **Per-person times:** calibration proposes capacity factors only when the workspace has per-person times switched on.
> 5. **Late payments:** left out of the market baseline until the engine has a cash model.

The reasoning behind 1, from the question Austin answered (#41, comment 5993726054):
> Should it be back-solved, so that today's simulated churn (normal churn × driver pressure) matches the measured
> figure? *I recommend back-solving.* Otherwise the drivers count today's late work twice.

**#41 acceptance criteria** (the ones part 2 owns):
> - [ ] Each proposed parameter type is computed correctly from fixture datasets (tests)
> - [ ] The diff view shows current, proposed and sample size, and supports selective apply
> - [ ] Applied values are `measured`, with `dataset_id` in provenance
> - [ ] Parameters with too small a sample are flagged and not proposed
> - [ ] The robustness check excludes or narrows measured parameters (test)
> - [ ] Applied values update the measured churn drivers and the market baseline (test)

**PRD D27:** "Clients are modelled as **client groups** per service: number, fee, normal churn, typical stay, starting
health." **PRD D20:** "capacity factor off by default, shown only when measured, visible to the person, never ranked."
**PRD §6.3.7:** capacity factor "minimum sample size: 10 completed items for that person-step".

---

## Audit: what the code does today

**Churn** (`packages/engine/src/churn-drivers.ts`, engine 1.6.0, `docs/engine-versioning.md` "Churn drivers"). A roster
client's weekly chance of leaving (`driveClient` in `simulate.ts`, around line 1534) is

    weekly = base × a × b ÷ 4.33,   a = 1 + Σ weight × pressure (switched-on drivers except the market),
                                     b = 1 + market weight × (churn factor − 1)

and is clamped to 0..1 as a hazard. `base` is `clientChurnMonthly` (`clients.ts`): for a client group, the group's
`churn_monthly` (`withClientGroups` overwrites the service's `churnMonthly` with it). Each week's hazard is split for
blame: normal churn gets `hazard ÷ (a + marketPart)`, each driver `hazard × term ÷ (a + marketPart)`. The run reports
`result.churnCauses.byService[serviceId] = { clients, shares: { normal, late, resp, … } }` (`summariseChurn`), keyed by a
client's first service (`svcKey`; a group client has exactly one).

**So with the market removed (b = 1) and no clamping, `1 / byService[s].shares.normal` is exactly the base-weighted mean
of `a` over the service's client-weeks: today's driver pressure multiplier.** That is what the back-solve divides by.

**Measured driver values** (`churnOut` in `simulate.ts`, around line 2591), reported for every driver, on or off, in
`churnCauses.causes[i].value`:
- `late`: (late + missed) ÷ all servicing touchpoints. A task is on time if done by `due = created + sla`; missed if not
  done by `created + 2 × sla`.
- `resp`: mean working hours from an **ad-hoc** task's creation to it being done (finished tasks only).
- `onb`: mean working days from a client **won in the run** to its first servicing task done (`hours ÷ (hoursPerWeek ÷ 5)`).
- All three are `null` without servicing processes.

**What "SLA" means in the current model.** Two different things:
1. `service_servicing.sla_hours` (default 40): working hours from a servicing task being created to it being due; not
   done within twice that, it is missed. Late and missed tasks cost health, and health is the `late` driver's pressure.
   **The servicing log is about this one.**
2. `steps.sla_hours` (rule 7, "SLA missed": time at a step over its SLA). Not touched by part 2.

An SLA is a promise, not a measurement, so **part 2 proposes no SLA value**. "Servicing SLA performance" (PRD §6.6) is
the late-or-missed share, shown as a check (decision 2). See Q6.

**Where normal churn lives.** `client_groups.churn_monthly` (0..1, per service, one row per service, `stamp_provenance`
on `client_count, fee, churn_monthly, stay_months, starting_health`, `company_needs_review` refuses API tokens, audited).
`services.churn_monthly_base` is used only for services simulated from named clients. **Part 2 writes only
`client_groups.churn_monthly`** (Q2).

**Robustness** (`estimatedParameters`, `robustness.ts`) perturbs `demand.churn_monthly` (pooled model only) and each
service's `churn_health_sensitivity`, but **never a group's normal churn**. So a measured normal churn needs no
robustness change. Sensitivity stays perturbed: it is still an estimate.

**Market baseline.** The market's "clients leaving" factor multiplies the base, so an applied normal churn becomes the
Stable (100%) level with no change. Late payments are stored in the market schedule and change nothing in the engine
(`docs/engine-versioning.md` "Market conditions"). Decision 5: nothing to build.

**Which process runs a service.** `engineServices` (`packages/db/src/model.ts`) puts a service in a process's model when
`entry_process_id` is that process **or null**; `engineClientGroups` then simulates that service's group there. The
Churn drivers settings section simulates `toEngineModel(loadLiveProcess(slug))`: the default top-level live process.

**Part 1's database side** (`20261202000000_calibration.sql`): `datasets.kind` is checked to
`('step_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices')`. `record_calibration` always inserts `'step_log'` and
needs a process. `apply_calibration(uuid, text[])` handles kinds `arrivals` (lead_sources, live) and `work`, `wait`,
`rework`, `routing` (steps, into the draft); anything else is `not_proposed`. The trigger
`private.calibrations_before_write` freezes proposals and lets `applied_keys` grow only inside `apply_calibration`.
`private.calibration_payload_problem(kind, set, before)` validates each kind. No later migration redefines them.

**Per-person times today: none of it exists.** `workspaces.settings.capacity_factor_enabled` is only a key in the
suggestions allow-list (`packages/db/src/suggestions.ts`, `company.ts`); no screen sets it and `toEngineModel` doesn't
read it. `EnginePerson` has no capacity factor and the engine never divides work time by one. `person_skills.efficiency`
exists but is unused, and **a `person_skills` row restricts the person to the listed steps** ("A person with no rows here
can do every step of their roles"), so storing a factor there would change who can do what. Hence Q1.

**Surprises worth knowing:**
- Measured churn can't be applied as is: the run multiplies it by today's pressure, so late work would count twice.
  Austin chose back-solving for exactly this reason.
- A clients file of **current clients only** has no leavers, so it can't measure churn. The page must say so.
- The servicing log has no "requested" column, so response time has to infer when a request came in (`due − sla`).
  An optional `requested` column fixes that (Q4).
- Capacity factors are a whole feature (switch, engine, storage, privacy), not a calibration detail (Q1).

---

## C2 (2a): estimators and back-solve (engine and parsers, no UI, no DB)

Branch `claude/c2-2a-churn-engine` from `main`. **No migration. No `ENGINE_VERSION` bump.** The new engine module only
reads `simulate`'s output; `simulate.ts`, `churn-drivers.ts` and `clients.ts` are **not edited**. If you find you need to
change them, stop and ask. The golden tests must pass untouched.

### 1. Clients file and servicing log parsers: `packages/db/src/client-calibration.ts`

New file, exported through the existing `./calibration` entry: add `export * from "./client-calibration";` at the end of
`packages/db/src/calibration.ts`. Reuse `splitCsv`, `detectDateOrder`, `parseLogTime`, `decodeLogFile` from
`calibration.ts`. Copy `parseStepLog`'s shape exactly: header matching via the same `normHeader`, `missing`, `errors`
by 1-based line, `lines`, `dateOrder`, `dateProblem`, and a `dateOrder` option. Times without a zone are UTC.

**Clients file.** One row per client per service.

| Column | Required | Headers (after normalising) |
|---|---|---|
| `client` | yes | client, client id, client name, customer, customer id, account, account id, company |
| `service` | yes | service, service name, product, plan, package, engagement |
| `started` | yes (cell too) | started, start, start date, signed, signed on, won, won on, since, joined |
| `ended` | no (blank = still a client) | ended, end, end date, left, left on, cancelled, canceled, churned, churned on, lost on |

```ts
export type ClientsColumn = "client" | "service" | "started" | "ended";
export const CLIENTS_COLUMNS, REQUIRED_CLIENTS_COLUMNS, CLIENTS_HEADERS, CLIENTS_TEMPLATE;
export interface ParsedClients { rows: ClientRow[]; columns; missing; errors; lines; dateOrder; dateProblem }
export function parseClientsFile(text: string, options?: { dateOrder?: DateOrder }): ParsedClients;
```

Row errors: empty client or service; unreadable `started`; unreadable non-blank `ended`; `ended` before `started`.
`ClientRow` (engine type, below) is `{ client, service, started, ended }`.

**Servicing log.** One row per servicing task.

| Column | Required | Headers |
|---|---|---|
| `task` | yes | task, task name, deliverable, activity, type, job, servicing |
| `client` | yes | the clients file's `client` headers |
| `due` | yes (cell too) | due, due date, due on, deadline, due by |
| `done` | no (blank = not done) | done, done on, completed, completed on, completed at, finished, delivered, delivered on, closed, closed on |
| `requested` | no (optional column, Q4) | requested, requested on, requested at, created, created at, created on, opened, raised, received |

```ts
export type ServicingLogColumn = "task" | "client" | "due" | "done" | "requested";
export const SERVICING_LOG_COLUMNS, REQUIRED_SERVICING_LOG_COLUMNS, SERVICING_LOG_HEADERS, SERVICING_LOG_TEMPLATE;
export interface ParsedServicingLog { rows: ServicingRow[]; columns; missing; errors; lines; dateOrder; dateProblem }
export function parseServicingLog(text: string, options?: { dateOrder?: DateOrder }): ParsedServicingLog;
```

- **A `due` with no time of day is the end of that day** (`t + 86_400_000 − 1`), so work done any time on its due day
  is on time. Decide "no time of day" with the same two regexes `parseLogTime` uses (group 4 absent). Export a small
  helper `hasTimeOfDay(text)` from `calibration.ts` rather than copying the regexes.
- `done` before `requested` is a row error. `done` before `due` is fine (early).
- Both files: at most `MAX_STEP_LOG_ROWS` (200,000) rows, as part 1.
- Templates: 4–6 lines each, like `STEP_LOG_TEMPLATE`, using Northbeam's service and servicing process names (take the exact names from the seed, `packages/db/src/fixtures/`).

**Stored rows to the engine's input** (same file), copying `calibrationInput`'s style:

```ts
export interface ClientCalibrationRows {
  services: ServiceRow[];               // the workspace's services
  clientGroups: ClientGroupRow[];       // with provenance
  servicing: ServiceServicingRow[];     // links, with sla_hours and recurrence
  processes: { id: string; name: string; kind: string }[];  // to name servicing processes
  hoursPerWeek: number;
}
export function clientCalibrationServices(stored): ChurnServiceInput[];
export function servicingLinks(stored): ServicingLinkInput[];
```

`ChurnServiceInput.group.source` uses `columnSource(group.provenance, "churn_monthly")`. Only **active** services.
`ServicingLinkInput.adhoc` is true when `engineRecurrence(link.recurrence)` has `poissonPerMonth`.

### 2. Estimators: `packages/engine/src/client-calibration.ts`

New file, exported from `packages/engine/src/index.ts`. Pure and deterministic except `backSolveChurn`, which calls
`simulate` (itself deterministic). No `Math.log`/`Math.exp` anywhere (`det-math.ts` if ever needed; nothing below needs
it). Header comment in the style of `calibration.ts`: what it measures, the formulas below, and that client ids are
used only to count and join and never leave this module (D27).

```ts
export const CHURN_WINDOW_WEEKS = 52;     // churn is measured over the last 52 weeks before asOf
export const CHURN_MIN_WEEKS = 13;        // ... and needs at least 13 weeks of it
export const CHURN_MIN_LEAVERS = 3;       // ... and at least 3 leavers
// minSample: CALIBRATION_MIN_SAMPLE (10) clients, tasks, requests or new clients, as part 1.
export const CHURN_BACKSOLVE_SEED = 1;
export const CHURN_BACKSOLVE_REPS = 30;
export const CHURN_BACKSOLVE_MAX_RUNS = 3; // after run 0 (today's model)
export const CHURN_BACKSOLVE_TOLERANCE = 0.0005; // absolute, on a monthly share

export interface ClientRow { client: string; service: string; started: number; ended: number | null }
export interface ServicingRow { task: string; client: string; due: number; done: number | null; requested: number | null }
export interface ChurnServiceInput {
  serviceId: string; name: string; pricingModel: "retainer" | "one_off" | "hourly";
  group: { id: string; churnMonthly: number; count: number; source: CalibrationValueSource } | null;
}
export interface ServicingLinkInput { serviceId: string; processId: string; processName: string; slaHours: number; adhoc: boolean }
```

Use `LOAD_WEEKS_PER_MONTH` (4.33, from `clients.ts`) for every weeks-to-months conversion, as the engine's weekly
churn tick does. `WEEK_MS` as in `calibration.ts`.

#### 2.1 `measureChurn`

```ts
export interface MeasuredChurn {
  serviceId: string; name: string;
  clients: number;        // distinct clients with exposure in the window
  leavers: number;        // spells that ended inside the window
  clientMonths: number;   // exposure
  activeAtAsOf: number;   // distinct clients with a spell covering asOf (shown beside the group's count)
  monthly: number | null; // leavers ÷ clientMonths, null when blocked
  enough: boolean; blocked: string | null; note: string;
}
export function measureChurn(input: {
  rows: readonly ClientRow[]; services: readonly ChurnServiceInput[]; asOf: number; minSample?: number;
}): { services: MeasuredChurn[]; window: { from: number; to: number; weeks: number } | null;
     unmatchedServices: { name: string; rows: number }[]; startsAfterAsOf: number; rows: number; clients: number };
```

1. Match `service` to services by name with part 1's `norm` (case and spacing ignored; a name two services share
   matches neither). Unmatched names are listed with row counts (the page stores counts only).
2. Drop rows with `started > asOf` (count them in `startsAfterAsOf`). An `ended > asOf` is treated as still a client.
3. **Spells.** Per (client, service): sort by `started`; merge spells that overlap or touch (`next.started ≤
   current.ended`, or current has no end); a gap keeps them separate, and the earlier spell's end is a leave.
4. **Window.** `W1 = asOf`. `W0 = max(asOf − 52 weeks, earliest started among the file's matched rows)`. `weeks =
   (W1 − W0) ÷ WEEK_MS`.
5. **Exposure.** Per spell: `max(0, min(ended ?? W1, W1) − max(started, W0))`, in weeks; `clientMonths = Σ ÷ 4.33`.
6. **Leavers.** Spells with `ended` in `(W0, W1]`. A client who moves from one service to another counts as a leaver of
   the first: that is churn for that service.
7. `monthly = leavers ÷ clientMonths`. This is the constant-hazard rate that the engine's weekly tick (`monthly ÷ 4.33`
   per client-week) reproduces.
8. **Blocked (nothing proposed)**, in this order, with these words:
   - `one_off` service: "One-off work ends by design, so churn isn't measured for it."
   - `weeks < 13`: "The file covers {w} weeks; at least 13 are needed."
   - `clients < minSample`: "Too few to measure: {n} of the {min} clients needed."
   - `leavers < 3`: "Only {k} client(s) left in the period; at least 3 are needed. A file of current clients only can't
     show churn: include the clients who left, with the date they left."
   - `monthly > 1`: "More than every client leaving each month: check the dates."
9. `note`: "{leavers} of {clients} clients left over {weeks} weeks ({monthly as %} a month). {activeAtAsOf} are clients
   on {asOf date}{, and Client groups counts {count} | }."

#### 2.2 `servicingChecks`

```ts
export type ServicingCheckId = "late" | "resp" | "onb";
export interface ServicingCheck {
  id: ServicingCheckId; n: number; value: number | null; // share 0-1 | working hours | working days
  enough: boolean; blocked: string | null; note: string;
}
export function servicingChecks(input: {
  log: readonly ServicingRow[]; clients: readonly ClientRow[] | null;
  links: readonly ServicingLinkInput[]; services: readonly ChurnServiceInput[];
  hoursPerWeek: number; asOf: number; minSample?: number;
}): { checks: ServicingCheck[]; unmatchedTasks: { name: string; rows: number }[]; tasks: number;
     window: { from: number; to: number; weeks: number } | null };
```

Calendar time becomes working time as part 1 does: `ms ÷ WEEK_MS × hoursPerWeek` hours; working days are `weeks × 5`
(the engine's `hours ÷ (hoursPerWeek ÷ 5)`).

- **`late`** (late or missed share). Tasks with `due ≤ asOf`. Bad when `done` is null or `done > due`. `value = bad ÷ n`.
  Needs no task matching. Same definition as the engine's `late` value: late and missed together.
- **`resp`** (response to ad-hoc requests, working hours). A row is an ad-hoc request when its `task` matches (by `norm`)
  the name of a servicing process linked **ad hoc** (Poisson) to a service the client takes. Which services a client
  takes comes from the clients file. Without the clients file, use any ad-hoc link to that process. Only rows with
  `done`. Response = `done − requested` when the column is there; otherwise `(done − due)` in working hours **plus that
  link's `slaHours`** (the engine creates a task `sla` hours before it is due). If several matching links have different
  SLAs, use the smallest and say so in the note. `value` = mean. Blocked: "No servicing work is set to come in as ad-hoc
  requests." when no ad-hoc link exists.
- **`onb`** (onboarding speed, working days). Needs both files; without the clients file it is blocked with "Needs the
  clients file too." The log starts at `L0 = min over rows of (requested ?? due)`. A new client is a spell with `L0 ≤
  started ≤ asOf`. Its speed is from `started` to the earliest `done` of that client's rows. Clients with nothing done
  yet are left out and counted in the note. `value` = mean.
- Each: `enough = n ≥ minSample`; below it `value = null` and `blocked = "Too few to measure: {n} of the {min} needed."`.
- Unmatched task names (no servicing process of that name) are listed with row counts. They still count for `late`.
- A client id in the log that isn't in the clients file is fine. It counts for `late` and is left out of `onb`.

#### 2.3 `churnMultipliers` and `backSolveChurn`

```ts
/** Today's driver pressure on each service's churn: 1 ÷ its normal share, from a run of a model with no market. */
export function churnMultipliers(result: SimulationResult): Record<string, number>;
```

For each `sid` in `result.churnCauses?.byService` with `clients > 0` and `shares.normal > 0`: `1 / shares.normal`.
Others are absent (the service's clients weren't simulated, or none could leave).

```ts
export interface BackSolvedChurn {
  /** Proposed normal churn per service id (rounded to 4 places). Absent: couldn't be solved (see `why`). */
  bases: Record<string, number>;
  /** The multiplier the proposal was divided by (from the last run). */
  multipliers: Record<string, number>;
  why: Record<string, string>;
  runs: number;            // including run 0
  converged: boolean;
  /** Today's simulated values of the three checks, from run 0 (null: the run measures none). */
  simulated: { late: number | null; resp: number | null; onb: number | null };
  engineVersion: string; seed: number; reps: number; horizonWeeks: number;
}
export function backSolveChurn(
  model: EngineModel,
  measured: Readonly<Record<string, number>>, // service id → measured monthly churn (> 0), only enough ones
  options?: { reps?: number; seed?: number; onRun?: (run: number) => void },
): BackSolvedChurn;
```

**The run.** `today = { ...model, market: undefined, churnDrivers: drivers with "price" set enabled: false }`. The
market is taken out because the history *is* today's market (Stable = 100%, A57). A planned price rise is taken out
because it hasn't happened. Every other driver stays at its weight: entered pressures (results, handoff, your own) are
part of today. Everything else (horizon, people, servicing) is the model as loaded. Build a **new** `churnDrivers` array
(`resolveChurnDrivers` caches per model object; never mutate the input). `simulate(today, reps = 30, seed = 1)`.

**The loop.** Only services in `measured` whose `today.clientGroups?.[sid]` exists with `count ≥ 1` are solved. Others
get `why[sid] = "No clients of this service are simulated here. Count them in Settings → Client groups first."`.

```
run 0: simulate(today)                              → simulated (from churnCauses.causes values), M0 = churnMultipliers
b[s] = M0[s] defined ? m[s] / M0[s] : m[s]          (a group at 0% churn has no M0: start from the measured figure)
for r = 1 .. 3:
  simulate(today with clientGroups[s].churnMonthly = b[s] for every solved s)   → M
  b'[s] = m[s] / M[s]   (M missing → why[s] = "Its clients couldn't leave in the simulation.", drop s)
  if max |b'[s] − b[s]| < 0.0005: b = b', converged = true, stop
  b = b'
bases[s] = round(b[s], 4)
```

Services are solved together because they share people (one service's load moves another's pressure). At most four
runs: about 1–1.5 s in a worker for seeded Northbeam. `onRun(r)` lets the page show progress.

**Why it works.** With the market out, `M = Σ base·a ÷ Σ base` over the service's client-weeks, so `b × M` is the churn
the run gives at base `b`. `a ≥ 1` always (every pressure is ≥ 0), so `M ≥ 1` and **the proposal is never above the
measured churn**. `M` depends a little on `b` (fewer clients, less load), hence the few iterations.

**Edge cases (each needs a test):**
- **Pressure at zero** (drivers off, or health 100 and nothing else on): `M = 1`, proposal = measured.
- **Zero measured churn**: never reaches here (blocked by the 3-leaver rule). The function throws on `m ≤ 0` or `m > 1`.
- **Current normal churn 0%**: run 0 has no `M0` for it; it starts from the measured figure and solves normally.
- **Few clients**: blocked by `measureChurn` (under 10). A group whose *simulated* count is 0: `why` as above.
- **Pressure capped**: each driver's pressure is capped in the engine (resp, rework, load, onb at 1); `late` is
  `sensitivity × (100 − health) ÷ 100`, up to 3 at the default sensitivity. Nothing to do here; but when `M > 2` the
  proposal's note adds: "Today's drivers more than double this service's churn, so normal churn is under half of what
  was measured. Check the driver weights."
- **Hazard clamp** (weekly chance ≥ 1, i.e. monthly × a ≥ 4.33): the blame split still sums to the hazard; `M` is then
  understated. It can't happen with `m ≤ 1` and `M ≤ ~4`; don't special-case it.
- **Not converged after 3**: propose the last `b` and add to the note "approximate: the simulation moved a little
  between runs."
- **Named clients only** (no group for the service): not solved (Q2).
- **Determinism**: same model, same measured figures → deep-equal output, on any machine (simulate is deterministic;
  `browser-determinism.test.ts` covers Node vs browser).

#### 2.4 `churnProposals`

```ts
export function churnProposals(services: readonly ChurnServiceInput[], measured: readonly MeasuredChurn[],
  solved: BackSolvedChurn | null): CalibrationProposal[];
```

Extend the part 1 types in `calibration.ts` (additive): `CalibrationKind` gains `"churn"`;
`CalibrationProposal.target.table` gains `"client_groups"`; add optional fields `measured?: number | null`,
`multiplier?: number | null`, `leavers?: number`. One proposal per active, non-`one_off` service that has a client group
or appears in the file:

- `key: "churn:<clientGroupId>"`, `kind: "churn"`, `target: { table: "client_groups", id: group.id }`, `subject` = the
  service name, `n` = clients, `leavers`, `currentSource` = group.source, `current` = group.churnMonthly, `measured`,
  `multiplier`, `proposed` = bases[sid] or null.
- `enough` = measured.enough and solved; `blocked` = measured.blocked ?? why[sid] ?? null.
- `changed` = proposed !== round(current, 4). `set = { churn_monthly: proposed }`, `before = { churn_monthly: current }`
  when proposed, else both null.
- A service with no client group at all: no target, so **no proposal object**; list it in the result's
  `noGroup: string[]` (service names from the model) for the page to say "Add a client group for {service} to calibrate
  its churn."
- `note`: measured's note, then "Today's drivers add {(M − 1) as %} to it, so normal churn is {proposed as %}: {proposed}
  × {M} gives the {measured} measured." When `M = 1`: "No driver adds churn today, so normal churn is the measured churn."

### 3. Tests (2a)

- **New `packages/engine/test/client-calibration.test.ts`** (copy `calibration.test.ts`'s fixtures style: small
  hand-built inputs, then Northbeam):
  - `measureChurn`: a 20-client fixture where you can compute exposure, leavers and the monthly rate by hand (write the
    arithmetic in a comment); clients before the window counted from `W0`; a spell ending after `asOf` is not a leaver;
    overlapping spells merge, a gap makes two spells and a leave; starts after `asOf` are dropped and counted; each
    blocked reason (one-off, under 13 weeks, under 10 clients, under 3 leavers, over 100%); unmatched names counted;
    row order doesn't change the result.
  - `servicingChecks`: late share with a date-only due (done 17:00 that day is on time); an open task past due counts
    as bad; a task not yet due is left out; response time with `requested` and inferred from `due − sla`; only ad-hoc
    links count, by the client's service; onboarding with both files, without the clients file (blocked), clients with
    nothing done left out; under 10 flagged with no value.
  - `churnMultipliers`: 1 for every service with all drivers off (`northbeamWithClientGroups()` with every driver switched
    off); above 1 with the defaults (late on).
  - `backSolveChurn` on `northbeamWithClientGroups()` (servicing, late on): proposal below measured; **simulating at the
    proposed bases gives `b × M` within 2% of the measured figure for each service**; deep-equal on a second call;
    drivers off → proposal = measured; a downturn market on the input and a planned price rise give the **same**
    proposal as without them; a group set to 0% churn still solves; a group with `count: 0` is in `why`; throws on
    `m ≤ 0` and `m > 1`.
  - **Market baseline:** after applying the proposed bases, `simulate(withMarketCondition(m, MARKET_PRESETS.stable.factors))`
    equals `simulate(m)` exactly (calibrated churn is the Stable level). Add a comment that late payments are untouched
    by design (decision 5).
  - **Robustness:** `estimatedParameters` on the calibrated model lists no parameter for a group's normal churn (none
    existed before either) and still lists `churn_health_sensitivity` (still an estimate). This is the acceptance
    criterion's test for churn.
  - `churnProposals`: keys, `changed`, `set`/`before`, blocked reasons, `noGroup`, the `M > 2` note.
- **New `packages/db/test/client-calibration-log.test.ts`** (copy `calibration-log.test.ts`): headers by common names;
  missing required columns read nothing; bad rows by line; day/month order from the whole file and asked when ambiguous;
  date-only due is end of day; both templates read cleanly; `clientCalibrationServices` and `servicingLinks` on the
  Northbeam seed rows (groups, sources, ad-hoc links).

### Done (2a)

`pnpm lint && pnpm typecheck && pnpm test` green; golden tests untouched and green; no change under `packages/engine/golden/`;
`ENGINE_VERSION` still `1.6.0`. PR body: what the module computes, the back-solve formula, and "no engine numbers move".

---

## C2 (2b): record, apply and the page

Branch `claude/c2-2b-churn-calibration` from `main` after 2a merges. Migration version **`20261208000000`**, name
`client_calibration`. (B1 1/3 uses `20261206000000`; B10 part 2 may use `20261207000000`. This one doesn't depend on
either. If it is applied before them, they must be renumbered above it: tell the orchestrator.)

### Migration `packages/db/supabase/migrations/20261208000000_client_calibration.sql`

Additive. It widens one check and replaces two of row 50's functions with full copies that add one branch each (the
same rule as `save_fields`: copy the **latest** definition, from `20261202000000_calibration.sql`, and mark the added
lines `-- C2 part 2`). It does **not** touch `save_fields`, `record_calibration` or the trigger.

1. **Widen `datasets.kind`:**
   ```sql
   alter table public.datasets drop constraint datasets_kind,
     add constraint datasets_kind check (kind in ('step_log', 'clients', 'servicing_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices'));
   ```
   (Precedent: `suggestions_target_table` in `20261021000000_roles_and_workspaces.sql`, `sources_kind` in row 48.)
2. **`create or replace function private.calibration_payload_problem(kind text, setv jsonb, beforev jsonb)`**: the full
   row 50 body plus, before the final `return null`:
   ```sql
   if kind = 'churn' then
     if (case when jsonb_typeof(setv -> 'churn_monthly') = 'number' then (setv ->> 'churn_monthly')::numeric not between 0 and 1 else true end) then
       return 'churn_monthly is not a share from 0 to 1';
     end if;
     if coalesce(jsonb_typeof(beforev -> 'churn_monthly'), 'null') not in ('number', 'null') then
       return 'the earlier churn_monthly is not a number';
     end if;
     return null;
   end if;
   ```
   Keep its `revoke`/`grant` lines as row 50 has them.
3. **`create or replace function public.apply_calibration(p_calibration uuid, p_keys text[])`**: the full row 50 body,
   plus a `cg public.client_groups;` declaration and this branch **right after the `arrivals` branch** (before the
   `if pkind not in ('work', …)` line), modelled on it:
   ```sql
   -- C2 part 2: a client group's normal churn, back-solved from a clients file: live, as a person's edit to the group.
   if pkind = 'churn' and prop -> 'target' ->> 'table' = 'client_groups' then
     select * into cg from public.client_groups g where g.id = target_id and g.workspace_id = cal.workspace_id for update;
     if cg.id is null then  -> 'not_found'; continue
     if cg.churn_monthly is distinct from (beforev ->> 'churn_monthly')::numeric then -> 'changed'; continue
     entry := stamp || jsonb_strip_nulls(jsonb_build_object(
       'n', prop -> 'n',
       'leavers', case when jsonb_typeof(prop -> 'leavers') = 'number' then prop -> 'leavers' end,
       'measured', case when jsonb_typeof(prop -> 'measured') = 'number' then prop -> 'measured' end,
       'multiplier', case when jsonb_typeof(prop -> 'multiplier') = 'number' then prop -> 'multiplier' end));
     keep `evidence` as the arrivals branch does;
     update public.client_groups g set churn_monthly = (setv ->> 'churn_monthly')::numeric,
       provenance = g.provenance || jsonb_build_object('churn_monthly', entry) where g.id = cg.id;
     done := done || k; -> 'applied'; continue
   end if;
   ```
   Setting `provenance` in the same statement keeps it `measured`: `stamp_provenance` only stamps `entered` when the
   column changes and its provenance entry doesn't. The `audit_company_write` trigger logs the change as for any edit.
   The API-token refusal at the top already covers it. Keep row 50's `revoke`/`grant` lines.
4. **New `public.record_client_calibration(p_workspace uuid, p_clients jsonb, p_log jsonb, p_results jsonb, p_keys text[])
   returns jsonb`**, `language plpgsql security invoker set search_path = ''`. `p_clients` and `p_log` are each null or
   `{file_name, column_map, row_count}`:
   - Refuse an API token first, as `apply_calibration` does (42501, "Calibration is applied by a person in the app, not
     over the API"). This matters because with no keys `apply_calibration` isn't called.
   - Both null → `raise … using errcode = '22023'` ("Give a clients file or a servicing log").
   - Insert one `datasets` row for each given file (`kind` `'clients'` / `'servicing_log'`, `process_id` null) with
     `coalesce(column_map, '{}')`.
   - Insert one `calibrations` row: `dataset_id` = the clients dataset, else the log's; `process_id` null; `results =
     p_results || jsonb_build_object('datasets', jsonb_build_object('clients', <id or null>, 'servicing_log', <id or null>))`.
   - When `coalesce(cardinality(p_keys), 0) > 0`, `out := public.apply_calibration(cal, p_keys)`; otherwise
     `out := jsonb_build_object('status', 'ok', 'draft', null, 'results', '[]'::jsonb)` (the checks are recorded without
     applying anything).
   - Return `out || jsonb_build_object('calibration_id', cal, 'datasets', <the two ids>)`.
   - `revoke all … from public, anon, authenticated; grant execute … to authenticated;`.
5. Nothing for RLS or grants on the tables: row 50's policies cover the new rows (editors insert, members read).

**Header**: purpose; that client ids, unmatched service and task names never reach the database (the page sends counts);
the preflight; post-apply checks; and this rollback:

```sql
-- ROLLBACK (one transaction; roll the app back first):
--   begin;
--   drop function if exists public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[]);
--   -- Put back row 50's apply_calibration and calibration_payload_problem: re-run their
--   -- `create function ... $$;` blocks from 20261202000000_calibration.sql as `create or replace`, with their grants.
--   delete from public.datasets where kind in ('clients', 'servicing_log');  -- cascades to their calibrations
--   alter table public.datasets drop constraint datasets_kind,
--     add constraint datasets_kind check (kind in ('step_log', 'leads', 'deals', 'jobs', 'time_logs', 'invoices'));
--   delete from supabase_migrations.schema_migrations where version = '20261208000000';
--   commit;
-- Rolling back deletes the clients and servicing-log records. Applied churn keeps its number and its `measured`
-- provenance, whose dataset_id then points at nothing.
```

**Preflight** (in the header and the PR body; each with its expected result):

```sql
-- 0. Nothing at or past this version.  Expect 0 rows.
select version from supabase_migrations.schema_migrations where version >= '20261208000000';
-- 1. Row 50 (part 1) applied.  Expect 1.
select count(*) from supabase_migrations.schema_migrations where version = '20261202000000';
-- 2. The two replaced functions are row 50's, unchanged.  Expect the two md5s recorded here
--    (compute them on a local database migrated to 20261205000000 and paste them into the header).
select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem')) order by 1;
-- 3. Only step logs recorded so far.  Expect only step_log (or no rows).
select kind, count(*) from public.datasets group by 1;
-- 4. Nothing created yet.  Expect null.
select to_regprocedure('public.record_client_calibration(uuid, jsonb, jsonb, jsonb, text[])');
-- 5. The tables the new branch writes exist with the columns it uses.  Expect 2 rows.
select column_name from information_schema.columns where table_schema = 'public' and table_name = 'client_groups'
  and column_name in ('churn_monthly', 'provenance');
```

**Post-apply**: `pg_get_constraintdef` of `datasets_kind` lists the two new kinds; `record_client_calibration` is
`prosecdef = false`, `proconfig = array['search_path=""']`, executable by `authenticated` and not `anon`;
`apply_calibration` and `calibration_payload_problem` keep the same.

**Apply file** `packages/db/scripts/apply/20261208000000_client_calibration.sql`: `begin;`, the migration SQL, the
`insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261208000000',
'client_calibration', array[$mig$…$mig$]);` row, `commit;`. Copy the header style of
`scripts/apply/20261202000000_calibration.sql`. Then `pnpm --filter @transpera-flow/db gen:bootstrap` and `gen:types`
(no fixture changes, so no `gen:seed`). Add row 53 to `docs/production-migrations.md` as "not applied", in the style of
row 50.

### App (2b)

Copy part 1's files and patterns; the names below are the new files.

- **Request checks** `apps/web/src/lib/calibration/client-request.ts` (framework-free; copy `request.ts`):
  - `parseClientApplyRequest(input)`: workspace id is a uuid; at least one of `clients` / `log`, each
    `{fileName (1–300 chars), columnMap (keys from CLIENTS_COLUMNS / SERVICING_LOG_COLUMNS, values ≤ 200 chars),
    rowCount (0–1,000,000)}`; keys match `/^churn:<uuid>$/` and are in the proposals, others skipped as `not_proposed`;
    **zero keys is allowed** (record the checks only).
  - `storedClientResults(results)`: **rebuilds** the stored object from known fields only, never `...spread`:
    `{ kind: "clients", asOf, window, rows, clients, tasks, startsAfterAsOf, unmatchedServices: <count>,
    unmatchedTasks: <count>, noGroup: <service names from the model>, proposals: [each proposal's known fields],
    checks: [{id, n, value, simulated, enough, blocked, note}], run: {engineVersion, seed, reps, horizonWeeks, runs,
    converged, processIds} }`. Notes are built only from numbers and model names, so they carry no client ids. Under 900 KB, as
    part 1.
- **Server action** `recordClientCalibration(input)` in `apps/web/src/app/w/[slug]/settings/calibration/actions.ts`,
  copying `applyCalibration`: parse, signed-in check, `rpc("record_client_calibration", …)`, 42501 → "Only owners and
  editors can apply calibration here.", then `refresh()`.
- **Loader** `apps/web/src/lib/calibration/client-data.ts` (`server-only`, copy `data.ts`):
  `loadClientCalibration(slug)` returns `ClientCalibrationRows`, the live bundles to simulate (one per process that
  runs a target service: its `entry_process_id`, or the default live process for null, via `loadProcessBySlug(…,
  { processId, draft: false })`), and the last 5 client calibrations (`results->>kind = 'clients'`, newest first:
  date, file names, proposals, applied).
- **Worker** `apps/web/src/workers/churn-calibration.worker.ts` (copy `stress.worker.ts`) and hook
  `apps/web/src/lib/calibration/use-churn-backsolve.ts` (copy the shape of `lib/solutions/use-stress.ts`): posts
  `{id, model, measured}` per process, receives `{kind: "run", run}` progress and `{kind: "done", solved}` or `error`.
  When services are split over processes, solve each process's services with that process's model and merge.
- **Wording** `apps/web/src/lib/calibration/client-view.ts` (framework-free; copy `view.ts`): labels and (i) text below,
  `formatValue` for churn ("2.1% a month"), response ("6.5 working hours"), onboarding ("8 working days"), an
  `initiallySelected` that reuses part 1's rule (only changes to an estimate are ticked), and `applySummary` wording
  ("Normal churn updated for 2 services.").
- **Panel** `apps/web/src/components/calibration/client-calibration-panel.tsx` (client component; copy
  `calibration-panel.tsx`'s structure, inputs, `LogSummary`, `ProposalRow`, `SourceBadge`, `Help`): a second card on
  the Historical data page, under part 1's, titled **"Clients and servicing work"**. It has:
  - two inputs (paste or upload, each with "Download template"), and **"Counted up to"** (a date, default today; Q3);
  - a read summary per file (rows, errors by line, date order question, unmatched names *as counts and names on screen
    only*);
  - **"Normal churn"**: one row per service: current (with source badge), **measured**, **today's drivers ×M**,
    **proposed**, sample (n clients, k left), tick box. Blocked rows show the reason, no tick. `noGroup` services get one
    line each. While solving: "Measuring today's driver pressure… (run 2 of up to 4)";
  - **"Checks"** (never ticked, no apply): Late or missed work, Response time to ad-hoc requests, Onboarding speed:
    history (n) beside "simulated now" from `solved.simulated`, with "The simulation measures none: no servicing work is
    mapped." when null. Badge "Check only";
  - the button: "Apply N ticked" when any are ticked, else "Save the checks" (owners and editors; hidden read-only).
    Both call `recordClientCalibration`. Show `applySummary`;
  - past client calibrations (copy part 1's history list).
- **Page** `apps/web/src/app/w/[slug]/settings/calibration/page.tsx`: load both and render the new panel below
  `CalibrationPanel`, `mode={canEdit ? "live" : "readonly"}`.
- **Demo** `apps/web/src/app/demo/settings/calibration/page.tsx`: the panel in `mode="demo"` with samples from a new
  `apps/web/src/lib/calibration/client-sample.ts` (copy `sample.ts`): a deterministic Northbeam clients file (both
  services, about 40 clients over 18 months, 6–8 leavers per service, a few who rejoin) and a servicing log for its two
  servicing processes (monthly reports and ad-hoc requests; about 15% late, some open past due). Nothing saved.
- **Churn drivers history** (decision 2): `apps/web/src/app/w/[slug]/settings/page.tsx` loads the latest client
  calibration's `checks` and `asOf` and passes them to `ChurnDriversSettings` as `history`. In its driver row's
  "now: …" line, for `late`, `resp` and `onb` only, append " · history: {value} ({n}, to {asOf})" when the check has a
  value. Demo: none. Nothing else on that screen changes; the history never feeds the run.
- **(i) help** (`components/help.tsx`), each with a description and an example:
  - Normal churn: "The share of a service's clients who leave each month when nothing is going wrong. The churn in your
    file already includes what today's drivers add (late work, slow replies), so that part is taken out: normal churn ×
    today's driver pressure gives the churn in the file." Example: "9 of 40 SEO clients left over a year: 2.2% a month.
    Today the drivers add 25%, so normal churn is 1.8%."
  - Today's drivers: "How much today's switched-on drivers multiply churn in the simulation, without the market and any
    planned price rise." Example: "×1.25 means late work and slow replies add a quarter to normal churn."
  - Counted up to: "The date the clients file is true on. Clients with no end date are counted as clients up to it."
    Example: "Exported from your CRM on 30 September: pick 30 September."
  - Each check: what it is in plain words, that it is a check only, and an example ("38 of 250 tasks done after their due
    date or not at all: 15%. The simulation says 12% now.").
- **Docs**: in `docs/PRD.md` §6.6, add a paragraph on churn back-solving and the checks, and add decision row **D44**
  ("How is churn calibrated?") quoting Austin's five answers of 6 Oct and the reason ("otherwise the drivers count
  today's late work twice"). In `CONTEXT.md`, add one line under **Client group**: normal churn can be measured from a
  clients file, back-solved through today's drivers.

### Tests (2b)

- **New `packages/db/test/client-calibration.test.ts`** (copy `calibration.test.ts`'s harness, users and Northbeam ids):
  - As an editor, `record_client_calibration` with both files stores two datasets of the new kinds and one calibration
    (`process_id` null, `results.datasets` holding both ids), and applies a churn key: the group's `churn_monthly` is the
    proposed value, its provenance entry is `measured` with `dataset_id` = the clients dataset, `calibration_id`, `n`,
    `leavers`, `measured`, `multiplier`; `stamp_provenance` did not turn it `entered`; an `audit_log` row exists.
  - Zero keys: records, applies nothing, `applied` false.
  - A viewer, a stranger and an API token are refused and leave no records (with and without keys).
  - A key applied twice → `already_applied`; a group whose churn changed since → `changed`; another workspace's group →
    `not_found`; `churn_monthly` of 1.5 or a string → `invalid` with a reason, nothing written.
  - `datasets_kind` accepts `clients` and `servicing_log` and still refuses `other`.
  - Both files null → 22023.
  - Part 1's `calibration.test.ts` stays green unchanged (the replaced functions behave as before).
- **New `packages/mcp/test/postgrest-client-calibration.test.ts`** (copy `postgrest-calibration.test.ts`): load the
  live model over PostgREST, `measureChurn` on a fixture file, `backSolveChurn`, `churnProposals`; record and apply as
  the page does; a viewer's call leaves no record; reloading the model gives the group the proposed churn with measured
  provenance; the Stable market run equals the run without a market.
- **New `apps/web/test/client-calibration.test.ts`** (copy `apps/web/test/calibration.test.ts`): what is ticked;
  wording; `parseClientApplyRequest` (zero keys accepted, bad keys skipped, bad files refused);
  **`storedClientResults` drops an extra field holding a client id, and the stored JSON of the demo sample contains
  none of the sample's client ids** (D27); the demo samples read cleanly, every service and task name matches Northbeam,
  churn is proposed for both services and all three checks have values.
- `apps/web/test/settings-help.test.ts`: extend if it lists the Settings (i) labels.

### Done (2b)

All green locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`, Postgres
running). Bootstrap and types regenerated. The apply file and row 53 written; the md5s in preflight 2 filled in.
Screenshots of the demo Historical data page (light and dark, 1440 and 400 px) attached as text evidence, with the
churn rows, the checks and no console errors. PR body: preflight, "no engine numbers move", and the Churn drivers
history line.

---

## C2 (2c): per-person capacity factors. Blocked on Q1

Don't start. Austin's decision 4 assumed a switch that doesn't exist. If he chooses option A, the orchestrator scopes it
properly; this is the outline:

1. **Switch**: Settings → basics "Per-person times (capacity factors)", `settings.capacity_factor_enabled`, owner and
   editor, off by default, with (i).
2. **Storage**: not `person_skills` (a row there restricts skills). A new table `person_step_factors (person_id,
   step_id, factor > 0, provenance)` with B1 (2/3)'s per-person read policy (`can_see_person`).
3. **Engine**: `EnginePerson.factors?: Record<stepId, number>`; work time ÷ factor when the model's flag is on.
   Defaults change nothing, so `golden:approve --bump`; a golden model with factors on would move numbers by design.
4. **Calibration**: part 1's step log gains an optional `person` column; per (person, step) with ≥ 10 visits,
   `factor = step mean hours ÷ person mean hours`, proposed only with the switch on; never ranked or compared with a
   role median (D20); visible only to editors and the person.

---

## Edge cases (all slices)

- **No client groups at all** (pooled model or named clients only): no churn proposals; the page says "Count clients in
  Settings → Client groups to calibrate churn." Checks still work.
- **A service in the file the workspace doesn't have**: counted, never stored by name.
- **Inactive services** are ignored like unknown ones.
- **Client switching service**: a leaver of the old service and a new spell in the new one.
- **Rejoined client**: two spells; the gap's end is a leave.
- **Clients file only**: churn proposals and no `resp`/`onb`/`late` checks ("Needs the servicing log").
  **Servicing log only**: `late` and `resp` (any ad-hoc link) checks, no churn, `onb` blocked.
- **Process can't be simulated** (`ModelError` in `toEngineModel`): churn rows blocked with the Churn drivers section's
  message ("This workspace's live process can't be simulated yet…"); checks show history only.
- **A draft open on the process**: irrelevant. Churn is a company-model value and changes live, like lead volumes.
- **MCP**: no new tool. `apply_calibration` and `record_client_calibration` refuse API tokens; `client_groups` already
  refuses direct API-token writes (`company_needs_review`).
- **Realtime**: `client_groups` isn't published; the page `refresh()`es.
- **Roles**: members and viewers can read the page and the checks, and can't apply (RLS). No per-person data in 2a/2b.

## Out of scope

- Proposing SLA hours, recurrences (tasks a month), client counts, fees, typical stay or starting health (Q5, Q6).
- Late payments and any cash model (decision 5).
- Robustness perturbing a group's normal churn (it never did; a follow-up if Austin wants it).
- Named-client churn (`services.churn_monthly_base`) (Q2).
- Step SLAs (`steps.sla_hours`, rule 7).
- C1's import wizard (#40), connectors, scheduled re-calibration.
- Any change to `simulate.ts`, `churn-drivers.ts`, `clients.ts`, the golden baselines or `ENGINE_VERSION` in 2a and 2b.
- Any change to `save_fields`.

## Questions for Austin

**Blocking (2c only):**

**Q1. Per-person times.** You said calibration should propose capacity factors only when per-person times are switched
on. Today nothing can switch them on, the simulation doesn't use them, and there's nowhere safe to store them. Choose:
- **A:** build per-person times as a feature now (a switch in Settings, the simulation using them, privacy as in B1),
  with calibration proposing them. About one more PR, after B1's privacy slice.
- **B (recommended):** close #41 without them and open a new ticket "Per-person times" that includes calibrating them.
  Nobody uses them yet, and they are off by default.

**Non-blocking (the builder uses the default unless Austin says otherwise):**

- **Q2.** A service whose clients are entered one by one (Settings → Clients) rather than counted in a client group:
  calibrate its normal churn too? *Default: no. The page says "Count this service's clients in Client groups to calibrate
  its churn."*
- **Q3.** Which date is the clients file true on? *Default: a "Counted up to" date on the page, today unless changed.*
- **Q4.** May the servicing log have an optional `requested` column, for response times? *Default: yes, optional.
  Without it, a request counts as coming in one SLA before its due date, as in the simulation.*
- **Q5.** The clients file also shows how many clients each service has today. Propose that as the group's count?
  *Default: no. It is shown beside the group's count as a check.*
- **Q6.** Propose SLA hours from the servicing log? *Default: no. An SLA is a promise, not a measurement; the late share
  shows how well it is kept.*
- **Q7.** Churn is measured over the last 12 months, needing at least 13 weeks, 10 clients and 3 who left. *Default: as
  stated.*
- **Q8.** One-off services: measure their churn? *Default: no. Their clients end by design.*
- **Q9.** Show the history beside the simulated values on Settings → Churn drivers too, not only on Historical data?
  *Default: yes.*
