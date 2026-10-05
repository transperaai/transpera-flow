import { describe, expect, it } from "vitest";
import {
  churnProbability,
  clientRoleLoads,
  detectIssues,
  northbeamWithClients,
  northbeamWithServicing,
  rosterLoads,
  runOnce,
  simulate,
  type EngineClient,
  type EngineModel,
  type EngineService,
  type EngineServicingLink,
  type Recurrence,
  type TraceEntity,
} from "../src";
import { largeModel } from "./fixtures/large-model";

// Client servicing, health and churn (docs/PRD.md §6.3.5, §6.4 "Per client",
// §13, decision D9; issue #19).

const HPW = 40;

const service = (servicing: EngineServicingLink[] = [], extra: Partial<EngineService> = {}): EngineService => ({
  name: "Retainer",
  pricingModel: "retainer",
  price: 4330,
  margin: 0.5,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  servicing,
  ...extra,
});

const client = (assignments: Record<string, string> = {}, extra: Partial<EngineClient> = {}): EngineClient => ({
  name: "Client",
  services: ["svc"],
  mrr: 4330,
  assignments,
  ...extra,
});

const weekly = (sla = 8): EngineServicingLink => ({ process: "care", recurrence: { every: "week", times: 1 }, sla });

/**
 * Role `r` with Ann and Bob; a pipeline step `a` (constant 1 h, then won) and
 * a servicing process `care` of one step `task` (constant `work` hours). No
 * warm-up, no leads unless asked.
 */
function model(
  clients: Record<string, EngineClient>,
  opts: { link?: EngineServicingLink; work?: number; leads?: number; svc?: Partial<EngineService>; weeks?: number } = {},
): EngineModel {
  return {
    horizonWeeks: opts.weeks ?? 10,
    hoursPerWeek: HPW,
    leadsPerWeek: opts.leads ?? 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "Role r", count: 2, cost: 50, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["r"], capacity: HPW }, bob: { name: "Bob", roles: ["r"], capacity: HPW } },
    services: { svc: service([opts.link ?? weekly()], opts.svc) },
    servicingProcesses: { care: { name: "Care", entry: "task", steps: ["task"] } },
    clients,
    entry: "a",
    sinks: { won: "won", lost: "lost" },
    ends: { care_done: { outcome: "done" } },
    steps: [
      { id: "a", name: "A", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] },
      { id: "task", name: "Task", role: "r", work: opts.work ?? 0.5, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "care_done", p: 1 }] },
    ],
  };
}

const tasksOf = (entities: TraceEntity[] | null, clientId?: string) =>
  (entities ?? []).filter((e) => e.servicing && (clientId === undefined || e.servicing.client === clientId));

