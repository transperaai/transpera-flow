// A solution's before and after as numbers (issue #173, B15): both sides simulated with the same runs and seed. Only the
// engine, so the worker that runs it stays small. Pure.

import { simulate, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { timeSplitOf } from "./time-split";

const WEEKS_PER_MONTH = 52 / 12;

export interface ImpactPair {
  id: string;
  name: string;
  implemented: boolean;
  base: EngineModel;
  solved: EngineModel;
}

/** The two measures, read off one run. */
export interface ImpactNumbers {
  /** Hands-on hours a month, everyone together, over every step. */
  handsOnPerMonth: number;
  /** Average time to complete an item, in working hours; null when none completed. */
  cycleHours: number | null;
}

export function impactNumbers(model: Pick<EngineModel, "steps" | "hoursPerWeek">, result: Pick<SimulationResult, "steps" | "stepFacts" | "H" | "kpi">): ImpactNumbers {
  const months = result.H / model.hoursPerWeek / WEEKS_PER_MONTH;
  const handsOn = timeSplitOf(model, result)?.handsOn ?? 0;
  const cycle = result.kpi.cycle.mean;
  return { handsOnPerMonth: months > 0 ? handsOn / months : 0, cycleHours: Number.isFinite(cycle) && cycle > 0 ? cycle : null };
}

export interface SolutionImpact {
  id: string;
  name: string;
  implemented: boolean;
  before: ImpactNumbers;
  after: ImpactNumbers;
}

/** Simulate one pair, both sides with the same runs and seed. */
export function measureImpact(pair: ImpactPair, reps = 30, seed = 1): SolutionImpact {
  const before = impactNumbers(pair.base, simulate(pair.base, reps, seed));
  const after = impactNumbers(pair.solved, simulate(pair.solved, reps, seed));
  return { id: pair.id, name: pair.name, implemented: pair.implemented, before, after };
}

