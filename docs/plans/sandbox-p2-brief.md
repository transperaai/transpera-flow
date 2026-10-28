# Sandbox phase 2: profit first (build brief)

Opus brief, 28 Oct 2026. Source: `docs/plans/sandbox-design.md` (section C "Money" C1–C3, "What it shows", build order
phase 2: "Profit first (Austin, 28 Oct)"). Built on `claude/supabase-migration-plan-mzchlf`, **in parallel with phase 1**
(the scenario model and the Sandbox page, its own brief). Phase 2 owns the engine, the model loader, the outputs, one
Settings field and a temporary money view on today's Forecast page and plan compare, so Austin can QA profit before the
Sandbox page exists. Read `CLAUDE.md`, `docs/engine-versioning.md` and PRD §6.4, §6.7 and §13 first.

## What exists today (verified)

- **Revenue.** `simulate.ts` `runOnce` books `billed` (one number per replication): with a client roster, `bill()` accrues
  each client's `weeklyBill` between `since` and its churn tick or the horizon; without one, `reachEnd()` adds a won
  retainer's expected weeks (`weeksBilled`) and a one-off's fee. Pooled interim clients (`activeClients`) are **not** in
  `billed`. `MonthlyReplication.mrr` is recurring revenue only. **Hourly services earn nothing:** `addWonClient` gives
  them `weeklyBill` 0, `resolveServices` gives them `value` 0, and the pooled path skips them (comment in `reachEnd`).
- **Labour.** `kpi.labour` / `labourOf()` is *pipeline* hands-on hours × role `cost` (PRD §13 "cost per unit"). Nobody's
  paid hours are costed.
- **Overtime rule in use today** (`runOnce`, the people loop after `const weeks = model.horizonWeeks`): a person works
  overtime only while `overloaded(p)` (`overtimeCap > 0` and their client load exceeds capacity); overtime =
  `min(max(0, overOngoing + overPipeline − capacity × overWeeks), overtimeCap × capacity × overWeeks)`; cost =
  overtime hours × `p.person.cost ?? mean of their roles' cost`, **at the plain rate (no premium)**. `monthlyOut()`
  applies the same formula month by month (`personOvertime`), so monthly overtime need not sum to the window's.
  `overtimeCost` is `null` when `model.payHidden` (PRD §13 "Overtime cost = overtime hours × cost rate").
- **Settings.** `workspaces.settings.overhead_monthly` and `target_margin` are listed in `COMPANY_FIELDS`
  (`packages/db/src/company.ts`) and guarded in share snapshots (`GUARDED_SETTINGS` in `packages/db/src/share.ts`,
  `private.share_snapshot_problem` in `20270104000000_strip_followups.sql`), but no screen writes them, `WorkspaceSettings`
  (`packages/db/src/types.ts`) has no field for them, and `toEngineModel` doesn't read them. The only shape checks on
  `settings` are `workspaces_currency_code` (`20261201000000_manual_entry.sql`) and `create_workspace`'s key checks.
  `save_fields` writes any `settings.<key>` (validation is in the server actions, e.g. `saveOvertimeCap` in
  `apps/web/src/app/w/[slug]/settings/actions.ts`), and a restore merges `settings` wholesale (`settings || (pl -> 'settings')`).
- **`services.margin`** is mapped to `EngineService.margin` and read by nothing.
- **Pay privacy.** `hidesPay(bundle)` (`packages/db/src/model.ts`) sets `payHidden` for a Viewer (`!viewer.seesEveryone`)
  and for share bundles; then no person carries `cost`. `can_see_people(ws)` = `can_edit_workspace(ws)` = Owner or Agency
  admin (`20270103000000_three_roles.sql`). Role rates (`roles.default_cost_rate`) are readable by Viewers.
- **Patches.** `PATCH_FIELDS.finances = ["retainer"]` (`packages/engine/src/scenario.ts`); `applyPatches` handles every
  `finances` path as `m.retainer` (`case "finances"`). The SQL twin is `private.is_scenario_patch`
  (last defined in `20261017000000_health_patches.sql`), used by `scenarios.patch` and solution levers.
- **Golden models:** northbeam, northbeam-seeded, northbeam-downturn, northbeam-groups, northbeam-drivers, larkspur
  (`packages/engine/test/golden.ts`); none has an hourly service, an overhead or monthly output. `ENGINE_VERSION` is 1.10.0.

