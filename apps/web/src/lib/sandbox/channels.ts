// Changes from a month as the engine's monthly channels (docs/plans/sandbox-p3-brief.md §5.4, packages/engine/src/channels.ts). Pure.
//
// Every channel lever writes its month array from the month its `from` falls in (on or before the start: month 0). A value acts on the
// model after the whole-run changes: a `set` becomes the ratio to the value in force, several changes to one target apply in month
// order, then change order, each on the value in force at its month. `@busiest` and `@heaviest` resolve on the whole-run model. Months
// before the first change are exactly 1 (or the model's own value), so the run before it is the run without it.

import { sandboxLever, type ProcessBundle, type SandboxChange } from "@transpera-flow/db";
import { MAX_REWORK, busiestRole, heaviestStep, resolvePeople, type EngineChannels, type EngineModel } from "@transpera-flow/engine";
import { hoursToDate } from "@/lib/forecast/positions";
import { combine, driverExists, hasClientRoster, sourceLeads, totalLeads } from "./edits";
import type { ChangeProblem } from "./run";

const EFFECT_MONTHS_DEFAULT = 3;

/** Whole-run changes of these levers are channels from month 0 too (the others are patches or model edits). */
export function isChannelChange(c: SandboxChange, d4Unhandled: ReadonlySet<string>): boolean {
  const lever = sandboxLever(c.lever);
  if (!lever) return false;
  if (c.lever === "D4") return c.from !== undefined && d4Unhandled.has(c.id);
  if (c.from !== undefined) return lever.timed === "channel";
  return c.lever === "A3" || c.lever === "D6" || c.lever === "B5" || (c.lever === "B2" && c.params?.who === "all");
}

/** A value month by month, starting at its base. */
class Track {
  readonly cur: number[];
  constructor(
    readonly base: number,
    n: number,
  ) {
    this.cur = new Array<number>(n).fill(base);
  }
  apply(from: number, op: SandboxChange["op"], value: number, clamp: (v: number) => number = (v) => Math.max(0, v)) {
    for (let m = from; m < this.cur.length; m++) this.cur[m] = clamp(combine(this.cur[m]!, op, value));
  }
  changed(): boolean {
    return this.cur.some((v) => v !== this.base);
  }
  /** × the base each month: exactly 1 where nothing changed. */
  ratios(): number[] {
    return this.cur.map((v) => (v === this.base ? 1 : v / this.base));
  }
}

export interface ChannelOptions {
  bundle: Pick<ProcessBundle, "leadSources" | "churnDrivers">;
  /** The months' edges in working hours: [0, ...monthStarts, H]. */
  bounds: readonly number[];
  startDate: string;
  hoursPerWeek: number;
  /** FTE changes (D4) that were not done as person rows (a person pinned to a step or assigned clients): the capacity channel does them. */
  d4Unhandled: ReadonlySet<string>;
}

export interface ChannelsResult {
  channels: EngineChannels | undefined;
  problems: ChangeProblem[];
}

