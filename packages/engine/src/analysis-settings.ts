// A workspace's analysis rules as they are stored (docs/analysis-rules.md, "Editing the rules"; issue #109).
//
// The stored document is sparse: it holds only what differs from the agreed
// defaults, so a default that changes later reaches every workspace that never
// edited it. Every rule of the spec is in here, including rules whose engine
// detector isn't on the rating model yet (`engine` is unset): their settings
// are kept so nothing is lost when that detector lands. `toRatingConfig`
// turns the document into the `RatingConfig` that `detectIssues` reads, so a
// stored run is re-rated by calling `detectIssues` again with it, with no new
// simulation. Pure: no I/O.

import {
  OVERRIDE_KINDS,
  RATING_RULE_IDS,
  defaultRatingConfig,
  type Cutoffs,
  type OverrideKind,
  type RatingConfig,
  type RatingOverride,
  type RatingRuleId,
} from "./ratings";

/** Every rule in docs/analysis-rules.md, in its order. */
export const ANALYSIS_RULE_IDS = [
  "busy",
  "spare",
  "overtime",
  "queue",
  "wait",
  "rework",
  "sla",
  "spof",
  "health",
  "driver",
  "success",
  "dropoff",
  "cycle",
  "sources",
  "broken",
] as const;
export type AnalysisRuleId = (typeof ANALYSIS_RULE_IDS)[number];

/** A chain of inputs that must be in order, e.g. the three busy cut-offs must not fall. */
interface Chain {
  indices: readonly number[];
  dir: "asc" | "desc";
}

export interface AnalysisRuleSpec {
  /** The rule's number in docs/analysis-rules.md. */
  number: number;
  /** The default value of each input (the numbers a person edits), in storage units (a share is 0.7, not 70). */
  defaults: readonly number[];
  /** Inputs that must be in order. */
  chains: readonly Chain[];
  /** Largest value an input may take. */
  max: number;
  /** Whether overrides make sense for this rule. */
  overridable: boolean;
  /** The id on the rating model, when the engine rates this rule from these settings. */
  engine: RatingRuleId | null;
}

const asc = (...indices: number[]): Chain => ({ indices, dir: "asc" });
const desc = (...indices: number[]): Chain => ({ indices, dir: "desc" });

export const ANALYSIS_RULE_SPECS: Record<AnalysisRuleId, AnalysisRuleSpec> = {
  busy: { number: 1, defaults: [0.7, 0.85, 0.95], chains: [asc(0, 1, 2)], max: 5, overridable: true, engine: "busy" },
  spare: { number: 2, defaults: [0.4], chains: [], max: 1, overridable: true, engine: "spare" },
  // Share of the overtime cap used: any regular overtime is Bad, the cap used up is Operational risk.
  overtime: { number: 3, defaults: [0.01, 0.95], chains: [asc(0, 1)], max: 1, overridable: true, engine: "overtime" },
  // Items a week the queue grows by; at or over this is Operational risk.
  queue: { number: 4, defaults: [0.5], chains: [], max: 1000, overridable: true, engine: "queue" },
  wait: { number: 5, defaults: [1, 1.5, 3], chains: [asc(0, 1, 2)], max: 100, overridable: true, engine: "wait" },
  rework: { number: 6, defaults: [0.05, 0.1, 0.2], chains: [asc(0, 1, 2)], max: 1, overridable: true, engine: "rework" },
  sla: { number: 7, defaults: [0.05, 0.1, 0.25], chains: [asc(0, 1, 2)], max: 1, overridable: true, engine: "sla" },
  // Work lost: Great under, Operational risk over; weeks to recover: Great within, Operational risk beyond.
  spof: { number: 8, defaults: [0.05, 0.2, 1, 4], chains: [asc(0, 1), asc(2, 3)], max: 100, overridable: true, engine: "spof" },
  health: { number: 9, defaults: [75, 65, 50], chains: [desc(0, 1, 2)], max: 100, overridable: true, engine: null },
  // A driver's share of churn for Bad, and the client group health below which it is Operational risk.
  driver: { number: 10, defaults: [0.3, 50], chains: [], max: 100, overridable: false, engine: "driver" },
  success: { number: 11, defaults: [0.8, 0.5, 0.2], chains: [desc(0, 1, 2)], max: 1, overridable: true, engine: "success" },
  dropoff: { number: 12, defaults: [1.25, 1.5], chains: [asc(0, 1)], max: 100, overridable: true, engine: "dropoff" },
  cycle: { number: 13, defaults: [1.25, 1.5], chains: [asc(0, 1)], max: 100, overridable: true, engine: "cycle" },
  sources: { number: 14, defaults: [2], chains: [], max: 1000, overridable: false, engine: null },
  broken: { number: 15, defaults: [], chains: [], max: 0, overridable: false, engine: null },
};

