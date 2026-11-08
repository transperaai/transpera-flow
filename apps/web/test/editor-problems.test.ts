import { describe, expect, it } from "vitest";
import { ModelError, northbeamStepIds as ids, toEngineModel, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { addEdge, newStepRow, stepWarnings } from "@/lib/editor/commands";
import { edgeRow, groupRow } from "@/lib/editor/groups";
import { firstProblem, nodeProblems, problemsLine } from "@/lib/editor/problems";
import { applyEdit } from "@/lib/editor/ops";
import { demoBundle } from "@/lib/sources/demo";

// What stops a process simulating, by node (editor brainstorm, item 4).

const flat = () => demoBundle();
const without = (b: ProcessBundle, pred: (e: ProcessBundle["edges"][number]) => boolean): ProcessBundle => ({ ...b, edges: b.edges.filter((e) => !pred(e)) });
const blocks = (b: ProcessBundle): string | null => {
  try {
    toEngineModel(b, { startDate: "2026-10-05" });
    return null;
  } catch (err) {
    if (err instanceof ModelError) return err.message;
    throw err;
  }
};

describe("nodeProblems", () => {
  it("finds nothing wrong with a process that simulates", () => {
    const p = nodeProblems(flat());
    expect(p.total).toBe(0);
    expect([p.steps.size, p.edges.size, p.process.length]).toEqual([0, 0, 0]);
    expect(problemsLine(p.total)).toBeNull();
    expect(firstProblem(flat(), p)).toBeNull();
  });

  it("pins a step with no way out to that step, once", () => {
    const b = without(flat(), (e) => e.from_step_id === ids.audit);
    const p = nodeProblems(b);
    expect(p.steps.get(ids.audit)).toEqual(["Nothing leaves this step yet. Drag from its right edge to connect it."]);
    expect(p.total).toBe(1);
    expect(blocks(b)).toMatch(/Audit & proposal.*no outgoing edge/);
  });

  it("flags branches that don't add up to 100%, on a decision or any step", () => {
    const b = { ...flat(), edges: flat().edges.map((e) => (e.from_step_id === ids.decision && e.to_step_id === ids.lost ? { ...e, probability: 0.5 } : e)) };
    const p = nodeProblems(b);
    expect(p.steps.get(ids.decision)).toEqual(["Branches add up to 82%, not 100%."]);
    expect(p.total).toBe(1);
    // Publish does not stop for this today: the model builds.
    expect(blocks(b)).toBeNull();
  });

  it("pins what the model error names: a missing start, an extra line from the start, a line back to the start", () => {
    const noStart = { ...flat(), steps: flat().steps.filter((s) => s.kind !== "start"), edges: flat().edges.filter((e) => e.from_step_id !== ids.start) };
    expect(nodeProblems(noStart).process).toEqual(["Process needs exactly one start step, found 0."]);

    const b = flat();
    const twoLines = applyEdit(b, addEdge(b, ids.start, ids.discovery)!.edit);
    expect(nodeProblems(twoLines).steps.get(ids.start)).toEqual(["The start step needs exactly one line out of it, to the first step."]);
    // A line into the start step (the editor refuses to draw one, but a loaded draft could hold it).
    const back = { ...b, edges: [...b.edges, edgeRow(b, ids.live, ids.start, 0)] };
    const p = nodeProblems(back);
    const line = back.edges[back.edges.length - 1]!;
    expect(p.edges.get(line.id)).toEqual(["Nothing can lead back to the start step."]);
    expect(blocks(back)).toMatch(/leads back to the start step/);
  });

  it("pins a line to a step that isn't there", () => {
    const b = flat();
    const dangling = { ...b, steps: b.steps.filter((s) => s.id !== ids.won) };
    const p = nodeProblems(dangling);
    expect([...p.edges.keys()]).toEqual(b.edges.filter((e) => e.to_step_id === ids.won).map((e) => e.id));
    expect(p.total).toBe(1);
    expect(blocks(dangling)).toMatch(/points at a missing step/);
  });

  it("pins an empty group and a linked process that isn't published to their steps", () => {
    const b = flat();
    const group = groupRow(b, 10, 10, null);
    const grouped = { ...b, steps: [...b.steps, group], edges: [...b.edges, edgeRow(b, group.id, ids.won, 1)] };
    expect(nodeProblems(grouped).steps.get(group.id)).toEqual(["Group 'New group' has no steps."]);

    const holder: StepRow = { ...newStepRow(b, "task", null, 0, 0), name: "Delivery", kind: "subprocess", work_hours: 0, child_process_id: "11111111-1111-4111-8111-111111111111" };
    const held = { ...b, steps: [...b.steps, holder], edges: [...b.edges, edgeRow(b, holder.id, ids.won, 1)] };
    expect(nodeProblems(held).steps.get(holder.id)).toEqual(["Publish 'Delivery' first: this step links to it, and it has no published version yet."]);
  });

  it("has nothing to say about the company map", () => {
    const b = { ...flat(), process: { ...flat().process, is_company: true } };
    expect(nodeProblems(without(b, (e) => e.from_step_id === ids.audit)).total).toBe(0);
  });

  it("counts a step's several problems, and the line says one or many", () => {
    const b = without(flat(), (e) => e.from_step_id === ids.audit);
    const both = { ...b, edges: b.edges.map((e) => (e.from_step_id === ids.decision && e.to_step_id === ids.lost ? { ...e, probability: 0.5 } : e)) };
    const p = nodeProblems(both);
    expect(p.total).toBe(2);
    expect(problemsLine(1)).toBe("1 thing to fix before this can simulate");
    expect(problemsLine(2)).toBe("2 things to fix before this can simulate");
    // The first one on the map, in the order the steps are held.
    expect(firstProblem(both, p)).toEqual({ kind: "step", id: both.steps.find((s) => p.steps.has(s.id))!.id });
  });
});

describe("nodeProblems and Publish", () => {
  // Publish is blocked by a model error (`editor-view.tsx`: `workingModel.error`), by unsaved edits and by conflicts. The first is the
  // only one about the process itself, and it must always show up here: every draft the model refuses has at least one problem.
  const broken = (): Record<string, ProcessBundle> => {
    const b = flat();
    const group = groupRow(b, 10, 10, null);
    return {
      "no way out": without(b, (e) => e.from_step_id === ids.audit),
      "no start": { ...b, steps: b.steps.filter((s) => s.kind !== "start"), edges: b.edges.filter((e) => e.from_step_id !== ids.start) },
      "start unlinked": without(b, (e) => e.from_step_id === ids.start),
      "two starts": { ...b, steps: [...b.steps, { ...newStepRow(b, "start", null, 0, 0) }] },
      "missing target": { ...b, steps: b.steps.filter((s) => s.id !== ids.won) },
      "empty group": { ...b, steps: [...b.steps, group], edges: [...b.edges, edgeRow(b, group.id, ids.won, 1)] },
      "line into start": { ...b, edges: [...b.edges, edgeRow(b, ids.live, ids.start, 0)] },
      "link to an unpublished process": { ...b, steps: [...b.steps, { ...group, kind: "subprocess" as const, child_process_id: "11111111-1111-4111-8111-111111111111" }] },
    };
  };

  it("lists a problem for every draft the model refuses (so the editor never lets through what blocks Publish)", () => {
    for (const [name, b] of Object.entries(broken())) {
      const refused = blocks(b);
      expect(refused, `${name} should be refused`).not.toBeNull();
      expect(nodeProblems(b).total, name).toBeGreaterThanOrEqual(1);
    }
  });

  it("is stricter than Publish in one way: branches that don't add up to 100% are listed, though the model builds", () => {
    const b = flat();
    const off = { ...b, edges: b.edges.map((e) => (e.id === b.edges.find((x) => x.from_step_id === ids.qualify)!.id ? { ...e, probability: 0.1 } : e)) };
    expect(blocks(off)).toBeNull();
    expect(nodeProblems(off).total).toBe(1);
    expect(stepWarnings(off).size).toBe(1);
  });
});

describe("the Publish gate", () => {
  it("blocks while anything stops the process simulating, and says how many", async () => {
    const { publishBlocker } = await import("@/lib/editor/problems");
    expect(publishBlocker(0)).toBeNull();
    expect(publishBlocker(1)).toMatch(/Fix the thing marked in red/);
    expect(publishBlocker(3)).toMatch(/Fix the 3 things marked in red/);
  });
});
