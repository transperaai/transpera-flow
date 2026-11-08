// Running a prepared Sandbox scenario, the same way in the browser and on the server (docs/plans/sandbox-p5-brief.md §2.2). The web app
// runs each segment on a worker (workers/simulate.worker.ts) and joins them with `joinRun`; MCP and tests call `simulateScenario`, which
// runs the same segments with the same options synchronously. Because both go through `joinRun` and `priceRiseOf`, the numbers can't drift.

import { simulate, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { priceRiseTradeoff, type PriceRiseTradeoff } from "./price-rise";
import type { PreparedScenario, PreparedSegment } from "./run";
import { spliceMonthly, spliceSamples } from "./splice";

/** Replications per Sandbox run and the seed they share (the live forecast's too), so a difference comes from the scenario, not chance. */
export const SANDBOX_REPS = 30;
export const SANDBOX_SEED = 1;

export interface ScenarioRun {
  model: EngineModel;
  result: SimulationResult;
  /** The model without the scenario: what Settings' own hires and leave are drawn from. */
  markersModel: EngineModel;
  /** Ids of the people the scenario added (its hires, and the second row of an FTE change). */
  planPeople: Set<string>;
  /**
   * The run is spliced from more than one segment: `result.monthly` follows the scenario, but `result.kpi` is the first segment's
   * alone, so whole-run figures must come from the months.
   */
  spliced: boolean;
}

/** The runs of a prepared scenario's segments as one: months spliced, and the first segment's other figures. */
export function joinRun(prepared: PreparedScenario, segments: { from: number; model: EngineModel }[], results: SimulationResult[]): ScenarioRun {
  const first = results[0]!;
  const monthly = spliceMonthly(segments.map((seg, i) => ({ from: seg.from, monthly: results[i]!.monthly! })));
  const samples = results.every((r) => r.monthlySamples) ? spliceSamples(segments.map((seg, i) => ({ from: seg.from, samples: results[i]!.monthlySamples! }))) : undefined;
  return { model: segments[0]!.model, result: { ...first, monthly, ...(samples ? { monthlySamples: samples } : {}) }, markersModel: prepared.markersModel, planPeople: prepared.planPeople, spliced: segments.length > 1 };
}

/** The price rise's trade-off from a run and its pair (the same scenario without the rise), or null when either has no monthly samples. */
export function priceRiseOf(prepared: PreparedScenario, run: ScenarioRun, pair: ScenarioRun): PriceRiseTradeoff | null {
  const a = run.result.monthlySamples;
  const b = pair.result.monthlySamples;
  if (!a || !b) return null;
  const clients = pair.result.monthly!.clients;
  const first = prepared.riseMonths[0] ?? 0;
  const clientMonthsAfter = Object.values(clients).reduce((sum, row) => sum + row.slice(first).reduce((x, st) => x + st.mean, 0), 0);
  const mrr = run.result.monthly!.mrr;
  const live = Object.values(run.result.monthly!.clients).reduce((x, row) => x + (row[row.length - 1]?.mean ?? 0), 0);
  return priceRiseTradeoff(a, b, prepared.riseMonths, { clientMonthsAfter, monthlyFee: live > 0 ? (mrr[mrr.length - 1]?.mean ?? 0) / live : 0 });
}

/** One segment through the engine with exactly the options the worker passes. */
function runSegment(prepared: PreparedScenario, seg: PreparedSegment): SimulationResult {
  return simulate(seg.model, SANDBOX_REPS, SANDBOX_SEED, { monthly: true, monthStarts: prepared.monthStarts, ...(prepared.start ? { initialState: prepared.start } : {}) });
}

/**
 * Every segment (and the price rise's pair) through the engine, one after another, and joined. For MCP and tests; the web app spreads
 * the same runs over its worker pool. Throws when the scenario has an `error` or no segments (the caller checks `prepared.error`).
 */
export function simulateScenario(prepared: PreparedScenario, o: { pair?: boolean } = {}): { run: ScenarioRun; priceRise: PriceRiseTradeoff | null } {
  if (prepared.error !== null) throw new Error(prepared.error);
  if (!prepared.segments.length) throw new Error("The scenario can't be simulated.");
  const run = joinRun(prepared, prepared.segments, prepared.segments.map((seg) => runSegment(prepared, seg)));
  let priceRise: PriceRiseTradeoff | null = null;
  if (prepared.pair?.length && o.pair !== false) {
    const other = joinRun(prepared, prepared.pair, prepared.pair.map((seg) => runSegment(prepared, seg)));
    priceRise = priceRiseOf(prepared, run, other);
  }
  return { run, priceRise };
}
