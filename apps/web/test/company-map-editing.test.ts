import { describe, expect, it } from "vitest";
import { defaultCompanyPart, larkspurBundle, northbeamBundle, partOf, toEngineModel, type ProcessBundle, type ProcessPart } from "@transpera-flow/db";
import { addEdge, copySteps, deleteSelection, deleteSteps, isPlacedStep, moveSteps, newStepRow, updateEdge } from "@/lib/editor/commands";
import { groupSteps } from "@/lib/editor/groups";
import { applyEdit } from "@/lib/editor/ops";
import { splitStep } from "@/lib/editor/split";
import { describeChanges } from "@/lib/history/versions";
import { companyMap } from "@/lib/overview/company-map";

// Editing the company map in the Editor (issue #163, B11 slice 2): cards are moved, joined by handoff lines (with a label),
// put in groups; they are never copied, split or removed here (that comes with the process library, B12).

/** The Editor's bundle of Northbeam's company map: the stored map's holders and lines, on the workspace's roles and people. */
function companyBundle(): ProcessBundle {
  const base = northbeamBundle();
  const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
  const company = defaultCompanyPart(base.workspace.id, parts);
  return { ...base, process: company.process, revision: company.revision, steps: company.steps, edges: company.edges, retired: [], otherProcesses: parts };
}

describe("the company map in the Editor", () => {
  it("moves a card, and the move is the only change (a handoff line is not a branch)", () => {
    const b = companyBundle();
    const card = b.steps[0]!;
    const edit = moveSteps(b, [{ id: card.id, x: 400, y: 300 }]);
    expect(edit?.ops).toHaveLength(1);
    expect(edit!.label).toContain("Moved");
  });

  it("draws a handoff with a full share, and labels and relabels it", () => {
    const b = companyBundle();
    const [a, c] = [b.steps[0]!, b.steps[1]!];
    // Two holders may already be joined: use a pair with no line yet by drawing the other way round.
    const drawn = addEdge(b, c.id, a.id);
    expect(drawn).not.toBeNull();
    const insert = drawn!.edit.ops[0]!;
    expect(insert.kind).toBe("insert");
    if (insert.kind === "insert") expect(insert.edges[0]).toMatchObject({ probability: 1, label: null, from_step_id: c.id, to_step_id: a.id });
    const labelled = updateEdge(b, b.edges[0]!.id, { label: "Signed contract" });
    expect(labelled?.ops[0]).toMatchObject({ kind: "update", changes: [{ table: "edges", after: { label: "Signed contract" } }] });
  });

  it("does not take a process off the map: a card, a group of cards or a selection with one in it can't be deleted, copied or split", () => {
    const b = companyBundle();
    const card = b.steps[0]!;
    expect(isPlacedStep(b, card)).toBe(true);
    expect(deleteSteps(b, [card.id])).toBeNull();
    expect(deleteSelection(b, [card.id], [])).toBeNull();
    expect(copySteps(b, [card.id])).toBeNull();
    expect(splitStep(b, card.id)).toBeNull();
    // Cards can be put in a group; the group then holds them, so it can't be deleted either, and ungrouped, the cards are as before.
    const grouped = groupSteps(b, [b.steps[0]!.id, b.steps[1]!.id])!;
    const withGroup = applyEdit(b, grouped.edit);
    expect(withGroup.steps.filter((s) => s.parent_step_id === grouped.id)).toHaveLength(2);
    expect(deleteSteps(withGroup, [grouped.id])).toBeNull();
  });

  it("deletes a handoff line, and a group with no card in it", () => {
    const b = companyBundle();
    const line = b.edges[0]!;
    expect(deleteSelection(b, [], [line.id])?.ops[0]).toMatchObject({ kind: "remove" });
    const group = { ...newStepRow(b, "task", null, 0, 0), kind: "group" as const, name: "Empty box", work_hours: 0 };
    expect(deleteSteps({ ...b, steps: [...b.steps, group] }, [group.id])?.ops.at(-1)).toMatchObject({ kind: "remove" });
  });

  it("is never simulated: the engine refuses it, and an ordinary process is unaffected by the map", () => {
    const b = companyBundle();
    expect(() => toEngineModel(b)).toThrow(/company map/);
    const other = larkspurBundle();
    expect(isPlacedStep(other, other.steps[0]!)).toBe(false);
    expect(deleteSteps(other, [other.steps.find((s) => s.kind === "task")!.id])).not.toBeNull();
  });

  it("shows handoff labels on the Overview's map", () => {
    const base = northbeamBundle();
    const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
    const stored = defaultCompanyPart(base.workspace.id, parts);
    const labelled = { ...stored, edges: stored.edges.map((e, i) => (i === 0 ? { ...e, label: "Won deals" } : e)) };
    const map = companyMap(base, parts, new Set(), labelled);
    expect(map.bundle.edges.filter((e) => e.label === "Won deals")).toHaveLength(1);
  });
});

describe("the company map's history", () => {
  it("counts what changed for a person's publish, and says what a system-made version did in words", () => {
    expect(describeChanges({ steps: { added: 0, removed: 0, changed: 0 }, edges: { added: 1, removed: 0, changed: 1 } }, false)).toBe("1 connection changed, 1 connection added");
    expect(describeChanges(null, true)).toBe("First version");
  });
});
