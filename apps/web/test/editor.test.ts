import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamStepIds, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import {
  addEdge,
  addStep,
  connectionProblem,
  deleteSelection,
  deleteSteps,
  moveSteps,
  reconnectEdge,
  setDistribution,
  setRangePoint,
  setStepKind,
  setStepPurposes,
  stepWarnings,
  updateEdge,
  updateStep,
} from "@/lib/editor/commands";
import { GONE, ProcessEditor } from "@/lib/editor/editor";
import { applyEdit, invertEdit, type Edit } from "@/lib/editor/ops";
import { MemoryStore, type ProcessStore } from "@/lib/editor/store";
import { describeValue, fieldLabel, namesOf } from "@/lib/editor/describe";

const ids = northbeamStepIds;
const ids_ = (b: ProcessBundle) => ({ steps: b.steps.map((s) => s.id).sort(), edges: b.edges.map((e) => e.id).sort() });
const step = (b: ProcessBundle, id: string) => b.steps.find((s) => s.id === id)!;
const edgesOf = (b: ProcessBundle, id: string) => b.edges.filter((e) => e.from_step_id === id || e.to_step_id === id);
/** The bundle with rows in a fixed order, to compare contents regardless of order. */
const sorted = (b: ProcessBundle) => ({
  steps: [...b.steps].sort((x, y) => x.id.localeCompare(y.id)),
  edges: [...b.edges].sort((x, y) => x.id.localeCompare(y.id)),
});

function setup(store?: ProcessStore) {
  const bundle = northbeamBundle();
  const memory = new MemoryStore(bundle);
  const editor = new ProcessEditor(bundle, store ?? memory);
  return { bundle, memory, editor, now: () => editor.getState().bundle };
}

