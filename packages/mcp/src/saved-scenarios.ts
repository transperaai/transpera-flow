// Saved Sandbox scenarios on MCP (docs/plans/sandbox-p5-brief.md §4): `list_scenarios` and `run_scenario`'s saved mode. A saved scenario
// runs on exactly the Sandbox page's inputs (the live company model with phase 4's delete candidates, the workspace's solutions and
// scenarios, read as the token's user) through the same runner (`@transpera-flow/db/sandbox`), so its months equal the page's.
// Read-only: nothing here writes.

import {
  canSeePerson,
  A_TEAM_MEMBER,
  loadProcessBySlug,
  loadScenarios,
  loadSandboxScenarios,
  loadSolutions,
  sandboxLever,
  workspacePurposes,
  type ProcessBundle,
  type SandboxChange,
  type SandboxScenarioRow,
  type SolutionRow,
  type Viewer,
  type WorkspaceSettings,
} from "@transpera-flow/db";
import {
  dateAtHour,
  effectiveChanges,
  effectiveLimitProblem,
  prepareScenario,
  simulateScenario,
  timeRows,
  SANDBOX_REPS,
  SANDBOX_SEED,
  type EffectiveChange,
  type PreparedScenario,
  type ScenarioRun,
  type TimeRows,
} from "@transpera-flow/db/sandbox";
import { CHURN_DRIVER_SPECS, CUSTOM_DRIVER_PREFIX, ENGINE_VERSION, isTooBusy, toRatingConfig, type BuiltinChurnDriverId, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { matchNamed } from "./analysis";
import type { ToolContext, WorkspaceRef } from "./context";
import { ToolError } from "./result";

/** The name that runs the live model with no changes, as the Sandbox's first column does. */
export const NO_CHANGES = "No changes";

/** What the Sandbox page loads, read as the token's user. */
export interface SandboxInputs {
  bundle: ProcessBundle;
  solutions: SolutionRow[];
  scenarios: SandboxScenarioRow[];
}

/** The page's inputs: the first live process of the workspace with its servicing processes, the solutions, the scenarios. */
export async function loadSandboxInputs(ctx: ToolContext, ws: WorkspaceRef): Promise<SandboxInputs> {
  const loaded = await loadProcessBySlug(ctx.db, ws.slug, { draft: false });
  if (!loaded || loaded.live.revision.number === 0) throw new ToolError("not_found", `Nothing is published in '${ws.name}' yet, so there is no live model to run scenarios on. Publish a process first.`);
  const live = loaded.live;
  const [solutions, scenarios] = await Promise.all([loadSolutions(ctx.db, ws.id), loadSandboxScenarios(ctx.db, ws.id)]);
  return { bundle: live, solutions, scenarios };
}

// ---------------------------------------------------------------------------
// Changes in structured fields (no sentences: open question 8)
// ---------------------------------------------------------------------------

export interface ChangeOut {
  id: string;
  lever: string;
  lever_label: string;
  target: string | null;
  /** What the target is called for this reader, "gone" when it isn't in the model any more; null for a change with no target. */
  target_name: string | null;
  op: string;
  value: number;
  from: string | null;
  params: SandboxChange["params"] | null;
  note: string | null;
  /** The scenario this change comes from when it isn't the scenario's own (a parent's). */
  inherited_from: { id: string; name: string } | null;
}

const GONE = "gone";

function viewerOf(bundle: Pick<ProcessBundle, "viewer">): Viewer {
  return bundle.viewer ?? { seesEveryone: true, ownPersonId: null };
}

/** The name of what a change points at, as the token's user may read it. "gone" when the target is no longer in the live model; null with no target, or with no live model to look in. */
export function targetNameOf(c: SandboxChange, bundle: ProcessBundle | null, solutions: readonly Pick<SolutionRow, "id" | "name">[]): string | null {
  const lever = sandboxLever(c.lever);
  if (!lever || c.target === null || !bundle) return null;
  const t = c.target;
  if (t === "@busiest") return "the busiest role";
  if (t === "@heaviest") return "the heaviest step";
  switch (lever.target) {
    case "lead_source_or_none":
      return bundle.leadSources?.find((x) => x.id === t)?.name ?? GONE;
    case "driver":
      return (t.startsWith(CUSTOM_DRIVER_PREFIX) ? bundle.churnDrivers?.find((d) => `${CUSTOM_DRIVER_PREFIX}${d.id}` === t)?.name : CHURN_DRIVER_SPECS[t as BuiltinChurnDriverId]?.name) ?? GONE;
    case "role":
    case "role_or_none":
      return bundle.roles.find((r) => r.id === t)?.name ?? GONE;
    case "person": {
      const found = bundle.people.find((p) => p.id === t);
      if (!found) return GONE;
      const v = viewerOf(bundle);
      if (canSeePerson(v, found.id)) return found.name;
      // Other people are labelled the way the page labels them: "Team member N" by position, never one shared label.
      return found.name !== A_TEAM_MEMBER ? found.name : `Team member ${bundle.people.findIndex((p) => p.id === found.id) + 1}`;
    }
    case "step":
      return [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)].find((s) => s.id === t)?.name ?? GONE;
    case "service":
    case "service_or_none":
      return bundle.services.find((s) => s.id === t)?.name ?? GONE;
    case "solution":
      return solutions.find((s) => s.id === t)?.name ?? GONE;
    case "health_rule":
      return t.replace("_", " ");
    default:
      return null;
  }
}

