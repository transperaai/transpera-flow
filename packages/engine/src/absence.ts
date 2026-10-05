// The absence test (docs/analysis-rules.md rule 8, "Only one person can do it"; issue #107).
//
// For each person who is the only one able to do some step, the engine runs an
// extra set of replications with that person away (2 weeks by default) and
// compares it with the same replications without the absence, on two numbers:
//
// - **Work lost**: of the work completed from the start of the absence to the
//   end of the run (won and done items, and servicing tasks on time or late),
//   the share the absence cost. Items that were only delayed and finished
//   before the end don't count; items still queued at the end do.
// - **Weeks to recover**: after the person returns, the weeks until the queues
//   at the steps only they can do are back to normal: within 1 item or 25% of
//   what the baseline's queues are in the same week.
//
// A third flag, "client deadline missed", is set when the absence makes at
// least one more servicing task go unfinished within twice its SLA, per
// replication on average (`CLIENT_MISSED_MIN`).
//
// Deterministic like the rest of the engine: the baseline and the absence run
// use the same seed and replication streams (common random numbers, so the
// difference is the absence and not luck), and nothing here draws a number of
// its own. It is its own pass, not part of `simulate`: it costs (people tested
// + 1) × `reps` replications, so the app runs it after the baseline run, in a
// worker (apps/web/src/lib/sim/absence.ts), and `detectIssues` only reads its
// result. To stay inside the performance targets (docs/PRD.md §6.7) it
//
// - tests only people who are the sole holder of a step (a structural check),
//   at most `maxPeople` of them (the ones holding the most steps first), and
// - uses 10 replications by default, not the baseline's 30.
//
// Pure: no I/O, no clock (except an optional time budget, as in shadow-price.ts).

import { eligible } from "./eligibility";
import type { EngineModel, ReplicationResult } from "./model";
import { initialState, resolvePeople, runOnce, SEED_STRIDE } from "./simulate";

/** One more missed servicing task per replication, on average, counts as a client deadline missed. */
export const CLIENT_MISSED_MIN = 1;
/** Replications for the absence test, and for the baseline it is compared with. */
export const ABSENCE_REPS = 10;
/** The most people tested in one pass. */
export const ABSENCE_MAX_PEOPLE = 8;
/** The week the absence starts in, when the run is long enough (the early weeks of a run are still settling). */
export const ABSENCE_START_WEEK = 2;
/** Weeks after the person returns that the run should still cover, to see whether the queues recover. */
const OBSERVE_WEEKS = 5;

export { eligible };

export interface AbsenceCandidate {
  personId: string;
  /** Steps only this person can do. */
  stepIds: string[];
}

