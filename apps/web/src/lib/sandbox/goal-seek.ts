// Goal seek's search (docs/plans/sandbox-p5-brief.md section 9): one lever over a range, one target, the fewest runs that find where the target
// starts to be met. A pure state machine: it never runs anything. The caller asks `nextProbes` which values to try, runs each (a whole scenario
// run with the lever set to it, read through a measure), and hands the number back with `addResult`; `answer` says what is known so far.
//
//   1. Both ends of the range at once (2 runs). Both meet the target: already met, the least change is the end nearest today's value.
//      Neither: not reachable in this range, and the closest end is named. Otherwise the target flips inside the range.
//   2. Bisection, one probe at a time, between a value that fails and one that meets, until the two are one step apart (whole numbers: 1;
//      other levers: the lever's own step). At most 8 runs in all, so a search over 0 to 10 more people is at most 4 more after the ends.
//   3. A monotonicity check: the probes in order of the lever must move one way from the low end's number to the high end's, within a small
//      tolerance (1% of the span between the ends, 0.5 percentage point for a share). Runs share a seed and a warm-up, so noise is small but not
//      zero. If the check fails the answer still stands, flagged, with every probe listed.

/** The most runs one search makes (the two ends and up to six more). */
export const MAX_RUNS = 8;

export interface SeekSpec {
  /** The lever's range to search, low to high, and the smallest step worth telling apart. */
  lo: number;
  hi: number;
  step: number;
  /** The lever takes whole numbers only (people): the search stops when the two sides are 1 apart. */
  whole: boolean;
  /** The lever's value today: "already met" names the end nearest it. */
  today: number;
  /** Whether a measured number meets the target. */
  meets: (value: number) => boolean;
  /** How far a number is from meeting it (0 when it does), to name the closest end when neither meets. */
  gap: (value: number) => number;
  /** The measure is a share (0 to 1), so a rise or fall of under half a percentage point is noise, not movement. */
  share?: boolean;
}

export interface Probe {
  x: number;
  /** The measured number; null when the run could not measure it (no costs, nobody in the role). */
  value: number | null;
  meets: boolean;
}

export interface SeekState {
  spec: SeekSpec;
  probes: Probe[];
  /** The values asked for and not answered yet. */
  pending: number[];
}

export type Monotone = { ok: true } | { ok: false; between: [number, number]; direction: "rose" | "fell" };

export type SeekAnswer =
  | { kind: "running"; runs: number }
  /** Every value in the range meets the target: nothing to change. `x` is the end nearest today's value. */
  | { kind: "already"; x: number; monotone: Monotone }
  /** No value in the range meets it. `closest` is the probe nearest meeting it. */
  | { kind: "unreachable"; closest: Probe; monotone: Monotone }
  /** The target is met from `x` (on the `side` of the range), and not at `failsAt`, one step away or the nearest probe that fails. */
  | { kind: "boundary"; x: number; failsAt: number; side: "high" | "low"; monotone: Monotone }
  | { kind: "cannot"; why: string };

export function startSearch(spec: SeekSpec): SeekState {
  return { spec, probes: [], pending: [] };
}

const unit = (spec: SeekSpec) => (spec.whole ? 1 : spec.step);
const byX = (s: SeekState) => [...s.probes].sort((a, b) => a.x - b.x);

/** Round to the lever's grid, counted from the low end. */
function snap(spec: SeekSpec, x: number): number {
  const u = unit(spec);
  const n = Math.round((x - spec.lo) / u);
  return Math.min(spec.hi, Math.max(spec.lo, +(spec.lo + n * u).toFixed(10)));
}

/** The meeting side and the failing side once the ends are known, or null while they aren't or don't flip. */
function bracket(s: SeekState): { good: number; bad: number } | null {
  const lo = s.probes.find((p) => p.x === s.spec.lo);
  const hi = s.probes.find((p) => p.x === s.spec.hi);
  if (!lo || !hi || lo.meets === hi.meets) return null;
  let good = lo.meets ? lo.x : hi.x;
  let bad = lo.meets ? hi.x : lo.x;
  // Tighten with the probes between: the nearest meeting value to the failing side and the nearest failing value to the meeting side.
  for (const p of byX(s)) {
    if (p.x <= Math.min(good, bad) || p.x >= Math.max(good, bad)) continue;
    if (p.meets) good = p.x;
    else bad = p.x;
  }
  return { good, bad };
}

