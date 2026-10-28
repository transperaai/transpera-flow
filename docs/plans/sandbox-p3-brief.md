# Sandbox phase 3: engine changes for Austin's levers (build brief)

Opus brief, 28 Oct 2026. Source: `docs/plans/sandbox-design.md` (Austin's decisions of 28 Oct: A "Market", B "Clients", build
order phase 3: "Engine changes for Austin's levers", monthly channels and the remaining timed levers), the built phases
(`docs/plans/sandbox-p1-brief.md`, `docs/plans/sandbox-p2-brief.md`, both merged), and the coordinator's click-through of the
built Sandbox (28 Oct). Built on `claude/supabase-migration-plan-mzchlf`. One builder; Opus reviews. Phase 4 (time by purpose) is
built **after** this and rebases on ENGINE 1.12.0: phase 3 owns the engine until it merges.

Read first: `CLAUDE.md`, `docs/engine-versioning.md`, PRD D28, D29, D44, D46, and the two earlier briefs.

**Phase 3 in one line:** the months before a timed change stop moving; every timed lever except a solution going live and a
headcount cut runs in one run through monthly channels; churn drivers can be chances with an effect; a service has a fee range;
a price rise reaches existing clients, carries its churn and shows its trade-off; clients on the book and base churn work for
client groups and named clients; role cost is offered.

## Rules

- **Nothing moves by default.** Every existing golden number and every existing workspace's result stays the same unless
  someone sets a new field (a chance, an effect, a fee range) or saves a new kind of change. The only intended moves for
  existing data are the two the coordinator asked for: B1/B3 (and the "Downturn" starter) now act on client groups and named
  rosters (§5.4), and Sandbox runs pin their warm-up (§1), which changes Sandbox numbers only, never a golden.
- **Random-number discipline.** No existing draw is added, removed or reordered on any path a model without the new fields
  takes. New randomness comes only from **new stream labels** (`Streams.get` keyed per label, `packages/engine/src/random.ts`), so
  it never shifts an existing stream. Multipliers are applied **after** the draw (as `capacityFactor` is in `startService`). The
  table in §2.8 lists every new stream and every changed read.
- **Migrations transform real data** (the production copy is imported at `20261231000000`, then every later migration runs on
  it). Phase 3's migration is `20270112000000_churn_chances_and_fee_ranges.sql`. If phase 4's brief named the same timestamp,
  the second to merge renames (`appliedVersions`, `packages/db/src/migrations.ts`, applies any unapplied version).
- **Generated files:** after the SQL, `pnpm --filter @transpera-flow/db gen:types` and `gen:seed`.
- **Done** = `pnpm lint && pnpm typecheck && pnpm test` green with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`
  (the known `format.test.ts` ICU failure ignored), goldens approved at 1.12.0 with only the moves §3 allows, perf recorded.

---

## 0. What exists today (verified at `95b96196`)

- **Streams are already per purpose** (`Streams`, `StreamLabels` in `random.ts`): arrivals (`arrivals`, `arrivals:warmup`),
  service mix (`mix`, `mix:warmup`), per step `work:<id>`, `wait:<id>`, `rework:<id>`, `route:<id>`, per roster client
  `churn:client:<key>` (named, groups) or `churn:<key>` (won), servicing `servicing:<key>:<service>:<process>`, WIP `wip:<id>`,
  `mix:wip`. A person with a later `from` changes no draw before `from` (checked, below).
- **Market** (`market.ts`): factors per **52/12-week month from t = 0** (`mkt(t)` in `runOnce`), not calendar months. `leads`
  (arrival rate, `demand.ts` `walk`), `conv` (`pickWithSigning` in `leave`, only when `conv !== 1 && winEdges`; `winEdges` and
  `beforeSale` are computed only `if (market)`), `cycle` (waits before the sale, `endService`), `price` (fee of each client won,
  `addWonClient`, `reachEnd`), `churn` (`churnMarket`). **`hire` is "Time to hire" and `pay` is "Late payments"**
  (`MarketFactors` doc comments; `apps/web/src/lib/market.ts` labels; `UNUSED_FACTORS = ["hire", "pay"]`). `pay` is **not** pay
  inflation: design D10's "wire the market's `pay` factor: role cost channel" misreads it (Downturn has `pay: 1.35`, slower
  payments; read as pay it would raise labour 35% in a downturn).
- **Churn drivers** (`churn-drivers.ts`; `runOnce` from `const drivers = resolveChurnDrivers(model)`): weekly chance =
  `base × (1 + Σ weight × pressure) × churnMarket(t) / WEEKS_PER_MONTH`, per roster client, in `driveClient`; blame in
  `flushRun` (slot 0 normal, then each driver). Pooled models: only the market acts. Without servicing, alike group clients are
  merged into runs (`runCount`) and worked out once. The `price` driver is churn only: an entered rise % from `month` gives
  pressure `2 × rise` for `PRICE_WEIGHT_WEEKS` (13) to **every** client; **no fee changes**. Default off.
- **Fees:** a roster client bills `weeklyBill` (`bill()`); a client won bills `price × mkt(t).price / WEEKS_PER_MONTH`
  (`addWonClient`); pooled `pooledMrr` (`accruePooled`, `churnTick`, `reachEnd`). B2 today is `services.<id>.price` (new
  clients only) or `finances.retainer`; a timed B2 is a spliced price patch: **new clients only, no churn**.
- **Sandbox** (`packages/db/src/sandbox-levers.ts`, `private.sandbox_levers()` in `20270109000000`, `is_sandbox_change` last in
  `20270111000000_sandbox_fix.sql` as PL/pgSQL; runner `apps/web/src/lib/sandbox/run.ts` `applyPeopleChanges`,
  `scenarioSegments`, `scenarioModel`; hook `use-scenario-run.ts`; `runSegments`/`runKey` in `lib/forecast/sim-pool.ts`;
  `spliceMonthly` in `lib/forecast/splice.ts`). Spliced (capped) today: A1, A6, B2, B3, C1, C2, D4 (pinned/assigned fallback),
  D5, E1, E2, E3, E6. `C1` is `offered: false` (ADR 0021: "kept, not offered"). A6 is a raw weight (a polish builder is
  changing the dialog to %; **not phase 3**). B1/B3 have `applies` = `ROSTER_REASON` (greyed with client groups or a named
  roster), so the library's "Downturn" (`B3 ×1.5`) does nothing in Northbeam.
- **Patches:** `private.is_scenario_patch` still exists (used by `save_solution`; latest body `20270108000000_overheads.sql`)
  and `packages/db/test/scenarios.test.ts` asserts it accepts exactly what `parsePatches` accepts; `apps/web/test/
  sandbox-levers.test.ts` asserts every `PATCH_FIELDS` path maps to one lever. **Phase 3 adds no `PATCH_FIELDS`** (§5.3), so
  neither twin changes.
- **Restore:** `public.import_workspace_bundle` (latest body `20270109000000_sandbox_scenarios.sql`) has an `allow` list per
  section; `workspace-import.test.ts` asserts it equals `IMPORT_COLUMNS` (`packages/db/src/workspace-import.ts`). New columns
  need both.
- **Goldens:** northbeam, northbeam-seeded, northbeam-downturn, northbeam-groups, northbeam-drivers, northbeam-money (monthly),
  larkspur; ENGINE 1.11.0. `keyOutputs` keeps `churnCauses.causes[id] = {share, mrr, pressure, value}`.
- **Phase-1 perf:** `apps/web/test/sandbox-performance.test.ts`, 7 segments at 12 months, about 0.7 s a segment against 1 s.

---

## 1. Months before a timed change must not move (coordinator item 1)

**Root cause, measured.** On the demo (`demoForecastBundle()`, start 2026-10-05, 12 months) a hire (D1, PPC, FTE 1) from
2027-01 moved revenue in Oct, Nov and Dec by +196, +26 and +302 a month (and wins by ±0.2). The streams are not the cause:
the scenario model deep-equals the live model apart from the hire (`from: 512`). The cause is the **automatic warm-up**:
`initialState` → `autoWarmupHours` runs a pilot (`PILOT_SEED`) of the whole model, hire included, and sizes the warm-up from its
P90 cycle (live 1002.81 h, with the hire 1007.05 h). A different warm-up shifts every arrival and draw of the run. With the
warm-up pinned to the live one, months 0–2 were **exactly** equal (0.00), and the same model with the hire sorted first, last,
or never present gave 0.00 too. Every scenario kind is exposed (a timed patch's segment, a channel, a leave, a leaver): any
change in the horizon moves the pilot.

**Fix (no golden moves):**
1. Engine: `SimulateOptions.initialState?: InitialState` (`simulate.ts`). `simulate` uses it instead of `initialState(model)`
   when given; `SimulationResult.initialState` echoes it. Goldens don't pass it.
2. Runner: one pinned start per scenario: `initialState(warmupModel)`, where `warmupModel` is the live bundle with only the
   scenario's **whole-run** changes (patches and model edits, no `from`, no scenario-dated people, no channels). A scenario with
   only timed changes therefore pins the live run's warm-up. "No changes" pins `initialState(live.model)`. Every segment, the
   price-rise pair (§2.5) and compare columns pass their pinned start.
3. Plumbing: `RunRequest`/`Entry` and `runKey` in `sim-pool.ts` gain the start (`|w=<hours or kind>`); `lib/sim/protocol.ts`
   (beside `monthly`, `monthStarts`) gains `initialState?`; `workers/simulate.worker.ts` passes it to `simulate`.
4. Splicing benefits too: every segment shares the pinned warm-up, so a spliced stock's offset at `k − 1` is only the change.

**Other CRN leaks, checked or closed by design:** won clients are keyed `won:<n>` in win order (only after the first change can
order differ); new randomness in this phase uses new labels (§2.8); channels multiply after draws and read the same stream
counts (`rework` and `wait`, §2.2); a channel equal to the base takes the old path (`activeChannels`, §2.2).

**Tests:** engine `simulate.test.ts`: `simulate(m, 30, 1, { initialState: initialState(m) })` deep-equals `simulate(m, 30, 1)`
for every golden model. Web `sandbox-run.test.ts` "months before a change are exactly the live run's": the demo with (a) D1
from 2027-01, (b) D3 leave, (c) D2 leaver, (d) A1 ×1.2 channel, (e) E1 ×0.5 channel, (f) B5 +8%, (g) B4 chance 30% effect
50%, (h) C1 ×1.2, (i) D6 ×0.9, each from 2027-01: every `MonthlyResult` series in months before January `toEqual` the live run's
(means and bands). Plus one spliced case (E6 from 2027-03).

---

## 2. Engine (`packages/engine`)

### 2.1 Types (`model.ts`, `churn-drivers.ts`)

```ts
// EngineService (model.ts)
/** Fee range of a client won on this service (A5): its fee is drawn from a triangular low – price – high. Omitted, or
 *  low = high = price: the price, and no draw. The engine uses min(low, price) and max(high, price). */
