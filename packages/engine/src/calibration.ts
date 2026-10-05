// Calibration from historical data (docs/PRD.md §6.6; issue #41, part 1).
//
// Replaces estimates with what actually happened. The input is a step log: one
// row per item (a deal, a job, a report) per step it went through, with when
// that visit started and finished, and optionally the hands-on hours and the
// lead source. From it this proposes, for one process:
//
//   work      hands-on hours per task step (mean of `hours`) and their spread
//             (a lognormal's coefficient of variation, sd / mean);
//   wait      the wait at a step nobody works on (a wait step, or a step with no
//             role such as "Client decision"): finished − started, in working
//             hours. At a step someone works on, whether `finished` includes the
//             wait after the work is not known, so no wait is proposed there;
//   rework    the share of a task step's visits that were done again straight
//             away (the same step logged twice in a row for an item);
//   routing   the odds of each way out of a step with more than one, from the
//             step each item was logged at next;
//   arrivals  qualified leads a week per lead source, from when each item first
//             appears, with the workspace's seasonality taken out.
//
// Queue time is never proposed: the engine simulates it from capacity, so the
// time between one step finishing and the next starting is not an input.
// Calendar time becomes working hours at the workspace's hours per week (the
// engine's clock: one simulated week is `hoursPerWeek` hours).
//
// Every proposal carries its sample size. Fewer than `minSample` observations
// (default 10) are flagged and not proposed. Nothing here writes anything: the
// caller shows the proposals beside the current values and a person picks
// which to apply. Pure and deterministic: no I/O, no clock, no randomness.

export const CALIBRATION_MIN_SAMPLE = 10;
/** Arrivals need at least this many weeks of log to be measured. */
export const CALIBRATION_MIN_WEEKS = 4;

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Where a current value came from (docs/PRD.md §5 provenance). */
export type CalibrationValueSource = "estimated" | "entered" | "measured";

export type CalibrationStepKind = "task" | "wait" | "decision" | "subprocess" | "group" | "start" | "end";

export interface CalibrationStep {
  id: string;
  name: string;
  kind: CalibrationStepKind;
  /** The group the step sits in, if any. */
  parent?: string | null;
  /** A group's first step. */
  entry?: string | null;
  /** Holds a child process (its steps are not in this log). */
  holder?: boolean;
  /** Whether someone works on it (it has a role or a pinned person). Only steps nobody works on get a wait proposed. */
  worked: boolean;
  workHours: number;
  workDist: string;
  /** The lognormal spread now, if one is set. */
  workCv: number | null;
  waitHours: number;
  waitDist: string;
  waitCv: number | null;
  rework: number;
  /** Where each current value came from. `routing` is the step's branch odds. */
  sources: { work: CalibrationValueSource; wait: CalibrationValueSource; rework: CalibrationValueSource; routing: CalibrationValueSource };
}

export interface CalibrationEdge {
  id: string;
  from: string;
  to: string;
  probability: number | null;
}

export interface CalibrationLeadSource {
  id: string;
  name: string;
  volumeWeek: number;
  /** Share of its leads that qualify (0-1); the process sees only qualified ones. */
  conversion: number;
  source: CalibrationValueSource;
}

/** One row of the step log. Times are epoch milliseconds. */
export interface StepLogRow {
  item: string;
  step: string;
  started: number;
  finished: number | null;
  /** Hands-on hours, if logged. */
  hours: number | null;
  /** Lead source name, if logged. */
  source: string | null;
}

export interface CalibrationInput {
  steps: readonly CalibrationStep[];
  edges: readonly CalibrationEdge[];
  rows: readonly StepLogRow[];
  hoursPerWeek: number;
  /** The lead sources to measure arrivals for; omit (or null) when the process is not where leads arrive. */
  leadSources?: readonly CalibrationLeadSource[] | null;
  /** Seasonality multipliers January to December (1 = normal); omitted means none. */
  seasonality?: readonly number[];
  minSample?: number;
}

export type CalibrationKind = "work" | "wait" | "rework" | "routing" | "arrivals";

/** A way out of a step, for a routing proposal. */
export interface CalibrationBranch {
  edgeId: string;
  to: string;
  toName: string;
  current: number | null;
  proposed: number | null;
  /** Items seen taking it. */
  n: number;
}