/** The channels the changes ask for on `model` (the model after the whole-run changes), or undefined when none changes anything. */
export function channelsOf(model: EngineModel, changes: readonly SandboxChange[], o: ChannelOptions): ChannelsResult {
  const problems: ChangeProblem[] = [];
  const n = o.bounds.length - 1;
  const horizon = o.bounds[n]!;
  const starts = o.bounds.slice(1, -1);
  const monthOf = (c: SandboxChange): number | null => {
    if (c.from === undefined) return 0;
    const hour = hoursToDate(o.startDate, c.from.length === 7 ? `${c.from}-01` : c.from, o.hoursPerWeek);
    if (hour >= horizon) return null;
    let month = 0;
    if (hour > 0) while (month < n - 1 && o.bounds[month + 1]! <= hour) month++;
    return month;
  };
  const picked = changes
    .map((c, i) => ({ c, i, m: isChannelChange(c, o.d4Unhandled) ? monthOf(c) : null }))
    .filter((x): x is { c: SandboxChange; i: number; m: number } => x.m !== null)
    .sort((a, b) => a.m - b.m || a.i - b.i);
  if (!picked.length) return { channels: undefined, problems };

  const channels: EngineChannels = { starts };
  const problem = (c: SandboxChange, message: string) => problems.push({ changeId: c.id, message });
  const tracks = new Map<string, Track>();
  const track = (key: string, base: number) => {
    let t = tracks.get(key);
    if (!t) tracks.set(key, (t = new Track(base, n)));
    return t;
  };
  const putRatio = (store: Record<string, number[]> | undefined, key: string, t: Track): Record<string, number[]> | undefined => (t.changed() ? { ...store, [key]: t.ratios() } : store);

  const services = model.services ?? {};
  const people = resolvePeople(model);
  const personFactor = new Map<string, number[]>();
  const personFte = new Map<string, number[]>();
  const priceState = new Map<string, { price: number[]; rl: (number | null)[]; rh: (number | null)[] }>();
  const mixTracks = new Map<string, Track>();
  const driverMonths = new Map<string, ({ chance: number | null; effect: number; months: number } | null)[]>();
  const waitTracks = new Map<string, Track>();
  const reworkTracks = new Map<string, Track>();
  const leadsTotal = new Track(model.leadsPerWeek, n);
  const sourceDelta = new Array<number>(n).fill(0);
  const sources = new Map((o.bundle.leadSources ?? []).map((s) => [s.id, { ...s }]));
  const sourceCur = new Map<string, number[]>();
  const convTrack = new Track(1, n);
  const overheadsTrack = new Track(model.overheadMonthly ?? 0, n);
  const hasMoney = (v: number) => v > 0;
  let leadsTouched = false;

  const priceOf = (sid: string) => {
    let st = priceState.get(sid);
    if (!st) priceState.set(sid, (st = { price: new Array<number>(n).fill(services[sid]!.price), rl: new Array<number | null>(n).fill(null), rh: new Array<number | null>(n).fill(null) }));
    return st;
  };

  for (const { c, m } of picked) {
    const id = c.target ?? "";
    switch (c.lever) {
      case "A1": {
        leadsTouched = true;
        if (c.target === null) {
          if (!(model.leadsPerWeek > 0)) problem(c, "There are no opportunities coming in today, so a change from a month can't be worked out. Use the whole run.");
          else leadsTotal.apply(m, c.op, c.value);
          break;
        }
        const src = sources.get(id);
        if (!src || totalLeads(o.bundle) === null) {
          problem(c, "A lead source in this scenario is no longer there");
          break;
        }
        const cur = sourceCur.get(id) ?? new Array<number>(n).fill(Number(src.volume_week));
        sourceCur.set(id, cur);
        for (let k = m; k < n; k++) cur[k] = Math.max(0, combine(cur[k]!, c.op, c.value));
        break;
      }
      case "A3":
        convTrack.apply(m, "multiply", c.value);
        break;
      case "A5": {
        const sv = services[id];
        if (!sv) {
          problem(c, "A service in this scenario is no longer there");
          break;
        }
        const st = priceOf(id);
        for (let k = m; k < n; k++) {
          st.price[k] = c.value;
          if (c.value > 0) {
            st.rl[k] = (c.params?.low ?? c.value) / c.value;
            st.rh[k] = (c.params?.high ?? c.value) / c.value;
          } else {
            st.rl[k] = null;
            st.rh[k] = null;
          }
        }
        break;
      }
      case "A6": {
        const sv = services[id];
        if (!sv) {
          problem(c, "A service in this scenario is no longer there");
          break;
        }
        let t = mixTracks.get(id);
        if (!t) mixTracks.set(id, (t = new Track(sv.mixShare, n)));
        t.apply(m, c.op, c.value);
        break;
      }
      case "B2":
      case "B5": {
        const all = c.lever === "B5" || c.params?.who === "all";
        const sid = c.target;
        if (sid !== null && !services[sid]) {
          problem(c, "A service in this scenario is no longer there");
          break;
        }
        if (c.lever === "B5") {
          track(`fee:${sid ?? "*"}`, 1).apply(m, "multiply", 1 + c.value);
          break;
        }
        const price = sid !== null ? services[sid]!.price : model.retainer;
        if (!(price > 0)) {
          problem(c, "This fee is 0 today, so a change from a month can't be worked out. Use the whole run.");
          break;
        }
        if (all) {
          const t = track(`fee:${sid ?? "*"}`, 1);
          // On the fee in force (as a factor of today's price): set to the value, multiplied by it, or plus it. A set after an earlier rise
          // is the value itself, not the value times the rise.
          if (c.op === "set") t.apply(m, "set", c.value / price);
          else if (c.op === "multiply") t.apply(m, "multiply", c.value);
          else t.apply(m, "add", c.value / price);
        } else if (sid !== null) {
          const st = priceOf(sid);
          for (let k = m; k < n; k++) {
            const was = st.price[k]!;
            const now = Math.max(0, combine(was, c.op, c.value));
            st.price[k] = now;
          }
        } else {
          const t = track("newFee:*", price);
          t.apply(m, c.op, c.value);
        }
        break;
      }
      case "B3": {
        const sid = c.target;
        if (sid !== null && !services[sid]) {
          problem(c, "A service in this scenario is no longer there");
          break;
        }
        const clampChurn = (v: number) => Math.min(1, Math.max(0, v));
        // Clients in one pool churn at the model's own rate (the "*" factor; per-service churn doesn't reach them), as the whole-run patch does.
        const ids = sid !== null ? [sid] : hasClientRoster(model) ? Object.keys(services) : [];
        if (!ids.length) {
          const t = track("churn:*", model.churnMonthly);
          t.apply(m, c.op, c.value, clampChurn);
          break;
        }
        for (const s of ids) {
          const base = model.clientGroups?.[s]?.churnMonthly ?? services[s]!.churnMonthly;
          if (!(base > 0)) {
            problem(c, "Base churn is 0 for this type today, so a change from a month can't be worked out. Use the whole run.");
            continue;
          }
          track(`churn:${s}`, base).apply(m, c.op, c.value, clampChurn);
        }
        break;
      }
      case "B4": {
        if (!driverExists(model, o.bundle, id) || id === "tenure" || id === "market") {
          problem(c, id === "tenure" || id === "market" ? "Early tenure and market conditions don't have chances." : "A churn driver in this scenario is no longer there");
          break;
        }
        const arr = driverMonths.get(id) ?? new Array<null>(n).fill(null);
        driverMonths.set(id, arr);
        for (let k = m; k < n; k++) arr[k] = { chance: c.params?.chance ?? null, effect: c.value, months: c.params?.months ?? EFFECT_MONTHS_DEFAULT };
        break;
      }
      case "C1": {
        const rid = id.startsWith("@") ? busiestRole(model) : id;
        const role = rid ? model.roles[rid] : undefined;
        if (!rid || !role) {
          problem(c, "A role in this scenario is no longer there");
          break;
        }
        if (!hasMoney(role.cost)) {
          problem(c, "This role costs 0 an hour today, so a change from a month can't be worked out. Use the whole run.");
          break;
        }
        track(`roleCost:${rid}`, role.cost).apply(m, c.op, c.value);
        break;
      }
      case "C2":
        overheadsTrack.apply(m, c.op, c.value);
        break;
      case "D4":
      case "D6": {
        const ids =
          c.lever === "D4"
            ? [id]
            : c.target === null
              ? Object.keys(people)
              : Object.keys(people).filter((pid) => people[pid]!.roles.includes(id));
        if (c.lever === "D6" && c.target !== null && !(id in model.roles)) {
          problem(c, "A role in this scenario is no longer there");
          break;
        }
        for (const pid of ids) {
          const p = people[pid];
          if (!p) {
            problem(c, "Someone in this scenario is no longer on the team");
            continue;
          }
          const f = personFactor.get(pid) ?? new Array<number>(n).fill(1);
          personFactor.set(pid, f);
          if (c.lever === "D6") {
            for (let k = m; k < n; k++) f[k] = f[k]! * c.value;
            continue;
          }
          const base = p.capacity / model.hoursPerWeek;
          if (!(base > 0)) {
            problem(c, "This person has no hours today, so a change from a month can't be worked out.");
            continue;
          }
          const fte = personFte.get(pid) ?? new Array<number>(n).fill(base);
          personFte.set(pid, fte);
          for (let k = m; k < n; k++) {
            const next = Math.min(2, Math.max(0.01, combine(fte[k]!, c.op, c.value)));
            f[k] = f[k]! * (next / fte[k]!);
            fte[k] = next;
          }
        }
        break;
      }
      case "E1":
      case "E2":
      case "E3": {
        const sid = id.startsWith("@") ? heaviestStep(model) : id;
        const step = sid ? model.steps.find((s) => s.id === sid) : undefined;
        if (!sid || !step) {
          problem(c, "A step in this scenario is no longer there");
          break;
        }
        if (c.lever === "E1") {
          if (!(step.work > 0)) {
            problem(c, "This step takes no hands-on time today, so a change from a month can't be worked out. Use the whole run.");
            break;
          }
          track(`work:${sid}`, step.work).apply(m, c.op, c.value);
        } else if (c.lever === "E2") {
          let t = waitTracks.get(sid);
          if (!t) waitTracks.set(sid, (t = new Track(step.wait, n)));
          t.apply(m, c.op, c.value);
        } else {
          let t = reworkTracks.get(sid);
          if (!t) reworkTracks.set(sid, (t = new Track(step.rework, n)));
          t.apply(m, c.op, c.value, (v) => Math.min(MAX_REWORK, Math.max(0, v)));
        }
        break;
      }
    }
  }

  // Write the arrays.
  const pick = (prefix: string, into: (key: string, t: Track) => void) => {
    for (const [k, t] of tracks) if (k.startsWith(prefix)) into(k.slice(prefix.length), t);
  };
  if (leadsTouched) {
    const q = totalLeads(o.bundle);
    const arr = leadsTotal.ratios().map((r, k) => {
      let delta = 0;
      for (const [sid, cur] of sourceCur) {
        const s = sources.get(sid)!;
        delta += (cur[k]! - Number(s.volume_week)) * Number(s.conversion_to_qualified);
      }
      sourceDelta[k] = delta;
      return q && q > 0 && delta !== 0 ? (r * q + delta) / q : r;
    });
    void sourceLeads;
    if (arr.some((v) => v !== 1)) channels.leads = arr;
  }
  if (convTrack.changed()) channels.conv = convTrack.cur.slice();
  pick("fee:", (k, t) => (channels.fee = putRatio(channels.fee, k, t)));
  pick("churn:", (k, t) => (channels.churn = putRatio(channels.churn, k, t)));
  pick("roleCost:", (k, t) => (channels.roleCost = putRatio(channels.roleCost, k, t)));
  pick("work:", (k, t) => (channels.work = putRatio(channels.work, k, t)));
  const newFee = tracks.get("newFee:*");
  if (newFee?.changed()) channels.newFee = { ...channels.newFee, "*": newFee.ratios() };
  for (const [sid, st] of priceState) {
    const P = services[sid]!.price;
    const ratios = st.price.map((v) => (v === P ? 1 : P > 0 ? v / P : 0));
    if (ratios.some((v) => v !== 1)) channels.newFee = { ...channels.newFee, [sid]: ratios };
    if (st.rl.some((v) => v !== null)) channels.priceRange = { ...channels.priceRange, [sid]: st.rl.map((l, k) => (l === null ? null : { low: l * P, high: st.rh[k]! * P })) };
  }
  for (const [sid, t] of mixTracks) if (t.changed()) channels.mix = { ...channels.mix, [sid]: t.cur.slice() };
  for (const [sid, t] of waitTracks) if (t.changed()) channels.wait = { ...channels.wait, [sid]: t.cur.slice() };
  for (const [sid, t] of reworkTracks) if (t.changed()) channels.rework = { ...channels.rework, [sid]: t.cur.slice() };
  for (const [id, arr] of driverMonths) channels.drivers = { ...channels.drivers, [id]: arr };
  if (overheadsTrack.changed()) {
    const base = overheadsTrack.base;
    // From a base of nothing no factor can raise it: the model carries the highest month and the channel the share of it (the caller sets overheadMonthly).
    channels.overheads = base > 0 ? overheadsTrack.ratios() : overheadsTrack.cur.map((v) => v / Math.max(...overheadsTrack.cur));
  }
  for (const [pid, f] of personFactor) {
    if (f.some((v) => v !== 1)) channels.capacity = { ...channels.capacity, [pid]: f };
  }
  const empty = Object.keys(channels).length === 1;
  return { channels: empty ? undefined : channels, problems };
}

/** The overheads a month the model must carry for a channel that raises them from nothing (the highest month), or null when it needn't. */
export function overheadsCarried(model: EngineModel, channels: EngineChannels | undefined, changes: readonly SandboxChange[]): number | null {
  if (!channels?.overheads || (model.overheadMonthly ?? 0) > 0) return null;
  let cur = 0;
  let max = 0;
  for (const c of changes) if (c.lever === "C2") max = Math.max(max, (cur = Math.max(0, combine(cur, c.op, c.value))));
  return max > 0 ? max : null;
}
