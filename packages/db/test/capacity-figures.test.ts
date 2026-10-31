import { describe, expect, test } from "vitest";
import { capacityModel, simulate, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import {
  bottleneck,
  busyShares,
  capacitySetupFromModel,
  departmentCeiling,
  dler,
  hiringAdvice,
  leaver,
  perEmployee,
  personMax,
  plannedServiceHours,
  serviceLines,
  timeToServe,
  todayModel,
} from "../src";

// A small agency, small enough to check by hand. Ids follow the prototype's example (capacitySetupFromModel knows their departments).
//   Organic, one service (org-T1, fee 1,000, win mix 100%). Its monthly process: a report step for the client's manager (2 h), a content step
//   (1 h, Content team) and a per-1,000-words step (0.5 h, Content team); the client has 3,000 words.
//   People: d (SEO Director, 4 clients), a and b (SEO Manager / Analyst, 10 and 6 clients), c (the same role, no clients), f (Content, a contractor).
//   Everyone has 40 hours a week and no team time, so 40 × 52/12 = 173.33 hours a month.
function tinyModel(): EngineModel {
  const person = (name: string, role: string, portfolio?: Record<string, number>) => ({ name, roles: [role], capacity: 40, ...(portfolio ? { portfolio } : {}) });
  return {
    horizonWeeks: 52,
    hoursPerWeek: 40,
    leadsPerWeek: 3,
    activeClients: 0,
    churnMonthly: 0.02,
    retainer: 0,
    roles: {
      dir_org: { name: "SEO Director", count: 1, cost: 0, ongoing: 0 },
      mgr_org: { name: "SEO Manager / Analyst", count: 3, cost: 0, ongoing: 0 },
      content: { name: "Content team", count: 1, cost: 0, ongoing: 0, unit: { label: "words" } },
    },
    people: {
      d: person("Dee", "dir_org", { "org-T1": 4 }),
      a: person("Ann", "mgr_org", { "org-T1": 10 }),
      b: person("Bo", "mgr_org", { "org-T1": 6 }),
      c: person("Cy", "mgr_org"),
      free: person("Freelancer", "content"),
    },
    services: {
      "org-T1": {
        name: "Organic Tier 1",
        pricingModel: "retainer",
        price: 1000,
        margin: 0,
        tenureMonths: 50,
        churnMonthly: 0.02,
        mixShare: 1,
        pathTags: [],
        department: "org",
        tier: "T1",
        deliverables: { words: 3000 },
        servicing: [
          { process: "report", recurrence: { every: "month", times: 1 }, sla: 100 },
          { process: "words", recurrence: { perMonth: 1, driver: "words", per: 1000 }, sla: 100 },
        ],
      },
    },
    servicingProcesses: {
      report: { name: "Report", entry: "r1", steps: ["r1", "r2"] },
      words: { name: "Words", entry: "w1", steps: ["w1"] },
    },
    entry: "r1",
    sinks: { won: "won", lost: "lost" },
    ends: { done: { outcome: "done" } },
    steps: [
      { id: "r1", name: "Monthly report", role: "mgr_org", toClientManager: true, work: 2, wait: 0, rework: 0, purpose: "Reporting", next: [{ to: "r2", p: 1 }] },
      { id: "r2", name: "Report upload", role: "content", work: 1, wait: 0, rework: 0, purpose: "Content", next: [{ to: "done", p: 1 }] },
      { id: "w1", name: "Writing (per 1,000 words)", role: "content", work: 0.5, wait: 0, rework: 0, purpose: "Content", next: [{ to: "done", p: 1 }] },
    ],
  };
}

/** A result with only the parts the figures read. `util` is the mean busy share; the range is ±0.05. */
function fakeResult(util: Record<string, number>, roleUtil: Record<string, number>, hours: Record<string, number>, clients: Record<string, number>, model: EngineModel): SimulationResult {
  const stat = (v: number) => ({ mean: v, p10: v - 0.05, p90: v + 0.05 });
  const block = (v: number) => ({ util: stat(v), pipeline: stat(0), ongoing: stat(0), servicing: stat(0), overtime: stat(0) });
  return {
    kpi: {
      people: Object.fromEntries(Object.entries(util).map(([k, v]) => [k, block(v)])),
      roles: Object.fromEntries(Object.entries(roleUtil).map(([k, v]) => [k, block(v)])),
    },
    personTime: {
      stepHours: Object.fromEntries(Object.entries(hours).map(([k, v]) => [k, { r2: v }])),
      clients: Object.fromEntries(Object.entries(clients).map(([k, v]) => [k, { "org-T1": v }])),
    },
    resolvedPeople: model.people,
  } as unknown as SimulationResult;
}

describe("personMax", () => {
  test("clients × line ÷ busy, and can-take is the max less the clients", () => {
    const m = personMax(10, 0.85, 0.5);
    expect(m.max).toBeCloseTo(17, 10);
    expect(m.canTake).toBeCloseTo(7, 10);
  });
  test("nobody asked of them gives 0, not a divide by zero", () => {
    expect(personMax(0, 0.85, 0)).toEqual({ max: 0, canTake: 0 });
  });
});

describe("busyShares", () => {
  test("reads the engine's busy share and range against the role's line, with clients by tier", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    const r = fakeResult({ d: 0.9, a: 0.5, b: 0.85, c: 0.1, free: 0.4 }, { mgr_org: 0.48, content: 0.4 }, { a: 80 }, { a: 10, b: 6, d: 4 }, model);
    const { people, roles } = busyShares(setup, model, r);
    const a = people.find((p) => p.id === "a")!;
    expect(a).toMatchObject({ busy: 0.5, low: 0.45, high: 0.55, line: 0.85, over: false, clients: 10, hours: 80, clientsByTier: { T1: 10 } });
    expect(people.find((p) => p.id === "b")!.over).toBe(true); // 0.85 is at the line
    expect(people.find((p) => p.id === "d")!.over).toBe(true);
    expect(roles.find((x) => x.id === "mgr_org")).toMatchObject({ busy: 0.48, people: 3, over: false });
  });
});

