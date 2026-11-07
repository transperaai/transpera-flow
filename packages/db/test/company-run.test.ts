import { describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  NO_PIPELINE_ON_MAP,
  companyBundle,
  companyEngineModel,
  defaultCompanyPart,
  holderStepId,
  northbeamBundle,
  partOf,
  resolveBundlePurposes,
  toEngineModel,
  ModelError,
  type EdgeRow,
  type ProcessBundle,
  type ProcessPart,
  type StepRow,
} from "../src";

// Q17 (ADR 0023): what the company map's processes and hand-off lines do to the run. Northbeam is the workspace (one pipeline, two servicing
// processes); processes are added and cards dropped on the map. The equality with today for the system-made map is `engine-model-snapshot.test.ts`.

const START = "2026-10-05";
const base = northbeamBundle();
const pipeline = partOf(base);
const servicingParts = base.otherProcesses!;
const everyPart = [pipeline, ...servicingParts];
const ws = base.workspace.id;
const roleId = base.roles[0]!.id;

/** A small process: start, one task, one end with `outcome`. */
function made(id: string, name: string, kind: "pipeline" | "servicing", outcome: "done" | "lost" | "won" = "done"): ProcessPart {
  const template = base.steps.find((s) => s.kind === "task")!;
  const revisionId = `${id}-rev`;
  const at = { revision_id: revisionId, workspace_id: ws, process_id: id };
  const step = (suffix: string, over: Partial<StepRow>): StepRow => ({ ...template, ...at, id: `${id}-${suffix}`, name: `${name} ${suffix}`, provenance: {}, ...over });
  const edge = (from: string, to: string): EdgeRow => ({ id: `${id}-${from}-${to}`, ...at, from_step_id: `${id}-${from}`, to_step_id: `${id}-${to}`, probability: 1, condition_tag: null, label: null });
  return {
    process: { ...base.process, id, name, kind, parent_process_id: null, live_revision_id: revisionId, is_company: false },
    revision: { id: revisionId, workspace_id: ws, process_id: id, number: 1, status: "published" },
    steps: [
      step("start", { kind: "start", role_id: null, work_hours: 0, wait_hours: 0, rework_rate: 0, tool: null }),
      step("task", { kind: "task", role_id: roleId, work_hours: 2, wait_hours: 0, rework_rate: 0, lost_per_day_waiting: null }),
      step("end", { kind: "end", outcome, role_id: null, work_hours: 0, wait_hours: 0, rework_rate: 0, tool: null }),
    ],
    edges: [edge("start", "task"), edge("task", "end")],
  };
}

const onboarding = made("p-onboarding", "Onboarding", "pipeline");
const delivery = made("p-delivery", "Delivery", "pipeline");

/** The company map for `parts`, with lines added (pipeline to pipeline, by process id) and cards dropped. */
function mapOf(parts: readonly ProcessPart[], opts: { lines?: [string, string, Partial<EdgeRow>?][]; drop?: string[]; status?: "draft" | "published" } = {}): ProcessPart {
  const company = defaultCompanyPart(ws, parts);
  const drop = new Set((opts.drop ?? []).map(holderStepId));
  const steps = company.steps.filter((s) => !drop.has(s.id));
  const edges = [
    ...company.edges.filter((e) => !drop.has(e.from_step_id) && !drop.has(e.to_step_id)),
    ...(opts.lines ?? []).map(([from, to, over], i): EdgeRow => ({
      id: `line-${i}`,
      revision_id: company.revision.id,
      workspace_id: ws,
      process_id: company.process.id,
      from_step_id: holderStepId(from),
      to_step_id: holderStepId(to),
      probability: 1,
      condition_tag: null,
      label: null,
      ...over,
    })),
  ];
  return { ...company, revision: { ...company.revision, status: opts.status ?? "published" }, steps, edges };
}

const run = (company: ProcessPart, parts: readonly ProcessPart[], bundle: ProcessBundle = base, options = { startDate: START }) => companyEngineModel(company, bundle, parts, options);
const messages = (r: { notes: { message: string }[] }) => r.notes.map((n) => n.message);
const pid = (p: ProcessPart) => p.process.id;

describe("the system-made map", () => {
  it("runs today's model and says nothing", () => {
    const r = run(mapOf(everyPart), everyPart);
    expect(r.model).toEqual(toEngineModel(base, { startDate: START }));
    expect(r.notes).toEqual([]);
    expect(r.bundle.handoffs).toBeUndefined();
  });
});