priceRange?: { low: number; high: number };

// EngineModel (model.ts)
/** Per-month values the engine reads while it runs (sandbox phase 3, §2.2). Omitted or all neutral: as before. */
channels?: EngineChannels;

export interface EngineChannels {
  /** Hours inside the run where months 1, 2, … start: the run's `monthStarts`. Month 0 starts at t = 0 and also covers the
   *  warm-up. An array shorter than starts.length + 1 holds its last value. */
  starts: number[];
  leads?: number[];                            // × arrival rate, on top of seasonality, growth and the market's leads
  conv?: number[];                             // × the market's conv
  mix?: Record<string, number[]>;              // service id → mix weight that month (absolute; replaces mixShare)
  newFee?: Record<string, number[]>;           // service id or "*" → × the price a client won that month pays (fee, one-off price, hourly rate)
  fee?: Record<string, number[]>;              // service id or "*" → × what every active client pays that month (existing and won)
  priceRange?: Record<string, ({ low: number; high: number } | null)[]>; // A5 timed; null = the service's own
  churn?: Record<string, number[]>;            // service id or "*" → × base churn (pooled: "*" only)
  drivers?: Record<string, (DriverEvents | null)[]>; // B4 timed, by driver id; null = as the model's churnDrivers say
  work?: Record<string, number[]>;             // step id → × hands-on time
  wait?: Record<string, number[]>;             // step id → mean external wait, hours (absolute)
  rework?: Record<string, number[]>;           // step id → rework probability (absolute, ≤ MAX_REWORK)
  roleCost?: Record<string, number[]>;         // role id → × the role's cost
  overheads?: number[];                        // × overheadMonthly
  capacity?: Record<string, number[]>;         // person id or "*" → × contracted capacity
}

