import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamStepIds, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { compareRuns } from "@/lib/drafts/compare";
import { POSITION, discardChange, discardProblem, revertField } from "@/lib/drafts/discard";
import { diffBundles, unresolvedSteps } from "@/lib/drafts/diff";
import { DraftSession, MemoryDraftBackend } from "@/lib/drafts/session";
import { addEdge, addStep, deleteSteps, moveSteps, updateEdge, updateStep } from "@/lib/editor/commands";
import { applyEdit } from "@/lib/editor/ops";
import { provenanceSource, stepProvenance } from "@/lib/editor/provenance";

const ids = northbeamStepIds;
const START = "2026-10-05";
const sorted = (b: Pick<ProcessBundle, "steps" | "edges">) => ({
  steps: [...b.steps].sort((x, y) => x.id.localeCompare(y.id)),
  edges: [...b.edges].sort((x, y) => x.id.localeCompare(y.id)),
});

function setup() {
  const live = northbeamBundle();
  const backend = new MemoryDraftBackend(live);
  const session = new DraftSession(live, null, backend);
  const now = () => session.editor.getState().bundle;
  return { live, backend, session, editor: session.editor, now };
}

describe("diffing a draft against live", () => {
  it("finds added, removed and changed steps and edges, and nothing when they match", () => {
    const live = northbeamBundle();
    expect(diffBundles(live, northbeamBundle()).list).toEqual([]);
    let d = live;
    const added = addStep(d, { kind: "task", x: 0, y: 0 });
    d = applyEdit(d, added.edit);
    d = applyEdit(d, deleteSteps(d, [ids.ppc])!);
    d = applyEdit(d, updateStep(d, ids.audit, { work_hours: 9, "work_params.cv": 0.5 })!);
    d = applyEdit(d, moveSteps(d, [{ id: ids.qualify, x: 5, y: 5 }])!);
    const edge = d.edges.find((e) => e.from_step_id === ids.decision)!;
    d = applyEdit(d, updateEdge(d, edge.id, { probability: 0.3 })!);
    const diff = diffBundles(live, d);
    expect(diff.steps.get(added.id)?.kind).toBe("added");
    expect(diff.steps.get(ids.ppc)?.kind).toBe("removed");
    expect(diff.steps.get(ids.audit)).toMatchObject({
      kind: "changed",
      moved: false,
      fields: [
        { field: "work_hours", live: 6, draft: 9 },
        { field: "work_params.cv", live: null, draft: 0.5 },
      ],
    });
    expect(diff.steps.get(ids.qualify)).toMatchObject({ kind: "changed", moved: true, fields: [] });
    expect(diff.edges.get(edge.id)).toMatchObject({ kind: "changed", fields: [{ field: "probability", live: edge.probability, draft: 0.3 }] });
    // The PPC step's connections went with it.
    const ppcEdges = live.edges.filter((e) => e.from_step_id === ids.ppc || e.to_step_id === ids.ppc);
    for (const e of ppcEdges) expect(diff.edges.get(e.id)?.kind).toBe("removed");
    expect(diff.list.map((c) => c.kind).slice(0, 4)).toEqual(["added", "changed", "changed", "removed"]);
  });
});

describe("discarding one change", () => {
  it("puts each kind of change back as it is live, as an undoable edit", () => {
    const live = northbeamBundle();
    let d = live;
    const added = addStep(d, { kind: "task", x: 0, y: 0 });
    d = applyEdit(d, added.edit);
    const newEdge = addEdge(d, ids.qualify, added.id)!;
    d = applyEdit(d, newEdge.edit);
    d = applyEdit(d, deleteSteps(d, [ids.ppc])!);
    d = applyEdit(d, updateStep(d, ids.audit, { name: "Audit", work_hours: 9 })!);
    d = applyEdit(d, moveSteps(d, [{ id: ids.audit, x: 1, y: 1 }])!);

    // One field at a time: the name, then the position; hands-on time stays changed.
    let e = revertField(live, d, "steps", ids.audit, "name")!;
    expect(e.label).toBe("Reverted Audit's name");
    d = applyEdit(d, e);
    d = applyEdit(d, revertField(live, d, "steps", ids.audit, POSITION)!);
    expect(diffBundles(live, d).steps.get(ids.audit)).toMatchObject({ moved: false, fields: [{ field: "work_hours" }] });
    d = applyEdit(d, discardChange(live, d, "steps", ids.audit)!);

    // A removed step comes back with its connections.
    e = discardChange(live, d, "steps", ids.ppc)!;
    expect(e.label).toBe("Restored PPC campaign setup");
    d = applyEdit(d, e);
    // A new step goes, with its new connection.
    d = applyEdit(d, discardChange(live, d, "steps", added.id)!);
    expect(sorted(d)).toEqual(sorted(live));
  });

  it("can't restore a connection whose step is gone, until the step is back", () => {
    const live = northbeamBundle();
    const d = applyEdit(live, deleteSteps(live, [ids.ppc])!);
    const edge = live.edges.find((x) => x.to_step_id === ids.ppc)!;
    const change = diffBundles(live, d).edges.get(edge.id)!;
    expect(discardProblem(d, change)).toBe("Restore the steps it connects first.");
    expect(discardChange(live, d, "edges", edge.id)).toBeNull();
  });
});

