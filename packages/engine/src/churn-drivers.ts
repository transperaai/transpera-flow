// Churn drivers (docs/PRD.md decisions D21 and D28; ticket A56, issue #121).
//
// A client's base churn (its service's "normal churn", from the client group)
// is multiplied by what is going on around it. Each reason clients leave is a
// driver with a weight (0 to 3; 1 is normal, 0 ignores it) and an on/off
// switch. A driver has a pressure for each client in each week: how much extra
// churn the cause adds at weight 1, where 0 means nothing is wrong and 1
// doubles that client's churn. The weekly churn chance of a client is
//
//   base × (1 + Σ weight × pressure) × market
//
// where the sum runs over the switched-on drivers other than the market, and
// the market driver stretches the whole thing by the month's "clients
// leaving" factor (market.ts), weighted: 1 + weight × (factor − 1).
//
// The engine measures what it can:
//   late      the health a client has lost to late or missed servicing work
//             (the health-sensitivity term of docs/PRD.md §6.3.5, as before);
//   resp      the share of its ad-hoc requests answered late or not at all;
//   onb       how long a client signed in the run waited for its first delivery;
//   rework    the share of its servicing visits that had to be done again;
//   load      how busy the people who look after it are, above 85%;
//   handoff   an entered rate of account manager changes, plus time its
//             people are away (the measured part);
//   market    the market's "clients leaving" factor.
// The rest take what you enter as a stated assumption: results (a score out
// of 10), tenure (the multiple in the first six months), price (a planned
// rise) and any driver of your own (the extra churn it causes, in percent).
//
// Chances (sandbox phase 3, B4). A driver can instead run as events: each month a client is hit with a chance, and
// while it lasts (`months`, from the hit) the hit raises that client's churn by `effect` (0.5 = +50%); a hit during a
// hit extends it, effects never stack. The weekly chance of leaving is then
//
//   base × churn(t) × (1 + Σ weight-mode w × p + Σ chance-mode effect × hit) × market
//
// A driver switches to events only when an `effect` is set, so every stored driver stays in weight mode and nothing moves.
// Entered chances draw from their own random streams (`hit:<driver>:<client>`); measured drivers are hit by the event itself
// (a late task, a redone visit, a slow first delivery, a busy tick) and draw nothing. Tenure and market have no events.
//
// With the defaults (late and market on at weight 1, everything else off) the
// formula is exactly the one the engine used before drivers existed, so a
// model with no `churnDrivers` runs and rounds exactly as it did. Pure: no I/O.

import { clientChurnMonthly, withClientGroups } from "./clients";
import { exp, log } from "./det-math";
import type { EngineModel } from "./model";

export const BUILTIN_CHURN_DRIVER_IDS = ["late", "resp", "onb", "rework", "load", "handoff", "results", "tenure", "price", "market"] as const;
export type BuiltinChurnDriverId = (typeof BUILTIN_CHURN_DRIVER_IDS)[number];

/** Custom drivers' ids start with this. */
export const CUSTOM_DRIVER_PREFIX = "custom:";

/** Where a driver's number comes from, as the screen words it. */
export type ChurnDriverSource = "measured" | "partly" | "entered" | "lever" | "market";

export const CHURN_SOURCE_LABELS: Record<ChurnDriverSource, string> = {
  measured: "Measured",
  partly: "Partly measured",
  entered: "You enter it",
  lever: "Lever",
  market: "From market settings",
};

/** The limits of a weight: 0 ignores the cause, 1 is normal, 3 matters three times as much. */
export const CHURN_WEIGHT_MIN = 0;
export const CHURN_WEIGHT_MAX = 3;

export interface ChurnDriverSpec {
  id: BuiltinChurnDriverId;
  name: string;
  source: ChurnDriverSource;
  /** Switched on until you say otherwise: only the two the engine always applied. */
  defaultEnabled: boolean;
  /** The value you enter (stated assumption), or the target it is measured against; null when the driver has none. */
  defaultValue: number | null;
  /** Limits of the entered value. */
  valueRange: { min: number; max: number } | null;
  /** What the entered value is, in a few words. */
  valueLabel: string | null;
  /** How the driver can run as events (chances): measured by the engine at the event, entered by you, or not at all (tenure, market). */
  events: "measured" | "entered" | "none";
}

