import { describe, expect, it } from "vitest";
import { northbeamStepIds as ids, toEngineModel, type BlockBundle, type ProcessBundle } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { blockFromGroup, blockFromSteps, blockOfStep, blockProblem, blockStepCount, insertBlock, readBlock, replaceProblem, replaceWithBlock } from "@/lib/blocks/blocks";
import { blockUsage } from "@/lib/blocks/usage";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { BlockSteps } from "@/components/blocks/block-library";
import { stepWarnings } from "@/lib/editor/commands";
import { diffBundles } from "@/lib/drafts/diff";
import { openGroupSize } from "@/lib/map/groups";
import { groupSteps } from "@/lib/editor/groups";
import { applyEdit, invertEdit } from "@/lib/editor/ops";
import { demoBundle } from "@/lib/sources/demo";

// The block library's pure edits (issue #116): saving a group as a block, putting a block in after the selection or in
// place of it, at any depth, with fresh ids that show as added.

const START = "2026-10-05";
const flat = () => demoBundle();
const nested = () => withDemoGroups(demoBundle());
const stepOf = (b: ProcessBundle, id: string) => b.steps.find((s) => s.id === id)!;
const from = (b: ProcessBundle, id: string) => b.edges.filter((e) => e.from_step_id === id);
const into = (b: ProcessBundle, id: string) => b.edges.filter((e) => e.to_step_id === id);
const childrenIds = (b: ProcessBundle, id: string) => b.steps.filter((s) => s.parent_step_id === id).map((s) => s.id);

/** The Sales conversation group of the nested demo, as a block. */
const sales = (): BlockBundle => blockFromGroup(nested(), DEMO_GROUP_IDS.conversation)!;

/** A block with a group inside a group: Campaign set-up with its first two steps grouped. */
function nestedBlock(): { block: BlockBundle; inner: string } {
  const b = nested();
  const made = groupSteps(b, [ids.seo, ids.ppc])!;
  const after = applyEdit(b, made.edit);
  return { block: blockFromGroup(after, DEMO_GROUP_IDS.setup)!, inner: made.id };
}

