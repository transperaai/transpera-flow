import { describe, expect, it } from "vitest";
import {
  blockersOf,
  bundleForProcess,
  capacityBlockers,
  capacityGaps,
  capacityNotes,
  northbeamBundle,
  northbeamServicingProcessIds,
  notesOf,
  toEngineModel,
  type ProcessBundle,
  type StepRow,
} from "../src";

// "Missing for simulation" with capacity (P4): the engine's capacity problems are blockers; a working step of a servicing process
// with no split, and a base value with no source, are notes. Nothing for a pipeline.

const START = "2026-10-05";
const SPLIT = { automatable: 0.5, augmentable: 0.3, manual: 0.2 };
const AT = "2026-10-31T00:00:00Z";
const SOURCED = {
  split: { source: "interview" as const, at: AT },
  tier_multiplier: { source: "calculator" as const, at: AT },
  work: { source: "interview" as const, at: AT },
};

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

describe("notes", () => {
  it("every working step of a servicing process with no split is a note, linking to its step", () => {
    const b = servicing();
    const notes = capacityNotes(b);
    expect(notes.map((n) => n.stepId).sort()).toEqual(working(b).map((s) => s.id).sort());
    expect(notes.every((n) => n.severity === "note" && n.kind === "split" && n.fix.type === "step")).toBe(true);
    expect(notes[0]!.text).toMatch(/ has no work split$/);
  });

  it("a split clears the note, and then a split with no source is a note about the source", () => {
    const b = withSteps(servicing(), () => ({ split: SPLIT }));
    const notes = capacityNotes(b);
    expect(notes.every((n) => n.kind === "source" && n.text.endsWith("has no source for its split and time"))).toBe(true);
    const sourced = withSteps(servicing(), () => ({ split: SPLIT, provenance: { split: SOURCED.split, work: SOURCED.work } }));
    expect(capacityNotes(sourced)).toEqual([]);
  });

  it("tier multipliers with no source are named too, and only when there are tier multipliers", () => {
    const b = withSteps(servicing(), () => ({ split: SPLIT, tier_multiplier: { T1: 1.3 }, provenance: { split: SOURCED.split, work: SOURCED.work } }));
    expect(capacityNotes(b).map((n) => n.text.replace(/^.* has/, "has"))).toEqual(working(b).map(() => "has no source for its tier multipliers"));
    const sourced = withSteps(servicing(), () => ({ split: SPLIT, tier_multiplier: { T1: 1.3 }, provenance: SOURCED }));
    expect(capacityNotes(sourced)).toEqual([]);
  });

  it("a source that is an older provenance kind (entered, estimated) is not a label", () => {
    const b = withSteps(servicing(), () => ({
      split: SPLIT,
      provenance: { split: { source: "entered" as const, at: AT }, work: { source: "estimated" as const, at: AT } },
    }));
    expect(capacityNotes(b).length).toBe(working(b).length);
  });

  it("nothing for a pipeline, the company map, or a group or child holder", () => {
    expect(capacityNotes(northbeamBundle())).toEqual([]);
    const s = servicing();
    expect(capacityNotes({ ...s, process: { ...s.process, is_company: true } })).toEqual([]);
    const holder = withSteps(s, () => ({ child_process_id: "11111111-1111-4111-8111-111111111111" }));
    expect(capacityNotes(holder)).toEqual([]);
  });
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
    expect(blockers[0]).toMatchObject({ kind: "capacity", severity: "blocker", stepId: first.id, stepName: first.name, fix: { type: "step", stepId: first.id } });
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

  it("blockers come first, and blockersOf / notesOf split the list", () => {
    const b = withSteps(servicing(), (_s, i) => (i === 0 ? { split: { automatable: 1, augmentable: 1, manual: 1 } } : {}));
    const all = capacityGaps(b, model(b));
    expect(all[0]!.severity).toBe("blocker");
    expect(blockersOf(all)).toHaveLength(1);
    expect(notesOf(all)).toHaveLength(working(b).length);
    expect(blockersOf(all).length + notesOf(all).length).toBe(all.length);
    expect(all.indexOf(notesOf(all)[0]!)).toBeGreaterThan(all.indexOf(blockersOf(all)[0]!));
  });
});
