// A solution's before and after as numbers (issue #173, B15): both sides simulated with the same runs and seed. Only the
// engine, so the worker that runs it stays small. Pure.

import { simulate, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { timeSplitOf } from "./time-split";

const WEEKS_PER_MONTH = 52 / 12;

export interface ImpactPair {
  id: string;
  name: string;
  implemented: boolean;
  /** The process it changes, and the version of it the copy was made from. */
  processId: string;
  processName: string;
  baseRevisionId: string;
  base: EngineModel;
  solved: EngineModel;
}

/** The measures, read off one run. */
export interface ImpactNumbers {
  /**
   * Hands-on hours an item needs, everyone together: the hands-on time of the visits that started, over the items that
   * came through. A per-item figure, so a solution that lets more items through isn't read as more work.
   */
  handsOnPerItem: number;
  /** Items a month the run brought in (finished, lost, done, or still in progress at the end). */
  itemsPerMonth: number;
  /** Average time to complete an item, in working hours; null when none completed. */
  cycleHours: number | null;
}

export function impactNumbers(model: Pick<EngineModel, "steps" | "hoursPerWeek">, result: Pick<SimulationResult, "steps" | "stepFacts" | "H" | "kpi">): ImpactNumbers {
  const months = result.H / model.hoursPerWeek / WEEKS_PER_MONTH;
  const handsOn = timeSplitOf(model, result)?.handsOn ?? 0;
  const { won, lost, done, wipEnd } = result.kpi;
  const finished = won.mean + lost.mean + done.mean;
  const items = finished + wipEnd.mean;
  const cycle = result.kpi.cycle.mean;
  return {
    // Over the items that got through, or, when none did, all of them.
    handsOnPerItem: finished > 0 ? handsOn / finished : items > 0 ? handsOn / items : 0,
    itemsPerMonth: months > 0 ? items / months : 0,
    cycleHours: Number.isFinite(cycle) && cycle > 0 ? cycle : null,
  };
}

export interface SolutionImpact {
  id: string;
  name: string;
  implemented: boolean;
  processId: string;
  processName: string;
  baseRevisionId: string;
  before: ImpactNumbers;
  after: ImpactNumbers;
}

/** Simulate one pair, both sides with the same runs and seed. */
export function measureImpact(pair: ImpactPair, reps = 30, seed = 1): SolutionImpact {
  const before = impactNumbers(pair.base, simulate(pair.base, reps, seed));
  const after = impactNumbers(pair.solved, simulate(pair.solved, reps, seed));
  return { id: pair.id, name: pair.name, implemented: pair.implemented, processId: pair.processId, processName: pair.processName, baseRevisionId: pair.baseRevisionId, before, after };
}


/**
 * Hands-on hours a month before and after, both at the same demand (the before's items a month): what the work per item
 * changed, not how many items got through.
 */
export function hoursAMonth(impact: Pick<SolutionImpact, "before" | "after">): { before: number; after: number } {
  const demand = impact.before.itemsPerMonth;
  return { before: impact.before.handsOnPerItem * demand, after: impact.after.handsOnPerItem * demand };
}
