import { describe, expect, it } from "vitest";
import { larkspurBundle, northbeamBundle, toEngineModel } from "@transpera-flow/db";
import { MARKET_PRESETS, applyPatches, marketFromSchedule, simulate, type EngineModel } from "@transpera-flow/engine";
import { buildLevers, leverPatches } from "@/lib/scenarios/levers";
import { HORIZON_MONTHS, horizonWeeks } from "@/lib/horizon";

// A 24-month run against the PRD §6.7 targets (issue #123, A58). Those targets are for 13 weeks. A run costs about
// as much per week as the one before it, so the targets are scaled by horizon: 104 weeks is 8 times 13, so the
// pipeline-only Northbeam gets 8 × 150 ms and the full seeded Northbeam 8 × 250 ms. The same models are also run
// with a downturn for all 24 months (every market factor off 100%). The result is recorded in
// docs/engine-versioning.md ("24-month horizon"). Timing tests can fail on a loaded machine: re-run them alone.

const START = { startDate: "2026-10-05" };
const SCALE = horizonWeeks(24) / 13;
const DOWNTURN = marketFromSchedule([{ from: 1, to: 24, condition: "downturn" }], () => MARKET_PRESETS.downturn.factors);

const withHorizon = (m: EngineModel, months: number, market = false): EngineModel => ({ ...m, horizonWeeks: horizonWeeks(months), ...(market ? { market: DOWNTURN } : {}) });

const northbeamFull = () => toEngineModel(northbeamBundle(), START);
const northbeamPipeline = () => {
  const b = northbeamBundle();
  return toEngineModel({ ...b, servicingLinks: [], otherProcesses: (b.otherProcesses ?? []).filter((p) => p.process.kind !== "servicing") }, START);
};
const larkspurFull = () => toEngineModel(larkspurBundle(), START);

/** Best of 3 re-runs after a lever move, as scenarios.test.ts measures the 13-week targets. */
function rerunBest(base: () => EngineModel, months: number, market = false): number {
  simulate(withHorizon(base(), months, market), 30, 1);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const m = withHorizon(base(), months, market);
    const t = performance.now();
    simulate(applyPatches(m, leverPatches(buildLevers(m), { "demand.leads_per_week": 8 + i })).model, 30, 1);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe("the horizon picker's options", () => {
  it("offers 1, 3, 6, 12 and 24 months, and 3 months is the 13-week default", () => {
    expect(HORIZON_MONTHS).toEqual([1, 3, 6, 12, 24]);
    expect(HORIZON_MONTHS.map(horizonWeeks)).toEqual([4, 13, 26, 52, 104]);
  });
});

describe("a 24-month run stays within the PRD §6.7 targets, scaled by horizon (8 × the 13-week targets)", { tags: ["perf"] }, () => {
  it("pipeline-only Northbeam: < 8 × 150 ms", () => {
    const ms = rerunBest(northbeamPipeline, 24);
    console.info(`24 months, pipeline-only Northbeam: ${ms.toFixed(0)} ms (limit ${150 * SCALE})`);
    expect(ms).toBeLessThan(150 * SCALE);
  });

  it("full seeded Northbeam (client roster and servicing): < 8 × 250 ms", () => {
    const ms = rerunBest(northbeamFull, 24);
    console.info(`24 months, full Northbeam: ${ms.toFixed(0)} ms (limit ${250 * SCALE})`);
    expect(ms).toBeLessThan(250 * SCALE);
  });

  it("full seeded Larkspur: < 8 × 250 ms", () => {
    const ms = rerunBest(larkspurFull, 24);
    console.info(`24 months, full Larkspur: ${ms.toFixed(0)} ms (limit ${250 * SCALE})`);
    expect(ms).toBeLessThan(250 * SCALE);
  });

  it("with a downturn in all 24 months: full Northbeam < 8 × 250 ms", () => {
    const ms = rerunBest(northbeamFull, 24, true);
    console.info(`24 months, full Northbeam with a downturn: ${ms.toFixed(0)} ms (limit ${250 * SCALE})`);
    expect(ms).toBeLessThan(250 * SCALE);
  });
});