/** How a rule's inputs become the three cut-offs of the rating model. */
const TO_CUTOFFS: Record<RatingRuleId, (inputs: readonly number[]) => Cutoffs> = {
  busy: (i) => [i[0]!, i[1]!, i[2]!],
  overtime: (i) => [i[0]!, i[0]!, i[1]!],
  queue: (i) => [i[0]!, i[0]!, i[0]!],
  wait: (i) => [i[0]!, i[1]!, i[2]!],
  rework: (i) => [i[0]!, i[1]!, i[2]!],
  sla: (i) => [i[0]!, i[1]!, i[2]!],
  // Spare time: Good under the cut-off; there is no Bad or Operational risk band.
  spare: (i) => [i[0]!, 0, 0],
  // Only one person can do it: the first two inputs are work lost (no Good band). The last two, the weeks to recover, are
  // `config.absence.recoveryCutoffs` (see `toRatingConfig`); they are not per-subject, so an override's recovery weeks are ignored.
  spof: (i) => [i[0]!, i[0]!, i[1]!],
  success: (i) => [i[0]!, i[1]!, i[2]!],
  // Cause of clients leaving: the share for Bad, then the group health below which it is Operational risk (churn-issues.ts).
  driver: (i) => [i[0]!, i[0]!, i[1]!],
  // Work lost at a step and too slow overall: at or within the benchmark / target is Great, then Good up to the first input.
  dropoff: (i) => [1, i[0]!, i[1]!],
  cycle: (i) => [1, i[0]!, i[1]!],
};

/** The cut-offs of the rating model for a rule's inputs; null for a rule the engine doesn't rate from these settings. */
export function inputsToCutoffs(rule: AnalysisRuleId, inputs: readonly number[]): Cutoffs | null {
  const id = ANALYSIS_RULE_SPECS[rule].engine;
  return id ? TO_CUTOFFS[id](inputs) : null;
}

/** An override as stored: a different setting for one role, person, step, service or process. */
export interface AnalysisOverride {
  kind: OverrideKind;
  id: string;
  /** The name when it was added, for showing it if the subject is later gone. */
  label?: string;
  enabled?: boolean;
  inputs?: number[];
  /** Rule 5 only: the subject's expected wait, in hours. */
  expectedWaitHours?: number;
  /** Why, in the person's words. */
  why?: string;
}

export interface AnalysisRuleSettings {
  /** Omitted: on. */
  enabled?: boolean;
  /** Omitted: the defaults. */
  inputs?: number[];
  overrides?: AnalysisOverride[];
}

/** Money settings and defaults. Each is omitted until changed. Kept generic so tickets that add money settings (A43) extend it. */
export interface AnalysisMoney {
  /** A lost client or deal counts as at most this many months of fees. */
  capMonths?: number;
  /** The absence test: weeks someone is away, and how many times a year it happens. */
  absenceWeeks?: number;
  absencesPerYear?: number;
  /** Rule 5's normal wait for a person, in hours, for sales steps and for client work. */
  waitHours?: { pipeline?: number; servicing?: number };
  /** Money settings added by later tickets (e.g. the cost per month): kept as stored, never validated or dropped here. */
  [other: string]: unknown;
}

export interface AnalysisSettings {
  rules?: Partial<Record<AnalysisRuleId, AnalysisRuleSettings>>;
  escalators?: { badMonth?: boolean; bottleneck?: boolean };
  money?: AnalysisMoney;
}

export const DEFAULT_MONEY = { capMonths: 12, absenceWeeks: 2, absencesPerYear: 2 } as const;

/** Bounds of the money settings, for the form and for validation. */
export const MONEY_LIMITS = {
  capMonths: { min: 1, max: 60 },
  absenceWeeks: { min: 1, max: 26 },
  absencesPerYear: { min: 0, max: 52 },
  waitHours: { min: 0.25, max: 2000 },
} as const;