export function changeOut(e: EffectiveChange, bundle: ProcessBundle | null, solutions: readonly SolutionRow[]): ChangeOut {
  const c = e.change;
  return {
    id: c.id,
    lever: c.lever,
    lever_label: sandboxLever(c.lever)?.label ?? c.lever,
    target: c.target,
    target_name: targetNameOf(c, bundle, solutions),
    op: c.op,
    value: c.value,
    from: c.from ?? null,
    params: c.params ?? null,
    note: c.note ?? null,
    inherited_from: e.inherited ? { id: e.scenarioId, name: e.scenarioName } : null,
  };
}

// ---------------------------------------------------------------------------
// list_scenarios
// ---------------------------------------------------------------------------

/** Every saved scenario with its effective changes, what it builds on, and whether the whole-run tools take it. No run. */
export async function listScenarios(ctx: ToolContext, ws: WorkspaceRef) {
  const [scenarios, standalone] = await Promise.all([loadSandboxScenarios(ctx.db, ws.id), loadScenarios(ctx.db, ws.id)]);
  // The bundle names targets; a workspace with nothing published still lists its scenarios (the names are then null).
  let inputs: Pick<SandboxInputs, "bundle" | "solutions"> | null = null;
  try {
    inputs = await loadSandboxInputs(ctx, ws);
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
  }
  const solutions = inputs?.solutions ?? (await loadSolutions(ctx.db, ws.id));
  const anywhere = new Set(standalone.map((s) => s.id));
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const rows = scenarios.map((s) => {
    const eff = effectiveChanges(s, scenarios);
    let problem: string | null = null;
    let list: EffectiveChange[];
    if (eff.ok) {
      list = eff.changes;
      problem = effectiveLimitProblem(eff.changes.map((c) => c.change));
    } else {
      problem = eff.error;
      list = s.changes.map((change) => ({ change, scenarioId: s.id, scenarioName: s.name, inherited: false }));
    }
    const parent = s.parent_id ? byId.get(s.parent_id) : undefined;
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      parent: s.parent_id ? { id: s.parent_id, name: parent?.name ?? GONE } : null,
      horizon_months: s.horizon_months,
      updated_at: s.updated_at,
      runs_in: anywhere.has(s.id) ? ("anywhere" as const) : ("sandbox" as const),
      changes: list.map((e) => changeOut(e, inputs?.bundle ?? null, solutions)),
      problem,
    };
  });
  const text = rows.length
    ? `${rows.length} saved scenario${rows.length === 1 ? "" : "s"}: ${rows.map((r) => `${r.name} (${r.changes.length} change${r.changes.length === 1 ? "" : "s"}${r.problem ? `, needs attention: ${r.problem}` : ""})`).join("; ")}. Run one with run_scenario.`
    : "No saved scenarios yet. run_scenario with scenario \"No changes\" runs the live model.";
  return { workspace: { id: ws.id, name: ws.name }, scenarios: rows, text };
}

// ---------------------------------------------------------------------------
// run_scenario, saved mode
// ---------------------------------------------------------------------------

/** One stat as plain numbers. */
const stat = (s: Stat) => ({ mean: s.mean, p10: s.p10, p90: s.p90 });
const stats = (list: readonly Stat[]) => list.map(stat);
const sumStats = (lists: readonly (readonly Stat[])[], n: number): Stat[] =>
  Array.from({ length: n }, (_, m) => lists.reduce<Stat>((a, l) => ({ mean: a.mean + (l[m]?.mean ?? 0), p10: a.p10 + (l[m]?.p10 ?? 0), p90: a.p90 + (l[m]?.p90 ?? 0) }), { mean: 0, p10: 0, p90: 0 }));
