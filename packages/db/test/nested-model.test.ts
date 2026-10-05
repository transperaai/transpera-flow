import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  ModelError,
  isHolderStep,
  isWorkingStep,
  northbeamBundle,
  northbeamStepIds as ids,
  toEngineModel,
  type EdgeRow,
  type ProcessBundle,
  type ProcessPart,
  type StepRow,
} from "../src";

// Nested processes in the engine's model (issue #102): groups and child
// processes are a view, so Northbeam written with a group, or with part of its
// delivery as a child process, resolves to the very model the flat Northbeam
// does, and therefore simulates to the same numbers.

const START_DATE = "2026-10-05";
const flat = () => northbeamBundle();
const modelOf = (b: ProcessBundle) => toEngineModel(b, { startDate: START_DATE });

const holder = (b: ProcessBundle, id: string, name: string, over: Partial<StepRow>): StepRow => ({
  ...b.steps[0]!,
  id,
  name,
  kind: "group",
  outcome: null,
  role_id: null,
  person_id: null,
  work_hours: 0,
  wait_hours: 0,
  rework_rate: 0,
  rework_to_step_id: null,
  tool: null,
  sla_hours: null,
  current_wip: null,
  parent_step_id: null,
  entry_step_id: null,
  child_process_id: null,
  assumption: false,
  conflict: false,
  provenance: {},
  ...over,
});

const edgeRow = (b: ProcessBundle, from: string, to: string, over: Partial<EdgeRow> = {}): EdgeRow => ({
  ...b.edges[0]!,
  id: randomUUID(),
  from_step_id: from,
  to_step_id: to,
  probability: 1,
  condition_tag: null,
  label: null,
  ...over,
});

/** Northbeam with "Sales" (qualify, discovery) and "Setup" (seo, ppc, live) as groups, and edges aimed at the groups. */
function withGroups(): ProcessBundle {
  const b = flat();
  const sales = randomUUID();
  const setup = randomUUID();
  const inside = (key: keyof typeof ids, parent: string) => (s: StepRow) => (s.id === ids[key] ? { ...s, parent_step_id: parent } : s);
  let steps = b.steps;
  for (const [key, parent] of [["qualify", sales], ["discovery", sales], ["seo", setup], ["ppc", setup], ["live", setup]] as const) steps = steps.map(inside(key, parent));
  steps = [...steps, holder(b, sales, "Sales", { entry_step_id: ids.qualify }), holder(b, setup, "Setup", { entry_step_id: ids.seo })];
  // The start step now leads into the Sales group, and Onboarding's kickoff stays a leaf. Seo and ppc stay reachable inside Setup.
  const edges = b.edges.map((e) => (e.from_step_id === ids.start ? { ...e, to_step_id: sales } : e));
  return { ...b, steps, edges };
}

/** Northbeam with its delivery (kickoff to go-live) as a child process held by one step of the pipeline. */
function withChildProcess(extra?: (child: ProcessPart, b: ProcessBundle) => void) {
  const b = flat();
  const childId = randomUUID();
  const childRev = randomUUID();
  const inChild = [ids.kickoff, ids.seo, ids.ppc, ids.live] as string[];
  const ownerOf = { process_id: childId, revision_id: childRev };
  const childStart = randomUUID();
  const childDone = randomUUID();
  const childSteps: StepRow[] = [
    ...b.steps.filter((s) => inChild.includes(s.id)).map((s) => ({ ...s, ...ownerOf })),
    { ...holder(b, childStart, "Start", { kind: "start", ...ownerOf }) },
    { ...holder(b, childDone, "Done", { kind: "end", outcome: "done", ...ownerOf }) },
  ];
  const childEdges: EdgeRow[] = [
    ...b.edges.filter((e) => inChild.includes(e.from_step_id)).map((e) => (e.from_step_id === ids.live ? { ...e, to_step_id: childDone } : e)).map((e) => ({ ...e, ...ownerOf })),
    { ...edgeRow(b, childStart, ids.kickoff), ...ownerOf },
  ];
  const heldBy = randomUUID();
  const steps = [...b.steps.filter((s) => !inChild.includes(s.id)), holder(b, heldBy, "Delivery", { kind: "subprocess", child_process_id: childId })];
  // Onboarding led to kickoff; it now leads to the step holding the child, which leads on to won.
  const edges = [
    ...b.edges.filter((e) => !inChild.includes(e.from_step_id)).map((e) => (e.to_step_id === ids.kickoff ? { ...e, to_step_id: heldBy } : e)),
    edgeRow(b, heldBy, ids.won),
  ];
  const child: ProcessPart = {
    process: { ...b.process, id: childId, name: "Delivery", live_revision_id: childRev, parent_process_id: b.process.id },
    revision: { ...b.revision, id: childRev, process_id: childId },
    steps: childSteps,
    edges: childEdges,
  };
  extra?.(child, b);
  return { bundle: { ...b, steps, edges, otherProcesses: [...(b.otherProcesses ?? []), child] } as ProcessBundle, child, heldBy, childDone };
}