describe("departmentCeiling", () => {
  test("the sum of the client-facing maxima when no shared team is lower", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    // d: 4 × 0.85 / 0.85 = 4; a: 10 × 0.85 / 0.5 = 17; b: 6 × 0.85 / 0.85 = 6; c: no clients. Sum 27, clients 20.
    // Content: demand 100 h at 0.5 busy, line 0.85: room 100 × (0.85 / 0.5 − 1) = 70 h; one more client brings 1 + 3 × 0.5 = 2.5 h, so 20 + 28 = 48.
    const r = fakeResult({ d: 0.85, a: 0.5, b: 0.85, c: 0, free: 0.5 }, { content: 0.5 }, { free: 100 }, { a: 10, b: 6, d: 4 }, model);
    const c = departmentCeiling(setup, model, r, "org");
    expect(c.clients).toBe(20);
    expect(c.max).toBeCloseTo(27, 10);
    expect(c.limit).toBe("Client-facing people");
    expect(c.room).toBe(7);
    expect(c.limits.map((l) => l.name)).toEqual(["Client-facing people", "Content team"]);
    expect(c.limits[1]!.max).toBeCloseTo(48, 10);
    expect(c.perPerson.a!.canTake).toBeCloseTo(7, 10);
  });

  test("names a shared team's limit when it is lower, and lists every limit lowest first", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    // Content at 0.8 busy with 100 h: room 100 × (0.85 / 0.8 − 1) = 6.25 h; at 2.5 h a client that is 2.5 more clients: 22.5 < 27.
    const r = fakeResult({ d: 0.85, a: 0.5, b: 0.85, c: 0, free: 0.8 }, { content: 0.8 }, { free: 100 }, { a: 10, b: 6, d: 4 }, model);
    const c = departmentCeiling(setup, model, r, "org");
    expect(c.limit).toBe("Content team");
    expect(c.max).toBeCloseTo(22.5, 10);
    expect(c.room).toBe(2);
    expect(c.limits.map((l) => l.name)).toEqual(["Content team", "Client-facing people"]);
  });

  test("a team already over its line leaves no room", () => {
    const model = tinyModel();
    const r = fakeResult({ d: 0.85, a: 0.5, b: 0.85, c: 0, free: 0.95 }, { content: 0.95 }, { free: 100 }, { a: 10, b: 6, d: 4 }, model);
    const c = departmentCeiling(capacitySetupFromModel(model), model, r, "org");
    expect(c.limit).toBe("Content team");
    // Room is 100 × (0.85 / 0.95 − 1) = −10.53 h, so 20 − 10.53 / 2.5 = 15.79 clients: below what it serves now.
    expect(c.max).toBeCloseTo(20 - (100 * (1 - 0.85 / 0.95)) / 2.5, 10);
    expect(c.room).toBe(0);
  });
});

