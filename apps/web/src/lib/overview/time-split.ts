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
 * Hands-on versus waiting over the run, summed over every visit to the steps in `stepIds` (all steps when omitted):
 * each step's per-visit times (the run's step facts) times its visits. Null when the run carries no step facts.
 */
export function timeSplitOf(model: Pick<EngineModel, "steps">, result: Pick<SimulationResult, "steps" | "stepFacts">, stepIds?: ReadonlySet<string>): TimeSplit | null {
  const facts = result.stepFacts;
  if (!facts) return null;
  const out = { ...NONE };
  for (const s of model.steps) {
    if (stepIds && !stepIds.has(s.id)) continue;
    const f = facts[s.id];
    const visits = result.steps[s.id]?.arrivals ?? 0;
    if (!f || visits <= 0) continue;
    out.handsOn += visits * f.handsOnHours;
    out.waitingForPerson += visits * (f.queueWaitHours + f.stretchHours);
    out.waitingOnOthers += visits * f.fixedWaitHours;
  }
  return out;
}

