import { describe, expect, test } from "vitest";
import { capacityModel, simulate, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import {
  bottleneck,
  busyShares,
  capacitySetupFromModel,
  departmentCeiling,
  departmentTime,
  dler,
  dlerSalariesMissing,
  modelProcessOfStep,
  personFees,
  roomPulse,
  limitedBy,
  hiringAdvice,
  hiringDelayAt,
  leaver,
  leavers,
  atRisk,
  riskOf,
  AT_RISK_MARGIN,
  perEmployee,
  personMax,
  plannedServiceHours,
  serviceLines,
  timeToServe,
  todayModel,
  wholeBusiness,
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

describe("leavers (several people leave at once)", () => {
  const MONTH = (40 * 52) / 12;
  test("every leaver is out of the pool before any client is handed out, so no leaver takes another's clients", () => {
    const model = tinyModel();
    model.people!.a!.portfolio = { "org-T1": 2 };
    model.people!.b!.portfolio = { "org-T1": 1 };
    const setup = capacitySetupFromModel(model);
    // Ann and Bo are the least busy (0.02, 0.01): either would win every pick if still in the pool. Cy (0.3) takes all three; Dee is at 0.9.
    const r = fakeResult({ d: 0.9, a: 0.02, b: 0.01, c: 0.3, free: 0.3 }, {}, { a: 10, b: 5 }, { a: 2, b: 1 }, model);
    const res = leavers(setup, model, r, ["a", "b"])!;
    expect(res.leaverIds).toEqual(["a", "b"]);
    expect(res.clients).toBe(3);
    expect(res.received).toEqual({ c: 3 });
    expect(res.unplaced).toBe(0);
    expect(res.rows.map((x) => x.id)).toEqual(["c"]);
    expect(res.rows[0]!.after).toBeCloseTo(0.3 + (3 * 2) / MONTH, 10);
  });

  test("clients go one at a time to whoever is least busy at that moment, across the leavers' clients together", () => {
    const model = tinyModel();
    model.people!.a!.portfolio = { "org-T1": 2 };
    model.people!.b!.portfolio = { "org-T1": 2 };
    const setup = capacitySetupFromModel(model);
    // Cy 0.40 and Dee 0.41; each client adds 2 ÷ 173.33 = 0.0115. Ann's: Cy (0.4115), Dee (0.4215). Bo's: Cy (0.4231), Dee (0.4331).
    const r = fakeResult({ d: 0.41, a: 0.5, b: 0.5, c: 0.4, free: 0.3 }, {}, { a: 10, b: 10 }, { a: 2, b: 2 }, model);
    const res = leavers(setup, model, r, ["a", "b"])!;
    expect(res.received).toEqual({ c: 2, d: 2 });
    expect(res.rows.find((x) => x.id === "c")!.after).toBeCloseTo(0.4 + (2 * 2) / MONTH, 10);
    expect(res.rows.find((x) => x.id === "d")!.after).toBeCloseTo(0.41 + (2 * 2) / MONTH, 10);
  });

  test("a shared-team leaver with a client-facing one: the team shares the hours, the clients are handed out", () => {
    const model = tinyModel();
    model.people!.a!.portfolio = { "org-T1": 1 };
    model.people!.free2 = { name: "Second", roles: ["content"], capacity: 40 };
    const setup = capacitySetupFromModel(model);
    const r = fakeResult({ d: 0.9, a: 0.5, b: 0.6, c: 0.5, free: 0.5, free2: 0.5 }, {}, { free: 52 }, { a: 1 }, model);
    const res = leavers(setup, model, r, ["free", "a"])!;
    expect(res.sharedTeams).toEqual(["content"]);
    expect(res.emptyTeams).toEqual([]);
    expect(res.received).toEqual({ c: 1 });
    expect(res.rows.find((x) => x.id === "free2")!.after).toBeCloseTo(0.5 + 52 / MONTH, 10);
    expect(res.rows.find((x) => x.id === "c")!.after).toBeCloseTo(0.5 + 2 / MONTH, 10);
  });

  test("when the whole shared team leaves, nobody is left to share the hours", () => {
    const model = tinyModel();
    model.people!.free2 = { name: "Second", roles: ["content"], capacity: 40 };
    const setup = capacitySetupFromModel(model);
    const r = fakeResult({ d: 0.9, a: 0.5, b: 0.5, c: 0.5, free: 0.5, free2: 0.5 }, {}, { free: 52, free2: 20 }, {}, model);
    const res = leavers(setup, model, r, ["free", "free2"])!;
    expect(res.emptyTeams).toEqual(["content"]);
    expect(res.sharedTeams).toEqual([]);
    expect(res.rows).toEqual([]);
  });

  test("repeated and unknown ids are dropped; nobody known gives null; one id matches leaver()", () => {
    const model = tinyModel();
    model.people!.a!.portfolio = { "org-T1": 3 };
    const setup = capacitySetupFromModel(model);
    const r = fakeResult({ d: 0.7, a: 0.05, b: 0.4, c: 0.41, free: 0.3 }, {}, { a: 10 }, { a: 3 }, model);
    expect(leavers(setup, model, r, [])).toBeNull();
    expect(leavers(setup, model, r, ["nobody"])).toBeNull();
    const many = leavers(setup, model, r, ["a", "a", "nobody"])!;
    expect(many.leaverIds).toEqual(["a"]);
    const one = leaver(setup, model, r, "a")!;
    expect(one).toMatchObject({ leaverId: "a", kind: "client_facing" });
    expect(many.received).toEqual(one.received);
    expect(many.rows).toEqual(one.rows);
  });
});

describe("atRisk", () => {
  test(`over (at or past the threshold) first, then near (within ${AT_RISK_MARGIN * 100} points under it), busiest first; with hours by purpose`, () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    const { people } = busyShares(setup, model, fakeResult({ d: 0, a: 0, b: 0, c: 0, free: 0 }, {}, {}, {}, model));
    const line = people.find((p) => p.id === "a")!.line;
    const freeLine = people.find((p) => p.id === "free")!.line;
    // Dee over; Ann exactly 10 points under (near); Bo just past near; Cy at the line (over); the freelancer near.
    const r = fakeResult({ d: line + 0.05, a: line - 0.1, b: line - 0.11, c: line, free: freeLine - 0.05 }, {}, { free: 40, d: 12 }, {}, model);
    const res = atRisk(setup, model, r);
    expect(res.people.map((x) => [x.person.id, x.status])).toEqual([
      ["d", "over"],
      ["c", "over"],
      ["free", "near"],
      ["a", "near"],
    ]);
    expect(res.over).toBe(2);
    expect(res.near).toBe(2);
    expect(res.people.find((x) => x.person.id === "free")!.byPurpose).toEqual([{ name: "Content", hours: 40 }]);
    expect(res.people.find((x) => x.person.id === "free")!.steps).toEqual([{ stepId: "r2", name: "Report upload", hours: 40 }]);
    expect(riskOf(0.5, 0.85)).toBeNull();
    expect(riskOf(0.75, 0.85)).toBe("near");
    expect(riskOf(0.85, 0.85)).toBe("over");
  });
});

describe("dler (D40: the average of each client-facing person's DLER)", () => {
  // Counted clients at 1,000: Dee 4, Ann 10, Bo 6, Cy none. Salaries: Dee 12,500, Ann 7,500, Bo 7,500, Cy 7,500; the freelancer is a contractor.
  // Person DLERs: Dee 4,000 ÷ 12,500 = 0.32; Ann 10,000 ÷ 7,500 = 4/3; Bo 6,000 ÷ 7,500 = 0.8; Cy 0.
  const DEE = 4000 / 12500;
  const ANN = 10000 / 7500;
  const BO = 6000 / 7500;
  test("leadership in: the mean of Dee, Ann, Bo and Cy", () => {
    const res = dler(capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: true }));
    const org = res.departments.find((d) => d.departmentId === "org")!;
    expect(org.people).toBe(4);
    expect(org.ratio).toBeCloseTo((DEE + ANN + BO + 0) / 4, 10);
    expect(org.retainers).toBe(20000);
    expect(res.whole.ratio).toBeCloseTo((DEE + ANN + BO + 0) / 4, 10);
  });
  test("leadership out (the default, D48): the director leaves the average", () => {
    expect(dler(capacitySetupFromModel(tinyModel())).whole.ratio).toBeCloseTo((ANN + BO + 0) / 3, 10);
    const org = dler(capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: false })).departments.find((d) => d.departmentId === "org")!;
    expect(org.people).toBe(3);
    expect(org.ratio).toBeCloseTo((ANN + BO + 0) / 3, 10);
  });
  test("someone with no salary entered is left out of the average, not counted as zero", () => {
    const setup = capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: false });
    setup.people.find((p) => p.name === "Cy")!.salary_monthly = null;
    const org = dler(setup).departments.find((d) => d.departmentId === "org")!;
    expect(org.people).toBe(2);
    expect(org.ratio).toBeCloseTo((ANN + BO) / 2, 10);
  });
  test("pay hidden: no ratio comes out", () => {
    const res = dler(capacitySetupFromModel(tinyModel(), { payHidden: true }));
    expect(res.departments.every((d) => d.hidden && d.ratio === null)).toBe(true);
    expect(res.whole.hidden).toBe(true);
    expect(res.whole.ratio).toBeNull();
  });
  test("a named client's fee goes to its manager, not to the tier's counted fee", () => {
    const model = tinyModel();
    model.clients = { n1: { name: "Named", services: ["org-T1"], mrr: 5000, assignments: { mgr_org: "c" }, manager: "c" } };
    const setup = capacitySetupFromModel(model, { dlerIncludesLeadership: false });
    const fees = personFees(setup);
    // Cy now manages the named client's 5,000; the counted clients stay with their holders.
    expect(fees.get("c")).toBe(5000);
    expect(fees.get("a")).toBe(10000);
    const org = dler(setup).departments.find((d) => d.departmentId === "org")!;
    expect(org.ratio).toBeCloseTo((ANN + BO + 5000 / 7500) / 3, 10);
  });
  test("the Sandbox's retainers for a month are shared by each person's share of today's fees", () => {
    const setup = capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: false });
    // A pool of 32,000 (a third more than today's 20,000... of which Ann, Bo and Cy hold 16,000): Ann 10/16, Bo 6/16, Cy has none and takes the mean share (16,000 / 3).
    const org = dler(setup, { org: 32000 }).departments.find((d) => d.departmentId === "org")!;
    const mean = 16000 / 3;
    const sum = 10000 + 6000 + mean;
    expect(org.ratio).toBeCloseTo((((32000 * 10000) / sum) / 7500 + ((32000 * 6000) / sum) / 7500 + ((32000 * mean) / sum) / 7500) / 3, 10);
    expect(org.retainers).toBeCloseTo(32000, 6);
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