## Where phase 1 and phase 2 meet

| Seam | Phase 2 owns | Phase 1 does |
|---|---|---|
| `packages/engine/src/model.ts` | `EngineModel.overheadMonthly`; the new fields on `ReplicationResult`, `Kpis`, `ReplicationSamples`, `MonthlyReplication`, `MonthlyResult` exactly as named below (the contract) | Reads them on the Sandbox page; adds no field to these types |
| `scenario.ts` | `PATCH_FIELDS.finances` gains `"overhead_monthly"`; the `finances` branch of `applyPatches` | Maps lever C2 "Overheads" (whole run) to the patch path `finances.overhead_monthly`; timed overheads wait for the phase 3 channel |
| `private.is_scenario_patch` | Redefined in phase 2's migration with `finances\.(retainer\|overhead_monthly)` | If phase 1 redefines it (or writes its own `sandbox_scenarios.changes` check), it copies the latest body, keeps that alternative |
| Migrations | `20270108000000_overheads.sql` | Uses `20270106000000`/`20270107000000`. The runner applies any unapplied version (`appliedVersions` in `packages/db/src/migrations.ts`), so merge order doesn't matter; on a clash, the second to merge renames |
| `apps/web/src/lib/forecast/splice.ts` | Adds the new monthly fields as flows | If phase 1 moves or replaces splicing for scenarios, it carries the new fields |
| Money view | `apps/web/src/lib/forecast/money.ts` (pure) and `apps/web/src/components/forecast/forecast-money.tsx` | The Sandbox page imports both; when it replaces the Forecast page and plan compare, the phase 2 edits there go with them |
| Golden files, `version.ts`, `golden/versions.json` | Bumps to 1.11.0 | If phase 1 also bumps, the second to merge re-runs `golden:approve` after rebasing; never hand-merge baselines or the ledger |

Phase 2 touches no Sandbox, scenario-table or plan-storage code.

## 1. Engine (`packages/engine`)

Money is in the workspace currency; hours are working hours; a "month" is a run month from `bounds` (the Forecast passes
calendar month starts, `calendarMonthStarts`). **Nothing below draws a random number or reorders an existing sum**, so no
existing golden number may move; only the new outputs and the new golden model change the baselines.

### 1.1 Types (`model.ts`)

```ts
// EngineModel
/** Fixed costs a month (rent, tools), per 52/12-week month. Omitted or 0: none. Not pay: kept when payHidden. */
overheadMonthly?: number;

// ReplicationResult
revenue: { recurring: number; oneOff: number; hourly: number; fromNew: number };  // see 1.2; total = recurring + oneOff + hourly
hourly: Record<string, { hours: number; revenue: number }>;                        // per hourly service id (present, 0, when none billed)
labourCost: number | null;   // paid hours × rate (1.4), overtime excluded; null when payHidden
overheads: number;           // overheadMonthly × horizonWeeks / (52/12)
profit: number | null;       // revenue total − labourCost − overtimeCost − overheads; null when payHidden

// Kpis
revenue: Stat;               // total billed revenue, new definition (1.2); `billed` stays as it is
revenueHourly: Stat;
hourly: Record<string, { hours: Stat; revenue: Stat }>;
labourCost: Stat | null;
overheads: number;
profit: Stat | null;

// ReplicationSamples
revenue: number[];
profit: number[] | null;

// MonthlyReplication (one entry per month, totals over the month)
opportunities: number[]; won: number[]; lost: number[];
clientsWon: number[]; clientsLost: number[];
revenueRecurring: number[]; revenueOneOff: number[]; revenueHourly: number[]; revenueFromNew: number[];
mrrLost: number[];
labour: number[] | null; labourByRole: Record<string, number[]> | null; labourByPerson: Record<string, number[]> | null;
overtimeCost: number[] | null;
overheads: number[];

// MonthlyResult
sales: { opportunities: Stat[]; won: Stat[]; lost: Stat[]; conversion: Stat[] };
clientsWon: Stat[]; clientsLost: Stat[];
revenue: { total: Stat[]; recurring: Stat[]; oneOff: Stat[]; hourly: Stat[]; fromNew: Stat[]; lostToChurn: Stat[] };
overtimeHours: Stat[];       // Σ of each replication's personOvertime that month
money: {
  labour: number[];          // deterministic: paid hours × rate (no overtime)
  labourByRole: Record<string, number[]>; labourByPerson: Record<string, number[]>;
  overtimeCost: Stat[]; overheads: number[]; profit: Stat[];
} | null;                    // null when payHidden
```