describe("edit operations", () => {
  it("every edit's inverse restores the process exactly", () => {
    const b = northbeamBundle();
    const edits: Edit[] = [
      addStep(b, { kind: "task", x: 10, y: 20 }).edit,
      deleteSteps(b, [ids.kickoff])!,
      moveSteps(b, [{ id: ids.audit, x: 1, y: 2 }])!,
      updateStep(b, ids.audit, { name: "Audit", work_hours: 3, current_wip: 2 })!,
      addEdge(b, ids.qualify, ids.won)!.edit,
      updateEdge(b, b.edges[1]!.id, { probability: 0.5, condition_tag: "ppc" })!,
      deleteSelection(b, [ids.seo], [b.edges[0]!.id])!,
    ];
    for (const edit of edits) {
      const after = applyEdit(b, edit);
      expect(after).not.toEqual(b);
      expect(sorted(applyEdit(after, invertEdit(edit)))).toEqual(sorted(b));
    }
  });

  it("deleting a step takes its edges and clears rework targets pointing at it; the inverse puts all of it back", () => {
    let b = northbeamBundle();
    b = applyEdit(b, updateStep(b, ids.onboard, { rework_to_step_id: ids.kickoff })!);
    const edit = deleteSteps(b, [ids.kickoff])!;
    const after = applyEdit(b, edit);
    expect(after.steps.some((s) => s.id === ids.kickoff)).toBe(false);
    expect(edgesOf(after, ids.kickoff)).toEqual([]);
    expect(edgesOf(b, ids.kickoff)).toHaveLength(3);
    expect(step(after, ids.onboard).rework_to_step_id).toBeNull();
    const back = applyEdit(after, invertEdit(edit));
    expect(sorted(back)).toEqual(sorted(b));
    expect(step(back, ids.onboard).rework_to_step_id).toBe(ids.kickoff);
  });

  it("returns nothing for edits that change nothing", () => {
    const b = northbeamBundle();
    expect(moveSteps(b, [{ id: ids.audit, x: 520, y: 50 }])).toBeNull();
    expect(updateStep(b, ids.audit, { name: "Audit & proposal", work_hours: 6 })).toBeNull();
    expect(deleteSteps(b, ["00000000-0000-4000-8000-000000000000"])).toBeNull();
  });

  it("only records the fields that change, with what they were", () => {
    const b = northbeamBundle();
    const edit = updateStep(b, ids.audit, { name: "Audit & proposal", work_hours: 4 })!;
    expect(edit.ops).toEqual([{ kind: "update", changes: [{ table: "steps", id: ids.audit, before: { work_hours: 6 }, after: { work_hours: 4 } }] }]);
  });

  it("gives new steps and edges fresh ids and sensible defaults", () => {
    const b = northbeamBundle();
    const end = addStep(b, { kind: "end", x: 0, y: 0 });
    const task = addStep(b, { kind: "task", x: 0, y: 0 });
    expect(end.id).not.toBe(task.id);
    const endRow = applyEdit(b, end.edit).steps.at(-1)!;
    // Won and lost exist, so a new end step is "done"; the table requires an outcome on end steps.
    expect(endRow).toMatchObject({ id: end.id, kind: "end", outcome: "done", revision_id: b.revision.id });
    expect(applyEdit(b, task.edit).steps.at(-1)).toMatchObject({ kind: "task", outcome: null, work_hours: 1 });
  });

  it("a new branch takes the share the step's other branches leave", () => {
    const b = northbeamBundle();
    const made = addEdge(b, ids.qualify, ids.audit)!;
    expect(applyEdit(b, made.edit).edges.find((e) => e.id === made.id)!.probability).toBe(0);
    let c = applyEdit(b, updateEdge(b, b.edges.find((e) => e.from_step_id === ids.qualify && e.to_step_id === ids.lost)!.id, { probability: 0.25 })!);
    const next = addEdge(c, ids.qualify, ids.audit)!;
    c = applyEdit(c, next.edit);
    expect(c.edges.find((e) => e.id === next.id)!.probability).toBe(0.2);
    expect(stepWarnings(c).has(ids.qualify)).toBe(false);
  });

  it("refuses connections that make no sense", () => {
    const b = northbeamBundle();
    expect(connectionProblem(b, ids.audit, ids.audit)).toMatch(/itself/);
    expect(connectionProblem(b, ids.won, ids.audit)).toMatch(/End steps/);
    expect(connectionProblem(b, ids.audit, ids.start)).toMatch(/start step/);
    expect(connectionProblem(b, ids.qualify, ids.discovery)).toMatch(/already connected/);
    expect(addEdge(b, ids.qualify, ids.discovery)).toBeNull();
    const e = b.edges.find((x) => x.from_step_id === ids.qualify && x.to_step_id === ids.discovery)!;
    expect(reconnectEdge(b, e.id, ids.qualify, ids.discovery)).toBeNull();
    const rerouted = applyEdit(b, reconnectEdge(b, e.id, ids.qualify, ids.audit)!);
    expect(rerouted.edges.find((x) => x.id === e.id)).toMatchObject({ from_step_id: ids.qualify, to_step_id: ids.audit, probability: 0.55 });
  });

  it("flags steps whose branches don't add up to 100% or that lead nowhere", () => {
    let b = northbeamBundle();
    expect(stepWarnings(b).size).toBe(0);
    const qualifyLost = b.edges.find((e) => e.from_step_id === ids.qualify && e.to_step_id === ids.lost)!;
    b = applyEdit(b, updateEdge(b, qualifyLost.id, { probability: 0.5 })!);
    expect(stepWarnings(b).get(ids.qualify)).toBe("Branches add up to 105%, not 100%.");
    const added = addStep(b, { kind: "task", x: 0, y: 0 });
    b = applyEdit(b, added.edit);
    expect(stepWarnings(b).get(added.id)).toMatch(/Nothing leaves this step/);
  });

  it("keeps a step's kind and outcome consistent", () => {
    const b = northbeamBundle();
    expect(setStepKind(b, ids.audit, "end")!.ops[0]).toMatchObject({ kind: "update", changes: [{ after: { kind: "end", outcome: "done" } }] });
    expect(setStepKind(b, ids.won, "task")!.ops[0]).toMatchObject({ changes: [{ before: { kind: "end", outcome: "won" }, after: { kind: "task", outcome: null } }] });
  });

  it("keeps a triangular range ordered and its mean in step", () => {
    let b = northbeamBundle();
    b = applyEdit(b, setDistribution(b, ids.audit, "work", "triangular")!);
    expect(step(b, ids.audit)).toMatchObject({ work_dist: "triangular", work_params: { min: 3, mode: 6, max: 9 }, work_hours: 6 });
    b = applyEdit(b, setRangePoint(b, ids.audit, "work", "min", 7)!);
    expect(step(b, ids.audit)).toMatchObject({ work_params: { min: 7, mode: 7, max: 9 }, work_hours: 7.667 });
    const engineStep = toEngineModel(b).steps.find((s) => s.id === ids.audit)!;
    expect(engineStep.workDist).toEqual({ kind: "triangular", min: 7, mode: 7, max: 9 });
  });
});

