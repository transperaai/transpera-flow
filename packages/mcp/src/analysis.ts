// The analysis tools' logic, free of I/O (docs/PRD.md §7.1; issue #26): given
// an engine model and the saved scenarios a call names, compare them, check
// robustness, and rank bottlenecks with the shadow price. The tools in
// analysis-tools.ts load rows as the user and call these; the tests call them
// directly. Every sentence comes from the engine's fixed templates, never a
// language model (docs/PRD.md §7.3, decision D15).

import {
  applyPatches,
  compareHeadline,
  compareRuns,
  compareTable,
  estimatedParameters,
  headlineSubject,
  isBlocking,
  provenanceFromRows,
  rankBottlenecks,
  robustness,
  robustnessVerdict,
  shadowPrice,
  shadowPriceText,
  simulate,
  type EngineModel,
  type ProvenanceRows,
  type RobustnessMetric,
  type RobustnessParameter,
  type ScenarioPatch,
  type SimulationResult,
  type Stat,
} from "@transpera-flow/engine";
import { ToolError } from "./result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One item by id or name (case-insensitive): an exact match, else the only
 * partial match. Ambiguity and misses fail with the candidates rather than a
 * guess (docs/PRD.md §7.1 "Naming").
 */
export function matchNamed<T extends { id: string; name: string }>(items: readonly T[], ref: string, kind: string, where = ""): T {
  const needle = ref.trim().toLowerCase();
  const list = (xs: readonly T[]) => xs.map((x) => ({ id: x.id, name: x.name }));
  const exact = items.filter((x) => x.id.toLowerCase() === needle || x.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = UUID.test(needle) ? [] : items.filter((x) => x.name.toLowerCase().includes(needle));
  if (exact.length === 0 && partial.length === 1) return partial[0]!;
  const candidates = exact.length ? exact : partial;
  if (candidates.length) throw new ToolError("ambiguous", `'${ref}' matches more than one ${kind}${where}`, list(candidates));
  throw new ToolError("not_found", `No ${kind}${where} matches '${ref}'`, list(items).slice(0, 50));
}

export interface NamedScenario {
  id: string;
  name: string;
  patch: ScenarioPatch[];
}

/**
 * The patches of scenarios stacked in order, refusing any scenario the model
 * can't apply (a deleted step, a person who left): docs/PRD.md §6.2 and D10
 * say such a scenario "needs attention" and is never silently run.
 */
export function stackPatches(model: EngineModel, scenarios: readonly NamedScenario[]): ScenarioPatch[] {
  for (const s of scenarios) {
    const blocking = applyPatches(model, s.patch).issues.filter(isBlocking);
    if (blocking.length) {
      throw new ToolError(
        "needs_attention",
        `“${s.name}” needs attention and can't be run: ${blocking.map((i) => i.message).join(" ")}`,
        blocking,
      );
    }
  }
  return scenarios.flatMap((s) => s.patch);
}

const roleNamesOf = (model: EngineModel) => Object.fromEntries(Object.entries(model.roles).map(([id, r]) => [id, r.name]));

// ---------------------------------------------------------------------------
// compare_scenarios
// ---------------------------------------------------------------------------

export interface CompareInput {
  model: EngineModel;
  /** The baseline side's scenarios (none: the model as it is, as in the app). */
  a: readonly NamedScenario[];
  /** The scenario side's scenarios, stacked in order. */
  b: readonly NamedScenario[];
  reps: number;
  seed: number;
  currency: string;
}

/**
 * Baseline vs scenario, as the app's compare view does it: both sides run with
 * the same seed and replication count (so the change's range is paired),
 * `compareRuns`, the delta table from `compareTable`, and the headline from
 * `compareHeadline` with the subject from `headlineSubject`.
 */
export function compareScenarios({ model, a, b, reps, seed, currency }: CompareInput) {
  if (!b.length) throw new ToolError("invalid_input", "Name at least one scenario to compare (`b`).");
  const aPatches = stackPatches(model, a);
  const bPatches = stackPatches(model, b);
  const sideA = aPatches.length ? applyPatches(model, aPatches) : { model, issues: [] };
  const sideB = applyPatches(model, bPatches);
  const runA = simulate(sideA.model, reps, seed);
  const runB = simulate(sideB.model, reps, seed);
  const comparison = compareRuns(runA, runB);
  const roleNames = roleNamesOf(model);
  const { subject: bSubject, plural } = headlineSubject(
    b.map((s) => s.name),
    false,
  );
  const subject = a.length ? `${bSubject}, against ${headlineSubject(a.map((s) => s.name), false).subject},` : bSubject;
  const headline = compareHeadline({
    comparison,
    subject,
    plural,
    horizonWeeks: model.horizonWeeks,
    hoursPerWeek: model.hoursPerWeek,
    currency,
    roleNames,
  });
  const table = compareTable(comparison, { horizonWeeks: model.horizonWeeks, hoursPerWeek: model.hoursPerWeek, currency });
  const people = { ...runA.resolvedPeople, ...runB.resolvedPeople };
  const notes = [...sideA.issues, ...sideB.issues].map((i) => i.message);
  const name = (id: string | null) => (id ? { id, name: roleNames[id] ?? id } : null);
  return {
    headline: headline.headline,
    details: headline.details,
    text: [headline.headline, ...headline.details].join(" "),
    table: table.map((r) => ({ metric: r.metric, label: r.label, better: r.better, tone: r.tone, ...r.text, paired: r.delta.paired, stats: r.delta })),
    utilisation: {
      roles: Object.entries(comparison.roles).map(([id, v]) => ({ id, name: roleNames[id] ?? id, ...v })),
      people: Object.entries(comparison.people).map(([id, v]) => ({ id, name: people[id]?.name ?? id, ...v })),
    },
    bottleneck: { baseline: name(comparison.bottleneck.baseline), scenario: name(comparison.bottleneck.scenario) },
    notes,
    runs: { baseline: runA, scenario: runB },
  };
}

// ---------------------------------------------------------------------------
// check_robustness
// ---------------------------------------------------------------------------

/**
 * Parameters to perturb: every estimated one. Steps, services and the
 * workspace settings (the health rules; issue #79) carry provenance, and
 * entered values are not perturbed; a health rule the workspace
 * hasn't set is the estimated default. Demand and roles carry none the check
 * reads, so theirs are all estimated. The same rule as the app's (apps/web
 * lib/robustness/session.ts `robustnessParameters`).
 */
export function robustnessParameters(model: EngineModel, rows: ProvenanceRows, metric: RobustnessMetric = "won"): RobustnessParameter[] {
  return estimatedParameters(model, { provenance: provenanceFromRows(rows), metric });
}

export interface RobustnessInput {
  model: EngineModel;
  scenario: readonly NamedScenario[];
  /** The rows whose provenance says which values are estimated. */
  provenance: ProvenanceRows;
  metric: RobustnessMetric;
  currency: string;
  timeBudgetMs: number;
  now?: () => number;
}

/** The robustness check on this thread, capped at `timeBudgetMs`; a capped check is flagged partial. */
export function checkScenarioRobustness({ model, scenario, provenance, metric, currency, timeBudgetMs, now }: RobustnessInput) {
  if (!scenario.length) throw new ToolError("invalid_input", "Name a scenario to check (`scenario`).");
  const patches = stackPatches(model, scenario);
  const parameters = robustnessParameters(model, provenance, metric);
  const { subject, plural } = headlineSubject(
    scenario.map((s) => s.name),
    false,
  );
  if (!parameters.length) {
    return {
      verdict: "Every input is entered, so there is nothing estimated to check.",
      details: [] as string[],
      sensitive: [] as { label: string; effect: string; flips: boolean }[],
      complete: true,
      partial: false,
      parameters: 0,
      screened: 0,
      runs: 0,
      result: null,
    };
  }
  const result = robustness(model, patches, { parameters, metric, timeBudgetMs, ...(now ? { now } : {}) });
  const v = robustnessVerdict({ result, subject, plural, roleNames: roleNamesOf(model), horizonWeeks: model.horizonWeeks, currency });
  return {
    verdict: v.verdict,
    details: v.details,
    sensitive: v.sensitive,
    complete: result.complete,
    partial: !result.complete,
    parameters: result.parameters,
    screened: result.screened,
    runs: result.runs,
    result,
  };
}

// ---------------------------------------------------------------------------
// get_bottlenecks
// ---------------------------------------------------------------------------

export interface BottleneckInput {
  model: EngineModel;
  reps: number;
  seed: number;
  /** Cap on the shadow price's extra replication set. */
  timeBudgetMs: number;
  limit?: number;
  /** The baseline run, if the caller already has it (it must be simulate(model, reps, seed)). */
  run?: SimulationResult;
  now?: () => number;
}

export interface ShadowPriceView {
  role: { id: string; name: string };
  /** Extra completed units (wins + done items) per quarter from one more FTE in the role. */
  per_quarter: Stat;
  baseline_per_quarter: Stat;
  with_fte_per_quarter: Stat;
  patch: ScenarioPatch[];
  reps: number;
  requested_reps: number;
  complete: boolean;
  text: string;
}

/** Ranked constraints of the model's baseline run, and the shadow price of the top one. */
export function bottleneckReport({ model, reps, seed, timeBudgetMs, limit, run, now }: BottleneckInput) {
  const result = run ?? simulate(model, reps, seed);
  const ranked = rankBottlenecks(model, result, limit === undefined ? {} : { limit });
  const top = ranked.top;
  const sp = top ? shadowPrice(model, top.id, { reps, seed, timeBudgetMs, ...(now ? { now } : {}) }) : null;
  const shadow: ShadowPriceView | null =
    top && sp
      ? {
          role: { id: top.id, name: top.name },
          per_quarter: sp.perQuarter,
          baseline_per_quarter: sp.baselinePerQuarter,
          with_fte_per_quarter: sp.withFtePerQuarter,
          patch: sp.patch,
          reps: sp.reps,
          requested_reps: sp.requestedReps,
          complete: sp.complete,
          text: shadowPriceText(sp, top.name),
        }
      : null;
  const text = top
    ? [top.evidence, ranked.steps[0]?.evidence, shadow?.text].filter((s): s is string => Boolean(s)).join(" ")
    : "This process has no roles, so nothing limits it but demand.";
  return { top, roles: ranked.roles, people: ranked.people, steps: ranked.steps, threshold: ranked.threshold, shadow_price: shadow, text, result };
}