Update the doc comments that say hourly earns nothing (`PricingModel`, `MonthlyReplication.mrr`, `ServiceState.value`)
and `EngineService.margin` ("not used; profit comes from paid hours, see 1.6").

### 1.2 Revenue, and exactly which hours an hourly service bills

**Recurring** (`revenue.recurring`): every active client's fee, pro rata while active in [0, H].
- Roster (named clients or client groups): in `bill()`, beside `billed += …`, add the same amount to `recurring` (and to
  `fromNew` when `!rc.roster`), and `spread()` it into `mon.revenueRecurring` (and `revenueFromNew`) over [from, to].
  So with a roster `recurring + oneOff === billed` exactly (a test).
- Pooled: track `pooledMrr` **always** (today only when `mon`; it draws nothing, so no number moves) and a `pooledNewMrr`
  (wins only). New helper `accruePooled(t)`: adds `pooledMrr / WEEKS_PER_MONTH × (clip(t) − clip(last)) / hpw`, clip to
  [0, H], then sets `last = t`. Call it before every change to `pooledMrr`: in `reachEnd` before the `+=`, in `churnTick`
  before the decay, and once at H after the event loop. Pooled `recurring` therefore **includes the interim clients**,
  unlike `billed`; documented, and `billed` is left alone (goldens and PRD §13).

**One-off** (`revenue.oneOff`): in `reachEnd`, where `billed += price × factor` for a one-off, add the same to `oneOff`
and `fromNew`, and to `mon.revenueOneOff`/`revenueFromNew` at `monthOf(t)`.

**Hourly** (`revenue.hourly`). Rule: **a client's entered fee is its bill.** Existing clients (a named client's `mrr`, a
client group's `fee`) keep billing that, whatever their service's pricing, so nothing already simulated moves and nothing
is counted twice. Hourly billing applies to **work for clients won during the run on an hourly service**, at
`rate = service price × the market's price factor in the month it was won` (as a retainer's fee is fixed at its win).
The hours that count:

1. **Post-sale pipeline work:** hands-on hours at any step visited after the entity reached its first `won` end (onboarding,
   delivery after a hand-off), when its service is hourly. `SimEntity` gains `rate: number` (set to 0 in all three
   entity literals: `seedWip`, the `arrive` branch, `createTask`, so the object shape stays monomorphic), set in
   `reachEnd` on a win at t ≥ 0. Exclude `rate` from traces in `toTrace`'s destructure.
2. **Servicing tasks** of a won hourly client: `e.task.client` has `!roster`, is `active` when the work starts, and has
   `hourlyRate > 0`. `RosterClient` gains `hourlyRate`, `hourlyWeekly`, `hourlySince`; `addWonClient` sets `hourlyRate`.
3. **Ongoing (fallback) client hours carried** for a won hourly client while active: `hourlyWeekly` = the sum of the
   hours in its shape's `parts` (not `uncovered`: work nobody of the role is there for is not worked). New
   `billHourly(rc, t)` accrues `hourlyRate × hourlyWeekly × (clipped weeks)` from `hourlySince`; call it in
   `removeClient`, in `restaff` before a client's shape is replaced (then recompute `hourlyWeekly`), and for every active
   client at H. **Do not call `bill()` from `restaff`**: splitting its interval would move `billed` in the last digit.
4. **Pooled model:** hourly wins add `rate` to a `pooledHourly` sum that decays with `pooledMrr` at each tick; each bills
   Σ `role.ongoing` over roles with `poolCapacity[rid] > 0` hours a week, accrued in `accruePooled`.

Items 1–2 are booked in `startService` when `p` is set: amount = `handsOn × rate × (overlap of [t, t+dur] with [0, H]) / dur`
into `hourly` and `hourly[service]`, and `spread(mon.revenueHourly, 0, t, t + dur, handsOn × rate)` (spread clips the same
way). Because only in-window parts are ever added, **no reset is needed in `startMeasuring`** (a job straddling t = 0
counts its in-window part). Repeat passes (rework) count: they are hours worked. Not counted: selling time before the
win, work for existing clients, uncovered work, wins during the warm-up (discarded, as they add no client today).
All hourly revenue is also `fromNew`. An hourly service whose clients generate no work earns 0 (`hourly[id].hours` 0;
the UI says so, §5).

**Lost to churn** (`mrrLost`): the monthly fee (`weeklyBill × WEEKS_PER_MONTH`) of each roster client removed in
`churnTick`, at `monthOf(t)`; pooled: `pooledMrr` before − after the decay. Churn happens at weekly ticks, so a client
"churning mid-month" bills to its tick and its lost fee lands in the tick's month (the tick closing a week on a month's
first hour belongs to the month before, as for `clients`: use `monthOf(max(0, t − 1e-6))`).