describe("plannedServiceHours and timeToServe", () => {
  test("tasks a month × step time, by purpose: 2 + 1 + 3 × 0.5", () => {
    const model = tinyModel();
    const h = plannedServiceHours(model, "org-T1");
    expect(h.total).toBeCloseTo(4.5, 10);
    expect(h.manager).toBeCloseTo(2, 10);
    expect(h.byRole.content).toBeCloseTo(2.5, 10);
    expect(h.byPurpose).toEqual({ Reporting: 2, Content: 2.5 });
    expect(h.bySteps).toEqual({ r1: 2, r2: 1, w1: 1.5 });
  });

  test("a tier multiplier and a named client's values change the hours", () => {
    const model = tinyModel();
    model.steps[0]!.tierMultiplier = { T1: 1.5 };
    expect(plannedServiceHours(model, "org-T1").total).toBeCloseTo(3 + 1 + 1.5, 10);
    const client = { name: "X", services: ["org-T1"], mrr: 1500, assignments: {}, handHoldingHours: { mgr_org: 4 }, overrides: { words: 1000 } };
    // 1.5 × 2 = 3 report + 1 upload + 1 × 0.5 words + 4 hand-holding = 8.5
    expect(plannedServiceHours(model, "org-T1", client).total).toBeCloseTo(8.5, 10);
  });

  test("fee ÷ hours per tier and per named client", () => {
    const model = tinyModel();
    model.clients = { n1: { name: "Named", services: ["org-T1"], mrr: 2250, assignments: { mgr_org: "a" }, manager: "a", handHoldingHours: { mgr_org: 4.5 } } };
    const setup = capacitySetupFromModel(model);
    const t = timeToServe(setup, model);
    const tier = t.departments.find((d) => d.id === "org")!.tiers[0]!;
    expect(tier).toMatchObject({ tierKey: "T1", fee: 1000, hours: 4.5 });
    expect(tier.feePerHour).toBeCloseTo(1000 / 4.5, 10);
    expect(tier.byPurpose).toEqual([
      { name: "Content", hours: 2.5 },
      { name: "Reporting", hours: 2 },
    ]);
    const named = t.named[0]!;
    expect(named.hours).toBeCloseTo(9, 10); // 4.5 + 4.5 hand-holding
    expect(named.feePerHour).toBeCloseTo(250, 10);
  });
});