/** The values to run next: both ends first, then the middle of what is left, one at a time; empty when finished or while waiting. */
export function nextProbes(s: SeekState): number[] {
  if (s.pending.length) return [];
  const { lo, hi } = s.spec;
  if (!s.probes.length) return lo === hi ? [lo] : [lo, hi];
  const b = bracket(s);
  if (!b || s.probes.length >= MAX_RUNS) return [];
  if (Math.abs(b.good - b.bad) <= unit(s.spec) + 1e-9) return [];
  const mid = snap(s.spec, (b.good + b.bad) / 2);
  // A middle that falls on a side already known (a coarse grid) means the two are as close as the grid allows.
  if (mid === b.good || mid === b.bad) return [];
  return [mid];
}

/** Record that the values `xs` were asked for (call with the result of `nextProbes`); `addResult` clears them. */
export function markAsked(s: SeekState, xs: readonly number[]): SeekState {
  return { ...s, pending: [...s.pending, ...xs] };
}

export function addResult(s: SeekState, x: number, value: number | null): SeekState {
  const meets = value !== null && s.spec.meets(value);
  return { ...s, probes: [...s.probes.filter((p) => p.x !== x), { x, value, meets }], pending: s.pending.filter((p) => p !== x) };
}

/** Whether the numbers move one way from the low end to the high end, within the tolerance. */
export function monotone(s: SeekState): Monotone {
  const probes = byX(s).filter((p) => p.value !== null);
  if (probes.length < 3) return { ok: true };
  const first = probes[0]!.value!;
  const last = probes[probes.length - 1]!.value!;
  const span = Math.abs(last - first);
  const tol = s.spec.share ? 0.005 : span * 0.01;
  if (span <= tol) return { ok: true };
  const up = last > first;
  for (let i = 1; i < probes.length; i++) {
    const move = probes[i]!.value! - probes[i - 1]!.value!;
    if (up ? move < -tol : move > tol) return { ok: false, between: [probes[i - 1]!.x, probes[i]!.x], direction: up ? "fell" : "rose" };
  }
  return { ok: true };
}

export function answer(s: SeekState): SeekAnswer {
  const { spec } = s;
  const lo = s.probes.find((p) => p.x === spec.lo);
  const hi = s.probes.find((p) => p.x === spec.hi);
  if (!lo || (!hi && spec.lo !== spec.hi)) return { kind: "running", runs: s.probes.length };
  const ends = [lo, ...(hi && hi !== lo ? [hi] : [])];
  if (ends.some((p) => p.value === null)) return { kind: "cannot", why: "The scenario has no number for this target (for example no costs, or nobody in that role)." };
  const mono = monotone(s);
  if (ends.every((p) => p.meets)) {
    const nearest = [...ends].sort((a, b) => Math.abs(a.x - spec.today) - Math.abs(b.x - spec.today) || a.x - b.x)[0]!;
    return { kind: "already", x: nearest.x, monotone: mono };
  }
  if (ends.every((p) => !p.meets)) {
    const closest = [...s.probes].filter((p) => p.value !== null).sort((a, b) => spec.gap(a.value!) - spec.gap(b.value!) || a.x - b.x)[0]!;
    return { kind: "unreachable", closest, monotone: mono };
  }
  const b = bracket(s)!;
  const done = nextProbes({ ...s, pending: [] }).length === 0;
  if (!done) return { kind: "running", runs: s.probes.length };
  return { kind: "boundary", x: b.good, failsAt: b.bad, side: b.good > b.bad ? "high" : "low", monotone: mono };
}

/** How many runs a search over this spec could take at most, for "about N runs" before it starts. */
export function maxRunsFor(spec: Pick<SeekSpec, "lo" | "hi" | "step" | "whole">): number {
  const width = Math.abs(spec.hi - spec.lo);
  const steps = Math.max(1, Math.ceil(width / (spec.whole ? 1 : spec.step) - 1e-9));
  return Math.min(MAX_RUNS, 2 + Math.ceil(Math.log2(steps)));
}

