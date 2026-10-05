// Robustness check (docs/PRD.md §6.5, decisions D5 and D11, issue #20): does
// the compare view's conclusion still hold if the estimates are off?
//
// Every estimated parameter is perturbed one at a time (±25% by default, or a
// conflicted value's actual range), and the baseline and the scenario are
// both re-run under each perturbation. Two stages keep the cost down:
//
// 1. Screen: every parameter, both directions, at `screenReps` (10)
//    replications.
// 2. Refine: the `refineTop` (5) most influential parameters, both
//    directions, topped up to `refineReps` (30) replications.
//
// Replication i of every run uses the same seed (seed + i × SEED_STRIDE), so
// the baseline, the scenario and every perturbation see the same random
// streams (common random numbers): a difference between two runs is the
// parameter's doing, not noise. The unperturbed ("nominal") runs use the
// compare view's seed and replication count, so they reproduce its numbers.
//
// Work is split into jobs of at most `screenReps` replications of one
// perturbation, both sides. A job is a pure function of the model, the
// scenario and the job, so jobs can run anywhere (this thread, a browser
// worker pool, a Node process) and be cached by (model hash, scenario hash,
// parameter, perturbation, replications). A refine job's first chunk is the
// screen job itself, so stage two only runs the missing replications.
// Results are merged in replication order, so they do not depend on how many
// workers ran them or in which order they finished: the check is
// deterministic for a given seed.
//
// Output: the share of perturbed runs in which the nominal bottleneck (on
// each side) stays the bottleneck and in which the headline delta keeps its
// sign, and the parameters ranked by how much they move the delta ("measure
// this next"). `robustnessVerdict` turns that into sentences from fixed
// templates; no language model is involved.
//
// Framework-free and dependency-free, like the rest of the engine.

import { withClientGroups } from "./clients";
import type { EngineModel } from "./model";
import { applyPatches, HEALTH_RULE_KEYS, PATCH_FIELDS, parsePatchPath, type PatchTarget, type ScenarioPatch } from "./scenario";
import { hasServicing, healthRules } from "./servicing";
import { initialState, runOnce, SEED_STRIDE } from "./simulate";

/** Bump when the engine or this module changes what a job returns, so stale cache entries are never read. */
export const ROBUSTNESS_VERSION = 1;

/** The headline metric whose delta's sign the check tests. `won` is the compare headline's. */
export type RobustnessMetric = "won" | "mrrAdded";

/** One input to perturb: a patch path and the multipliers for its low and high runs. */
export interface RobustnessParameter {
  path: string;
  /** Multiplier for the low run (0.75 for ±25%). */
  low: number;
  /** Multiplier for the high run (1.25 for ±25%). */
  high: number;
  /** True when the range comes from conflicting estimates rather than ±perturbation. */
  conflict?: boolean;
}

export interface RobustnessOptions {
  /** Seed of replication 0; the compare view uses 1. */
  seed?: number;
  metric?: RobustnessMetric;
  /** Relative perturbation for parameters without a conflict range (0.25 = ±25%). */
  perturbation?: number;
  /** Replications per perturbation in stage one (also the job size). */
  screenReps?: number;
  /** Replications per perturbation in stage two, and of the nominal runs. */
  refineReps?: number;
  /** How many parameters stage two refines. */
  refineTop?: number;
  /** The parameters to perturb; defaults to every perturbable parameter (`estimatedParameters(model)`). */
  parameters?: RobustnessParameter[];
}

/** One unit of work: `reps` replications from `repStart` of one perturbation, baseline and scenario. */
export interface RobustnessJob {
  /** Patch path perturbed, or null for the nominal (unperturbed) runs. */
  path: string | null;
  /** Multiplier applied to the parameter (1 for nominal). */
  factor: number;
  seed: number;
  repStart: number;
  reps: number;
}

/** What a worker needs to run a job. */
export interface RobustnessTask {
  model: EngineModel;
  scenario: ScenarioPatch[];
  job: RobustnessJob;
}

/** Per-replication values of one side, in replication order. */
export interface SideSamples {
  won: number[];
  mrrAdded: number[];
  /** Utilisation per replication, by role id in the model's role order. */
  util: Record<string, number[]>;
}

