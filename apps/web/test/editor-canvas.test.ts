import { describe, expect, it } from "vitest";
import {
  northbeamBundle,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamStepIds,
  type ProcessBundle,
} from "@transpera-flow/db";
import {
  copySteps,
  deleteSelection,
  duplicateSteps,
  kindProblem,
  moveSteps,
  pasteSteps,
  pinPerson,
  setDistribution,
  setReworkTarget,
  setStepKind,
  updateStep,
} from "@/lib/editor/commands";
import { ProcessEditor } from "@/lib/editor/editor";
import { commitInline, inlineDraft, parseHours } from "@/lib/editor/inline-edit";
import { NO_ROLE_LANE, assignLanes, laneLayout } from "@/lib/editor/lanes";
import { applyEdit, invertEdit, type Edit } from "@/lib/editor/ops";
import { MemoryStore } from "@/lib/editor/store";
import { parseNewEdge, parseNewStep } from "@/lib/editor/validate";

// Part 2 of canvas editing (issue #8): duplicate and paste, multi-select
// delete and move, change kind, pin, rework target, inline edits, swimlanes.

const ids = northbeamStepIds;
const step = (b: ProcessBundle, id: string) => b.steps.find((s) => s.id === id)!;
const sorted = (b: Pick<ProcessBundle, "steps" | "edges">) => ({
  steps: [...b.steps].sort((x, y) => x.id.localeCompare(y.id)),
  edges: [...b.edges].sort((x, y) => x.id.localeCompare(y.id)),
});
const edgeBetween = (b: ProcessBundle, from: string, to: string) => b.edges.find((e) => e.from_step_id === from && e.to_step_id === to);

function setup() {
  const bundle = northbeamBundle();
  const memory = new MemoryStore(bundle);
  const editor = new ProcessEditor(bundle, memory);
  return { bundle, memory, editor, now: () => editor.getState().bundle };
}