### 1.3 Sales and clients series

- `opportunities`: the `arrive` branch of the event loop, t in [0, H) (qualified arrivals, as `leadsPerWeek` is qualified).
- `won`, `lost`: in `reachEnd` at t ≥ 0, beside `won++` / `lost++`.
- `conversion` (MonthlyResult only): `ratioStat(won, won + lost)` per month (ratio of sums for the mean, per-replication
  ratios for the band; `ratioStat` exists in `simulate.ts`). Items ending `done` unwon don't count.
- `clientsWon`: wins whose service isn't `one_off` (they become clients). `clientsLost`: roster churn events; pooled,
  `before − active` at the tick (fractional).

### 1.4 Labour cost (paid hours × rate)

- **Rate:** extract the overtime loop's rate expression into `rateOf(p)` (`p.person.cost ?? mean of own roles' cost`) and
  use it for overtime and labour (same arithmetic, so overtime cost doesn't move).
- **Paid hours:** contracted capacity while on the team: `capacity × presentWeeks(p.person)` (the existing helper, which
  clips `from`/`until` to [0, H]). **Leave is paid** (it is in the paid hours; it only reduces hours available). A hire
  from mid-month is paid from `from`; a leaver until `until`. Role-count models are covered: `resolvePeople` synthesises
  their people.
- `labourCost = Σ paid × rateOf(p)`; null when `model.payHidden` (rates there are role means standing in for hidden pay).
- **Monthly** (in `monthlyOut`): per person and month, `capacity × presentHours(p, a, b) / hpw × rateOf(p)` where
  `presentHours` is the overlap of [a, b] with [startsAt, endsAt) (not `awayHours`, which also takes leave off);
  `labourByRole` splits each person evenly over their roles, as `roleCapacity` does. `overtimeCost[m] =
  Σ personOvertime[m] × rateOf(p)`. All null under `payHidden`.
- `kpi.labour` (pipeline labour, cost per unit) is unchanged.

### 1.5 Overheads and profit

- `overheads = overheadMonthly × weeks / (52/12)` for the window, and per month `× weeks(m) / (52/12)`, so 12 months of
  a 52-week run cost exactly 12 × the figure; calendar months vary by their working days (±5%), which is documented.
- **Profit per replication** = `recurring + oneOff + hourly − labourCost − overtimeCost − overheads`; per month the same
  with that month's values, and `MonthlyResult.money.profit[m] = stat(per-replication profit)` (not a difference of
  means). Monthly overtime is per month (as today), so Σ monthly profit can differ slightly from `kpi.profit`; say so in
  the help.
- `MonthlyResult.money` and `kpi.labourCost`/`profit` are null when `payHidden`; `overheads` and revenue never are.

### 1.6 `services.margin`

**Stays unused** (recommended): profit comes from the hours actually paid, so applying a margin as well would count the
cost of delivery twice. Keep the column and the field; change the Settings hint (§4) to say it is recorded, not used.

### 1.7 Where in `simulate.ts` (runOnce unless said)

| Change | Place |
|---|---|
| New `mon` arrays (`opps`, `won`, `lost`, `clientsWon`, `clientsLost`, `revRecurring`, `revOneOff`, `revHourly`, `revNew`, `mrrLost`: `Float64Array(nM)`) | the `const mon = sampleMonthly ? {…}` block (`mon.arrivals` is per step; don't reuse the name) |
| `recurring`, `oneOff`, `hourly`, `fromNew`, `hourlyBy` accumulators; `pooledMrr` unconditional; `accruePooled` | beside `let billed = 0` and `let pooledMrr` |
| Roster recurring and `billHourly` | `bill`, `removeClient`, `restaff`, `addWonClient`, after the loop (`for (const rc of rosterClients) bill(rc, H)`) |
| Hourly hands-on | `startService` |
| Wins, losses, one-offs, entity `rate`, pooled hourly | `reachEnd` |
| Opportunities | the `arrive` branch of the event loop |
| Churn: `clientsLost`, `mrrLost`, pooled accrual and decay | `churnTick` |
| `rateOf`, `labourCost`, `overheads`, `profit`, `revenue`, `hourly` in the result | the people loop and the `return {…}` of `runOnce` |
| Monthly labour, overtime cost, overheads | `monthlyOut` |
| Stats | `monthlyResult`, `kpis`, the `samples` in `simulate` |

Export nothing new from `index.ts` except the new types (`MonthlyMoney` if named).

## 2. ENGINE version and golden files

1. Add a golden model **`northbeam-money`**: `northbeamWithClientGroups()` with `overheadMonthly: 18000` and the PPC
   service switched to `pricingModel: "hourly"` at `price: 95` (new fixture `northbeamWithMoney()` in
   `packages/engine/src/fixtures/northbeam.ts`), run with `{ monthly: true }`: add an optional `options?: SimulateOptions`
   to the golden model type in `test/golden.ts` and pass it in the harness.
2. Extend `keyOutputs`: `money: { revenue, revenueHourly, labourCost, overheads, profit }` (Stats, `!` on the nullable ones
   as `overtime.cost` does), and for models run monthly, `monthly: { opportunities, won, lost, conversion, revenue total,
   recurring, hourly, lostToChurn, overtimeHours, labour, overtimeCost, profit }` as means per month.
3. `pnpm --filter @transpera-flow/engine golden:approve "Profit first (sandbox phase 2): billed revenue incl. hourly work for clients won in the run, paid labour, overheads and profit, and monthly sales, revenue and money series; northbeam-money golden model. No existing simulated number moved."`
   It bumps `ENGINE_VERSION` to 1.11.0 and appends the ledger. **Check the printed diff: only added keys and the new
   model.** Any moved existing value is a bug (an existing sum reordered or a draw added): fix it, don't approve it.
4. `browser-determinism.test.ts` picks up the new model; it must pass.
5. Commit baselines, ledger and `version.ts` with the engine change. Add a section "Profit (engine 1.11.0)" to
   `docs/engine-versioning.md` (rules of 1.2–1.5, the hourly rule, the pooled `recurring` vs `billed` difference, the
   timing table from §7).

## 3. Model loader and settings (`packages/db`)

- `WorkspaceSettings` (`src/types.ts`): `overhead_monthly?: number | null` with a doc comment. Run
  `pnpm --filter @transpera-flow/db gen:types` after the migration.
- `toEngineModel` (`src/model.ts`): `...(num(s.overhead_monthly) > 0 ? { overheadMonthly: num(s.overhead_monthly) } : {})`
  (use the file's `num` helper; null, absent, 0 or junk adds nothing, so every existing model is unchanged). It is kept
  under `hidesPay` (overheads are not pay). Share snapshots with Financials off already strip the key, so they get none.
- `target_margin`: untouched (open question 5).

### Migration `packages/db/migrations/20270108000000_overheads.sql`

Runs on real data (the production copy imported at `20261231000000`, then every later migration). Header comment as the
strip migrations do: what, why, rollback (`alter table public.workspaces drop constraint workspaces_overhead_monthly;` and
re-run the `is_scenario_patch` body from `20261017000000_health_patches.sql`).

```sql
select set_config('transpera.actor_kind', 'system', true);