describe("servicing tasks", () => {
  it("each active client generates tasks per its services' recurrences", () => {
    const five = Object.fromEntries(["c1", "c2", "c3", "c4", "c5"].map((id) => [id, client()]));
    // Weekly: one task in every 40 h, the first at a random point of the first week, so exactly 10 in 10 weeks.
    const w = runOnce(model(five), 1, true);
    expect(w.steps.task!.arrivals).toBe(50);
    for (const id of Object.keys(five)) {
      const t0 = tasksOf(w.entities, id).map((e) => e.t0);
      expect(t0).toHaveLength(10);
      for (let i = 1; i < t0.length; i++) expect(t0[i]! - t0[i - 1]!).toBeCloseTo(40, 9);
    }
    // Twice a week: 20 each.
    const twice = runOnce(model(five, { link: { process: "care", recurrence: { every: "week", times: 2 }, sla: 8 } }), 1, false);
    expect(twice.steps.task!.arrivals).toBe(100);
    // Monthly: every 4.33 weeks, so 2 or 3 each in 10 weeks.
    const monthly = runOnce(model(five, { link: { process: "care", recurrence: { every: "month", times: 1 }, sla: 40 } }), 1, true);
    for (const id of Object.keys(five)) expect([2, 3]).toContain(tasksOf(monthly.entities, id).length);
    // Ad hoc: Poisson, 4.33 a month is one a week on average.
    const adHoc: Recurrence = { poissonPerMonth: 4.33 };
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) total += runOnce(model(five, { link: { process: "care", recurrence: adHoc, sla: 8 } }), seed, false).steps.task!.arrivals;
    expect(total / 40 / 5).toBeGreaterThan(9);
    expect(total / 40 / 5).toBeLessThan(11);
  });

  it("clients won during the run generate tasks too; churned clients stop", () => {
    const won = runOnce(model({}, { leads: 1 }), 2, true);
    const wins = won.entities!.filter((e) => e.outcome === "won");
    expect(wins.length).toBeGreaterThan(4);
    expect(tasksOf(won.entities, "won:1").length).toBeGreaterThan(0);
    // Every win's client starts its tasks after it was won.
    const firstWin = Math.min(...wins.map((e) => e.done!));
    expect(Math.min(...tasksOf(won.entities).map((e) => e.t0))).toBeGreaterThanOrEqual(firstWin);

    // A weekly churn chance above 1: gone at the first weekly tick, and no tasks after it.
    const churny = runOnce(model({ c1: client(), c2: client() }, { svc: { churnMonthly: 5 } }), 3, true);
    expect(churny.clientsChurned).toBe(2);
    const t0 = tasksOf(churny.entities).map((e) => e.t0);
    expect(t0.length).toBeGreaterThan(0);
    expect(Math.max(...t0)).toBeLessThan(HPW);
  });

  it("flows through the servicing process beside the pipeline and books nothing", () => {
    const r = runOnce(model({ c1: client() }), 1, false);
    expect(r.won).toBe(0);
    expect(r.done).toBe(0);
    expect(r.cycle).toEqual([]);
    expect(r.newMrr).toBe(0);
    expect(r.people.ann!.servicingHours + r.people.bob!.servicingHours).toBeCloseTo((10 * 0.5) / 10, 9);
    expect(r.people.ann!.pipelineHours + r.people.bob!.pipelineHours).toBe(0);
    expect(r.roles.r!.servicing).toBeCloseTo(0.5 / (2 * HPW), 9);
  });
});

describe("assignment", () => {
  it("a client's tasks go to its assigned person for the step's role; unassigned clients' to the role's pool", () => {
    const m = model({ c1: client({ r: "ann" }), c2: client() }, { weeks: 26 });
    const r = runOnce(m, 5, true);
    const who = (id: string) => new Set(tasksOf(r.entities, id).flatMap((e) => e.trace.map((s) => s.person)));
    expect(who("c1")).toEqual(new Set(["ann"]));
    expect(who("c2")).toEqual(new Set(["ann", "bob"]));
  });

  it("waits for the assignee while they are busy, even with someone else free", () => {
    // Ann is busy with pipeline work most of the week; Bob does nothing but is never given c1's tasks.
    const m = model({ c1: client({ r: "ann" }) }, { leads: 30, weeks: 4 });
    m.steps[0] = { ...m.steps[0]!, person: "ann" };
    const r = runOnce(m, 1, true);
    const segs = tasksOf(r.entities, "c1").flatMap((e) => e.trace);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((s) => s.person === "ann" || s.person === null)).toBe(true);
    expect(r.steps.task!.avgWait).toBeGreaterThan(0);
  });

  it("falls back to the role's pool while the assignee is on leave", () => {
    const leave: [number, number] = [80, 240];
    const m = model({ c1: client({ r: "ann" }) }, { weeks: 13 });
    m.people!.ann = { ...m.people!.ann!, leave: [leave] };
    const r = runOnce(m, 7, true);
    const segs = tasksOf(r.entities, "c1").flatMap((e) => e.trace).filter((s) => s.tS !== null);
    const during = segs.filter((s) => s.tS! >= leave[0] && s.tS! < leave[1]);
    expect(during.length).toBeGreaterThanOrEqual(3);
    expect(during.every((s) => s.person === "bob")).toBe(true);
    expect(segs.filter((s) => !during.includes(s)).every((s) => s.person === "ann")).toBe(true);
  });

  it("hands tasks already waiting for the assignee to the pool when their leave starts", () => {
    // Ann's task queue backs up behind her pinned pipeline work; when her leave starts, Bob clears it.
    const m = model({ c1: client({ r: "ann" }) }, { leads: 38, weeks: 6, link: { process: "care", recurrence: { every: "week", times: 5 }, sla: 40 } });
    m.steps[0] = { ...m.steps[0]!, person: "ann" };
    m.people!.ann = { ...m.people!.ann!, leave: [[120, 200]] };
    const r = runOnce(m, 2, true);
    const byBob = tasksOf(r.entities, "c1").flatMap((e) => e.trace).filter((s) => s.person === "bob");
    expect(byBob.length).toBeGreaterThan(0);
    // Some of what Bob did had been queued before the leave started.
    expect(byBob.some((s) => s.tQ < 120 && s.tS! >= 120)).toBe(true);
    expect(byBob.every((s) => s.tS! >= 120 && s.tS! < 200)).toBe(true);
  });

  it("clients won during the run are assigned per role by round-robin, and their tasks follow", () => {
    const r = runOnce(model({}, { leads: 1, weeks: 26 }), 4, true);
    const persons = (id: string) => new Set(tasksOf(r.entities, id).flatMap((e) => e.trace.map((s) => s.person)));
    expect(persons("won:1")).toEqual(new Set(["ann"]));
    expect(persons("won:2")).toEqual(new Set(["bob"]));
  });
});

