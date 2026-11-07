import { describe, expect, it } from "vitest";
import { northbeamStepIds as ids } from "@transpera-flow/db";
import { addDecision } from "@/lib/editor/groups";
import { addBranch, branchesOf, setBranchTarget } from "@/lib/editor/branches";
import { applyEdit, type Edit } from "@/lib/editor/ops";
import { decodeTarget, encodeTarget, currentTarget, goBackNodes, goesToMenu, branchRows, goBackNodeId } from "@/lib/editor/branch-view";
import { deleteSelection } from "@/lib/editor/commands";
import { demoBundle } from "@/lib/sources/demo";

const edit = (r: { edit: Edit } | { problem: string } | null): Edit => {
  if (!r || "problem" in r) throw new Error(`expected an edit, got ${JSON.stringify(r)}`);
  return r.edit;
};

describe("branch rows and go back nodes", () => {
  const base = demoBundle();
  const made = addDecision(base, ids.audit);
  const b = applyEdit(base, made.edit);
  const d = made.id;

  it("lists a decision's branches with their names and whole percents", () => {
    expect(branchRows(b, d).map((r) => [r.name, r.percent, r.goBack])).toEqual([
      ["Yes", 50, false],
      ["No", 50, false],
    ]);
  });

  it("draws a branch that goes back to an earlier step as a go back node, and only that one", () => {
    const [yes] = branchesOf(b, d);
    const back = applyEdit(b, edit(setBranchTarget(b, yes!.id, { goBackTo: ids.audit })));
    const nodes = goBackNodes(back);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: goBackNodeId(yes!.id), edgeId: yes!.id, decisionId: d, targetId: ids.audit });
    expect(goBackNodes(b)).toEqual([]);
    expect(branchRows(back, d)[0]!.goBack).toBe(true);
  });

  it("offers a branch its next steps, the earlier steps to go back to, and the ends it may have", () => {
    const [yes] = branchesOf(b, d);
    const menu = goesToMenu(b, yes!);
    expect(menu.map((g) => g.label)).toEqual(["Next step…", "Go back to…", "End (won / lost / done)"]);
    const [next, back, ends] = menu;
    expect(back!.options.map((o) => o.value)).toContain(encodeTarget({ goBackTo: ids.audit }));
    expect(next!.options.map((o) => o.value)).not.toContain(encodeTarget(d));
    expect(ends!.options.map((o) => o.label)).toEqual(["Won", "Lost", "Done"]);
    // What it leads to now is always on the menu.
    expect(next!.options.map((o) => o.value)).toContain(currentTarget(b, yes!));
  });

  it("round-trips a menu value", () => {
    for (const t of [ids.audit, { goBackTo: ids.audit }, { end: "lost" as const }]) expect(decodeTarget(encodeTarget(t))).toEqual(t);
    expect(decodeTarget("nope")).toBeNull();
    expect(decodeTarget("end:maybe")).toBeNull();
  });

  it("sends a branch to a new end through the menu's value", () => {
    const [, no] = branchesOf(b, d);
    const to = decodeTarget(encodeTarget({ end: "lost" }))!;
    const after = applyEdit(b, edit(setBranchTarget(b, no!.id, to)));
    expect(currentTarget(after, branchesOf(after, d)[1]!)).toBe(encodeTarget({ end: "lost" }));
    const three = edit(addBranch(after, d, { end: "won" }));
    expect(three.ops.length).toBeGreaterThan(0);
  });
});

describe("the start step is never deleted", () => {
  it("leaves the start step out of a delete, whether it is selected alone or with others", () => {
    const b = demoBundle();
    const start = b.steps.find((s) => s.kind === "start")!;
    expect(deleteSelection(b, [start.id], [])).toBeNull();
    const after = applyEdit(b, deleteSelection(b, [start.id, ids.audit], [])!);
    expect(after.steps.some((s) => s.id === start.id)).toBe(true);
    expect(after.steps.some((s) => s.id === ids.audit)).toBe(false);
  });
});
