# B7 build brief: forecast planning, drag markers, compare two plans (#36)

Scoped 6 Oct 2026 (overnight run) against `origin/main` at 01523297 (B1 2b, #205, merged; the audit base asked for,
`main` plus `claude/amazing-planck-64op6x`, has the same tree). Read `docs/plans/builder-brief.md` first; this brief adds
to it and wins where they differ. Build strictly from it. Austin is asleep: where this brief is unclear, take the
default in "Open questions" and say so in the PR. Don't invent beyond it.

Branch: `claude/b7-forecast-planning` (this brief is its first commit; build on it). Migration version
**`20261213000000_forecast_plans`**. Commit and push after every step below.

## The short version

B6 (#35, PR #191) built the Forecast page: the live company model run forward month by month (`simulate(…, { monthly:
true, monthStarts })`), "too busy" alerts as insights, and a hand-drawn SVG timeline with fixed markers for hires, end
dates and leave that come from Settings → People. B7 makes it a planning tool:

1. **Plan markers** (hire, leave, solution) on a new "Your plan" lane at the top of the timeline. Add, edit, drag
   (pointer) and move by keyboard, remove. Dropping one re-runs the forecast.
2. **Plans**: a named set of markers, saved in a new table `public.forecast_plans` (owners, editors and agency admins
   only). The demo keeps plans in the tab.
3. **Hire and leave markers need no engine change.** They become extra `people` / `person_roles` / `person_leave` rows in
   the bundle before `forecastModel` builds the model, exactly as a planned hire from Settings does today.
4. **Solution markers need no engine change either.** The engine can't switch a process's steps mid-run, so a plan with
   solutions is run once per go-live month (the model with the solutions live by then, all from month 0, same seed), and
   the monthly series are **spliced**: months before a solution's month come from the run without it; from that month on,
   from the run with it (stock series carried on from where they were, see "Splicing").
5. **One additive engine output** (no number moves, no `ENGINE_VERSION` bump): month-by-month MRR and clients at risk per
   service in `MonthlyResult`. The compare view needs both and the engine doesn't report them per month today.
6. **Compare two plans** (`?compare=a,b`; "No changes" counts as a plan): monthly recurring revenue, clients at risk per
   client group, how busy each role gets: both plans' averages and 10–90% ranges, and the difference.

| Part | What | Migration | Engine |
|---|---|---|---|
| 1 | Engine: `MonthlyResult.mrr`, `MonthlyResult.atRisk` | none | additive output, no bump (Q8) |
| 2 | `forecast_plans` table, RLS, loader, types | `20261213000000_forecast_plans` | none |
| 3 | Pure plan logic: apply markers, solutions, segments, splicing, positions, compare data | none | none |
| 4 | UI: plan bar, plan lane with drag and keyboard, marker dialog, "with this plan" summary, compare view, demo store | none | none |
| 5 | Tests (unit, database, browser), docs | none | none |

One PR, `Closes #36`. **Build order**, committing and pushing after each: (1) engine outputs and their tests; (2)
migration, apply file, bootstrap, types, loader, database tests; (3) `plan.ts`, `splice.ts`, `positions.ts`,
`compare.ts`, demo additions and their unit tests (including the acceptance test for solutions); (4) `usePlanForecast`,
plan bar, marker dialog, plan lane; (5) compare view; (6) browser tests, docs, screenshots, PR.

---

## Decisions (verbatim)