describe("duplicate and paste", () => {
  it("gives pasted steps and edges new ids, copies and remaps connections among them, and drops the rest", () => {
    const b = northbeamBundle();
    // onboard → kickoff → seo, ppc: copy onboard, kickoff and seo.
    const made = duplicateSteps(b, [ids.onboard, ids.kickoff, ids.seo])!;
    const after = applyEdit(b, made.edit);
    const [onboard, kickoff, seo] = made.ids.map((id) => step(after, id));
    expect(made.ids).toHaveLength(3);
    for (const id of made.ids) expect(Object.values(ids)).not.toContain(id);
    expect(new Set(made.ids).size).toBe(3);
    expect([onboard!.name, kickoff!.name, seo!.name]).toEqual(["Contract & onboarding (copy)", "Kickoff & strategy (copy)", "SEO campaign setup (copy)"]);

    // Internal edges come along, pointing at the copies, with new ids and the same shares.
    const pasted = after.edges.filter((e) => made.ids.includes(e.from_step_id) || made.ids.includes(e.to_step_id));
    expect(pasted.map((e) => [e.from_step_id, e.to_step_id, e.probability]).sort()).toEqual(
      [
        [onboard!.id, kickoff!.id, 1],
        [kickoff!.id, seo!.id, 0.55],
      ].sort(),
    );
    for (const e of pasted) expect(b.edges.some((o) => o.id === e.id)).toBe(false);
    // Edges to steps that weren't copied (decision → onboard, kickoff → ppc, seo → live) are not.
    expect(edgeBetween(after, kickoff!.id, ids.ppc)).toBeUndefined();
    expect(edgeBetween(after, seo!.id, ids.live)).toBeUndefined();
    expect(after.edges.filter((e) => e.to_step_id === onboard!.id)).toEqual([]);

    // Everything that was there is untouched.
    expect(sorted({ steps: after.steps.filter((s) => !made.ids.includes(s.id)), edges: after.edges.filter((e) => !pasted.includes(e)) })).toEqual(sorted(b));
    // Offset from the originals, in the same revision.
    expect(onboard).toMatchObject({ x: 100, y: 330, revision_id: b.revision.id, role_id: northbeamRoleIds.am });
  });

  it("remaps rework targets inside the copied steps and keeps ones outside", () => {
    let b = northbeamBundle();
    b = applyEdit(b, setReworkTarget(b, ids.seo, ids.kickoff)!);
    b = applyEdit(b, setReworkTarget(b, ids.kickoff, ids.onboard)!);
    b = applyEdit(b, updateStep(b, ids.kickoff, { current_wip: 3 })!);
    const made = duplicateSteps(b, [ids.kickoff, ids.seo])!;
    const after = applyEdit(b, made.edit);
    const [kickoff, seo] = made.ids.map((id) => step(after, id));
    expect(seo!.rework_to_step_id).toBe(kickoff!.id);
    expect(kickoff!.rework_to_step_id).toBe(ids.onboard);
    // Nothing is waiting at a brand-new step.
    expect(kickoff!.current_wip).toBeNull();
    // The originals keep theirs.
    expect(step(after, ids.seo).rework_to_step_id).toBe(ids.kickoff);
  });

  it("pastes a snapshot: later edits don't change it, and a rework target deleted since is cleared", () => {
    let b = northbeamBundle();
    b = applyEdit(b, setReworkTarget(b, ids.seo, ids.audit)!);
    const clip = copySteps(b, [ids.seo])!;
    b = applyEdit(b, updateStep(b, ids.seo, { name: "Renamed" })!);
    b = applyEdit(b, deleteSelection(b, [ids.audit], [])!);
    const first = pasteSteps(b, clip, { x: 40, y: 40 })!;
    const second = pasteSteps(b, clip, { x: 80, y: 80 })!;
    expect(first.ids[0]).not.toBe(second.ids[0]);
    const pasted = step(applyEdit(b, first.edit), first.ids[0]!);
    expect(pasted).toMatchObject({ name: "SEO campaign setup (copy)", rework_to_step_id: null, x: 560, y: 276 });
    expect(first.edit.label).toBe("Pasted SEO campaign setup");
  });

  it("leaves out the start step, since a process has one", () => {
    const b = northbeamBundle();
    expect(copySteps(b, [ids.start])).toBeNull();
    expect(duplicateSteps(b, [ids.start])).toBeNull();
    const made = duplicateSteps(b, [ids.start, ids.qualify])!;
    expect(made.ids).toHaveLength(1);
    expect(applyEdit(b, made.edit).edges.filter((e) => e.to_step_id === made.ids[0])).toEqual([]);
  });

  it("pasted rows are rows the server accepts", () => {
    const b = northbeamBundle();
    const made = duplicateSteps(b, [ids.onboard, ids.kickoff, ids.won])!;
    const op = made.edit.ops[0]!;
    if (op.kind !== "insert") throw new Error("expected an insert");
    for (const s of op.steps) expect(parseNewStep(s)).not.toBeNull();
    for (const e of op.edges) expect(parseNewEdge(e)).not.toBeNull();
    expect(op.steps.find((s) => s.kind === "end")).toMatchObject({ outcome: "won" });
  });

  it("a duplicate is one undo step, saved, and undo removes exactly what it added", async () => {
    const { bundle, memory, editor, now } = setup();
    let made: string[] = [];
    editor.run((b) => {
      const r = duplicateSteps(b, [ids.onboard, ids.kickoff])!;
      made = r.ids;
      return r.edit;
    });
    await editor.settled();
    expect(memory.snapshot().steps).toHaveLength(bundle.steps.length + 2);
    expect(editor.getState().undoLabel).toBe("Duplicated 2 steps");
    editor.undo();
    await editor.settled();
    expect(sorted(now())).toEqual(sorted(bundle));
    expect(sorted(memory.snapshot())).toEqual(sorted(bundle));
    editor.redo();
    await editor.settled();
    // Redo brings back the same ids: they were made once, when the edit was built.
    expect(made.every((id) => memory.snapshot().steps.some((s) => s.id === id))).toBe(true);
  });
});

describe("multi-select", () => {
  it("deleting several steps and edges is one edit; one undo restores all of it, in the store too", async () => {
    const { bundle, memory, editor, now } = setup();
    const stray = edgeBetween(bundle, ids.qualify, ids.lost)!.id;
    editor.run((b) => deleteSelection(b, [ids.seo, ids.ppc, ids.kickoff], [stray]));
    await editor.settled();
    expect(editor.getState().undoLabel).toBe("Deleted 3 steps");
    expect(now().steps).toHaveLength(bundle.steps.length - 3);
    expect(now().edges.some((e) => e.id === stray)).toBe(false);
    expect(memory.snapshot().steps).toHaveLength(bundle.steps.length - 3);
    expect(editor.undo()).toBe(true);
    await editor.settled();
    expect(sorted(now())).toEqual(sorted(bundle));
    expect(sorted(memory.snapshot())).toEqual(sorted(bundle));
    expect(editor.getState().undoLabel).toBeNull();
  });

  it("moving several steps together is one undo step", async () => {
    const { bundle, editor, now } = setup();
    editor.run((b) =>
      moveSteps(b, [
        { id: ids.seo, x: 600, y: 250 },
        { id: ids.ppc, x: 600, y: 360 },
      ]),
    );
    expect(editor.getState().undoLabel).toBe("Moved 2 steps");
    editor.undo();
    await editor.settled();
    expect(sorted(now())).toEqual(sorted(bundle));
  });
});

