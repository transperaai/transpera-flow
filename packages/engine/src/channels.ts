// Monthly channels (sandbox phase 3; docs/plans/sandbox-p3-brief.md §2.2): per-month values the engine reads while it
// runs, so a change from a month is one run, exact from the month, and the months before it are exactly the run without it.
//
// Each channel is an array indexed by the run's months. Month 0 starts at t = 0 and also covers the warm-up; month k starts at
// `starts[k - 1]`; an array shorter than `starts.length + 1` holds its last value. A channel whose every month is neutral (all
// 1, or equal to what the model already says) is dropped by `activeChannels`, so such a model takes the old code paths and
// simulates exactly as before channels existed, like `activeMarket` for the market.

import type { DriverEvents } from "./churn-drivers";
import type { EngineChannels, EngineModel } from "./model";
import { MAX_REWORK } from "./scenario";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Throws on channels the engine can't run: non-numbers, negatives, rework above the maximum, or month starts out of order. */
export function checkChannels(c: EngineChannels, horizonHours = Infinity): void {
  if (!Array.isArray(c.starts)) throw new Error("Channels need the months' start hours");
  let prev = 0;
  for (const s of c.starts) {
    if (!(isNum(s) && s > prev && s < horizonHours)) throw new Error("Channel month starts must rise and fall inside the run");
    prev = s;
  }
  const arr = (name: string, a: unknown, max = Infinity) => {
    if (!Array.isArray(a) || !a.length) throw new Error(`Channel '${name}' needs at least one month`);
    if (a.length > c.starts.length + 1) throw new Error(`Channel '${name}' has more months than the run`);
    for (const v of a) if (!(isNum(v) && v >= 0 && v <= max)) throw new Error(`Channel '${name}' must be numbers from 0${max < Infinity ? ` to ${max}` : ""}`);
  };
  const rec = (name: string, r: Record<string, number[]> | undefined, max = Infinity) => {
    for (const id of Object.keys(r ?? {})) arr(`${name} ${id}`, r![id], max);
  };
  if (c.leads) arr("leads", c.leads);
  if (c.conv) arr("conv", c.conv);
  if (c.overheads) arr("overheads", c.overheads);
  rec("mix", c.mix);
  rec("newFee", c.newFee);
  rec("fee", c.fee);
  rec("churn", c.churn);
  rec("work", c.work);
  rec("wait", c.wait);
  rec("rework", c.rework, MAX_REWORK);
  rec("roleCost", c.roleCost);
  rec("capacity", c.capacity);
  for (const id of Object.keys(c.priceRange ?? {})) {
    const a = c.priceRange![id]!;
    if (!Array.isArray(a) || !a.length || a.length > c.starts.length + 1) throw new Error(`Channel 'priceRange ${id}' has the wrong number of months`);
    for (const v of a) if (v !== null && !(isNum(v.low) && isNum(v.high) && v.low >= 0 && v.high >= 0)) throw new Error(`Channel 'priceRange ${id}' must be fees of 0 or more`);
  }
  for (const id of Object.keys(c.drivers ?? {})) {
    const a = c.drivers![id]!;
    if (!Array.isArray(a) || !a.length || a.length > c.starts.length + 1) throw new Error(`Channel 'drivers ${id}' has the wrong number of months`);
  }
}

/** The array with its last value repeated to `n` months. */
function expand<T>(a: readonly T[], n: number): T[] {
  if (a.length >= n) return a.slice(0, n) as T[];
  return [...a, ...new Array<T>(n - a.length).fill(a[a.length - 1]!)];
}

const allOne = (a: readonly number[]) => a.every((v) => v === 1);

/**
 * The channels a run acts on: checked, with every array dropped that is neutral (all 1 for multipliers; equal to the model's
 * own value for `wait`, `rework` and `mix`; all null for `priceRange` and `drivers`), or null when nothing is left. Cached
 * per `model.channels`, so a run's replications share it.
 */
export function activeChannels(model: EngineModel): EngineChannels | null {
  const c = model.channels;
  if (!c) return null;
  const hit = active.get(c);
  if (hit !== undefined) return hit.model === model ? hit.value : build(model, c);
  return build(model, c);
}

const active = new WeakMap<EngineChannels, { model: EngineModel; value: EngineChannels | null }>();