export interface CalibrationProposal {
  /** Stable per process and kind: `work:<stepId>`, `routing:<stepId>`, `arrivals:<leadSourceId>`. */
  key: string;
  kind: CalibrationKind;
  target: { table: "steps" | "lead_sources"; id: string };
  /** The step or lead source, by name. */
  subject: string;
  /** Observations the proposal rests on. */
  n: number;
  /** Whether `n` reaches the minimum sample; when false nothing is proposed. */
  enough: boolean;
  /** Where the current value came from. */
  currentSource: CalibrationValueSource;
  /** The current value: hours (work, wait), a share (rework), leads a week (arrivals); null for routing. */
  current: number | null;
  /** The proposed value in the same unit, or null when not proposed. */
  proposed: number | null;
  /** Spread (lognormal CV) now and proposed, for work and wait. */
  currentCv?: number | null;
  proposedCv?: number | null;
  /** Routing only: each way out, now and proposed. */
  branches?: CalibrationBranch[];
  /** Whether applying would change anything. */
  changed: boolean;
  /** Why nothing is proposed, when nothing is (too few, a branch that can't be seen). */
  blocked: string | null;
  /** What was measured, in plain words. */
  note: string;
  /** The columns to write and what they hold now (compare-and-set); null when nothing is proposed. */
  set: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
}

export interface CalibrationResult {
  rows: number;
  items: number;
  /** The log's span, epoch ms, and in weeks. */
  window: { from: number; to: number; weeks: number } | null;
  /** Step names in the log that match no step of the process, with how many rows each. */
  unmatchedSteps: { name: string; rows: number }[];
  /** Lead source names in the log that match no lead source, with how many items each. */
  unmatchedSources: { name: string; items: number }[];
  minSample: number;
  proposals: CalibrationProposal[];
}

// ---------------------------------------------------------------------------

const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function meanAndCv(xs: readonly number[]): { mean: number; cv: number } {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2 || mean <= 0) return { mean, cv: 0 };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, cv: Math.sqrt(variance) / mean };
}

/** Round probabilities to 3 places so they still add up to 1 (the largest absorbs the rounding). */
function roundShares(shares: number[]): number[] {
  const out = shares.map((p) => round(p, 3));
  const diff = round(1 - out.reduce((s, p) => s + p, 0), 3);
  if (diff !== 0 && out.length) {
    let big = 0;
    for (let i = 1; i < out.length; i++) if (out[i]! > out[big]!) big = i;
    out[big] = round(out[big]! + diff, 3);
  }
  return out;
}

const fmt = (x: number, dp = 1) => (Number.isInteger(round(x, dp)) ? String(round(x, dp)) : round(x, dp).toFixed(dp));

const CV_MIN = 0.05;
const CV_MAX = 3;

/** Weeks of exposure from `from` to `to`, each calendar month weighted by its seasonality multiplier. */
function seasonalWeeks(from: number, to: number, seasonality: readonly number[] | undefined): number {
  if (!seasonality || seasonality.length !== 12) return (to - from) / WEEK_MS;
  let t = from;
  let weeks = 0;
  while (t < to) {
    const d = new Date(t);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const end = Math.min(next, to);
    weeks += ((end - t) / WEEK_MS) * (seasonality[d.getUTCMonth()] ?? 1);
    t = end;
  }
  return weeks;
}

/**
 * Proposed values for one process from its step log. Steps are matched by
 * name (case and spacing ignored); a name two steps share matches neither.
 */
