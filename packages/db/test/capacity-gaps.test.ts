import { describe, expect, it } from "vitest";
import {
  bundleForProcess,
  capacityBlockers,
  northbeamBundle,
  northbeamServicingProcessIds,
  toEngineModel,
  type ProcessBundle,
  type StepRow,
} from "../src";

// "Missing for simulation" with capacity (P4): the engine's capacity problems are blockers. (The "worth adding" notes for a missing
// split or source were removed in Q3.)

const START = "2026-10-05";
const servicing = (): ProcessBundle => {
  const b = bundleForProcess(northbeamBundle(), Object.values(northbeamServicingProcessIds)[0]!)!;
  expect(b.process.kind).toBe("servicing");
  return b;
};
const working = (b: ProcessBundle) => b.steps.filter((s) => s.kind === "task");
const withSteps = (b: ProcessBundle, change: (s: StepRow, i: number) => Partial<StepRow>): ProcessBundle => ({
  ...b,
  steps: b.steps.map((s, i) => (s.kind === "task" ? { ...s, ...change(s, i) } : s)),
});

describe("blockers", () => {
  const model = (b: ProcessBundle) => toEngineModel(b, { startDate: START });

  it("a model with no base values has none", () => {
    expect(capacityBlockers(model(northbeamBundle()))).toEqual([]);
    expect(capacityBlockers(model(servicing()))).toEqual([]);
    expect(capacityBlockers(null)).toEqual([]);
  });

  it("a split that doesn't add up is a blocker on its step, in the engine's words", () => {
    const b = withSteps(servicing(), (_s, i) => (i === 0 ? { split: { automatable: 0.5, augmentable: 0.5, manual: 0.5 } } : {}));
    const first = working(b)[0]!;
    const blockers = capacityBlockers(model(b));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ kind: "capacity", stepId: first.id, stepName: first.name, fix: { type: "step", stepId: first.id } });
    expect(blockers[0]!.text).toMatch(/the work split adds up to 1\.5, not 1/);
  });

  it("a step for the client's manager with no role is a blocker", () => {
    const b = withSteps(servicing(), (_s, i) => (i === 0 ? { to_client_manager: true, role_id: null } : {}));
    const blockers = capacityBlockers(model(b));
    expect(blockers.map((x) => x.text)).toEqual([expect.stringContaining("goes to the client's manager but has no role")]);
  });

  it("a driver recurrence whose service has no deliverables is a blocker that links to Settings", () => {
    const b = servicing();
    const link = b.servicingLinks![0]!;
    const driver = { ...b, servicingLinks: b.servicingLinks!.map((l) => (l === link ? { ...l, recurrence: { perMonth: 4, driver: "words" as const, per: 1000 } } : l)) };
    const blockers = capacityBlockers(model(driver));
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers[0]).toMatchObject({ kind: "capacity", stepId: null, fix: { type: "settings", where: "services" } });
  });
});