describe("a map that drops a process", () => {
  const dropped = servicingParts[0]!;

  it("simulates the rest: the dropped servicing process is not in the model, and the note names its services", () => {
    const r = run(mapOf(everyPart, { drop: [pid(dropped)] }), everyPart);
    expect(Object.keys(r.model.servicingProcesses ?? {})).not.toContain(pid(dropped));
    expect(Object.keys(toEngineModel(base, { startDate: START }).servicingProcesses ?? {})).toContain(pid(dropped));
    // The services still run: only that process's tasks go.
    expect(Object.keys(r.model.services ?? {}).sort()).toEqual(Object.keys(toEngineModel(base, { startDate: START }).services ?? {}).sort());
    const note = r.notes.find((n) => n.kind === "not-on-map");
    expect(note?.message).toMatch(new RegExp(`^'${dropped.process.name}' is linked to .+ but isn't on this company map, so its work isn't simulated\\.$`));
    // And it still simulates.
    expect(simulate(r.model, 2, 1).kpi.won.mean).toBeGreaterThan(0);
  });

  it("with today's pipeline off the map, the next pipeline on it runs, and the note says so", () => {
    const parts = [pipeline, onboarding, ...servicingParts];
    const r = run(mapOf(parts, { drop: [pid(pipeline)] }), parts);
    expect(r.bundle.process.id).toBe(pid(onboarding));
    expect(messages(r)).toContain(`'${pipeline.process.name}' isn't on this company map.`);
  });

  it("a map with no pipeline can't start the run", () => {
    const c = companyBundle(base, mapOf(everyPart, { drop: [pid(pipeline)] }), everyPart);
    expect(c.bundle).toBeNull();
    expect(c.problem).toBe(NO_PIPELINE_ON_MAP);
    expect(() => run(mapOf(everyPart, { drop: [pid(pipeline)] }), everyPart)).toThrow(ModelError);
  });

  it("a card whose process was never published isn't simulated", () => {
    // The map holds a card for a process that has no live version: it is not among the live parts.
    const withCard = mapOf([...everyPart, made("p-renewals", "Renewals", "servicing")]);
    const r = run(withCard, everyPart);
    expect(messages(r)).toEqual(["'Renewals' has no published version, so it isn't simulated."]);
    expect(r.model).toEqual(toEngineModel(base, { startDate: START }));
  });

  it("a servicing card linked to no service says nothing starts it", () => {
    const audit = made("p-audit", "Audit", "servicing");
    const parts = [...everyPart, audit];
    expect(messages(run(mapOf(parts), parts))).toEqual(["Nothing starts 'Audit': it isn't linked to a service."]);
  });

  it("a service that enters another process than the sales pipeline is named", () => {
    const entered: ProcessBundle = { ...base, services: base.services.map((s, i) => (i === 0 ? { ...s, entry_process_id: pid(servicingParts[0]!) } : s)) };
    const r = run(mapOf(everyPart), everyPart, entered);
    expect(messages(r)).toEqual([`'${base.services[0]!.name}' starts at '${servicingParts[0]!.process.name}', not the sales pipeline, so no new clients arrive for it.`]);
  });

  it("a line out of a servicing card isn't simulated, and says so", () => {
    const [a, b] = servicingParts;
    const r = run(mapOf(everyPart, { lines: [[pid(a!), pid(b!)]] }), everyPart);
    expect(messages(r)).toEqual([`Work handed on from '${a!.process.name}' isn't simulated.`]);
    expect(r.model).toEqual(toEngineModel(base, { startDate: START }));
  });
});

