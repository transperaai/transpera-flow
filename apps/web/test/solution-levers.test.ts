import { describe, expect, it } from "vitest";
import { toEngineModel, type SolutionRow } from "@transpera-flow/db";
import { simulate, type ScenarioPatch } from "@transpera-flow/engine";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { planSegments } from "@/lib/forecast/plan";
import { monthBounds } from "@/lib/forecast/positions";
import { impactPairs } from "@/lib/overview/impact";
import { solutionCopy } from "@/lib/solutions/bundle";
import { withLeverChanges } from "@/lib/solutions/levers";
import { parseSolutionInput } from "@/lib/solutions/save";
import { simulateCopy } from "@/lib/solutions/server-verdict";
import { demoBundle } from "@/lib/sources/demo";

// A solution's lever changes (B4, D48): applied wherever a solution is simulated, and with none everything is as before.

const base = demoBundle();
const LEADS: ScenarioPatch = { path: "demand.leads_per_week", op: "set", value: 99 };
const row = (over: Partial<SolutionRow>): SolutionRow =>
  ({ id: "s1", workspace_id: base.workspace.id, process_id: base.process.id, base_revision_id: base.revision.id, name: "S", steps: solutionCopy(base), changed_step_ids: [], lever_changes: [], created_at: "2026-10-01T00:00:00Z", ...over }) as unknown as SolutionRow;

describe("withLeverChanges", () => {
  const model = toEngineModel(base);

  it("with no changes returns the model itself and no problems", () => {
    const r = withLeverChanges(model, []);
    expect(r.model).toBe(model);
    expect(r.problems).toEqual([]);
  });

  it("applies the changes to a copy, leaving the input alone", () => {
    const before = JSON.stringify(model);
    const r = withLeverChanges(model, [LEADS]);
    expect(r.model.leadsPerWeek).toBe(99);
    expect(r.problems).toEqual([]);
    expect(JSON.stringify(model)).toBe(before);
  });

  it("leaves out a change whose target is gone and reports it, never throws", () => {
    const gone: ScenarioPatch = { path: "steps.00000000-0000-4000-8000-00000000dead.work_hours", op: "multiply", value: 0.5 };
    const r = withLeverChanges(model, [LEADS, gone]);
    expect(r.model.leadsPerWeek).toBe(99);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/dead/);
  });

  it("brings an out-of-range value into range without calling it a problem", () => {
    const r = withLeverChanges(model, [{ path: "demand.leads_per_week", op: "add", value: -10_000 }]);
    expect(r.model.leadsPerWeek).toBe(0);
    expect(r.problems).toEqual([]);
  });
});

describe("simulateCopy", () => {
  const copy = solutionCopy(base);

  it("a solution with no lever changes simulates byte for byte as before", () => {
    const a = simulateCopy(base, copy);
    const b = simulateCopy(base, copy, []);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(JSON.stringify(b.run.model)).toBe(JSON.stringify(a.run.model));
      expect(JSON.stringify(b.run.result)).toBe(JSON.stringify(a.run.result));
      expect(JSON.stringify(a.run.model)).toBe(JSON.stringify(toEngineModel(a.run.solved)));
    }
  });

  it("raising leads per week changes the run, the model and the numbers", () => {
    const plain = simulateCopy(base, copy);
    const more = simulateCopy(base, copy, [LEADS]);
    if (!plain.ok || !more.ok) throw new Error("expected both to simulate");
    expect(more.run.model.leadsPerWeek).toBe(99);
    expect(plain.run.model.leadsPerWeek).not.toBe(99);
    expect(JSON.stringify(more.run.result)).not.toBe(JSON.stringify(plain.run.result));
  });
});

describe("the Overview's impact pairs", () => {
  it("the solved side carries the lever changes; the before side doesn't", () => {
    const [pair] = impactPairs(base, [{ solution: row({ lever_changes: [LEADS] }), implemented: true }], {}, 13);
    expect(pair!.solved.leadsPerWeek).toBe(99);
    expect(pair!.base.leadsPerWeek).not.toBe(99);
    const [none] = impactPairs(base, [{ solution: row({}), implemented: true }], {}, 13);
    expect(JSON.stringify(none!.solved)).toBe(JSON.stringify(none!.base));
  });
});

