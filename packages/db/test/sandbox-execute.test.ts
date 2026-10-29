import { describe, expect, it } from "vitest";
import { simulate, type SimulationResult } from "@transpera-flow/engine";
import { northbeamBundle, northbeamRoleIds, northbeamSandboxScenarios, northbeamStepIds, toEngineModel, NORTHBEAM_REVISION_ID, type SandboxChange, type SolutionRow } from "../src";
import { SANDBOX_REPS, SANDBOX_SEED, calendarMonthStarts, effectiveChanges, horizonWeeks, joinRun, prepareScenario, priceRiseOf, simulateScenario, type PreparedScenario, type PreparedSegment } from "../src/sandbox";

// The Sandbox runner is shared by the web app and MCP (docs/plans/sandbox-p5-brief.md §2.5): `simulateScenario` must give exactly what the
// web does, which runs each prepared segment on a worker (workers/simulate.worker.ts: `simulate(model, reps, seed, { monthly, monthStarts,
// initialState })`) and joins them with `joinRun` and `priceRiseOf`. The worker's call is written out here, not imported.

const START = "2026-10-05";
const MONTHS = 12;
const bundle = northbeamBundle();
const saved = northbeamSandboxScenarios();
let n = 0;
const change = (c: Omit<SandboxChange, "id">): SandboxChange => ({ id: `7e000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, ...c }) as SandboxChange;
const eff = (list: SandboxChange[]) => list.map((c) => ({ change: c, scenarioId: "s", scenarioName: "S", inherited: false }));

/** A solution that halves the PPC step's time: a second map to switch to from a month. */
const solution: SolutionRow = (() => {
  const strip = <T extends object>(row: T) => {
    const { revision_id: _r, workspace_id: _w, process_id: _p, ...rest } = structuredClone(row) as T & { revision_id: unknown; workspace_id: unknown; process_id: unknown };
    void _r;
    void _w;
    void _p;
    return rest;
  };
  const steps = bundle.steps.map((s) => (s.id === northbeamStepIds.ppc ? { ...strip(s), work_hours: Number(s.work_hours) / 2 } : strip(s)));
  return {
    id: "50000000-0000-4000-8000-000000000001",
    workspace_id: bundle.workspace.id,
    process_id: bundle.process.id,
    base_revision_id: NORTHBEAM_REVISION_ID,
    name: "Faster PPC setup",
    notes: "",
    steps: { steps, edges: bundle.edges.map((e) => strip(e)), entry_step_id: null },
    changed_step_ids: [northbeamStepIds.ppc],
    lever_changes: [],
    created_at: "2026-10-05T00:00:00.000Z",
    updated_at: "2026-10-05T00:00:00.000Z",
    created_by: null,
  } as unknown as SolutionRow;
})();

/** What the web does with a prepared scenario: each segment as the worker runs it, then joined. */
function asTheWebRuns(p: PreparedScenario) {
  const runAll = (segments: PreparedSegment[]): SimulationResult[] =>
    segments.map((s) => simulate(s.model, 30, 1, { monthly: true, monthStarts: p.monthStarts, ...(p.start ? { initialState: p.start } : {}) }));
  const run = joinRun(p, p.segments, runAll(p.segments));
  const pair = p.pair ? joinRun(p, p.pair, runAll(p.pair)) : null;
  return { run, priceRise: pair ? priceRiseOf(p, run, pair) : null };
}

const cases: { name: string; changes: SandboxChange[]; segments: number; pair: boolean }[] = [
  { name: "whole-run patches (Northbeam's saved More leads)", changes: saved.find((s) => s.name.startsWith("More"))?.changes ?? [change({ lever: "A1", target: null, op: "multiply", value: 1.25 })], segments: 1, pair: false },
  {
    name: "a hire and a price rise from a month",
    changes: [change({ lever: "D1", target: northbeamRoleIds.ppc, op: "set", value: 1, from: "2027-01" }), change({ lever: "B5", target: null, op: "set", value: 0.08, from: "2027-03" })],
    segments: 1,
    pair: true,
  },
  { name: "a solution going live from a month", changes: [change({ lever: "E6", target: solution.id, op: "set", value: 1, from: "2027-02" })], segments: 2, pair: false },
];

describe("the shared Sandbox runner", () => {
  it("shares its constants with the web app's pool", () => {
    expect([SANDBOX_REPS, SANDBOX_SEED]).toEqual([30, 1]);
  });

  for (const c of cases) {
    it(`gives byte-identical results to the web's worker run: ${c.name}`, () => {
      const p = prepareScenario(bundle, eff(c.changes), [solution], MONTHS, START);
      expect(p.error).toBeNull();
      expect(p.segments.length).toBeGreaterThanOrEqual(c.segments);
      expect(Boolean(p.pair)).toBe(c.pair);
      const web = asTheWebRuns(p);
      const server = simulateScenario(p);
      expect(server.run.result).toEqual(web.run.result);
      expect(server.run.spliced).toBe(web.run.spliced);
      expect(server.priceRise).toEqual(web.priceRise);
      if (c.pair) expect(server.priceRise).not.toBeNull();
      expect(JSON.stringify(server.run.result.monthly)).toBe(JSON.stringify(web.run.result.monthly));
    }, 180_000);
  }

  it("skips the pair when asked not to build it", () => {
    const list = eff(cases[1]!.changes);
    expect(prepareScenario(bundle, list, [solution], MONTHS, START).pair).not.toBeNull();
    expect(prepareScenario(bundle, list, [solution], MONTHS, START, { pair: false }).pair).toBeNull();
  });

  it("runs 'No changes' as the live forecast does: its one segment and warm-up", () => {
    const p = prepareScenario(bundle, [], [], MONTHS, START);
    expect(p.error).toBeNull();
    expect(p.segments).toHaveLength(1);
    // The forecast page's model: toEngineModel for the planned company with the horizon in weeks, months on the calendar.
    const model = { ...toEngineModel(bundle, { startDate: START, planned: true, purposes: true }), horizonWeeks: horizonWeeks(MONTHS) };
    expect(p.segments[0]!.model).toEqual(model);
    expect(p.monthStarts).toEqual(calendarMonthStarts(START, model.horizonWeeks, model.hoursPerWeek));
    const a = simulateScenario(p).run.result;
    const b = simulate(model, 30, 1, { monthly: true, monthStarts: p.monthStarts, initialState: p.start! });
    expect(a).toEqual(b);
  }, 120_000);

  it("takes a saved scenario through effectiveChanges to the same run", () => {
    const row = saved.find((s) => s.changes.length === 1 && s.changes[0]!.lever === "D5")!;
    const chain = effectiveChanges(row, saved);
    if (!chain.ok) throw new Error(chain.error);
    const p = prepareScenario(bundle, chain.changes, [], MONTHS, START);
    expect(p.error).toBeNull();
    expect(simulateScenario(p).run.result.monthly!.months).toHaveLength(MONTHS);
  }, 120_000);
});