const MAX_OVERRIDES = 100;
const MAX_TEXT = 500;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Why a set of inputs isn't allowed for a rule, or null when it is. */
export function inputsProblem(rule: AnalysisRuleId, inputs: readonly number[]): string | null {
  const spec = ANALYSIS_RULE_SPECS[rule];
  if (inputs.length !== spec.defaults.length) return "Wrong number of cut-offs.";
  for (const v of inputs) if (!isNum(v) || v < 0 || v > spec.max) return `Cut-offs must be between 0 and ${spec.max}.`;
  for (const chain of spec.chains) {
    for (let k = 1; k < chain.indices.length; k++) {
      const a = inputs[chain.indices[k - 1]!]!;
      const b = inputs[chain.indices[k]!]!;
      if (chain.dir === "asc" ? b < a : b > a) return chain.dir === "asc" ? "Each cut-off must be at least the one before it." : "Each cut-off must be no more than the one before it.";
    }
  }
  return null;
}

export type AnalysisSettingsResult = { ok: true; value: AnalysisSettings } | { ok: false; errors: string[]; value: AnalysisSettings };

/**
 * Read a stored or submitted document. Anything not valid is dropped and
 * reported; `value` is always usable. The result holds only what differs from
 * the defaults, so saving an unchanged rule stores nothing for it.
 */
export function parseAnalysisSettings(input: unknown): AnalysisSettingsResult {
  const errors: string[] = [];
  const out: AnalysisSettings = {};
  if (input === null || input === undefined || (isObj(input) && !Object.keys(input).length)) return { ok: true, value: out };
  if (!isObj(input)) return { ok: false, errors: ["The rules must be an object."], value: out };

  if (isObj(input.rules)) {
    const rules: Partial<Record<AnalysisRuleId, AnalysisRuleSettings>> = {};
    for (const [id, raw] of Object.entries(input.rules)) {
      if (!(ANALYSIS_RULE_IDS as readonly string[]).includes(id)) {
        errors.push(`There is no rule called ${id}.`);
        continue;
      }
      const rule = id as AnalysisRuleId;
      const spec = ANALYSIS_RULE_SPECS[rule];
      if (!isObj(raw)) {
        errors.push(`${id}: not an object.`);
        continue;
      }
      const r: AnalysisRuleSettings = {};
      if (raw.enabled === false) r.enabled = false;
      else if (raw.enabled !== undefined && raw.enabled !== true) errors.push(`${id}: on/off must be true or false.`);
      if (raw.inputs !== undefined) {
        if (Array.isArray(raw.inputs) && raw.inputs.every(isNum)) {
          const inputs = raw.inputs.map(round);
          const problem = inputsProblem(rule, inputs);
          if (problem) errors.push(`${id}: ${problem}`);
          else if (inputs.some((v, k) => v !== spec.defaults[k])) r.inputs = inputs;
        } else errors.push(`${id}: cut-offs must be numbers.`);
      }
      if (raw.overrides !== undefined) {
        const overrides: AnalysisOverride[] = [];
        const seen = new Set<string>();
        if (!Array.isArray(raw.overrides)) errors.push(`${id}: overrides must be a list.`);
        else if (!spec.overridable && raw.overrides.length) errors.push(`${id}: this rule has no overrides.`);
        else if (raw.overrides.length > MAX_OVERRIDES) errors.push(`${id}: at most ${MAX_OVERRIDES} overrides.`);
        else
          for (const o of raw.overrides) {
            const parsed = parseOverride(rule, o, errors);
            if (!parsed) continue;
            const key = `${parsed.kind}:${parsed.id}`;
            if (seen.has(key)) {
              errors.push(`${id}: ${parsed.kind} ${parsed.label ?? parsed.id} has two overrides.`);
              continue;
            }
            seen.add(key);
            overrides.push(parsed);
          }
        if (overrides.length) r.overrides = overrides;
      }
      if (Object.keys(r).length) rules[rule] = r;
    }
    if (Object.keys(rules).length) out.rules = rules;
  } else if (input.rules !== undefined) errors.push("rules must be an object.");

  if (isObj(input.escalators)) {
    const e: NonNullable<AnalysisSettings["escalators"]> = {};
    for (const k of ["badMonth", "bottleneck"] as const) {
      if (input.escalators[k] === false) e[k] = false;
      else if (input.escalators[k] !== undefined && input.escalators[k] !== true) errors.push(`${k}: must be true or false.`);
    }
    if (Object.keys(e).length) out.escalators = e;
  } else if (input.escalators !== undefined) errors.push("escalators must be an object.");

  if (isObj(input.money)) {
    const m: AnalysisMoney = {};
    for (const k of ["capMonths", "absenceWeeks", "absencesPerYear"] as const) {
      const v = input.money[k];
      if (v === undefined) continue;
      const lim = MONEY_LIMITS[k];
      if (!isNum(v) || v < lim.min || v > lim.max) errors.push(`${k}: must be between ${lim.min} and ${lim.max}.`);
      else if (v !== DEFAULT_MONEY[k]) m[k] = round(v);
    }
    if (isObj(input.money.waitHours)) {
      const w: NonNullable<AnalysisMoney["waitHours"]> = {};
      for (const k of ["pipeline", "servicing"] as const) {
        const v = input.money.waitHours[k];
        if (v === undefined) continue;
        const lim = MONEY_LIMITS.waitHours;
        if (!isNum(v) || v < lim.min || v > lim.max) errors.push(`${k} wait: must be between ${lim.min} and ${lim.max} hours.`);
        else w[k] = round(v);
      }
      if (Object.keys(w).length) m.waitHours = w;
    } else if (input.money.waitHours !== undefined) errors.push("waitHours must be an object.");
    // Keys this version doesn't know are another ticket's money settings: pass them through untouched.
    const known = new Set(["capMonths", "absenceWeeks", "absencesPerYear", "waitHours"]);
    for (const [k, v] of Object.entries(input.money)) if (!known.has(k) && v !== undefined) m[k] = v;
    if (Object.keys(m).length) out.money = m;
  } else if (input.money !== undefined) errors.push("money must be an object.");

  return errors.length ? { ok: false, errors, value: out } : { ok: true, value: out };
}

