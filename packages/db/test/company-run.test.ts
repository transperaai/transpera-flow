import { describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  NO_PIPELINE_ON_MAP,
  companyBundle,
  companyEngineModel,
  defaultCompanyPart,
  holderStepId,
  liveMapDifferences,
  northbeamBundle,
  partOf,
  resolveBundlePurposes,
  toEngineModel,
  ModelError,
  type EdgeRow,
  type ProcessBundle,
  type ProcessPart,
  type SolutionRow,
  type StepRow,
} from "../src";
import { scenarioSegments, withSolution } from "../src/sandbox";

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

describe("process versions on top of the map", () => {
  const parts = [pipeline, onboarding, ...servicingParts];
  const solution = (process: ProcessPart): SolutionRow => ({ id: "s-1", process_id: pid(process), name: "Faster", steps: { steps: [], edges: [] }, lever_changes: [] }) as unknown as SolutionRow;
  const change = { id: "c-1", lever: "E6", target: "s-1", op: "set", value: 1, from: "2026-11" } as const;
  const segments = (bundle: ProcessBundle, sol: SolutionRow) =>
    scenarioSegments(bundle, [{ change: change as never, scenarioId: "play", scenarioName: "Free play", inherited: false }], [sol], START, [0, 173, 346], 40);

  it("a swap applies to any process on the map, a handed-to pipeline included", () => {
    const company = mapOf(parts, { lines: [[pid(pipeline), pid(onboarding)]] });
    const { bundle } = run(company, parts);
    expect(withSolution(bundle, solution(onboarding))).not.toBeNull();
    expect(withSolution(bundle, solution(servicingParts[0]!))).not.toBeNull();
    expect(segments(bundle, solution(onboarding)).problems).toEqual([]);
  });

  it("a version of a process that isn't on the chosen map is skipped, with the map's wording", () => {
    // Onboarding is not run on the system-made map (no line into it).
    const { bundle } = run(mapOf(parts), parts);
    expect(withSolution(bundle, solution(onboarding))).toBeNull();
    expect(segments(bundle, solution(onboarding)).problems.map((p) => p.message)).toEqual(["'Onboarding' isn't on this company map, so its version isn't used."]);
    // A bundle that no map made keeps the old wording.
    expect(segments(base, solution(onboarding)).problems.map((p) => p.message)).toEqual(["“Faster” changes a process the forecast doesn't run"]);
  });
});

describe("how the live map differs while it doesn't drive the run", () => {
  const parts = [pipeline, onboarding, ...servicingParts];
  const diff = (company: ProcessPart) => liveMapDifferences(base, companyBundle(base, company, parts));

  it("names a process the run still includes, and a hand-off it doesn't make", () => {
    const left = servicingParts[0]!;
    expect(diff(mapOf(parts, { drop: [pid(left)] })).map((n) => n.message)).toEqual([`The live company map leaves out '${left.process.name}'. The run still includes it until a company map version is published.`]);
    expect(diff(mapOf(parts, { lines: [[pid(pipeline), pid(onboarding)]] })).map((n) => n.message)).toEqual([
      `The live company map hands work on from '${pipeline.process.name}' to 'Onboarding'. The run doesn't until a company map version is published.`,
    ]);
    const both = diff(mapOf(parts, { drop: [pid(servicingParts[0]!), pid(servicingParts[1]!)] })).map((n) => n.message);
    expect(both).toEqual([`The live company map leaves out '${servicingParts[0]!.process.name}' and '${servicingParts[1]!.process.name}'. The run still includes them until a company map version is published.`]);
  });

  it("says nothing when the map and the run agree", () => {
    expect(diff(mapOf(parts))).toEqual([]);
  });
});