describe("saving a group as a block", () => {
  it("keeps the group's steps and the connections among them, with the group as the box they came from", () => {
    const block = sales();
    expect(block.steps.map((s) => s.name).sort()).toEqual(["Discovery call", "Qualify lead"]);
    expect(block.steps.every((s) => s.parent_step_id === null)).toBe(true);
    expect(block.edges.every((e) => block.steps.some((s) => s.id === e.from_step_id) && block.steps.some((s) => s.id === e.to_step_id))).toBe(true);
    expect(block.entry_step_id).toBe(ids.qualify);
    expect(blockStepCount(block)).toBe(2);
    expect(blockProblem(block)).toBeNull();
  });

  it("carries nothing of the process it came from", () => {
    for (const s of sales().steps) {
      expect(s).not.toHaveProperty("revision_id");
      expect(s).not.toHaveProperty("workspace_id");
      expect(s).not.toHaveProperty("process_id");
      expect(s.current_wip).toBeNull();
    }
  });

  it("keeps groups inside the group, at any depth, and counts only the work steps", () => {
    const { block, inner } = nestedBlock();
    expect(block.steps.find((s) => s.id === inner)!.parent_step_id).toBeNull();
    expect(block.steps.filter((s) => s.parent_step_id === inner)).toHaveLength(2);
    expect(blockStepCount(block)).toBe(3);
    expect(blockProblem(block)).toBeNull();
  });

  it("refuses a parent loop, work on a group, and numbers that aren't numbers", () => {
    const ok = sales();
    const [a, c] = ok.steps;
    const loop = { ...ok, steps: [{ ...a!, parent_step_id: c!.id }, { ...c!, parent_step_id: a!.id }], entry_step_id: null };
    expect(blockProblem(loop)).not.toBeNull();
    const self = { ...ok, steps: [{ ...a!, parent_step_id: a!.id }], edges: [], entry_step_id: null };
    expect(blockProblem(self)).not.toBeNull();
    const group = { ...ok, steps: [{ ...a!, kind: "group" as const, work_hours: 3 }], edges: [], entry_step_id: a!.id };
    expect(blockProblem(group)).toMatch(/group can't hold work/);
    expect(blockProblem({ ...ok, steps: [{ ...a!, work_hours: "lots" as unknown as number }], edges: [], entry_step_id: a!.id })).not.toBeNull();
  });

  it("is only for groups", () => {
    expect(blockFromGroup(flat(), ids.seo)).toBeNull();
    expect(blockFromGroup(nested(), "nope")).toBeNull();
  });

  it("turns the whole map of block mode into a block at the top left, entered at its leftmost step", () => {
    const b = flat();
    const steps = b.steps.filter((s) => s.kind === "task").slice(0, 3);
    const mini = { steps: steps.map((s, i) => ({ ...s, x: 400 + i * 100, y: 300 })), edges: b.edges.filter((e) => steps.some((s) => s.id === e.from_step_id) && steps.some((s) => s.id === e.to_step_id)) };
    const block = blockFromSteps(mini);
    expect(Math.min(...block.steps.map((s) => Number(s.x)))).toBe(24);
    expect(Math.min(...block.steps.map((s) => Number(s.y)))).toBe(56);
    expect(block.entry_step_id).toBe(block.steps.sort((a, c) => Number(a.x) - Number(c.x))[0]!.id);
  });

  it("refuses a block with nothing in it, with start or end steps, or one that is malformed", () => {
    expect(blockProblem({ steps: [], edges: [], entry_step_id: null })).toMatch(/at least one step/);
    const start = { ...sales(), steps: [stepOf(flat(), ids.start)] } as unknown as BlockBundle;
    expect(blockProblem(start)).toMatch(/start and end/);
    expect(blockProblem(null)).not.toBeNull();
    expect(blockProblem({ steps: [{ id: "a", name: "A", kind: "task", parent_step_id: "ghost" }], edges: [] })).not.toBeNull();
    expect(readBlock({ steps: "no" })).toEqual({ steps: [], edges: [], entry_step_id: null });
    expect(readBlock(sales()).steps).toHaveLength(2);
  });
});

describe("inserting a block after the selection", () => {
  it("adds a group named after the block, joined in, with fresh ids that show as added", () => {
    const live = flat();
    const block = sales();
    const next = from(live, ids.audit)[0]!;
    const { edit, id } = insertBlock(live, ids.audit, block, "Sales conversation")!;
    const after = applyEdit(live, edit);
    const group = stepOf(after, id);
    expect(group.kind).toBe("group");
    expect(group.name).toBe("Sales conversation");
    expect(group.parent_step_id).toBeNull();
    // Its steps are copies with new ids, inside the group, entered where the block was.
    const inside = childrenIds(after, id);
    expect(inside).toHaveLength(2);
    expect(inside.some((i) => block.steps.some((s) => s.id === i))).toBe(false);
    expect(stepOf(after, group.entry_step_id!).name).toBe("Qualify lead");
    // Joined in: audit -> block -> what audit led to.
    expect(from(after, ids.audit).map((e) => e.to_step_id)).toEqual([id]);
    expect(from(after, id).map((e) => [e.to_step_id, Number(e.probability)])).toEqual([[next.to_step_id, 1]]);
    // Every new step and connection is added, and nothing else changed except the one connection that was re-pointed.
    const diff = diffBundles(live, after);
    expect([...diff.steps.values()].map((c) => c.kind)).toEqual(Array(3).fill("added"));
    expect(diff.steps.has(id)).toBe(true);
    for (const i of inside) expect(diff.steps.get(i)?.kind).toBe("added");
    expect(new Set(after.steps.map((s) => s.id)).size).toBe(after.steps.length);
    expect(new Set(after.edges.map((e) => e.id)).size).toBe(after.edges.length);
    expect(after.steps.every((s) => s.revision_id === live.revision.id && s.process_id === live.process.id)).toBe(true);
  });

  it("gives a second insert of the same block its own new ids", () => {
    const live = flat();
    const block = sales();
    const first = insertBlock(live, ids.audit, block, "A")!;
    const once = applyEdit(live, first.edit);
    const second = insertBlock(once, first.id, block, "B")!;
    const twice = applyEdit(once, second.edit);
    expect(twice.steps).toHaveLength(live.steps.length + 6);
    expect(new Set(twice.steps.map((s) => s.id)).size).toBe(twice.steps.length);
    expect(from(twice, first.id).map((e) => e.to_step_id)).toEqual([second.id]);
  });

  it("can be undone and redone", () => {
    const live = flat();
    const { edit } = insertBlock(live, ids.audit, sales(), "Sales conversation")!;
    const after = applyEdit(live, edit);
    const undone = applyEdit(after, invertEdit(edit));
    expect(undone.steps.map((s) => s.id).sort()).toEqual(live.steps.map((s) => s.id).sort());
    expect(undone.edges.map((e) => [e.id, e.to_step_id]).sort()).toEqual(live.edges.map((e) => [e.id, e.to_step_id]).sort());
  });

  it("lands inside the group the selected step is in, at any depth", () => {
    const b = nested();
    const { edit, id } = insertBlock(b, ids.seo, sales(), "Sales conversation")!;
    const after = applyEdit(b, edit);
    expect(stepOf(after, id).parent_step_id).toBe(DEMO_GROUP_IDS.setup);
    expect(childrenIds(after, id)).toHaveLength(2);
    // Two levels down: a block inside a group inside a group.
    const deep = applyEdit(b, groupSteps(b, [ids.seo])!.edit);
    const inner = deep.steps.find((s) => s.kind === "group" && s.parent_step_id === DEMO_GROUP_IDS.setup && s.id !== DEMO_GROUP_IDS.setup)!;
    const seo = stepOf(deep, ids.seo);
    expect(seo.parent_step_id).toBe(inner.id);
    const placed = insertBlock(deep, ids.seo, nestedBlock().block, "Setup again")!;
    const result = applyEdit(deep, placed.edit);
    expect(stepOf(result, placed.id).parent_step_id).toBe(inner.id);
    // The block's own inner group came along, a level below the new group.
    const kids = childrenIds(result, placed.id);
    expect(kids.map((k) => stepOf(result, k).kind).sort()).toEqual(["group", "task"].sort());
    const innerCopy = result.steps.find((s) => s.kind === "group" && kids.includes(s.id))!;
    expect(childrenIds(result, innerCopy.id)).toHaveLength(2);
    expect(innerCopy.id).not.toBe(nestedBlock().inner);
    // Every group's first step is one of its own.
    for (const g of result.steps.filter((s) => s.kind === "group")) expect(childrenIds(result, g.id)).toContain(g.entry_step_id);
  });

  it("puts it at the end of the top level, unconnected, with nothing selected", () => {
    const b = flat();
    const { edit, id, note } = insertBlock(b, null, sales(), "Sales conversation")!;
    const after = applyEdit(b, edit);
    expect(after.edges.filter((e) => e.from_step_id === id || e.to_step_id === id)).toHaveLength(0);
    expect(note).toBeUndefined();
  });

  it("joins a step with nothing after it, and leaves a step with branches or an end step to be connected by hand", () => {
    const b = flat();
    const leaf = b.steps.find((s) => s.kind !== "end" && s.kind !== "group" && !from(b, s.id).length);
    if (leaf) expect(from(applyEdit(b, insertBlock(b, leaf.id, sales(), "X")!.edit), leaf.id)).toHaveLength(1);
    const branching = b.steps.find((s) => from(b, s.id).length > 1)!;
    const branch = insertBlock(b, branching.id, sales(), "X")!;
    expect(branch.note).toMatch(/has branches/);
    expect(from(applyEdit(b, branch.edit), branching.id)).toHaveLength(from(b, branching.id).length);
    const end = b.steps.find((s) => s.kind === "end")!;
    const afterEnd = insertBlock(b, end.id, sales(), "X")!;
    expect(afterEnd.note).toMatch(/end step/);
  });

  it("copies only the known columns, and clears a role or person that no longer exists", () => {
    const live = flat();
    const block = sales();
    const odd = { ...block, steps: block.steps.map((x, i) => ({ ...x, role_id: "e1111111-0000-4000-8000-00000000dead", person_id: i ? "e1111111-0000-4000-8000-00000000beef" : x.person_id, stray: "x" })) };
    const after = applyEdit(live, insertBlock(live, ids.audit, odd as unknown as BlockBundle, "X")!.edit);
    const added = after.steps.filter((x) => !live.steps.some((o) => o.id === x.id) && x.kind !== "group");
    expect(added).toHaveLength(2);
    for (const x of added) {
      expect(x).not.toHaveProperty("stray");
      expect(x.role_id).toBeNull();
      expect(x.person_id).toBeNull();
    }
    expect(readBlock(odd).steps[0]).not.toHaveProperty("stray");
  });

  it("puts the group clear of its neighbours, whatever their size", () => {
    const b = nested();
    const placed = insertBlock(b, ids.audit, nestedBlock().block, "Set-up again")!;
    const after = applyEdit(b, placed.edit);
    const g = stepOf(after, placed.id);
    const size = openGroupSize(after.steps, g.id, "all");
    for (const o of after.steps.filter((x) => (x.parent_step_id ?? null) === null && x.id !== g.id && x.kind !== "start" && x.kind !== "end")) {
      const os = o.kind === "group" ? openGroupSize(after.steps, o.id, "all") : { width: 200, height: 90 };
      const overlap = Number(g.x) < Number(o.x) + os.width && Number(o.x) < Number(g.x) + size.width && Number(g.y) < Number(o.y) + os.height && Number(o.y) < Number(g.y) + size.height;
      expect(overlap, o.name).toBe(false);
    }
  });

  it("refuses a block that can't be put in", () => {
    expect(insertBlock(flat(), ids.audit, { steps: [], edges: [], entry_step_id: null }, "Empty")).toBeNull();
  });

  it("still simulates, and the numbers flow through the new steps", () => {
    const b = nested();
    const { edit } = insertBlock(b, ids.seo, sales(), "Sales conversation")!;
    const after = applyEdit(b, edit);
    const model = toEngineModel(after, { startDate: START });
    expect(model.steps.some((s) => s.name === "Discovery call")).toBe(true);
    expect(() => simulate(model, 2, 1)).not.toThrow();
    // The block's steps leave through the group's connection, so none is flagged as a dead end.
    expect([...stepWarnings(after).values()].some((w) => /Nothing leaves/.test(w))).toBe(false);
  });
});

describe("replacing the selection with a block", () => {
  it("swaps a step for the block, keeping the connections in and out", () => {
    const live = flat();
    const before = into(live, ids.discovery).map((e) => e.from_step_id);
    const after_ = from(live, ids.discovery).map((e) => [e.to_step_id, Number(e.probability), e.condition_tag]);
    const { edit, id } = replaceWithBlock(live, ids.discovery, sales(), "Sales conversation")!;
    const after = applyEdit(live, edit);
    expect(after.steps.some((s) => s.id === ids.discovery)).toBe(false);
    expect(into(after, id).map((e) => e.from_step_id)).toEqual(before);
    expect(from(after, id).map((e) => [e.to_step_id, Number(e.probability), e.condition_tag])).toEqual(after_);
    // The group sits where the step was, and its steps show as added.
    expect(Number(stepOf(after, id).x)).toBe(Number(stepOf(live, ids.discovery).x));
    const diff = diffBundles(live, after);
    for (const c of childrenIds(after, id)) expect(diff.steps.get(c)?.kind).toBe("added");
    expect(diff.steps.get(ids.discovery)?.kind).toBe("removed");
  });

  it("swaps a group for the block, taking the steps inside it out", () => {
    const live = nested();
    const goneKids = childrenIds(live, DEMO_GROUP_IDS.setup);
    const { edit, id } = replaceWithBlock(live, DEMO_GROUP_IDS.setup, sales(), "Sales conversation")!;
    const after = applyEdit(live, edit);
    for (const g of [DEMO_GROUP_IDS.setup, ...goneKids]) expect(after.steps.some((s) => s.id === g)).toBe(false);
    expect(into(after, id).length).toBeGreaterThan(0);
    expect(from(after, id).length).toBeGreaterThan(0);
    // No connection is left pointing at a step that is gone.
    const present = new Set(after.steps.map((s) => s.id));
    expect(after.edges.every((e) => present.has(e.from_step_id) && present.has(e.to_step_id))).toBe(true);
  });

  it("works inside nested groups, and a group's first step that is replaced is replaced as the first step", () => {
    const b = nested();
    // Qualify lead is the first step of Sales conversation.
    const { edit, id } = replaceWithBlock(b, ids.qualify, nestedBlock().block, "Setup")!;
    const after = applyEdit(b, edit);
    expect(stepOf(after, id).parent_step_id).toBe(DEMO_GROUP_IDS.conversation);
    expect(stepOf(after, DEMO_GROUP_IDS.conversation).entry_step_id).toBe(id);
    expect(childrenIds(after, id)).toHaveLength(2);
    for (const g of after.steps.filter((s) => s.kind === "group")) expect(childrenIds(after, g.id)).toContain(g.entry_step_id);
    // Two levels down.
    const deep = applyEdit(b, groupSteps(b, [ids.qualify])!.edit);
    const inner = stepOf(deep, ids.qualify).parent_step_id!;
    const again = replaceWithBlock(deep, ids.qualify, sales(), "Sales")!;
    const result = applyEdit(deep, again.edit);
    expect(stepOf(result, again.id).parent_step_id).toBe(inner);
    expect(stepOf(result, inner).entry_step_id).toBe(again.id);
  });

  it("keeps a group's connections, which start and end at steps inside it, so the process can still run", () => {
    for (const group of [DEMO_GROUP_IDS.conversation, DEMO_GROUP_IDS.setup]) {
      const live = nested();
      const { edit, id } = replaceWithBlock(live, group, sales(), "Sales conversation")!;
      const after = applyEdit(live, edit);
      expect(into(after, id).length, group).toBeGreaterThan(0);
      expect(from(after, id).length, group).toBeGreaterThan(0);
      // Nothing is left pointing at a step that is gone, nothing is flagged as a dead end, and the model builds and runs.
      const present = new Set(after.steps.map((x) => x.id));
      expect(after.edges.every((e) => present.has(e.from_step_id) && present.has(e.to_step_id))).toBe(true);
      expect([...stepWarnings(after).values()].filter((w) => /Nothing leaves|no outgoing/.test(w)), group).toEqual([]);
      const model = toEngineModel(after, { startDate: START });
      expect(() => simulate(model, 2, 1)).not.toThrow();
      // Undo brings the group and its connections back exactly.
      const undone = applyEdit(after, invertEdit(edit));
      expect(undone.edges.map((e) => [e.id, e.from_step_id, e.to_step_id]).sort()).toEqual(live.edges.map((e) => [e.id, e.from_step_id, e.to_step_id]).sort());
      expect(undone.steps.map((x) => x.id).sort()).toEqual(live.steps.map((x) => x.id).sort());
    }
  });

  it("keeps the exits of one step, and says so, when a group is left from several", () => {
    const b = nested();
    const extra = { ...from(b, ids.discovery)[0]!, id: "e9999999-0000-4000-8000-000000000001", from_step_id: ids.qualify, probability: 0.1 };
    const many = { ...b, edges: [...b.edges, extra] };
    const placed = replaceWithBlock(many, DEMO_GROUP_IDS.conversation, sales(), "Sales conversation")!;
    expect(placed.note).toMatch(/exits from 2 steps/);
    const after = applyEdit(many, placed.edit);
    const total = from(after, placed.id).reduce((t, e) => t + Number(e.probability), 0);
    expect(total).toBeLessThanOrEqual(1.0001);
  });

  it("can be undone", () => {
    const live = nested();
    const { edit } = replaceWithBlock(live, DEMO_GROUP_IDS.setup, sales(), "Sales conversation")!;
    const undone = applyEdit(applyEdit(live, edit), invertEdit(edit));
    expect(undone.steps.map((s) => s.id).sort()).toEqual(live.steps.map((s) => s.id).sort());
    expect(undone.edges.map((e) => [e.id, e.from_step_id, e.to_step_id]).sort()).toEqual(live.edges.map((e) => [e.id, e.from_step_id, e.to_step_id]).sort());
  });

  it("clears a rework that pointed at the replaced step", () => {
    const live = flat();
    const loop = { ...stepOf(live, ids.audit), rework_to_step_id: ids.discovery, rework_rate: 0.1 };
    const b = { ...live, steps: live.steps.map((s) => (s.id === ids.audit ? loop : s)) };
    const after = applyEdit(b, replaceWithBlock(b, ids.discovery, sales(), "Sales conversation")!.edit);
    expect(stepOf(after, ids.audit).rework_to_step_id).toBeNull();
  });

  it("says why it can't, and does nothing", () => {
    const b = flat();
    expect(replaceProblem(b, null)).toMatch(/Select/);
    expect(replaceProblem(b, ids.start)).toMatch(/start and end/);
    expect(replaceProblem(b, ids.discovery)).toBeNull();
    expect(replaceWithBlock(b, ids.start, sales(), "X")).toBeNull();
    expect(replaceWithBlock(b, "ghost", sales(), "X")).toBeNull();
  });
});

// Capacity P8: a block carries each step's base values, and a solution's map says which blocks it holds.
describe("base values travel with a block", () => {
  const SPLIT = { automatable: 0.4, augmentable: 0.35, manual: 0.25 };
  const NOTES = { automatable: "Pull the data", augmentable: "Draft the notes", manual: "Talk to the client" };
  const MULT = { T1: 1.5, T3: 0.5 };
  const PROV = { work: { source: "interview", at: "2027-01-05", by: "someone" }, split: { source: "measured", at: "2027-01-06", by: "someone" } };

  /** The nested demo with base values on the Sales conversation's steps. */
  function withBase(): ProcessBundle {
    const b = nested();
    return {
      ...b,
      steps: b.steps.map((s) =>
        s.id === ids.qualify
          ? { ...s, split: { ...SPLIT }, split_notes: { ...NOTES }, tier_multiplier: { ...MULT }, to_client_manager: true, provenance: { ...PROV } }
          : s.id === ids.discovery
            ? { ...s, split: { automatable: 0, augmentable: 0.5, manual: 0.5 } }
            : s,
      ),
    };
  }

  it("keeps the split, notes, tier multipliers, client-manager flag and sources when a group is saved, stored as JSON and put back in", () => {
    const saved = blockFromGroup(withBase(), DEMO_GROUP_IDS.conversation)!;
    // What the database holds is a JSON document: it comes back through readBlock.
    const block = readBlock(JSON.parse(JSON.stringify(saved)));
    const q = block.steps.find((x) => x.id === ids.qualify)!;
    expect(q.split).toEqual(SPLIT);
    expect(q.split_notes).toEqual(NOTES);
    expect(q.tier_multiplier).toEqual(MULT);
    expect(q.to_client_manager).toBe(true);
    expect(q.provenance).toEqual(PROV);

    const live = flat();
    const after = applyEdit(live, insertBlock(live, ids.audit, block, "Sales conversation")!.edit);
    const added = after.steps.filter((x) => !live.steps.some((o) => o.id === x.id) && x.kind !== "group");
    const copy = added.find((x) => x.name === "Qualify lead")!;
    expect(copy.id).not.toBe(ids.qualify);
    expect(copy.split).toEqual(SPLIT);
    expect(copy.split_notes).toEqual(NOTES);
    expect(copy.tier_multiplier).toEqual(MULT);
    expect(copy.to_client_manager).toBe(true);
    expect(copy.provenance).toEqual(PROV);
    expect(added.find((x) => x.name === "Discovery call")!.split).toEqual({ automatable: 0, augmentable: 0.5, manual: 0.5 });
    // It is a copy: changing the inserted step's split leaves the block alone.
    copy.split!.automatable = 0.9;
    expect(block.steps.find((x) => x.id === ids.qualify)!.split).toEqual(SPLIT);
  });

  it("keeps them when a block replaces a step, and when the whole map is saved from block mode", () => {
    const whole = blockFromSteps(withBase());
    expect(whole.steps.find((x) => x.id === ids.qualify)!.split).toEqual(SPLIT);
    const block = blockFromGroup(withBase(), DEMO_GROUP_IDS.conversation)!;
    const live = flat();
    const after = applyEdit(live, replaceWithBlock(live, ids.discovery, block, "Sales conversation")!.edit);
    expect(after.steps.find((x) => x.name === "Qualify lead" && x.id !== ids.qualify)!.tier_multiplier).toEqual(MULT);
  });

  it("an older block with no base values puts in steps with none", () => {
    const old = sales();
    const live = flat();
    const after = applyEdit(live, insertBlock(live, ids.audit, old, "Old")!.edit);
    const copy = after.steps.find((x) => x.name === "Discovery call" && x.id !== ids.discovery)!;
    expect(copy.split ?? null).toBeNull();
    expect(copy.to_client_manager === true).toBe(false);
  });

  it("the block page draws each step's split bar", () => {
    const block = readBlock(JSON.parse(JSON.stringify(blockFromGroup(withBase(), DEMO_GROUP_IDS.conversation)!)));
    const html = renderToStaticMarkup(createElement(BlockSteps, { block }));
    expect((html.match(/data-split-bar/g) ?? []).length).toBe(2);
    expect(html).toContain("Automatable 40%");
    expect(html).toContain("T1 ×1.5");
    expect(html).toContain("the client&#x27;s manager");
  });
});

describe("used in N solutions", () => {
  const BLOCK = { id: "b0000000-0000-4000-8000-000000000001" };
  const OTHER = { id: "b0000000-0000-4000-8000-000000000002" };
  /** A solution holding the map the Editor leaves after inserting the block `times` times. */
  function solutionWith(block: { id: string } | null, times = 1) {
    let map = flat();
    for (let i = 0; i < times; i++) map = applyEdit(map, insertBlock(map, ids.audit, sales(), "Sales conversation", block?.id ?? null)!.edit);
    return { steps: { steps: map.steps, edges: map.edges, entry_step_id: null } } as never;
  }

  it("marks the group an insert makes with the block it came from", () => {
    const live = flat();
    const made = insertBlock(live, ids.audit, sales(), "S", BLOCK.id)!;
    const group = applyEdit(live, made.edit).steps.find((x) => x.id === made.id)!;
    expect(blockOfStep(group)).toBe(BLOCK.id);
    const plain = insertBlock(live, ids.audit, sales(), "S")!;
    expect(blockOfStep(applyEdit(live, plain.edit).steps.find((x) => x.id === plain.id)!)).toBeNull();
    const replaced = replaceWithBlock(live, ids.discovery, sales(), "S", BLOCK.id)!;
    expect(blockOfStep(applyEdit(live, replaced.edit).steps.find((x) => x.id === replaced.id)!)).toBe(BLOCK.id);
  });

  it("is 0 with no solutions, 1 with one, 2 with two (a block put in twice in one solution counts once)", () => {
    expect(blockUsage([])).toEqual({});
    expect(blockUsage([solutionWith(BLOCK)])[BLOCK.id]).toBe(1);
    expect(blockUsage([solutionWith(BLOCK), solutionWith(BLOCK, 2)])[BLOCK.id]).toBe(2);
  });

  it("counts each block on its own, and not a solution that holds none of them", () => {
    const usage = blockUsage([solutionWith(BLOCK), solutionWith(OTHER), solutionWith(null), { steps: { steps: [], edges: [], entry_step_id: null } } as never]);
    expect(usage).toEqual({ [BLOCK.id]: 1, [OTHER.id]: 1 });
  });
});