function build(model: EngineModel, c: EngineChannels): EngineChannels | null {
  checkChannels(c, model.horizonWeeks * model.hoursPerWeek);
  const out: EngineChannels = { starts: c.starts };
  let any = false;
  const mult = (a: number[] | undefined): number[] | undefined => (a && !allOne(a) ? ((any = true), a) : undefined);
  const multRec = (r: Record<string, number[]> | undefined, known: (id: string) => boolean, what: string): Record<string, number[]> | undefined => {
    let o: Record<string, number[]> | undefined;
    for (const id of Object.keys(r ?? {})) {
      if (id !== "*" && !known(id)) throw new Error(`A channel names ${what} '${id}', which the model doesn't have`);
      if (allOne(r![id]!)) continue;
      (o ??= {})[id] = r![id]!;
      any = true;
    }
    return o;
  };
  const stepOf = new Map(model.steps.map((s) => [s.id, s]));
  const hasService = (id: string) => Boolean(model.services && id in model.services);
  const hasRole = (id: string) => id in model.roles;
  const personIds = model.people ? Object.keys(model.people) : null;
  const hasPerson = (id: string) => (personIds ? personIds.includes(id) : true);
  const set = <K extends keyof EngineChannels>(k: K, v: EngineChannels[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("leads", mult(c.leads));
  set("conv", mult(c.conv));
  set("overheads", mult(c.overheads));
  set("newFee", multRec(c.newFee, hasService, "service"));
  set("fee", multRec(c.fee, hasService, "service"));
  set("churn", multRec(c.churn, hasService, "service"));
  set("work", multRec(c.work, (id) => stepOf.has(id), "step"));
  set("roleCost", multRec(c.roleCost, hasRole, "role"));
  set("capacity", multRec(c.capacity, hasPerson, "person"));
  // Absolute values: neutral when every month is what the model already says.
  const absolute = (r: Record<string, number[]> | undefined, base: (id: string) => number | undefined, what: string): Record<string, number[]> | undefined => {
    let o: Record<string, number[]> | undefined;
    for (const id of Object.keys(r ?? {})) {
      const b = base(id);
      if (b === undefined) throw new Error(`A channel names ${what} '${id}', which the model doesn't have`);
      if (r![id]!.every((v) => v === b)) continue;
      (o ??= {})[id] = r![id]!;
      any = true;
    }
    return o;
  };
  set("wait", absolute(c.wait, (id) => stepOf.get(id)?.wait, "step"));
  set("rework", absolute(c.rework, (id) => stepOf.get(id)?.rework, "step"));
  set("mix", absolute(c.mix, (id) => model.services?.[id]?.mixShare, "service"));
  for (const k of ["priceRange", "drivers"] as const) {
    const r = c[k] as Record<string, unknown[]> | undefined;
    let o: Record<string, unknown[]> | undefined;
    for (const id of Object.keys(r ?? {})) {
      if (k === "priceRange" && !hasService(id)) throw new Error(`A channel names service '${id}', which the model doesn't have`);
      if (r![id]!.every((v) => v === null)) continue;
      (o ??= {})[id] = r![id]!;
      any = true;
    }
    if (o) (out as unknown as Record<string, unknown>)[k] = o;
  }
  const value = any ? out : null;
  active.set(c, { model, value });
  return value;
}

/** The month `t` falls in: how many of the starts are at or before it (a binary search; before t = 0 it is month 0). */
export function channelMonth(starts: readonly number[], t: number): number {
  if (!(t > 0) || !starts.length || t < starts[0]!) return 0;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A rise in a service's fees: from `t` (hours), by `r` (0.1 is +10%). */
export interface FeeRise {
  t: number;
  r: number;
}

/** What a run reads from the channels, worked out once per model (`planChannels`): every array expanded to one value per month. */
export interface ChannelPlan {
  /** Months in the run: `starts.length + 1`. */
  n: number;
  starts: readonly number[];
  leads: number[] | null;
  conv: number[] | null;
  overheads: number[] | null;
  /** Mix weights by month then service index (in `model.services` order), and each month's total; null when the mix isn't a channel. */
  mix: number[][] | null;
  mixTotal: number[] | null;
  /** By service id: its combined factor ("*" included) per month, or null (= "*" only / none). `""` is the key for clients on no service. */
  newFee: ByKey;
  fee: ByKey;
  churn: ByKey;
  /** Rises in fees per service key ("" and ids), including "*"'s, ordered by time. */
  rises: Map<string, FeeRise[]>;
  priceRange: Map<string, ({ low: number; high: number } | null)[]>;
  drivers: Map<string, (DriverEvents | null)[]>;
  work: Map<string, number[]>;
  wait: Map<string, number[]>;
  rework: Map<string, number[]>;
  roleCost: Map<string, number[]>;
  /** The highest rework each step gets in any month (its own included): the loops a step can be in. */
  maxRework: Map<string, number>;
}

export interface ByKey {
  /** Combined factor per month for the service id, falling back to the "*" array; `get("")` is "*" alone. */
  byId: Map<string, number[]>;
  star: number[] | null;
  any: boolean;
}

const planCache = new WeakMap<EngineChannels, ChannelPlan>();

function byKey(r: Record<string, number[]> | undefined, n: number, ids: string[]): ByKey {
  const star = r?.["*"] ? expand(r["*"], n) : null;
  const byId = new Map<string, number[]>();
  for (const id of ids) {
    const own = r?.[id] ? expand(r[id], n) : null;
    if (!own) continue;
    byId.set(id, star ? own.map((v, m) => v * star[m]!) : own);
  }
  return { byId, star, any: Boolean(r && Object.keys(r).length) };
}

/** The values a run looks up, expanded once. `ch` must be `activeChannels(model)`. */
export function planChannels(model: EngineModel, ch: EngineChannels): ChannelPlan {
  const hit = planCache.get(ch);
  if (hit) return hit;
  const n = ch.starts.length + 1;
  const ids = Object.keys(model.services ?? {});
  const plan: ChannelPlan = {
    n,
    starts: ch.starts,
    leads: ch.leads ? expand(ch.leads, n) : null,
    conv: ch.conv ? expand(ch.conv, n) : null,
    overheads: ch.overheads ? expand(ch.overheads, n) : null,
    mix: null,
    mixTotal: null,
    newFee: byKey(ch.newFee, n, ids),
    fee: byKey(ch.fee, n, ids),
    churn: byKey(ch.churn, n, ids),
    rises: new Map(),
    priceRange: new Map(Object.entries(ch.priceRange ?? {}).map(([id, a]) => [id, expand(a, n)])),
    drivers: new Map(Object.entries(ch.drivers ?? {}).map(([id, a]) => [id, expand(a, n)])),
    work: new Map(Object.entries(ch.work ?? {}).map(([id, a]) => [id, expand(a, n)])),
    wait: new Map(Object.entries(ch.wait ?? {}).map(([id, a]) => [id, expand(a, n)])),
    rework: new Map(Object.entries(ch.rework ?? {}).map(([id, a]) => [id, expand(a, n)])),
    roleCost: new Map(Object.entries(ch.roleCost ?? {}).map(([id, a]) => [id, expand(a, n)])),
    maxRework: new Map(),
  };
  if (ch.mix) {
    const sv = Object.entries(model.services ?? {});
    const mix = Array.from({ length: n }, (_, m) => sv.map(([id, s]) => (ch.mix![id] ? expand(ch.mix![id]!, n)[m]! : s.mixShare)));
    plan.mix = mix;
    plan.mixTotal = mix.map((w) => w.reduce((a, b) => a + b, 0));
    for (const t of plan.mixTotal) if (!(t > 0)) throw new Error("The services' mix shares must add up to more than 0");
  }
  // Rises in fees, for the price driver: each month whose factor is above the one before it (month 0 against 1).
  if (plan.fee.any) {
    const rises = (a: number[]): FeeRise[] => {
      const out: FeeRise[] = [];
      for (let m = 0; m < n; m++) {
        const before = m === 0 ? 1 : a[m - 1]!;
        if (a[m]! > before && before > 0) out.push({ t: m === 0 ? 0 : ch.starts[m - 1]!, r: a[m]! / before - 1 });
      }
      return out;
    };
    const starRises = ch.fee?.["*"] ? rises(expand(ch.fee["*"], n)) : [];
    const merge = (a: FeeRise[], b: FeeRise[]) => [...a, ...b].sort((x, y) => x.t - y.t);
    plan.rises.set("", starRises);
    for (const id of ids) plan.rises.set(id, merge(ch.fee?.[id] ? rises(expand(ch.fee[id]!, n)) : [], starRises));
  }
  for (const s of model.steps) {
    const r = plan.rework.get(s.id);
    if (r) plan.maxRework.set(s.id, Math.max(s.rework, ...r));
  }
  planCache.set(ch, plan);
  return plan;
}

/** The factor `a` (per month, or null for none) has at month `m`: 1 with none. */
export const factorAt = (a: readonly number[] | null | undefined, m: number): number => (a ? a[m]! : 1);

/** The combined factor of a key's array: the service's own (with "*"), else "*" alone, else none. */
export function keyFactors(b: ByKey, key: string): number[] | null {
  return b.byId.get(key) ?? b.star;
}

/** The model with each step's rework set to the highest it has in any channel month, so a step that gains rework from a month still has its redo loop. */
export function withMaxRework(model: EngineModel, plan: ChannelPlan): EngineModel {
  if (!plan.maxRework.size) return model;
  return { ...model, steps: model.steps.map((s) => (plan.maxRework.has(s.id) ? { ...s, rework: plan.maxRework.get(s.id)! } : s)) };
}

/** Each person's capacity factor per month (their own and "*" multiplied), for the people that have one, and the months where any factor changes. */
export function capacityFactors(ch: EngineChannels, personIds: readonly string[], n: number): { byPerson: Map<string, number[]>; months: number[] } | null {
  if (!ch.capacity) return null;
  const star = ch.capacity["*"] ? expand(ch.capacity["*"], n) : null;
  const byPerson = new Map<string, number[]>();
  const changing = new Set<number>();
  for (const pid of personIds) {
    const own = ch.capacity[pid] ? expand(ch.capacity[pid]!, n) : null;
    if (!own && !star) continue;
    const f = Array.from({ length: n }, (_, m) => (own ? own[m]! : 1) * (star ? star[m]! : 1));
    byPerson.set(pid, f);
    for (let m = 1; m < n; m++) if (f[m] !== f[m - 1]) changing.add(m);
  }
  return { byPerson, months: [...changing].sort((a, b) => a - b) };
}
