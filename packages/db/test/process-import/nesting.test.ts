import { describe, expect, it } from "vitest";
import { absolutePositions, type EdgeRow, type StepRow } from "../../src";
import { flattenNesting, graphWarnings, layoutSteps, nestingProblem, planImport, revisionDiff, type ImportInput, type ImportStep } from "../../src/process-import/building";
import { ImportError } from "../../src/process-import/errors";

// Nested steps in import_process (issue #102): groups written inside a step's
// `steps`, or given a `parent`; the group's first step; the rules that keep the
// nesting valid; and that what is written reads back as what was imported.

const owner = { revision_id: "r0000000-0000-4000-8000-000000000001", workspace_id: "w1", process_id: "p1" };
const stamp = { at: "2026-11-01T09:00:00.000Z", by: "u0000000-0000-4000-8000-000000000001" };
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const empty = { steps: [] as StepRow[], edges: [] as EdgeRow[], retired: [] as StepRow[] };

const importOf = (steps: ImportStep[], edges: ImportInput["edges"], extra: Partial<ImportInput> = {}): ImportInput => ({ steps, edges, ...extra });
const plan = (input: ImportInput, draft: typeof empty = empty) => planImport(input, draft, owner, stamp, { newId });
const byName = (rows: StepRow[], name: string) => rows.find((r) => r.name === name)!;
const failure = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ImportError) return e.message;
    throw e;
  }
  throw new Error("expected a ImportError");
};

// Sales with a Qualify group (receive, check) and a Discovery step, then Won and Lost.
const NESTED = {
  steps: [
    { name: "Enquiry", kind: "start" },
    {
      name: "Qualify",
      steps: [
        { name: "Receive enquiry", work_hours: 0.1 },
        { name: "Check fit", work_hours: 0.3, steps: undefined },
      ],
    },
    { name: "Discovery", work_hours: 1.5 },
    { name: "Won", kind: "end", outcome: "won" },
    { name: "Lost", kind: "end", outcome: "lost" },
  ],
  edges: [
    { from: "Enquiry", to: "Qualify" },
    { from: "Receive enquiry", to: "Check fit" },
    { from: "Check fit", to: "Discovery", probability: 0.6 },
    { from: "Check fit", to: "Lost", probability: 0.4 },
    { from: "Discovery", to: "Won" },
  ],
};

describe("flattenNesting", () => {
  it("unfolds groups, giving their steps the group as parent and making steps with steps groups", () => {
    const { steps, holders } = flattenNesting(NESTED.steps as never[]);
    expect(steps.map((s) => [s.name, (s as { kind?: string }).kind, (s as { parent?: string | null }).parent])).toEqual([
      ["Enquiry", "start", undefined],
      ["Qualify", "group", undefined],
      ["Receive enquiry", undefined, "Qualify"],
      ["Check fit", undefined, "Qualify"],
      ["Discovery", undefined, undefined],
      ["Won", "end", undefined],
      ["Lost", "end", undefined],
    ]);
    expect(holders).toEqual([]);
  });

  it("lists the steps that hold child processes, and makes them sub-process steps", () => {
    const { steps, holders } = flattenNesting([
      { name: "Onboarding", child_process: "Onboarding process" },
      { name: "Delivery", process: { steps: [] } },
    ]);
    expect(steps.map((s) => (s as { kind?: string }).kind)).toEqual(["subprocess", "subprocess"]);
    expect(holders).toEqual([{ step: "Onboarding", child_process: "Onboarding process" }, { step: "Delivery", process: { steps: [] } }]);
  });

  it("refuses a kind that contradicts the nesting, and a step that holds both", () => {
    expect(failure(() => flattenNesting([{ name: "A", kind: "task", steps: [] }]))).toMatch(/is a group, not 'task'/);
    expect(failure(() => flattenNesting([{ name: "A", kind: "group", child_process: "X" }]))).toMatch(/subprocess step, not 'group'/);
    expect(failure(() => flattenNesting([{ name: "A", child_process: "X", process: {} }]))).toMatch(/give one/);
    expect(failure(() => flattenNesting([{ name: "A", steps: [], child_process: "X" }]))).toMatch(/both steps and a child process/);
    expect(failure(() => flattenNesting([{ name: "A", steps: [{ name: "B", parent: "Somewhere else" }] }]))).toMatch(/says its parent is/);
  });

  it("refuses groups nested too deep", () => {
    let step: { name: string; steps?: unknown[] } = { name: "leaf" };
    for (let i = 0; i < 10; i++) step = { name: `g${i}`, steps: [step] };
    expect(failure(() => flattenNesting([step as never]))).toMatch(/nested more than 8 deep/);
  });
});