describe("change kind", () => {
  it("making a step an end drops its outgoing connections and rework pointing at it; the inverse restores them", () => {
    let b = northbeamBundle();
    b = applyEdit(b, setReworkTarget(b, ids.seo, ids.kickoff)!);
    const edit = setStepKind(b, ids.kickoff, "end")!;
    expect(edit.label).toBe("Made Kickoff & strategy an end step");
    const after = applyEdit(b, edit);
    expect(step(after, ids.kickoff)).toMatchObject({ kind: "end", outcome: "done" });
    expect(after.edges.filter((e) => e.from_step_id === ids.kickoff)).toEqual([]);
    expect(after.edges.filter((e) => e.to_step_id === ids.kickoff)).toHaveLength(1);
    expect(step(after, ids.seo).rework_to_step_id).toBeNull();
    expect(sorted(applyEdit(after, invertEdit(edit)))).toEqual(sorted(b));
  });

  it("making the start step a task and back keeps (kind = 'end') = (outcome is not null)", () => {
    let b = northbeamBundle();
    const edits: Edit[] = [];
    for (const kind of ["task", "end", "decision", "start"] as const) {
      const edit = setStepKind(b, ids.start, kind)!;
      edits.push(edit);
      b = applyEdit(b, edit);
      expect((step(b, ids.start).kind === "end") === (step(b, ids.start).outcome !== null)).toBe(true);
    }
    // Becoming an end dropped the start's edge; becoming the start again has nothing to drop.
    expect(b.edges.some((e) => e.from_step_id === ids.start)).toBe(false);
    for (const edit of edits.reverse()) b = applyEdit(b, invertEdit(edit));
    expect(sorted(b)).toEqual(sorted(northbeamBundle()));
  });

  it("refuses a second start step", () => {
    const b = northbeamBundle();
    expect(kindProblem(b, ids.audit, "start")).toMatch(/already has a start/);
    expect(setStepKind(b, ids.audit, "start")).toBeNull();
    expect(kindProblem(b, ids.start, "start")).toBeNull();
    // Already a task: nothing to do.
    expect(setStepKind(b, ids.audit, "task")).toBeNull();
  });

  it("is saved and undone through the editor", async () => {
    const { bundle, memory, editor } = setup();
    editor.run((b) => setStepKind(b, ids.live, "end"));
    await editor.settled();
    expect(memory.snapshot().steps.find((s) => s.id === ids.live)).toMatchObject({ kind: "end", outcome: "done" });
    expect(memory.snapshot().edges.some((e) => e.from_step_id === ids.live)).toBe(false);
    editor.undo();
    await editor.settled();
    expect(sorted(memory.snapshot())).toEqual(sorted(bundle));
  });
});