export const CHURN_DRIVER_SPECS: Record<BuiltinChurnDriverId, ChurnDriverSpec> = {
  late: { id: "late", name: "Late or missed servicing work", source: "measured", defaultEnabled: true, defaultValue: null, valueRange: null, valueLabel: null, events: "measured" },
  resp: { id: "resp", name: "Response time to ad-hoc requests", source: "measured", defaultEnabled: false, defaultValue: null, valueRange: null, valueLabel: null, events: "measured" },
  onb: {
    id: "onb",
    name: "Onboarding speed (won to first delivery)",
    source: "measured",
    defaultEnabled: false,
    defaultValue: 10,
    valueRange: { min: 1, max: 120 },
    valueLabel: "Normal first delivery, in working days",
    events: "measured",
  },
  rework: { id: "rework", name: "Rework or errors on deliverables", source: "measured", defaultEnabled: false, defaultValue: null, valueRange: null, valueLabel: null, events: "measured" },
  load: { id: "load", name: "Account team overload (above 85% busy)", source: "measured", defaultEnabled: false, defaultValue: null, valueRange: null, valueLabel: null, events: "measured" },
  handoff: {
    id: "handoff",
    name: "Account manager changes",
    source: "partly",
    defaultEnabled: false,
    defaultValue: 0.3,
    valueRange: { min: 0, max: 1 },
    valueLabel: "Share of clients whose account manager changes in a year",
    events: "entered",
  },
  results: {
    id: "results",
    name: "Client results or satisfaction",
    source: "entered",
    defaultEnabled: false,
    defaultValue: 7,
    valueRange: { min: 0, max: 10 },
    valueLabel: "Average rating out of 10",
    events: "entered",
  },
  tenure: {
    id: "tenure",
    name: "Early tenure (first 6 months)",
    source: "entered",
    defaultEnabled: false,
    defaultValue: 1.6,
    valueRange: { min: 1, max: 5 },
    valueLabel: "Times as likely to leave in months 1 to 6",
    events: "none",
  },
  price: {
    id: "price",
    name: "Price changes",
    source: "lever",
    defaultEnabled: false,
    defaultValue: 0,
    valueRange: { min: 0, max: 100 },
    valueLabel: "Planned price rise, %",
    events: "entered",
  },
  market: { id: "market", name: "Market conditions", source: "market", defaultEnabled: true, defaultValue: null, valueRange: null, valueLabel: null, events: "none" },
};

/** The most a chance-mode driver can raise a hit client's churn: +500%. */
export const CHURN_EFFECT_MAX = 5;
/** How long a hit lasts, in months. */
export const EFFECT_MONTHS = { min: 1, max: 24, default: 3 } as const;
/**
 * A price driver's effect is per this much of rise: an effect of 1 is +100% churn for a 10% rise. The weight mode's "10% adds 20% for 13 weeks"
 * at weight 1 is effect 0.2 for 3 months (`priceEffectOfWeight`).
 */
export const PRICE_EFFECT_PER = 0.1;

/** The limits of a custom driver's value: the extra churn it causes at weight 1, in percent. */
export const CUSTOM_DRIVER_VALUE = { min: 0, max: 500, default: 20 } as const;