describe("planImport with groups", () => {
  const flat = flattenNesting(NESTED.steps as never[]).steps as unknown as ImportStep[];

  it("writes a group, its steps, the steps' parent and the group's first step", () => {
    const p = plan(importOf(flat, NESTED.edges));
    const rows = p.after.steps;
    const group = byName(rows, "Qualify");
    expect(group).toMatchObject({ kind: "group", parent_step_id: null, work_hours: 0, role_id: null });
    // The first step defaults to the first of the group's steps in the JSON.
    expect(group.entry_step_id).toBe(byName(rows, "Receive enquiry").id);
    expect(byName(rows, "Receive enquiry").parent_step_id).toBe(group.id);
    expect(byName(rows, "Check fit").parent_step_id).toBe(group.id);
    expect(byName(rows, "Discovery").parent_step_id).toBeNull();
    // Edges go to the group itself, and from steps inside it to steps outside.
    expect(p.insertEdges.map((e) => [rows.find((r) => r.id === e.from_step_id)!.name, rows.find((r) => r.id === e.to_step_id)!.name])).toContainEqual(["Enquiry", "Qualify"]);
    expect(p.insertEdges.map((e) => rows.find((r) => r.id === e.from_step_id)!.name)).toContain("Check fit");
  });

  it("takes a given entry, by name", () => {
    const withEntry = flat.map((s) => (s.name === "Qualify" ? { ...s, entry: "Check fit" } : s));
    const p = plan(importOf(withEntry, NESTED.edges));
    expect(byName(p.after.steps, "Qualify").entry_step_id).toBe(byName(p.after.steps, "Check fit").id);
  });

  it("accepts the flat form: a step's parent by name, with the group listed anywhere", () => {
    const shuffled = [...flat].reverse();
    const p = plan(importOf(shuffled, NESTED.edges));
    expect(byName(p.after.steps, "Check fit").parent_step_id).toBe(byName(p.after.steps, "Qualify").id);
  });

  it("nests groups in groups", () => {
    const input = importOf(
      flattenNesting([
        { name: "Start", kind: "start" },
        { name: "Outer", steps: [{ name: "Inner", steps: [{ name: "Deep", work_hours: 1 }] }, { name: "Sibling", work_hours: 2 }] },
        { name: "Done", kind: "end", outcome: "done" },
      ] as never[]).steps as unknown as ImportStep[],
      [{ from: "Start", to: "Outer" }, { from: "Deep", to: "Sibling" }, { from: "Outer", to: "Done" }],
    );
    const p = plan(input);
    const rows = p.after.steps;
    expect(byName(rows, "Deep").parent_step_id).toBe(byName(rows, "Inner").id);
    expect(byName(rows, "Inner").parent_step_id).toBe(byName(rows, "Outer").id);
    expect(byName(rows, "Outer").entry_step_id).toBe(byName(rows, "Inner").id);
    expect(byName(rows, "Inner").entry_step_id).toBe(byName(rows, "Deep").id);
    expect(nestingProblem(p.after)).toBeNull();
  });

  it("refuses a group with numbers of its own, a step inside a task, and a start or end inside a group", () => {
    expect(failure(() => plan(importOf([{ name: "Box", kind: "group", work_hours: 2 }, { name: "In", parent: "Box" }], [])))).toMatch(/does no work itself/);
    expect(failure(() => plan(importOf([{ name: "Task" }, { name: "In", parent: "Task" }], [])))).toMatch(/isn't a group/);
    expect(failure(() => plan(importOf([{ name: "Box", kind: "group" }, { name: "Won", kind: "end", outcome: "won", parent: "Box" }], [])))).toMatch(/top level/);
    expect(failure(() => plan(importOf([{ name: "A", kind: "group", parent: "B" }, { name: "B", kind: "group", parent: "A" }], [])))).toMatch(/inside itself/);
  });

  it("refuses a first step that isn't inside the group", () => {
    const input = importOf([{ name: "Box", kind: "group", entry: "Elsewhere" }, { name: "In", parent: "Box" }, { name: "Elsewhere" }], []);
    expect(failure(() => plan(input))).toMatch(/must be one of the steps inside it/);
  });

  it("moves an existing step into a new group, keeping its id", () => {
    const first = plan(importOf([{ name: "A", work_hours: 1 }, { name: "B", work_hours: 2 }], [{ from: "A", to: "B" }]));
    const draft = { steps: first.after.steps, edges: first.after.edges, retired: [] };
    const a = byName(draft.steps, "A");
    const moved = plan(importOf([{ name: "Box", kind: "group" }, { name: "A", parent: "Box" }], []), draft);
    expect(moved.matched.find((m) => m.name === "A")).toMatchObject({ id: a.id, by: "name" });
    expect(moved.updateSteps.find((u) => u.id === a.id)!.changes).toMatchObject({ parent_step_id: moved.insertSteps.find((s) => s.name === "Box")!.id });
    expect(moved.updateSteps.find((u) => u.id === a.id)!.base).toMatchObject({ parent_step_id: null });
    // The new group's first step is the step moved into it, set once it is in.
    expect(moved.insertSteps.find((s) => s.name === "Box")!.entry_step_id).toBe(a.id);
  });

  it("won't remove a group and leave its steps behind", () => {
    const first = plan(importOf(flat, NESTED.edges));
    const draft = { steps: first.after.steps, edges: first.after.edges, retired: [] };
    const withoutGroup = flat.filter((s) => s.name !== "Qualify");
    expect(failure(() => plan(importOf(withoutGroup, [], { remove_missing: true }), draft))).toMatch(/would remove it and the steps inside it/);
  });

  it("round trips: what is written reads back as the same import, with nothing to change", () => {
    const first = plan(importOf(flat, NESTED.edges));
    const draft = { steps: first.after.steps, edges: first.after.edges, retired: [] };
    // Read the draft back as the flat form get_process shows (parent by name), and import it onto itself.
    const nameOf = new Map(draft.steps.map((s) => [s.id, s.name]));
    const back: ImportStep[] = draft.steps.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      ...(s.kind === "end" ? { outcome: s.outcome! } : {}),
      parent: s.parent_step_id ? nameOf.get(s.parent_step_id)! : null,
      ...(s.entry_step_id ? { entry: nameOf.get(s.entry_step_id)! } : {}),
    }));
    const edges = draft.edges.map((e) => ({ from: nameOf.get(e.from_step_id)!, to: nameOf.get(e.to_step_id)!, probability: Number(e.probability) }));
    const again = plan(importOf(back, edges), draft);
    expect(again.insertSteps).toEqual([]);
    expect(again.removeSteps).toEqual([]);
    expect(again.insertEdges).toEqual([]);
    expect(again.removeEdges).toEqual([]);
    expect(again.updateSteps).toEqual([]);
    expect(again.updateEdges).toEqual([]);
    expect(revisionDiff(draft, again.after).text).toBe("The draft is the same as live.");
  });

  it("lays out each level on its own: a group's steps relative to the group", () => {
    const p = plan(importOf(flat, NESTED.edges));
    const rows = p.after.steps;
    const group = byName(rows, "Qualify");
    const receive = byName(rows, "Receive enquiry");
    const check = byName(rows, "Check fit");
    // Inside the group they start at its padding, one column to the right for each step on.
    expect([Number(receive.x), Number(receive.y)]).toEqual([24, 56]);
    expect([Number(check.x), Number(check.y)]).toEqual([24 + 240, 56]);
    // Top level: start, the group and Discovery run left to right as in any process.
    expect(Number(byName(rows, "Enquiry").x)).toBe(0);
    expect(Number(group.x)).toBe(240);
    expect(Number(byName(rows, "Discovery").x)).toBe(480);
    // On the whole canvas the group's steps are inside its box's left edge.
    const at = absolutePositions(rows);
    expect(at.get(receive.id)!.x).toBe(Number(group.x) + 24);
  });

  it("keeps laying flat processes out as before", () => {
    const flatOnly = plan(importOf([{ name: "S", kind: "start" }, { name: "A" }, { name: "B" }], [{ from: "S", to: "A" }, { from: "A", to: "B" }]));
    expect(flatOnly.after.steps.map((s) => [s.name, Number(s.x), Number(s.y)])).toEqual([["S", 0, 0], ["A", 240, 0], ["B", 480, 0]]);
    const spots = layoutSteps(flatOnly.after, new Set(flatOnly.after.steps.map((s) => s.id)));
    expect(spots.size).toBe(3);
  });
});