// churn-drivers.ts
export interface DriverEvents {
  /** Monthly chance a client is hit, 0–1. null: measured (late, resp, onb, rework, load). */
  chance: number | null;
  /** How much a hit raises that client's churn while it lasts: 0.5 = +50%. */
  effect: number;
  /** Months a hit lasts, 1–24. */
  months: number;
}
// EngineChurnDriver gains
chance?: number | null;    // 0–1
effect?: number | null;    // 0–5; set (a number) = the driver runs as events
effectMonths?: number | null; // 1–24, default 3
// ResolvedChurnDriver gains
events: DriverEvents | null;  // null: weight × pressure, exactly as today
// ChurnCause gains
mode: "weight" | "chance";
chance: number | null;     // hits per active client-month in the run (measured or drawn); null for tenure and market
exposure: number;          // share of active client-weeks under the driver's effect (0 in weight mode)
effect: number | null;
// ChurnDriverSpec gains
events: "measured" | "entered" | "none";  // late, resp, onb, rework, load: measured; handoff, results, price, custom: entered; tenure, market: none
```

New constants in `churn-drivers.ts`: `CHURN_EFFECT_MAX = 5`, `EFFECT_MONTHS = { min: 1, max: 24, default: 3 }`,
`PRICE_EFFECT_PER = 0.1` (a price driver's effect is per 10% rise, §2.5). Export the new types from `index.ts`.

### 2.2 Monthly channels (`simulate.ts`, new `channels.ts`)

- New `packages/engine/src/channels.ts`: `checkChannels(c)` (finite, ≥ 0, `rework` ≤ `MAX_REWORK`, `starts` ascending in
  (0, H)), and `activeChannels(model)`: the channels with every array dropped that is neutral (all 1 for multipliers; equal to
  the base for `wait`, `rework`, `mix`; all null for `priceRange`, `drivers`), null when nothing is left. Like
  `activeMarket`, a neutral channel takes the old code path.
- In `runOnce`, beside `const market = activeMarket(model)`: `const ch = activeChannels(model)` and `chM(t)`, the month index
  (binary search over `ch.starts`, `t < 0` → 0). Every lookup below is `ch ? arr[min(chM(t), arr.length − 1)] : base`.
- **Where each is read:**

| Channel | Read at | Exactness |
|---|---|---|
| `leads` | `demand.ts` `calendar()`/`walk`: a third edge set (channel month edges) beside calendar and market edges; `calendar()` is non-null when `leads` is active | unit-exponential draws unchanged; the rate per piece × channel |
| `conv` | `leave`: `conv = (market ? mkt(t).conv : 1) × convCh`; compute `winEdges`/`beforeSale` `if (market \|\| ch?.conv)` | factor 1 takes the plain pick |
| `mix` | `drawService`: weights and total of month `chM(t)` | one draw per arrival, as now |
| `newFee` | `addWonClient`, `reachEnd` (one-off price, pooled fee, `billed`, hourly `e.rate`), × the market's price | no draw |
| `fee` | `bill`, `accruePooled`, hourly booking in `startService`, `mon.mrr`, `mrrLost`, blame `runMrr`: a client's fee at t is `weeklyBill × fee(t)`; `bill` integrates month by month over [from, to] | no draw (§2.5) |
| `priceRange` | the win (§2.4) | own stream |
| `churn` | `driveClient`: `rc.churnBase × churn(t)`; pooled `model.churnMonthly × churn["*"]` in `churnTick` | no draw |
| `drivers` | `churnTick` per tick: the driver's events for that month (§2.3) | own streams |
| `work` | `startService`: `handsOn = drawn × factor × work(t)` (after the draw) | same draws |
| `wait` | `endService`: base > 0: `w × wait(t) / s.wait`; base 0: a sampler created at setup when the channel has any month > 0, on the step's existing label `wait:<id>`, mean 1 and `s.waitDist ?? DEFAULT_WAIT_DIST`, × `wait(t)` | the stream exists only when used |
| `rework` | `leave`: `const rw = reworkAt(st, t); redo = Boolean(rw && st.rework() < rw)` | same draw count as base when equal |
| `roleCost` | `rateOf(p)` per month: a person without their own `cost` is costed at the mean of `role.cost × roleCost[role][m]`; `monthlyOut` labour and overtime cost per month; `labourCost`/`overtimeCost` totals sum the months | no draw |
| `overheads` | overheads per month × `overheads[m]` | no draw |
| `capacity` | new event type `"capacity"` (see below) | no draw |

- **Rework from 0:** `detectLoops` makes a redo loop only for `s.rework > 0`. `loopsOf` passes a model whose step rework is the
  maximum over its channel months, so a step that only gains rework from a month still has its loop (0 rounds before).
- **Capacity:** `EventType` gains `"capacity"`, scheduled once per `starts[k]` where any `capacity` array changes, **after** the
  weekly ticks and `staff` events are scheduled (ties: week tick, then staff, then capacity, by insertion order). Handler:
  for each person whose factor changes, `advance(p, t)`, `peopleModel[id] = p.person = { ...base, capacity: base.capacity × f }`,
  then `restaff(t)` (it recomputes pools, shapes, loads, `availFrac`). A factor of 0 is not allowed (the runner turns it into
  a leaver, §5.4). `presentWeeks`/`presentHours`-based figures (labour, monthly capacity, overtime limits, `staffedCapacity`)
  use a new `capHours(p, a, b)`: Σ over channel months of overlap × base capacity × factor / hpw, so whole-run and monthly sums
  agree.
- The channel months are the **run's months** (`starts` = the run's `monthStarts`, calendar months in the app). When
  `simulate` is called with `monthly` and `monthStarts`, the engine throws if `channels.starts` differs (one meaning of
  "month"). The market keeps its 52/12-week months (out of scope to change).

### 2.3 Churn drivers as chances (B4)

**Model, exactly.** For a roster client (named or group; pooled models have no per-client state, as today) at each weekly tick:

    weekly chance = base × churn(t) × (1 + Σ_weight-mode w_d × p_d + Σ_chance-mode e_d × x_d) × churnMarket(t) / WEEKS_PER_MONTH

- Weight mode (`events === null`): exactly today's term.
- Chance mode: `x_d` is 1 while the client is under a hit (t < `hitUntil[d]`), else 0; `e_d` is the effect. A hit at time `h`
  sets `hitUntil[d] = max(hitUntil[d], h + months × (52/12) × hpw)`: a hit during a hit extends it, effects never stack.
- **Where hits come from:**
  - Entered chance `c`: at each tick, before the churn draw, each active client draws once from its own stream
    `labels.join("hit", driverId, rc.key)` (created lazily) and is hit if `u < 1 − exp(log(1 − c) / WEEKS_PER_MONTH)`
    (`det-math` `exp`/`log`). The draw is made **every tick for every active client while the driver is in chance mode**, hit
    or not, so a stream's position depends only on the tick count. `c ≥ 1`: hit every tick, no draw; `c ≤ 0`: never, no draw.
  - Measured (chance null, `spec.events === "measured"`), at the event itself: `late` a servicing task of the client finished
    late (`finishTask`) or missed (`settleMisses`); `resp` the same for an ad-hoc task (the `adhoc` flag `touchpoint` gets);
    `rework` a servicing visit of the client redone (`leave`, where `e.task.client.reworks++`); `onb` a client won in the run
    whose first delivery comes later than normal (at that delivery, or at the first tick past normal while it still waits);
    `load` a tick at which its team's busiest share is above `LOAD_THRESHOLD`. No draw.
  - Defaults when `chance` is null and the driver is entered: `handoff` its value ÷ 12 (the value is "share of clients whose
    account manager changes in a year"); `results` and custom: 1; `price`: 1 at each rise (§2.5). `tenure` and `market` have no
    chance mode (`events: "none"`): an `effect` on them is ignored by `resolveChurnDrivers`.
- **Weight in chance mode** is not used (the UI greys it). The on/off switch still applies.
- **Combination:** effects add inside `(1 + Σ …)` with weight-mode drivers; `churn(t)` scales the base; the market multiplies
  the whole, as today. The weekly chance is clamped as today (`hazard`).
- **Code:** `RosterClient` gains `hitUntil: Float64Array | null` and `hitRng: (Rng | null)[] | null`, set (to null) in the
  `addClient` literal so its shape stays monomorphic, allocated only when a driver is in chance mode. In `driveClient` a
  chance-mode slot sets `ev[s] = x` and uses `dw[s] = effect` (set per tick from the month's events), so `flushRun`'s blame,
  `pressSum` (now the exposure for that slot) and `summariseChurn` work unchanged. **Run merging is off** in any tick where a
  driver is in chance mode (clients differ). `liveSlots` includes chance-mode `resp`/`onb`/`rework` only with servicing.
- **Reporting:** each driver's realised hits per active client-month (`chance`) and exposure are counted in both modes for the
  measured drivers (counting draws nothing), so Settings can show "measured chance" before anyone switches.
- **Keeping existing results:** no stored row has a chance or an effect (new nullable columns), so every workspace runs in
  weight mode, bit for bit. Nothing is migrated. To switch a driver without changing its expected churn, the UI pre-fills
  `equivalentEvents(cause, weight)` (new, pure, `churn-drivers.ts`): `chance` = the measured chance (measured drivers) or 1
  (results, custom: exact, since a hit every tick with effect `w × p` is today's term), `effect = w × cause.pressure /
  exposure(chance, months)` where `exposure = 1 − (1 − chance)^months` (capped at 5). Expected churn matches in expectation,
  not draw for draw; the help says so.
- `projectChurn` (Settings' live projection): `DriverWeightChoice` gains optional `{ effect, chance, months }`; a chance-mode
  choice adds `effect × exposure(chance, months)` (measured: the run's `exposure`) instead of `weight × pressure`.
- `client-calibration.ts` back-solve needs no change (it reads `1 / normal share` from `byService`).

### 2.4 Client value range (A5)

- At a win of service `sv` (t ≥ 0, `reachEnd`), when the range in force (`ch.priceRange[sv][m] ?? sv.s.priceRange`) has
  `low < price` or `high > price`: `price' = triangular(rng, min(low, price), price, max(high, price))` from a new stream
  `labels.join("fee", serviceId)` (one draw per win of that service, only for ranged services). `price'` replaces
  `sv.s.price` for that client: retainer `weeklyBill`, pooled `pooledMrr`/`billed`, one-off price, hourly `e.rate` and
  `rc.hourlyRate`, then × the market's price and `newFee`.