describe("pin to person and rework target", () => {
  it("pins and unpins, refusing people who don't exist", () => {
    const b = northbeamBundle();
    const priya = northbeamPersonIds["Priya Shah"]!;
    const pinned = applyEdit(b, pinPerson(b, ids.qualify, priya)!);
    expect(step(pinned, ids.qualify).person_id).toBe(priya);
    expect(pinPerson(pinned, ids.qualify, priya)).toBeNull();
    expect(pinPerson(b, ids.qualify, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(pinPerson(pinned, ids.qualify, null)!.label).toBe("Unpinned Qualify lead");
  });

  it("sends rework back to another working step only", () => {
    const b = northbeamBundle();
    expect(setReworkTarget(b, ids.audit, ids.discovery)!.label).toBe("Sent Audit & proposal's rework back to Discovery call");
    expect(setReworkTarget(b, ids.audit, ids.audit)).toBeNull();
    expect(setReworkTarget(b, ids.audit, ids.won)).toBeNull();
    expect(setReworkTarget(b, ids.audit, ids.start)).toBeNull();
    expect(setReworkTarget(b, ids.audit, null)).toBeNull();
  });
});

describe("inline editing", () => {
  it("commits one field at a time as its own undo step, saved per field", async () => {
    const { bundle, memory, editor, now } = setup();
    const commit = (field: Parameters<typeof commitInline>[2], text: string) => {
      const r = commitInline(editor.getState().bundle, ids.audit, field, text);
      if ("error" in r) throw new Error(r.error);
      return editor.run(() => r.edit);
    };
    expect(commit("name", "  Audit  ")).toBe(true);
    expect(commit("work_hours", "4.5h")).toBe(true);
    expect(commit("role_id", northbeamRoleIds.sales)).toBe(true);
    expect(commit("person_id", northbeamPersonIds["Tom Reed"]!)).toBe(true);
    await editor.settled();
    expect(step(now(), ids.audit)).toMatchObject({ name: "Audit", work_hours: 4.5, role_id: northbeamRoleIds.sales });
    expect(memory.snapshot().steps.find((s) => s.id === ids.audit)).toMatchObject({ name: "Audit", work_hours: 4.5 });
    // Committing what is already stored (a blur after Enter, or no change) saves nothing.
    expect(commit("name", "Audit")).toBe(false);
    expect(inlineDraft(now(), ids.audit, "work_hours")).toBe("4.5");
    for (let i = 0; i < 4; i++) editor.undo();
    await editor.settled();
    expect(sorted(now())).toEqual(sorted(bundle));
    expect(sorted(memory.snapshot())).toEqual(sorted(bundle));
  });

  it("refuses what can't be saved, so cancelling or fixing it leaves the step as it was", () => {
    const b = northbeamBundle();
    expect(commitInline(b, ids.audit, "name", "   ")).toEqual({ error: "A step needs a name." });
    expect(commitInline(b, ids.audit, "work_hours", "-1")).toEqual({ error: "Enter hours, 0 or more." });
    expect(commitInline(b, ids.audit, "wait_hours", "soon")).toEqual({ error: "Enter hours, 0 or more." });
    expect(commitInline(b, ids.audit, "role_id", "00000000-0000-4000-8000-000000000000")).toEqual({ error: "Pick one from the list." });
    expect(commitInline(b, ids.audit, "role_id", "")).toMatchObject({ edit: { ops: [{ changes: [{ after: { role_id: null } }] }] } });
    expect(parseHours(".5")).toBe(0.5);
    expect(parseHours("2 h")).toBe(2);
    expect(parseHours("")).toBeNull();
  });

  it("scales a triangular range to a new mean", () => {
    let b = northbeamBundle();
    b = applyEdit(b, setDistribution(b, ids.audit, "work", "triangular")!); // 3, 6, 9
    const r = commitInline(b, ids.audit, "work_hours", "12");
    if ("error" in r) throw new Error(r.error);
    b = applyEdit(b, r.edit!);
    expect(step(b, ids.audit)).toMatchObject({ work_hours: 12, work_params: { min: 6, mode: 12, max: 18 } });
  });
});

describe("swimlanes", () => {
  it("puts steps in their role's lane, start and end steps next to their work, and the rest in No role", () => {
    const b = northbeamBundle();
    const lanes = assignLanes(b);
    expect(lanes.get(ids.qualify)).toBe(northbeamRoleIds.sales);
    expect(lanes.get(ids.start)).toBe(northbeamRoleIds.sales);
    expect(lanes.get(ids.won)).toBe(northbeamRoleIds.am);
    // Lost's likeliest source is the client decision (no role); the next is Qualify (Sales).
    expect(lanes.get(ids.lost)).toBe(northbeamRoleIds.sales);
    expect(lanes.get(ids.decision)).toBe(NO_ROLE_LANE);
    // A step pinned to a person without a role goes in that person's role's lane.
    const pinned = applyEdit(b, updateStep(b, ids.decision, { person_id: northbeamPersonIds["Rosa Diaz"]! })!);
    expect(assignLanes(pinned).get(ids.decision)).toBe(northbeamRoleIds.fin);
  });

  it("lays lanes out top to bottom in role order, keeps x, and never overlaps steps", () => {
    const b = northbeamBundle();
    const { lanes, positions, laneOf } = laneLayout(b);
    expect(lanes.map((l) => l.label)).toEqual(["Sales", "Strategist", "Account manager", "SEO specialist", "PPC specialist", "No role"]);
    for (let i = 1; i < lanes.length; i++) expect(lanes[i]!.y).toBe(lanes[i - 1]!.y + lanes[i - 1]!.height);
    for (const s of b.steps) {
      const p = positions.get(s.id)!;
      const lane = lanes.find((l) => l.key === laneOf.get(s.id))!;
      expect(p.x).toBe(Number(s.x));
      expect(p.y).toBeGreaterThanOrEqual(lane.y);
      expect(p.y).toBeLessThan(lane.y + lane.height);
    }
    // Two steps at the same x in one lane go in separate rows.
    const moved = applyEdit(b, moveSteps(b, [{ id: ids.discovery, x: 60, y: 50 }])!);
    const layout = laneLayout(moved);
    expect(layout.positions.get(ids.discovery)!.y).not.toBe(layout.positions.get(ids.qualify)!.y);
  });
});