describe("health (docs/PRD.md §6.3.5)", () => {
  const one = (work: number, health: number, extra: Partial<EngineModel> = {}) => {
    const m = { ...model({ c1: client({ r: "ann" }, { health }) }, { work, link: weekly(8) }), ...extra };
    return runOnce(m, 1, false);
  };

  it("on time: +2 per task, capped at 100", () => {
    const r = one(1, 50);
    const c = r.clients!.c1!;
    expect(c.touchpoints).toEqual({ onTime: 10, late: 0, missed: 0 });
    expect(c.health[0]).toBe(50);
    expect(c.health.at(-1)).toBe(70);
    // One task a week: the trajectory climbs by 2 each week.
    for (let w = 1; w < c.health.length; w++) expect(c.health[w]! - c.health[w - 1]!).toBe(2);
    expect(one(1, 99).clients!.c1!.health.at(-1)).toBe(100);
  });

  it("late (done after the SLA, within twice it): −5", () => {
    const c = one(10, 80).clients!.c1!;
    // The last task may finish after the horizon.
    expect(c.touchpoints.onTime + c.touchpoints.missed).toBe(0);
    expect([9, 10]).toContain(c.touchpoints.late);
    expect(c.health.at(-1)).toBe(80 - 5 * c.touchpoints.late);
  });

  it("missed (not done within twice the SLA): −12 when the time runs out, and nothing more when it's done", () => {
    const r = one(20, 90);
    const c = r.clients!.c1!;
    expect(c.touchpoints.onTime + c.touchpoints.late).toBe(0);
    // The last task's deadline may fall after the horizon.
    expect([9, 10]).toContain(c.touchpoints.missed);
    expect(c.health.at(-1)).toBe(Math.max(0, 90 - 12 * c.touchpoints.missed));
    expect(r.touchpoints).toEqual(c.touchpoints);
  });

  it("uses the model's own rules when given, and 80 for a client with no health", () => {
    const r = one(10, 80, { health: { latePenalty: 1 } });
    expect(r.clients!.c1!.health.at(-1)).toBe(80 - r.clients!.c1!.touchpoints.late);
    const m = model({ c1: client({ r: "ann" }) }, { work: 1 });
    expect(runOnce(m, 1, false).clients!.c1!.health[0]).toBe(80);
    expect(runOnce({ ...m, health: { initial: 60 } }, 1, false).clients!.c1!.health[0]).toBe(60);
  });

  it("stays put without servicing: a roster client's health is what the roster says", () => {
    const m = northbeamWithClients();
    const r = runOnce(m, 1, false);
    for (const [id, c] of Object.entries(r.clients!)) {
      expect(c.touchpoints).toEqual({ onTime: 0, late: 0, missed: 0 });
      expect(new Set(c.health)).toEqual(new Set([m.clients![id]!.health]));
    }
  });
});