describe("toEngineModel with groups", () => {
  it("resolves Northbeam in groups to the flat Northbeam model", () => {
    expect(modelOf(withGroups())).toEqual(modelOf(flat()));
  });

  it("simulates to the same numbers", () => {
    expect(simulate(modelOf(withGroups()), 5, 1)).toEqual(simulate(modelOf(flat()), 5, 1));
  });

  it("doesn't count a group as a working step", () => {
    const b = withGroups();
    const groups = b.steps.filter((s) => s.kind === "group");
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => isHolderStep(g) && !isWorkingStep(g))).toBe(true);
    expect(b.steps.filter(isWorkingStep).length).toBe(flat().steps.filter(isWorkingStep).length);
  });

  it("leaves a step with no way out through its group's edges", () => {
    const b = withGroups();
    // Discovery's two branches move to the group, leaving Discovery as the group's way out.
    const setupId = b.steps.find((s) => s.name === "Setup")!.id;
    const salesId = b.steps.find((s) => s.name === "Sales")!.id;
    const out = b.edges.filter((e) => e.from_step_id === ids.discovery);
    const edges = [...b.edges.filter((e) => e.from_step_id !== ids.discovery), ...out.map((e) => ({ ...e, from_step_id: salesId }))];
    expect(setupId).toBeTruthy();
    expect(modelOf({ ...b, edges })).toEqual(modelOf(flat()));
  });

  it("refuses a group with no steps or no first step", () => {
    const b = withGroups();
    const sales = b.steps.find((s) => s.name === "Sales")!;
    expect(() => modelOf({ ...b, steps: b.steps.map((s) => (s.id === sales.id ? { ...s, entry_step_id: null } : s)) })).toThrow(/needs a first step/);
    expect(() => modelOf({ ...b, steps: b.steps.map((s) => (s.parent_step_id === sales.id ? { ...s, parent_step_id: null } : s)) })).toThrow(/has no steps/);
    expect(() => modelOf({ ...b, steps: b.steps.map((s) => (s.id === ids.audit ? { ...s, parent_step_id: ids.decision } : s)) })).toThrow(ModelError);
  });

  it("reports a group with nowhere to go as a ModelError, not a crash", () => {
    const b = withGroups();
    // Go-live is the last step of Setup and nothing leaves Setup either.
    const edges = b.edges.filter((e) => e.from_step_id !== ids.live);
    expect(() => modelOf({ ...b, edges })).toThrow(ModelError);
    expect(() => modelOf({ ...b, edges })).toThrow(/nothing leaving it/);
  });

  it("refuses a step with no way out when it is not inside a group", () => {
    const b = flat();
    expect(() => modelOf({ ...b, edges: b.edges.filter((e) => e.from_step_id !== ids.audit) })).toThrow(/has no outgoing edge/);
  });
});