describe("a draft session", () => {
  it("opens a draft on the first edit; live and runs of the live model are unchanged", async () => {
    const { live, backend, session, editor, now } = setup();
    const liveModel = toEngineModel(live, { startDate: START });
    expect(session.hasDraft()).toBe(false);
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 20 }));
    await editor.settled();
    expect(session.hasDraft()).toBe(true);
    expect(session.getState().draft).toMatchObject({ number: 2 });
    editor.run((b) => deleteSteps(b, [ids.ppc]));
    await editor.settled();

    // The live revision (what simulation loads) doesn't move; the draft holds the edits.
    expect(sorted(backend.liveRows())).toEqual(sorted(live));
    expect(sorted(backend.draftRows()!)).toEqual(sorted(now()));
    const liveNow = { ...live, ...backend.liveRows() };
    expect(toEngineModel(liveNow, { startDate: START })).toEqual(liveModel);
    expect(simulate(toEngineModel(liveNow, { startDate: START }), 3, 1).kpi).toEqual(simulate(liveModel, 3, 1).kpi);
    expect(toEngineModel(now(), { startDate: START })).not.toEqual(liveModel);
    expect(session.getState().live).toBe(live);
  });

  it("records a person's parameter edits in the draft as entered, and a revert puts back live's provenance", async () => {
    const live = northbeamBundle();
    const backend = new MemoryDraftBackend(live);
    const at = "2026-09-29T10:00:00.000Z";
    const by = "11111111-1111-4111-8111-111111111111";
    const session = new DraftSession(live, null, backend, () => ({ at, by }));
    const editor = session.editor;
    const audit = (b: Pick<ProcessBundle, "steps">) => b.steps.find((s) => s.id === ids.audit)!;

    editor.run((b) => updateStep(b, ids.audit, { current_wip: 7 }));
    await editor.settled();
    expect(stepProvenance(audit(backend.draftRows()!), "current_wip")).toEqual({ source: "entered", at, by });
    expect(provenanceSource(audit(backend.liveRows()), "current_wip")).toBe("estimated");
    // The draft's changes list the value, not its provenance.
    expect(diffBundles(live, editor.getState().bundle).steps.get(ids.audit)?.fields.map((f) => f.field)).toEqual(["current_wip"]);

    editor.run((b) => revertField(live, b, "steps", ids.audit, "current_wip"));
    await editor.settled();
    expect(provenanceSource(audit(backend.draftRows()!), "current_wip")).toBe("estimated");
    expect(diffBundles(live, editor.getState().bundle).list).toEqual([]);
  });

  it("undo and redo work in the draft", async () => {
    const { live, backend, editor, now } = setup();
    editor.run((b) => updateStep(b, ids.audit, { name: "Audit" }));
    editor.run((b) => deleteSteps(b, [ids.ppc]));
    editor.undo();
    editor.undo();
    await editor.settled();
    expect(sorted(backend.draftRows()!)).toEqual(sorted(live));
    expect(diffBundles(live, now()).list).toEqual([]);
    editor.redo();
    await editor.settled();
    expect(backend.draftRows()!.steps.find((s) => s.id === ids.audit)!.name).toBe("Audit");
  });

  it("refuses to publish unconfirmed estimates unless accepted, then bumps the revision and makes the draft live", async () => {
    const { backend, session, editor, now } = setup();
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 9, assumption: true }));
    expect(unresolvedSteps(now()).map((s) => s.id)).toEqual([ids.audit]);
    expect(await session.publish(false)).toEqual({ status: "unresolved", steps: [{ id: ids.audit, name: "Audit & proposal" }] });
    expect(session.getState().unresolved).toHaveLength(1);
    expect(backend.liveRevisionInfo().number).toBe(1);

    expect(await session.publish(true)).toMatchObject({ status: "published", revision: { number: 2 } });
    expect(backend.published).toEqual([{ number: 2, acceptEstimates: true, estimates: [ids.audit] }]);
    const state = session.getState();
    expect(state.draft).toBeNull();
    expect(state.live.revision).toMatchObject({ number: 2, status: "published" });
    expect(state.live.steps.find((s) => s.id === ids.audit)!.work_hours).toBe(9);
    expect(editor.getState().undoLabel).toBeNull();
    expect(backend.liveRows().steps.find((s) => s.id === ids.audit)!.work_hours).toBe(9);

    // The next edit opens revision 3 from the new live.
    editor.run((b) => updateStep(b, ids.audit, { assumption: false }));
    await editor.settled();
    expect(session.getState().draft?.number).toBe(3);
    expect(await session.publish(false)).toMatchObject({ status: "published", revision: { number: 3 } });
  });

  it("publishes the draft it shows: one that was swapped for another underneath is refused, and nothing goes live", async () => {
    const { backend, session, editor } = setup();
    const seen: string[] = [];
    const publish = backend.publish.bind(backend);
    backend.publish = (accept, draftId) => (seen.push(String(draftId)), publish(accept, draftId));
    editor.run((b) => updateStep(b, ids.audit, { name: "Mine" }));
    await editor.settled();
    const mine = session.getState().draft!.id;
    // Someone else discards it and opens another.
    await backend.discard();
    await backend.open();
    expect(await session.publish(true)).toEqual({ status: "error", message: expect.stringMatching(/^This draft changed since you opened it/) });
    expect(seen).toEqual([mine]);
    expect(backend.liveRevisionInfo().number).toBe(1);
    expect(session.getState().error).toMatch(/Reload to see it/);
  });

  it("discards the whole draft and goes back to live", async () => {
    const { live, backend, session, editor, now } = setup();
    editor.run((b) => updateStep(b, ids.audit, { name: "Audit" }));
    await editor.settled();
    expect(await session.discard()).toBe(true);
    expect(session.getState().draft).toBeNull();
    expect(backend.draftRows()).toBeNull();
    expect(sorted(now())).toEqual(sorted(live));
    expect(editor.getState().undoLabel).toBeNull();
    // Editing again opens a fresh draft.
    editor.run((b) => updateStep(b, ids.audit, { name: "Audit 2" }));
    await editor.settled();
    expect(session.getState().draft?.number).toBe(2);
  });

  it("continues a draft someone else opened, and says so", async () => {
    const live = northbeamBundle();
    const backend = new MemoryDraftBackend(live);
    await backend.open();
    const session = new DraftSession(live, null, backend);
    session.editor.run((b) => updateStep(b, ids.audit, { name: "Audit" }));
    await session.editor.settled();
    expect(session.getState().notice).toMatch(/already had a draft/);
    expect(backend.draftRows()!.steps.find((s) => s.id === ids.audit)!.name).toBe("Audit");
  });
});

describe("draft vs live", () => {
  it("shows each KPI for both runs and the change", () => {
    const live = northbeamBundle();
    const draft = applyEdit(live, updateStep(live, ids.audit, { work_hours: 1 })!);
    const lm = toEngineModel(live, { startDate: START });
    const dm = toEngineModel(draft, { startDate: START });
    const rows = compareRuns({ model: lm, result: simulate(lm, 5, 1) }, { model: dm, result: simulate(dm, 5, 1) }, "GBP");
    expect(rows.map((r) => r.label)).toContain("Wins");
    const same = compareRuns({ model: lm, result: simulate(lm, 5, 1) }, { model: lm, result: simulate(lm, 5, 1) }, "GBP");
    expect(same.every((r) => r.delta === "no change" && r.better === null)).toBe(true);
    expect(rows.some((r) => r.delta !== "no change")).toBe(true);
  });
});