describe("the Forecast's plans (amends D46)", () => {
  const bundle = demoForecastBundle();
  const live = forecastModel(bundle, 12, DEMO_FORECAST_START).model!;
  const monthStarts = forecastModel(bundle, 12, DEMO_FORECAST_START).monthStarts!;
  const bounds = monthBounds(monthStarts, live.horizonWeeks * live.hoursPerWeek);
  const marker = (date: string) => [{ id: "11111111-1111-4111-8111-111111111111", kind: "solution" as const, date, solution_id: DEMO_FORECAST_SOLUTION_ID }];

  it("a segment carries the lever changes of the solutions live by then, and the run applies them", () => {
    const withLevers = { ...DEMO_FORECAST_SOLUTION, lever_changes: [LEADS] } as SolutionRow;
    const { segments } = planSegments(bundle, marker("2027-01-01"), [withLevers], DEMO_FORECAST_START, bounds, 40);
    expect(segments[0]!.levers).toEqual([]);
    const last = segments[segments.length - 1]!;
    expect(last.levers).toEqual([LEADS]);
    expect(forecastModel(last.bundle, 12, DEMO_FORECAST_START, last.levers).model!.leadsPerWeek).toBe(99);
    expect(forecastModel(last.bundle, 12, DEMO_FORECAST_START).model!.leadsPerWeek).not.toBe(99);
  });

  it("when a later solution replaces an earlier one for the same process, the earlier one's lever changes are dropped (and two x0.8 don't compound)", () => {
    const step = bundle.steps.find((x) => x.kind === "task")!.id;
    const slow = { path: `steps.${step}.work_hours`, op: "multiply", value: 0.8 } as const;
    const A = { ...DEMO_FORECAST_SOLUTION, id: "00000000-0000-4000-8000-0000000000a1", lever_changes: [LEADS, slow] } as SolutionRow;
    const B = { ...DEMO_FORECAST_SOLUTION, id: "00000000-0000-4000-8000-0000000000a2", lever_changes: [] } as SolutionRow;
    const two = [
      { id: "11111111-1111-4111-8111-111111111111", kind: "solution" as const, date: "2026-12-01", solution_id: A.id },
      { id: "22222222-2222-4222-8222-222222222222", kind: "solution" as const, date: "2027-03-01", solution_id: B.id },
    ];
    const { segments } = planSegments(bundle, two, [A, B], DEMO_FORECAST_START, bounds, 40);
    // Where only A is live its changes count; once B replaces it, none do.
    expect(segments.some((s) => s.solutionIds.length === 1 && s.levers.length === 2)).toBe(true);
    expect(segments[segments.length - 1]!.solutionIds).toEqual([A.id, B.id]);
    expect(segments[segments.length - 1]!.levers).toEqual([]);
    // Both with x0.8 on one step: the model shows x0.8, not x0.64.
    const both = { ...B, lever_changes: [slow] } as SolutionRow;
    const last = planSegments(bundle, two, [A, both], DEMO_FORECAST_START, bounds, 40).segments.at(-1)!;
    expect(last.levers).toEqual([slow]);
    const base = forecastModel(last.bundle, 12, DEMO_FORECAST_START).model!.steps.find((x) => x.id === step)!.work;
    expect(forecastModel(last.bundle, 12, DEMO_FORECAST_START, last.levers).model!.steps.find((x) => x.id === step)!.work).toBeCloseTo(base * 0.8, 6);
  });

  it("with none, the plan's models are the same as before", () => {
    const { segments } = planSegments(bundle, marker("2027-01-01"), [DEMO_FORECAST_SOLUTION], DEMO_FORECAST_START, bounds, 40);
    for (const s of segments) {
      expect(s.levers).toEqual([]);
      expect(JSON.stringify(forecastModel(s.bundle, 12, DEMO_FORECAST_START, s.levers).model)).toBe(JSON.stringify(forecastModel(s.bundle, 12, DEMO_FORECAST_START).model));
    }
  });
});

describe("saving a solution's lever changes", () => {
  const input = (levers: unknown) => ({ name: "S", processId: base.process.id, baseRevisionId: base.revision.id, copy: solutionCopy(base), changedStepIds: [], levers, links: [] });

  it("keeps well-formed changes and refuses a malformed list", () => {
    const ok = parseSolutionInput(input([LEADS]));
    expect(ok.ok && ok.value.levers).toEqual([LEADS]);
    expect(parseSolutionInput(input([{ ...LEADS, extra: 1 }]))).toEqual({ ok: false, error: "That solution's lever changes aren't valid." });
    expect(parseSolutionInput(input([{ path: "x", op: "set", value: 1 }]))).toEqual({ ok: false, error: "That solution's lever changes aren't valid." });
    expect(parseSolutionInput(input("nope"))).toMatchObject({ ok: true });
  });

  it("the stress run of a solution's model is the same simulation the Editor ran", () => {
    const m = withLeverChanges(toEngineModel(base), [LEADS]).model;
    expect(JSON.stringify(simulate(m, 3, 1))).toBe(JSON.stringify(simulate(withLeverChanges(toEngineModel(base), [LEADS]).model, 3, 1)));
  });
});