describe("leaver", () => {
  test("hands clients one at a time to the least-busy colleague who serves the tier, never back to the leaver", () => {
    const model = tinyModel();
    model.people!.a!.portfolio = { "org-T1": 3 };
    model.people!.a!.tiers = ["T1"];
    const setup = capacitySetupFromModel(model);
    // Ann (the leaver) is the least busy of all at 0.05, so she would win every pick if she weren't taken out first.
    // Each client brings the manager 2 h ÷ 173.33 h = 0.011538. Bo 0.40 and Cy 0.41: Bo, Cy, Bo (0.4115 > 0.41, then 0.4115 < 0.4215).
    const r = fakeResult({ d: 0.7, a: 0.05, b: 0.4, c: 0.41, free: 0.3 }, {}, { a: 10 }, { a: 3 }, model);
    const res = leaver(setup, model, r, "a")!;
    expect(res.kind).toBe("client_facing");
    expect(res.clients).toBe(3);
    expect(res.received.a).toBeUndefined();
    expect(res.received.b).toBe(2);
    expect(res.received.c).toBe(1);
    expect(res.unplaced).toBe(0);
    const bo = res.rows.find((x) => x.id === "b")!;
    expect(bo.before).toBeCloseTo(0.4, 10);
    expect(bo.after).toBeCloseTo(0.4 + (2 * 2) / ((40 * 52) / 12), 10);
    expect(res.rows.find((x) => x.id === "c")!.after).toBeCloseTo(0.41 + 2 / ((40 * 52) / 12), 10);
    expect(res.rows.some((x) => x.id === "a")).toBe(false);
  });

  test("a colleague pushed over their line is named", () => {
    const model = tinyModel();
    model.people!.a!.portfolio = { "org-T1": 2 };
    const setup = capacitySetupFromModel(model);
    // Bo is at 0.845 and Cy at 0.846: the first client goes to Bo (0.8565), the second to Cy (0.8575). Both pass 0.85; Dee, already over, is not touched.
    const r = fakeResult({ d: 0.9, a: 0.5, b: 0.845, c: 0.846, free: 0.3 }, {}, { a: 10 }, { a: 2 }, model);
    const res = leaver(setup, model, r, "a")!;
    expect(res.goOver).toEqual(["c", "b"]);
  });

  test("clients nobody serves the tier of are counted as unplaced", () => {
    const model = tinyModel();
    for (const id of ["b", "c", "d"]) model.people![id]!.tiers = ["T2"];
    const setup = capacitySetupFromModel(model);
    const r = fakeResult({ d: 0.9, a: 0.5, b: 0.5, c: 0.5, free: 0.3 }, {}, { a: 10 }, { a: 10 }, model);
    const res = leaver(setup, model, r, "a")!;
    expect(res.unplaced).toBe(10);
    expect(res.rows).toEqual([]);
  });

  test("someone in a shared team: the rest of the team shares their hours", () => {
    const model = tinyModel();
    model.people!.free2 = { name: "Second", roles: ["content"], capacity: 40 };
    const setup = capacitySetupFromModel(model);
    const r = fakeResult({ d: 0.9, a: 0.5, b: 0.5, c: 0.5, free: 0.5, free2: 0.5 }, {}, { free: 52 }, {}, model);
    const res = leaver(setup, model, r, "free")!;
    expect(res.kind).toBe("shared");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.after).toBeCloseTo(0.5 + 52 / ((40 * 52) / 12), 10);
  });
});

describe("dler", () => {
  // Retainers: 20 counted clients × 1,000 = 20,000 a month. Salaries (the helper's): Dee 12,500, Ann 7,500, Bo 7,500, Cy 7,500; the contractor is out.
  test("leadership in: retainers ÷ every salary but the contractor's", () => {
    const model = tinyModel();
    const res = dler(capacitySetupFromModel(model, { dlerIncludesLeadership: true }));
    const org = res.departments.find((d) => d.departmentId === "org")!;
    expect(org.retainers).toBe(20000);
    expect(org.salaries).toBe(12500 + 7500 + 7500 + 7500);
    expect(org.ratio).toBeCloseTo(20000 / 35000, 10);
    expect(res.whole.ratio).toBeCloseTo(20000 / 35000, 10);
  });
  test("leadership out: the director's salary leaves the base", () => {
    const res = dler(capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: false }));
    const org = res.departments.find((d) => d.departmentId === "org")!;
    expect(org.salaries).toBe(22500);
    expect(org.ratio).toBeCloseTo(20000 / 22500, 10);
  });
  test("pay hidden: no salaries and no ratio come out", () => {
    const res = dler(capacitySetupFromModel(tinyModel(), { payHidden: true }));
    expect(res.departments.every((d) => d.salaries === null && d.ratio === null)).toBe(true);
    expect(res.whole.salaries).toBeNull();
    expect(res.whole.retainers).toBe(20000);
  });
  test("named clients bring their own fee, once, and are not also counted at the tier's fee", () => {
    const model = tinyModel();
    model.clients = { n1: { name: "Named", services: ["org-T1"], mrr: 5000, assignments: { mgr_org: "a" }, manager: "a" } };
    const org = dler(capacitySetupFromModel(model)).departments.find((d) => d.departmentId === "org")!;
    // 20 counted at 1,000 + the named one at 5,000. (The named client is one of the service's clients but is not counted twice.)
    expect(org.retainers).toBe(25000);
  });
});