describe("a map that hands the pipeline's wins on to another pipeline", () => {
  const parts = [pipeline, onboarding, ...servicingParts];
  const company = mapOf(parts, { lines: [[pid(pipeline), pid(onboarding)]] });

  it("the won end carries on at the handed-to process, whose steps join the model", () => {
    const r = run(company, parts);
    expect(r.notes).toEqual([]);
    expect(r.bundle.handoffs).toEqual([{ from: pid(pipeline), to: pid(onboarding) }]);
    const todayModel = toEngineModel(base, { startDate: START });
    expect(r.model.steps.map((s) => s.id)).toEqual(expect.arrayContaining(["p-onboarding-task"]));
    expect(r.model.steps.length).toBe(todayModel.steps.length + 1);
    // The won sink carries the hand-off to the process's first step; the rest of the model is today's.
    expect(r.model.ends![r.model.sinks.won]).toEqual({ outcome: "won", handoff: "p-onboarding-task" });
    expect(r.model.ends!["p-onboarding-end"]).toEqual({ outcome: "done" });
    expect({ ...r.model, steps: [], ends: undefined }).toEqual({ ...todayModel, steps: [], ends: undefined });
  });

  it("clients flow through it: the work happens, and the win is counted once, at the pipeline's won end", () => {
    const withHand = simulate(run(company, parts).model, 3, 1);
    const without = simulate(toEngineModel(base, { startDate: START }), 3, 1);
    expect(withHand.steps["p-onboarding-task"]!.arrivals).toBeGreaterThan(0);
    expect(withHand.steps["p-onboarding-task"]!.arrivals).toBeCloseTo(withHand.kpi.won.mean, 0);
    expect(withHand.kpi.won.mean).toBeCloseTo(without.kpi.won.mean, 0);
    // Cycle time stops at the win: the handed-to process adds nothing to it.
    expect(withHand.kpi.cycle.mean).toBeCloseTo(without.kpi.cycle.mean, 0);
  });

  it("the handed-to steps are after the sale for purposes: client work, not winning", () => {
    const r = run(company, parts, base, { startDate: START, purposes: true } as never);
    expect(r.model.steps.find((s) => s.id === "p-onboarding-task")!.purpose).toBe("client_job");
    // The same step with no hand-off is outside the sale and reads as winning work: the company map is what tells it.
    const without = resolveBundlePurposes({ ...r.bundle, handoffs: undefined });
    const withHand = resolveBundlePurposes(r.bundle);
    expect(withHand.get("p-onboarding-task")!.key).toBe("client_job");
    expect(without.get("p-onboarding-task")!.key).toBe("winning");
  });

  it("a chain hands each process's ends on to the next, and a lost end in a handed-to process is treated as done", () => {
    const chain = [pipeline, onboarding, made("p-care", "Care", "pipeline", "lost"), ...servicingParts];
    const careEnds = chain[2]!;
    const c = mapOf(chain, { lines: [[pid(pipeline), pid(onboarding)], [pid(onboarding), pid(careEnds)]] });
    const r = run(c, chain);
    expect(r.bundle.handoffs).toEqual([
      { from: pid(pipeline), to: pid(onboarding) },
      { from: pid(onboarding), to: pid(careEnds) },
    ]);
    expect(r.model.ends!["p-onboarding-end"]).toEqual({ outcome: "done", handoff: "p-care-task" });
    // Care's end is a lost end on the map; here it is done, and the note says so.
    expect(r.model.ends!["p-care-end"]).toEqual({ outcome: "done" });
    expect(messages(r)).toEqual(["'Care' has a lost end. A client who reaches it still counts as won, so the run treats it as done."]);
    expect(simulate(r.model, 2, 1).steps["p-care-task"]!.arrivals).toBeGreaterThan(0);
  });

  it("a fork follows the first process by the workspace's order and says which it left out", () => {
    const fork = [pipeline, onboarding, delivery, ...servicingParts];
    const c = mapOf(fork, { lines: [[pid(pipeline), pid(onboarding)], [pid(pipeline), pid(delivery)]] });
    const r = run(c, fork);
    expect(r.bundle.handoffs).toEqual([{ from: pid(pipeline), to: pid(onboarding) }]);
    expect(messages(r)).toEqual([`'${pipeline.process.name}' hands on to 'Onboarding' and 'Delivery'. The run follows only 'Onboarding'.`]);
    expect(r.bundle.otherProcesses!.map(pid)).not.toContain(pid(delivery));
  });

  it("a loop is cut at the closing line, which is named", () => {
    const c = mapOf(parts, { lines: [[pid(pipeline), pid(onboarding)], [pid(onboarding), pid(pipeline)]] });
    const r = run(c, parts);
    expect(r.bundle.handoffs).toEqual([{ from: pid(pipeline), to: pid(onboarding) }]);
    // In a ring every pipeline has a line into it, so the first one is the sales pipeline.
    expect(r.bundle.process.id).toBe(pid(pipeline));
    expect(messages(r)).toEqual([`The line from 'Onboarding' back to '${pipeline.process.name}' closes a loop, so it isn't used.`]);
    expect(simulate(r.model, 2, 1).kpi.won.mean).toBeGreaterThan(0);
  });

  it("a share and a condition on the line aren't used, and the notes say so", () => {
    const c = mapOf(parts, { lines: [[pid(pipeline), pid(onboarding), { probability: 0.6, condition_tag: "seo" }]] });
    const r = run(c, parts);
    expect(r.bundle.handoffs).toHaveLength(1);
    expect(messages(r)).toEqual(["The 60% on the line to 'Onboarding' isn't used: every won client goes through it.", "The condition on the line to 'Onboarding' isn't used: every won client goes through it."]);
  });

  it("a pipeline with a line into it isn't the sales pipeline, even when it comes first", () => {
    // Onboarding is listed before the Lead to live pipeline here; the line into it makes Lead to live the sales pipeline.
    const odd = [onboarding, pipeline, ...servicingParts];
    const c = mapOf(odd, { lines: [[pid(pipeline), pid(onboarding)]] });
    const r = run(c, odd);
    expect(r.bundle.process.id).toBe(pid(pipeline));
    expect(r.bundle.handoffs).toEqual([{ from: pid(pipeline), to: pid(onboarding) }]);
  });

  it("a second pipeline with no line into it is on the map but isn't simulated", () => {
    const r = run(mapOf(parts), parts);
    expect(r.bundle.otherProcesses!.map(pid)).not.toContain(pid(onboarding));
    expect(r.model).toEqual(toEngineModel(base, { startDate: START }));
  });
});

describe("the draft and earlier versions run from their own map", () => {
  it("a draft that hands on to Onboarding is a different run from the live map's, with the same bundle and parts", () => {
    const parts = [pipeline, onboarding, ...servicingParts];
    const live = mapOf(parts);
    const draft = mapOf(parts, { lines: [[pid(pipeline), pid(onboarding)]], status: "draft" });
    const a = run(live, parts);
    const b = run(draft, parts);
    expect(a.model).toEqual(toEngineModel(base, { startDate: START }));
    expect(b.model).not.toEqual(a.model);
    expect(b.model.ends![b.model.sinks.won]!.handoff).toBe("p-onboarding-task");
  });
});
