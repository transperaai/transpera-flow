// What the process page's Supporting data shows besides the hours (lib/process-page/hours.ts): the time split per step and key-person
// risk, read off one simulation result. Pure.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";

export interface TimeSplitRow {
  id: string;
  label: string;
  /** Hours per visit: hands-on, waiting for a person (queue and part-time availability), and fixed waits (outside the team). */
  handsOn: number;
  waitingForPerson: number;
  fixedWait: number;
  total: number;
  /** Hands-on as a share of the whole visit. */
  handsOnShare: number;
}

/** Hands-on versus waiting per step, the steps whose visit takes longest in total first. Needs a run that carries step facts. */
export function timeSplitRows(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>, max = 8): TimeSplitRow[] {
  if (!result?.stepFacts) return [];
  return model.steps
    .flatMap((s) => {
      const f = result.stepFacts![s.id];
      const r = result.steps[s.id];
      if (!f || !r || r.arrivals <= 0 || !stepIds.has(s.id)) return [];
      const waitingForPerson = f.queueWaitHours + f.stretchHours;
      const total = f.handsOnHours + waitingForPerson + f.fixedWaitHours;
      return total > 0 ? [{ id: s.id, label: s.name, handsOn: f.handsOnHours, waitingForPerson, fixedWait: f.fixedWaitHours, total, handsOnShare: f.handsOnShare }] : [];
    })
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
    .slice(0, max);
}

export interface KeyPersonRow {
  id: string;
  step: string;
  /** Who is the only one that can do it; null when nobody can. */
  person: string | null;
  /** The name is one the simulation made up for a role with no named people ("Reviewer 1"), not a person in People. */
  placeholder: boolean;
}

/** Steps only one person can do (and any nobody can do), in process order. */
export function keyPersonRows(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>): KeyPersonRow[] {
  if (!result?.stepFacts) return [];
  return model.steps.flatMap((s): KeyPersonRow[] => {
    const f = result.stepFacts![s.id];
    if (!f || !stepIds.has(s.id)) return [];
    // Without named people the engine makes one up per head-count, keyed "<role>#<n>"; a person in People never has a # in the id.
    if (f.keyPerson) return [{ id: s.id, step: s.name, person: f.keyPerson.personName, placeholder: f.keyPerson.personId.includes("#") }];
    return f.nobodyCanDo ? [{ id: s.id, step: s.name, person: null, placeholder: false }] : [];
  });
}