function parseOverride(rule: AnalysisRuleId, o: unknown, errors: string[]): AnalysisOverride | null {
  if (!isObj(o)) {
    errors.push(`${rule}: an override isn't an object.`);
    return null;
  }
  const kind = o.kind;
  if (typeof kind !== "string" || !(OVERRIDE_KINDS as readonly string[]).includes(kind)) {
    errors.push(`${rule}: an override must be for a person, step, role, service or process.`);
    return null;
  }
  if (typeof o.id !== "string" || !o.id || o.id.length > 100) {
    errors.push(`${rule}: an override needs something to apply to.`);
    return null;
  }
  const out: AnalysisOverride = { kind: kind as OverrideKind, id: o.id };
  if (typeof o.label === "string" && o.label.trim()) out.label = o.label.trim().slice(0, 200);
  if (o.enabled === false) out.enabled = false;
  if (o.inputs !== undefined) {
    if (!Array.isArray(o.inputs) || !o.inputs.every(isNum)) {
      errors.push(`${rule}: override cut-offs must be numbers.`);
      return null;
    }
    const inputs = o.inputs.map(round);
    const problem = inputsProblem(rule, inputs);
    if (problem) {
      errors.push(`${rule}: ${problem}`);
      return null;
    }
    out.inputs = inputs;
  }
  if (o.expectedWaitHours !== undefined) {
    const lim = MONEY_LIMITS.waitHours;
    if (rule !== "wait" || !isNum(o.expectedWaitHours) || o.expectedWaitHours < lim.min || o.expectedWaitHours > lim.max) {
      errors.push(`${rule}: an expected wait must be between ${lim.min} and ${lim.max} hours, and only waiting rules have one.`);
      return null;
    }
    out.expectedWaitHours = round(o.expectedWaitHours);
  }
  if (typeof o.why === "string" && o.why.trim()) {
    if (o.why.length > MAX_TEXT) {
      errors.push(`${rule}: a note is at most ${MAX_TEXT} characters.`);
      return null;
    }
    out.why = o.why.trim();
  }
  if (out.enabled === undefined && out.inputs === undefined && out.expectedWaitHours === undefined) {
    errors.push(`${rule}: an override has to change something.`);
    return null;
  }
  return out;
}

/** A rule's settings with the defaults filled in. */
export interface ResolvedAnalysisRule {
  enabled: boolean;
  inputs: number[];
  overrides: AnalysisOverride[];
  /** Whether anything differs from the defaults. */
  changed: boolean;
}

export function resolveAnalysisRule(settings: AnalysisSettings, rule: AnalysisRuleId): ResolvedAnalysisRule {
  const spec = ANALYSIS_RULE_SPECS[rule];
  const r = settings.rules?.[rule];
  return {
    enabled: r?.enabled !== false,
    inputs: r?.inputs ? [...r.inputs] : [...spec.defaults],
    overrides: r?.overrides ? r.overrides.map((o) => ({ ...o })) : [],
    changed: Boolean(r && (r.enabled === false || r.inputs || r.overrides?.length)),
  };
}