describe("the leadership flag", () => {
  test("per-employee figures follow the flag on the role, not its name", () => {
    const setup = capacitySetupFromModel(tinyModel());
    const flipped = { ...setup, roles: setup.roles.map((r) => ({ ...r, leadership: !r.leadership })) };
    expect(perEmployee(setup, "org").employees).toBe(3);
    // Every flag flipped: the director is counted again, and the other two client-facing roles and the shared one drop out.
    expect(perEmployee(flipped, "org").employees).toBeLessThan(3);
    const none = { ...setup, roles: setup.roles.map((r) => ({ ...r, leadership: false })) };
    expect(perEmployee(none, "org").employees).toBe(4);
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

    // The workspace's market stretches the delay: "time to hire" 200% from month 0 doubles 2 months to 4.
    const slow = { months: Array.from({ length: 24 }, () => ({ leads: 1, conv: 1, cycle: 1, price: 1, churn: 1, hire: 2, pay: 1 })) };
    expect(hiringDelayAt(slow, 3)).toBe(4);
    expect(hiringDelayAt(undefined, 3)).toBe(2);
    expect(hiringAdvice(setup, result, (m) => hiringDelayAt(slow, m)).map((a) => [a.roleId, a.hireBy])).toEqual([
      ["dir_org", -3],
      ["mgr_org", -1],
      ["content", null],
    ]);
    expect(hiringAdvice(setup, result, (m) => hiringDelayAt(undefined, m))[1]!.hireBy).toBe(1);
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

describe("the Overview's figures (P6)", () => {
  test("whole business: unique clients, revenue per employee over everyone but contractors and leaders, DLER without the director (D48)", () => {
    const setup = capacitySetupFromModel(tinyModel());
    setup.tiers[0]!.both_count = 3;
    const w = wholeBusiness(setup);
    expect(w.unique).toBe(17);
    expect(w.both).toBe(3);
    // Ann, Bo and Cy are the employees; Dee leads and the freelancer is a contractor.
    expect(w.employees).toBe(3);
    expect(w.revenuePerEmployee).toBeCloseTo(20000 / 3, 10);
    expect(w.dler.ratio).toBeCloseTo((10000 / 7500 + 6000 / 7500 + 0) / 3, 10);
  });
  test("DLER follows the leadership switch; per-employee does not", () => {
    const withLead = wholeBusiness(capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: true }));
    const without = wholeBusiness(capacitySetupFromModel(tinyModel(), { dlerIncludesLeadership: false }));
    expect(withLead.dler.ratio).toBeCloseTo((4000 / 12500 + 10000 / 7500 + 6000 / 7500 + 0) / 4, 10);
    expect(without.dler.ratio).toBeCloseTo((10000 / 7500 + 6000 / 7500 + 0) / 3, 10);
    expect(without.employees).toBe(withLead.employees);
  });
  test("a missing salary of someone in DLER is flagged; a contractor's is not; hidden pay is never flagged", () => {
    const setup = capacitySetupFromModel(tinyModel());
    expect(dlerSalariesMissing(setup, "org")).toBe(false);
    setup.people.find((p) => p.name === "Freelancer")!.salary_monthly = null;
    expect(dlerSalariesMissing(setup, "org")).toBe(false);
    setup.people.find((p) => p.name === "Ann")!.salary_monthly = null;
    expect(dlerSalariesMissing(setup, "org")).toBe(true);
    expect(dlerSalariesMissing(setup, null)).toBe(true);
    expect(dlerSalariesMissing({ ...setup, payHidden: true }, "org")).toBe(false);
  });
  test("where the time goes: hours by purpose for the department's people, with shares", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    // Ann (SEO) does 30 h and Bo 10 h of step r2 (purpose "Content"); the freelancer's hours (Content team, no department) are not Organic's.
    const result = fakeResult({ a: 0.5, b: 0.4 }, {}, { a: 30, b: 10 }, {}, model);
    const t = departmentTime(setup, model, result, "org", { Content: "Making content" });
    expect(t.total).toBe(40);
    expect(t.parts).toEqual([{ name: "Making content", hours: 40, share: 1 }]);
    (result.personTime!.stepHours as Record<string, Record<string, number>>).a!.hand = 10;
    const u = departmentTime(setup, model, result, "org");
    expect(u.parts.map((x) => x.name)).toEqual(["Content", "Hand-holding"]);
    expect(u.parts[1]!.share).toBeCloseTo(10 / 50, 10);
  });
  test("where the time goes by process: the same hours, grouped by the process of each step (Q1 item 16)", () => {
    const model = tinyModel();
    const setup = capacitySetupFromModel(model);
    const result = fakeResult({ a: 0.5, b: 0.4 }, {}, { a: 30, b: 10 }, {}, model);
    // Step r2 is in the "report" servicing process, named "Report".
    const byProcess = departmentTime(setup, model, result, "org", {}, { processOfStep: modelProcessOfStep(model) });
    expect(byProcess.total).toBe(40);
    expect(byProcess.parts).toEqual([{ name: "Report", hours: 40, share: 1 }]);
    // A map of the app's own process names (steps by id) is used as given, and a step it doesn't know is "Other".
    expect(departmentTime(setup, model, result, "org", {}, { processOfStep: new Map([["r2", "Monthly reporting"]]) }).parts[0]!.name).toBe("Monthly reporting");
    expect(departmentTime(setup, model, result, "org", {}, { processOfStep: new Map() }).parts[0]!.name).toBe("Other");
  });
});

describe("room for more clients as a pulse check (Q1 item 15)", () => {
  test("a status word from the room as a share of today's clients, with the edges as written", () => {
    // 100 clients: 20 is exactly 20% (plenty), 19 is some room, 5 is exactly 5% (some room), 4 is tight, 0 is full.
    expect(roomPulse(20, 100).status).toBe("Plenty of room");
    expect(roomPulse(19, 100).status).toBe("Some room");
    expect(roomPulse(5, 100).status).toBe("Some room");
    expect(roomPulse(4, 100).status).toBe("Tight");
    expect(roomPulse(0, 100).status).toBe("Full");
    expect(roomPulse(0.4, 100).status).toBe("Full");
    expect(roomPulse(3, 0).status).toBe("Plenty of room");
  });
  test("colours: green until tight, amber when tight, red when full", () => {
    expect([roomPulse(30, 100).tone, roomPulse(10, 100).tone, roomPulse(2, 100).tone, roomPulse(0, 100).tone]).toEqual(["ok", "ok", "warn", "bad"]);
  });
  test("the figure is rounded to the nearest 5 from 10 up, else to the nearest whole client", () => {
    expect(roomPulse(12, 60).words).toBe("about 10 more clients");
    expect(roomPulse(13, 60).words).toBe("about 15 more clients");
    expect(roomPulse(10, 40).approx).toBe(10);
    expect(roomPulse(9, 40).words).toBe("about 9 more clients");
    expect(roomPulse(1, 40).words).toBe("about 1 more client");
    expect(roomPulse(0, 40).words).toBe("");
  });
  test("says what limits it", () => {
    expect(limitedBy("Client-facing people")).toBe("client managers");
    expect(limitedBy("Content team")).toBe("Content team");
  });
});