describe("graphWarnings with groups", () => {
  it("flags the last step of a group when no group it is in has a connection out", () => {
    const input = importOf(
      flattenNesting([{ name: "S", kind: "start" }, { name: "Box", steps: [{ name: "In" }] }, { name: "W", kind: "end", outcome: "won" }] as never[]).steps as unknown as ImportStep[],
      [{ from: "S", to: "Box" }],
    );
    const warnings = graphWarnings(plan(input).after).map((w) => `${w.step}: ${w.warning}`);
    expect(warnings).toContain("In: Nothing leaves this step, and no group it is in has a connection out.");
    // Connecting the group out clears it.
    const fixed = plan(importOf(input.steps, [{ from: "S", to: "Box" }, { from: "Box", to: "W" }]));
    expect(graphWarnings(fixed.after).map((w) => w.step)).not.toContain("In");
  });

  it("lets the last step inside a group have nothing leaving it, and flags an empty group", () => {
    const p = plan(importOf(flattenNesting([{ name: "S", kind: "start" }, { name: "Box", steps: [{ name: "In" }] }, { name: "Empty", steps: [] }, { name: "W", kind: "end", outcome: "won" }] as never[]).steps as unknown as ImportStep[], [{ from: "S", to: "Box" }, { from: "Box", to: "Empty" }, { from: "Empty", to: "W" }]));
    const warnings = graphWarnings(p.after).map((w) => `${w.step}: ${w.warning}`);
    expect(warnings).toEqual(["Empty: This group has no steps yet."]);
  });
});