describe("the map's own steps, waits and decisions are simulated", () => {
  const parts = [pipeline, onboarding, delivery, ...servicingParts];
  const template = base.steps.find((s) => s.kind === "task")!;

  /** One of the company map's own steps (+ Step, + Wait, + Decision). */
  function node(company: ProcessPart, id: string, kind: "task" | "wait" | "decision", over: Partial<StepRow> = {}): StepRow {
    return {
      ...template,
      id,
      revision_id: company.revision.id,
      workspace_id: ws,
      process_id: company.process.id,
      name: id,
      kind,
      outcome: null,
      role_id: kind === "task" ? roleId : null,
      person_id: null,
      work_hours: kind === "task" ? 3 : 0,
      wait_hours: kind === "wait" ? 40 : 0,
      rework_rate: 0,
      current_wip: null,
      sla_hours: null,
      parent_step_id: null,
      child_process_id: null,
      provenance: {},
      ...over,
    };
  }
  /** A line on the company map between two of its steps (a card is its holder step). */
  const line = (company: ProcessPart, from: string, to: string, probability = 1): EdgeRow => ({
    id: `l-${from}-${to}`,
    revision_id: company.revision.id,
    workspace_id: ws,
    process_id: company.process.id,
    from_step_id: from,
    to_step_id: to,
    probability,
    condition_tag: null,
    label: null,
  });
  const card = (p: ProcessPart) => holderStepId(pid(p));
  /** The system-made map for `parts` with `nodes` added and `lines` drawn: [from, to, share?] by step id (a card by `card(...)`). */
  function mapWith(nodes: ((c: ProcessPart) => StepRow)[], lines: [string, string, number?][]): ProcessPart {
    const company = mapOf(parts);
    return { ...company, steps: [...company.steps, ...nodes.map((n) => n(company))], edges: [...company.edges, ...lines.map(([f, t, p]) => line(company, f, t, p))] };
  }
  const todayModel = toEngineModel(base, { startDate: START });

  describe("card → Step → card", () => {
    const company = mapWith([(c) => node(c, "c-check", "task")], [[card(pipeline), "c-check"], ["c-check", card(onboarding)]]);

    it("the step joins the model between the two processes, and the work goes through both", () => {
      const r = run(company, parts);
      expect(r.notes).toEqual([]);
      expect(r.bundle.handoffs).toEqual([
        { from: pid(pipeline), to: "c-check" },
        { from: "c-check", to: pid(onboarding) },
      ]);
      expect(r.model.ends![r.model.sinks.won]).toEqual({ outcome: "won", handoff: "c-check" });
      const check = r.model.steps.find((s) => s.id === "c-check")!;
      expect(check).toMatchObject({ role: roleId, work: 3, wait: 0, next: [{ to: "p-onboarding-task", p: 1 }] });
      const out = simulate(r.model, 3, 1);
      expect(out.steps["c-check"]!.arrivals).toBeGreaterThan(0);
      expect(out.steps["c-check"]!.arrivals).toBeCloseTo(out.kpi.won.mean, 0);
      expect(out.steps["p-onboarding-task"]!.arrivals).toBeGreaterThan(0);
      // The step's role does its hands-on time.
      expect(out.steps["c-check"]!.avgHandsOn).toBeGreaterThan(0);
    });

    it("its steps are after the sale for purposes", () => {
      const r = run(company, parts, base, { startDate: START, purposes: true } as never);
      expect(r.model.steps.find((s) => s.id === "c-check")!.purpose).toBe("client_job");
    });

    it("deleting the step (and its lines) takes it and the process after it out of the run", () => {
      const deleted: ProcessPart = { ...company, steps: company.steps.filter((s) => s.id !== "c-check"), edges: company.edges.filter((e) => e.from_step_id !== "c-check" && e.to_step_id !== "c-check") };
      const r = run(deleted, parts);
      expect(r.model).toEqual(todayModel);
      expect(r.model).not.toEqual(run(company, parts).model);
    });

    it("re-wiring the step to Delivery hands the work on there instead", () => {
      const rewired: ProcessPart = { ...company, edges: company.edges.map((e) => (e.from_step_id === "c-check" ? { ...e, to_step_id: card(delivery) } : e)) };
      const out = simulate(run(rewired, parts).model, 2, 1);
      expect(out.steps["p-delivery-task"]!.arrivals).toBeGreaterThan(0);
      expect(out.steps["p-onboarding-task"]).toBeUndefined();
    });
  });

  it("a Decision (70/30) splits the work across the two processes after it", () => {
    const company = mapWith(
      [(c) => node(c, "c-fit", "decision")],
      [
        [card(pipeline), "c-fit"],
        ["c-fit", card(onboarding), 0.7],
        ["c-fit", card(delivery), 0.3],
      ],
    );
    const r = run(company, parts);
    expect(r.notes).toEqual([]);
    // Branches come in the order of the lines' ids.
    expect(r.model.steps.find((s) => s.id === "c-fit")!.next).toEqual(
      expect.arrayContaining([
        { to: "p-onboarding-task", p: 0.7 },
        { to: "p-delivery-task", p: 0.3 },
      ]),
    );
    expect(r.model.steps.find((s) => s.id === "c-fit")!.next).toHaveLength(2);
    const out = simulate(r.model, 12, 7);
    const a = out.steps["p-onboarding-task"]!.arrivals;
    const b = out.steps["p-delivery-task"]!.arrivals;
    expect(a + b).toBeCloseTo(out.kpi.won.mean, 0);
    expect(a / (a + b)).toBeGreaterThan(0.62);
    expect(a / (a + b)).toBeLessThan(0.78);
    // The win is still counted once.
    expect(out.kpi.won.mean).toBeCloseTo(simulate(todayModel, 12, 7).kpi.won.mean, -1);
  });

  it("a Decision's branch to a servicing card or an end is done there, and shares that don't add up are scaled", () => {
    const company = mapWith(
      [(c) => node(c, "c-fit", "decision")],
      [
        [card(pipeline), "c-fit"],
        ["c-fit", card(onboarding), 0.5],
        ["c-fit", card(servicingParts[0]!), 0.5],
      ],
    );
    const r = run(company, parts);
    expect(r.bundle.handoffs).toEqual([
      { from: pid(pipeline), to: "c-fit" },
      { from: "c-fit", to: "__company_done__", p: 0.5 },
      { from: "c-fit", to: pid(onboarding), p: 0.5 },
    ]);
    expect(messages(r)).toEqual([`The branch from 'c-fit' to '${servicingParts[0]!.process.name}' isn't simulated: work that takes it is done there.`]);
    expect(r.model.ends!["__company_done__"]).toEqual({ outcome: "done" });
    expect(simulate(r.model, 2, 1).steps["p-onboarding-task"]!.arrivals).toBeGreaterThan(0);

    const off = mapWith(
      [(c) => node(c, "c-fit", "decision")],
      [
        [card(pipeline), "c-fit"],
        ["c-fit", card(onboarding), 0.7],
      ],
    );
    const o = run(off, parts);
    expect(messages(o)).toEqual(["The branches out of 'c-fit' add up to 70%, so the run scales them to 100%."]);
    expect(o.model.steps.find((s) => s.id === "c-fit")!.next).toEqual([{ to: "p-onboarding-task", p: 1 }]);
  });

  it("a Wait delays the work before the next process", () => {
    const withWait = (hours: number) =>
      run(mapWith([(c) => node(c, "c-hold", "wait", { wait_hours: hours })], [[card(pipeline), "c-hold"], ["c-hold", card(onboarding)]]), parts).model;
    const short = simulate(withWait(40), 4, 3);
    expect(short.steps["c-hold"]!.avgFixedWait).toBeGreaterThan(25);
    expect(short.steps["c-hold"]!.avgFixedWait).toBeLessThan(60);
    expect(short.steps["c-hold"]!.avgHandsOn ?? 0).toBe(0);
    // A long wait holds work past the end of the run: fewer clients reach onboarding within it.
    const long = simulate(withWait(1500), 4, 3);
    expect(long.steps["p-onboarding-task"]!.arrivals).toBeLessThan(short.steps["p-onboarding-task"]!.arrivals * 0.9);
  });

  it("a chain of map steps ends the work when the last has no line out", () => {
    const company = mapWith([(c) => node(c, "c-a", "task"), (c) => node(c, "c-b", "wait")], [[card(pipeline), "c-a"], ["c-a", "c-b"]]);
    const r = run(company, parts);
    expect(r.bundle.companySteps!.map((s) => s.id)).toEqual(["c-a", "c-b"]);
    expect(r.model.steps.find((s) => s.id === "c-b")!.next).toEqual([{ to: "__company_done__", p: 1 }]);
    expect(simulate(r.model, 2, 1).steps["c-b"]!.arrivals).toBeGreaterThan(0);
  });

  it("a step that isn't joined to the work isn't simulated, and a note names it; the rest of the run is unchanged", () => {
    const company = mapWith([(c) => node(c, "c-loose", "task")], []);
    const r = run(company, parts);
    expect(messages(r)).toEqual(["'c-loose' isn't joined to the work from the sales pipeline, so it isn't simulated."]);
    expect(r.model).toEqual(todayModel);
    // A card reached only through a step isn't taken for the sales pipeline, even when it comes first in the workspace's order.
    const odd = [onboarding, pipeline, delivery, ...servicingParts];
    const c2 = { ...mapOf(odd), steps: [...mapOf(odd).steps, node(mapOf(odd), "c-x", "task")], edges: [...mapOf(odd).edges, line(mapOf(odd), card(pipeline), "c-x"), line(mapOf(odd), "c-x", card(onboarding))] };
    expect(run(c2, odd).bundle.process.id).toBe(pid(pipeline));
  });

  it("a decision branch back to the sales pipeline is cut and its work is done", () => {
    const company = mapWith(
      [(c) => node(c, "c-fit", "decision")],
      [
        [card(pipeline), "c-fit"],
        ["c-fit", card(onboarding), 0.8],
        ["c-fit", card(pipeline), 0.2],
      ],
    );
    const r = run(company, parts);
    expect(messages(r)).toEqual([`The line from 'c-fit' back to '${pipeline.process.name}' closes a loop, so it isn't used: work that takes it is done there.`]);
    expect(r.model.steps.find((s) => s.id === "c-fit")!.next).toEqual([
      { to: "__company_done__", p: 0.2 },
      { to: "p-onboarding-task", p: 0.8 },
    ]);
  });

  it("a cards-only chain is unchanged: no shares, no map steps", () => {
    const r = run(mapOf(parts, { lines: [[pid(pipeline), pid(onboarding)]] }), parts);
    expect(r.bundle.handoffs).toEqual([{ from: pid(pipeline), to: pid(onboarding) }]);
    expect(r.bundle.companySteps).toBeUndefined();
    expect(r.model.ends!["__company_done__"]).toBeUndefined();
  });
});