describe("ProcessEditor", () => {
  it("applies edits at once and saves them, in order", async () => {
    const { editor, memory, now } = setup();
    let id = "";
    editor.run((b) => {
      const made = addStep(b, { kind: "task", x: 5, y: 5 });
      id = made.id;
      return made.edit;
    });
    editor.run((b) => updateStep(b, id, { name: "Send welcome pack" }));
    editor.run((b) => addEdge(b, ids.onboard, id)?.edit ?? null);
    expect(step(now(), id).name).toBe("Send welcome pack");
    expect(editor.getState().saving).toBe(true);
    await editor.settled();
    expect(editor.getState().saving).toBe(false);
    expect(sorted({ ...now(), ...memory.snapshot() })).toEqual(sorted(now()));
  });

  it("undo and redo cover every edit, and each is saved", async () => {
    const { editor, memory, bundle, now } = setup();
    editor.run((b) => moveSteps(b, [{ id: ids.audit, x: 600, y: 80 }]));
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 2 }));
    editor.run((b) => deleteSteps(b, [ids.kickoff]));
    expect(editor.getState().undoLabel).toBe("Deleted Kickoff & strategy");
    await editor.settled();
    expect(memory.snapshot().edges).toHaveLength(bundle.edges.length - 3);

    expect(editor.undo()).toBe(true);
    await editor.settled();
    expect(memory.snapshot().edges).toHaveLength(bundle.edges.length);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(false);
    await editor.settled();
    expect(sorted(now())).toEqual(sorted(bundle));
    expect(sorted({ ...bundle, ...memory.snapshot() })).toEqual(sorted(bundle));
    expect(editor.getState().redoLabel).toBe("Moved Audit & proposal");

    editor.redo();
    editor.redo();
    editor.redo();
    await editor.settled();
    expect(step(now(), ids.audit)).toMatchObject({ x: 600, y: 80, work_hours: 2 });
    expect(now().steps.some((s) => s.id === ids.kickoff)).toBe(false);
    expect(sorted({ ...bundle, ...memory.snapshot() })).toEqual(sorted(now()));
  });

  it("a new edit clears redo", () => {
    const { editor } = setup();
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 2 }));
    editor.undo();
    expect(editor.getState().redoLabel).not.toBeNull();
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 3 }));
    expect(editor.getState().redoLabel).toBeNull();
  });

  it("never changes step ids: after edits, undo, redo and a reload they are the same", async () => {
    const { editor, memory, bundle, now } = setup();
    let added = "";
    editor.run((b) => {
      const made = addStep(b, { kind: "task", x: 0, y: 0 });
      added = made.id;
      return made.edit;
    });
    editor.run((b) => updateStep(b, ids.audit, { name: "Audit", kind: "wait" }));
    editor.run((b) => moveSteps(b, [{ id: ids.seo, x: 1, y: 1 }]));
    editor.run((b) => deleteSteps(b, [ids.ppc]));
    editor.undo();
    editor.redo();
    editor.undo();
    await editor.settled();
    const expected = [...bundle.steps.map((s) => s.id), added].sort();
    expect(ids_(now()).steps).toEqual(expected);
    // Reload: a fresh editor over what the store holds.
    const reloaded = new ProcessEditor({ ...bundle, ...memory.snapshot() }, memory).getState().bundle;
    expect(ids_(reloaded)).toEqual(ids_(now()));
    expect(step(reloaded, ids.audit)).toMatchObject({ name: "Audit", kind: "wait" });
  });

  it("surfaces a same-field conflict instead of overwriting, and resolves it either way", async () => {
    const { editor, memory, now } = setup();
    // Someone else sets the hands-on time to 8 after we loaded it as 6.
    await memory.update("steps", ids.audit, { work_hours: 6 }, { work_hours: 8 });
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4, name: "Audit" }));
    await editor.settled();
    const [conflict] = editor.getState().conflicts;
    expect(conflict).toEqual({ table: "steps", id: ids.audit, field: "work_hours", mine: 4, theirs: 8 });
    // The other field saved; ours stays on screen; theirs is still stored.
    expect(memory.snapshot().steps.find((s) => s.id === ids.audit)).toMatchObject({ name: "Audit", work_hours: 8 });
    expect(step(now(), ids.audit).work_hours).toBe(4);

    editor.keepTheirs(conflict!);
    expect(editor.getState().conflicts).toEqual([]);
    expect(step(now(), ids.audit).work_hours).toBe(8);

    // Again, keeping ours this time.
    await memory.update("steps", ids.audit, { work_hours: 8 }, { work_hours: 9 });
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 5 }));
    await editor.settled();
    await editor.keepMine(editor.getState().conflicts[0]!);
    expect(editor.getState().conflicts).toEqual([]);
    expect(memory.snapshot().steps.find((s) => s.id === ids.audit)!.work_hours).toBe(5);
  });

  it("an undo that meets someone else's change is a conflict too", async () => {
    const { editor, memory } = setup();
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    await memory.update("steps", ids.audit, { work_hours: 4 }, { work_hours: 7 });
    editor.undo();
    await editor.settled();
    expect(editor.getState().conflicts).toEqual([{ table: "steps", id: ids.audit, field: "work_hours", mine: 6, theirs: 7 }]);
    expect(memory.snapshot().steps.find((s) => s.id === ids.audit)!.work_hours).toBe(7);
  });

  it("rolls back an edit that can't be saved, and drops it from history", async () => {
    const memory = new MemoryStore(northbeamBundle());
    const failing: ProcessStore = {
      insert: async () => ({ status: "error", message: "You don't have permission to edit this process." }),
      remove: (s, e) => memory.remove(s, e),
      update: async () => ({ status: "not_found" }),
    };
    const { editor, bundle, now } = setup(failing);
    editor.run((b) => addStep(b, { kind: "task", x: 0, y: 0 }).edit);
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 1 }));
    expect(now().steps).toHaveLength(bundle.steps.length + 1);
    await editor.settled();
    expect(sorted(now())).toEqual(sorted(bundle));
    expect(editor.getState().undoLabel).toBeNull();
    expect(editor.getState().error).toContain(GONE);
    editor.dismissError();
    expect(editor.getState().error).toBeNull();
  });

  it("a failed undo leaves the edit where undo can try again", async () => {
    let fail = false;
    const memory = new MemoryStore(northbeamBundle());
    const flaky: ProcessStore = {
      insert: (s, e) => memory.insert(s, e),
      remove: (s, e) => memory.remove(s, e),
      update: async (...args) => (fail ? { status: "error", message: "Offline." } : memory.update(...args)),
    };
    const { editor, now } = setup(flaky);
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    fail = true;
    editor.undo();
    await editor.settled();
    expect(step(now(), ids.audit).work_hours).toBe(4);
    expect(editor.getState().undoLabel).toBe("Changed Audit & proposal");
    fail = false;
    editor.undo();
    await editor.settled();
    expect(step(now(), ids.audit).work_hours).toBe(6);
  });
});

