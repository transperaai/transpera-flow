import { afterEach, describe, expect, it, vi } from "vitest";
import { isHolderStep, northbeamStepIds as ids, toEngineModel, type EdgeRow, type ProcessBundle, type ProcessPart, type StepRow } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { turnIntoSteps, turnIntoStepsProblem } from "@/lib/blocks/blocks";
import { applyEdit, invertEdit } from "@/lib/editor/ops";
import { nodeProblems } from "@/lib/editor/problems";
import { groupSteps } from "@/lib/editor/groups";
import { demoBundle } from "@/lib/sources/demo";

// A linked process becomes steps (editor brainstorm, item 3): the copy simulates to the same numbers as the link did.

const START = "2026-10-05";
/** Ids for the fixture's own rows: in order, and after Northbeam's, as the engine's order by id would see them in a real draft. */
let counter = 0;
const randomUUID = () => `f9000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
/** Rows in id order, so two bundles that hold the same rows compare equal whatever order they were put back in. */
const byId = (b: ProcessBundle): ProcessBundle => ({ ...b, steps: [...b.steps].sort((x, y) => x.id.localeCompare(y.id)), edges: [...b.edges].sort((x, y) => x.id.localeCompare(y.id)) });
const modelOf = (b: ProcessBundle) => toEngineModel(b, { startDate: START });
const row = (b: ProcessBundle, id: string, name: string, over: Partial<StepRow>): StepRow => ({
  ...b.steps[0]!,
  id,
  name,
  kind: "task",
  outcome: null,
  role_id: null,
  person_id: null,
  work_hours: 0,
  wait_hours: 0,
  rework_rate: 0,
  rework_to_step_id: null,
  parent_step_id: null,
  entry_step_id: null,
  child_process_id: null,
  ...over,
});
const line = (b: ProcessBundle, from: string, to: string, over: Partial<EdgeRow> = {}): EdgeRow => ({ ...b.edges[0]!, id: randomUUID(), from_step_id: from, to_step_id: to, probability: 1, condition_tag: null, label: null, ...over });

interface Fixture {
  bundle: ProcessBundle;
  holder: string;
  child: ProcessPart;
  grandchild?: ProcessPart;
}

/** Northbeam with its delivery (kickoff to go-live) held as a child process; `shape` changes the child before it is built. */
function withChild(shape: (child: ProcessPart, b: ProcessBundle, own: { start: string; done: string }) => void = () => undefined, holderLines?: (b: ProcessBundle, holder: string) => EdgeRow[]): Fixture {
  const b = demoBundle();
  const childId = randomUUID();
  const childRev = randomUUID();
  const inChild: string[] = [ids.kickoff, ids.seo, ids.ppc, ids.live];
  const ownerOf = { process_id: childId, revision_id: childRev };
  const start = randomUUID();
  const done = randomUUID();
  const holder = randomUUID();
  const child: ProcessPart = {
    process: { ...b.process, id: childId, name: "Delivery", live_revision_id: childRev, parent_process_id: b.process.id },
    revision: { ...b.revision, id: childRev, process_id: childId },
    steps: [
      ...b.steps.filter((s) => inChild.includes(s.id)).map((s) => ({ ...s, ...ownerOf })),
      row(b, start, "Start", { kind: "start", ...ownerOf }),
      row(b, done, "Done", { kind: "end", outcome: "done", ...ownerOf }),
    ],
    edges: [
      ...b.edges.filter((e) => inChild.includes(e.from_step_id)).map((e) => ({ ...e, ...ownerOf, to_step_id: e.from_step_id === ids.live ? done : e.to_step_id })),
      { ...line(b, start, ids.kickoff), ...ownerOf },
    ],
  };
  shape(child, b, { start, done });
  const steps = [...b.steps.filter((s) => !inChild.includes(s.id)), row(b, holder, "Delivery", { kind: "subprocess", child_process_id: childId, x: 290, y: 320 })];
  const kept = b.edges.filter((e) => !inChild.includes(e.from_step_id)).map((e) => (e.to_step_id === ids.kickoff ? { ...e, to_step_id: holder } : e));
  const edges = [...kept, ...(holderLines ? holderLines(b, holder) : [line(b, holder, ids.won)])];
  return { bundle: { ...b, steps, edges, otherProcesses: [...(b.otherProcesses ?? []), child] } as ProcessBundle, holder, child };
}

const owner = (p: ProcessPart) => ({ process_id: p.process.id, revision_id: p.revision.id });
const holders = (b: ProcessBundle) => b.steps.filter((s) => s.child_process_id);

/** The numbers a run reports, to compare two models whose steps carry different ids. */
const run = (b: ProcessBundle) => simulate(modelOf(b), 5, 1);

/** Ids the copy makes, in order and after the fixture's, so a run is the same every time (the engine orders steps by id). */
function fixedIds() {
  let n = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `ffffffff-0000-4000-8000-${String(++n).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`);
}
afterEach(() => vi.restoreAllMocks());

/**
 * The copy with the ids of the steps it was copied from put back (matched by name, which the fixture keeps unique): everything the
 * engine reads is then the same as when the process was linked, so the whole result must be equal.
 */
function withOriginalIds(f: Fixture, after: ProcessBundle, groupId: string): ProcessBundle {
  const originals = new Map([f.child, ...(f.bundle.otherProcesses ?? [])].flatMap((p) => p.steps.filter((s) => s.kind !== "start").map((s) => [s.name, s.id] as const)));
  const copies = new Map(after.steps.filter((s) => s.id !== groupId && !f.bundle.steps.some((o) => o.id === s.id)).map((s) => [s.id, originals.get(s.name)!] as const));
  for (const [id, back] of copies) expect(back, `a step called like ${id}`).toBeDefined();
  const swap = (id: string | null) => (id === null ? null : (copies.get(id) ?? id));
  return {
    ...after,
    steps: after.steps.map((s) => ({ ...s, id: swap(s.id)!, parent_step_id: swap(s.parent_step_id), entry_step_id: swap(s.entry_step_id), rework_to_step_id: swap(s.rework_to_step_id) })),
    edges: after.edges.map((e) => ({ ...e, from_step_id: swap(e.from_step_id)!, to_step_id: swap(e.to_step_id)! })),
  };
}

/**
 * Turn the holder into steps and check the whole contract: no link left, nothing else touched, one undo, and the same simulation as
 * the link gave. Same seed and run count; the engine orders steps by id, so the copy is compared two ways: with the original ids put
 * back (the model and the whole summary are then exactly equal), and as it is (new ids), where the headline numbers must agree
 * within the noise of 5 runs.
 */
function turn(f: Fixture) {
  fixedIds();
  const made = turnIntoSteps(f.bundle, f.holder, f.child);
  vi.restoreAllMocks();
  expect(made, turnIntoStepsProblem(f.bundle, f.holder, f.child) ?? "").not.toBeNull();
  const after = applyEdit(f.bundle, made!.edit);
  expect(holders(after)).toHaveLength(0);
  expect(after.steps.some((s) => s.id === f.holder)).toBe(false);
  expect(byId(applyEdit(after, invertEdit(made!.edit)))).toEqual(byId(f.bundle));
  return { made: made!, after };
}

/** The link and the copy simulate the same: exactly, with the original ids put back; closely, with the new ones. */
function expectSameSimulation(f: Fixture, after: ProcessBundle, groupId: string) {
  const before = run(f.bundle);
  const back = withOriginalIds(f, after, groupId);
  expect(modelOf(back)).toEqual(modelOf(f.bundle));
  expect(run(back)).toEqual(before);
  const raw = run(after);
  for (const k of ["won", "lost", "cycleP50"] as const) expect(Math.abs(Number(raw[k]) - Number(before[k]))).toBeLessThanOrEqual(Math.abs(Number(before[k])) * 0.2 + 1);
}

describe("turnIntoSteps", () => {
  it("copies the held process in as a group named after it, with new ids and the layout kept", () => {
    const f = withChild();
    const { made, after } = turn(f);
    expectSameSimulation(f, after, made.id);
    const group = after.steps.find((s) => s.id === made.id)!;
    expect([group.kind, group.name, group.parent_step_id]).toEqual(["group", "Delivery", null]);
    expect([Number(group.x), Number(group.y)]).toEqual([290, 320]);
    const inside = after.steps.filter((s) => s.parent_step_id === group.id);
    expect(inside.map((s) => s.name).sort()).toEqual(["Go live & first report", "Kickoff & strategy", "PPC campaign setup", "SEO campaign setup"]);
    // Fresh ids: nothing shared with the process it came from.
    const old = new Set(f.child.steps.map((s) => s.id));
    expect(inside.every((s) => !old.has(s.id))).toBe(true);
    expect(after.steps.every((s) => s.process_id === f.bundle.revision.process_id && s.revision_id === f.bundle.revision.id)).toBe(true);
    // The group starts at the copy of the process's first step.
    expect(after.steps.find((s) => s.id === group.entry_step_id)!.name).toBe("Kickoff & strategy");
    // The relative layout is kept, with the box's padding around it.
    const kick = inside.find((s) => s.name === "Kickoff & strategy")!;
    const ppc = inside.find((s) => s.name === "PPC campaign setup")!;
    expect(Number(ppc.x) - Number(kick.x)).toBe(520 - 290);
  });

  it("wires it in like a block: lines into the holder go to the group, lines out of it go out of the group", () => {
    const f = withChild();
    const { made, after } = turn(f);
    expect(after.edges.filter((e) => e.to_step_id === made.id).map((e) => e.from_step_id)).toEqual([ids.onboard]);
    expect(after.edges.filter((e) => e.from_step_id === made.id).map((e) => [e.to_step_id, Number(e.probability)])).toEqual([[ids.won, 1]]);
    // The lines among the copied steps carry their shares and tags.
    const seo = after.steps.find((s) => s.parent_step_id === made.id && s.name === "SEO campaign setup")!;
    const kick = after.steps.find((s) => s.parent_step_id === made.id && s.name === "Kickoff & strategy")!;
    expect(after.edges.find((e) => e.from_step_id === kick.id && e.to_step_id === seo.id)).toMatchObject({ probability: 0.55, condition_tag: "seo" });
    expect(nodeProblems(after).total).toBe(0);
  });

  it("simulates to the same summary as the link did (done ends become the way out of the group)", () => {
    const f = withChild();
    const { made, after } = turn(f);
    expectSameSimulation(f, after, made.id);
  });

  it("keeps a held process's lost end as an end of this process, and its share", () => {
    const f = withChild((child, b) => {
      const lost = randomUUID();
      child.steps.push(row(b, lost, "Child lost", { kind: "end", outcome: "lost", ...owner(child) }));
      child.edges = child.edges.map((e) => (e.from_step_id === ids.kickoff && e.to_step_id === ids.seo ? { ...e, probability: 0.45 } : e));
      child.edges.push({ ...line(b, ids.kickoff, lost, { probability: 0.1 }), ...owner(child) });
    });
    const { made, after } = turn(f);
    expectSameSimulation(f, after, made.id);
    const copy = after.steps.find((s) => s.name === "Child lost")!;
    expect([copy.kind, copy.outcome, copy.parent_step_id]).toEqual(["end", "lost", null]);
    expect(copy.id).not.toBe(f.child.steps.find((s) => s.name === "Child lost")!.id);
    expect(made.note).toMatch(/lost end/);
    expect(modelOf(after).ends).toBeDefined();
    expect(run(after).lost).toBeGreaterThan(0);
  });

  it("runs the same when the copied lost end would sort ahead of the map's own (it is then the model's lost sink)", () => {
    const f = withChild((child, b) => {
      const lost = "01000000-0000-4000-8000-000000000001";
      child.steps.push(row(b, lost, "Child lost", { kind: "end", outcome: "lost", ...owner(child) }));
      child.edges = child.edges.map((e) => (e.from_step_id === ids.kickoff && e.to_step_id === ids.seo ? { ...e, probability: 0.45 } : e));
      child.edges.push({ ...line(b, ids.kickoff, lost, { probability: 0.1 }), ...owner(child) });
    });
    const { made, after } = turn(f);
    const back = withOriginalIds(f, after, made.id);
    expect(modelOf(back).sinks.lost).not.toBe(modelOf(f.bundle).sinks.lost);
    expect(run(back)).toEqual(run(f.bundle));
  });

  it("sends a step that also leaves some other way to the holder's next steps, shares multiplied in", () => {
    const f = withChild(
      (child, b) => {
        // Go live now also finishes the process 40% of the time before the last step: SEO -> done 40%.
        child.edges = child.edges.map((e) => (e.from_step_id === ids.seo ? { ...e, probability: 0.6 } : e));
        const done = child.steps.find((s) => s.kind === "end")!.id;
        child.edges.push({ ...line(b, ids.seo, done, { probability: 0.4, label: "early" }), ...owner(child) });
      },
      // The holder leaves to Won 70% and Lost 30%.
      (b, holder) => [line(b, holder, ids.won, { probability: 0.7 }), line(b, holder, ids.lost, { probability: 0.3, condition_tag: "late" })],
    );
    const { made, after } = turn(f);
    expectSameSimulation(f, after, made.id);
    const seo = after.steps.find((s) => s.parent_step_id === made.id && s.name === "SEO campaign setup")!;
    const out = after.edges.filter((e) => e.from_step_id === seo.id).map((e) => [e.to_step_id === ids.won ? "won" : e.to_step_id === ids.lost ? "lost" : "inside", Math.round(Number(e.probability) * 1e6) / 1e6, e.condition_tag, e.label]);
    expect(out).toContainEqual(["won", 0.28, null, "early"]);
    expect(out).toContainEqual(["lost", 0.12, "late", "early"]);
    expect(out.filter((o) => o[0] === "inside")).toHaveLength(1);
  });

  it("copies a process held inside it too, as a group inside the group, and leaves no link", () => {
    const innerBox: { part?: ProcessPart } = {};
    const f = withChild((child, b) => {
      // Inside Delivery, PPC set-up and Go live are another process, "Launch".
      const launchId = randomUUID();
      const launchRev = randomUUID();
      const lo = { process_id: launchId, revision_id: launchRev };
      const lStart = randomUUID();
      const lDone = randomUUID();
      const lost = randomUUID();
      const inner: ProcessPart = {
        process: { ...b.process, id: launchId, name: "Launch", live_revision_id: launchRev, parent_process_id: child.process.id },
        revision: { ...b.revision, id: launchRev, process_id: launchId },
        steps: [
          ...child.steps.filter((s) => s.id === ids.ppc || s.id === ids.live).map((s) => ({ ...s, ...lo })),
          row(b, lStart, "Start", { kind: "start", ...lo }),
          row(b, lDone, "Done", { kind: "end", outcome: "done", ...lo }),
          row(b, lost, "Launch lost", { kind: "end", outcome: "lost", ...lo }),
        ],
        edges: [
          { ...line(b, lStart, ids.ppc), ...lo },
          { ...line(b, ids.ppc, ids.live, { probability: 0.9 }), ...lo },
          { ...line(b, ids.ppc, lost, { probability: 0.1 }), ...lo },
          { ...line(b, ids.live, lDone), ...lo },
        ],
      };
      const hold = randomUUID();
      const co = owner(child);
      child.steps = [...child.steps.filter((s) => s.id !== ids.ppc && s.id !== ids.live), row(b, hold, "Launch", { kind: "subprocess", child_process_id: launchId, ...co })];
      // SEO and the launch both lead on to Done, as PPC and Go live did.
      child.edges = [
        ...child.edges.filter((e) => e.from_step_id !== ids.ppc && e.from_step_id !== ids.live).map((e) => (e.to_step_id === ids.ppc || e.to_step_id === ids.live ? { ...e, to_step_id: hold } : e)),
        { ...line(b, hold, child.steps.find((s) => s.kind === "end")!.id), ...co },
      ];
      // The inner process rides along on the bundle, as the model reads it.
      innerBox.part = inner;
    });
    const inner = innerBox.part!;
    f.bundle.otherProcesses = [...(f.bundle.otherProcesses ?? []), inner];
    expect(modelOf(f.bundle)).toBeDefined();
    const { made, after } = turn(f);
    expectSameSimulation(f, after, made.id);
    const launch = after.steps.find((s) => s.name === "Launch")!;
    expect([launch.kind, launch.parent_step_id, launch.child_process_id]).toEqual(["group", made.id, null]);
    expect(after.steps.filter((s) => s.parent_step_id === launch.id).map((s) => s.name).sort()).toEqual(["Go live & first report", "PPC campaign setup"]);
    expect(after.steps.find((s) => s.name === "Launch lost")!.outcome).toBe("lost");
    expect(nodeProblems(after).total).toBe(0);
  });

  it("works for a holder inside a group, and keeps it as the group's first step", () => {
    const f = withChild();
    const grouped = groupSteps(f.bundle, [f.holder])!;
    const inGroup = applyEdit(f.bundle, grouped.edit);
    expect(inGroup.steps.find((s) => s.id === grouped.id)!.entry_step_id).toBe(f.holder);
    const { made, after } = turn({ ...f, bundle: inGroup });
    const outer = after.steps.find((s) => s.id === grouped.id)!;
    expect(outer.entry_step_id).toBe(made.id);
    expect(after.steps.find((s) => s.id === made.id)!.parent_step_id).toBe(outer.id);
  });
});

describe("turnIntoSteps refuses", () => {
  it("when the held process has no live version", () => {
    const f = withChild();
    expect(turnIntoSteps(f.bundle, f.holder, undefined)).toBeNull();
    expect(turnIntoStepsProblem(f.bundle, f.holder, null)).toMatch(/no published version/);
    const draftOnly = { ...f.child, process: { ...f.child.process, live_revision_id: null } };
    expect(turnIntoSteps(f.bundle, f.holder, draftOnly)).toBeNull();
    // Not the process the step holds.
    expect(turnIntoStepsProblem(f.bundle, f.holder, { ...f.child, process: { ...f.child.process, id: randomUUID() } })).toMatch(/no published version/);
  });

  it("when the step is not a holder, is not there, or is a card on the company map", () => {
    const f = withChild();
    expect(turnIntoStepsProblem(f.bundle, ids.qualify, f.child)).toMatch(/isn't a linked process/);
    expect(turnIntoStepsProblem(f.bundle, "nope", f.child)).toMatch(/isn't on this map/);
    const company = { ...f.bundle, process: { ...f.bundle.process, is_company: true } };
    expect(turnIntoSteps(company, f.holder, f.child)).toBeNull();
    expect(turnIntoStepsProblem(company, f.holder, f.child)).toMatch(/company map/);
  });

  it("when a process held inside it is not published, or links back", () => {
    const f = withChild((child, b) => {
      child.steps.push(row(b, randomUUID(), "Inner", { kind: "subprocess", child_process_id: randomUUID(), ...owner(child) }));
    });
    expect(turnIntoStepsProblem(f.bundle, f.holder, f.child)).toMatch(/Publish Inner first/);
    const loop = withChild((child, b) => {
      child.steps.push(row(b, randomUUID(), "Back", { kind: "subprocess", child_process_id: b.process.id, ...owner(child) }));
    });
    expect(turnIntoStepsProblem(loop.bundle, loop.holder, loop.child)).toMatch(/inside itself/);
  });

  it("when the held process has no start line, or nowhere for its way out to go", () => {
    const f = withChild((child) => {
      child.edges = child.edges.filter((e) => child.steps.find((s) => s.id === e.from_step_id)?.kind !== "start");
    });
    expect(turnIntoStepsProblem(f.bundle, f.holder, f.child)).toMatch(/start step needs exactly one line/);
    // The holder leads nowhere and a step of the process has more than one way on.
    const stuck = withChild(
      (child, b) => {
        const done = child.steps.find((s) => s.kind === "end")!.id;
        child.edges = child.edges.map((e) => (e.from_step_id === ids.seo ? { ...e, probability: 0.6 } : e));
        child.edges.push({ ...line(b, ids.seo, done, { probability: 0.4 }), ...owner(child) });
      },
      () => [],
    );
    expect(turnIntoStepsProblem(stuck.bundle, stuck.holder, stuck.child)).toMatch(/Join Delivery to a next step/);
  });
});

describe("no new links", () => {
  it("is never made by turning one into steps", () => {
    const f = withChild();
    const { after } = turn(f);
    expect(after.steps.filter((s) => isHolderStep(s) && s.kind !== "group")).toHaveLength(0);
  });
});
