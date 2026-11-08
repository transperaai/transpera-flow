import { describe, expect, it } from "vitest";
import { northbeamStepIds as ids, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { addEdge, stepWarnings } from "@/lib/editor/commands";
import { addAfter, addDecision, groupSteps } from "@/lib/editor/groups";
import { addBranch, branchesOf, isGoBack, removeBranch, setBranchCondition, setBranchName, setBranchShare, setBranchTarget, type BranchResult } from "@/lib/editor/branches";
import { applyEdit, invertEdit, type Edit } from "@/lib/editor/ops";
import { demoBundle } from "@/lib/sources/demo";

// The data side of the simpler editor's decisions (editor brainstorm, items 5 and 6): a decision comes with two branches, shares
// always add up to 100%, a branch can lead on, go back to an earlier step or end, and a go back is just a line the engine loops on.

const START = "2026-10-05";
const flat = () => demoBundle();
const modelOf = (b: ProcessBundle) => toEngineModel(b, { startDate: START });
const stepOf = (b: ProcessBundle, id: string) => b.steps.find((s) => s.id === id)!;
const nameOf = (b: ProcessBundle, id: string) => stepOf(b, id).name;
const percents = (b: ProcessBundle, id: string) => branchesOf(b, id).map((e) => Math.round(Number(e.probability) * 100));
const total = (b: ProcessBundle, id: string) => branchesOf(b, id).reduce((n, e) => n + Number(e.probability), 0);
const edit = (r: BranchResult): Edit => {
  if (!r || "problem" in r) throw new Error(`expected an edit, got ${JSON.stringify(r)}`);
  return r.edit;
};
const problem = (r: BranchResult) => (r && "problem" in r ? r.problem : null);
/** The bundle with every step that leads nowhere sent to Lost, so it can be simulated. */
const runnable = (b: ProcessBundle): ProcessBundle =>
  b.steps.filter((s) => s.kind === "task" && !b.edges.some((e) => e.from_step_id === s.id)).reduce((cur, s) => applyEdit(cur, addEdge(cur, s.id, ids.lost)!.edit), b);
const roundTrips = (b: ProcessBundle, e: Edit) => expect(applyEdit(applyEdit(b, e), invertEdit(e))).toEqual(b);

/** A bundle with a fresh decision (Yes / No at 50%) after Audit & proposal, and its id. */
function withDecision(): { b: ProcessBundle; d: string } {
  const b = flat();
  const made = addDecision(b, ids.audit);
  return { b: applyEdit(b, made.edit), d: made.id };
}

describe("addDecision", () => {
  it("joins a decision in after the selection: the old next step is Yes, a new 'Next step' is No, 50% each", () => {
    const b = flat();
    const { edit: e, id } = addDecision(b, ids.audit);
    const after = applyEdit(b, e);
    expect(stepOf(after, id).kind).toBe("decision");
    expect(from(after, ids.audit).map((x) => x.to_step_id)).toEqual([id]);
    const [yes, no] = branchesOf(after, id);
    expect([yes!.label, yes!.to_step_id]).toEqual(["Yes", ids.decision]);
    expect([no!.label, nameOf(after, no!.to_step_id)]).toEqual(["No", "Next step"]);
    expect([Number(yes!.probability), Number(no!.probability)]).toEqual([0.5, 0.5]);
    // The share the selection had into its next step carries on into the decision.
    expect(Number(from(after, ids.audit)[0]!.probability)).toBe(1);
    expect(stepWarnings(after).get(id)).toBeUndefined();
    roundTrips(b, e);
  });

  it("gives both branches a new step when the selection has no next step", () => {
    const b = flat();
    const lone = applyEdit(b, addAfter(b, null, "task").edit);
    const loneId = lone.steps.find((s) => !b.steps.some((o) => o.id === s.id))!.id;
    const { edit: e, id } = addDecision(lone, loneId);
    const after = applyEdit(lone, e);
    expect(from(after, loneId).map((x) => x.to_step_id)).toEqual([id]);
    expect(branchesOf(after, id).map((x) => [x.label, nameOf(after, x.to_step_id), Number(x.probability)])).toEqual([
      ["Yes", "Next step", 0.5],
      ["No", "Next step", 0.5],
    ]);
    expect(new Set(branchesOf(after, id).map((x) => x.to_step_id)).size).toBe(2);
  });

  it("is the last step of a process: Go live leads to Won, which becomes Yes", () => {
    const b = flat();
    const { edit: e, id } = addDecision(b, ids.live);
    const after = applyEdit(b, e);
    expect(branchesOf(after, id)[0]!.to_step_id).toBe(ids.won);
    expect(from(after, ids.live).map((x) => x.to_step_id)).toEqual([id]);
  });

  it("goes beside a step with branches, an end step, or nothing selected, unconnected, with its two new steps", () => {
    const b = flat();
    for (const sel of [ids.qualify, ids.won, null]) {
      const { edit: e, id, note } = addDecision(b, sel);
      const after = applyEdit(b, e);
      expect(after.edges.filter((x) => x.to_step_id === id)).toHaveLength(0);
      expect(branchesOf(after, id)).toHaveLength(2);
      expect(note !== undefined).toBe(sel !== null);
      // The selection's own lines are untouched.
      if (sel) expect(from(after, sel)).toEqual(from(b, sel));
    }
  });

  it("is what the palette's decision adds", () => {
    const b = flat();
    const palette = addAfter(b, ids.audit, "decision");
    expect(palette.edit.ops.map((o) => o.kind)).toEqual(addDecision(b, ids.audit).edit.ops.map((o) => o.kind));
    const after = applyEdit(b, palette.edit);
    expect(branchesOf(after, palette.id)).toHaveLength(2);
  });

  it("places the 'Next step' in view and clear of the decision", () => {
    const b = flat();
    const view = { x: 4000, y: 3000 };
    const { edit: e, id } = addDecision(b, null, view);
    const after = applyEdit(b, e);
    const d = stepOf(after, id);
    const next = branchesOf(after, id).map((x) => stepOf(after, x.to_step_id));
    for (const s of [d, ...next]) {
      expect(Math.abs(Number(s.x) - 4000)).toBeLessThan(700);
      expect(Math.abs(Number(s.y) - 3000)).toBeLessThan(700);
    }
    expect(new Set([d, ...next].map((s) => `${s.x},${s.y}`)).size).toBe(3);
  });
});

const from = (b: ProcessBundle, id: string) => b.edges.filter((e) => e.from_step_id === id);

/** A decision with Yes 50 / No 30 / Maybe 20. */
function threeWay() {
  const start = withDecision();
  const d = start.d;
  let b = applyEdit(start.b, edit(addBranch(start.b, d, ids.lost)));
  const changes = branchesOf(b, d).map((e, i) => ({ table: "edges" as const, id: e.id, before: { probability: e.probability }, after: { probability: [0.5, 0.3, 0.2][i]! } }));
  b = applyEdit(b, { label: "", ops: [{ kind: "update", changes }] });
  expect(percents(b, d)).toEqual([50, 30, 20]);
  return { b, d };
}

describe("setBranchShare", () => {
  it("sets a branch and gives the other the rest", () => {
    const { b, d } = withDecision();
    const [yes] = branchesOf(b, d);
    const e = setBranchShare(b, d, yes!.id, 70)!;
    const after = applyEdit(b, e);
    expect(percents(after, d)).toEqual([70, 30]);
    roundTrips(b, e);
  });

  it("treats the last branch like any other", () => {
    const { b, d } = withDecision();
    const last = branchesOf(b, d)[1]!;
    expect(percents(applyEdit(b, setBranchShare(b, d, last.id, 20)!), d)).toEqual([80, 20]);
  });

  it("shares the difference across the others in proportion to what they had (round 2, item 12)", () => {
    const { b, d } = threeWay();
    const [yes, no, maybe] = branchesOf(b, d);
    // 60 on Yes: No and Maybe share 40 as 30 : 20.
    expect(percents(applyEdit(b, setBranchShare(b, d, yes!.id, 60)!), d)).toEqual([60, 24, 16]);
    // 61 on Yes: 39 as 30 : 20 is 23.4 and 15.6; rounded down that is 38, and the 1 left goes to the larger (No).
    expect(percents(applyEdit(b, setBranchShare(b, d, yes!.id, 61)!), d)).toEqual([61, 24, 15]);
    // Down works the same way: 10 on Yes leaves 90 as 30 : 20.
    expect(percents(applyEdit(b, setBranchShare(b, d, yes!.id, 10)!), d)).toEqual([10, 54, 36]);
    // A middle or last branch too: 50 on Maybe leaves 50 as 50 : 30, which is 31.25 and 18.75; the 1 left goes to Yes.
    expect(percents(applyEdit(b, setBranchShare(b, d, maybe!.id, 50)!), d)).toEqual([32, 18, 50]);
    expect(percents(applyEdit(b, setBranchShare(b, d, no!.id, 0)!), d)).toEqual([72, 0, 28]);
  });

  it("splits evenly when the others are all at 0%", () => {
    const { b, d } = threeWay();
    const [yes] = branchesOf(b, d);
    const all = applyEdit(b, setBranchShare(b, d, yes!.id, 100)!);
    expect(percents(all, d)).toEqual([100, 0, 0]);
    expect(percents(applyEdit(all, setBranchShare(all, d, yes!.id, 40)!), d)).toEqual([40, 30, 30]);
    // An odd remainder goes to the first of equals.
    expect(percents(applyEdit(all, setBranchShare(all, d, yes!.id, 99)!), d)).toEqual([99, 1, 0]);
  });

  it("counts a go back as a branch like any other", () => {
    const { b: start, d } = threeWay();
    const maybe = branchesOf(start, d)[2]!;
    const b = applyEdit(start, edit(setBranchTarget(start, maybe.id, { goBackTo: ids.qualify })));
    expect(isGoBack(b, maybe.id)).toBe(true);
    expect(percents(applyEdit(b, setBranchShare(b, d, branchesOf(b, d)[0]!.id, 60)!), d)).toEqual([60, 24, 16]);
  });

  it("handles 0% and 100%", () => {
    const { b, d } = withDecision();
    const [yes, no] = branchesOf(b, d);
    expect(percents(applyEdit(b, setBranchShare(b, d, yes!.id, 0)!), d)).toEqual([0, 100]);
    expect(percents(applyEdit(b, setBranchShare(b, d, yes!.id, 100)!), d)).toEqual([100, 0]);
    expect(percents(applyEdit(b, setBranchShare(b, d, no!.id, 100)!), d)).toEqual([0, 100]);
    expect(percents(applyEdit(b, setBranchShare(b, d, no!.id, 0)!), d)).toEqual([100, 0]);
    // A branch at 0% is still a branch: the process still has no warnings.
    expect(stepWarnings(applyEdit(b, setBranchShare(b, d, yes!.id, 0)!)).get(d)).toBeUndefined();
  });

  it("always adds up to exactly 100 whole percents, however it is set", () => {
    const start = withDecision();
    const d = start.d;
    let b = start.b;
    b = applyEdit(b, edit(addBranch(b, d, ids.lost)));
    b = applyEdit(b, edit(addBranch(b, d, ids.won)));
    for (const [i, value] of [[0, 33], [1, 77], [3, 5], [2, 99.6], [0, 0], [3, 100], [1, 1], [2, 37], [0, 50]] as const) {
      const e = setBranchShare(b, d, branchesOf(b, d)[i]!.id, value);
      if (e) b = applyEdit(b, e);
      const p = percents(b, d);
      expect(p.reduce((n, x) => n + x, 0)).toBe(100);
      expect(p.every((x) => Number.isInteger(x) && x >= 0 && x <= 100)).toBe(true);
      expect(Math.abs(total(b, d) - 1)).toBeLessThan(1e-9);
    }
  });

  it("settles a share that was not a whole percent, and does nothing when nothing changes", () => {
    const { b, d } = withDecision();
    const [yes] = branchesOf(b, d);
    expect(setBranchShare(b, d, yes!.id, 50)).toBeNull();
    const odd = applyEdit(b, { label: "", ops: [{ kind: "update", changes: [{ table: "edges", id: yes!.id, before: { probability: 0.5 }, after: { probability: 0.333 } }] }] });
    expect(percents(applyEdit(odd, setBranchShare(odd, d, yes!.id, 40)!), d)).toEqual([40, 60]);
  });

  it("refuses what is not a share, a line that is not the decision's, and a decision's only branch", () => {
    const { b, d } = withDecision();
    const [yes] = branchesOf(b, d);
    for (const v of [-1, 101, Number.NaN, Infinity]) expect(setBranchShare(b, d, yes!.id, v)).toBeNull();
    expect(setBranchShare(b, d, from(b, ids.qualify)[0]!.id, 50)).toBeNull();
    // Qualify's only branch... Audit has exactly one line out: that is always 100%.
    expect(setBranchShare(b, ids.audit, from(b, ids.audit)[0]!.id, 50)).toBeNull();
  });
});

describe("addBranch and setBranchTarget", () => {
  it("adds a branch to a step with an even share, the others making room in proportion", () => {
    const { b, d } = withDecision();
    const r = addBranch(b, d, ids.lost);
    const after = applyEdit(b, edit(r));
    // 100 / 3 is 33; Yes and No share 67 evenly, and the 1 left over goes to the first of equals.
    expect(percents(after, d)).toEqual([34, 33, 33]);
    expect(branchesOf(after, d)[2]!.to_step_id).toBe(ids.lost);
    expect(branchesOf(after, d)[2]!.label).toBe("Branch 3");
    expect(stepWarnings(after).get(d)).toBeUndefined();
    roundTrips(b, edit(r));
  });

  it("refuses a step the decision already leads to, itself, the start, and a missing step", () => {
    const { b, d } = withDecision();
    expect(problem(addBranch(b, d, ids.decision))).toMatch(/already connected/);
    expect(problem(addBranch(b, d, d))).toMatch(/can't lead to itself/);
    expect(problem(addBranch(b, d, ids.start))).toMatch(/start/);
    expect(problem(addBranch(b, d, "nope"))).toMatch(/Connect two steps/);
    expect(addBranch(b, "nope", ids.lost)).toBeNull();
  });

  it("makes a go back to an earlier step, and the engine loops on it", () => {
    const { b, d } = withDecision();
    const r = addBranch(b, d, { goBackTo: ids.qualify });
    const after = applyEdit(b, edit(r));
    const line = branchesOf(after, d)[2]!;
    expect(line.to_step_id).toBe(ids.qualify);
    expect(isGoBack(after, line.id)).toBe(true);
    expect(isGoBack(after, branchesOf(after, d)[0]!.id)).toBe(false);
    const result = simulate(modelOf(runnable(after)), 3, 1);
    expect(result.loops!.some((l) => l.kind === "back-edge" && l.to === ids.qualify)).toBe(true);
  });

  it("refuses a go back to a step that doesn't lead to the decision, the decision itself, the start or an end", () => {
    const { b, d } = withDecision();
    expect(problem(addBranch(b, d, { goBackTo: ids.kickoff }))).toMatch(/doesn't lead to this decision/);
    expect(problem(addBranch(b, d, { goBackTo: d }))).toMatch(/can't go back to itself/);
    expect(problem(addBranch(b, d, { goBackTo: ids.start }))).toMatch(/not to the start or an end/);
    expect(problem(addBranch(b, d, { goBackTo: ids.won }))).toMatch(/not to the start or an end/);
    expect(problem(addBranch(b, d, { goBackTo: "nope" }))).toMatch(/Pick the step/);
  });

  it("allows a go back to the step just before the decision, but a step that only leads to it through a group works too", () => {
    const { b, d } = withDecision();
    const after = applyEdit(b, edit(addBranch(b, d, { goBackTo: ids.audit })));
    expect(isGoBack(after, branchesOf(after, d)[2]!.id)).toBe(true);
  });

  it("ends a branch: reuses an end with that outcome, or makes one", () => {
    const { b, d } = withDecision();
    const lost = applyEdit(b, edit(addBranch(b, d, { end: "lost" })));
    expect(branchesOf(lost, d)[2]!.to_step_id).toBe(ids.lost);
    expect(lost.steps).toHaveLength(b.steps.length);
    const done = applyEdit(b, edit(addBranch(b, d, { end: "done" })));
    const made = stepOf(done, branchesOf(done, d)[2]!.to_step_id);
    expect([made.kind, made.outcome]).toEqual(["end", "done"]);
    expect(done.steps).toHaveLength(b.steps.length + 1);
    roundTrips(b, edit(addBranch(b, d, { end: "done" })));
    // A second branch to done reuses the end the first one made.
    const again = applyEdit(done, edit(addBranch(done, d, { end: "done" })));
    expect(again.steps).toHaveLength(done.steps.length);
  });

  it("allows won and lost in a pipeline only", () => {
    const { b, d } = withDecision();
    const servicing = { ...b, process: { ...b.process, kind: "servicing" as const } };
    expect(problem(addBranch(servicing, d, { end: "won" }))).toMatch(/pipelines/);
    expect(problem(addBranch(servicing, d, { end: "lost" }))).toMatch(/pipelines/);
    expect(addBranch(servicing, d, { end: "done" })).toHaveProperty("edit");
    expect(addBranch(b, d, { end: "won" })).toHaveProperty("edit");
  });

  it("moves an existing branch to a step, a go back or an end, keeping its name and share", () => {
    const { b, d } = withDecision();
    const [yes, no] = branchesOf(b, d);
    const toStep = applyEdit(b, edit(setBranchTarget(b, no!.id, ids.lost)));
    expect(branchesOf(toStep, d)[1]).toMatchObject({ id: no!.id, label: "No", to_step_id: ids.lost });
    expect(percents(toStep, d)).toEqual([50, 50]);
    const back = applyEdit(b, edit(setBranchTarget(b, no!.id, { goBackTo: ids.qualify })));
    expect(isGoBack(back, no!.id)).toBe(true);
    expect(isGoBack(applyEdit(back, edit(setBranchTarget(back, no!.id, ids.lost))), no!.id)).toBe(false);
    const ended = applyEdit(b, edit(setBranchTarget(b, yes!.id, { end: "done" })));
    expect(stepOf(ended, branchesOf(ended, d)[0]!.to_step_id).outcome).toBe("done");
    roundTrips(b, edit(setBranchTarget(b, yes!.id, { end: "done" })));
    // Nothing to do, and the refusals.
    expect(setBranchTarget(b, yes!.id, ids.decision)).toBeNull();
    expect(problem(setBranchTarget(b, no!.id, ids.decision))).toMatch(/already connected/);
    expect(problem(setBranchTarget(b, no!.id, { goBackTo: d }))).toMatch(/itself/);
    expect(problem(setBranchTarget(b, no!.id, { goBackTo: ids.kickoff }))).toMatch(/doesn't lead/);
    expect(setBranchTarget(b, "nope", ids.lost)).toBeNull();
  });

  it("goes back to the decision's own step from inside a loop: a decision that is the last of a loop", () => {
    // Client decision already sends 68% to Lost. A go back from it to Qualify lead is a loop through Discovery and Audit.
    const b = flat();
    const after = applyEdit(b, edit(addBranch(b, ids.decision, { goBackTo: ids.discovery })));
    const line = branchesOf(after, ids.decision).find((e) => e.to_step_id === ids.discovery)!;
    expect(isGoBack(after, line.id)).toBe(true);
    expect(Math.abs(total(after, ids.decision) - 1)).toBeLessThan(1e-9);
    expect(simulate(modelOf(runnable(after)), 3, 1).loops!.length).toBeGreaterThan(0);
  });
});

describe("isGoBack", () => {
  it("is false for a line that moves forward, and for one that is not there", () => {
    const b = flat();
    for (const e of b.edges) expect(isGoBack(b, e.id)).toBe(false);
    expect(isGoBack(b, "nope")).toBe(false);
  });

  it("sees a loop through a group", () => {
    const { b, d } = withDecision();
    // Put Discovery call in a group: a go back to it is still a loop.
    const grouped = applyEdit(b, groupSteps(b, [ids.discovery])!.edit);
    const after = applyEdit(grouped, edit(addBranch(grouped, d, { goBackTo: ids.discovery })));
    expect(isGoBack(after, branchesOf(after, d)[2]!.id)).toBe(true);
  });
});

describe("branch names and conditions", () => {
  it("renames a branch and sets its 'Only when…'", () => {
    const { b, d } = withDecision();
    const [yes] = branchesOf(b, d);
    const named = applyEdit(b, setBranchName(b, yes!.id, "  Approved ")!);
    expect(branchesOf(named, d)[0]!.label).toBe("Approved");
    const tagged = applyEdit(named, setBranchCondition(named, yes!.id, "seo")!);
    expect(branchesOf(tagged, d)[0]!.condition_tag).toBe("seo");
    expect(branchesOf(applyEdit(tagged, setBranchCondition(tagged, yes!.id, "  ")!), d)[0]!.condition_tag).toBeNull();
    expect(branchesOf(applyEdit(named, setBranchName(named, yes!.id, "")!), d)[0]!.label).toBeNull();
  });

  it("does nothing when nothing changes, and refuses text that is too long", () => {
    const { b, d } = withDecision();
    const [yes] = branchesOf(b, d);
    expect(setBranchName(b, yes!.id, "Yes")).toBeNull();
    expect(setBranchCondition(b, yes!.id, "")).toBeNull();
    expect(setBranchName(b, yes!.id, "x".repeat(201))).toBeNull();
    expect(setBranchCondition(b, yes!.id, "x".repeat(101))).toBeNull();
    expect(setBranchName(b, "nope", "A")).toBeNull();
  });
});

describe("removeBranch", () => {
  it("takes a branch off and the others grow in proportion, so the shares still add to 100%", () => {
    const { b: three, d } = threeWay();
    const [yes, no, maybe] = branchesOf(three, d);
    const e = removeBranch(three, yes!.id)!;
    const after = applyEdit(three, e);
    // No and Maybe share 100 as 30 : 20.
    expect(percents(after, d)).toEqual([60, 40]);
    expect(branchesOf(after, d).map((x) => x.id)).toEqual([no!.id, maybe!.id]);
    expect(total(after, d)).toBeCloseTo(1, 10);
    // 50 : 20 is 71.4 and 28.6; rounded down that is 99, and the 1 left goes to the larger.
    expect(percents(applyEdit(three, removeBranch(three, no!.id)!), d)).toEqual([72, 28]);
    // Undo puts the line and its share back (the line comes back at the end of the list).
    const undone = applyEdit(after, invertEdit(e));
    const byId = (x: ProcessBundle) => [...x.edges].sort((p, q) => p.id.localeCompare(q.id));
    expect(byId(undone)).toEqual(byId(three));
  });

  it("splits evenly among the branches left when they were all at 0%", () => {
    const { b: three, d } = threeWay();
    const [yes, no] = branchesOf(three, d);
    const all = applyEdit(three, setBranchShare(three, d, yes!.id, 100)!);
    expect(percents(applyEdit(all, removeBranch(all, yes!.id)!), d)).toEqual([50, 50]);
    expect(percents(applyEdit(all, removeBranch(all, no!.id)!), d)).toEqual([100, 0]);
  });

  it("removing one of two leaves the other at 100%", () => {
    const { b, d } = withDecision();
    const [yes, no] = branchesOf(b, d);
    const after = applyEdit(b, removeBranch(b, no!.id)!);
    expect(percents(after, d)).toEqual([100]);
    expect(branchesOf(after, d)[0]!.id).toBe(yes!.id);
  });

  it("never removes the only branch, or a line that isn't a branch", () => {
    const { b, d } = withDecision();
    const [yes, no] = branchesOf(b, d);
    const one = applyEdit(b, removeBranch(b, no!.id)!);
    expect(removeBranch(one, yes!.id)).toBeNull();
    expect(removeBranch(b, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