describe("toEngineModel with a child process", () => {
  it("says plainly what is wrong with a link: nowhere to go, nothing published yet, or a loop (B12 wording)", () => {
    const { bundle, heldBy, child } = withChildProcess();
    // No next step after a linked process: called by its name, not "Group".
    const stuck = { ...bundle, edges: bundle.edges.filter((e) => e.from_step_id !== heldBy) };
    expect(() => modelOf(stuck)).toThrow(/^'Delivery' has nothing leaving it: join it to a next step$/);
    // The linked process has no published version (not among the parts).
    const unpublished = { ...bundle, otherProcesses: (bundle.otherProcesses ?? []).filter((p) => p.process.id !== child.process.id) };
    expect(() => modelOf(unpublished)).toThrow(/^Publish 'Delivery' first: this step links to it, and it has no published version yet$/);
    // The linked process links back to this one.
    const back = { ...child, steps: [...child.steps, holder(bundle, randomUUID(), "Back", { kind: "subprocess", child_process_id: bundle.process.id, process_id: child.process.id, revision_id: child.revision.id })] };
    const loop = { ...bundle, otherProcesses: (bundle.otherProcesses ?? []).map((p) => (p.process.id === child.process.id ? back : p)) };
    expect(() => modelOf(loop)).toThrow(/would put '.*' inside itself: 'Back' links back to it\. Take one of the links out/);
  });

  it("resolves Northbeam with its delivery as a child process to the flat Northbeam model", () => {
    expect(modelOf(withChildProcess().bundle)).toEqual(modelOf(flat()));
  });

  it("simulates to the same numbers", () => {
    expect(simulate(modelOf(withChildProcess().bundle), 5, 1)).toEqual(simulate(modelOf(flat()), 5, 1));
  });

  it("needs the child to be published", () => {
    const { bundle } = withChildProcess();
    expect(() => modelOf({ ...bundle, otherProcesses: (bundle.otherProcesses ?? []).filter((p) => p.process.name !== "Delivery") })).toThrow(/no published version/);
  });

  it("keeps the child's lost end as an end of the whole model", () => {
    const lost = randomUUID();
    const { bundle } = withChildProcess((child, b) => {
      child.steps.push(holder(b, lost, "Child lost", { kind: "end", outcome: "lost", process_id: child.process.id, revision_id: child.revision.id }));
      child.edges = child.edges.map((e) =>
        e.from_step_id === ids.kickoff && e.to_step_id === ids.seo ? { ...e, probability: 0.45 } : e,
      );
      child.edges.push({ ...edgeRow(b, ids.kickoff, lost, { probability: 0.1 }), process_id: child.process.id, revision_id: child.revision.id });
    });
    const model = modelOf(bundle);
    expect(model.ends?.[lost]).toEqual({ outcome: "lost" });
    expect(model.groups).toBeUndefined();
    expect(simulate(model, 3, 1).lost).toBeGreaterThan(0);
  });

  it("refuses a child process that holds itself, however it got there", () => {
    const { bundle, child } = withChildProcess();
    const owner = { process_id: child.process.id, revision_id: child.revision.id };
    // Go-live now leads to a step of the child that holds the child again (the database refuses this; the model must too).
    const again = holder(bundle, randomUUID(), "Delivery again", { kind: "subprocess", child_process_id: child.process.id, ...owner });
    const done = child.steps.find((s) => s.kind === "end")!.id;
    child.steps = [...child.steps, again];
    child.edges = [
      ...child.edges.map((e) => (e.from_step_id === ids.live ? { ...e, to_step_id: again.id } : e)),
      { ...edgeRow(bundle, again.id, done), ...owner },
    ];
    expect(() => modelOf(bundle)).toThrow(/no longer sits inside this process|inside itself/);
  });

  it("simulates a child through the step's link, whatever its parent column says (B12: a link is what nests it)", () => {
    // Placed from the library: the child's (legacy) parent column names nothing, or another process. The holder step's link is
    // what puts it here, so the model is still the flat one, and so are the numbers.
    const { bundle } = withChildProcess();
    for (const parent of [null, randomUUID()]) {
      const linked = (bundle.otherProcesses ?? []).map((p) => (p.process.name === "Delivery" ? { ...p, process: { ...p.process, parent_process_id: parent } } : p));
      expect(modelOf({ ...bundle, otherProcesses: linked })).toEqual(modelOf(flat()));
      expect(simulate(modelOf({ ...bundle, otherProcesses: linked }), 3, 1)).toEqual(simulate(modelOf(flat()), 3, 1));
    }
  });

  it("is not picked as the pipeline a servicing process runs beside", () => {
    const { bundle } = withChildProcess();
    const servicing = (bundle.otherProcesses ?? []).find((p) => p.process.kind === "servicing")!;
    // Open the servicing process as the bundle, with the child ahead of the real pipeline.
    const pipeline: ProcessPart = { process: bundle.process, revision: bundle.revision, steps: bundle.steps, edges: bundle.edges };
    const others = [...(bundle.otherProcesses ?? []).filter((p) => p.process.parent_process_id), pipeline, ...(bundle.otherProcesses ?? []).filter((p) => p.process.kind === "servicing" && p !== servicing)];
    const opened: ProcessBundle = { ...bundle, process: servicing.process, revision: servicing.revision, steps: servicing.steps, edges: servicing.edges, otherProcesses: others };
    expect(modelOf(opened).steps.map((s) => s.id)).toContain(ids.audit);
  });
});