-- 1. Normalise what is stored. Nothing in the app writes the key today, but the removed Suggestions could have, and a restore
--    merges settings wholesale. A plain number from 0 to 100,000,000 stays; a number written as a string becomes a number;
--    JSON null stays (it means "not set"); anything else is removed. CASE, not AND, so no cast runs on a non-number.
update public.workspaces w
set settings = case
    when jsonb_typeof(w.settings -> 'overhead_monthly') = 'string'
         and btrim(w.settings ->> 'overhead_monthly') ~ '^[0-9]{1,8}(\.[0-9]+)?$'
      then jsonb_set(w.settings, '{overhead_monthly}', to_jsonb(btrim(w.settings ->> 'overhead_monthly')::numeric))
    else w.settings - 'overhead_monthly'
  end
where w.settings ? 'overhead_monthly'
  and case jsonb_typeof(w.settings -> 'overhead_monthly')
        when 'null' then false
        when 'number' then not ((w.settings ->> 'overhead_monthly')::numeric between 0 and 100000000)
        else true
      end;

-- 2. The shape check, beside workspaces_currency_code. Validated at once: step 1 made every row pass.
alter table public.workspaces add constraint workspaces_overhead_monthly check (
  case
    when not (settings ? 'overhead_monthly') then true
    when jsonb_typeof(settings -> 'overhead_monthly') = 'null' then true
    when jsonb_typeof(settings -> 'overhead_monthly') = 'number'
      then (settings ->> 'overhead_monthly')::numeric between 0 and 100000000
    else false
  end) not valid;