export function calibrate(input: CalibrationInput): CalibrationResult {
  const minSample = Math.max(1, Math.floor(input.minSample ?? CALIBRATION_MIN_SAMPLE));
  const steps = input.steps;
  const byId = new Map(steps.map((s) => [s.id, s]));

  // Match names to steps.
  const byName = new Map<string, string | null>();
  for (const s of steps) {
    const k = norm(s.name);
    byName.set(k, byName.has(k) ? null : s.id);
  }
  const unmatched = new Map<string, { name: string; rows: number }>();
  const visits: { item: string; step: string; row: StepLogRow; order: number }[] = [];
  input.rows.forEach((row, order) => {
    const id = byName.get(norm(row.step));
    if (!id) {
      const k = norm(row.step);
      const u = unmatched.get(k) ?? { name: row.step.trim(), rows: 0 };
      u.rows++;
      unmatched.set(k, u);
      return;
    }
    visits.push({ item: row.item, step: id, row, order });
  });

  // Each item's visits in time order (ties keep the log's order).
  const byItem = new Map<string, typeof visits>();
  for (const v of visits) {
    const list = byItem.get(v.item) ?? [];
    list.push(v);
    byItem.set(v.item, list);
  }
  for (const list of byItem.values()) list.sort((a, b) => a.row.started - b.row.started || a.order - b.order);
  const items = [...byItem.keys()].sort();

  let from = Infinity;
  let to = -Infinity;
  for (const r of input.rows) {
    from = Math.min(from, r.started);
    to = Math.max(to, r.started, r.finished ?? r.started);
  }
  const window = Number.isFinite(from) && Number.isFinite(to) ? { from, to, weeks: (to - from) / WEEK_MS } : null;

  const logged = new Set(visits.map((v) => v.step));
  const proposals: CalibrationProposal[] = [];
  const tooFew = (n: number) => `Too few to measure: ${n} of the ${minSample} needed.`;

  // Work: hands-on hours of task steps someone works on.
  for (const s of steps) {
    if (s.kind !== "task" || !s.worked || s.holder || !logged.has(s.id)) continue;
    const hours = visits.filter((v) => v.step === s.id && v.row.hours !== null && v.row.hours >= 0).map((v) => v.row.hours!);
    if (!hours.length) continue;
    const n = hours.length;
    const enough = n >= minSample;
    const sorted = [...hours].sort((a, b) => a - b);
    const { mean, cv } = meanAndCv(hours);
    const proposed = enough ? round(mean, 2) : null;
    const proposedCv = enough ? round(Math.min(CV_MAX, Math.max(CV_MIN, cv)), 2) : null;
    const currentCv = s.workDist === "lognormal" ? s.workCv : null;
    const changed = enough && (proposed !== round(s.workHours, 2) || s.workDist !== "lognormal" || proposedCv !== (currentCv === null ? null : round(currentCv, 2)));
    proposals.push({
      key: `work:${s.id}`,
      kind: "work",
      target: { table: "steps", id: s.id },
      subject: s.name,
      n,
      enough,
      currentSource: s.sources.work,
      current: s.workHours,
      proposed,
      currentCv,
      proposedCv,
      changed,
      blocked: enough ? null : tooFew(n),
      note: `Average of ${n} logged visit${n === 1 ? "" : "s"}: half took ${fmt(quantile(sorted, 0.25))} to ${fmt(quantile(sorted, 0.75))} hours, one in ten over ${fmt(quantile(sorted, 0.9))}.`,
      set: enough ? { work_hours: proposed, work_dist: "lognormal", work_params: { cv: proposedCv } } : null,
      before: enough ? { work_hours: s.workHours, work_dist: s.workDist, work_params_cv: s.workCv } : null,
    });
  }

  // Wait: elapsed time at steps nobody works on, in working hours.
  for (const s of steps) {
    if (!(s.kind === "wait" || ((s.kind === "task" || s.kind === "decision") && !s.worked)) || s.holder || !logged.has(s.id)) continue;
    const waits = visits
      .filter((v) => v.step === s.id && v.row.finished !== null && v.row.finished >= v.row.started)
      .map((v) => ((v.row.finished! - v.row.started) / WEEK_MS) * input.hoursPerWeek);
    if (!waits.length) continue;
    const n = waits.length;
    const enough = n >= minSample;
    const sorted = [...waits].sort((a, b) => a - b);
    const { mean, cv } = meanAndCv(waits);
    const proposed = enough ? round(mean, 2) : null;
    const proposedCv = enough ? round(Math.min(CV_MAX, Math.max(CV_MIN, cv)), 2) : null;
    const currentCv = s.waitDist === "lognormal" ? s.waitCv : null;
    const changed = enough && (proposed !== round(s.waitHours, 2) || s.waitDist !== "lognormal" || proposedCv !== (currentCv === null ? null : round(currentCv, 2)));
    proposals.push({
      key: `wait:${s.id}`,
      kind: "wait",
      target: { table: "steps", id: s.id },
      subject: s.name,
      n,
      enough,
      currentSource: s.sources.wait,
      current: s.waitHours,
      proposed,
      currentCv,
      proposedCv,
      changed,
      blocked: enough ? null : tooFew(n),
      note: `Average of ${n} logged wait${n === 1 ? "" : "s"}, in working hours at ${fmt(input.hoursPerWeek)} hours a week: half lasted ${fmt(quantile(sorted, 0.25))} to ${fmt(quantile(sorted, 0.75))} hours.`,
      set: enough ? { wait_hours: proposed, wait_dist: "lognormal", wait_params: { cv: proposedCv } } : null,
      before: enough ? { wait_hours: s.waitHours, wait_dist: s.waitDist, wait_params_cv: s.waitCv } : null,
    });
  }

  // Rework: the same task step logged twice in a row for an item.
  for (const s of steps) {
    if (s.kind !== "task" || !s.worked || s.holder || !logged.has(s.id)) continue;
    let n = 0;
    let redo = 0;
    for (const list of byItem.values()) {
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.step !== s.id) continue;
        n++;
        if (list[i + 1]?.step === s.id) redo++;
      }
    }
    const enough = n >= minSample;
    const proposed = enough ? round(redo / n, 3) : null;
    proposals.push({
      key: `rework:${s.id}`,
      kind: "rework",
      target: { table: "steps", id: s.id },
      subject: s.name,
      n,
      enough,
      currentSource: s.sources.rework,
      current: s.rework,
      proposed,
      changed: enough && proposed !== round(s.rework, 3),
      blocked: enough ? null : tooFew(n),
      note: `${redo} of ${n} logged visits were done again straight away.`,
      set: enough ? { rework_rate: proposed } : null,
      before: enough ? { rework_rate: s.rework } : null,
    });
  }

  proposals.push(...routingProposals(input, byId, logged, byItem, minSample));
  if (input.leadSources && window) proposals.push(...arrivalProposals(input, byItem, window, minSample));

  const unmatchedSources = input.leadSources && window ? unmatchedSourceNames(input.leadSources, byItem) : [];
  return {
    rows: input.rows.length,
    items: items.length,
    window,
    unmatchedSteps: [...unmatched.values()].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name)),
    unmatchedSources,
    minSample,
    proposals,
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Visits = Map<string, { step: string; row: StepLogRow }[]>;