const total = (list: readonly Stat[]) => list.reduce((a, s) => a + s.mean, 0);

/** The named series of a run, each month a mean with its 10-90% range. Profit and labour are null when pay is hidden. */
export function seriesOf(monthly: MonthlyResult) {
  const n = monthly.months.length;
  const money = monthly.money;
  const labour = money ? money.labour.map((v, i) => ({ mean: v + money.overtimeCost[i]!.mean, p10: v + money.overtimeCost[i]!.p10, p90: v + money.overtimeCost[i]!.p90 })) : null;
  return {
    revenue: stats(monthly.revenue.total),
    mrr: stats(monthly.mrr),
    opportunities: stats(monthly.sales.opportunities),
    won: stats(monthly.sales.won),
    lost: stats(monthly.sales.lost),
    conversion: stats(monthly.sales.conversion),
    clients_won: stats(monthly.clientsWon),
    clients_lost: stats(monthly.clientsLost),
    at_risk: stats(sumStats(Object.values(monthly.atRisk), n)),
    late_tasks: stats(monthly.lateTasks),
    overtime_hours: stats(monthly.overtimeHours),
    profit: money ? stats(money.profit) : null,
    labour,
  };
}

const busyOut = (series: readonly ({ mean: number; p10: number; p90: number } | null)[] | undefined, n: number) => Array.from({ length: n }, (_, m) => (series?.[m] ? stat(series[m]!) : null));

function rolesOut(monthly: MonthlyResult, names: Record<string, string>) {
  const n = monthly.months.length;
  return Object.fromEntries(Object.keys(monthly.roles).map((id) => [id, { name: names[id] ?? id, busy: busyOut(monthly.roles[id], n), uncovered: Array.from({ length: n }, (_, m) => monthly.uncovered[id]?.[m] ?? null) }]));
}

/** Where the time goes, hours per month (means) by category: the team and each role. Never by person. */
function timeOut(monthly: MonthlyResult, categories: ReturnType<typeof workspacePurposes>, roleNames: Record<string, string>) {
  const n = monthly.months.length;
  const split = (rows: TimeRows) => Object.fromEntries(rows.rows.map((r) => [r.id, { hours: r.hours.map((s) => s.mean), share: r.share, run_hours: r.runHours, run_share: r.runShare }]));
  const team = timeRows(monthly, n, categories, { kind: "team" });
  return {
    categories: team.rows.map((r) => ({ key: r.id, name: r.name })),
    hours_available: team.total.map((s) => s.mean),
    team: split(team),
    roles: Object.fromEntries(Object.keys(monthly.time.roles).map((id) => [id, { name: roleNames[id] ?? id, ...split(timeRows(monthly, n, categories, { kind: "role", id })) }])),
    notes: team.notes,
  };
}

function totalsOut(monthly: MonthlyResult, cutoffs: readonly [number, number, number]) {
  const money = monthly.money;
  return {
    revenue: total(monthly.revenue.total),
    profit: money ? total(money.profit) : null,
    clients_lost: total(monthly.clientsLost),
    too_busy_months: Object.values(monthly.roles).reduce((n, series) => n + series.filter((m) => m !== null && isTooBusy(m.mean, cutoffs)).length, 0),
  };
}

/** A real calendar date from 2000 to 2100 as YYYY-MM-DD: what a saved scenario's run can start on (its months are walked from it). */
export function isRunDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A saved scenario (by id or name), or null for "No changes". */
export function pickScenario(scenarios: readonly SandboxScenarioRow[], ref: string, ws: WorkspaceRef): SandboxScenarioRow | null {
  if (ref.trim().toLowerCase() === NO_CHANGES.toLowerCase() && !scenarios.some((s) => s.name.trim().toLowerCase() === NO_CHANGES.toLowerCase())) return null;
  return matchNamed(scenarios, ref, "saved scenario", ` in '${ws.name}'`);
}

/** The effective changes of a scenario, or a ToolError saying why it can't run. */
export function changesOf(scenario: SandboxScenarioRow | null, scenarios: readonly SandboxScenarioRow[]): EffectiveChange[] {
  if (!scenario) return [];
  const eff = effectiveChanges(scenario, scenarios);
  if (!eff.ok) throw new ToolError("scenario_error", eff.error);
  const limit = effectiveLimitProblem(eff.changes.map((c) => c.change));
  if (limit) throw new ToolError("scenario_error", limit);
  return eff.changes;
}

