// Hands-on versus waiting, read off one simulation run (issue #173, B15): the Overview's flow efficiency and time split,
// and the before/after of a solution. Only the engine's types, so a worker can import it. Pure.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";

/** Hours of elapsed time at the steps over the run, split by what was happening. */
export interface TimeSplit {
  /** Someone working on it. */
  handsOn: number;
  /** Waiting for a person: in their queue, or stretched over a part-time week. */
  waitingForPerson: number;
  /** Waiting on others: a fixed wait outside the team (the client, a supplier). */
  waitingOnOthers: number;
}

export const totalOf = (t: TimeSplit): number => t.handsOn + t.waitingForPerson + t.waitingOnOthers;

/** Hands-on as a share of all the elapsed time, or null when nothing went through the steps. */
export const workingShare = (t: TimeSplit): number | null => {
  const total = totalOf(t);
  return total > 0 ? t.handsOn / total : null;
};

const NONE: TimeSplit = { handsOn: 0, waitingForPerson: 0, waitingOnOthers: 0 };

/**
 * Hands-on versus waiting over the run, at the steps in `stepIds` (all steps when omitted), so a backlog counts as waiting:
 * - hands-on, the part-time stretch and the fixed wait: each step's per-visit times (the run's step facts) times the
 *   visits that started there (its arrivals less those still queued at the horizon, which nobody has worked on yet);
 * - queueing for a person: the time items spent in the step's queue over the run (its average queue length times the
 *   run's length), which includes the items still queued at the horizon. A run that only read finished visits would leave
 *   those out and show the backlog as more working than it is.
 * Null when the run carries no step facts.
 */
export function timeSplitOf(model: Pick<EngineModel, "steps">, result: Pick<SimulationResult, "steps" | "stepFacts" | "H">, stepIds?: ReadonlySet<string>): TimeSplit | null {
  const facts = result.stepFacts;
  if (!facts) return null;
  const out = { ...NONE };
  for (const s of model.steps) {
    if (stepIds && !stepIds.has(s.id)) continue;
    const f = facts[s.id];
    const r = result.steps[s.id];
    const visits = r?.arrivals ?? 0;
    if (!f || !r || visits <= 0) continue;
    const started = Math.max(0, visits - (r.wip ?? 0));
    const queued = Number.isFinite(r.avgQueue) && r.avgQueue > 0 && result.H > 0 ? r.avgQueue * result.H : started * f.queueWaitHours;
    out.handsOn += started * f.handsOnHours;
    out.waitingForPerson += queued + started * f.stretchHours;
    out.waitingOnOthers += started * f.fixedWaitHours;
  }
  return out;
}