**Issue #36 (Austin, 29 Sep; no comments since):**
> Plan with the forecast, not just read it. On the monthly timeline from B6 (#35), drag markers along the months and the
> forecast re-runs:
>
> - **Hire** markers: a new person in a role from a given month.
> - **Leave** markers: someone away for a stretch of weeks.
> - **Solution** markers: a saved solution (A49, #114) going live from a given month.
>
> Markers can be added, moved (by drag or keyboard) and removed. The forecast uses client groups (A55, #120) and the
> market schedule (A57, #122), over the chosen horizon (A58, #123).
>
> A set of markers is a **plan**, saved with a name. Two plans can be compared side by side (for example "hire in Jan" vs
> "hire in Mar"), showing monthly recurring revenue, client groups at risk and how busy each role gets, with the
> differences and ranges (PRD §4.1 Forecasting).

> Acceptance criteria
> - Hire, leave and solution markers can be added, dragged (and moved by keyboard) and removed; dropping one re-runs the forecast
> - Plans persist with their markers and a name
> - The compare view shows monthly series for both plans, with differences and ranges
> - A solution marker applies that solution's changes from its month only (test)
> - Every setting, lever and rule on this screen has an (i) with a plain-English description and an example
> - Wording follows the prototype's plain language

**PRD §4.1 Forecasting:**
> - Timeline view: stacked area of active clients by service, line of utilisation per role with the ceiling marked, markers
>   for hires and scenarios. Plan hires by dragging a hire marker along the timeline.
> - Forecast runs are saved like any run; two forecasts can be compared (e.g. hire in Jan vs hire in Mar).

(The redesign replaced scenarios with solutions, D22/D25; PRD §8: "the **Forecast** timeline (B6, B7: drag hire, leave
and solution markers; compare two plans)". D37: "B7 keeps the drag-and-drop timeline.")

**PRD D25:**
> A solution is a separate copy of a process with changed steps, plus optional lever changes. A process can have many.

**Austin on #30 (B1), 6 Oct (privacy rules every screen follows):**
> members and viewers see "Team member N" labels, only their own row, "A team member" for other names, and **no pay
> data**.

**HANDOVER, "Things worth knowing":**
> **Engine determinism:** never use `Math.log`/`Math.exp` in the engine; use `det-math.ts`. Any change that moves
> golden-model numbers needs an `ENGINE_VERSION` bump and `golden:approve` (see `docs/engine-versioning.md`).

> PRD §6.7 targets: Pipeline-only Northbeam, re-run after a lever change: < 150 ms. Full seeded Northbeam with its client
> roster and servicing: < 250 ms. [§6.7 also: "12-month forecast of the above: < 5 s."]

**HANDOVER, "Rules while Austin is away":**
> **Open questions:** take the brief's default. Record each default on the issue and under "Design calls Claude made, for
> Austin to confirm". Never block waiting for an answer.

**HANDOVER, "Operations":**
> **`save_fields`:** each migration that redefines `save_fields` must copy the **latest** definition and append to its
> allow-list, because the last definition wins.

This migration does **not** touch `save_fields` (plans are written whole, by their own policies).

---

## Audit: what exists

| Piece | Where | State | B7 change |
|---|---|---|---|
| Forecast page (live) | `apps/web/src/app/w/[slug]/forecast/page.tsx` | loads live bundle, issues, sources, `canEdit` | also loads plans and solutions when `canEdit` |
| Forecast page (demo) | `apps/web/src/app/demo/forecast/page.tsx` | `demoForecastBundle()`, start `DEMO_FORECAST_START` | passes demo plans and the demo solution |
| `ForecastView` | `apps/web/src/components/forecast/forecast-view.tsx` | horizon (`?horizon=`), alerts (insights), "By role / By person", timeline, "planned changes" line | plan bar, plan run, plan lane, "with this plan" summary, compare view |
| `ForecastTimeline` | `apps/web/src/components/forecast/forecast-timeline.tsx` | SVG; rows; Settings markers drawn per row (`markerGlyph`), not interactive; sr-only `TimelineTable` | optional `plan` prop: the "Your plan" lane, draggable markers |
| `ForecastPanel` (People page) | `apps/web/src/components/forecast/forecast-panel.tsx` | read-only | **unchanged** |
| `forecastModel`, `forecastInsights` | `apps/web/src/lib/forecast/forecast.ts` | `toEngineModel(bundle, { startDate, planned: true })` | unchanged; plans feed it a changed bundle |
| `timelineData`, `plannedMarkers`, `calendarMonthStarts`, `dateAtHour`, `marketBands` | `apps/web/src/lib/forecast/timeline.ts` | members see only own person row (`ownRowsOnly`) | `timelineData` gains an optional `markersModel` (see below) |
| Demo forecast | `apps/web/src/lib/forecast/demo.ts` | Jade Hart planned hire (Feb 2027), Leah Brooks leave over Christmas, market schedule | adds `DEMO_FORECAST_SOLUTION` and two demo plans |
| Planned hires/leave in the model | `packages/db/src/model.ts` `resolvePeopleRows` (l. 640) | `planned`: `start_date > startDate` → `from` hours; `end_date` → `until`; `personLeave` → `leave` windows | none; B7 adds rows to the bundle |
| Monthly engine output | `packages/engine/src/simulate.ts` (`mon`, l. 966; tick l. 2351; `monthlyOut` l. 2386; `monthlyResult` l. 3092); types `packages/engine/src/model.ts` (`MonthlyReplication`, `MonthlyResult`) | busy per role/person, uncovered, waits, late tasks, **active clients per service**. No MRR, no clients at risk per month | add `mrr` and `atRisk` |
| MRR today | `apps/web/src/lib/overview/projection.ts` (`startingMrr`, `mrrAfter`: runs of increasing length; "new-client revenue only" per HANDOVER) | not per calendar month | not reused for plans |
| `useSimulation` | `apps/web/src/lib/sim/use-simulation.ts` | one `SimulationClient` (one worker), debounced 40 ms, `run()` cancels the previous | new hook reuses `SimulationClient` sequentially |
| Solutions | table `public.solutions` (`20261122000000_solutions.sql`): `process_id`, `base_revision_id`, `steps` (whole copy, `BlockBundle`), `lever_changes`; loader `loadSolutions` / `loadWorkspaceSolutions` (`apps/web/src/lib/data.ts` l. 178); `bundleFromSolution` (`apps/web/src/lib/solutions/bundle.ts`) | Solution page simulates `bundleFromSolution(base, solution)`; **`lever_changes` are not applied by any simulation today** (only listed by `changesLine`) | forecast applies the copy the same way; lever changes not applied (Q4) |
| Demo solutions | `apps/web/src/lib/solutions/demo.ts` (`demoSolutionsNow`, tab-only) | none seeded | demo forecast lists `DEMO_FORECAST_SOLUTION` plus the tab's |
| Viewer / privacy | `apps/web/src/lib/viewer.ts` (`viewerOf`, `namedForViewer`, `ownRowsOnly`, `personName`) | | plans are editors-only (Q1), so no plan text reaches members |
| Charts | `ForecastTimeline` (`linePath`, `bandPath`), `MrrChart` in `apps/web/src/components/overview/charts.tsx` (second series dashed `var(--edit)`) | | new `PlanCompareChart` copies these patterns |
| (i) help | `apps/web/src/components/help.tsx` (`Help`, `HelpLabel`) | | every control below |
| Browser test harness | `apps/web/test/build-harness.ts` (stands in for `next/navigation`, `next/link`, Server Actions); `apps/web/test/people-browser.test.ts` + `people-harness/entry.tsx` (real Web Worker via `window.workerScripts`) | | copy for `forecast-plan-browser.test.ts` |
| Role matrix | `packages/db/test/role-matrix.test.ts` (`TABLES`, `reads: "editors"` kind exists for `runs`) | | add `forecast_plans` |
| Prototype | `apps/web/prototype/app-flow.html` | **has no forecast screen** | wording follows its general plain style (short verbs, "you", no jargon) |
| `forecasts` table in PRD §5 | — | never built | `forecast_plans` replaces it; update the PRD line |

**What the engine can't do and why splicing:** `EngineModel` has time windows only for people (`from`, `until`,
`leave`) and the market schedule. A solution is a whole new copy of a process's steps and edges; switching graphs mid-run
(items in flight at removed steps, new queues) would be a large engine change that moves nothing today but risks a lot.
Splicing two runs that share the seed is honest, cheap and testable.

---

## Part 1: engine, monthly MRR and clients at risk (no numbers move)

Files: `packages/engine/src/model.ts`, `packages/engine/src/simulate.ts`, `packages/engine/test/forecast.test.ts`.

**Types** (`model.ts`):

```ts
// MonthlyReplication, after `clients`:
  /**
   * Monthly recurring revenue of the active clients at each weekly tick, averaged over the month's ticks: with a client
   * roster (named clients or client groups), each retainer client's monthly fee as it bills (`weeklyBill × 4.33`); without
   * one, the interim client count × the pooled monthly fee (`pooledMonthlyFee`). One-off and hourly services add nothing.
   */
  mrr: number[];
  /**
   * With a client roster only: active clients whose health is below 50 (`AT_RISK_HEALTH`), per service key (the same keys
   * as `clients`, each present even when 0), averaged over the month's ticks. Empty without a roster.
   */
  atRisk: Record<string, number[]>;

// MonthlyResult, after `clients`:
  /** Monthly recurring revenue per month (see `MonthlyReplication.mrr`). */
  mrr: Stat[];
  /** Clients at risk (health below 50) per service key and month; empty without a client roster. */
  atRisk: Record<string, Stat[]>;
```

**Simulation** (`simulate.ts`):
- In `mon` (l. 966) add `mrr: new Float64Array(nM)` and `atRisk: new Map<string, Float64Array>()`.
- Add a module-level `pooledMonthlyFee(model)`: the mix-share-weighted average `price` of the services with
  `pricingModel === "retainer"` (plain average when the shares sum to 0), or `model.retainer` when there are none. This is
  the same rule as `startingMrr` in `apps/web/src/lib/overview/projection.ts`; compute it once per run, not per tick.
- In the weekly tick (the `else` branch at l. 2351, right after the existing `add(...)` calls, same `m`):
  - roster: `for (const rc of rosterClients) { mon.mrr[m] += rc.weeklyBill * WEEKS_PER_MONTH; addRisk(rc.svcKey, rc.health < AT_RISK_HEALTH ? 1 : 0); }`
    where `addRisk` creates the row on first sight (so a service with no client at risk still has a row of zeros);
  - pooled: `mon.mrr[m] += active * pooledFee`.
- `monthlyOut`: `mrr` divided by `sums.ticks[m]` like `clients` (0 when no tick); `atRisk` the same, keys sorted like
  `clients`.
- `monthlyResult` (l. 3092): `mrr: months.map((_, m) => stat(reps.map((r) => r.mrr[m]!)))`; `atRisk` as `clients` is
  built (union of keys, missing → 0).
- **Reads only.** No random draw, no state change, no new event. Don't touch anything outside the `if (mon)` paths.

**Version:** golden outputs don't include `monthly` (`packages/engine/test/golden.ts`, `keyOutputs`), and B6 added the
whole `monthly` result without a bump (`golden/versions.json` has no B6 entry). So: **no `ENGINE_VERSION` bump, no
`golden:approve`** (Q8). `pnpm --filter @transpera-flow/engine test` must pass unchanged, including `golden.test.ts`,
`browser-determinism.test.ts` and the existing "monthly changes nothing else" test (`forecast.test.ts` l. 43:
`withoutMonthly(monthly)` equals the plain run).

**Engine tests** (add to `packages/engine/test/forecast.test.ts`):
1. Northbeam with client groups (`northbeamWithClientGroups()`), 12 months monthly: `monthly.mrr` has one `Stat` per month;
   month 0's mean is within 2% of the roster's starting MRR (Σ group count × fee, as `startingMrr` computes); every value
   ≥ 0 and `p10 ≤ mean ≤ p90`.
2. `Object.keys(monthly.atRisk)` equals `Object.keys(monthly.clients)` for the roster model; for each key and month,
   `atRisk.mean ≤ clients.mean + 1e-9`. The PPC group (health 52, near the line) has a mean at risk > 0 in some month.
3. The pooled model (`northbeamModel()`): `atRisk` is `{}`; `mrr[0].mean` equals `clients[""][0].mean × pooledMonthlyFee`
   within 1e-9 (export `pooledMonthlyFee` from the engine index for the test and for the app).
4. Determinism: two runs with the same seed give `toEqual` monthly results (mrr and atRisk included).

---

## Part 2: the `forecast_plans` table

Files: `packages/db/supabase/migrations/20261213000000_forecast_plans.sql`, apply file
`packages/db/scripts/apply/20261213000000_forecast_plans.sql`, `packages/db/supabase/bootstrap.sql` (regenerate with
`pnpm --filter @transpera-flow/db gen:bootstrap`, never by hand), `packages/db/src/database.types.ts` (hand-edit in the
generator's order and shape: `Row`, `Insert`, `Update`, `Relationships` between `findings`/… alphabetically, as #205 did;
`gen:types` needs the linked project), `packages/db/src/types.ts`, `packages/db/src/queries.ts`,
`packages/db/src/index.ts` (exports), `docs/production-migrations.md` (new row, **NOT applied**, next row number at merge
time).

### Marker shape (stored in `markers`, a jsonb array)

```ts
// packages/db/src/types.ts
export type ForecastPlanMarker =
  /** A new person in a role from `date` (the 1st of a month). `fte` 0.1–2. `name` optional; the app shows "New <role>". */
  | { id: string; kind: "hire"; date: string; role_id: string; fte: number; name?: string }
  /** An existing person away for `weeks` whole weeks from `date` (a Monday). */
  | { id: string; kind: "leave"; date: string; person_id: string; weeks: number }
  /** A saved solution live from `date` (the 1st of a month). */
  | { id: string; kind: "solution"; date: string; solution_id: string };

export interface ForecastPlanRow {
  id: string;
  workspace_id: string;
  name: string;
  markers: ForecastPlanMarker[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
}
```

`queries.ts`: `export const FORECAST_PLAN_COLUMNS = "id, workspace_id, name, markers, created_at, updated_at, created_by" as const;`
and `loadForecastPlans(db, workspaceId): Promise<ForecastPlanRow[]>` (by `workspace_id`, ordered by `name`; on error
return `[]` and log, as `loadSolutions` does). `apps/web/src/lib/data.ts`: `loadWorkspaceForecastPlans(workspaceId)`.

Dates are **absolute ISO dates**, never month offsets: "Hire in January" stays January as today moves on.

### Migration (write exactly this; header comment as in `20261122000000_solutions.sql`)

Header must say: what it adds (one table, its indexes, one trigger function, two triggers, four policies, grants);
**STRICTLY ADDITIVE** (no existing table, column, function, policy or grant changes; `save_fields` untouched); who reads
and writes (owners, editors, agency admins: `can_edit_workspace`; members and viewers nothing, Q1; anon nothing); the
marker shape; that ids inside `markers` are checked at write time but are not foreign keys (a person, role or solution
deleted later leaves the marker "needs attention" in the app, never an error); preflight, post-apply and rollback below.

```sql
create table public.forecast_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 120),
  markers jsonb not null default '[]'
    check (
      pg_catalog.jsonb_typeof(markers) = 'array'
      and pg_catalog.jsonb_array_length(markers) <= 40
      and pg_catalog.octet_length(markers::text) <= 20000
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create unique index forecast_plans_workspace_name_key on public.forecast_plans (workspace_id, pg_catalog.lower(pg_catalog.btrim(name)));

create trigger set_updated_at before update on public.forecast_plans
  for each row execute function public.set_updated_at();

-- Checks every writer meets, with plain messages. Security invoker: a caller who can't edit the workspace gets a plain
-- permission error first (a plain database connection, as in migrations and tests, has no user and is not asked).
-- Fires only on the columns a person writes, so the foreign key's `on delete set null` of created_by passes untouched.
create function private.forecast_plans_before_write() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  m jsonb;
  k text;
  d date;
  seen text[] := '{}';
  solutions integer := 0;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if auth.uid() is not null and not coalesce(public.can_edit_workspace(new.workspace_id), false) then
    raise exception 'forecast_plans: you cannot edit this workspace' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if (select pg_catalog.count(*) from public.forecast_plans p where p.workspace_id = new.workspace_id) >= 50 then
      raise exception 'forecast_plans: a workspace keeps at most 50 plans' using errcode = '23514';
    end if;
  elsif new.workspace_id is distinct from old.workspace_id then
    raise exception 'forecast_plans: a plan stays in its workspace' using errcode = '23514';
  end if;
  for m in select e.value from pg_catalog.jsonb_array_elements(new.markers) e loop
    if pg_catalog.jsonb_typeof(m) is distinct from 'object' then
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
    k := m ->> 'kind';
    if coalesce(m ->> 'id', '') !~ uuid_re or (m ->> 'id') = any (seen) then
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
    seen := seen || (m ->> 'id');
    if coalesce(m ->> 'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end if;
    begin
      d := (m ->> 'date')::date;
    exception when others then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end;
    if d < date '2000-01-01' or d > date '2100-12-31' then
      raise exception 'forecast_plans: a marker''s date is not valid' using errcode = '23514';
    end if;
    if k = 'hire' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'role_id', 'fte', 'name')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'role_id', '') !~ uuid_re
        or not exists (select 1 from public.roles r where r.id = (m ->> 'role_id')::uuid and r.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: a hire needs a role of this workspace' using errcode = '23514';
      end if;
      if pg_catalog.jsonb_typeof(m -> 'fte') is distinct from 'number' then
        raise exception 'forecast_plans: a hire''s FTE must be between 0.1 and 2' using errcode = '23514';
      end if;
      if (m ->> 'fte')::numeric < 0.1 or (m ->> 'fte')::numeric > 2 then
        raise exception 'forecast_plans: a hire''s FTE must be between 0.1 and 2' using errcode = '23514';
      end if;
      if m ? 'name' then
        if pg_catalog.jsonb_typeof(m -> 'name') is distinct from 'string' then
          raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
        end if;
        if pg_catalog.length(m ->> 'name') > 120 then
          raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
        end if;
      end if;
    elsif k = 'leave' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'person_id', 'weeks')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'person_id', '') !~ uuid_re
        or not exists (select 1 from public.people p where p.id = (m ->> 'person_id')::uuid and p.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: leave needs a person of this workspace' using errcode = '23514';
      end if;
      if pg_catalog.jsonb_typeof(m -> 'weeks') is distinct from 'number' or (m ->> 'weeks') !~ '^[0-9]+$' then
        raise exception 'forecast_plans: leave lasts 1 to 52 whole weeks' using errcode = '23514';
      end if;
      if (m ->> 'weeks')::integer not between 1 and 52 then
        raise exception 'forecast_plans: leave lasts 1 to 52 whole weeks' using errcode = '23514';
      end if;
    elsif k = 'solution' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(m) x where x not in ('id', 'kind', 'date', 'solution_id')) then
        raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
      end if;
      if coalesce(m ->> 'solution_id', '') !~ uuid_re
        or not exists (select 1 from public.solutions s where s.id = (m ->> 'solution_id')::uuid and s.workspace_id = new.workspace_id) then
        raise exception 'forecast_plans: a solution marker needs a solution of this workspace' using errcode = '23514';
      end if;
      solutions := solutions + 1;
    else
      raise exception 'forecast_plans: a marker is not valid' using errcode = '23514';
    end if;
  end loop;
  if solutions > 4 then
    raise exception 'forecast_plans: a plan has at most 4 solutions' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.forecast_plans_before_write() from public, anon, authenticated;

create trigger forecast_plans_before_write before insert or update of name, markers, workspace_id on public.forecast_plans
  for each row execute function private.forecast_plans_before_write();

alter table public.forecast_plans enable row level security;

-- Supabase gives every new public table full privileges for anon, authenticated and service_role, so revoke first; a
-- column grant only restricts anything once the table-level UPDATE is gone (as 20261122000000 does).
revoke all on public.forecast_plans from anon, authenticated;
grant select, insert, delete on public.forecast_plans to authenticated;
grant update (name, markers) on public.forecast_plans to authenticated;

-- Plans are planning by the people who run the workspace (Q1): a hypothetical leave names a person, which is per-person
-- data members and viewers don't see (B1). Owners, editors and agency admins read and write; nobody else reads.
create policy "read forecast_plans" on public.forecast_plans for select to authenticated
  using (public.can_edit_workspace(workspace_id));
create policy "insert forecast_plans" on public.forecast_plans for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update forecast_plans" on public.forecast_plans for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete forecast_plans" on public.forecast_plans for delete to authenticated
  using (public.can_edit_workspace(workspace_id));
```

Notes for the builder:
- `public.roles`, `public.people`, `public.solutions` each have `id` and `workspace_id`; check before you rely on it. If a
  column name differs, stop and ask.
- In plpgsql, never combine a type test and a cast in one `or` expression: Postgres doesn't promise evaluation order. The
  nested `if`s above are deliberate; keep them.
- `count(*) >= 50` without a lock can let two concurrent inserts reach 51. Accepted (a soft cap); say so in the header.

### Preflight (in the header; run one file at a time with `prod-sql.sh -f`)

```sql
-- 0. Nothing at or past this version. Expect 0:
select count(*) from supabase_migrations.schema_migrations where version >= '20261213000000';
-- 1. The table doesn't exist. Expect null:
select pg_catalog.to_regclass('public.forecast_plans');
-- 2. The trigger function doesn't exist. Expect 0:
select count(*) from pg_proc where proname = 'forecast_plans_before_write';
-- 3. Helpers present. Expect 2 rows:
select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_edit_workspace', 'set_updated_at');
-- 4. Referenced tables have id and workspace_id. Expect 6 rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public' and table_name in ('roles', 'people', 'solutions') and column_name in ('id', 'workspace_id');
```

### Post-apply checks (in the header)

```sql
-- RLS on. Expect t:
select relrowsecurity from pg_class where oid = 'public.forecast_plans'::regclass;
-- Four policies, each on can_edit_workspace. Expect 4 rows (r, a, w, d):
select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) from pg_policy where polrelid = 'public.forecast_plans'::regclass order by polcmd;
-- Grants: authenticated DELETE, INSERT, SELECT only; anon nothing. Expect 3 rows:
select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'forecast_plans' and grantee in ('anon', 'authenticated') order by 1, 2;
-- Column UPDATE: markers and name for authenticated. Expect 2 rows:
select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'forecast_plans' and privilege_type = 'UPDATE' and grantee = 'authenticated' order by 1;
-- Triggers enabled. Expect forecast_plans_before_write O, set_updated_at O:
select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.forecast_plans'::regclass and not tgisinternal order by 1;
-- Function: not SECURITY DEFINER, empty search_path, no client EXECUTE. Expect f, t, f, f:
select p.prosecdef, p.proconfig = array['search_path=""'],
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
  from pg_proc p where p.proname = 'forecast_plans_before_write';
-- The version row. Expect 1:
select count(*) from supabase_migrations.schema_migrations where version = '20261213000000';
```

### Rollback (in the header; one transaction; roll the app back first)

```sql
begin;
drop table if exists public.forecast_plans;   -- its triggers, policies and indexes go with it
drop function if exists private.forecast_plans_before_write();
delete from supabase_migrations.schema_migrations where version = '20261213000000';
commit;
```
Rolling back loses every saved plan. Production data: none needed.

### Apply file

`packages/db/scripts/apply/20261213000000_forecast_plans.sql`: `begin;`, `set local lock_timeout = '5s';` (as the other
apply files do; copy their first lines), the migration SQL, the `insert into supabase_migrations.schema_migrations
(version, name, statements) values ('20261213000000', 'forecast_plans', array[$mig$<the migration SQL>$mig$]);`, `commit;`.
No ordering dependency beyond the rows already applied; if another migration merges first with a later number, renumber
this one (HANDOVER: migrations apply in file-name order).

### Database tests

New `packages/db/test/forecast-plans.test.ts` (copy the harness use in `packages/db/test/solutions.test.ts` and
`solutions-privileges.test.ts`), against Northbeam:
1. An editor inserts a plan with one marker of each kind; reads it back; renames it; replaces its markers; deletes it.
2. A member and a viewer read 0 plans (one exists) and can't insert, update or delete (42501 or 0 rows).
3. Someone from another workspace can't read or write it; an editor can't insert a plan whose `workspace_id` is another
   workspace, nor move one (`workspace_id` update refused).
4. Each refusal, with its message: a role/person/solution of another workspace; an unknown `kind`; an extra key; a
   duplicate marker id; a bad date (`2027-02-30`, `27-01-01`); FTE 0, 2.5 and a string; weeks 0, 53, 1.5; 5 solution
   markers; 41 markers (the check); a blank name; a duplicate name differing only by case and spaces (23505); the 51st plan.
5. `created_by` is the caller even if the insert names someone else.
6. Deleting a role used by a hire marker succeeds (no foreign key); the plan keeps the marker.
7. Deleting the auth user who created a plan sets `created_by` null (the trigger doesn't fire on that column).

Add to `packages/db/test/role-matrix.test.ts` `TABLES`: `{ table: "forecast_plans", insert: …, update: ["update
forecast_plans set name = name where workspace_id = $1 and name = 'x seed'", [ws]], delete: …, reads: "editors" }` with an
insert of a plan with `markers` `'[]'`. Follow the `runs` entry.

---

## Part 3: pure plan logic (no React)

All in `apps/web/src/lib/forecast/`. Every function here is unit-tested in `apps/web/test/forecast-plan.test.ts`.

### `plan.ts`

```ts
export const MAX_PLANS = 50;
export const MAX_MARKERS = 40;
export const MAX_SOLUTIONS = 4;
export const MAX_NAME = 120;

/** What can be wrong with a marker today, in words, for the "needs attention" list. Null when it applies. */
export type MarkerProblem = { markerId: string; message: string };

/** A plan's name and markers as typed, checked (as the database checks, plus "two solutions for one process in one month"). */
export function parsePlanInput(input: unknown): { ok: true; value: { name: string; markers: ForecastPlanMarker[] } } | { ok: false; error: string };

/**
 * The bundle with the plan's hires and leave in it: a hire is a person row (`name` or "New <role name>", numbered
 * "New PPC specialist 2" when there are several, `fte`, `capacity_hours_week: null`, `cost_rate: null`, `active: true`,
 * `start_date: date`, `end_date: null`) with one `person_roles` row; leave is a `person_leave` row from `date` to
 * `date + 7 × weeks − 3` days (Monday to Friday of the last week). Ids: the marker's id for the person and the leave row.
 * Markers whose role or person is gone, or whose person is inactive, are skipped and returned as problems.
 * Solution markers are ignored here.
 */
export function applyPlanPeople(bundle: ProcessBundle, markers: readonly ForecastPlanMarker[]): { bundle: ProcessBundle; problems: MarkerProblem[] };

/**
 * The bundle with a solution's copy in place of its process: the main process (`bundle.process.id`) through
 * `bundleFromSolution`, or the matching part in `bundle.otherProcesses` (steps and edges swapped, its revision kept).
 * Null when the process isn't part of the company model the forecast runs.
 */
export function withSolution(bundle: ProcessBundle, solution: Pick<SolutionRow, "process_id" | "steps">): ProcessBundle | null;

/** One run of a plan: from month `from` on, this bundle's numbers are used. */
export interface PlanSegment { from: number; bundle: ProcessBundle; solutionIds: string[] }

/**
 * The runs a plan needs. `bounds` are the months' edges in working hours ([0, ...monthStarts, H]). Each solution marker
 * goes live in the month its date falls in (a date on or before the start: month 0; at or after the horizon: left out and
 * listed in `later`). Segment 0 starts at month 0; one more segment per distinct go-live month; each segment's bundle has
 * the plan's people applied and every solution live by then (for one process, the latest one by date wins). Missing
 * solutions and solutions of processes outside the company model are problems, skipped.
 */
export function planSegments(
  bundle: ProcessBundle,
  markers: readonly ForecastPlanMarker[],
  solutions: readonly SolutionRow[],
  startDate: string,
  bounds: readonly number[],
  hoursPerWeek: number,
): { segments: PlanSegment[]; problems: MarkerProblem[]; later: string[] };
```

Use `workingDaysBetween` (from `@transpera-flow/db`) × `hoursPerWeek / 5` to turn a date into hours from the start, as
`calendarMonthStarts` does; a month index is the last bound ≤ that hour.

### `splice.ts`: `spliceMonthly(segments: { from: number; monthly: MonthlyResult }[]): MonthlyResult`

Segments sorted by `from`, the first at 0, all with the same `months`. Build month by month; the result `R`. (`Stat` is `{ mean, p10, p90 }`; `MonthBusy` extends it with `capacity` and
`work`.)
- **Flows** (`roles`, `people`, `uncovered`, `waits`, `lateTasks`): month `m` takes the value of the segment whose range
  holds `m` (the last segment with `from ≤ m`). Keys: union over segments; a key missing in that segment gives `null`
  (`roles`, `people`, `uncovered`, `waits`) or a zero `Stat` (`lateTasks` is an array, always present).
- **Stocks** (`clients`, `mrr`, `atRisk`): for the first segment, as is. For a later segment `s` starting at `k > 0`:
  `offset = R(k−1).mean − s(k−1).mean`, and for `m ≥ k` (until the next segment) `mean`, `p10` and `p90` are each `s(m).field + offset`, floored at 0.
  So clients and revenue carry on from where they were, and only the change from that month follows the solution's run.
  A key missing on either side counts as 0.
- `months` from the first segment.

`MonthBusy` rows (flows) are copied, not shifted.

### `positions.ts`

```ts
/** The months' edges in working hours: [0, ...monthStarts, H]. */
export function monthBounds(monthStarts: readonly number[], horizonHours: number): number[];
/** Hours from the start of `startDate` to the start of `date` (negative before it), weekdays only. */
export function hoursToDate(startDate: string, date: string, hoursPerWeek: number): number;
/** Where a date sits on the timeline, in columns from the left (2.5 = halfway through the third month), clamped to [0, n]. */
export function positionOfDate(date: string, startDate: string, bounds: readonly number[], hoursPerWeek: number): number;
/**
 * The date a drop at `position` columns means. "month" snaps to the 1st of the calendar month of the column under the
 * pointer (the first column: the 1st of the start date's month); "week" snaps to the Monday on or before the date there.
 */
export function dateAtPosition(position: number, snap: "month" | "week", startDate: string, bounds: readonly number[], hoursPerWeek: number): string;
/** One step by keyboard: a month (the 1st of the next or previous month) or a week (± 7 days). */
export function stepDate(date: string, snap: "month" | "week", direction: 1 | -1): string;
```

The timeline's columns are equal width while months differ in length; positions use the same "fraction of the month"
rule as `plannedMarkers`'s `at` (l. 218 of `timeline.ts`). Copy that rule; don't invent another.

### `compare.ts`

```ts
export interface CompareRow { id: string; name: string; a: (Stat | null)[]; b: (Stat | null)[]; /** b.mean − a.mean, null when either is null. */ diff: (number | null)[] }
export interface PlanComparison {
  months: TimelineMonth[];
  mrr: CompareRow;
  /** One per client group (service), named by the service; pooled models: empty. */
  atRisk: CompareRow[];
  /** One per role with work in either plan (as `busyRows` filters), in the model's role order. `a`/`b` are `MonthBusy`. */
  roles: CompareRow[];
  /** Headline numbers for the tiles: last month's MRR, last month's clients at risk (all groups), months too busy (all roles). */
  totals: { mrr: [number, number]; atRisk: [number, number] | null; tooBusyMonths: [number, number] };
}
export function comparePlans(model: EngineModel, a: MonthlyResult, b: MonthlyResult, bundle: Pick<ProcessBundle, "services">, startDate: string, cutoffs: readonly [number, number, number]): PlanComparison;
```

### `plans-demo.ts` (tab-only store, like `apps/web/src/lib/solutions/demo.ts`)

`useDemoPlans()` (with `useSyncExternalStore`), `saveDemoPlan(plan)`, `deleteDemoPlan(id)`. Seeded with two plans so
"compare" works on first open (fixed ids, `NORTHBEAM_WORKSPACE_ID`):
- "Hire in January": hire, PPC specialist role (`northbeamRoleIds.ppc`), FTE 1, `2027-01-01`.
- "Hire in March": the same hire on `2027-03-01`, plus the demo solution from `2027-04-01`.

### `demo.ts` additions

`DEMO_FORECAST_SOLUTION: SolutionRow`: a solution of Northbeam's main process (copy with `solutionCopy(demoBundle())`) named
"Faster PPC campaign setup" that halves the hands-on time of step `northbeamStepIds.ppc` (read `StepRow` and
`toEngineModel` to find the field the engine reads as `work`; change only that; `changed_step_ids: [northbeamStepIds.ppc]`,
`lever_changes: []`, fixed id, `base_revision_id` the demo live revision). The demo Forecast page lists it plus
`demoSolutionsNow().solutions`.

### `timeline.ts` change

`timelineData(model, result, bundle, startDate, options?: { markersModel?: EngineModel; planPeople?: ReadonlySet<string> })`:
- `markersModel` (default `model`) is what `plannedMarkers` reads, so Settings' hires and leave are drawn per row as today,
  and the plan's hires and leave are **not** drawn twice (the plan lane draws them).
- `planPeople`: ids of people a plan added; their "By person" rows are named `"<name> (plan)"`.
- Nothing else changes; existing calls stay valid. `ForecastPanel` keeps calling it as now.

---

## Part 4: UI

Read `apps/web/AGENTS.md` and the bundled Next docs (`node_modules/next/dist/docs/`, the Server Actions / "updating
data" guide) before writing the actions file. Wording below is the copy to use.

### Server side

- `apps/web/src/app/w/[slug]/forecast/page.tsx`: when `canEdit`, also load `loadWorkspaceForecastPlans(ws)` and
  `loadWorkspaceSolutions(ws)` (its `.solutions`), in the same `Promise.all`. Pass `plans`, `solutions` to `ForecastView`.
  When not `canEdit`, pass nothing (`[]`): no plan UI at all.
- `apps/web/src/app/w/[slug]/forecast-plan-actions.ts` (`"use server"`, copy the shape of `solution-actions.ts`):
  - `savePlan(workspaceId: unknown, planId: unknown | null, input: unknown, expectedUpdatedAt: unknown | null): Promise<SavePlanResult>`:
    `isId` checks, `parsePlanInput`, signed-in check (`getClaims`), then insert (`planId` null) or update
    `.eq("id", planId).eq("workspace_id", workspaceId).eq("updated_at", expectedUpdatedAt)` with `.select(FORECAST_PLAN_COLUMNS)`.
    An update that returns no row: "Someone else changed or deleted this plan. Reload to see it."
  - `deletePlan(workspaceId: unknown, planId: unknown): Promise<{ status: "ok" } | { status: "error"; message: string }>`.
  - Error mapping in a pure `planFailure(error)` in `apps/web/src/lib/forecast/plan-save.ts` (a "use server" file may only
    export async functions): 23505 → "A plan with that name already exists."; "at most 50 plans" → "This workspace already
    has 50 plans. Delete one first."; "at most 4 solutions" → "A plan can have up to 4 solutions."; "needs a role/person/
    solution" → "Something in this plan isn't there any more. Reload and try again."; 42501 → "You don't have permission to
    change plans here."; else "Couldn't save the plan. Try again." Signed out: "Your session has ended. Sign in again."

### `ForecastView` (`forecast-view.tsx`)

New props: `plans?: ForecastPlanRow[]`, `solutions?: SolutionRow[]`, and for the demo `demoPlans?: true` (use the demo
store instead of the actions). Plan UI only when `mode !== "readonly"`.

State and URL (copy the `?horizon=` pattern, `router.replace(…, { scroll: false })`):
- `?plan=<id>`: the plan shown. Absent: "No changes" (today's forecast, as now).
- `?compare=<a>,<b>`: the compare view (each id a saved plan id or `live`).
- Working copy of the selected plan's markers in state; "Unsaved changes" when it differs from the saved one. Switching
  plan or opening compare with unsaved changes asks first (the `Dialog` in `components/ui/dialog.tsx`): "Discard your
  changes to “<name>”?" [Discard] [Keep editing]. Adding a marker while on "No changes" starts an unsaved plan named
  "New plan".

Runs:
- The live run stays exactly as now (alerts/insights, and the timeline when no plan is selected).
- With a plan selected: `usePlanForecast` (below) runs it; the timeline shows the plan's spliced numbers; the old chart
  stays on screen while a new run is in progress (no skeleton flash), with `aria-busy="true"` and the text "Updating the
  forecast…" in the status line.
- **Insights stay on the live forecast** (Q11). Under the plan bar, a "With this plan" list: for each role whose first
  "too busy" month differs from the live run (`firstCrossing` from the engine on both series, average): "PPC specialist:
  too busy from March 2027 (with no changes: February 2027)", "… no longer too busy in the next 12 months", or "… too busy
  from June 2027 (not with no changes)". When none differ: "This plan doesn't change when anyone gets too busy."

### `usePlanForecast` (`apps/web/src/lib/forecast/use-plan-forecast.ts`)

```ts
export function usePlanForecast(args: {
  bundle: ProcessBundle; markers: readonly ForecastPlanMarker[] | null; solutions: readonly SolutionRow[];
  months: number; startDate: string;
}): {
  status: "idle" | "running" | "done" | "error";
  /** The last finished run (kept while a newer one runs). */
  run: { model: EngineModel; result: SimulationResult; markersModel: EngineModel; planPeople: Set<string> } | null;
  problems: MarkerProblem[]; later: string[]; error: string | null; progress: [done: number, total: number];
}
```
- `markers === null`: idle, nothing runs.
- Build `bounds` from `forecastModel(bundle, months, start)` (its `monthStarts` and `horizonWeeks × hoursPerWeek`), then
  `planSegments`, then `forecastModel(segment.bundle, months, start)` for each; a `ModelError` in a segment is the error:
  "“<solution name>” can't be simulated: <message>" (or the plain message for segment 0).
- One `SimulationClient` (as `useSimulation` creates it), runs awaited **in order**, 30 reps, seed 1 (the same seed as the
  live run, so differences aren't noise), `{ monthly: true, monthStarts }`; a newer input cancels (`client.run` cancels the
  one in flight; drop the stale results). Debounce 40 ms.
- Result: segment 0's `result` with `monthly` replaced by `spliceMonthly(...)`; `model` is segment 0's (names, people);
  `markersModel` is `forecastModel(bundle …)` without the plan (for Settings' markers); `planPeople` the hire marker ids.
- Memoise models by the inputs' identity so a re-render doesn't re-run.

### Plan bar (`apps/web/src/components/forecast/plan-bar.tsx`)

Above the timeline section, a `Card` row:
- **Plan** (`NativeSelect`): "No changes" then saved plans by name, then the unsaved one if any. (i) "Plan": "A plan is a
  set of changes you're thinking about: people you might hire, leave someone might take, solutions you might put live. The
  forecast runs with them so you can see what they do. Plans don't change your live model." Example: "“Hire in March”
  adds a PPC specialist from 1 March and shows who is still too busy before then."
- **Add** (`DropdownMenu`): "Add a hire", "Add leave", "Add a solution" (the last disabled with the hint "No saved
  solutions yet" when there are none).
- **Save** (primary, when unsaved changes), **Save as new plan**, **Rename**, **Delete** (Dialog: "Delete the plan
  “<name>”? This can't be undone." [Delete] [Cancel]), **Compare plans** (disabled with title "Save a plan to compare it"
  when there's no saved plan).
- Status text (`aria-live="polite"`): "Unsaved changes", "Saved", "Updating the forecast…", the save error.
- Under it, when there are problems: "Needs attention: <message>; …" (each problem's message, e.g. "The role of “New SEO
  specialist” isn't there any more", "Leah Brooks is no longer on the team", "“Faster PPC campaign setup” was deleted",
  "“X” changes a process the forecast doesn't run"), and for `later`: "After this span: <label>".

### Marker dialog (`apps/web/src/components/forecast/plan-marker-dialog.tsx`)

One `Dialog` for add and edit, fields by kind, each with a `HelpLabel` (i). Months are offered as the forecast's months
(a `NativeSelect` of `TimelineMonth.long`, value the 1st of that month); no earlier month is offered.
- **Hire**: Role (active roles), "Starts in" (month), FTE (number, 0.1–2, step 0.1, default 1), Name (optional,
  placeholder "New <role>").
  - (i) Role: "The role the new person works in. They take that role's share of the work from the month they start."
    Example: "A PPC specialist starting in March takes on PPC work from 1 March."
  - (i) Starts in: "The month they start. They count from the 1st of that month." Example: "January means from 1 January."
  - (i) FTE: "How much of a full working week they work. 1 is full time, 0.5 is half time." Example: "0.6 is three days a
    week."
- **Leave**: Person (active people, names as `namedForViewer` gives them; the editor sees all), "From" (a date input
  snapped to the Monday on or before; show "Monday 14 December 2026"), "For" (weeks, 1–52, default 2).
  - (i) Person: "Who is away. Their work goes to the others in their role while they're gone." Example: "If Leah is away,
    Dan picks up her clients' account work."
  - (i) From / For: "The Monday the leave starts, and how many whole weeks it lasts." Example: "From 14 December for 3
    weeks is back on 4 January."
- **Solution**: Solution (grouped by process name; a solution whose process isn't in the company model is listed disabled
  with "(not part of the forecast)"), "Live from" (month). When the solution has lever changes: a note "Its <n> lever
  change(s) aren't part of the forecast, as on the solution's page." When its `base_revision_id` isn't the live revision of
  its process: "Made from an older version of <process>; the forecast uses the solution's map as saved."
  - (i) Solution: "A solution you've built and saved. From the month it goes live, the forecast uses the solution's map
    instead of the live one." Example: "“Faster PPC campaign setup” from April: April onwards runs with the faster setup."
  - (i) Live from: "From this month on, the forecast follows a run with the solution in place. Busy levels change from
    that month; client numbers and revenue carry on from where they were and change from there." Example: "Live from
    April: January to March are the same as without it."
- Buttons: [Add] or [Save], [Remove] (edit only), [Cancel]. Validation messages inline.

### Plan lane (in `ForecastTimeline`)

New optional prop:

```ts
plan?: {
  markers: PlanLaneMarker[];   // id, kind, date, label ("New PPC specialist starts", "Leah Brooks on leave", "Faster PPC campaign setup goes live"), when ("1 Mar 2027", "14 Dec 2026 to 1 Jan 2027"), problem?: string
  bounds: number[]; startDate: string; hoursPerWeek: number;
  editable: boolean;
  onMove: (id: string, date: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}
```
- A lane 32 px high above the first busy row (shift `TOP` by the lane when `plan` is set), labelled "Your plan" in the
  left column (compact: a line above it, as rows do). Each marker at `positionOfDate` (leave: a bar from its start to its
  end, 12 px high), with a faint dashed vertical guide line through the whole chart at its position.
- Glyphs (text-token colours; `var(--edit)` for plan markers so they read as "not live"): hire ▲ with a small "+",
  leave a bar, solution ◆. A marker with a problem is drawn hollow with the problem in its `<title>`.
- Each marker is a focusable `<g role="slider" tabIndex={0} aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={month index}
  aria-valuetext="New PPC specialist starts, 1 March 2027" aria-label="Hire: New PPC specialist" data-plan-marker={id}
  data-kind={kind}>` with an invisible hit rect at least 24 × 24 px (`touch-action: none`). Focus ring visible
  (`outline` via a focus rect).
- **Pointer**: `pointerdown` captures (`setPointerCapture`); while moving, a ghost glyph and a label with the snapped date
  follow the pointer (snap "month" for hire/solution, "week" for leave, via `dateAtPosition`); `pointerup` calls `onMove`
  if the date changed; moving less than 4 px is a click and calls `onEdit`; Escape during a drag cancels it. Nothing
  re-runs during the drag; dropping does (the view updates markers → `usePlanForecast` re-runs).
- **Keyboard** on a focused marker: ← / → one step (`stepDate`: a month, or a week for leave); PageUp / PageDown three
  months (four weeks for leave); Home / End the first / last month of the span; Enter or Space edits; Delete or Backspace
  removes. After a move, announce in a visually hidden `aria-live="polite"` region: "New PPC specialist starts moved to
  1 April 2027. Updating the forecast…"; focus stays on the marker.
- Not editable (`editable: false`): markers drawn, focusable, no move or remove.
- The sr-only `TimelineTable` gets a "Your plan" column listing plan markers in their months.
- Settings' own markers (per row) stay as they are and are **not** draggable (Q6). The line under the chart becomes:
  "<n> planned change(s) from Settings: …. Your plan: <labels with when>. Start dates, end dates and leave are set in
  Settings, under People."
- Expose `data-plan-status="running|done|error"` and `data-plan-run="<count of finished plan runs>"` on the timeline's
  container for the browser tests.

### Compare view (`apps/web/src/components/forecast/plan-compare.tsx`)

Replaces the timeline section while `?compare=` is set (alerts stay above). "Back to the plan" returns.
- Two pickers, "Plan A" and "Plan B" (each: "No changes" + saved plans). Same plan on both: "Pick two different plans."
  Defaults when opened from the bar: A = "No changes", B = the selected saved plan (or the first plan).
- Runs: two `usePlanForecast` (A with `markers: []` for "No changes" → one run of the live model). Progress text
  "Running plan A… / Running plan B…".
- Legend: Plan A solid `var(--accent)` with its 10–90% band; Plan B dashed `var(--edit)` with a lighter band, names in text
  tokens.
- Three tiles (`Card`): "Recurring revenue in <last month long>": A, B, "B − A" (signed, currency); "Clients at risk in
  <last month>" (all groups; "—" with the line "Needs clients counted per service" when pooled); "Months a role is too
  busy" (sum over roles of months whose average is too busy): A, B, difference.
- Sections, each a heading with (i) and one `PlanCompareChart` per series, then `<details><summary>Show the
  numbers</summary>` with a table: Month | Plan A (10–90%) | Plan B (10–90%) | Difference (B − A):
  1. "Monthly recurring revenue" (currency). (i) "What your clients pay each month, from the active clients' fees, month
     by month. The band is the middle 80% of the 30 simulated runs." Example: "£48.2K (£46.9K–£49.5K) means most runs land
     between those two."
  2. "Clients at risk, by group" (one chart per client group; counts with one decimal). (i) "How many clients in each group
     have health below 50 in that month, on average across the runs. Unhappy clients are more likely to leave." Example:
     "PPC 3.4 means about three or four PPC clients are unhappy that month."
  3. "How busy each role gets" (one chart per role; percent; the dashed “Too busy” line from the cut-offs). (i) "Work as a
     share of the hours the role has that month, with overtime. Above the dashed line the role is too busy." Example:
     "92% means 37 of 40 hours are taken."
  - "Difference" (i) on the table header: "Plan B's average minus plan A's. Both plans use the same random runs, so a
    difference comes from the plans, not from chance. Each plan's own range is beside it." Example: "+£1.2K means plan B
    brings in £1.2K more that month on average."
- `PlanCompareChart` (`apps/web/src/components/forecast/plan-compare-chart.tsx`): one SVG, x = the forecast's months
  (`TimelineMonth.short`, `labelIndexes` as the timeline), y with `niceTicks` from `lib/overview/axis`, A and B lines and
  bands (copy `linePath` / `bandPath` from `ForecastTimeline`), optional dashed reference line, hover tooltip with both
  values and the difference, an sr-only table, `role="img"` with an `aria-label` summarising the last month. Width from a
  `ResizeObserver` (copy `useWidth`); works at 400 px.

### Demo page

`apps/web/src/app/demo/forecast/page.tsx`: pass `demoPlans`, `solutions={[DEMO_FORECAST_SOLUTION]}` (the view adds the
tab's demo solutions). Keep its `note`, adding: "Try the sample plans “Hire in January” and “Hire in March”, or drag a
marker." Saving writes only the tab's store.

### Privacy

- Plans and the plan UI are for owners, editors and agency admins only (RLS and `mode !== "readonly"`). The People
  page's `ForecastPanel` and the live forecast are unchanged for members and viewers.
- No pay anywhere: hire markers carry no rate; the forecast shows no cost.

---

## Patterns to copy

| Need | Copy from |
|---|---|
| Migration header, RLS, revoke-then-grant, column grants, before-write trigger | `packages/db/supabase/migrations/20261122000000_solutions.sql` |
| Apply file | any file in `packages/db/scripts/apply/` (e.g. `20261207700000_saved_text_privacy.sql`) |
| Server action shape and error mapping | `apps/web/src/app/w/[slug]/solution-actions.ts` |
| Tab-only demo store | `apps/web/src/lib/solutions/demo.ts` |
| URL state | `ForecastView`'s `?horizon=` |
| SVG paths, tooltip, sr-only table, `useWidth` | `forecast-timeline.tsx`; second series dashed `var(--edit)`: `MrrChart` in `components/overview/charts.tsx` |
| Running in a worker | `useSimulation`, `SimulationClient` (`lib/sim`) |
| Browser test with a real worker | `apps/web/test/people-browser.test.ts`, `people-harness/entry.tsx` |
| Pure forecast tests | `apps/web/test/forecast.test.ts` |

---

## Edge cases (each needs the behaviour stated, most a test)

1. A hire dated on or before the forecast start: in the team from day 1 (as Settings' hires are); its marker sits at the
   left edge with "(already started)" in its label.
2. Any marker dated at or after the horizon: not drawn; listed "After this span"; the horizon picker bringing it into
   range draws it again. Solutions past the horizon start no segment.
3. Two solutions for one process in the same month: refused by `parsePlanInput` ("Two solutions for <process> can't go
   live in the same month."). In different months: the later replaces the earlier from its month.
4. A solution marker in month 0: one run, with the solution, for every month (no splice).
5. Two solution markers in the same month for different processes: one segment with both.
6. A deleted role / person / solution, an inactive person, or a solution whose process isn't in the company model:
   "Needs attention", skipped; the rest of the plan still runs. The database trigger checks every marker on each save, so
   **the app removes stale markers on save** after a confirm: "Save without the <n> marker(s) that need attention?"
   [Save without them] [Cancel]. Test it.
7. A solution copy the engine can't simulate: the plan's run fails with "“<name>” can't be simulated: …"; the live
   forecast and insights stay.
8. Leave overlapping Settings' leave (or another plan leave) for the same person: the engine's `awayHours`
   (`simulate.ts` l. 1018) **sums** windows, so an overlap would count twice. `applyPlanPeople` merges a person's
   overlapping or touching leave rows (Settings' and the plan's) into one row before returning. Test it.
9. Leave on a person whose Settings end date is before it: harmless (no hours); no problem shown.
10. Leave for a person a plan hires: not offered (the person picker lists real people only).
11. The horizon changes with a plan open: markers keep their dates; positions recompute; the run re-runs.
12. Another editor deleted or changed the plan: save says so (update returns no row); nothing is overwritten.
13. 50 plans, 40 markers, 4 solutions: Add / Save disabled with the reason, and the database refuses beyond.
14. The member view (`readonly`) with `?plan=` or `?compare=` in the URL: ignored, no plan UI.
15. Pooled model (no client roster): compare shows MRR and roles; "Clients at risk" says "Needs clients counted per
    service (Settings, Clients)".
16. Narrow screens (400 px): plan bar wraps; lane label above the lane; drag and keyboard both work; dialog fits.
17. A drag dropped outside the chart: snaps to the nearest end column; Escape cancels.

---

## Tests

**Engine** (`packages/engine/test/forecast.test.ts`): the four in Part 1.

**Database** (`packages/db/test/forecast-plans.test.ts`, role matrix): Part 2.

**Pure app** (`apps/web/test/forecast-plan.test.ts`, node):
1. `parsePlanInput`: accepts a plan with each kind; refuses every case the database refuses (same list) plus two solutions
   for one process in one month; trims the name.
2. `applyPlanPeople` on `demoForecastBundle()`: a hire adds a person (name "New PPC specialist", then "New PPC specialist
   2"), a `person_roles` row, `start_date`; `forecastModel` on it has that person with `from` equal to the hours to the 1st;
   leave adds a `person_leave` row Monday to Friday; a stale role/person is a problem and skipped.
3. `withSolution`: replaces the main process's steps (the step's work halves in `toEngineModel`); a solution of a servicing
   process in `otherProcesses` swaps that part only; an unknown process gives null.
4. `planSegments`: none → one segment; solutions at months 3 and 3 (two processes) → two segments [0, 3]; month 0 → one
   segment with it; past the horizon → `later`; same process at 2 and 5 → three segments, the third with the later copy.
5. `spliceMonthly`: built from small hand-made `MonthlyResult`s: flows switch at `k`; stocks are shifted by the offset at
   `k−1` and floored at 0; keys missing on one side; `k = 0` returns the segment as is.
6. **"A solution marker applies that solution's changes from its month only"** (the acceptance test): demo bundle, 12
   months, plan = `DEMO_FORECAST_SOLUTION` from the 1st of the fourth forecast month. Run segments with
   `simulate(model, 30, 1, { monthly: true, monthStarts })` in the test (no worker). Assert: months 0–2 of the spliced
   `roles`, `people`, `clients`, `mrr` and `atRisk` `toEqual` the live run's months 0–2; months 3+ of `roles` equal the
   solution run's; the PPC role's busy mean differs from live in at least one month ≥ 3 (the change does something); and a
   plan with the same solution from month 0 equals the solution run everywhere.
7. Positions: `positionOfDate` / `dateAtPosition` round-trip on month starts; week snap gives Mondays; the first column
   snaps to the 1st of the start's month; `stepDate` across a year end; clamping.
8. `comparePlans`: diff is `b.mean − a.mean`; null where a role isn't there; totals; pooled → `atRisk` empty and
   `totals.atRisk` null.
9. `timelineData` with `markersModel`: plan hires aren't in `markers`; `planPeople` rows are named "(plan)"; without
   options the output is unchanged (existing tests stay green).
10. `planFailure` messages.

**Browser** (`apps/web/test/forecast-plan-browser.test.ts` with `apps/web/test/forecast-harness/entry.tsx`, bundling
`simulate.worker.ts` as the people harness does; mount `ForecastView` in demo mode with `DEMO_FORECAST_START`; timeouts
as the people test). At 1440 px and 400 px each:
1. **Add and drag a hire**: open "Add a hire", pick PPC specialist, "Starts in" January 2027, Add → a `[data-plan-marker]`
   appears; wait for `data-plan-run` to increase. Read the PPC role's February cell from the sr-only table. Drag the
   marker with `page.mouse` (down on its centre, move in steps to the April column, up) → its `aria-valuetext` says
   "1 April 2027", `data-plan-run` increases again, and the PPC February cell now shows a higher average than before.
2. **Keyboard**: focus the marker, press ArrowLeft twice → "1 February 2027"; the live region announces the move; a run
   follows. PageDown → three months later. Delete → the marker is gone and a run follows.
3. **A click is not a drag**: a short click opens the edit dialog; Escape closes it; nothing moved.
4. **Escape cancels a drag** midway: the marker stays where it was; no run.
5. **Leave**: add leave for Dan Okafor from a Monday for 3 weeks → a bar in the lane; drag moves it in weeks (the
   valuetext date is a Monday).
6. **Solution and compare**: pick the sample "Hire in March" (it has the demo solution), check the "Needs attention" area
   is empty; open "Compare plans" with A "Hire in January" and B "Hire in March" → three tiles, the MRR chart, a "Clients at
   risk" chart per group and a chart per role render; "Show the numbers" lists every month with A, B and difference; the
   URL has `?compare=`.
7. **Save in the demo**: rename a plan, save, reload the plan picker → the new name; delete it → gone.
8. **Member view**: mount with `mode="readonly"` (and a member viewer bundle as the people harness's `asMember`): no plan
   bar, no lane, no "Compare plans", even with `?plan=` set.
9. Every case: no console errors (`pageerror`, `console.error`).

**Existing suites** must stay green: `forecast.test.ts`, `horizon-performance.test.ts`, `people-browser.test.ts`,
`overview-browser.test.ts` (the Overview's team-load chart reuses `timelineData`/`ForecastTimeline`), the engine's golden
and determinism tests.

**Performance check** (record in the PR, no new test): on full Northbeam, 12 months, time a plan with one solution (two
runs) and a compare of two such plans in the browser; expect roughly twice and four times one forecast run (B6: about half
a second for 12 months).

---

## Docs

- `docs/PRD.md`: §4.1 Forecasting, replace "Forecast runs are saved like any run; two forecasts can be compared" with
  plans (named marker sets, saved, compared; solutions spliced from their month); §5 data model, replace the `forecasts`
  line with `forecast_plans id, workspace_id, name, markers jsonb ([{id, kind: hire|leave|solution, date, …}]),
  created_by, dates`; add a decision row for "solution from a month = spliced runs" and "plans are editors-only".
- `CONTEXT.md`: add **Plan** ("a named set of forecast markers: hires, leave and solutions going live; it never changes
  the live model") if the file has a glossary; keep its style.
- `docs/production-migrations.md`: the new row (NOT applied), with the header's preflight, checks and rollback summary.
- `docs/supabase-notes.md`: only if something was verified against plain Postgres alone (e.g. the trigger messages
  through PostgREST).

---

## Out of scope

- Dragging Settings' own hires, end dates and leave (they stay fixed markers; edit them in Settings) (Q6).
- Applying a solution's `lever_changes` (Q4); end-date ("someone leaves") markers in plans.
- Saving run results with a plan (plans store markers; numbers are re-run), PDF or share links of plans.
- Plans in workspace export / restore (B10) (Q9) and in MCP tools.
- Plans on the Overview or the People page's forecast.
- Any engine change beyond the two monthly outputs; any `ENGINE_VERSION` bump.
- Members and viewers seeing plans (Q1).

## Done criteria

- [ ] Every acceptance criterion of #36 met, each pointed to by a test or a screenshot in the PR.
- [ ] Engine: `mrr` and `atRisk` in `MonthlyResult`; golden and determinism tests unchanged; no version bump.
- [ ] Migration `20261213000000_forecast_plans.sql` with header (what, additive, preflight, post-apply, rollback), apply
      file, `bootstrap.sql` regenerated, `database.types.ts` hand-edited, production-migrations row NOT applied.
- [ ] Database tests and the role-matrix entry pass.
- [ ] Unit tests (Part 3 list) and browser tests (both widths) pass; no console errors.
- [ ] Every control on the plan bar, dialog and compare view has an (i) with the text above.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` green locally (known
      container-only failures excepted) and in CI.
- [ ] Screenshots (light and dark, 1440 and 400 px) of the plan lane, the marker dialog and the compare view, described
      in the PR.
- [ ] PR body (pr skill): `Closes #36`, migration and apply file, "no engine numbers move, no version bump", preflight,
      every Q default taken.

---

## Open questions (each has a default; the builder takes it)

| # | Question | Default |
|---|---|---|
| Q1 | Who sees plans? | Owners, editors and agency admins only (RLS `can_edit_workspace` for every command). A hypothetical leave names a person, which is per-person data members don't see (B1). Members and viewers see the forecast as today. |
| Q2 | How does a solution apply "from its month"? | Spliced runs (Part 3), not an engine switch. The engine can't change a process's steps mid-run; building that is large and risky. |
| Q3 | Client numbers and MRR when a solution goes live | Carried on from where they were (offset at the month before), changing as the solution's run changes from there; busy levels switch at once. |
| Q4 | A solution's lever changes | Not applied, as on the Solution page today; the dialog says so. |
| Q5 | Drag granularity | Hires and solutions by month (the 1st), leave by week (Mondays, whole weeks). |
| Q6 | Settings' own hires and leave | Shown as now, not draggable; plan markers only. |
| Q7 | Ranges on the difference | Each plan's own 10–90% range is shown; the difference is of the averages (same seed for both, so it is not noise). A range of the difference would need per-run monthly numbers; follow-up if wanted. |
| Q8 | `ENGINE_VERSION` bump for the new monthly outputs? | No: golden outputs don't include `monthly`, B6 added `monthly` without a bump, and nothing saved records monthly numbers. |
| Q9 | Plans in export/restore | No; a follow-up for B10/B21. |
| Q10 | Limits | 50 plans per workspace, 40 markers per plan, 4 solutions per plan, names up to 120 characters, unique per workspace ignoring case. |
| Q11 | Alerts with a plan open | Insights (acknowledgeable) stay on the live forecast; a plan shows a "With this plan" summary that can't be acknowledged. |
| Q12 | Cost of a hire | None: the forecast shows no cost, and no rate is stored. |
| Q13 | Stale markers | "Needs attention", skipped in the run; removed on save after a confirm. |
| Q14 | Leave for someone a plan hires | Not offered. |
| Q15 | Compare an unsaved plan | No: save it first ("Save a plan to compare it"). |