function prepare(inputs: SandboxInputs, changes: EffectiveChange[], months: number, startDate: string): PreparedScenario {
  const prepared = prepareScenario(inputs.bundle, changes, inputs.solutions, months, startDate);
  if (prepared.error !== null) throw new ToolError("scenario_error", prepared.error);
  return prepared;
}

export interface SavedRunArgs {
  scenario: string;
  months?: number;
  include_baseline: boolean;
  include_people: boolean;
  startDate: string;
}

/** Run a saved scenario (and, unless it is "No changes", the live model beside it) the way the Sandbox does. */
export async function runSaved(ctx: ToolContext, ws: WorkspaceRef, args: SavedRunArgs, assumptions: string[]) {
  const inputs = await loadSandboxInputs(ctx, ws);
  const scenario = pickScenario(inputs.scenarios, args.scenario, ws);
  const months = args.months ?? scenario?.horizon_months ?? 12;
  if (args.months === undefined) assumptions.push(scenario ? `months defaulted to the scenario's horizon (${months}).` : `months defaulted to ${months}.`);
  const changes = changesOf(scenario, inputs.scenarios);

  const started = performance.now();
  const prepared = prepare(inputs, changes, months, args.startDate);
  const { run, priceRise } = simulateScenario(prepared);
  const baseline = args.include_baseline && scenario ? simulateScenario(prepare(inputs, [], months, args.startDate), { pair: false }).run : null;

  const monthly = run.result.monthly!;
  const hpw = run.model.hoursPerWeek;
  const cutoffs = toRatingConfig({}, hpw).rules.busy.cutoffs;
  const { bundle } = inputs;
  const roleNames = Object.fromEntries(Object.entries(run.model.roles).map(([id, r]) => [id, r.name]));
  const categories = workspacePurposes(bundle.workspace.settings as WorkspaceSettings);
  const view = (r: ScenarioRun) => ({ series: seriesOf(r.result.monthly!), roles: rolesOut(r.result.monthly!, roleNames), totals: totalsOut(r.result.monthly!, cutoffs) });
  const main = view(run);
  const base = baseline ? view(baseline) : null;
  const diffTotals =
    base === null
      ? null
      : {
          revenue: main.totals.revenue - base.totals.revenue,
          profit: main.totals.profit !== null && base.totals.profit !== null ? main.totals.profit - base.totals.profit : null,
          clients_lost: main.totals.clients_lost - base.totals.clients_lost,
          too_busy_months: main.totals.too_busy_months - base.totals.too_busy_months,
        };
  assumptions.push("Months before a timed change are the No changes run exactly (pinned warm-up).");
  if (scenario === null) assumptions.push("No changes runs the live model as it is; there is no baseline to compare it with.");
  assumptions.push(`${SANDBOX_REPS} replications and seed ${SANDBOX_SEED}, as the Sandbox runs them; whole-run figures come from the months (kpi is not returned for a spliced run).`);

  return {
    workspace: { id: ws.id, name: ws.name },
    scenario: scenario ? { id: scenario.id, name: scenario.name, parent: scenario.parent_id ? { id: scenario.parent_id, name: inputs.scenarios.find((s) => s.id === scenario.parent_id)?.name ?? GONE } : null } : { id: null, name: NO_CHANGES, parent: null },
    start_date: args.startDate,
    months,
    engine_version: ENGINE_VERSION,
    reps: SANDBOX_REPS,
    seed: SANDBOX_SEED,
    segments: prepared.segments.length,
    spliced: run.spliced,
    changes: changes.map((e) => changeOut(e, bundle, inputs.solutions)),
    problems: prepared.problems.map((p) => ({ change_id: p.changeId, message: p.message, note: p.note === true })),
    later: prepared.later,
    month_starts: monthly.months.map((m) => dateAtHour(args.startDate, m.start, hpw).toISOString().slice(0, 10)),
    series: main.series,
    roles: main.roles,
    ...(args.include_people
      ? {
          // As the Sandbox shows them: everyone to those who see everyone, else only the reader's own person (B1 2b), never others' rows by label.
          people: Object.fromEntries(
            Object.keys(monthly.people).filter((id) => canSeePerson(viewerOf(bundle), id)).map((id) => [id, { name: run.result.resolvedPeople[id]?.name ?? id, busy: busyOut(monthly.people[id], monthly.months.length) }]),
          ),
        }
      : {}),
    time: timeOut(monthly, categories, roleNames),
    totals: main.totals,
    price_rise: priceRise,
    baseline: base,
    diff: diffTotals ? { totals: diffTotals } : null,
    duration_ms: Math.round(performance.now() - started),
  };
}