/** What a stored driver looks like to the engine: a builtin's id or `custom:<id>`, and what you set. */
export interface EngineChurnDriver {
  id: string;
  /** 0 to 3. */
  weight: number;
  enabled: boolean;
  /** The entered value (see `ChurnDriverSpec.valueLabel`); a custom driver's is its extra churn in percent. */
  value?: number | null;
  /** Price changes only: the month (1 to 24 of the run) the rise takes effect; it weighs on churn for three months. */
  month?: number | null;
  /** A custom driver's name. */
  name?: string;
  /** Chance mode (B4): the monthly chance (0-1) a client is hit. Null or omitted: measured for late, resp, onb, rework and load; a default for the rest. */
  chance?: number | null;
  /** Chance mode: how much a hit raises that client's churn (0 to 5; 0.5 is +50%). A number switches the driver from its weight to events; null or omitted keeps the weight. Ignored for tenure and market. */
  effect?: number | null;
  /** Chance mode: months a hit lasts (1 to 24, default 3). */
  effectMonths?: number | null;
}

/** A driver run as events (chance mode), as the engine resolves it (and as a monthly channel gives it). */
export interface DriverEvents {
  /** Monthly chance a client is hit, 0-1. Null: measured (late, resp, onb, rework, load). */
  chance: number | null;
  /** How much a hit raises that client's churn while it lasts: 0.5 = +50%. */
  effect: number;
  /** Months a hit lasts, 1-24. */
  months: number;
}

/** A driver as the engine resolves it. */
export interface ResolvedChurnDriver {
  id: string;
  name: string;
  source: ChurnDriverSource;
  custom: boolean;
  weight: number;
  enabled: boolean;
  /** The entered value, or null when the driver takes none. */
  value: number | null;
  /** Price changes: the month the rise takes effect (1-based). */
  month: number;
  /** Chance mode, or null for weight x pressure exactly as before. An entered driver's chance is never null here (its default is filled in). */
  events: DriverEvents | null;
}

/** The chance an entered driver is hit with when none is given: handoff its yearly share a month, price 1 at each rise, the rest 1. */
export function defaultEventChance(id: string, value: number | null): number {
  return id === "handoff" ? clamp((value ?? 0) / 12, 0, 1) : 1;
}

/** A chance-and-effect setting made safe and complete for a driver (its chance defaulted when entered, its numbers brought into range). */
export function normaliseEvents(id: string, value: number | null, raw: DriverEvents): DriverEvents | null {
  const kind = id.startsWith(CUSTOM_DRIVER_PREFIX) ? "entered" : (CHURN_DRIVER_SPECS[id as BuiltinChurnDriverId]?.events ?? "none");
  if (kind === "none" || !finite(raw.effect)) return null;
  return {
    chance: finite(raw.chance) ? clamp(raw.chance, 0, 1) : kind === "measured" ? null : defaultEventChance(id, value),
    effect: clamp(raw.effect, 0, CHURN_EFFECT_MAX),
    months: finite(raw.months) ? clamp(Math.round(raw.months), EFFECT_MONTHS.min, EFFECT_MONTHS.max) : EFFECT_MONTHS.default,
  };
}

const eventsOf = (id: string, value: number | null, d: EngineChurnDriver | undefined): DriverEvents | null =>
  d && finite(d.effect)
    ? normaliseEvents(id, value, { chance: finite(d.chance) ? d.chance : null, effect: d.effect, months: finite(d.effectMonths) ? d.effectMonths : EFFECT_MONTHS.default })
    : null;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The drivers a model runs with: the ten built-ins in the screen's order (each
 * as set, or at its default), then the custom ones in the order given.
 * Out-of-range weights and values are brought into range, unknown ids that
 * aren't custom are ignored, and a repeated id keeps its first entry.
 */
export function resolveChurnDrivers(model: Pick<EngineModel, "churnDrivers">): ResolvedChurnDriver[] {
  // A run asks once per replication: the answer for a model is the same, so it is kept (and must not be changed by callers).
  const kept = resolved.get(model);
  if (kept) return kept;
  const out = resolveUncached(model);
  resolved.set(model, out);
  return out;
}

const resolved = new WeakMap<object, ResolvedChurnDriver[]>();

