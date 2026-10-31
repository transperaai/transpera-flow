// Team time and a new starter's ramp (docs/adr/0022-capacity-inputs.md; P2 item 5).
//
// A person's effective capacity in a month is their capacity × `availableShare(person, month, monthHours)`. The engine already
// has one way to change a person's hours month by month: the capacity channel (channels.ts), which the run reads at each month
// start. This composes with it rather than adding a second path: the shares become a capacity channel for the people who have
// one (× the model's own capacity channel for that person, when it has one), on the months the run already uses. Everything
// downstream (their hours for work, their utilisation's denominator, the roles' hours available) follows from that.
//
// Paid hours are not reduced: team time and a ramp are hours someone is paid for and doesn't spend on client work. The run
// asks `availabilityBase` for the model's own channels and costs paid hours from those alone.
//
// A model where nobody has team time or a ramp (or where every share is 1) is returned as it is, so it runs as before.

import { availableShare, CAPACITY_WEEKS_PER_MONTH } from "./capacity-inputs";
import type { EngineChannels, EngineModel } from "./model";

/** The model's own channels behind an injected capacity channel, by the channels object the run reads (for paid hours). */
const original = new WeakMap<EngineChannels, EngineChannels | undefined>();

/** Whether `ch` was built here (it carries team time or ramp), and the model's own channels it was built on. */
export function availabilityBase(ch: EngineChannels): { base: EngineChannels | undefined } | null {
  return original.has(ch) ? { base: original.get(ch) } : null;
}

const memo = new WeakMap<EngineModel, Map<string, EngineModel>>();

/** The last value repeated out to `n` months. */
const expandTo = (a: readonly number[], n: number): number[] => (a.length >= n ? a.slice(0, n) : [...a, ...new Array<number>(n - a.length).fill(a[a.length - 1]!)]);

/**
 * The model with each person's team time and ramp as a capacity channel, or the model itself when nobody has either. The months
 * are the model's channels' months when it has channels, else `monthStarts` (the run's, when it asks for calendar months), else
 * 52/12 weeks from the start. Memoised, so a run's replications share one model.
 */
export function withAvailability(model: EngineModel, monthStarts?: readonly number[]): EngineModel {
  const people = model.people;
  // (A model that already went through here, as `simulate` hands one to `runOnce`, is done.)
  if (model.channels && original.has(model.channels)) return model;
  if (!people || !Object.values(people).some((p) => (p.reservedShare !== undefined && p.reservedShare > 0) || (p.ramp !== undefined && p.ramp.length > 0))) return model;
  const H = model.horizonWeeks * model.hoursPerWeek;
  const monthHours = CAPACITY_WEEKS_PER_MONTH * model.hoursPerWeek;
  let starts: number[];
  if (model.channels) starts = model.channels.starts;
  else if (monthStarts) starts = [...new Set(monthStarts.filter((t) => Number.isFinite(t) && t > 0 && t < H))].sort((a, b) => a - b);
  else starts = Array.from({ length: Math.max(1, Math.ceil(H / monthHours - 1e-9)) - 1 }, (_, k) => (k + 1) * monthHours);
  const key = starts.join(",");
  const hit = memo.get(model)?.get(key);
  if (hit) return hit;

  const n = starts.length + 1;
  const base = model.channels;
  const capacity: Record<string, number[]> = { ...base?.capacity };
  let any = false;
  for (const [id, p] of Object.entries(people)) {
    const shares = Array.from({ length: n }, (_, m) => availableShare(p, m, monthHours));
    if (shares.every((v) => v === 1)) continue;
    const own = capacity[id];
    capacity[id] = own ? expandTo(own, n).map((f, m) => f * shares[m]!) : shares;
    any = true;
  }
  let out = model;
  if (any) {
    const channels: EngineChannels = { ...base, starts, capacity };
    original.set(channels, base);
    out = { ...model, channels };
  }
  let byKey = memo.get(model);
  if (!byKey) memo.set(model, (byKey = new Map()));
  byKey.set(key, out);
  return out;
}