- `ServiceState.value` (LTV, lost revenue) uses the range's mean `(low + price + high) / 3` when ranged.
- Existing clients (named `mrr`, group `fee`) keep their entered fee. Low = likely = high (the Settings default) draws nothing.

### 2.5 Price rise with its trade-off (B5), and fees for existing clients (B2 "all")

- **Fees:** the `fee` channel (§2.2) multiplies what every active client of the service pays from its month: existing and won,
  retainer fees, one-off prices at the win and hourly revenue as it is booked. `weeklyBill` stays the base fee (so nothing is
  counted twice with `newFee`).
- **Rise revenue, in the run:** wherever a fee is booked at factor `f ≠ 1`, the `(f − 1)` part is also added to `riseRevenue`
  (and `mon.revRise`). This is "revenue gained from clients who stay" for each moment they stayed.
- **The churn:** the price driver reads the rises: at each month `m` where `fee[s](m) > fee[s](m−1)`, rise `r = f(m)/f(m−1) − 1`
  for clients of `s` (or all for `"*"`). Weight mode: the client's price pressure is the Settings planned rise as today plus
  `PRICE_PRESSURE_PER_UNIT × r` for `PRICE_WEIGHT_WEEKS` from the month (`ev[SPRICE]` per client in `driveClient`, not one
  constant per tick; merged runs share a service, so they stay alike). Chance mode: at the rise each active client of `s` is hit
  with the driver's chance (draw from `hit:price:<key>`; default 1) and its churn rises by `effect × r / PRICE_EFFECT_PER` for
  `months`. A cut (`r < 0`) has no churn effect.
- **Outputs:** `ReplicationResult.revenue.rise`, `ReplicationSamples.revenueRise`, `MonthlyReplication.revenueRise`,
  `MonthlyResult.revenue.rise: Stat[]`, and with `monthly` a new `SimulationResult.monthlySamples = { revenue: number[][];
  rise: number[][]; clientsLost: number[][] }` (replication × month; total revenue as `revenue.total`). `Kpis` is unchanged.