function resolveUncached(model: Pick<EngineModel, "churnDrivers">): ResolvedChurnDriver[] {
  const given = new Map<string, EngineChurnDriver>();
  for (const d of model.churnDrivers ?? []) if (!given.has(d.id)) given.set(d.id, d);
  const out: ResolvedChurnDriver[] = [];
  for (const id of BUILTIN_CHURN_DRIVER_IDS) {
    const spec = CHURN_DRIVER_SPECS[id];
    const d = given.get(id);
    const range = spec.valueRange;
    const value = range ? (d && finite(d.value) ? clamp(d.value, range.min, range.max) : spec.defaultValue) : null;
    out.push({
      id,
      name: spec.name,
      source: spec.source,
      custom: false,
      weight: d && finite(d.weight) ? clamp(d.weight, CHURN_WEIGHT_MIN, CHURN_WEIGHT_MAX) : 1,
      enabled: d ? d.enabled !== false : spec.defaultEnabled,
      value,
      month: id === "price" && d && finite(d.month) ? clamp(Math.round(d.month), 1, 24) : 1,
      events: eventsOf(id, value, d),
    });
  }
  for (const [id, d] of given) {
    if (!id.startsWith(CUSTOM_DRIVER_PREFIX)) continue;
    const value = finite(d.value) ? clamp(d.value, CUSTOM_DRIVER_VALUE.min, CUSTOM_DRIVER_VALUE.max) : CUSTOM_DRIVER_VALUE.default;
    out.push({
      id,
      name: d.name?.trim() || "Your own driver",
      source: "entered",
      custom: true,
      weight: finite(d.weight) ? clamp(d.weight, CHURN_WEIGHT_MIN, CHURN_WEIGHT_MAX) : 1,
      enabled: d.enabled !== false,
      value,
      month: 1,
      events: eventsOf(id, value, d),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pressure: how much extra churn a cause adds at weight 1
// ---------------------------------------------------------------------------

/** A quarter of a client's work redone is the most rework counts for. */
export const REWORK_FULL_SHARE = 0.25;
/** Half of a client's ad-hoc requests late or missed is the most response time counts for. */
export const RESPONSE_FULL_SHARE = 0.5;
/** Busy share above which the team looking after a client is overloaded, and where the pressure is full. */
export const LOAD_THRESHOLD = 0.85;
export const LOAD_FULL = 1;
/** Weeks of a client's life that count as early tenure. */
export const EARLY_TENURE_WEEKS = 26;
/** Weeks a planned price rise weighs on churn. */
export const PRICE_WEIGHT_WEEKS = 13;
/** Pressure per whole unit of price rise: a 10% rise adds 20% to churn. */
export const PRICE_PRESSURE_PER_UNIT = 2;
/** A rating of this or more out of 10 adds nothing; each point below adds `RESULTS_PRESSURE_PER_POINT`. */
export const RESULTS_NORMAL_SCORE = 8;
export const RESULTS_PRESSURE_PER_POINT = 0.25;
/** An account manager change adds this much for a client whose people are away. */
export const AWAY_PRESSURE = 0.5;

/** Late or missed share of ad-hoc requests, 0 to 1 pressure. */
export const responsePressure = (badShare: number): number => clamp(badShare / RESPONSE_FULL_SHARE, 0, 1);
/** Share of visits done again, 0 to 1 pressure. */
export const reworkPressure = (share: number): number => clamp(share / REWORK_FULL_SHARE, 0, 1);
/** How busy a team is (1 = 100%), above the 85% line. */
export const loadPressure = (util: number): number => clamp((util - LOAD_THRESHOLD) / (LOAD_FULL - LOAD_THRESHOLD), 0, 1);
/** Waiting longer than normal for the first delivery: twice as long as normal is full pressure. */
export const onboardingPressure = (delayHours: number, normalHours: number): number =>
  normalHours > 0 && delayHours > normalHours ? Math.min(1, (delayHours - normalHours) / normalHours) : 0;
/** An average rating out of 10. */
export const resultsPressure = (score: number): number => clamp((RESULTS_NORMAL_SCORE - score) * RESULTS_PRESSURE_PER_POINT, 0, 1);
/** A price rise in percent. */
export const pricePressure = (risePercent: number): number => Math.max(0, risePercent / 100) * PRICE_PRESSURE_PER_UNIT;

/** The share of time a client is under a hit's effect when it is hit with `chance` each month and a hit lasts `months`: 1 - (1 - chance)^months. */
export function eventExposure(chance: number, months: number): number {
  if (!(chance > 0)) return 0;
  if (chance >= 1) return 1;
  let keep = 1;
  for (let i = 0; i < months; i++) keep *= 1 - chance;
  return 1 - keep;
}

/** Hits a week as a monthly chance: 1 - (1 - q)^(weeks in a month), for q hits per client-week (at most 1 a week). */
export function weeklyHitsToMonthlyChance(q: number, weeksPerMonth: number): number {
  if (!(q > 0)) return 0;
  if (q >= 1) return 1;
  return 1 - exp(weeksPerMonth * log(1 - q));
}

// ---------------------------------------------------------------------------
// What a run reports
// ---------------------------------------------------------------------------

/** One cause of churn in a run. */
export interface ChurnCause {
  id: string;
  name: string;
  source: ChurnDriverSource;
  custom: boolean;
  enabled: boolean;
  weight: number;
  /** Share of all the churn it causes (0-1), by clients; the shares of every cause and normal churn add up to 1. */
  share: number;
  /** Clients lost to it in a run, on average. */
  clients: number;
  /** Monthly fees of the clients lost to it, in a run, on average. */
  mrr: number;
  /** Its average pressure on an active client over the run (0 = nothing wrong; the market's is its factor minus 1). */
  pressure: number;
  /**
   * What was measured or entered, in the driver's own unit: the share of work late or missed (late), hours to answer
   * an ad-hoc request (resp), working days to first delivery (onb), the share of work redone (rework), how busy the
   * busiest of the team is, 0-1 (load), the entered number (handoff, results, tenure, price, your own), or the
   * market's average "clients leaving" factor (market). Null when nothing could be measured.
   */
  value: number | null;
  /** A person's id when the value is theirs (load: the busiest). */
  valuePerson?: string;
  /** How the driver was counted: `weight` (weight × pressure) or `chance` (events: hits and an effect). */
  mode: "weight" | "chance";
  /**
   * Hits a month per active client in the run, as a chance (0-1): measured for late, resp, onb, rework and load (counted in
   * both modes, so Settings can show it before anyone switches), drawn or counted for a chance-mode driver. Null for tenure,
   * market, price, and an entered driver in weight mode.
   */
  chance: number | null;
  /** Share of active client-weeks under the driver's effect (0 in weight mode). */
  exposure: number;
  /** The effect a hit had (chance mode; the last month's when it changed), or null in weight mode. */
  effect: number | null;
}

/** One service's churn by cause (a service's clients, including those won in the run). */
export interface ChurnCausesByService {
  /** Clients lost in a run, on average (all causes). */
  clients: number;
  /** Share of that churn each cause is responsible for, by driver id; `normal` is the rest. */
  shares: Record<string, number>;
}

export interface ChurnCauses {
  /** Clients lost in a run, on average: what the causes below add up to. */
  clients: number;
  /** Their monthly fees. */
  mrr: number;
  /** The part of the churn that is simply base churn ("normal churn"): not blamed on any driver. */
  normal: { share: number; clients: number; mrr: number };
  /** Every driver, in the screen's order (built-ins, then your own), including those switched off. */
  causes: ChurnCause[];
  /** By service id; clients on no known service are under `""`. */
  byService: Record<string, ChurnCausesByService>;
  /** Average of the "clients leaving" market factor (1 with no market). */
  marketFactor: number;
  /** The base churn of the clients at the start, in clients a month, and their mean base rate. */
  baseClientsPerMonth: number;
}

/** One replication's raw churn accounting, indexed by slot: 0 is normal churn, then each resolved driver in order. */
export interface ChurnReplication {
  clients: number[];
  mrr: number[];
  /** Sum of every active client-week's pressure, per slot; divide by `pressureN`. */
  pressure: number[];
  pressureN: number;
  /** Per service id ("" for none): expected clients lost per slot. */
  byService: Record<string, number[]>;
  /** The measured value per driver slot (null: nothing to measure). */
  values: (number | null)[];
  valuePerson: (string | null)[];
  /** Per driver slot: hits (the events, measured or drawn) and client-weeks under its effect, client-weeks it ran in chance mode, and its last effect. */
  hits?: number[];
  exposed?: number[];
  chanceWeeks?: number[];
  effect?: (number | null)[];
}

/** Average the replications' accounting into the run's causes. Pure. */
export function summariseChurn(model: EngineModel, drivers: readonly ResolvedChurnDriver[], reps: readonly ChurnReplication[]): ChurnCauses {
  const n = reps.length || 1;
  const slots = drivers.length + 1;
  const mean = (f: (r: ChurnReplication, i: number) => number, i: number) => reps.reduce((a, r) => a + f(r, i), 0) / n;
  const clientsBy: number[] = [];
  const mrrBy: number[] = [];
  for (let i = 0; i < slots; i++) {
    clientsBy.push(mean((r, s) => r.clients[s]!, i));
    mrrBy.push(mean((r, s) => r.mrr[s]!, i));
  }
  const totalClients = clientsBy.reduce((a, b) => a + b, 0);
  const totalMrr = mrrBy.reduce((a, b) => a + b, 0);
  const share = (v: number) => (totalClients > 0 ? v / totalClients : 0);
  const causes: ChurnCause[] = drivers.map((d, k) => {
    const s = k + 1;
    const withPressure = reps.filter((r) => r.pressureN > 0);
    const values = reps.map((r) => r.values[s] ?? null).filter((v): v is number => v !== null);
    const of = reps.map((r) => r.valuePerson[s] ?? null).find((v) => v !== null);
    // Chance mode, hits and exposure (engine 1.12.0). Replications from before them read as weight mode with nothing counted.
    const spec = d.custom ? "entered" : (CHURN_DRIVER_SPECS[d.id as BuiltinChurnDriverId]?.events ?? "none");
    const chanceWeeks = reps.reduce((a, r) => a + (r.chanceWeeks?.[s] ?? 0), 0);
    const mode: "weight" | "chance" = chanceWeeks > 0 || d.events !== null ? "chance" : "weight";
    const rates = withPressure.map((r) => {
      const q = (r.hits?.[s] ?? 0) / r.pressureN;
      return weeklyHitsToMonthlyChance(q, WEEKS_PER_MONTH);
    });
    const counted = spec === "measured" || (spec === "entered" && mode === "chance" && d.id !== "price");
    const exposed = withPressure.length ? withPressure.reduce((a, r) => a + (r.exposed?.[s] ?? 0) / r.pressureN, 0) / withPressure.length : 0;
    const effects = reps.map((r) => r.effect?.[s] ?? null).filter((v): v is number => v !== null);
    return {
      id: d.id,
      name: d.name,
      source: d.source,
      custom: d.custom,
      enabled: d.enabled,
      weight: d.weight,
      share: share(clientsBy[s]!),
      clients: clientsBy[s]!,
      mrr: mrrBy[s]!,
      pressure: withPressure.length ? withPressure.reduce((a, r) => a + r.pressure[s]! / r.pressureN, 0) / withPressure.length : 0,
      value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      ...(of ? { valuePerson: of } : {}),
      mode,
      chance: counted && rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      exposure: mode === "chance" ? exposed : 0,
      effect: mode === "chance" ? (effects.length ? effects[effects.length - 1]! : (d.events?.effect ?? null)) : null,
    };
  });
  const byService: Record<string, ChurnCausesByService> = {};
  const services = new Set<string>();
  for (const r of reps) for (const sid of Object.keys(r.byService)) services.add(sid);
  for (const sid of [...services].sort()) {
    const per = new Array<number>(slots).fill(0);
    for (const r of reps) {
      const row = r.byService[sid];
      if (row) for (let s = 0; s < slots; s++) per[s]! += row[s]! / n;
    }
    const total = per.reduce((a, b) => a + b, 0);
    const shares: Record<string, number> = { normal: total > 0 ? per[0]! / total : 0 };
    drivers.forEach((d, k) => (shares[d.id] = total > 0 ? per[k + 1]! / total : 0));
    byService[sid] = { clients: total, shares };
  }
  const market = causes.find((c) => c.id === "market");
  return {
    clients: totalClients,
    mrr: totalMrr,
    normal: { share: share(clientsBy[0]!), clients: clientsBy[0]!, mrr: mrrBy[0]! },
    causes,
    byService,
    marketFactor: market ? 1 + market.pressure : 1,
    baseClientsPerMonth: baseClientsPerMonth(model),
  };
}

/** Weeks in a month as the churn tick uses them (4.33), the engine's conversion from a monthly rate to a weekly chance. */
const WEEKS_PER_MONTH = 4.33;

/** Clients a month the model's clients at the start lose to normal churn alone: Σ each client's base monthly churn. */
export function baseClientsPerMonth(source: EngineModel): number {
  const model = withClientGroups(source);
  if (model.clients && Object.keys(model.clients).length) {
    let sum = 0;
    for (const cid of Object.keys(model.clients).sort()) sum += clientChurnMonthly(model, model.clients[cid]!);
    return sum;
  }
  return model.activeClients * model.churnMonthly;
}

/** A weight set to try on the screen, by driver id. */
export interface DriverWeightChoice {
  id: string;
  weight: number;
  enabled: boolean;
  /**
   * Chance mode: a choice with an `effect` is counted as events, adding `effect × exposure` instead of `weight × pressure`, where
   * exposure comes from `chance` (null: the run's measured chance) and `months` (default 3).
   */
  effect?: number | null;
  chance?: number | null;
  months?: number | null;
}

/** The screen's projection: churn and each driver's share with weights as chosen, from a run's measured pressures. */
export interface ChurnProjection {
  /** Clients a month. */
  clientsPerMonth: number;
  /** Each driver's share of that churn (0-1), by id; switched off drivers have 0. */
  shares: Record<string, number>;
  /** Normal churn's share. */
  normalShare: number;
}

/**
 * Churn per month with the weights as chosen, from the pressures a run
 * measured: base × (1 + Σ weight × pressure) × (1 + market weight × (factor − 1)).
 * It moves as the weights move, with no new simulation. Each driver's pressure is
 * the run's average over all client-weeks, not weighted by each client's base churn,
 * so it can differ a little from the run's own shares when clients with high base
 * churn carry different pressure from the rest. A projection, not a
 * run: it holds the measured pressures fixed, so it ignores how churn itself
 * changes who is left.
 */
export function projectChurn(causes: ChurnCauses, choices: readonly DriverWeightChoice[]): ChurnProjection {
  const by = new Map(choices.map((c) => [c.id, c]));
  let add = 0;
  const parts: [string, number][] = [];
  let marketW = 0;
  let marketPressure = 0;
  for (const c of causes.causes) {
    const choice = by.get(c.id) ?? { id: c.id, weight: c.weight, enabled: c.enabled };
    if (!choice.enabled) {
      parts.push([c.id, 0]);
      continue;
    }
    if (c.id === "market") {
      marketW = choice.weight;
      marketPressure = c.pressure;
      parts.push([c.id, 0]);
      continue;
    }
    let v: number;
    if (c.id === "price" && choice.effect !== undefined && choice.effect !== null && Number.isFinite(choice.effect)) {
      // The price driver as events: a rise hits a client once (with the chance, default 1) for `months`. A run in chance mode measured the
      // hits' size times their share of client-weeks; a run by weight measured 2 per unit of rise over 13 weeks, which converts.
      const months = choice.months ?? EFFECT_MONTHS.default;
      const chance = choice.chance ?? 1;
      v =
        c.mode === "chance"
          ? Math.max(0, choice.effect * c.pressure)
          : Math.max(0, choice.effect * chance * (c.pressure / (PRICE_PRESSURE_PER_UNIT * PRICE_EFFECT_PER)) * ((months * (52 / 12)) / PRICE_WEIGHT_WEEKS));
    } else if (choice.effect !== undefined && choice.effect !== null && Number.isFinite(choice.effect)) {
      // Chance mode: the chance of being under a hit's effect, times the effect. A run that was itself in chance mode with no new chance keeps its measured exposure.
      const months = choice.months ?? EFFECT_MONTHS.default;
      const chance = choice.chance ?? c.chance ?? 0;
      const exposure = c.mode === "chance" && (choice.chance === undefined || choice.chance === null) && months === EFFECT_MONTHS.default ? c.exposure : eventExposure(chance, months);
      v = Math.max(0, choice.effect * exposure);
    } else {
      v = Math.max(0, choice.weight * c.pressure);
    }
    add += v;
    parts.push([c.id, v]);
  }
  const a = 1 + add;
  const b = marketW > 0 ? Math.max(0, 1 + marketW * marketPressure) : 1;
  const marketPart = b > 1 ? a * (b - 1) : 0;
  const total = a + marketPart;
  const shares: Record<string, number> = {};
  for (const [id, v] of parts) shares[id] = id === "market" ? marketPart / total : v / total;
  return { clientsPerMonth: causes.baseClientsPerMonth * a * b, shares, normalShare: 1 / total };
}

/**
 * The chance and effect that give a driver the churn its weight gave in the last run, to pre-fill when it is switched to
 * chances: `chance` is null for a measured driver (the engine measures it; the run's `chance` is what to expect) and 1 for
 * results and your own drivers (a hit every week with effect weight × pressure is exactly today's term), a twelfth of the yearly share
 * for handoff; the effect is weight × the run's pressure ÷ the share of time under a hit (capped at 5). The expected churn
 * matches in expectation, not draw for draw.
 */
export function equivalentEvents(cause: Pick<ChurnCause, "id" | "custom" | "pressure" | "chance" | "value">, weight: number, months: number = EFFECT_MONTHS.default): DriverEvents {
  const spec = cause.custom ? "entered" : (CHURN_DRIVER_SPECS[cause.id as BuiltinChurnDriverId]?.events ?? "none");
  // The price driver: a rise's pressure in weight mode is 2 per unit for 13 weeks, as events it is effect per 10% for the months, so the
  // effect that matches doesn't depend on the last run (which may have had no rise to measure).
  if (cause.id === "price" && !cause.custom) return { chance: 1, effect: priceEffectOfWeight(weight, months), months };
  const target = Math.max(0, weight * cause.pressure);
  if (spec === "measured") {
    const exposure = eventExposure(cause.chance ?? 0, months);
    // No hits measured: no effect can give the weight's churn (the cause would add nothing as a chance), so none is pre-filled.
    return { chance: null, effect: exposure > 0 ? Math.min(CHURN_EFFECT_MAX, target / exposure) : 0, months };
  }
  const chance = defaultEventChance(cause.id, cause.value);
  const exposure = eventExposure(chance, months);
  return { chance: cause.id === "handoff" ? chance : spec === "entered" ? 1 : null, effect: exposure > 0 ? Math.min(CHURN_EFFECT_MAX, target / exposure) : 0, months };
}

/** The price driver's effect (per 10% rise, for `months`) that gives a rise the churn the weight gives it: 2 × weight per unit of rise for 13 weeks. */
export function priceEffectOfWeight(weight: number, months: number = EFFECT_MONTHS.default): number {
  const effect = (Math.max(0, weight) * PRICE_PRESSURE_PER_UNIT * PRICE_EFFECT_PER * PRICE_WEIGHT_WEEKS) / (months * (52 / 12));
  return Math.min(CHURN_EFFECT_MAX, effect);
}