function routingProposals(
  input: CalibrationInput,
  byId: Map<string, CalibrationStep>,
  logged: Set<string>,
  byItem: Visits,
  minSample: number,
): CalibrationProposal[] {
  const out = new Map<string, CalibrationEdge[]>();
  for (const e of input.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }

  // Where an item is once it reaches a step: a group sends it to its first step.
  const arrive = (id: string): string => {
    const s = byId.get(id);
    return s?.kind === "group" && s.entry && byId.has(s.entry) ? arrive(s.entry) : id;
  };
  // Where an item can go after a step: along its edges, or, with none, out of the group it sits in.
  const after = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const edges = out.get(id);
    if (edges?.length) return edges.map((e) => arrive(e.to));
    const parent = byId.get(id)?.parent;
    return parent && byId.has(parent) ? after(parent, seen) : [];
  };
  const isEnd = (id: string) => byId.get(id)?.kind === "end";
  // The first logged steps reached from `start` through steps nobody logs (decisions, unlogged ends stop the search).
  const firstLogged = (start: string, avoid: string | null): Set<string> => {
    const found = new Set<string>();
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || id === avoid) continue;
      seen.add(id);
      if (logged.has(id)) {
        found.add(id);
        continue;
      }
      if (isEnd(id)) continue;
      for (const n of after(id)) stack.push(n);
    }
    return found;
  };
  // Steps nobody logs that an item can pass straight after `start` is logged.
  const unloggedAfter = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = after(start);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || logged.has(id)) continue;
      seen.add(id);
      if (isEnd(id)) continue;
      for (const n of after(id)) stack.push(n);
    }
    return seen;
  };

  const proposals: CalibrationProposal[] = [];
  for (const step of input.steps) {
    const edges = out.get(step.id);
    if (!edges || edges.length < 2) continue;
    const X = step.id;
    const reach = edges.map((e) => firstLogged(arrive(e.to), null));
    const xLogged = logged.has(X);
    const from = xLogged ? new Set([X]) : new Set([...logged].filter((a) => unloggedAfter(a).has(X)));
    if (!from.size) continue;
    const counts = edges.map(() => 0);
    const bypass = new Map<string, Set<string>>();
    for (const list of byItem.values()) {
      for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i]!.step;
        const b = list[i + 1]!.step;
        if (a === b || !from.has(a)) continue;
        const hit = reach.flatMap((r, j) => (r.has(b) ? [j] : []));
        if (hit.length !== 1) continue;
        if (!xLogged) {
          // Only when every way from a to b passes this step.
          let other = bypass.get(a);
          if (!other) {
            other = new Set<string>();
            for (const n of after(a)) for (const f of firstLogged(n, X)) other.add(f);
            bypass.set(a, other);
          }
          if (other.has(b)) continue;
        }
        counts[hit[0]!]!++;
      }
    }
    const n = counts.reduce((s, c) => s + c, 0);
    const unseen = edges.filter((_, j) => reach[j]!.size === 0).map((e) => byId.get(e.to)!.name);
    const enough = n >= minSample;
    const blocked = unseen.length
      ? `Can't count the way to ${unseen.join(" or ")}: nothing after it is in the log. Log the end steps too (for example "Lost", with the date).`
      : enough
        ? null
        : `Too few to measure: ${n} of the ${minSample} needed.`;
    const shares = !blocked ? roundShares(counts.map((c) => c / n)) : null;
    const branches: CalibrationBranch[] = edges.map((e, j) => ({
      edgeId: e.id,
      to: e.to,
      toName: byId.get(e.to)!.name,
      current: e.probability,
      proposed: shares ? shares[j]! : null,
      n: counts[j]!,
    }));
    const changed = Boolean(shares) && branches.some((b) => b.current === null || round(b.current, 3) !== b.proposed);
    proposals.push({
      key: `routing:${X}`,
      kind: "routing",
      target: { table: "steps", id: X },
      subject: step.name,
      n,
      enough: enough && !unseen.length,
      currentSource: step.sources.routing,
      current: null,
      proposed: null,
      branches,
      changed,
      blocked,
      note: `${n} item${n === 1 ? "" : "s"} seen going on from ${step.name}: ${branches.map((b) => `${b.n} to ${b.toName}`).join(", ")}.`,
      set: shares ? { probabilities: Object.fromEntries(branches.map((b) => [b.edgeId, b.proposed])) } : null,
      before: shares ? { probabilities: Object.fromEntries(branches.map((b) => [b.edgeId, b.current])) } : null,
    });
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Arrivals
// ---------------------------------------------------------------------------