describe("MemoryStore", () => {
  it("inserts, removes (with the step's edges) and updates with compare-and-set", async () => {
    const b = northbeamBundle();
    const store = new MemoryStore(b);
    const made = addStep(b, { kind: "task", x: 0, y: 0 });
    const op = made.edit.ops[0]!;
    if (op.kind !== "insert") throw new Error("expected an insert");
    expect(await store.insert(op.steps, [])).toEqual({ status: "ok" });
    expect(await store.insert(op.steps, [])).toMatchObject({ status: "error" });
    expect(await store.update("steps", made.id, { name: "New task" }, { name: "Renamed" })).toEqual({ status: "saved" });
    // A retry of the same save is fine; a stale base is a conflict.
    expect(await store.update("steps", made.id, { name: "New task" }, { name: "Renamed" })).toEqual({ status: "saved" });
    expect(await store.update("steps", made.id, { name: "New task" }, { name: "Other" })).toEqual({ status: "conflict", theirs: { name: "Renamed" } });
    expect(await store.update("steps", made.id, { "work_params.cv": null }, { "work_params.cv": 0.5 })).toEqual({ status: "saved" });
    expect(store.snapshot().steps.find((s) => s.id === made.id)!.work_params).toEqual({ cv: 0.5 });
    await store.remove([ids.kickoff], []);
    expect(store.snapshot().edges.filter((e) => e.from_step_id === ids.kickoff || e.to_step_id === ids.kickoff)).toEqual([]);
    expect(await store.update("steps", ids.kickoff, { name: "x" }, { name: "y" })).toEqual({ status: "not_found" });
  });
});