alter table public.workspaces validate constraint workspaces_overhead_monthly;

-- 3. Scenario patches may set overheads (sandbox lever C2). The body of 20261017000000_health_patches.sql with one change:
--    '|finances\.retainer' becomes '|finances\.(retainer|overhead_monthly)'.
create or replace function private.is_scenario_patch(patch jsonb) returns boolean
language sql immutable
set search_path = ''
as $$ /* copy the 20261017000000 body verbatim, with the one alternative changed */ $$;
```

(The builder pastes the full body; the placeholder above is the only part of this brief that is not literal SQL.)
The first line marks step 1's writes as the system's, as `20270103000000_three_roles.sql` does. `create_workspace` needs no change (it refuses the key).

## 4. Settings and patch fields

- **Settings → Workspace** (`apps/web/src/app/w/[slug]/settings/workspace-details.tsx`, `WorkspaceDetails`): a
  `NumberField` "Overheads a month", money in the workspace currency, `min 0`, optional (blank removes it), disabled
  unless `canManage`, with help: "Fixed costs a month that don't depend on the work: rent, software, insurance. The
  forecast takes them off revenue with pay to show profit." Example: "18,000 a month is 216,000 over a 12-month forecast."
  Saver `saveOverheadMonthly(workspaceId, base, value)` in `settings/actions.ts`, modelled on `saveOvertimeCap`:
  `null` or a finite number 0–100,000,000, then `saveField("workspaces", { id }, "settings.overhead_monthly", base, value)`;
  passed in as a prop like `saveCurrency`.
- **Services** (`services-settings.tsx`): the margin hint and help become "Recorded for reference. Profit is worked out from
  the hours people are paid for, not from this."
- **Patch field** (`scenario.ts`): `finances: ["retainer", "overhead_monthly"]`; in `applyPatches`, `case "finances"`
  branches on `target.field`: `overhead_monthly` → `m.overheadMonthly = next(m.overheadMonthly ?? 0, 0)`, otherwise the
  retainer as today. `parsePatchPath` needs no change. No lever is added to `lever-catalogue.ts` (phase 1 owns lever UI).
  Role cost (C1) already patches as `roles.<id>.cost_rate` and now moves labour cost and profit.

## 5. Pay privacy (recommended, consistent with B1)

| | Owner, Agency admin | Viewer (`payHidden`) |
|---|---|---|
| Revenue (all series), sales, clients, overtime **hours** | yes | yes |
| Overheads | yes | yes in Settings (a company figure, not pay); not shown in the money view, which hides costs |
| Labour cost, overtime cost, profit, labour by role or person | yes | **no**: the engine returns null, the UI says "Costs and profit are shown to Agency admins and the Owner." |

Labour by role can reveal one person's pay in a one-person role, and total labour is the sum of individual pay, so all cost
and profit figures follow `payHidden`, as `overtimeCost` already does. Share links show no money view in phase 2.

## 6. Forecast page and plan compare (temporary home until the Sandbox page)

- **`apps/web/src/lib/forecast/money.ts`** (pure): `forecastMoney(result: SimulationResult, months: TimelineMonth[])` →
  tiles (revenue, labour incl. overtime, overheads, profit over the run: mean and 10–90%, from `kpi`) and table rows
  per month from `result.monthly`; `null` cost rows when `money` is null; `hourlyWithoutHours: string[]` (service names
  with `kpi.hourly[id].hours.mean === 0`).
- **`apps/web/src/components/forecast/forecast-money.tsx`** (`ForecastMoney`), rendered by `ForecastView` after the
  "Month by month" section, for the run on screen (the live forecast, or the selected plan's spliced run). Section
  "Sales and money": four tiles; a profit-per-month chart with its 10–90% band (extend `PlanCompareChart` to draw one
  series when `b` is absent, rather than a new chart); and a table, months as columns: Opportunities, Won, Lost,
  Conversion, Billed revenue (with recurring / one-off / hourly beneath), From new clients, Monthly fees lost to churn,
  Clients won, Clients lost, Overtime hours, Labour, Overtime cost, Overheads, Profit. Notes: "No overheads set" with a
  link to Settings → Workspace (Agency admins and the Owner); "Hourly service X earned nothing: no client work is
  modelled for its clients"; the Viewer note from §5.
- **Splice** (`splice.ts`): every new monthly field is a **flow** (month `m` from the segment holding `m`); `money` is null
  if any segment's is.
- **Compare** (`compare.ts` `comparePlans`, `plan-compare.tsx`): rows `profit`, `revenue` (total), `labour` (labour +
  overtime cost), `won`, `conversion`; `totals.profit: [number, number] | null` (sum of monthly means). A first tile
  "Profit over the run" and sections "Profit" and "Billed revenue" before "Monthly recurring revenue". Plans are for
  Agency admins and the Owner, but guard `money === null` anyway.
- Help text for each in `PLAN_HELP` (`apps/web/src/lib/forecast/help.ts`), plain words (D34).
- `/demo/...` forecast: works unchanged (no overheads; the note shows).

## 7. Performance

PRD §6.7: 9 steps/6 people/13 weeks < 150 ms; seeded Northbeam < 250 ms; 40 steps/25 people 26 weeks < 1.5 s; 12-month
forecast < 5 s; `apps/web/test/horizon-performance.test.ts` scales them by horizon (24 months = 8×). The new work is a
few array adds per arrival, win, tick and service start, and O(people × months) in `monthlyOut`; no new events.

- Add to `horizon-performance.test.ts` a case "24-month forecast with monthly output, full Northbeam and Larkspur:
  < 8 × 250 ms" calling `simulate(model, 30, 1, { monthly: true, monthStarts: calendarMonthStarts(…) })`.
- Measure before and after on the same machine, alone: `pnpm --filter @transpera-flow/web test:perf` and
  `pnpm --filter @transpera-flow/engine test:perf`, on the parent commit and on the branch, best of 3. **Budget: no case
  more than 5% slower** (or 10 ms, whichever is larger). Record both in the new `engine-versioning.md` section.
- If over budget: check `rate` is in every entity literal (shape), and that `accruePooled`/`billHourly` aren't called per
  event when there is nothing hourly or pooled (guard on a run-level boolean).

## 8. Tests

**Engine** (`packages/engine/test/`):
- `services.test.ts`: replace "hourly work is billed through servicing, which isn't simulated yet" with: a won hourly
  client bills its servicing hands-on hours × rate; post-sale pipeline steps bill, pre-sale don't; an existing group
  client on an hourly service bills its fee and no hours; tasks of a churned client don't bill; uncovered hours don't.
- `forecast.test.ts`: "pooled models count hourly clients as active but bill them nothing" becomes "… bill their ongoing
  hours"; monthly sums equal totals for one-off, recurring (roster) and opportunities/won/lost (Σ months =
  `kpi`/`services` counts); roster `recurring + oneOff === billed` exactly; pooled `recurring` includes interim clients.
- New `money.test.ts`: labour = capacity × weeks × rate for a constant team; a hire from month 3 is paid from month 3; leave
  is still paid; a leaver stops; role-count model; `rateOf` matches overtime's rate; overheads 12 × figure over 52 weeks;
  profit identity per replication; `payHidden` gives null labour, overtime cost, profit and `money`, and the same revenue;
  conversion is `ratioStat`; an hourly service with no work has `hours` 0.
- `scenario.test.ts`: `finances.overhead_monthly` set/multiply/add, clamped at 0; `finances.retainer` unchanged.
- Golden: §2. Existing goldens: only added keys.

**DB** (`packages/db/test/`):
- `model.test.ts`: `overhead_monthly` 18000 → `overheadMonthly`; absent, null, 0 → field absent (model deep-equals today's);
  kept for a Viewer bundle (with `payHidden`).
- `scenarios.test.ts`: `private.is_scenario_patch` accepts `finances.overhead_monthly`, still refuses `finances.margin`.
- New `overheads-migration.test.ts`: build to `20270105000000` (the runner's up-to option), insert workspaces with
  `"12000"`, `12000`, `-5`, `"abc"`, `null`, `true`, `2e9`; run the rest; expect `12000`, `12000`, removed, removed, null,
  removed, removed; then a write of `-1` or `"5"` is refused by `workspaces_overhead_monthly`, through `save_fields` and
  through a restore.

**Web** (`apps/web/test/`):
- `forecast.test.ts`: `forecastMoney` tiles and rows; Viewer (`payHidden`) gets no cost rows; the two notes.
- `forecast-plan.test.ts`: `spliceMonthly` treats every new field as a flow; `comparePlans` profit row and totals.
- The settings action: `saveOverheadMonthly` accepts null and 0–1e8, refuses negatives, strings and NaN.
- Existing MCP tests that snapshot `kpi` (it is returned whole by `run_scenario` in `packages/mcp/src/tools.ts`) updated for
  the added keys; under a Viewer token the cost keys are null.

`pnpm lint && pnpm typecheck && pnpm test` green with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`.

