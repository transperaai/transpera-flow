import { describe, expect, it } from "vitest";
import { northbeamPersonIds, northbeamRoleIds, type SandboxChange } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { monthBounds } from "@/lib/forecast/positions";
import { spliceMonthly } from "@/lib/forecast/splice";
import { scenarioModel, scenarioSegments, MAX_SEGMENTS } from "@/lib/sandbox/run";

// The worst scenario the Sandbox will run (docs/plans/sandbox-p1-brief.md §6): six distinct change months, so seven segments, with a
// hire, a leaver's leave and a solution among them. Each segment is one full run at 30 replications; the limit per run is the 12-month
// forecast's 4 x 250 ms (the full seeded Northbeam, scaled for a year as horizon-performance.test.ts scales it) and the seven together
// must come in under 7 s one after the other (the app spreads them over the worker pool, so this is the slowest case). The numbers are
// recorded in docs/engine-versioning.md ("Sandbox scenarios"). Timing tests can fail on a loaded machine: re-run them alone.

const START = DEMO_FORECAST_START;
const bundle = demoForecastBundle();
const id = (n: number) => `5e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const changes = (): SandboxChange[] => [
  { id: id(1), lever: "A1", target: null, op: "multiply", value: 1.1, from: "2026-11" },
  { id: id(2), lever: "A1", target: null, op: "multiply", value: 1.1, from: "2027-01" },
  { id: id(3), lever: "A1", target: null, op: "multiply", value: 1.05, from: "2027-03" },
  { id: id(4), lever: "A1", target: null, op: "multiply", value: 1.05, from: "2027-05" },
  { id: id(5), lever: "E6", target: DEMO_FORECAST_SOLUTION_ID, op: "set", value: 1, from: "2027-07" },
  { id: id(6), lever: "A1", target: null, op: "multiply", value: 1.05, from: "2027-09" },
  { id: id(7), lever: "D1", target: northbeamRoleIds.ppc, op: "set", value: 1, from: "2027-02" },
  { id: id(8), lever: "D3", target: northbeamPersonIds["Dan Okafor"]!, op: "set", value: 2, from: "2027-03-01" },
  { id: id(9), lever: "D2", target: northbeamPersonIds["Leah Brooks"]!, op: "set", value: 0, from: "2027-08" },
];

describe("the largest Sandbox scenario: seven segments", { tags: ["perf"] }, () => {
  it("runs each segment under 4 x 250 ms and all seven under 7 s, sequentially", () => {
    const live = scenarioModel(bundle, 12, START);
    if (live.error !== null) throw new Error(live.error);
    const bounds = monthBounds(live.monthStarts, live.model.horizonWeeks * live.model.hoursPerWeek);
    const plan = scenarioSegments(bundle, changes().map((change) => ({ change, scenarioId: "s", scenarioName: "S", inherited: false })), [DEMO_FORECAST_SOLUTION], START, bounds, live.model.hoursPerWeek);
    expect(plan.error).toBeNull();
    expect(plan.problems).toEqual([]);
    expect(plan.segments).toHaveLength(MAX_SEGMENTS);
    const models = plan.segments.map((s) => {
      const built = scenarioModel(s.bundle, 12, START, s.patches, s.patchChangeIds);
      if (built.error !== null) throw new Error(built.error);
      return { from: s.from, model: built.model, monthStarts: built.monthStarts };
    });
    // Warm up (JIT), then time the runs.
    simulate(models[0]!.model, 30, 1, { monthly: true, monthStarts: models[0]!.monthStarts });
    const each: number[] = [];
    const runs = models.map((m) => {
      const t = performance.now();
      const result = simulate(m.model, 30, 1, { monthly: true, monthStarts: m.monthStarts });
      each.push(performance.now() - t);
      return { from: m.from, monthly: result.monthly! };
    });
    const total = each.reduce((a, b) => a + b, 0);
    const t = performance.now();
    const spliced = spliceMonthly(runs);
    const splice = performance.now() - t;
    console.info(`Sandbox, 7 segments at 12 months: ${each.map((e) => e.toFixed(0)).join(", ")} ms; total ${total.toFixed(0)} ms (limit 7000); splice ${splice.toFixed(1)} ms`);
    expect(spliced).toBeDefined();
    for (const e of each) expect(e).toBeLessThan(4 * 250);
    expect(total).toBeLessThan(7000);
  });
});