describe("serviceLines and perEmployee", () => {
  test("unique clients are the departments' clients less those taking both", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    setup.tiers[0]!.both_count = 3;
    const lines = serviceLines(setup);
    expect(lines.byDepartment.find((d) => d.id === "org")!.clients).toBe(20);
    expect(lines.both).toBe(3);
    expect(lines.unique).toBe(17);
  });
  test("clients and revenue per employee leave out contractors and leadership", () => {
    const pe = perEmployee(capacitySetupFromModel(tinyModel()), "org");
    expect(pe.employees).toBe(3); // Ann, Bo, Cy (Dee leads; the freelancer is a contractor)
    expect(pe.clientsPerEmployee).toBeCloseTo(20 / 3, 10);
    expect(pe.revenuePerEmployee).toBeCloseTo(20000 / 3, 10);
  });
});

describe("hiringAdvice", () => {
  test("the first month a role's mean busy share passes its line, less the hiring delay", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    const mb = (v: number) => ({ mean: v, p10: v, p90: v, capacity: 40, work: 0 });
    const result = {
      monthly: {
        roles: {
          mgr_org: [0.5, 0.6, 0.84, 0.86, 0.9, 0.9].map(mb),
          dir_org: [0.5, 0.86, 0.9, 0.9, 0.9, 0.9].map(mb),
          content: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5].map(mb),
        },
      },
    } as unknown as SimulationResult;
    const advice = hiringAdvice(setup, result, 2);
    expect(advice.map((a) => [a.roleId, a.overFrom, a.hireBy])).toEqual([
      ["dir_org", 1, -1],
      ["mgr_org", 3, 1],
      ["content", null, null],
    ]);
    expect(hiringAdvice(setup, result, 0)[1]!.hireBy).toBe(3);
  });
});

describe("todayModel", () => {
  test("no new leads and no churn; everything else untouched", () => {
    const model = capacityModel();
    const t = todayModel(model);
    expect(t.leadsPerWeek).toBe(0);
    expect(t.churnMonthly).toBe(0);
    expect(Object.values(t.services!).every((s) => s.churnMonthly === 0)).toBe(true);
    expect(Object.values(t.clientGroups!).every((g) => g.churnMonthly === 0)).toBe(true);
    expect(t.people).toBe(model.people);
    expect(model.leadsPerWeek).toBeGreaterThan(0); // the original is not changed
  });
});

describe("on the engine's own results (capacityModel, 4 replications)", () => {
  const model = capacityModel();
  const setup = capacitySetupFromModel(model);
  const result = simulate(todayModel(model), 4, 1, { personTime: true });

  test("busy shares and clients come from the run", () => {
    const { people } = busyShares(setup, model, result);
    const laura = people.find((p) => p.id === "laura")!;
    expect(laura.busy).toBeGreaterThan(0.5);
    expect(laura.clients).toBeGreaterThan(5);
    expect(people.find((p) => p.id === "sales")!.busy).toBe(0); // demand is off: sales has nothing to do
  });

  test("the bottleneck is the person furthest over their line, with their steps biggest first", () => {
    const b = bottleneck(setup, model, result)!;
    const { people } = busyShares(setup, model, result);
    const worst = Math.max(...people.map((p) => p.busy - p.line));
    expect(b.over).toBeCloseTo(worst, 10);
    expect(b.steps.length).toBeGreaterThan(0);
    expect(b.steps.map((s) => s.hours)).toEqual([...b.steps.map((s) => s.hours)].sort((x, y) => y - x));
    expect(b.next.length).toBeGreaterThan(0);
  });

  test("each department has a ceiling that names its lowest limit", () => {
    for (const dept of ["org", "perf"]) {
      const c = departmentCeiling(setup, model, result, dept);
      expect(c.limits[0]!.name).toBe(c.limit);
      expect(c.limits.map((l) => l.max)).toEqual([...c.limits.map((l) => l.max)].sort((a, b) => a - b));
      expect(c.max).toBeGreaterThan(0);
    }
  });

  test("a leaver's clients all go to a colleague", () => {
    const res = leaver(setup, model, result, "karl")!;
    expect(res.received.karl).toBeUndefined();
    expect(Object.values(res.received).reduce((a, b) => a + b, 0) + res.unplaced).toBe(res.clients);
    expect(res.clients).toBe(10 + 2 - 0); // Karl's 5 + 5 counted, plus his 2 named clients (n4, n5)
  });
});