describe("what a step achieves (sandbox phase 4)", () => {
  it("setStepPurposes is one edit with one change per working step whose value differs, labelled by how many", () => {
    const b = northbeamBundle();
    const edit = setStepPurposes(b, [ids.audit, ids.kickoff, ids.qualify], "coordination")!;
    expect(edit.ops).toHaveLength(1);
    expect(edit.ops[0]).toMatchObject({ kind: "update" });
    const changes = (edit.ops[0] as { changes: { id: string; before: object; after: object }[] }).changes;
    expect(changes.map((c) => c.id).sort()).toEqual([ids.audit, ids.kickoff, ids.qualify].sort());
    expect(changes[0]!.before).toEqual({ purpose: null });
    expect(edit.label).toBe("Changed what 3 steps achieve");
    expect(setStepPurposes(b, [ids.audit], "fixing")!.label).toBe("Changed what Audit & proposal achieves");
  });

  it("skips starts, ends and holders, and steps already at the value, and is null when nothing changes", () => {
    const b = applyEdit(northbeamBundle(), setStepPurposes(northbeamBundle(), [ids.audit], "fixing")!);
    expect(setStepPurposes(b, [ids.audit], "fixing")).toBeNull();
    expect(setStepPurposes(b, [ids.start, ids.won, ids.lost], "fixing")).toBeNull();
    const holder = { ...b, steps: b.steps.map((s) => (s.id === ids.kickoff ? { ...s, child_process_id: "11111111-1111-4111-8111-111111111111" } : s)) };
    const edit = setStepPurposes(holder, [ids.audit, ids.kickoff, ids.start, ids.qualify], "fixing")!;
    expect((edit.ops[0] as { changes: { id: string }[] }).changes.map((c) => c.id)).toEqual([ids.qualify]);
    expect(setStepPurposes(b, [ids.qualify], null)).toBeNull();
  });

  it("one undo restores each step's own value", () => {
    const first = northbeamBundle();
    const withOne = applyEdit(first, setStepPurposes(first, [ids.audit], "required")!);
    const edit = setStepPurposes(withOne, [ids.audit, ids.kickoff, ids.qualify], "fixing")!;
    const after = applyEdit(withOne, edit);
    expect([ids.audit, ids.kickoff, ids.qualify].map((id) => step(after, id).purpose)).toEqual(["fixing", "fixing", "fixing"]);
    const back = applyEdit(after, invertEdit(edit));
    expect(step(back, ids.audit).purpose).toBe("required");
    expect(step(back, ids.kickoff).purpose).toBeNull();
    expect(sorted(back)).toEqual(sorted(withOne));
  });

  it("goes through the editor as one undoable step", async () => {
    const { editor, now } = setup();
    editor.run((b) => setStepPurposes(b, [ids.audit, ids.kickoff], "winning"));
    expect([ids.audit, ids.kickoff].map((id) => step(now(), id).purpose)).toEqual(["winning", "winning"]);
    editor.run((b) => updateStep(b, ids.audit, { purpose: "fixing" }));
    expect(step(now(), ids.audit).purpose).toBe("fixing");
    await editor.undo();
    expect(step(now(), ids.audit).purpose).toBe("winning");
    await editor.undo();
    expect([ids.audit, ids.kickoff].map((id) => step(now(), id).purpose)).toEqual([null, null]);
  });

  it("describeValue shows the category's name, Automatic for none, and a removed category plainly", () => {
    const names = namesOf(northbeamBundle());
    expect(fieldLabel("purpose")).toBe("what it achieves");
    expect(describeValue("purpose", "winning", names)).toBe("Winning work");
    expect(describeValue("purpose", null, names)).toBe("Automatic");
    expect(describeValue("purpose", "c12345678", names)).toBe("a removed category");
    const renamed = northbeamBundle();
    renamed.workspace = { ...renamed.workspace, settings: { ...renamed.workspace.settings, purposes: [{ key: "client_job", name: "The job", description: "" }, { key: "client_upkeep", name: "Upkeep", description: "" }, { key: "winning", name: "Selling", description: "" }, { key: "fixing", name: "Fixing", description: "" }, { key: "removable", name: "Could go", description: "" }] } };
    expect(describeValue("purpose", "winning", namesOf(renamed))).toBe("Selling");
  });
});