describe("churn (docs/PRD.md §6.3.5)", () => {
  it("monthly churn = base × (1 + sensitivity × (100 − health) / 100)", () => {
    expect(churnProbability(0.03, 3, 40)).toBeCloseTo(0.03 * (1 + 3 * 0.6), 12);
    expect(churnProbability(0.03, 3, 100)).toBe(0.03);
    expect(churnProbability(0.03, 0, 0)).toBe(0.03);
    expect(churnProbability(0.5, 3, 0)).toBe(1);
    expect(churnProbability(0.03, 3, 150)).toBe(0.03);
  });

  it("each client reports the churn its final health implies", () => {
    const r = runOnce(model({ c1: client({ r: "ann" }, { health: 80 }) }, { work: 10, svc: { churnMonthly: 0.02, churnSensitivity: 3 } }), 1, false);
    const c = r.clients!.c1!;
    expect(c.churnMonthly).toBeCloseTo(churnProbability(0.02, 3, c.health.at(-1)!), 12);
  });

  it("clients churn at the formula's weekly rate (monthly / 4.33), on their own streams", () => {
    const share = (sensitivity: number) => {
      const m = model({ c1: client({}, { health: 20 }) }, { weeks: 1, svc: { churnMonthly: 0.5, churnSensitivity: sensitivity, servicing: [] } });
      let churned = 0;
      const n = 4000;
      for (let seed = 1; seed <= n; seed++) churned += runOnce(m, seed, false).clientsChurned!;
      return churned / n;
    };
    expect(share(1)).toBeCloseTo((0.5 * (1 + 0.8)) / 4.33, 1);
    expect(Math.abs(share(1) - (0.5 * 1.8) / 4.33)).toBeLessThan(0.02);
    expect(Math.abs(share(0) - 0.5 / 4.33)).toBeLessThan(0.02);
  });

  it("churned clients stop billing; the roster bills at its MRR while active", () => {
    // 4,330 a month is 1,000 a week.
    const stay = runOnce(model({ c1: client() }, { svc: { servicing: [] } }), 1, false);
    expect(stay.billed).toBeCloseTo(10_000, 6);
    const gone = runOnce(model({ c1: client() }, { svc: { servicing: [], churnMonthly: 5 } }), 1, false);
    expect(gone.clientsChurned).toBe(1);
    expect(gone.billed).toBeCloseTo(1_000, 6);
    // A client won at t bills its service's price from then on.
    const won = runOnce(model({}, { leads: 1, svc: { servicing: [] } }), 3, true);
    const wins = won.entities!.filter((e) => e.outcome === "won").map((e) => e.done!);
    expect(won.billed).toBeCloseTo(wins.reduce((sum, t) => sum + (1000 * (400 - t)) / HPW, 0), 6);
  });
});

describe("outputs", () => {
  it("per-client results: health trajectory, touchpoints, churn probability and share churned", () => {
    const m = model({ c1: client({ r: "ann" }, { health: 60 }), c2: client({ r: "bob" }, { health: 90 }) }, { work: 1 });
    const r = simulate(m, 5, 1);
    const c1 = r.clients!.c1!;
    expect(c1.name).toBe("Client");
    expect(c1.trajectory).toHaveLength(11);
    expect(c1.trajectory[0]).toBe(60);
    expect(c1.health.mean).toBe(80);
    expect(c1.touchpoints).toEqual({ onTime: 10, late: 0, missed: 0 });
    expect(c1.churned).toBe(0);
    expect(c1.atRisk).toBe(0);
    expect(r.kpi.touchpoints!.onTime.mean).toBe(20);
    expect(r.kpi.clientsAtRisk!.mean).toBe(0);
    expect(r.kpi.clientsChurned!.mean).toBe(0);
  });

  it("clients at risk: active clients with health below 50 at the horizon", () => {
    const m = model({ c1: client({ r: "ann" }, { health: 70 }), c2: client({ r: "bob" }, { health: 95 }) }, { work: 10 });
    const r = simulate(m, 3, 1);
    // Nine or ten late tasks take 45–50 off each: c1 ends at 20–25, c2 at 45–50.
    expect(r.clients!.c1!.health.p90).toBeLessThanOrEqual(25);
    expect(r.clients!.c1!.atRisk).toBe(1);
    const c2Low = r.clients!.c2!.atRisk;
    expect(r.kpi.clientsAtRisk!.mean).toBeCloseTo(1 + c2Low, 9);
    expect(runOnce(m, 1, false).clientsAtRisk).toBe(Object.values(runOnce(m, 1, false).clients!).filter((c) => c.health.at(-1)! < 50).length);
  });

  it("raises a churn_risk issue for each client whose health ends below 50, linked to the client", () => {
    const m = model({ c1: client({ r: "ann" }, { health: 70, name: "Acme" }), c2: client({ r: "bob" }, { health: 95, name: "Brio" }) }, { work: 10 });
    const r = simulate(m, 3, 1);
    const churn = detectIssues(m, r).filter((i) => i.type === "churn_risk");
    expect(churn.map((i) => i.key)).toEqual(r.clients!.c2!.health.mean < 50 ? ["churn_risk:client:c1", "churn_risk:client:c2"] : ["churn_risk:client:c1"]);
    const acme = churn[0]!;
    expect(acme.clientId).toBe("c1");
    expect(acme.title).toMatch(/^Acme: health falls from 70 to \d+, at risk of churning$/);
    expect(acme.evidence).toMatch(/late/);
    expect(acme.stepId).toBe("task");
    expect(acme.personId).toBe("ann");
    expect(acme.fix?.patch).toEqual([{ path: "roles.r.headcount", op: "add", value: 1 }]);
    expect(acme.metrics.health).toBeLessThan(50);
  });

  it("Northbeam: Swift Courier starts at 47 and is flagged; every roster client is reported", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    expect(Object.keys(r.clients!)).toHaveLength(26);
    expect(r.kpi.touchpoints!.onTime.mean).toBeGreaterThan(r.kpi.touchpoints!.late.mean);
    const issues = detectIssues(m, r);
    expect(issues.some((i) => i.key === "churn_risk:client:c12" && i.clientId === "c12")).toBe(true);
    expect(r.bnRole).toBe("strat");
  });
});

