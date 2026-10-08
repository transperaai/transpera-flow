import { describe, expect, it } from "vitest";
import { northbeamStepIds as ids, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { stepWarnings } from "@/lib/editor/commands";
import { addAfter, groupProblem, groupSteps, membersOf, setGroupEntry, ungroup } from "@/lib/editor/groups";
import { applyEdit, invertEdit } from "@/lib/editor/ops";
import { CARD_SIZE } from "@/lib/map/groups";
import { demoBundle } from "@/lib/sources/demo";

// Placing steps and grouping them in the Editor (issue #104).

const START = "2026-10-05";
const flat = () => demoBundle();
const nested = () => withDemoGroups(demoBundle());
const modelOf = (b: ProcessBundle) => toEngineModel(b, { startDate: START });
const stepsOf = (b: ProcessBundle, id: string) => b.steps.find((s) => s.id === id)!;
const from = (b: ProcessBundle, id: string) => b.edges.filter((e) => e.from_step_id === id);

describe("adding where the person is looking", () => {
  const cardBox = (b: ProcessBundle, id: string) => {
    const s = stepsOf(b, id);
    return { l: Number(s.x), t: Number(s.y), r: Number(s.x) + CARD_SIZE.width, b: Number(s.y) + CARD_SIZE.height };
  };
  const clear = (b: ProcessBundle, id: string) =>
    b.steps
      .filter((o) => o.id !== id && (o.parent_step_id ?? null) === null && o.kind !== "group")
      .every((o) => {
        const a = cardBox(b, id);
        const c = cardBox(b, o.id);
        return a.r <= c.l || a.l >= c.r || a.b <= c.t || a.t >= c.b;
      });

  it("puts the new step at the centre of the view when that is free", () => {
    const b = flat();
    const view = { x: 5000, y: 3000 };
    const { edit, id } = addAfter(b, null, "task", view);
    const s = stepsOf(applyEdit(b, edit), id);
    expect([Number(s.x) + CARD_SIZE.width / 2, Number(s.y) + CARD_SIZE.height / 2]).toEqual([5000, 3000]);
  });

  it("moves to the nearest free place when the centre is taken, without touching another step", () => {
    const b = flat();
    const taken = stepsOf(b, ids.seo);
    const view = { x: Number(taken.x) + CARD_SIZE.width / 2, y: Number(taken.y) + CARD_SIZE.height / 2 };
    for (const kind of ["task", "decision", "wait"] as const) {
      const { edit, id } = addAfter(b, null, kind, view);
      const after = applyEdit(b, edit);
      expect(clear(after, id)).toBe(true);
      const s = stepsOf(after, id);
      // Near: within a step or two of where it was meant to go.
      expect(Math.hypot(Number(s.x) + CARD_SIZE.width / 2 - view.x, Number(s.y) + CARD_SIZE.height / 2 - view.y)).toBeLessThan(260);
    }
  });

  it("stays inside what is visible when there is room there", () => {
    const b = flat();
    const taken = stepsOf(b, ids.seo);
    const view = {
      x: Number(taken.x) + CARD_SIZE.width / 2,
      y: Number(taken.y) + CARD_SIZE.height / 2,
      visible: { left: Number(taken.x) - 400, top: Number(taken.y) - 300, right: Number(taken.x) + 600, bottom: Number(taken.y) + 300 },
    };
    const { edit, id } = addAfter(b, null, "task", view);
    const s = stepsOf(applyEdit(b, edit), id);
    expect(Number(s.x)).toBeGreaterThanOrEqual(view.visible.left);
    expect(Number(s.y)).toBeGreaterThanOrEqual(view.visible.top);
    expect(Number(s.x) + CARD_SIZE.width).toBeLessThanOrEqual(view.visible.right);
    expect(Number(s.y) + CARD_SIZE.height).toBeLessThanOrEqual(view.visible.bottom);
  });

  it("keeps a step added inside a group beside the selected step, not at the view's centre", () => {
    const b = nested();
    const sel = stepsOf(b, ids.qualify);
    const { edit, id } = addAfter(b, sel.id, "task", { x: 9000, y: 9000 });
    const s = stepsOf(applyEdit(b, edit), id);
    expect(s.parent_step_id).toBe(sel.parent_step_id);
    expect(Number(s.x)).toBeLessThan(2000);
  });
});

describe("adding after the selected step", () => {
  it("splices a new step between the selected step and the one after it", () => {
    const b = flat();
    const next = from(b, ids.seo)[0]!;
    const { edit, id } = addAfter(b, ids.seo, "task");
    const after = applyEdit(b, edit);
    expect(from(after, ids.seo).map((e) => e.to_step_id)).toEqual([id]);
    expect(from(after, id).map((e) => [e.to_step_id, Number(e.probability)])).toEqual([[next.to_step_id, 1]]);
    // The old connection kept its share and is now the one into the new step.
    expect(after.edges.find((e) => e.id === next.id)!.to_step_id).toBe(id);
    expect(modelOf(after).steps.some((s) => s.id === id)).toBe(true);
  });

  it("leads a selected step with nothing after it to the new one", () => {
    const b = flat();
    const first = addAfter(b, null, "wait");
    const b2 = applyEdit(b, first.edit);
    const { edit, id } = addAfter(b2, first.id, "decision");
    const after = applyEdit(b2, edit);
    expect(from(after, first.id).map((e) => e.to_step_id)).toEqual([id]);
    expect(stepsOf(after, id).kind).toBe("decision");
  });

  it("places the new step unconnected beside a step with branches", () => {
    const b = flat();
    expect(from(b, ids.discovery).length).toBeGreaterThan(1);
    const { edit, id, note } = addAfter(b, ids.discovery, "task");
    const after = applyEdit(b, edit);
    expect(after.edges).toHaveLength(b.edges.length);
    // Just below the selected step, where it is easy to find, and the person is told to join it in.
    expect(Number(stepsOf(after, id).y)).toBeGreaterThan(Number(stepsOf(b, ids.discovery).y));
    expect(Math.abs(Number(stepsOf(after, id).x) - Number(stepsOf(b, ids.discovery).x))).toBeLessThan(100);
    expect(note).toBe("Discovery call has branches: connect the new step yourself.");
    expect(addAfter(b, ids.seo, "task").note).toBeUndefined();
  });

  it("lands inside the group of the selected step, at any depth", () => {
    const b = nested();
    const { edit, id } = addAfter(b, ids.qualify, "task");
    expect(stepsOf(applyEdit(b, edit), id).parent_step_id).toBe(DEMO_GROUP_IDS.conversation);
    // Inside a group inside a group.
    const g = groupSteps(b, [ids.qualify, ids.discovery])!;
    const inner = applyEdit(b, g.edit);
    expect(stepsOf(inner, g.id).parent_step_id).toBe(DEMO_GROUP_IDS.conversation);
    const deep = addAfter(inner, ids.qualify, "wait");
    expect(stepsOf(applyEdit(inner, deep.edit), deep.id).parent_step_id).toBe(g.id);
  });

  it("adds a group holding one step, which is its first step and keeps the model simulatable", () => {
    const b = flat();
    const { edit, id } = addAfter(b, ids.seo, "group");
    const after = applyEdit(b, edit);
    const group = stepsOf(after, id);
    expect(group.kind).toBe("group");
    const inside = membersOf(after, id);
    expect(inside).toHaveLength(1);
    expect(group.entry_step_id).toBe(inside[0]!.id);
    expect(group.work_hours).toBe(0);
    expect(() => simulate(modelOf(after), 2, 1)).not.toThrow();
  });

  it("is undone as one edit", () => {
    const b = flat();
    const { edit } = addAfter(b, ids.qualify, "group");
    const back = applyEdit(applyEdit(b, edit), invertEdit(edit));
    expect(back.steps.map((s) => s.id).sort()).toEqual(b.steps.map((s) => s.id).sort());
    expect(back.edges.map((e) => [e.id, e.to_step_id]).sort()).toEqual(b.edges.map((e) => [e.id, e.to_step_id]).sort());
  });
});

describe("grouping and ungrouping", () => {
  it("groups the selected steps without changing a number", () => {
    const b = flat();
    const g = groupSteps(b, [ids.seo, ids.ppc, ids.live])!;
    const after = applyEdit(b, g.edit);
    expect(membersOf(after, g.id).map((s) => s.id).sort()).toEqual([ids.seo, ids.ppc, ids.live].sort());
    expect(stepsOf(after, g.id).entry_step_id).toBeTruthy();
    expect(simulate(modelOf(after), 4, 1)).toEqual(simulate(modelOf(b), 4, 1));
  });

  it("makes the step the outside leads into the group's first step, and puts the steps inside the box", () => {
    const b = flat();
    const g = groupSteps(b, [ids.discovery, ids.qualify])!;
    const after = applyEdit(b, g.edit);
    expect(stepsOf(after, g.id).entry_step_id).toBe(ids.qualify);
    expect(Number(stepsOf(after, ids.qualify).x)).toBe(24);
    expect(Number(stepsOf(after, ids.qualify).y)).toBe(56);
  });

  it("refuses steps in different places, the start and end steps, and nothing", () => {
    const b = nested();
    expect(groupProblem(b, [ids.qualify, ids.audit])).toMatch(/same place/);
    expect(groupProblem(flat(), [ids.start, ids.qualify])).toMatch(/start and end/);
    expect(groupProblem(flat(), [])).toMatch(/Select/);
    expect(groupSteps(b, [ids.qualify, ids.audit])).toBeNull();
  });

  it("when a group's first step goes into a new group inside it, the new group becomes the first step", () => {
    const b = nested();
    const g = groupSteps(b, [ids.qualify])!;
    const after = applyEdit(b, g.edit);
    expect(stepsOf(after, DEMO_GROUP_IDS.conversation).entry_step_id).toBe(g.id);
    expect(simulate(modelOf(after), 4, 1)).toEqual(simulate(modelOf(nested()), 4, 1));
  });

  it("orders its saves so a group is empty first and its first step is set last", () => {
    const g = groupSteps(flat(), [ids.seo, ids.ppc])!;
    expect(g.edit.ops[0]!.kind).toBe("insert");
    const last = g.edit.ops[g.edit.ops.length - 1]!;
    expect(last.kind === "update" && last.changes[0]!.after).toHaveProperty("entry_step_id");
  });

  it("ungroups back to where it was, with the same numbers", () => {
    const b = nested();
    const edit = ungroup(b, DEMO_GROUP_IDS.setup)!;
    const after = applyEdit(b, edit);
    expect(after.steps.some((s) => s.id === DEMO_GROUP_IDS.setup)).toBe(false);
    expect(stepsOf(after, ids.seo).parent_step_id).toBeNull();
    expect(Number(stepsOf(after, ids.seo).x)).toBe(Number(stepsOf(flat(), ids.seo).x));
    expect(simulate(modelOf(after), 4, 1)).toEqual(simulate(modelOf(flat()), 4, 1));
    // The group's connections went to its steps: nothing is left dangling.
    expect(after.edges.every((e) => after.steps.some((s) => s.id === e.from_step_id) && after.steps.some((s) => s.id === e.to_step_id))).toBe(true);
    expect(stepWarnings(after).size).toBe(stepWarnings(flat()).size);
  });

  it("ungroups a group inside a group, passing its first-step place up", () => {
    const b = applyEdit(nested(), groupSteps(nested(), [ids.qualify])!.edit);
    const inner = b.steps.find((s) => s.kind === "group" && s.parent_step_id === DEMO_GROUP_IDS.conversation)!;
    const after = applyEdit(b, ungroup(b, inner.id)!);
    expect(stepsOf(after, DEMO_GROUP_IDS.conversation).entry_step_id).toBe(ids.qualify);
    expect(stepsOf(after, ids.qualify).parent_step_id).toBe(DEMO_GROUP_IDS.conversation);
  });

  it("sets a group's first step, only to one of its own", () => {
    const b = nested();
    const edit = setGroupEntry(b, DEMO_GROUP_IDS.setup, ids.ppc)!;
    expect(stepsOf(applyEdit(b, edit), DEMO_GROUP_IDS.setup).entry_step_id).toBe(ids.ppc);
    expect(setGroupEntry(b, DEMO_GROUP_IDS.setup, ids.qualify)).toBeNull();
    expect(setGroupEntry(b, DEMO_GROUP_IDS.setup, ids.seo)).toBeNull();
  });
});

describe("groups with nowhere to go", () => {
  it("warns about a new group with no way out, and about the step inside it", () => {
    const b = flat();
    const lone = addAfter(b, null, "group");
    const withGroup = applyEdit(b, lone.edit);
    expect(stepWarnings(withGroup).get(lone.id)).toMatch(/Nothing leaves this group/);
    const inner = membersOf(withGroup, lone.id)[0]!;
    expect(stepWarnings(withGroup).get(inner.id)).toMatch(/no group it is in has a connection out/);
  });
});