- **The trade-off (measured with paired runs, exactly).** R = the scenario. B = the same scenario without its B5 changes (and
  without the forced price driver, §5.4); same seed, same pinned warm-up (§1), same segments. Per replication `i` and month `m`:
  - gained `G = rise_R[i][m]` (stayers' extra fees in R);
  - net `N = revenue_R[i][m] − revenue_B[i][m]`;
  - lost `L = G − N` (revenue lost from the extra leavers, and anything else the rise changed);
  - extra leavers `X = clientsLost_R[i][m] − clientsLost_B[i][m]`.
  Each shown as mean and 10–90% of the per-replication values, per month and summed over the run (the sum taken per
  replication, then the stat). Common random numbers make months before the rise exactly 0 and the rest low-noise: a client of
  R leaves where B's does unless the rise pushed its chance over its own churn draw.
  **Break-even:** `lossPerLeaver = ΣL / ΣX` over replications (run totals); `breakEven = mean G / lossPerLeaver`, the extra
  clients the rise can lose before the net is 0, shown against mean X. If mean X < 0.05: `lossPerLeaver` = the service's mean fee
  after the rise × half the months from the rise to the horizon (labelled "estimated"). As a rate: `breakEven ÷` (client-months
  after the rise in B), in percentage points of monthly churn.
  Pure function `priceRiseTradeoff(withRise, withoutRise, riseMonths)` in `apps/web/src/lib/sandbox/price-rise.ts`.
- Pooled models: `fee` and `newFee` take `"*"` only (one pool); a per-service B5 says why in `applies`.

### 2.6 Hiring delay (D9) and the market's `hire` and `pay`

- **D9 in scope, runner only** (no engine change): a D9 change (0–6 months, whole run) delays every **scenario** hire (D1)
  by `round(delay × the market's hire factor in the hire's month)` months (`engineMarket(bundle)`, month index from the start).
  Settings' own planned hires are dated already and not delayed. `hire` is then wired (only through D9).
- **`pay` stays unwired**: it means late payments (cash flow), out of scope. D10 "pay inflation" is C1 from a month (the role
  cost channel); a compounding % a year is an open question (Q6). Fix design D10's text in `sandbox-design.md`'s next edit.

### 2.7 Where in `simulate.ts`

| Change | Place |
|---|---|
| `ch`, `chM`, channel lookups | beside `const market = activeMarket(model)` |
| `leads` edges | `demand.ts` `calendar`, `walk`, `demandFactor` |
| `conv`, `rework`, measured `rework` hits | `leave` |
| `mix` | `drawService` |
| `work`, hourly × `fee` | `startService` |
| `wait` (and its lazy sampler) | step setup loop (`stepStates.set`), `endService` |
| fee range, `newFee`, `fee` at win, one-off | `reachEnd`, `addWonClient` |
| `fee` integration, `riseRevenue` | `bill`, `accruePooled`, `billHourly`, the weekly `mon.mrr` snapshot, `churnTick` (`mrrLost`) |
| driver events, price rises, `churn` | `churnTick`, `driveClient`, `flushRun`; hits in `finishTask`, `settleMisses`, `leave`, onboarding in `finishTask` |
| `capacity` events, `capHours` | event loop (`"capacity"`), `restaff`, people loop, `monthlyOut` |
| `roleCost`, `overheads` | `rateOf`, `monthlyOut`, the people loop's `labourCost`/`overtimeCost` |
| `initialState` option, `monthlySamples` | `simulate` |
| new outputs | `churnOut`, `summariseChurn`, `monthlyResult`, `kpis` (samples only) |

### 2.8 Random streams: what is new, what is untouched

| Stream | Status |
|---|---|
| `arrivals`, `arrivals:warmup`, `mix`, `mix:warmup`, `work:*`, `wait:*`, `rework:*`, `route:*`, `churn:*`, `servicing:*`, `wip:*`, `mix:wip` | unchanged count and order on every path without the new fields; with channels the same draws, multiplied after |
| `hit:<driver>:<client>` | **new**, only in chance mode with an entered chance < 1; one draw per tick per active client |
| `hit:price:<client>` | **new**, only at a rise with a price chance < 1 |
| `fee:<service>` | **new**, only for a ranged service, one per win |
| `wait:<id>` for a step with base wait 0 | created only when a `wait` channel gives it a mean |
| synthetic named clients' `churn:client:sandbox:<change>:<i>` (§5.4) | new clients, new keys |

## 3. ENGINE version and goldens

1. Add two golden models (fixtures in `packages/engine/src/fixtures/northbeam.ts`), run `{ monthly: true }`:
   - **`northbeam-chances`** = `northbeamWithChurnDrivers()` with `late` measured (effect 0.6, 3 months), `handoff` entered
     (chance 0.05, effect 1, 2 months), the custom driver at chance 0.1 effect 0.5, a PPC fee range 3,000–(price)–6,000, and
     a `fee` channel of PPC +8% from month 4 with the price driver on.
   - **`northbeam-channels`** = `northbeamWithMoney()` with channels from month 3: `leads` ×1.2, `conv` ×0.9, `work` ×0.7 on the
     heaviest step, `wait` 0 → 8 h on one step, `rework` 0 → 0.1 on another, `roleCost` ×1.1 on one role, `overheads` ×1.25,
     `capacity` ×0.9 for one person, `churn["*"]` ×1.3.
   `keyOutputs`: `churnCauses.causes[id]` gains `mode`, `chance`, `exposure`; monthly models gain `revenue.rise` means.
2. `pnpm --filter @transpera-flow/engine golden:approve "Sandbox phase 3: monthly channels, churn drivers as chances, fee ranges, price rises for existing clients with their churn, pinned warm-up option; northbeam-chances and northbeam-channels golden models. No existing simulated number moved."`
   → 1.12.0. **Check the diff: only added keys and the two new models.** Any moved existing value is a reordered sum or a new
   draw on an old path: fix it.
3. `browser-determinism.test.ts` picks up the new models; must pass.
4. Commit baselines, ledger and `version.ts` with the engine change. `docs/engine-versioning.md`: a section "Chances, fee ranges,
   price rises and channels (engine 1.12.0, sandbox phase 3)" with the B4 formula (§2.3), the trade-off definition (§2.5), the
   stream table (§2.8), the warm-up finding (§1) and the timings (§10); fix "Time to hire and late payments … change nothing"
   (hire acts through D9). Phase 4 rebases on 1.12.0; its hands-on output must count hours after the `work` channel.

## 4. Data, Settings model loading, restore

### 4.1 Migration `packages/db/migrations/20270112000000_churn_chances_and_fee_ranges.sql`

Header as `20270108000000_overheads.sql`: what, why, preflight (`select count(*) from public.schema_migrations where version >=
'20270112000000'` = 0; counts of `churn_drivers` by driver and of services), post-apply checks, rollback (drop the five columns
and two constraints, re-run the three function bodies and two triggers from their previous migrations, named).

```sql
select set_config('transpera.actor_kind', 'system', true);

-- 1. Churn drivers as chances (B4). All null on every existing row: weight mode, results unchanged.
alter table public.churn_drivers
  add column chance numeric constraint churn_drivers_chance check (chance >= 0 and chance <= 100),          -- percent a month
  add column effect numeric constraint churn_drivers_effect check (effect >= 0 and effect <= 500),          -- percent
  add column effect_months smallint constraint churn_drivers_effect_months check (effect_months between 1 and 24);
alter table public.churn_drivers add constraint churn_drivers_chance_kinds check (
  (chance is null and effect is null and effect_months is null) or driver is null or driver not in ('tenure', 'market'));
drop trigger stamp_provenance on public.churn_drivers;
create trigger stamp_provenance before insert or update on public.churn_drivers
  for each row execute function public.stamp_provenance('weight', 'enabled', 'value', 'month', 'chance', 'effect', 'effect_months');

-- 2. Client value range per type (A5). Null: no range. No cross-column check: price and the ends are saved one field at a time
--    (save_fields), and the engine uses min(low, price) and max(high, price).
alter table public.services
  add column price_low numeric constraint services_price_low check (price_low >= 0),
  add column price_high numeric constraint services_price_high check (price_high >= 0);
drop trigger stamp_provenance on public.services;
create trigger stamp_provenance before insert or update on public.services
  for each row execute function public.stamp_provenance('pricing_model', 'price', 'margin', 'tenure_months', 'churn_monthly_base',
    'churn_health_sensitivity', 'mix_share', 'price_low', 'price_high');

-- 3. The restore carries the new columns: import_workspace_bundle REWRITTEN as a full copy of the 20270109000000 body with only
--    `allow` changed: churn_drivers + "chance","effect","effect_months"; services + "price_low","price_high".
-- 4. The lever table and the change check: private.sandbox_levers() (create or replace, no search_path, §5.2) and
--    private.is_sandbox_change (create or replace, PL/pgSQL, the 20270111000000 body with the §5.2 branches).
```

The trigger drop/create pairs must match the existing trigger names (`stamp_provenance`, `20261116000000`, `20261015000000`).
`company_needs_review` and `audit_company_write` triggers are row-level and need nothing. New columns are numeric, so
`share-field-classes.test.ts` (string columns) and `private.share_snapshot_problem` need nothing; a share snapshot carries
`price_low/high` as it carries `price` (not pay).

### 4.2 Code in `packages/db`

- `types.ts`: `ChurnDriverRow` gains `chance`, `effect`, `effect_months: number | null`; `ServiceRow` gains `price_low`,
  `price_high`. `queries.ts`: `CHURN_DRIVER_COLUMNS` and `SERVICE_COLUMNS` gain them. `workspace-import.ts` `IMPORT_COLUMNS`
  gains them (equal to the SQL `allow`).
- `model.ts` `engineChurnDrivers`: `chance/100`, `effect/100`, `effectMonths` when not null (a row with none maps exactly as
  today, so the model deep-equals). `engineServices`: `priceRange: { low, high }` only when both are set and not both equal to
  `price`.

### 4.3 Migration test `packages/db/test/churn-chances-migration.test.ts`

`createTestDb({ upTo: "20270111000000" })`; insert for Northbeam every built-in driver row (price with `value` 10 and `month`
3), two custom drivers, services of each pricing model; snapshot `toEngineModel` of the seeded bundle; `applyMigrations`.
Assert: every row's old columns unchanged and new ones null; `toEngineModel` deep-equals the snapshot; `chance` 101, `effect`
-1, `effect_months` 0, a chance on `tenure` or `market`, `price_low` -1 are refused (direct insert, and through `save_fields`
for services); provenance is stamped for `chance`; a backup exported before restores (null columns) and one with the columns
round-trips them (`import-bundle.test.ts` covers the rest).

## 5. Sandbox: registry, SQL, runner

### 5.1 Registry (`packages/db/src/sandbox-levers.ts`)

- `SandboxLeverId` adds `A3`, `A5`, `B4`, `B5`, `D6`, `D9`. `timed` gains `"channel"`. `SandboxChange.params` becomes
  `SandboxParams` = `{ name?: string; low?: number; high?: number; chance?: number; months?: number; who?: "new" | "all" }`, with
  `paramsProblem(lever, params)` (only the lever's own keys). `target` gains `"lead_source_or_none"`, `"driver"`,
  `"role_or_none"`, `"service_or_none"` reused. New field `edit?: "leadSource" | "conversion" | "feeRange" | "roster" | "fees" |
  "driver" | "priceRise" | "hours" | "hireDelay"`: how a non-patch lever reaches the model (§5.4).

| ID | Label | Target | Ops (UI range) | Whole run | Timed | Capped | Kind | Pay | Offered |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Opportunities coming in | lead source or none | set 0–50,000 a month; × 0–5 | patch (none) / source edit | channel `leads` | no | `demand.enquiries` | none | yes |
| A3 **new** | Conversion rate | none | × 0–5 | channel from month 0 | channel `conv` | no | `demand.conversion` (control `"sandbox"`) | none | yes |
| A5 **new** | Client value range | service | set likely ≥ 0, params low ≤ likely ≤ high | model edit | channel `priceRange` (+ `newFee` for likely ≠ price) | no | `finances.prices` | none | yes |
| A6 | Traffic by type | service | as phase 1 (the dialog's % is the polish builder's) | patch | channel `mix` | no | none | none | yes |
| B1 | Clients on the book | service or none | set 0–2,000 a type; + ; × | patch (pooled) / roster edit §5.4 | no | no | `clients.count` | none | yes, roster too |
| B2 | Fees | service or none; params `who` (default `new`) | as phase 1 | `new`: patch; `all`: `fee` channel from month 0 | `new`: `newFee`; `all`: `fee` | no | `finances.prices` | none | yes |
| B3 | Base churn | service or none | set 0–1; × 0–5 | patch (pooled) / roster edit | channel `churn` | no | `clients.churn` | none | yes, roster too |
| B4 **new** | Churn driver as a chance | driver (built-in key or `custom:<id>`) | set effect 0–500%; params chance 0–100% (absent: measured or default), months 1–24 | model edit | channel `drivers` | no | `clients.causes` | none | with a client roster |
| B5 **new** | Price rise | service or none | set −100% to +400% | `fee` channel from month 0 + price driver | `fee` channel + price driver | no | `finances.prices` | none | yes |
| C1 | Role cost | role or `@busiest` | as phase 1 | patch | channel `roleCost` | no | `finances.roleCost` | role | **yes** (coordinator item 2) |
| C2 | Overheads a month | none | as phase 2 | patch | channel `overheads` | no | none | none | yes |
| D4 | FTE change | person | as phase 1 | patch | people rows; pinned/assigned: channel `capacity` | **no** | `people.hours` | none | yes |
| D5 | Headcount by role | role or `@busiest` | as phase 1 | patch | named people, an increase: hires (people over time); else splice | yes | `people.headcount` | none | yes |
| D6 **new** | Hours available | role or none | × 0.1–2 | channel from month 0 | channel `capacity` (each of the role's people) | no | `people.hours` | none | yes |
| D9 **new** | Hiring delay | none | set 0–6 whole months | runner (§2.6) | no | no | `people.starters` | none | yes |
| E1, E2, E3 | Step time, waiting, rework | step or `@heaviest` | as phase 1 | patch | channels `work`, `wait`, `rework` | **no** | as phase 1 | none | yes |
| E6 | Solution goes live | solution | as phase 1 | splice | splice | yes | none | none | yes |

D1–D3, X1–X3 unchanged. Only D5 and E6 count toward the 6 change months now. No new `LEVER_KIND_IDS` (all kinds exist);
`demand.conversion`'s `LeverControl` moves from `"later"` to `"sandbox"` in `lever-catalogue.ts`. ADR 0021 gets a dated note:
C1 offered, channels, D4 uncapped.

### 5.2 SQL (`20270112000000`, create or replace)

`private.sandbox_levers()` (keep `language sql immutable`, **no** `set search_path`, so it inlines; `20270111000000` point 1),
the 25 rows with `timed` now `'no' | 'people' | 'splice' | 'channel'`:
A1 `id_or_none` channel uncapped; A3 `none` `{multiply}` channel; A5 `id` `{set}` channel; A6 channel; B1 `id_or_none` `no`;
B2 `id_or_none` channel; B3 `id_or_none` channel; B4 `id` `{set}` channel; B5 `id_or_none` `{set}` channel; C1 channel; C2
channel; D4 people **uncapped**; D5 splice capped; D6 `id_or_none` `{multiply}` channel; D9 `none` `{set}` `no`; E1–E3 channel
uncapped; E6 splice capped; the rest as now. Every change widens (targets `none` → `id_or_none`, capped → uncapped), so every
saved row still passes.

`private.is_sandbox_change`: the `20270111000000` body with
- value rules: `'A3'` 0–5; `'A5'` ≥ 0; `'B4'` 0–5; `'B5'` −1 to 4; `'D6'` 0.1–2; `'D9'` whole 0–6 (`~ '^[0-6]$'`);
- the params branch generalised: absent → true; not an object → false; else `case l.id` — `'D1'` as now; `'A5'` keys ⊆
  {low, high}, both numbers, `0 ≤ low ≤ value ≤ high ≤ 1e9`; `'B4'` keys ⊆ {chance, months}, chance number 0–1, months whole
  1–24; `'B2'` keys = {who}, `who in ('new', 'all')`; else false;
- `'A5'` requires params.

`private.is_sandbox_changes` is unchanged (it reads `capped` from the table). `parseChanges`/`changeProblem`/`valueProblem`
mirror it; `sandbox-scenarios.test.ts`'s shared case table gains every new lever, params case and the widened targets.

### 5.3 Why no new patch fields

B4, A5, B5, A3, D6, D9 and the roster forms of B1/B3 are **model edits and channels** applied by the runner, not
`PATCH_FIELDS`. That keeps `private.is_scenario_patch` (and `save_solution`), the `parsePatches` mirror test, `leverOfPath`'s
exhaustiveness and MCP `run_scenario`'s grammar unchanged. `patchOf` returns null for them, so `isPatchChange` is false and a
scenario holding one is not shown on the process page or to MCP (`loadScenarios` adapter), as a timed change isn't today.

### 5.4 Runner (`apps/web/src/lib/sandbox/`)

New `channels.ts`, `edits.ts`, `price-rise.ts`; `run.ts` and `use-scenario-run.ts` changed.

1. **Bundle edits before the model** (`edits.ts` `applyBundleChanges(bundle, changes)`): A1 with a source target edits that
   `leadSources` row's `volume_week` (whole run). A missing source is a `ChangeProblem`.
2. **Model edits** (`edits.ts` `applyModelChanges(model, changes, bundle)`), after `applyPatches`, in change order, whole-run
   changes only:
   - **B1 on a roster** (coordinator item 4). Client groups: the service's `clientGroups[s].count` (set/×/+, whole, 0–2,000; a
     service with no group gets one from its price, `churn_monthly_base`, `tenure_months` and the initial health); target none:
     ×/+ on every group (set needs a type). New group clients get the next `groupClientKey` indexes, so existing clients keep
     their streams. **Named roster (recommended):** add only: `n` synthetic clients `sandbox:<changeId>:<i>` on the service with
     the mean `mrr` and health of its active named clients (the service price and initial health when it has none), no
     assignments (shared by role, as group clients); a decrease is a `ChangeProblem` "Named clients can't be removed here: make
     them inactive in Settings, Clients". Rejected alternative: scaling everyone's weight (no per-client meaning).
   - **B3 on a roster:** groups → `clientGroups[s].churnMonthly`; named → `services[s].churnMonthly`; target none → all. Pooled:
     the phase-1 patch. The "Downturn" starter (`B3 ×1.5`, target none) therefore acts on Northbeam (coordinator item 6); saved
     scenarios with B3 now move on roster workspaces: PRD note.
   - **B2 `who: "all"`** (coordinator item 5) and **B5**: `fee[s or "*"]` from month 0 = the ratio (set: value ÷ current price;
     ×; +: (price + value) ÷ price; B5: 1 + value). B2 `new` stays the price patch. B2 `all` has no churn effect; the dialog
     points to B5 for a rise that carries churn.
   - **B5 forces the price driver on** for the run at its weight (Q2), unless it is in chance mode.
   - **B4**: the driver's `chance` (params, null when absent and measured), `effect` (value), `effectMonths` (params, default 3).
   - **A3**, **D6**: channel from month 0. **A5**: `services[s].priceRange` and `price` = likely. **D9**: §2.6, applied in
     `applyPeopleChanges` (hire start dates).
3. **Channels** (`channels.ts` `channelsOf(model, timed, bounds, monthStarts, startDate)`): every timed channel lever writes its
   month array from the month its `from` falls in (the `scenarioSegments` rule: on or before the start → month 0; at or after
   the horizon → `later`). Values act on the model after whole-run changes: a timed `set` is stored as the ratio to that value
   (absolute for `wait`, `rework`, `mix`); several timed changes to one target apply in month order then change order, each on
   the value in force at its month. `@busiest`/`@heaviest` resolve on the whole-run model. D6 and D4-fallback expand to person
   ids. D4 to 0 from a month becomes a leaver (D2 semantics). A5 timed writes `priceRange` and, for a likely ≠ price, `newFee`.
   Then `model.channels = { starts: monthStarts, … }`.
4. **Segments:** `scenarioSegments` makes segments only for `capped` changes in splice mode (D5 cuts and role-count models, E6).
   Each segment's model gets the same edits and channels. `MAX_SEGMENTS` stays 7.
5. **Pinned warm-up** (§1) and, with any B5 change, the **without-rise pair** B (same segments, B5 changes and the forced driver
   removed; when the scenario has nothing else, B is the live run, already cached). `ScenarioForecast` gains
   `priceRise: PriceRiseTradeoff | null`.
6. Whole-run figures: with one segment, `result.kpi` is now right for timed changes (no splice); the `spliced` flag stays for E6/D5.

## 6. UI

### 6.1 Settings

- **Churn drivers** (`settings/churn-drivers-settings.tsx`, `churn-drivers-actions.ts`, `lib/churn-drivers.ts`): each driver
  with `events !== "none"` gets "How it's counted": **Weight** (today) or **Chance and effect**. Chance and effect shows
  "Chance a month" (% ; measured drivers: "Measured: 4.2% a month" from `cause.chance`, a blank field means measured, typing
  overrides), "Raises that client's churn by" (%), "For" (months, 1–24, default 3); the weight slider greys. Switching pre-fills
  `equivalentEvents` and says "Same expected churn as the weight gave in the last run". `parseDriverPatch` and `DriverState`
  gain the three fields (null clears them, back to weight mode); `saveChurnDriver` writes them (built-in first-change insert
  carries them). The projection uses §2.3's `projectChurn`. Price: "Chance a month" reads "Clients who notice a rise", effect
  "per 10% rise". Help in `DRIVER_HELP`/`CONTROL_HELP` style, plain words.
- **Services** (`settings/services-settings.tsx`, `lib/services.ts` `SERVICE_FIELDS`): under price, "Fee range: lowest" and
  "highest" (blank = none; money; per pricing model "monthly fee", "price", "hourly rate"), help "Each new client's fee is
  drawn between these, most often near the fee above. Clients you already have keep theirs." A warning (not a refusal) when
  low > price or high < price: "The engine uses the fee as the end of the range."
- **Market** (`market-settings.tsx`): "Time to hire … don't change the simulation yet" becomes "Time to hire stretches the
  Sandbox's hiring delay; Late payments don't change the simulation yet."

### 6.2 Sandbox

- **Change dialog** (`components/sandbox/change-dialog.tsx`): A1's target picker "All opportunities" or a lead source; A5 three
  money fields (low, likely, high); B2 "Who pays it: new clients / new and existing clients"; B4 a driver picker (switched-on
  and off drivers, with "measured" shown) plus effect, chance (blank = measured or default) and months; B5 a % with "From
  [month]" and a note "Counts the clients a rise loses (Price changes driver)"; D6 a ×; D9 months. Registry ranges as above.
  `describe.ts` words each change ("PPC +8% from Mar 2027, for new and existing clients").
- **Price rise section** (`components/sandbox/price-rise.tsx`, new, after "Sales and money" in `sandbox-view.tsx`), shown
  when the scenario has a B5 change and the pair has run:
  - tiles over the run (mean, 10–90%): **Gained from clients who stay**, **Lost from extra leavers**, **Net change**,
    **Extra clients lost**;
  - the break-even line: "The rise pays for itself while it loses fewer than 6.2 extra clients over the run (it loses 2.1 now),
    or about 1.4 points of extra monthly churn." Estimated break-even says so;
  - a chart (`compare-chart.tsx`, one series with its band) of net change per month, zero line marked;
  - a table, months as columns: gained, lost, net, extra leavers;
  - help in `lib/forecast/help.ts` style: "Lost includes everything the rise changed besides the higher fees: clients who left
    because of it and the work and fees they would have brought. Worked out by running the same months without the rise."
- **Compare** (`sandbox-compare.tsx`, `lib/sandbox/compare.ts`): a "Net from price rises" row for columns with B5 (others "—").
  `CACHE_LIMIT` in `sim-pool.ts` from 40 to 48 (three columns may add their pairs).
- **Change list:** a chance-mode B4 shows "measured" or the %. Greyed reasons (`applies`): B4 without a client roster ("needs
  clients counted per service or by name"); B5/B2 per type on a pooled model.

## 7. Viewers and pay (B1, cut list item 9)

- No new lever stores an individual's pay. C1 is a role rate (`pay: "role"`), readable by every member today. A Viewer can't add
  changes; on a saved C1 change they see the role rate, as Settings shows it.
- Under `payHidden`, the role-cost channel changes nothing visible: labour, overtime cost and profit stay null (phase 2 rule);
  the C1 change still lists. Revenue, the price-rise trade-off, clients, churn causes and fee ranges are not pay: shown to
  Viewers. Settings' new driver and range fields are read-only for Viewers (as now).
- Share links: services' `price_low/high` follow `price` (kept, Financials toggle unchanged); drivers' new fields are numbers.

## 8. MCP

**No read tool's output shape changes.** `Kpis` gains nothing (new totals go to `samples`, `monthly`, `monthlySamples`,
`churnCauses`), so `run_scenario` (`summarizeRun` returns `kpi`) and `compare_scenarios` return the same keys; only
`engine_version` reads 1.12.0. `get_facts` (rule 10 from `churnCauses` shares) is unchanged for every workspace that sets no
chance. No `PATCH_FIELDS` change, so `run_scenario`'s path description stays. `packages/mcp/test/read-only.test.ts` passes
unchanged. Scenarios with the new levers are not standalone patch scenarios, so `loadScenarios` (and `compare_scenarios`,
`check_robustness`, `list_issues`) leave them out, as timed scenarios already are.

## 9. Tests

**Engine** (`packages/engine/test/`), new **`chances-hand.test.ts`** in the style of `money-hand.test.ts` (tiny deterministic
models, constant times, numbers worked from the inputs):
- One group of 100 clients, base churn 0.0433 a month (0.01 a week), no servicing, no market: weight mode, `results` 6 at
  weight 1 → pressure 0.5, weekly 0.015; chance mode chance 1 effect 0.5 → **identical result** (`toEqual`).
- Entered chance 1 for every client, effect 1, months 1: weekly chance doubles while hit: expected clients lost in week 1 = 100 ×
  0.02; `chance` reported 1, `exposure` 1.
- Chance 0: no draw (stream never created; spy on `Streams.get` or check `churnCauses` exposure 0) and results equal to the
  driver switched off.
- Hit extension: a measured `load` hit each tick keeps exposure 1; months 2 → the effect lasts 2 × 52/12 weeks after the last hit.
- Price: one named client, fee 4,330 (1,000 a week), 13 weeks, 52/12-week months (`starts: [52/12 × 40, 2 × 52/12 × 40]`),
  `fee` 1 → 1.1 from month 2 (week 8.667), no churn: revenue = 1,000 × 8.667 + 1,100 × 4.333 = 13,433.33; `revenue.rise` =
  433.33. With churn on and the driver in weight mode: pressure `2 × 0.1 = 0.2` for 13 weeks from week 8.667 only.
- Fee range: one-off service, low 1,000, price 2,000, high 6,000, 3,000 wins over 30 reps: mean price within 1% of 3,000;
  a degenerate range draws nothing (results equal to no range).
- Channels: constant distributions; `work` ×0.5 from month 0 equals the patch `steps.x.work_hours ×0.5` exactly; `wait` 0 → 8 h
  from month 1 adds 8 h waits only after month 1; `rework` 0 → 0.5 creates the redo loop; `roleCost` ×2 doubles month labour
  only after its month; `capacity` ×0.5 halves paid hours and monthly capacity from its month; `overheads` ×2.
- `activeChannels`: neutral arrays leave every result deep-equal to no channels, for every golden model.

Also: `churn-drivers.test.ts` (`resolveChurnDrivers` events, tenure/market ignore effect, `equivalentEvents`, `projectChurn`
chance mode), `market.test.ts` (conv channel × market), `demand.test.ts` (leads channel edges), `simulate.test.ts`
(`initialState` option, §1), `money.test.ts` (rise in revenue identity: total = recurring + one-off + hourly; rise ⊂ total).
Goldens: §3.

**DB** (`packages/db/test/`): `churn-chances-migration.test.ts` (§4.3); `sandbox-scenarios.test.ts` (shared SQL/TS cases for
every new lever, params and widened target; `sandbox_levers()` = `SANDBOX_LEVERS`; existing migrated rows still pass);
`churn-drivers.test.ts` (RLS and constraints for the new columns); `model.test.ts` (driver chance/effect and service range map;
none → deep-equal today); `services.test.ts` (the range columns); `workspace-import.test.ts` (allow = `IMPORT_COLUMNS`);
`json-columns.test.ts`, `function-types.test.ts` after `gen:types`.

**Web** (`apps/web/test/`): `sandbox-run.test.ts` (the §1 cases; `channelsOf` per lever, set-as-ratio, two timed changes on one
target, `@busiest` resolution, D4 fallback → capacity, D4 to 0 → leaver; segments only for D5/E6; B1/B3 on groups and named
rosters; the Downturn starter now changes Northbeam's churn); `sandbox-levers.test.ts` (C1 offered, kinds ⊆ `LEVER_KIND_IDS`,
`applies` reasons now absent for B1/B3 on rosters); new `price-rise.test.ts` (`priceRiseTradeoff` on fabricated samples: net =
gained − lost per replication, break-even, estimated fallback, months before the rise exactly 0 on the demo pair);
`sandbox-compare.test.ts` (the net row); `churn-drivers.test.ts` (parse and states); `services.test.ts` (range fields);
`actions-database.test.ts` (saving a B4/B5/A5 scenario; `saveChurnDriver` chance fields; Viewer refused);
`lever-catalogue.test.ts` (`demand.conversion` control).

**Browser** (`sandbox-browser.test.ts`, `settings-browser.test.ts`, at 1440, 640 and 400 px, no console errors): add a B5 +8%
from a month in the demo → the price-rise section shows tiles, break-even, chart and table; a B4 with chance; a C1 timed change
(one run: progress 1/1); B1 +5 on a group type; a Viewer sees the trade-off and no costs; Settings → Churn drivers switch to
chance and effect (the projection moves), Settings → Services fee range.

**Perf**: §10.

## 10. Performance

Targets: PRD §6.7 (9 steps/6 people/13 weeks < 150 ms; seeded Northbeam < 250 ms; 40 steps/25 people/26 weeks < 1.5 s;
12-month forecast < 5 s), scaled by horizon in `horizon-performance.test.ts`; Sandbox segment < 4 × 250 ms at 12 months.

- **Gain from channels:** the phase-1 worst case (`sandbox-performance.test.ts`: five timed A1 months, E6, D1, D3, D2) drops
  from 7 runs to 2 (the E6 month only). Any scenario of channel and people levers is one run at any number of months; three
  compared scenarios of that kind are 3 runs plus the cached live run instead of up to 21. Levers moved off splicing: A1, A6,
  B2, B3, C1, C2, D4 (fallback), E1, E2, E3 (and the new A3, A5, B4, B5, D6). Still spliced: E6, and D5 cuts or role-count models.
- **Cost of the new work per run:** a binary search over ≤ 24 starts per lookup when channels exist (none otherwise: a null
  check), up to 24 `capacity` events, per-client hit draws in chance mode with run merging off, a per-client price pressure.
  The heaviest case is chance mode on large groups: 2,000 clients × 12 drivers × 52 ticks × 30 replications.
- **Tests:** keep `sandbox-performance.test.ts`'s 7-segment case but build it from capped changes (six D5 cuts and E6 months);
  add "a channel-heavy scenario is one run": A1 in five months, E1/E2/E3/C1/C2/D6 timed, B5 with the price driver, B4 chance
  mode on four drivers → 1 segment, < 1.1 × the no-change run and < 1 s at 12 months; add to `horizon-performance.test.ts` a
  12-month run of Northbeam with 2,000 clients per group and three drivers in chance mode < 5 s.
- **Budget:** `test:perf` (engine and web), parent commit vs branch, alone, best of 3: no existing case more than 5% (or 10 ms)
  slower. The phase-1 segment margin (about 0.7 s of 1 s) is not spent: a model without channels or chance mode takes the old
  paths. Record before/after in `docs/engine-versioning.md`.

## 11. Out of scope

Phase 4: time by purpose (G), `steps.purpose`, hands-on hours per step output. Phase 5: goal seek, tornado, exports, scenario
share links, MCP `list_scenarios`/saved `run_scenario`, the runner moving to `packages/db`. Also: the A6 % dialog (polish
builder); A2 lead quality, A7 seasonality, A8 growth and A9 a scenario market as levers; D7 speed, D8 skills, D10 compounding
pay inflation, E4 routing, E5 who does a step, E7 WIP, E8 variability; the market's `pay` (late payments) and the market's
52/12-week months; removing named clients in the Sandbox; an overtime premium; F2/F3 in the UI; client health, named clients
joining or leaving, delivery hours and service levels as levers (Austin, 28 Oct).

## 12. Done when

- §1's test passes: months before every kind of timed change equal the live run exactly.
- Every existing golden value unchanged; `northbeam-chances` and `northbeam-channels` approved at 1.12.0 with the ledger;
  browser determinism green.
- The migration runs on the real-data preview (a throwaway Neon branch: copy at the base, then `migrate`): driver and service
  counts before and after equal, every new column null, `select count(*) from public.sandbox_scenarios where not
  private.is_sandbox_changes(changes)` = 0; a workspace's model unchanged. Row in `docs/production-migrations.md`.
- In the demo as an Agency admin: a B5 rise shows its trade-off; a B4 chance changes churn and its cause shares; B1 and B3 work
  on Northbeam's groups and the "Downturn" starter raises churn; C1 is offered; a scenario of timed channel levers runs once
  ("1 of 1"). A Viewer sees the trade-off and no costs.
- Perf within budget and recorded; generated files regenerated; `pnpm lint && pnpm typecheck && pnpm test` green.
- Docs: `engine-versioning.md` (§3); PRD dated notes on D28 (chances), D29 (`hire` through D9; `pay` still unused), §13
  (rise revenue, the trade-off, fee range), and that B1/B3 act on rosters; ADR 0021 note; `sandbox-design.md` D10 corrected.

## 13. Open questions for Opus (recommended defaults)

1. **Switching a driver to chances:** chance mode only when an effect is set; existing rows stay in weight mode; nothing is
   migrated. *Default: yes,* with the "same expected churn" pre-fill. Alternative (convert everyone) moves results.
2. **B5 and a switched-off price driver:** the Sandbox turns it on at its weight for that run, with a note. *Default: yes.*
   Alternative: a rise with no churn unless the driver is on (that is what B2 "all" is for).
3. **Settings' own planned price rise** (`price` driver value and month) stays churn only, no fee change, and adds to a B5 rise's
   pressure. *Default: keep*; making it raise fees would move live results. Revisit with Austin.
4. **Named roster, B1:** add synthetic average clients; decreases refused. *Default: as §5.4.*
5. **B3 on rosters moves saved scenarios** (the Downturn starter included). *Default: accept, PRD note* (coordinator item 6).
6. **D10 pay inflation:** C1 from a month covers it; `pay` stays late payments. *Default: no compounding lever in phase 3.*
7. **D9:** delays scenario hires only, whole months, by delay × the market's hire factor. *Default: in scope as §2.6.*
8. **Price effect units:** a price driver's effect is per 10% rise. *Default: yes* (matches today's "10% → +20%").
9. **The trade-off's "lost"** includes knock-on effects (work and fees the leavers would have brought). *Default: yes, labelled.*
10. **Warm-up pinning** uses the whole-run-only model's warm-up. *Default: yes*; the Overview and People page keep their own.
11. **Hits during the warm-up** carry into the window (a client hit in week −2 is still affected). *Default: yes*, as health does.
12. **Fee range for existing group clients:** none (they keep `fee`). *Default: yes*; a group range is a later lever.