describe("behaviour (docs/PRD.md §6.9 item 2)", () => {
  it("raising lead volume raises missed touchpoints, lowers health and raises churn", () => {
    // Ann does both the pipeline and six clients' weekly servicing.
    const clients = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`c${i}`, client({ r: "ann" }, { health: 75 })]));
    const at = (leads: number) => {
      const m = model(clients, { leads, work: 2, weeks: 13, link: weekly(16), svc: { churnMonthly: 0.1, churnSensitivity: 3 } });
      m.roles = { r: { name: "Role r", count: 1, cost: 50, ongoing: 0 } };
      m.people = { ann: { name: "Ann", roles: ["r"], capacity: HPW } };
      m.steps[0] = { ...m.steps[0]!, work: 3, workDist: undefined };
      return simulate(m, 60, 1);
    };
    const calm = at(2);
    const busy = at(9);
    const meanHealth = (r: ReturnType<typeof simulate>) => Object.values(r.clients!).reduce((a, c) => a + c.health.mean, 0) / 6;
    const meanChurn = (r: ReturnType<typeof simulate>) => Object.values(r.clients!).reduce((a, c) => a + c.churnMonthly.mean, 0) / 6;
    expect(busy.kpi.touchpoints!.missed.mean).toBeGreaterThan(calm.kpi.touchpoints!.missed.mean);
    expect(busy.kpi.touchpoints!.onTime.mean).toBeLessThan(calm.kpi.touchpoints!.onTime.mean);
    expect(meanHealth(busy)).toBeLessThan(meanHealth(calm) - 10);
    expect(meanChurn(busy)).toBeGreaterThan(meanChurn(calm));
    expect(busy.kpi.clientsChurned!.mean).toBeGreaterThan(calm.kpi.clientsChurned!.mean);
  });
});

describe("fallback load (docs/PRD.md §6.3.4)", () => {
  it("a service with a servicing process skips its fallback load; one without keeps it", () => {
    const m = model({}, {});
    m.services = {
      svc: service([weekly()], { fallbackOngoing: { r: 43.3 } }),
      plain: service([], { fallbackOngoing: { r: 86.6 } }),
    };
    expect(clientRoleLoads(m, { services: ["svc"] })).toEqual({});
    expect(clientRoleLoads(m, { services: ["plain"] })).toEqual({ r: 20 });
    expect(clientRoleLoads(m, { services: ["svc", "plain"] })).toEqual({ r: 20 });
    // Its process gone (not in the model), the fallback applies again.
    expect(clientRoleLoads({ ...m, servicingProcesses: {} }, { services: ["svc"] })).toEqual({ r: 10 });
    m.clients = { c1: { ...client({ r: "ann" }), services: ["svc", "plain"] } };
    expect(rosterLoads(m, m.people!).ann!.hours).toBeCloseTo(20, 9);
    const r = runOnce(m, 1, false);
    expect(r.people.ann!.ongoingHours).toBeCloseTo(20, 9);
    expect(r.people.ann!.servicingHours).toBeGreaterThan(0);
  });
});