/** People who are the only one able to do at least one step, most steps first (then by id). */
export function absenceCandidates(model: EngineModel): AbsenceCandidate[] {
  const people = resolvePeople(model);
  const ids = Object.keys(people).filter((id) => people[id]!.capacity > 0);
  const sole = new Map<string, string[]>();
  for (const s of model.steps) {
    if (!s.role && !s.person) continue;
    const who = ids.filter((id) => eligible(id, people[id]!, s));
    if (who.length !== 1) continue;
    const list = sole.get(who[0]!) ?? [];
    list.push(s.id);
    sole.set(who[0]!, list);
  }
  return [...sole.entries()]
    .map(([personId, stepIds]) => ({ personId, stepIds: stepIds.sort() }))
    .sort((a, b) => b.stepIds.length - a.stepIds.length || (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
}

export interface AbsenceFinding {
  personId: string;
  /** Steps only this person can do. */
  stepIds: string[];
  /** Work lost (0 to 1) from the start of the absence to the end of the run, against the same run without it. */
  workLost: number;
  /** Items (and servicing tasks) lost in that window, per replication. */
  itemsLost: number;
  /** Wins lost in that window, per replication: what the cost per month counts at deal value (servicing tasks aren't deals). */
  winsLost: number;
  /** Weeks after they return until the queues at their steps are back to normal; see `recovered`. */
  recoveryWeeks: number;
  /**
   * Whether the queues got back to normal before the run ended. When not,
   * `recoveryWeeks` is the weeks observed plus one: at least that many.
   */
  recovered: boolean;
  /** Servicing tasks missed beyond the baseline's, per replication. */
  extraMissed: number;
  /** Whether that reaches `CLIENT_MISSED_MIN`: a client deadline is missed. */
  clientDeadlineMissed: boolean;
}

export interface AbsenceTest {
  /** Replications per side, and the seed of replication 0 (the baseline run's, so they pair up). */
  reps: number;
  seed: number;
  /** How long the person is away, and the week it starts in. */
  weeksAway: number;
  startWeek: number;
  people: AbsenceFinding[];
  /** False when the time budget ran out before every candidate was tested. */
  complete: boolean;
}

export interface AbsenceOptions {
  /** Replications per side (default `ABSENCE_REPS`). */
  reps?: number;
  /** Seed of replication 0 (default 1, the app's baseline). */
  seed?: number;
  /** Weeks away (default 2). */
  weeks?: number;
  /** Test only these people (default: every candidate). */
  personIds?: readonly string[];
  /** The most people to test (default `ABSENCE_MAX_PEOPLE`). */
  maxPeople?: number;
  /** Stop starting people after this many milliseconds (at least one person always runs). */
  timeBudgetMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Run the absence test on `model`. With no one to test it returns an empty list without simulating. */
export function absenceTest(model: EngineModel, options: AbsenceOptions = {}): AbsenceTest {
  const reps = Math.max(1, Math.floor(options.reps ?? ABSENCE_REPS));
  const seed = options.seed ?? 1;
  const weeks = Math.max(0, options.weeks ?? 2);
  const horizon = model.horizonWeeks;
  // Early enough that the queues have time to recover before the run ends, late enough that it has settled.
  const startWeek = Math.max(0, Math.min(ABSENCE_START_WEEK, Math.floor(horizon - weeks - OBSERVE_WEEKS)));
  const out: AbsenceTest = { reps, seed, weeksAway: weeks, startWeek, people: [], complete: true };
  if (!(weeks > 0) || horizon < startWeek + weeks) return out;

  let candidates = absenceCandidates(model);
  if (options.personIds) candidates = candidates.filter((c) => options.personIds!.includes(c.personId));
  candidates = candidates.slice(0, Math.max(1, options.maxPeople ?? ABSENCE_MAX_PEOPLE));
  if (!candidates.length) return out;

  // Both sides use the model with its people spelled out, so the baseline and the absence draw the same streams.
  const people = resolvePeople(model);
  const base: EngineModel = { ...model, people };
  const start = initialState(base);
  const hpw = model.hoursPerWeek;
  const run = (m: EngineModel): ReplicationResult[] => {
    const rs: ReplicationResult[] = [];
    for (let i = 0; i < reps; i++) rs.push(runOnce(m, seed + i * SEED_STRIDE, false, start, true));
    return rs;
  };
  const baseline = run(base);
  const now = options.now ?? (() => performance.now());
  const deadline = options.timeBudgetMs === undefined ? Infinity : now() + options.timeBudgetMs;

  // Completed work in a replication from the start of the absence to the end of the run.
  const windowWork = (r: ReplicationResult) => {
    const c = r.weekly!.completed;
    return (c[c.length - 1] ?? 0) - (startWeek > 0 ? (c[startWeek - 1] ?? 0) : 0);
  };
  const windowWins = (r: ReplicationResult) => {
    const w = r.weekly!.won;
    return (w[w.length - 1] ?? 0) - (startWeek > 0 ? (w[startWeek - 1] ?? 0) : 0);
  };
  const baseWins = sum(baseline.map(windowWins));
  const baseWork = sum(baseline.map(windowWork));
  const baseMissed = sum(baseline.map((r) => r.touchpoints?.missed ?? 0)) / reps;
  const queueAt = (rs: ReplicationResult[], stepIds: string[], tick: number) =>
    sum(rs.map((r) => sum(stepIds.map((id) => r.weekly!.queue[id]?.[tick - 1] ?? 0)))) / reps;

  for (const [index, cand] of candidates.entries()) {
    if (index > 0 && now() > deadline) {
      out.complete = false;
      break;
    }
    const p = people[cand.personId]!;
    const away: EngineModel = {
      ...base,
      people: { ...people, [cand.personId]: { ...p, leave: [...(p.leave ?? []), [startWeek * hpw, (startWeek + weeks) * hpw]] } },
    };
    const absent = run(away);
    const workLost = baseWork > 0 ? Math.max(0, (baseWork - sum(absent.map(windowWork))) / baseWork) : 0;
    const itemsLost = Math.max(0, (baseWork - sum(absent.map(windowWork))) / reps);
    const winsLost = Math.max(0, (baseWins - sum(absent.map(windowWins))) / reps);

    // Weeks after the return until the queues at their steps are back to normal, and stay so a week later.
    const back = startWeek + weeks;
    const normal = (tick: number) => {
      const q0 = queueAt(baseline, cand.stepIds, tick);
      return queueAt(absent, cand.stepIds, tick) <= q0 + Math.max(1, 0.25 * q0);
    };
    let recoveryWeeks = horizon - back + 1;
    let recovered = false;
    for (let k = 0; back + k <= horizon; k++) {
      if (normal(back + k) && (back + k === horizon || normal(back + k + 1))) {
        recoveryWeeks = k;
        recovered = true;
        break;
      }
    }
    const extraMissed = Math.max(0, sum(absent.map((r) => r.touchpoints?.missed ?? 0)) / reps - baseMissed);
    out.people.push({
      personId: cand.personId,
      stepIds: cand.stepIds,
      workLost,
      itemsLost,
      winsLost,
      recoveryWeeks,
      recovered,
      extraMissed,
      clientDeadlineMissed: extraMissed >= CLIENT_MISSED_MIN,
    });
  }
  return out;
}