/** The money settings with the defaults filled in; the expected waits are null until set. */
export function resolveMoney(settings: AnalysisSettings) {
  const m = settings.money ?? {};
  return {
    capMonths: m.capMonths ?? DEFAULT_MONEY.capMonths,
    absenceWeeks: m.absenceWeeks ?? DEFAULT_MONEY.absenceWeeks,
    absencesPerYear: m.absencesPerYear ?? DEFAULT_MONEY.absencesPerYear,
    waitHours: { pipeline: m.waitHours?.pipeline ?? null, servicing: m.waitHours?.servicing ?? null },
  };
}

/** Whether nothing differs from the defaults. */
export function isDefaultAnalysisSettings(settings: AnalysisSettings): boolean {
  return !Object.keys(parseAnalysisSettings(settings).value).length;
}

/**
 * The rating model's config for these settings. `hoursPerWeek` is the model's
 * working week, to turn the expected waits (hours) into working days.
 */
export function toRatingConfig(settings: AnalysisSettings | null | undefined, hoursPerWeek: number): RatingConfig {
  const s = parseAnalysisSettings(settings).value;
  const config = defaultRatingConfig();
  for (const id of RATING_RULE_IDS) {
    const r = s.rules?.[id];
    if (!r) continue;
    const to = TO_CUTOFFS[id];
    const overrides: RatingOverride[] = (r.overrides ?? []).map((o) => ({
      kind: o.kind,
      id: o.id,
      ...(o.enabled === false ? { enabled: false } : {}),
      ...(o.inputs ? { cutoffs: to(o.inputs) } : {}),
      ...(o.expectedWaitHours !== undefined ? { expectedWaitHours: o.expectedWaitHours } : {}),
    }));
    config.rules[id] = { enabled: r.enabled !== false, cutoffs: r.inputs ? to(r.inputs) : config.rules[id].cutoffs, overrides };
  }
  if (s.escalators?.badMonth === false) config.escalators.badMonth = false;
  if (s.escalators?.bottleneck === false) config.escalators.bottleneck = false;
  // The absence test: the recovery cut-offs are the last two inputs of "Only one person can do it" (rule-wide: overrides
  // for one person or step change the work-lost cut-offs only), and its length and frequency are money settings.
  const spof = resolveAnalysisRule(s, "spof");
  const money = resolveMoney(s);
  config.absence = { weeks: money.absenceWeeks, perYear: money.absencesPerYear, recoveryCutoffs: [spof.inputs[2]!, spof.inputs[2]!, spof.inputs[3]!] };
  const hoursPerDay = hoursPerWeek / 5;
  const w = s.money?.waitHours;
  if (hoursPerDay > 0 && w?.pipeline !== undefined) config.expectedWaitDays.pipeline = w.pipeline / hoursPerDay;
  if (hoursPerDay > 0 && w?.servicing !== undefined) config.expectedWaitDays.servicing = w.servicing / hoursPerDay;
  return config;
}

const RULE_OF_KEY_PREFIX: Record<string, AnalysisRuleId> = {
  capacity: "busy",
  // The forecast's "gets too busy in <month>" alerts (forecast.ts) are rule 1's too.
  forecast: "busy",
  overtime: "overtime",
  queue: "queue",
  wait: "wait",
  spof: "spof",
  rework: "rework",
  sla: "sla",
  spare: "spare",
  dropoff: "dropoff",
  cycle: "cycle",
  success: "success",
  churn_risk: "health",
  broken_scenario: "broken",
  perception_gap: "sources",
};

/** The analysis rule a finding comes from, by its key (`capacity:role:<id>`, `spof:step:<id>`, ...); null for ones no rule owns. */
export function ruleOfFinding(finding: { key: string; type?: string }): AnalysisRuleId | null {
  // A driver causing a share of a group's churn (rule 10) is a churn_risk issue too, but not rule 9's.
  if (finding.key.startsWith("churn_risk:driver:")) return "driver";
  return RULE_OF_KEY_PREFIX[finding.key.split(":")[0]!] ?? (finding.type ? (RULE_OF_KEY_PREFIX[finding.type] ?? null) : null);
}

/** Findings without those of rules the workspace has switched off (the whole rule; switches for one subject are the detectors' job). */
export function withoutDisabledRules<T extends { key: string; type?: string }>(settings: AnalysisSettings | null | undefined, findings: readonly T[]): T[] {
  const parsed = parseAnalysisSettings(settings).value;
  const off = new Set(ANALYSIS_RULE_IDS.filter((id) => !resolveAnalysisRule(parsed, id).enabled));
  if (!off.size) return [...findings];
  return findings.filter((f) => {
    const rule = ruleOfFinding(f);
    return !rule || !off.has(rule);
  });
}