## 9. Docs

PRD §6.4 (outputs) and §13 (definitions: billed revenue, hourly billing, labour cost, overheads, profit, conversion), each
with a dated note "Added 28 Oct 2026, sandbox phase 2"; `docs/engine-versioning.md` (§2); the `EngineService.margin`
comment. Nothing verified only against plain Postgres needs `docs/supabase-notes.md` unless the migration test is.

## Out of scope

Timed overheads and the role cost and hours channels (phase 3); the market's `pay` and `hire` factors; client value
ranges, price-rise trade-off, churn drivers as chances (phase 3); "why they left" per driver per month and time to win;
an overtime premium; a contractor or unpaid-leave flag; cash flow and late payments; target margin lines; lever UI for
overheads (phase 1); MCP `list_scenarios`/`run_scenario` changes; issue costs (`cost.ts` `dealValue` keeps hourly at 0);
share-link money views; the Sandbox page itself.

## Done when

- Every existing golden value is unchanged; `northbeam-money` and the added keys are approved at 1.11.0 with the ledger.
- A workspace with overheads, an hourly service and planned hires shows, on the Forecast page as an Agency admin:
  revenue split three ways, labour, overtime cost, overheads and profit per month with 10–90% ranges, and the sales and
  client series; a Viewer sees revenue, sales and clients, and the note instead of costs.