/** A job's result: both sides' per-replication values. */
export interface ChunkResult {
  baseline: SideSamples;
  scenario: SideSamples;
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

function runSide(model: EngineModel, job: RobustnessJob): SideSamples {
  const start = initialState(model);
  const out: SideSamples = { won: [], mrrAdded: [], util: {} };
  for (const rid in model.roles) out.util[rid] = [];
  for (let i = job.repStart; i < job.repStart + job.reps; i++) {
    const r = runOnce(model, job.seed + i * SEED_STRIDE, false, start);
    out.won.push(r.won);
    out.mrrAdded.push(r.newMrr);
    for (const rid in model.roles) out.util[rid]!.push(r.roles[rid]!.util);
  }
  return out;
}

/**
 * Run one job: the baseline with the perturbation, and the scenario (its
 * patches applied after the perturbation, so a `multiply` lever acts on the
 * perturbed value and a `set` overrides it). Pure and synchronous.
 */
export function runRobustnessTask({ model, scenario, job }: RobustnessTask): ChunkResult {
  const perturbation: ScenarioPatch[] = job.path ? [{ path: job.path, op: "multiply", value: job.factor }] : [];
  const baseline = perturbation.length ? applyPatches(model, perturbation).model : model;
  const withScenario = applyPatches(model, [...perturbation, ...scenario]).model;
  return { baseline: runSide(baseline, job), scenario: runSide(withScenario, job) };
}

// ---------------------------------------------------------------------------
// Which parameters are estimated
// ---------------------------------------------------------------------------

export type ProvenanceSource = "estimated" | "entered" | "measured";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The provenance source of one field of a row, from the row's `provenance`
 * jsonb. Two shapes are read:
 *
 * - per column, `{ work_hours: { source: "measured", ... }, ... }` (the demand
 *   tables' shape): the field's own entry decides, and a field with no entry
 *   is estimated;
 * - per row, `{ source: "entered", ... }` (docs/PRD.md §5): it covers every
 *   field of the row that has no entry of its own.
 *
 * Anything else (no provenance, `{}`, an unknown source) is `estimated`: a
 * number counts as known only when someone said it was entered or measured.
 */
export function provenanceSource(provenance: unknown, field: string): ProvenanceSource {
  if (!isObject(provenance)) return "estimated";
  const own = provenance[field];
  const source = isObject(own) ? own.source : provenance.source;
  return source === "entered" || source === "measured" ? source : "estimated";
}

/**
 * The conflicting values recorded for one field (per-column provenance only),
 * or null. A conflict someone settled (`conflict.resolved`) no longer counts.
 */
function conflictValues(provenance: unknown, field: string): number[] | null {
  if (!isObject(provenance)) return null;
  const own = provenance[field];
  if (!isObject(own) || !isObject(own.conflict) || !Array.isArray(own.conflict.values)) return null;
  if (own.conflict.resolved) return null;
  const values = own.conflict.values
    .map((v: unknown) => (isObject(v) ? Number(v.value) : Number(v)))
    .filter((v: number) => Number.isFinite(v) && v >= 0);
  return values.length >= 2 ? values : null;
}

/**
 * The provenance jsonb of the row a patch target lives on (a step row for
 * `steps.<id>.*`, the demand row for `demand.*`, ...), or undefined when the
 * caller has none. Fields are looked up inside it by `provenanceSource`.
 */
export type ProvenanceLookup = (target: PatchTarget) => unknown;

/** The rows whose `provenance` jsonb decides what is estimated (see `provenanceFromRows`). */
export interface ProvenanceRows {
  /** Step rows (every simulated process's), per-column or per-row provenance. */
  steps?: readonly { id: string; provenance?: unknown }[];
  /** Service rows, per-column provenance (`churn_health_sensitivity`, `price`, ...). */
  services?: readonly { id: string; provenance?: unknown }[];
  /** The workspace row's `provenance`: settings keyed `settings.<key>` (`settings.health_recover`, ...). */
  workspace?: unknown;
  /**
   * Lead source rows, per-column provenance (`volume_week`, `conversion_to_qualified`). Qualified leads a week
   * (`demand.leads_per_week`) are known only when every source's are (see `leadsProvenance`).
   */
  leadSources?: readonly { provenance?: unknown }[];
}

/**
 * Where qualified leads a week come from, given the lead sources. Calibration measures the qualified leads themselves
 * and stores the leads a week that give them (issue #41), so a source whose `volume_week` is measured has measured
 * qualified leads. Only then are they left out of the robustness check: the total is measured when every source's
 * leads a week are, and an estimate otherwise (entered volumes stay varied, as before calibration). With no sources it
 * is the workspace's interim figure, an estimate.
 */
export function leadsProvenance(sources: readonly { provenance?: unknown }[]): ProvenanceSource {
  return sources.length > 0 && sources.every((s) => provenanceSource(s.provenance, "volume_week") === "measured") ? "measured" : "estimated";
}

/**
 * A `ProvenanceLookup` over the stored rows: a step's or a service's own row,
 * and for a health rule (`health.<field>`) the workspace's
 * `settings.health_<field>` entry, handed over in the per-column shape;
 * for qualified leads a week, the lead sources' (`leadsProvenance`).
 * Targets with no row here (other demand, roles, people) are estimated.
 */
export function provenanceFromRows({ steps = [], services = [], workspace, leadSources }: ProvenanceRows): ProvenanceLookup {
  const byStep = new Map(steps.map((s) => [s.id, s.provenance]));
  const byService = new Map(services.map((s) => [s.id, s.provenance]));
  const leads = leadSources ? leadsProvenance(leadSources) : "estimated";
  return (t) => {
    if (t.kind === "steps") return byStep.get(t.id);
    if (t.kind === "demand" && t.field === "leads_per_week") return { leads_per_week: { source: leads } };
    if (t.kind === "services") return byService.get(t.id);
    if (t.kind === "health" && isObject(workspace)) return { [t.field]: workspace[`settings.health_${t.field}`] };
    return undefined;
  };
}

/**
 * Every parameter the check can perturb, as patch paths, with the ones whose
 * provenance says entered or measured left out.
 *
 * Perturbed: leads per week, active clients, monthly churn, each role's
 * client hours per client, each service's mix share (when there are several),
 * and each step's hands-on time, wait and rework rate. Values of 0 are left
 * out (±25% of nothing is nothing). Money inputs (the retainer, service
 * prices) are included only when the metric is new MRR, and cost rates never:
 * they cannot move wins or the bottleneck. Head-counts and FTEs are facts
 * about the team, not estimates, and are not perturbed. With a client roster,
 * the health rules and each service's churn sensitivity are perturbed too
 * (docs/PRD.md §6.5 "including health/churn defaults"): a rule the workspace
 * hasn't set is the estimated default, so it is perturbed whatever the
 * provenance says; the on-time, late and missed rules only when some service
 * has a servicing process (their tasks are what move health).
 *
 * A conflicted field (per-column provenance with unresolved `conflict.values`)
 * uses the range of the conflicting values instead of ±perturbation, and is
 * perturbed even when its value was entered or measured: sources disagreeing
 * with it is the uncertainty the check is for (docs/PRD.md §6.5, D17).
 */
export function estimatedParameters(
  model: EngineModel,
  { provenance, perturbation = 0.25, metric = "won" }: { provenance?: ProvenanceLookup; perturbation?: number; metric?: RobustnessMetric } = {},
): RobustnessParameter[] {
  const out: RobustnessParameter[] = [];
  /** `unset`: the value is a default the engine fills in, so an estimate whatever the provenance says. */
  const add = (path: string, current: number, unset = false) => {
    if (!(current > 0)) return;
    const target = parsePatchPath(path);
    if (!target) return;
    const prov = provenance?.(target);
    const conflict = conflictValues(prov, target.field);
    if (!conflict && !unset && provenanceSource(prov, target.field) !== "estimated") return;
    if (conflict) {
      const low = Math.min(...conflict) / current;
      const high = Math.max(...conflict) / current;
      if (high > low) {
        out.push({ path, low: Math.min(low, 1), high: Math.max(high, 1), conflict: true });
        return;
      }
    }
    out.push({ path, low: 1 - perturbation, high: 1 + perturbation });
  };
  const money = metric === "mrrAdded";
  add("demand.leads_per_week", model.leadsPerWeek);
  add("demand.active_clients", model.activeClients);
  add("demand.churn_monthly", model.churnMonthly);
  const services = Object.entries(model.services ?? {});
  if (money && !services.length) add("finances.retainer", model.retainer);
  for (const [id, s] of services) {
    if (services.length > 1) add(`services.${id}.mix_share`, s.mixShare);
    if (money) add(`services.${id}.price`, s.price);
  }
  for (const [id, r] of Object.entries(model.roles)) add(`roles.${id}.ongoing_hours`, r.ongoing);
  for (const s of model.steps) {
    add(`steps.${s.id}.work_hours`, s.work);
    add(`steps.${s.id}.wait_hours`, s.wait);
    add(`steps.${s.id}.rework_rate`, s.rework);
  }
  // Client health and churn (docs/PRD.md §6.3.5, issue #79), which act only
  // with a client roster: the health rules (a rule the workspace hasn't set is
  // the PRD's estimated default) and each service's churn sensitivity. Tasks
  // done on time, late or missed come only from servicing processes.
  if (withClientGroups(model).clients !== undefined) {
    const rules = healthRules(model);
    const servicing = services.some(([, s]) => hasServicing(model, s));
    for (const field of PATCH_FIELDS.health) {
      if (field !== "initial" && !servicing) continue;
      const key = HEALTH_RULE_KEYS[field];
      add(`health.${field}`, rules[key], model.health?.[key] === undefined);
    }
    for (const [id, s] of services) if (s.churnMonthly > 0) add(`services.${id}.churn_health_sensitivity`, s.churnSensitivity ?? 0);
  }
  return out;
}

const FIELD_LABELS: Record<string, string> = {
  leads_per_week: "Leads per week",
  active_clients: "Active clients",
  churn_monthly: "Monthly churn",
  retainer: "Monthly retainer",
  price: "price",
  mix_share: "share of new business",
  ongoing_hours: "client hours per client",
  cost_rate: "cost rate",
  headcount: "head-count",
  fte: "FTE",
  work_hours: "hands-on time",
  wait_hours: "wait",
  rework_rate: "rework rate",
  churn_health_sensitivity: "churn sensitivity to health",
  initial: "Starting client health",
  recover: "Health gained per task on time",
  late_penalty: "Health lost per late task",
  missed_penalty: "Health lost per missed task",
};

/** A parameter in words: "Audit & proposal: hands-on time", "Leads per week". */
export function parameterLabel(model: EngineModel, path: string): string {
  const t = parsePatchPath(path);
  if (!t) return path;
  const field = FIELD_LABELS[t.field] ?? t.field;
  if (t.kind === "demand" || t.kind === "finances" || t.kind === "health") return field;
  const name =
    t.kind === "steps"
      ? model.steps.find((s) => s.id === t.id)?.name
      : t.kind === "roles"
        ? model.roles[t.id]?.name
        : t.kind === "people"
          ? model.people?.[t.id]?.name
          : model.services?.[t.id]?.name;
  return `${name ?? t.id}: ${field}`;
}

// ---------------------------------------------------------------------------
// Hashing and caching
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so equal values give equal strings whatever their key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 53-bit string hash (cyrb53) as 14 hex digits. Not cryptographic; for cache keys. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Where job results are kept between checks. Any Map-like store works. */
export interface RobustnessCache {
  get(key: string): ChunkResult | undefined;
  set(key: string, value: ChunkResult): void;
}

/** An in-memory cache with a size cap (oldest entries go first). */
export class MemoryRobustnessCache implements RobustnessCache {
  private readonly map = new Map<string, ChunkResult>();

  constructor(private readonly maxEntries = 5000) {}

  get(key: string) {
    return this.map.get(key);
  }

  set(key: string, value: ChunkResult) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  get size() {
    return this.map.size;
  }
}

/**
 * The cache key of a job: the model's and the scenario's hashes, the
 * parameter and its perturbation, and the replications it covers.
 */
export function robustnessJobKey(hashes: { model: string; scenario: string }, job: RobustnessJob): string {
  return [`v${ROBUSTNESS_VERSION}`, hashes.model, hashes.scenario, job.path ?? "-", job.factor, job.seed, `${job.repStart}+${job.reps}`].join("|");
}

// ---------------------------------------------------------------------------
// The two-stage plan
// ---------------------------------------------------------------------------

/** How one parameter moves the conclusion. */
export interface Sensitivity {
  path: string;
  label: string;
  /** Multipliers of the low and high runs. */
  low: number;
  high: number;
  conflict: boolean;
  /**
   * Change in the headline delta (scenario − baseline, in the metric's units
   * over the whole horizon) at the low and high values, relative to the
   * unperturbed delta at the same replications. Null for a direction that
   * didn't run (time cap).
   */
  effect: { low: number | null; high: number | null };
  /** The larger of the two effects' sizes. */
  influence: number;
  /** Whether either direction flips the delta's sign. */
  flipsSign: boolean;
  /** Whether either direction changes the bottleneck on either side. */
  flipsBottleneck: boolean;
  /** Replications behind the numbers: `screenReps`, or `refineReps` once refined. */
  reps: number;
  refined: boolean;
}

export interface RobustnessResult {
  metric: RobustnessMetric;
  seed: number;
  /** The default relative perturbation (conflicted parameters use their own range). */
  perturbation: number;
  screenReps: number;
  refineReps: number;
  /** The unperturbed comparison, at `refineReps` replications. */
  nominal: {
    /** Mean paired delta of the metric over the horizon. */
    delta: number;
    /** Its sign; 0 when it is within noise (no difference). */
    sign: -1 | 0 | 1;
    bottleneck: { baseline: string | null; scenario: string | null };
  };
  /** Perturbed runs counted in the shares (two per parameter, each at its most refined). */
  runs: number;
  /** Share of runs where each side's nominal bottleneck is still the bottleneck, and where both are. */
  bottleneckHolds: { baseline: number; scenario: number; both: number };
  /** Share of runs where the delta keeps the nominal sign. */
  signHolds: number;
  /** Every screened parameter, most sensitive first: those that flip the delta's sign, then by influence. */
  sensitivities: Sensitivity[];
  /**
   * Conflicted parameters (sources disagree) whose range flips the conclusion:
   * the delta's sign or the bottleneck. The answer depends on whose estimate
   * is right, so it should be measured (docs/PRD.md §6.5).
   */
  conflictFlips: { path: string; label: string }[];
  /** Parameters planned, screened (both directions) and refined. */
  parameters: number;
  screened: number;
  refined: number;
  /** False when a time cap stopped the check early; the shares cover what ran. */
  complete: boolean;
  /** Jobs the check needed and how many came from the cache. */
  stats: { jobs: number; cached: number; replications: number };
}

interface Ctx {
  model: EngineModel;
  scenario: ScenarioPatch[];
  seed: number;
  metric: RobustnessMetric;
  perturbation: number;
  screenReps: number;
  refineReps: number;
  refineTop: number;
  parameters: RobustnessParameter[];
  hashes: { model: string; scenario: string };
}

function context(model: EngineModel, scenario: ScenarioPatch[], opts: RobustnessOptions): Ctx {
  const metric = opts.metric ?? "won";
  const perturbation = opts.perturbation ?? 0.25;
  const screenReps = Math.max(1, Math.floor(opts.screenReps ?? 10));
  const refineReps = Math.max(screenReps, Math.floor(opts.refineReps ?? 30));
  return {
    model,
    scenario,
    seed: opts.seed ?? 1,
    metric,
    perturbation,
    screenReps,
    refineReps,
    refineTop: Math.max(0, Math.floor(opts.refineTop ?? 5)),
    parameters: opts.parameters ?? estimatedParameters(model, { perturbation, metric }),
    hashes: { model: hashString(stableStringify(model)), scenario: hashString(stableStringify(scenario)) },
  };
}

/** Replication ranges of `screenReps` each, covering [0, refineReps). */
function chunks(ctx: Ctx): { repStart: number; reps: number }[] {
  const out: { repStart: number; reps: number }[] = [];
  for (let s = 0; s < ctx.refineReps; s += ctx.screenReps) out.push({ repStart: s, reps: Math.min(ctx.screenReps, ctx.refineReps - s) });
  return out;
}

const WEEKS_PER_QUARTER = 13;
/** Deltas smaller than this per quarter count as no change (as in the compare headline). */
const NOISE: Record<RobustnessMetric, number> = { won: 0.05, mrrAdded: 0.5 };

/** Per-side outcome of one merged run. */
interface Outcome {
  delta: number;
  sign: -1 | 0 | 1;
  bottleneck: { baseline: string | null; scenario: string | null };
}

function merge(parts: ChunkResult[]): ChunkResult {
  const side = (k: "baseline" | "scenario"): SideSamples => {
    const util: Record<string, number[]> = {};
    for (const rid of Object.keys(parts[0]![k].util)) util[rid] = parts.flatMap((p) => p[k].util[rid] ?? []);
    return { won: parts.flatMap((p) => p[k].won), mrrAdded: parts.flatMap((p) => p[k].mrrAdded), util };
  };
  return { baseline: side("baseline"), scenario: side("scenario") };
}

/** The role with the highest mean utilisation, first in role order on a tie (as `simulate` picks it). */
function bottleneckOf(util: Record<string, number[]>): string | null {
  let best: string | null = null;
  let bestMean = -Infinity;
  for (const rid in util) {
    const v = util[rid]!;
    const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    if (best === null || mean > bestMean) {
      best = rid;
      bestMean = mean;
    }
  }
  return best;
}

function outcome(ctx: Ctx, r: ChunkResult): Outcome {
  const a = r.baseline[ctx.metric];
  const b = r.scenario[ctx.metric];
  const delta = b.reduce((acc, v, i) => acc + (v - a[i]!), 0) / (b.length || 1);
  const noise = (NOISE[ctx.metric] * ctx.model.horizonWeeks) / WEEKS_PER_QUARTER;
  const sign = Math.abs(delta) < noise ? 0 : delta > 0 ? 1 : -1;
  return { delta, sign, bottleneck: { baseline: bottleneckOf(r.baseline.util), scenario: bottleneckOf(r.scenario.util) } };
}

const job = (ctx: Ctx, path: string | null, factor: number, c: { repStart: number; reps: number }): RobustnessJob => ({
  path,
  factor,
  seed: ctx.seed,
  ...c,
});

/**
 * The check as a sequence of job batches. It yields stage one's jobs (the
 * nominal runs first), then stage two's; the driver sends back each batch's
 * results in the same order, with null for a job it skipped (time cap). The
 * nominal jobs must not be skipped.
 */
function* plan(ctx: Ctx): Generator<RobustnessJob[], Omit<RobustnessResult, "stats">, (ChunkResult | null)[]> {
  const cs = chunks(ctx);
  const first = cs[0]!;
  const nominalJobs = cs.map((c) => job(ctx, null, 1, c));
  const screenJobs = ctx.parameters.flatMap((p) => [job(ctx, p.path, p.low, first), job(ctx, p.path, p.high, first)]);
  const r1 = yield [...nominalJobs, ...screenJobs];

  const nominalParts = r1.slice(0, nominalJobs.length);
  if (nominalParts.some((r) => !r)) throw new Error("The robustness check needs the unperturbed runs.");
  const nominalFull = outcome(ctx, merge(nominalParts as ChunkResult[]));
  const nominalAt = new Map<number, Outcome>([[first.reps, outcome(ctx, nominalParts[0]!)], [ctx.refineReps, nominalFull]]);

  interface Entry {
    p: RobustnessParameter;
    index: number;
    /** Screen results, low then high. */
    screen: [ChunkResult | null, ChunkResult | null];
    runs: [Outcome | null, Outcome | null];
    reps: number;
    refined: boolean;
  }
  const entries: Entry[] = ctx.parameters.map((p, index) => {
    const screen: [ChunkResult | null, ChunkResult | null] = [r1[nominalJobs.length + 2 * index] ?? null, r1[nominalJobs.length + 2 * index + 1] ?? null];
    return { p, index, screen, runs: [screen[0] && outcome(ctx, screen[0]), screen[1] && outcome(ctx, screen[1])], reps: first.reps, refined: false };
  });

  const sensitivity = (e: Entry) => {
    const ref = nominalAt.get(e.reps)!;
    const eff = e.runs.map((o) => (o ? o.delta - ref.delta : null)) as [number | null, number | null];
    const flipsSign = e.runs.some((o) => o && o.sign !== nominalFull.sign);
    const flipsBottleneck = e.runs.some(
      (o) => o && (o.bottleneck.baseline !== nominalFull.bottleneck.baseline || o.bottleneck.scenario !== nominalFull.bottleneck.scenario),
    );
    return { eff, flipsSign, flipsBottleneck, influence: Math.max(Math.abs(eff[0] ?? 0), Math.abs(eff[1] ?? 0)) };
  };
  const rank = (list: Entry[]) =>
    list
      .map((e) => ({ e, s: sensitivity(e) }))
      .sort(
        (x, y) =>
          Number(y.s.flipsSign) - Number(x.s.flipsSign) ||
          y.s.influence - x.s.influence ||
          x.e.index - y.e.index,
      );

  // Stage two: the most influential fully screened parameters, topped up to refineReps.
  const screened = entries.filter((e) => e.runs[0] && e.runs[1]);
  const top = cs.length > 1 ? rank(screened).slice(0, ctx.refineTop).map((x) => x.e) : [];
  const rest = cs.slice(1);
  const refineJobs = top.flatMap((e) => [e.p.low, e.p.high].flatMap((f) => rest.map((c) => job(ctx, e.p.path, f, c))));
  const r2 = yield refineJobs;
  top.forEach((e, t) => {
    const per = rest.length;
    const lowParts = r2.slice(2 * t * per, 2 * t * per + per);
    const highParts = r2.slice(2 * t * per + per, 2 * t * per + 2 * per);
    if (lowParts.some((r) => !r) || highParts.some((r) => !r)) return;
    e.runs = [outcome(ctx, merge([e.screen[0]!, ...(lowParts as ChunkResult[])])), outcome(ctx, merge([e.screen[1]!, ...(highParts as ChunkResult[])]))];
    e.reps = ctx.refineReps;
    e.refined = true;
  });

  // Verdict shares over every perturbed run, each at its most refined.
  const runs = entries.flatMap((e) => e.runs.filter((o): o is Outcome => o !== null));
  const share = (f: (o: Outcome) => boolean) => (runs.length ? runs.filter(f).length / runs.length : 1);
  const sensitivities: Sensitivity[] = rank(entries.filter((e) => e.runs[0] || e.runs[1])).map(({ e, s }) => ({
    path: e.p.path,
    label: parameterLabel(ctx.model, e.p.path),
    low: e.p.low,
    high: e.p.high,
    conflict: Boolean(e.p.conflict),
    effect: { low: s.eff[0], high: s.eff[1] },
    influence: s.influence,
    flipsSign: s.flipsSign,
    flipsBottleneck: s.flipsBottleneck,
    reps: e.reps,
    refined: e.refined,
  }));
  const complete = screened.length === entries.length && r2.every((r) => r !== null);
  return {
    metric: ctx.metric,
    seed: ctx.seed,
    perturbation: ctx.perturbation,
    screenReps: ctx.screenReps,
    refineReps: ctx.refineReps,
    nominal: nominalFull,
    runs: runs.length,
    bottleneckHolds: {
      baseline: share((o) => o.bottleneck.baseline === nominalFull.bottleneck.baseline),
      scenario: share((o) => o.bottleneck.scenario === nominalFull.bottleneck.scenario),
      both: share(
        (o) => o.bottleneck.baseline === nominalFull.bottleneck.baseline && o.bottleneck.scenario === nominalFull.bottleneck.scenario,
      ),
    },
    signHolds: share((o) => o.sign === nominalFull.sign),
    sensitivities,
    conflictFlips: sensitivities.filter((s) => s.conflict && (s.flipsSign || s.flipsBottleneck)).map((s) => ({ path: s.path, label: s.label })),
    parameters: entries.length,
    screened: screened.length,
    refined: top.filter((e) => e.refined).length,
    complete,
  };
}

/** Replications a check simulates when nothing is cached (both sides), for progress bars. */
export function plannedReplications(ctx: Pick<Ctx, "parameters" | "screenReps" | "refineReps" | "refineTop">): number {
  const n = ctx.parameters.length;
  return 2 * (ctx.refineReps + 2 * n * ctx.screenReps + 2 * Math.min(ctx.refineTop, n) * (ctx.refineReps - ctx.screenReps));
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export class RobustnessCancelled extends Error {
  constructor() {
    super("Robustness check cancelled");
    this.name = "RobustnessCancelled";
  }
}

export interface RobustnessProgress {
  /** Replications done (cached ones count as done), both sides. */
  done: number;
  /** Replications planned so far; stage two's are included from the start. */
  total: number;
  stage: 1 | 2;
}

/**
 * Runs a batch of tasks and resolves with their results in order, calling
 * `onResult` as each finishes. The browser's worker pool implements this;
 * `localExecutor` runs them on this thread.
 */
export type RobustnessExecutor = (
  tasks: RobustnessTask[],
  hooks: { onResult: (index: number, result: ChunkResult) => void; signal?: AbortSignal },
) => Promise<ChunkResult[]>;

/** Runs tasks one after another on this thread, yielding to the event loop between them. */
export const localExecutor: RobustnessExecutor = async (tasks, { onResult, signal }) => {
  const out: ChunkResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) throw new RobustnessCancelled();
    out.push(runRobustnessTask(tasks[i]!));
    onResult(i, out[i]!);
    await Promise.resolve();
  }
  return out;
};

export interface CheckRobustnessOptions extends RobustnessOptions {
  execute?: RobustnessExecutor;
  cache?: RobustnessCache;
  onProgress?: (progress: RobustnessProgress) => void;
  signal?: AbortSignal;
}

/**
 * The robustness check, asynchronously: jobs not in the cache go to
 * `execute` (a worker pool in the browser), stage by stage. Rejects with
 * `RobustnessCancelled` when `signal` aborts.
 */
export async function checkRobustness(
  model: EngineModel,
  scenario: ScenarioPatch[],
  { execute = localExecutor, cache, onProgress, signal, ...opts }: CheckRobustnessOptions = {},
): Promise<RobustnessResult> {
  const ctx = context(model, scenario, opts);
  const total = plannedReplications(ctx);
  const stats = { jobs: 0, cached: 0, replications: 0 };
  let done = 0;
  const gen = plan(ctx);
  let step = gen.next();
  let stage: 1 | 2 = 1;
  while (!step.done) {
    if (signal?.aborted) throw new RobustnessCancelled();
    const jobs = step.value;
    const results: (ChunkResult | null)[] = new Array(jobs.length).fill(null);
    const missing: number[] = [];
    jobs.forEach((j, i) => {
      stats.jobs++;
      stats.replications += 2 * j.reps;
      const hit = cache?.get(robustnessJobKey(ctx.hashes, j));
      if (hit) {
        results[i] = hit;
        stats.cached++;
        done += 2 * j.reps;
      } else missing.push(i);
    });
    onProgress?.({ done, total, stage });
    if (missing.length) {
      const tasks = missing.map((i) => ({ model, scenario, job: jobs[i]! }));
      const out = await execute(tasks, {
        signal,
        onResult: (k, result) => {
          // Cached as each job finishes, so a cancelled check resumes where it stopped.
          cache?.set(robustnessJobKey(ctx.hashes, tasks[k]!.job), result);
          done += 2 * tasks[k]!.job.reps;
          onProgress?.({ done, total, stage });
        },
      });
      if (signal?.aborted) throw new RobustnessCancelled();
      missing.forEach((i, k) => {
        results[i] = out[k]!;
      });
    }
    step = gen.next(results);
    stage = 2;
  }
  onProgress?.({ done: total, total, stage: 2 });
  return { ...step.value, stats };
}

export interface RobustnessNodeOptions extends RobustnessOptions {
  /**
   * Stop starting new jobs after this many milliseconds. The unperturbed runs
   * always complete; a check stopped early reports `complete: false` and its
   * shares cover the perturbations that ran. Omit for no cap.
   */
  timeBudgetMs?: number;
  cache?: RobustnessCache;
  /** Use only cached results: return null if any job would have to run. */
  cacheOnly?: boolean;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * The robustness check on this thread, synchronously, for the server (MCP,
 * PDF) or for reading a cached result. With `timeBudgetMs` it stops starting
 * jobs once the budget is spent.
 *
 * Benchmark (40 steps, 25 people, 72 estimated parameters, 3,340
 * replications over both sides; test/robustness-browser.test.ts with
 * ROBUSTNESS_BENCH=1): 62 s on one core of the 4-core CI container, so a
 * server caller should cap it (the result then says `complete: false`). The
 * browser pool took 23 s there with 3 workers, so ~10 s with the 7 workers
 * of an 8-core laptop.
 */
export function robustness(model: EngineModel, scenario: ScenarioPatch[], opts?: RobustnessNodeOptions & { cacheOnly?: false }): RobustnessResult;
export function robustness(model: EngineModel, scenario: ScenarioPatch[], opts: RobustnessNodeOptions & { cacheOnly: true }): RobustnessResult | null;
export function robustness(
  model: EngineModel,
  scenario: ScenarioPatch[],
  { timeBudgetMs, cache, cacheOnly = false, now = () => performance.now(), ...opts }: RobustnessNodeOptions = {},
): RobustnessResult | null {
  const ctx = context(model, scenario, opts);
  const deadline = timeBudgetMs === undefined ? Infinity : now() + timeBudgetMs;
  const stats = { jobs: 0, cached: 0, replications: 0 };
  const gen = plan(ctx);
  let step = gen.next();
  while (!step.done) {
    const results: (ChunkResult | null)[] = [];
    for (const j of step.value) {
      stats.jobs++;
      const key = robustnessJobKey(ctx.hashes, j);
      const hit = cache?.get(key);
      if (hit) {
        stats.cached++;
        stats.replications += 2 * j.reps;
        results.push(hit);
        continue;
      }
      if (cacheOnly) return null;
      if (j.path !== null && now() >= deadline) {
        results.push(null);
        continue;
      }
      const r = runRobustnessTask({ model, scenario, job: j });
      cache?.set(key, r);
      stats.replications += 2 * j.reps;
      results.push(r);
    }
    step = gen.next(results);
  }
  return { ...step.value, stats };
}

// ---------------------------------------------------------------------------
// Templated verdict
// ---------------------------------------------------------------------------

export interface VerdictInput {
  result: RobustnessResult;
  /** What changed, as in the compare headline: `“Hire a strategist”`, `These lever changes`. */
  subject: string;
  plural?: boolean;
  roleNames: Record<string, string>;
  horizonWeeks: number;
  /** ISO 4217 code, for the MRR metric. */
  currency?: string;
}

export interface Verdict {
  /** "Strategist is the bottleneck in 100% of cases; “Hire” adds wins in 94% of cases." */
  verdict: string;
  /** What was perturbed and how many runs, and a warning when the check stopped early. */
  details: string[];
  /** The top sensitive inputs, one line each, most sensitive first. */
  sensitive: { label: string; effect: string; flips: boolean }[];
  /** One line per conflicted input whose range flips the conclusion: "the answer depends on whose estimate … is right; measure this". */
  conflicts: string[];
}

const LOCALE = "en-GB";
const MINUS = "−";
/** A share as a whole percentage that never rounds to 100% or 0% unless it is exactly that. */
function pctText(share: number): string {
  if (share >= 1) return "100%";
  if (share <= 0) return "0%";
  return `${Math.min(99, Math.max(1, Math.round(share * 100)))}%`;
}

function signed(v: number, fmt: (x: number) => string): string {
  const s = fmt(Math.abs(v));
  if (s === fmt(0)) return fmt(0);
  return v > 0 ? `+${s}` : `${MINUS}${s}`;
}

/** The verdict and the sensitive inputs in words, from fixed templates only. */
export function robustnessVerdict({ result: r, subject, plural = false, roleNames, horizonWeeks, currency }: VerdictInput, top = 5): Verdict {
  const verb = (one: string, many: string) => (plural ? many : one);
  const name = (id: string | null) => (id ? (roleNames[id] ?? "a role") : "no role");
  const { baseline: bA, scenario: bB } = r.nominal.bottleneck;
  const parts: string[] = [];
  if (bA === bB) {
    const share = r.bottleneckHolds.both;
    parts.push(`${name(bA)} is the bottleneck in ${pctText(share)} of cases`);
  } else {
    parts.push(`${name(bA)} is the bottleneck today in ${pctText(r.bottleneckHolds.baseline)} of cases, and ${name(bB)} after the change in ${pctText(r.bottleneckHolds.scenario)}`);
  }
  const what = r.metric === "won" ? "wins" : "new MRR";
  const holds = pctText(r.signHolds);
  if (r.nominal.sign > 0) parts.push(`${subject} ${verb("adds", "add")} ${what} in ${holds} of cases`);
  else if (r.nominal.sign < 0) parts.push(`${subject} ${verb("costs", "cost")} ${what} in ${holds} of cases`);
  else parts.push(`${subject} ${verb("makes", "make")} no difference to ${what} in ${holds} of cases`);
  const verdict = `${parts.join("; ")}.`;

  const perQuarter = WEEKS_PER_QUARTER / horizonWeeks;
  const fmt = (v: number) =>
    r.metric === "won"
      ? `${Math.abs(v).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} wins/quarter`
      : `${Math.abs(v).toLocaleString(LOCALE, currency ? { style: "currency", currency, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 })}/quarter`;
  const conflicted = r.sensitivities.some((s) => s.conflict);
  const details = [
    `Each estimated input was moved ${Math.round(r.perturbation * 100)}% down and up${conflicted ? " (conflicting estimates across their range)" : ""}, one at a time: ${r.runs} runs of ${r.screenReps} replications${r.refined ? `, with the ${r.refined} most sensitive inputs re-run at ${r.refineReps}` : ""}.`,
  ];
  if (!r.complete) details.push(`Stopped early: ${r.screened} of ${r.parameters} inputs checked.`);
  const sensitive = r.sensitivities.slice(0, top).map((s) => {
    const range = (m: number) => `${m < 1 ? MINUS : "+"}${Math.round(Math.abs(m - 1) * 100)}%`;
    const low = s.effect.low === null ? "not run" : signed(s.effect.low * perQuarter, fmt);
    const high = s.effect.high === null ? "not run" : signed(s.effect.high * perQuarter, fmt);
    const effect = `${range(s.low)}: ${low}; ${range(s.high)}: ${high}${s.flipsSign ? " (flips the answer)" : s.flipsBottleneck ? " (moves the bottleneck)" : ""}`;
    return { label: s.label, effect, flips: s.flipsSign || s.flipsBottleneck };
  });
  const conflicts = (r.conflictFlips ?? []).map(
    (c) => `The conclusion flips within the conflict range: the answer depends on whose estimate of ${lowerFirst(c.label)} is right; measure this.`,
  );
  return { verdict, details, sensitive, conflicts };
}

/** "Audit & proposal: hands-on time" stays as is; "Leads per week" becomes "leads per week". */
const lowerFirst = (s: string) => (s.includes(":") ? s : s.charAt(0).toLowerCase() + s.slice(1));