describe("compatibility and determinism", () => {
  it("no servicing processes: runs exactly as before servicing existed", () => {
    const golden = JSON.stringify(simulate(northbeamWithClients(), 10, 1));
    const empty = northbeamWithClients();
    empty.servicingProcesses = {};
    empty.services = Object.fromEntries(Object.entries(empty.services!).map(([id, sv]) => [id, { ...sv, servicing: [] }]));
    expect(JSON.stringify(simulate(empty, 10, 1))).toBe(golden);
  });

  it("without a roster, servicing links are ignored", () => {
    const { clients: _c, ...pooled } = northbeamWithServicing();
    const { clients: _d, ...plain } = northbeamWithClients();
    const kpi = simulate(plain, 10, 1).kpi;
    expect(simulate(pooled, 10, 1).kpi).toEqual(kpi);
    // Only the pooled `ongoing` load applies: nobody does servicing.
    expect(Object.values(kpi.people).every((p) => p.servicing.mean === 0)).toBe(true);
  });

  it("same seed, same result", () => {
    expect(simulate(northbeamWithServicing(), 10, 3)).toEqual(simulate(northbeamWithServicing(), 10, 3));
  });

  it("tasks come from their own streams: a different lead rate doesn't move when clients' tasks fall due", () => {
    const at = (leads: number) => {
      const m = { ...northbeamWithServicing(), leadsPerWeek: leads, warmupWeeks: 4 };
      m.services = Object.fromEntries(Object.entries(m.services!).map(([id, sv]) => [id, { ...sv, churnMonthly: 0 }]));
      return tasksOf(runOnce(m, 5, true).entities, "c07").map((e) => e.t0);
    };
    expect(at(3).length).toBeGreaterThan(5);
    expect(at(3)).toEqual(at(9));
  });
});

describe("performance (docs/PRD.md §6.7)", () => {
  // The limit is the best of three 30-replication runs (< 1.5 s); the test's wall time is a warm-up plus all three, so an
  // engine just inside the limit needs about 4.7 s, too close to Vitest's 5 s default. Issue #181 measured the engine
  // before and after #178 (the same speed: best of 5, about 0.8 s here, identical KPIs); the timeouts on CI were other
  // suites sharing the CPU, now fixed by running perf tests on their own. The timeout bounds the harness, not the target.
  it("40 steps, 25 people, 26 clients with servicing, 26 weeks, 30 reps: within 1.5 s", { tags: ["perf"], timeout: 10_000 }, () => {
    const m = largeModel();
    m.services = {
      svc: service(
        [
          { process: "report", recurrence: { every: "month", times: 1 }, sla: 40 },
          { process: "call", recurrence: { every: "week", times: 0.5 }, sla: 16 },
          { process: "adhoc", recurrence: { poissonPerMonth: 1 }, sla: 24 },
        ],
        { churnMonthly: 0.03, churnSensitivity: 3 },
      ),
    };
    m.servicingProcesses = {
      report: { name: "Report", entry: "rp1", steps: ["rp1", "rp2", "rp3"] },
      call: { name: "Call", entry: "cl1", steps: ["cl1"] },
      adhoc: { name: "Ad hoc", entry: "ah1", steps: ["ah1"] },
    };
    m.ends = { svc_done: { outcome: "done" } };
    m.steps.push(
      { id: "rp1", name: "Data", role: "r1", work: 2, wait: 0, rework: 0, next: [{ to: "rp2", p: 1 }] },
      { id: "rp2", name: "Write", role: "r2", work: 1, wait: 8, rework: 0.1, next: [{ to: "rp3", p: 1 }] },
      { id: "rp3", name: "Send", role: "r3", work: 0.5, wait: 0, rework: 0, next: [{ to: "svc_done", p: 1 }] },
      { id: "cl1", name: "Call", role: "r2", work: 0.5, wait: 0, rework: 0, next: [{ to: "svc_done", p: 1 }] },
      { id: "ah1", name: "Request", role: "r4", work: 1, wait: 0, rework: 0, next: [{ to: "svc_done", p: 1 }] },
    );
    m.clients = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`c${i}`, { name: `C${i}`, services: ["svc"], mrr: 3000, health: 60 + i, assignments: { r2: `r2#${(i % 3) + 1}` } }]),
    );
    simulate(m, 3, 1); // warm up the JIT
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const r = simulate(m, 30, 1);
      best = Math.min(best, performance.now() - t);
      expect(r.kpi.touchpoints!.onTime.mean).toBeGreaterThan(100);
    }
    expect(best).toBeLessThan(1500);
  });
});