/** Each item's lead source name (the first one logged for it), or null. */
function itemSources(byItem: Visits): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [item, list] of byItem) out.set(item, list.find((v) => v.row.source && v.row.source.trim())?.row.source?.trim() ?? null);
  return out;
}

function unmatchedSourceNames(sources: readonly CalibrationLeadSource[], byItem: Visits): { name: string; items: number }[] {
  const known = new Set(sources.map((s) => norm(s.name)));
  const counts = new Map<string, { name: string; items: number }>();
  for (const name of itemSources(byItem).values()) {
    if (!name || known.has(norm(name))) continue;
    const c = counts.get(norm(name)) ?? { name, items: 0 };
    c.items++;
    counts.set(norm(name), c);
  }
  return [...counts.values()].sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
}

function arrivalProposals(
  input: CalibrationInput,
  byItem: Visits,
  window: { from: number; to: number; weeks: number },
  minSample: number,
): CalibrationProposal[] {
  const sources = input.leadSources ?? [];
  if (!sources.length) return [];
  const named = itemSources(byItem);
  const anyNamed = [...named.values()].some((n) => n !== null);
  const counts = new Map(sources.map((s) => [s.id, 0]));
  const idByName = new Map(sources.map((s) => [norm(s.name), s.id]));
  for (const name of named.values()) {
    // With no source column and one lead source, every item is that source's.
    const id = name ? idByName.get(norm(name)) : !anyNamed && sources.length === 1 ? sources[0]!.id : undefined;
    if (id) counts.set(id, counts.get(id)! + 1);
  }
  if (!anyNamed && sources.length > 1) return [];
  const exposure = seasonalWeeks(window.from, window.to, input.seasonality);
  const longEnough = window.weeks >= CALIBRATION_MIN_WEEKS;
  return [...sources]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s): CalibrationProposal => {
      const n = counts.get(s.id) ?? 0;
      const enough = n >= minSample && longEnough && exposure > 0;
      const qualified = exposure > 0 ? n / exposure : 0;
      const proposed = enough ? round(s.conversion > 0 ? qualified / s.conversion : qualified, 2) : null;
      const seasonal = input.seasonality?.some((m) => m !== 1) ?? false;
      return {
        key: `arrivals:${s.id}`,
        kind: "arrivals",
        target: { table: "lead_sources", id: s.id },
        subject: s.name,
        n,
        enough,
        currentSource: s.source,
        current: s.volumeWeek,
        proposed,
        changed: enough && proposed !== round(s.volumeWeek, 2),
        blocked: !longEnough
          ? `The log covers ${fmt(window.weeks)} weeks; at least ${CALIBRATION_MIN_WEEKS} are needed.`
          : enough
            ? null
            : `Too few to measure: ${n} of the ${minSample} needed.`,
        note:
          `${n} item${n === 1 ? "" : "s"} arrived over ${fmt(window.weeks)} weeks: ${fmt(qualified, 2)} qualified a week` +
          (seasonal ? " with seasonality taken out" : "") +
          (s.conversion > 0 && s.conversion < 1 ? `, so ${fmt(qualified / s.conversion, 2)} leads a week at the ${Math.round(s.conversion * 100)}% that qualify.` : "."),
        set: enough ? { volume_week: proposed } : null,
        before: enough ? { volume_week: s.volumeWeek } : null,
      };
    });
}
