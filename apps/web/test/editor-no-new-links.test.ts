import { describe, expect, it } from "vitest";
import { northbeamStepIds as ids, type ProcessBundle } from "@transpera-flow/db";
import { addStep, copySteps, deleteSteps, duplicateSteps, pasteSteps, setStepKind, STEP_KINDS, updateStep } from "@/lib/editor/commands";
import { addBranch, setBranchTarget } from "@/lib/editor/branches";
import { addAfter, addDecision, groupSteps, ungroup, type PaletteKind } from "@/lib/editor/groups";
import { placeProcesses } from "@/lib/editor/library";
import { applyEdit, type Edit } from "@/lib/editor/ops";
import { blockFromGroup, insertBlock, replaceWithBlock } from "@/lib/blocks/blocks";
import { demoBundle } from "@/lib/sources/demo";

// Editor brainstorm item 3, "no new links": the process library's "+ Process" is the only editor command that makes a step holding
// another process. The library goes (the screens' brief); nothing else in the editor may take its place.

const links = (b: ProcessBundle) => b.steps.filter((s) => s.child_process_id).map((s) => s.id);

/** Every edit the editor's commands make from a map with no link in it must leave it with no link. */
describe("editor commands make no links", () => {
  const b = demoBundle();
  const kinds: PaletteKind[] = [...STEP_KINDS, "group"];

  it("adds, connects, groups, copies and deletes without making a holder", () => {
    const edits: Edit[] = [];
    const push = (e: Edit | null) => void (e && edits.push(e));
    for (const kind of kinds) for (const sel of [ids.audit, ids.qualify, ids.won, null]) edits.push(addAfter(b, sel, kind).edit);
    for (const kind of STEP_KINDS) edits.push(addStep(b, { kind, x: 0, y: 0 }).edit);
    edits.push(addDecision(b, ids.audit).edit);
    const grouped = groupSteps(b, [ids.seo, ids.ppc])!;
    edits.push(grouped.edit);
    push(ungroup(applyEdit(b, grouped.edit), grouped.id));
    push(duplicateSteps(b, [ids.seo, ids.ppc])?.edit ?? null);
    push(pasteSteps(b, copySteps(b, [ids.discovery])!, { x: 5, y: 5 })?.edit ?? null);
    push(deleteSteps(b, [ids.seo]));
    for (const kind of ["task", "wait", "decision", "subprocess"] as const) push(setStepKind(b, ids.live, kind));
    push(updateStep(b, ids.live, { name: "Renamed" }));
    expect(edits.length).toBeGreaterThan(35);
    for (const edit of edits) expect(links(applyEdit(b, edit)), edit.label).toEqual([]);
  });

  it("branches without making a holder", () => {
    const withDecision = applyEdit(b, addDecision(b, ids.audit).edit);
    const d = withDecision.steps.find((s) => s.kind === "decision" && s.name === "Decision")!.id;
    const branch = (r: ReturnType<typeof addBranch>) => (r && "edit" in r ? r.edit : null);
    for (const target of [ids.lost, { goBackTo: ids.qualify }, { end: "done" as const }, { end: "won" as const }]) {
      expect(links(applyEdit(withDecision, branch(addBranch(withDecision, d, target))!))).toEqual([]);
    }
    const line = withDecision.edges.find((e) => e.from_step_id === d)!.id;
    expect(links(applyEdit(withDecision, branch(setBranchTarget(withDecision, line, { end: "done" }))!))).toEqual([]);
  });

  it("puts blocks in, and replaces steps with them, without making a holder", () => {
    // A block is taken from a group of the map.
    const made = groupSteps(b, [ids.seo, ids.ppc])!;
    const grouped = applyEdit(b, made.edit);
    const fromGroup = blockFromGroup(grouped, made.id)!;
    expect(links(applyEdit(b, insertBlock(b, ids.audit, fromGroup, "Block")!.edit))).toEqual([]);
    expect(links(applyEdit(b, replaceWithBlock(b, ids.discovery, fromGroup, "Block")!.edit))).toEqual([]);
  });

  it("is the process library alone that links one", () => {
    const placed = placeProcesses(b, [], null, [{ id: "11111111-1111-4111-8111-111111111111", name: "Delivery", kind: "servicing", category: "routine_client_work", live: true, holder: null }]);
    expect(placed).toBeNull();
    const out = placeProcesses(b, ["11111111-1111-4111-8111-111111111111"], null, [{ id: "11111111-1111-4111-8111-111111111111", name: "Delivery", kind: "servicing", category: "routine_client_work", live: true, holder: null }]);
    expect(links(applyEdit(b, out!.edit))).toHaveLength(1);
  });
});