- Plan compare shows profit and billed revenue for both plans.
- The migration runs on the real-data preview (copy at the base, then `migrate`) and the check holds.
- Performance within budget and recorded; `pnpm lint && pnpm typecheck && pnpm test` green.

## Open questions for Opus (recommended defaults)

1. **Hourly billing for existing clients:** their entered fee is the bill; only clients won in the run bill hours.
   *Default: yes.* Alternative (bill hours for every hourly client, ignore the fee) changes today's revenue numbers.
2. **Rework hours on hourly work:** billed (time and materials). *Default: billed.* Excluding them needs the loop flags
   at `startService`; cheap if Austin prefers it.
3. **Leave is paid.** *Default: yes*, no unpaid-leave or contractor flag in phase 2.
4. **Overtime premium:** none; overtime at the person's rate, as today. *Default: no new setting*; a
   `settings.overtime_rate` multiplier would be a small follow-up.
5. **`target_margin`:** left unread. *Default:* phase 3 or later may draw it as a line on the profit chart.
6. **`services.margin`:** stays unused (1.6). *Default: keep the column, change the hint.*
7. **Viewers and overheads:** shown in Settings, not in the money view. *Default: as §5.*
8. **Pooled revenue includes interim clients** while `kpi.billed` doesn't. *Default: keep both, documented*; changing
   `billed` would move golden numbers for no gain.
