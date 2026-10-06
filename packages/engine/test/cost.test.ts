import { describe, expect, it } from "vitest";
import {
  WEEKS_PER_MONTH,
  absenceTest,
  averageDealValue,
  chanceToSign,
  churnLossValue,
  clientLossValue,
  compareCostsDesc,
  dealValue,
  detectIssues,
  larkspurModel,
  lossValueAtStep,
  northbeamModel,
  northbeamWithClientGroups,
  withClientGroups,
  northbeamWithServices,
  northbeamWithServicing,
  noCost,
  remainingTenure,
  shadowPrice,
  shadowPricesFor,
  simulate,
  type DetectedIssue,
  type EngineModel,
  type EngineStep,
} from "../src";
import { clientChurnMonthly, groupServiceOf } from "../src/clients";
import { payHiddenCost } from "../src/cost";
import { servicingStepIds } from "../src/servicing";

// Cost per month (issue #108; docs/analysis-rules.md "Cost per month"): what a
// loss is worth, the cost method of each rule, and the order issues come in.

const NO_ESC = { escalators: { badMonth: false, bottleneck: false } };
const find = (issues: DetectedIssue[], key: string) => issues.find((i) => i.key === key);

/** One pipeline of steps in a row on one role, 40 h weeks, 26-week horizon. A 1,000 a month retainer with a 20-month tenure (12 months once capped). */
function line(leadsPerWeek: number, steps: (Partial<EngineStep> & { id: string })[], extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 26,
    hoursPerWeek: 40,
    leadsPerWeek,
    activeClients: 0,
    churnMonthly: 0.05,
    retainer: 1000,
    warmupWeeks: 4,
    roles: { r: { name: "Role r", count: 1, cost: 50, ongoing: 0 } },
    entry: steps[0]!.id,
    sinks: { won: "won", lost: "lost" },
    steps: steps.map((s, i) => ({
      name: `Step ${s.id}`,
      role: "r",
      work: 1,
      wait: 0,
      rework: 0,
      workDist: { kind: "constant" },
      next: [{ to: steps[i + 1]?.id ?? "won", p: 1 }],
      ...s,
    })),
    ...extra,
  };
}

describe("what a loss is worth", () => {
  it("deal value is the monthly fee × typical tenure, capped at 12 months; a one-off is its price", () => {
    expect(dealValue({ pricingModel: "retainer", price: 3500, tenureMonths: 18 }, 12)).toBe(42000);
    expect(dealValue({ pricingModel: "retainer", price: 4200, tenureMonths: 6 }, 12)).toBe(25200);
    expect(dealValue({ pricingModel: "retainer", price: 1000, tenureMonths: 18 }, 6)).toBe(6000);
    expect(dealValue({ pricingModel: "one_off", price: 9000, tenureMonths: 0 }, 12)).toBe(9000);
    expect(dealValue({ pricingModel: "hourly", price: 120, tenureMonths: 0 }, 12)).toBe(0);
    // A retainer that never churns is worth the cap.
    expect(dealValue({ pricingModel: "retainer", price: 1000, tenureMonths: 0 }, 12)).toBe(12000);
  });

  it("before signing, Northbeam's lead lost at Check fit is worth about 12% of a deal, and at Client decision about 32%", () => {
    const m = northbeamModel();
    // Qualify (Check fit) → Discovery 55% → Audit 70% → Client decision 32% → signed.
    expect(chanceToSign(m, "qualify")).toBeCloseTo(0.55 * 0.7 * 0.32, 10);
    expect(chanceToSign(m, "qualify")).toBeCloseTo(0.1232, 4);
    expect(chanceToSign(m, "decision")).toBeCloseTo(0.32, 10);
    expect(chanceToSign(m, "onboard")).toBeCloseTo(1, 10);
    const deal = averageDealValue(m, 12);
    expect(deal).toBe(3800 * 12);
    expect(lossValueAtStep(m, { id: "qualify" }, 12) / deal).toBeCloseTo(0.12, 2);
    expect(lossValueAtStep(m, { id: "decision" }, 12) / deal).toBeCloseTo(0.32, 10);
  });

  it("follows each service's own routing", () => {
    const m = northbeamWithServices();
    // Every kickoff branch leads to a win, so the services only differ in deal value.
    expect(chanceToSign(m, "qualify")).toBeCloseTo(0.1232, 4);
    const seo = 3500 * 12;
    const ppc = 4200 * 12;
    expect(averageDealValue(m, 12)).toBeCloseTo(0.55 * seo + 0.45 * ppc, 6);
  });

  it("a nested model gives the same chance to sign, and loss value, as the same model drawn flat", () => {
    const flat = northbeamModel();
    const inside = (id: string, parent: string, next?: EngineStep["next"]): EngineStep => ({ ...flat.steps.find((s) => s.id === id)!, parent, ...(next ? { next } : {}) });
    const nested: EngineModel = {
      ...flat,
      groups: {
        sales: { name: "Sales", entry: "qualify", next: [{ to: "audit", p: 0.7 }, { to: "lost", p: 0.3 }] },
        setup: { name: "Setup", entry: "seo", next: [{ to: "won", p: 1 }] },
      },
      steps: flat.steps.map((s) =>
        s.id === "qualify" ? inside("qualify", "sales") : s.id === "discovery" ? inside("discovery", "sales", []) : s.id === "seo" || s.id === "ppc" ? inside(s.id, "setup") : s.id === "live" ? inside("live", "setup", []) : s,
      ),
    };
    for (const s of flat.steps) {
      expect(chanceToSign(nested, s.id), s.id).toBeCloseTo(chanceToSign(flat, s.id), 12);
      expect(lossValueAtStep(nested, s, 12), s.id).toBeCloseTo(lossValueAtStep(flat, s, 12), 6);
    }
    expect(chanceToSign(nested, "qualify")).toBeCloseTo(0.1232, 4);
  });

  it("copes with loops: a step that sends half its items back still ends where its other half goes", () => {
    const m = line(5, [{ id: "a", next: [{ to: "a", p: 0.5 }, { to: "b", p: 0.5 }] }, { id: "b", next: [{ to: "won", p: 0.5 }, { to: "lost", p: 0.5 }] }]);
    expect(chanceToSign(m, "a")).toBeCloseTo(0.5, 9);
    expect(chanceToSign(m, "b")).toBeCloseTo(0.5, 9);
  });

  it("after signing, a churned client is worth its fee × the tenure it had left, capped at 12 months", () => {
    // Month 2 of a 22-month tenure: 20 months left, so the cap's 12. Month 20: 2 left.
    expect(remainingTenure(22, 2, 12)).toBe(12);
    expect(remainingTenure(22, 20, 12)).toBe(2);
    expect(churnLossValue(3000, 22, 2, 12)).toBe(36000);
    expect(churnLossValue(3000, 22, 20, 12)).toBe(6000);
    // Past its typical tenure there is nothing left to lose; a lower cap binds sooner.
    expect(remainingTenure(22, 30, 12)).toBe(0);
    expect(churnLossValue(3000, 22, 2, 6)).toBe(18000);
  });

  it("a roster client's loss value uses its service's tenure and the months it has been a client", () => {
    const m = northbeamWithServices();
    const client = { name: "C", services: ["seo"], mrr: 2000, assignments: {} };
    expect(clientLossValue(m, client, 12)).toBe(2000 * 12);
    // SEO's tenure is 18 months: 17 months in leaves 1.
    expect(clientLossValue(m, { ...client, monthsActive: 17 }, 12)).toBe(2000);
  });
});

describe("the cost of each insight", () => {
  it("waiting: items lost through 'lost per day of waiting' × what a loss is worth at that step", () => {
    const m = line(8, [{ id: "a", work: 4, lostPerDayWaiting: 0.05 }], { entry: "a" });
    const r = simulate(m, 12, 1);
    const issue = find(detectIssues(m, r, { ...NO_ESC, expectedWaitDays: { pipeline: 0.25 } }), "wait:step:a")!;
    expect(issue).toBeDefined();
    const st = r.steps.a!;
    const lostShare = Math.min(1, 0.05 * (st.avgWait / 8));
    const expected = (st.arrivals / 26) * WEEKS_PER_MONTH * lostShare * 12000;
    expect(issue.cost.perMonth).toBeCloseTo(expected, 6);
    expect(issue.cost.perMonth).toBeGreaterThan(0);
    expect(issue.cost.hoursPerMonth).toBeNull();
  });

  it("waiting with no 'lost per day' shows time, not money", () => {
    const m = line(8, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    const issue = find(detectIssues(m, r, { ...NO_ESC, expectedWaitDays: { pipeline: 0.25 } }), "wait:step:a")!;
    expect(issue.cost.perMonth).toBeNull();
    expect(issue.cost.hoursPerMonth).toBeCloseTo((r.steps.a!.arrivals / 26) * WEEKS_PER_MONTH * r.steps.a!.avgWait, 6);
    expect(issue.cost.method).toMatch(/^Time, not money/);
  });

  it("too busy: extra wins one more person would bring × deal value", () => {
    const m = line(9, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    const none = find(detectIssues(m, r, NO_ESC), "capacity:role:r")!;
    expect(none.cost.perMonth).toBeNull();
    // 3 extra wins a quarter = 1 a month × 12,000.
    const issue = find(detectIssues(m, r, NO_ESC, { shadowPrices: { r: 3 } }), "capacity:role:r")!;
    expect(issue.cost.perMonth).toBeCloseTo(((3 * WEEKS_PER_MONTH) / 13) * 12000, 6);
    // A lower cap lowers what a win is worth.
    const capped = find(detectIssues(m, r, NO_ESC, { shadowPrices: { r: 3 }, cost: { capMonths: 6 } }), "capacity:role:r")!;
    expect(capped.cost.perMonth).toBeCloseTo(((3 * WEEKS_PER_MONTH) / 13) * 6000, 6);
  });

  it("too busy: amounts in the descriptions carry the workspace currency", () => {
    const m = line(9, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    const issue = find(detectIssues(m, r, NO_ESC, { cost: { currency: "AUD" }, shadowPrices: { r: 3 } }), "capacity:role:r")!;
    expect(issue.cost.method).toContain("A$12,000");
    const rework = line(3, [{ id: "a", work: 4, rework: 0.3 }]);
    const rr = find(detectIssues(rework, simulate(rework, 12, 1), NO_ESC, { cost: { currency: "AUD" } }), "rework:step:a")!;
    expect(rr.cost.method).toContain("A$50 an hour");
  });

  it("too busy: when more capacity wouldn't add wins, it says so instead of '0 more wins'", () => {
    const m = line(9, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    const issue = find(detectIssues(m, r, NO_ESC, { shadowPrices: { r: 0 } }), "capacity:role:r")!;
    expect(issue.cost.perMonth).toBeNull();
    expect(issue.cost.method).toMatch(/wouldn't add wins/);
    expect(issue.cost.method).not.toMatch(/0 more wins/);
  });

  it("too busy: the shadow price counts wins only, in one time budget for every role", () => {
    const m = line(9, [{ id: "a", work: 4 }]);
    expect(shadowPricesFor(m, ["r"], { reps: 6, seed: 1 }).r).toBe(shadowPrice(m, "r", { reps: 6, seed: 1, count: "wins" })!.perQuarter.mean);
    // A budget already spent still runs one pair per role, and no more.
    let t = 0;
    const spent = shadowPricesFor(m, ["r"], { reps: 30, seed: 1, timeBudgetMs: 5, now: () => (t += 10) });
    expect(Object.keys(spent)).toEqual(["r"]);
  });

  it("too busy: the shadow price is the engine's extra run", () => {
    const m = line(9, [{ id: "a", work: 4 }]);
    const prices = shadowPricesFor(m, ["r", "r"], { reps: 6, seed: 1 });
    expect(Object.keys(prices)).toEqual(["r"]);
    expect(prices.r).toBeGreaterThan(0);
  });

  it("rework: repeated hours × cost rate", () => {
    const m = line(3, [{ id: "a", work: 4, rework: 0.3 }]);
    const r = simulate(m, 12, 1);
    const issue = find(detectIssues(m, r, NO_ESC), "rework:step:a")!;
    const hours = ((r.steps.a!.reworks * 4) / 26) * WEEKS_PER_MONTH;
    expect(issue.cost.hoursPerMonth).toBeCloseTo(hours, 6);
    expect(issue.cost.perMonth).toBeCloseTo(hours * 50, 6);
  });

  it("work piling up: the items added a month × what a loss is worth at that step", () => {
    const m = line(14, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    const issue = find(detectIssues(m, r, NO_ESC), "queue:step:a")!;
    expect(issue.cost.perMonth).toBeCloseTo(r.steps.a!.queueGrowth * WEEKS_PER_MONTH * 12000, 6);
  });

  it("overtime: overtime hours × cost rate", () => {
    const m = larkspurModel();
    const r = simulate(m, 12, 1);
    const ot = detectIssues(m, r, NO_ESC).filter((i) => i.key.startsWith("overtime:"));
    expect(ot.length).toBeGreaterThan(0);
    for (const i of ot) {
      // The rate: the person's own, else their roles' average; a role subject takes the role's.
      const person = i.personId ? m.people![i.personId]! : null;
      const own = person ? person.roles.filter((rid) => rid in m.roles) : [];
      const rate = person
        ? (person.cost ?? (own.length ? own.reduce((s, rid) => s + m.roles[rid]!.cost, 0) / own.length : 0))
        : m.roles[i.roleId!]!.cost;
      expect(i.cost.perMonth).toBeCloseTo(i.metrics.overtime_hours_week! * rate * WEEKS_PER_MONTH, 6);
      expect(i.metrics).not.toHaveProperty("overtime_cost");
    }
  });

  it("single point of failure: the damage of one absence x absences a year / 12", () => {
    const m = line(7, [{ id: "a", work: 4 }]);
    const absence = absenceTest(m, { seed: 1, weeks: 2 });
    const issue = find(detectIssues(m, simulate(m, 12, 1), NO_ESC, { absence }), "spof:step:a");
    expect(issue).toBeDefined();
    const f = absence.people[0]!;
    // 12,000 a deal (1,000 a month for the 12-month cap); the one step only they can do carries all of it.
    expect(issue!.cost.perMonth).toBeCloseTo((f.winsLost * 12000 * 2) / 12, 6);
    const more = find(detectIssues(m, simulate(m, 12, 1), NO_ESC, { absence, cost: { absencesPerYear: 4 } }), "spof:step:a")!;
    expect(more.cost.perMonth).toBeCloseTo(issue!.cost.perMonth! * 2, 6);
  });

  it("single point of failure: missed servicing tasks aren't priced as deals; only wins lost are", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 12, 1);
    const absence = absenceTest(m, { seed: 1, weeks: 2 });
    const deal = averageDealValue(m, 12);
    const issues = detectIssues(m, r, NO_ESC, { absence }).filter((i) => i.key.startsWith("spof:"));
    expect(issues.length).toBeGreaterThan(0);
    let some = false;
    for (const f of absence.people) {
      // Servicing tasks are in the items lost but aren't wins.
      if (f.itemsLost > f.winsLost + 1e-9) some = true;
      const mine = issues.filter((i) => i.personId === f.personId);
      const total = mine.reduce((sum, i) => sum + (i.cost.perMonth ?? 0), 0);
      if (mine.length) expect(total).toBeLessThanOrEqual((f.winsLost * deal * 2) / 12 + 1e-6);
    }
    expect(some).toBe(true);
  });

  it("single point of failure: no wins lost, only missed client tasks, is n/a rather than A$0", () => {
    const m = line(7, [{ id: "a", work: 4 }]);
    const absence = absenceTest(m, { seed: 1, weeks: 2 });
    const none = { ...absence, people: absence.people.map((f) => ({ ...f, winsLost: 0 })) };
    const issue = find(detectIssues(m, simulate(m, 12, 1), NO_ESC, { absence: none }), "spof:step:a")!;
    expect(issue.cost.perMonth).toBeNull();
    expect(issue.cost.method).toMatch(/missed client tasks/);
  });

  it("too busy: overtime that has its own insight isn't counted again", () => {
    const m = larkspurModel();
    const r = simulate(m, 12, 1);
    const issues = detectIssues(m, r, NO_ESC, { shadowPrices: Object.fromEntries(Object.keys(m.roles).map((id) => [id, 0])) });
    const overtime = issues.filter((i) => i.key.startsWith("overtime:"));
    expect(overtime.length).toBeGreaterThan(0);
    for (const o of overtime) {
      const busy = issues.find((i) => i.key.startsWith("capacity:") && (o.personId ? i.personId === o.personId : i.roleId === o.roleId));
      if (busy) expect(busy.cost.perMonth).toBeNull();
    }
  });

  it("missed deadlines: client work costs the churn it drives; a step that isn't client work has no money method", () => {
    const base = northbeamWithServicing();
    const servicing = servicingStepIds(base);
    // A tight SLA on every step, so servicing steps breach it and so does the pipeline.
    const m: EngineModel = { ...base, steps: base.steps.map((s) => ({ ...s, sla: 2 })) };
    const r = simulate(m, 12, 1);
    const issues = detectIssues(m, r, NO_ESC).filter((i) => i.key.startsWith("sla:"));
    const client = issues.filter((i) => servicing.has(i.stepId!));
    const other = issues.filter((i) => !servicing.has(i.stepId!));
    expect(client.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    for (const i of other) expect(i.cost.perMonth).toBeNull();
    // Excess churn (the simulated monthly churn above each client's base) x what losing it is worth, shared by each step's breaches.
    let excess = 0;
    for (const [cid, c] of Object.entries(m.clients!)) {
      const mean = c.services.reduce((sum, id) => sum + m.services![id]!.churnMonthly, 0) / c.services.length;
      excess += Math.max(0, r.clients![cid]!.churnMonthly.mean - mean) * clientLossValue(m, c, 12);
    }
    const total = [...servicing].reduce((sum, id) => sum + (r.steps[id]?.slaBreaches ?? 0), 0);
    for (const i of client) expect(i.cost.perMonth).toBeCloseTo(excess * (r.steps[i.stepId!]!.slaBreaches / total), 6);
    expect(client.reduce((sum, i) => sum + i.cost.perMonth!, 0)).toBeGreaterThan(0);
  });

  it("client groups: churn risk and missed deadlines are costed per group of unnamed clients", () => {
    const base = northbeamWithClientGroups();
    // Make them unhealthy so a group is a finding, and the servicing steps miss their deadlines.
    const m: EngineModel = {
      ...base,
      clientGroups: Object.fromEntries(Object.entries(base.clientGroups!).map(([id, g]) => [id, { ...g, health: 30 }])),
      steps: base.steps.map((s) => ({ ...s, sla: 2 })),
    };
    const r = simulate(m, 8, 1);
    const issues = detectIssues(m, r, NO_ESC);
    const groups = issues.filter((i) => i.key.startsWith("churn_risk:group:"));
    expect(groups.length).toBeGreaterThan(0);
    const grouped = withClientGroups(m);
    for (const i of groups) {
      const sid = i.key.split(":")[2]!;
      const members = Object.keys(r.clients!).filter((k) => groupServiceOf(k) === sid);
      const value = clientLossValue(grouped, grouped.clients![members[0]!]!, 12);
      expect(i.cost.perMonth).toBeCloseTo(Math.max(0, i.metrics.churn_monthly! - clientChurnMonthly(grouped, grouped.clients![members[0]!]!)) * members.length * value, 6);
      expect(i.cost.method).toMatch(/above the base rate/);
      expect(i.cost.perMonth).toBeGreaterThan(0);
    }
    const servicing = servicingStepIds(m);
    const sla = issues.filter((i) => i.key.startsWith("sla:") && servicing.has(i.stepId!));
    expect(sla.some((i) => (i.cost.perMonth ?? 0) > 0)).toBe(true);
  });

  it("spare time: idle hours at cost rates; too slow overall: revenue delayed; goals met: no money method", () => {
    const quiet = line(1, [{ id: "a", work: 2 }]);
    const rq = simulate(quiet, 8, 1);
    const spare = find(detectIssues(quiet, rq, NO_ESC), "spare:role:r")!;
    expect(spare.cost.hoursPerMonth).toBeCloseTo(spare.metrics.free_hours_week! * WEEKS_PER_MONTH, 6);
    expect(spare.cost.perMonth).toBeCloseTo(spare.cost.hoursPerMonth! * 50, 6);

    const slow: EngineModel = { ...line(3, [{ id: "a", work: 4 }], { churnMonthly: 0.05 }), targetCycleHours: 1 };
    const rs = simulate(slow, 8, 1);
    const cycle = detectIssues(slow, rs, NO_ESC).find((i) => i.key.startsWith("cycle:"))!;
    const monthsLate = (rs.kpi.cycle.mean - 1) / (40 * WEEKS_PER_MONTH);
    expect(cycle.cost.perMonth).toBeCloseTo(((rs.kpi.won.mean / 26) * WEEKS_PER_MONTH) * 1000 * monthsLate, 6);
  });

  it("churn risk: the churn above its base rate × what losing it is worth", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 12, 1);
    const issues = detectIssues(m, r).filter((i) => i.key.startsWith("churn_risk:client:"));
    for (const i of issues) {
      const client = m.clients![i.clientId!]!;
      expect(i.cost.perMonth).toBeCloseTo(Math.max(0, i.metrics.churn_monthly! - clientChurnMonthly(m, client)) * clientLossValue(m, client, 12), 6);
      expect(i.cost.method).toMatch(/above its base rate/);
    }
  });

  it("every insight has a cost with a method, and money is never negative", () => {
    const m = northbeamWithServicing();
    for (const i of detectIssues(m, simulate(m, 8, 1))) {
      expect(i.cost.method.length).toBeGreaterThan(0);
      expect(i.cost.perMonth === null || i.cost.perMonth >= 0).toBe(true);
    }
  });
});

describe("order", () => {
  it("sorts by rating, then cost, highest first", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 12, 1);
    const roles = Object.keys(m.roles);
    const issues = detectIssues(m, r, {}, { shadowPrices: shadowPricesFor(m, roles, { reps: 6, seed: 1 }) });
    expect(issues.length).toBeGreaterThan(3);
    const RANK = { risk: 0, bad: 1, good: 2, great: 3 } as const;
    for (let i = 1; i < issues.length; i++) {
      const a = issues[i - 1]!;
      const b = issues[i]!;
      expect(RANK[a.rating]).toBeLessThanOrEqual(RANK[b.rating]);
      if (a.rating === b.rating) expect(compareCostsDesc(a.cost, b.cost)).toBeLessThanOrEqual(0);
    }
  });

  it("puts the costlier issue first within a rating", () => {
    const m = line(14, [{ id: "a", work: 4 }, { id: "b", work: 1, rework: 0.3 }]);
    const r = simulate(m, 12, 1);
    const issues = detectIssues(m, r, NO_ESC);
    const same = issues.filter((i) => i.rating === issues[0]!.rating);
    const costs = same.map((i) => i.cost.perMonth ?? -1);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("costs money first, then time, then nothing", () => {
    const money = { perMonth: 5, hoursPerMonth: null, method: "" };
    const time = { perMonth: null, hoursPerMonth: 9, method: "" };
    const none = { perMonth: null, hoursPerMonth: null, method: "" };
    expect([none, time, money].sort(compareCostsDesc)).toEqual([money, time, none]);
  });

  it("a pay-hidden cost sorts as no cost: level with it, and below any money or time cost (B1 2b)", () => {
    const money = { perMonth: 5, hoursPerMonth: null, method: "" };
    const time = { perMonth: null, hoursPerMonth: 9, method: "" };
    const none = noCost("n/a");
    const hidden = payHiddenCost();
    expect(compareCostsDesc(hidden, none)).toBe(0);
    expect(compareCostsDesc(none, hidden)).toBe(0);
    expect(compareCostsDesc(hidden, time)).toBeGreaterThan(0);
    expect(compareCostsDesc(hidden, money)).toBeGreaterThan(0);
    expect(compareCostsDesc(money, hidden)).toBeLessThan(0);
    // Whatever order they arrive in, a stable sort keeps hidden and none in the order given.
    expect([hidden, money, none, time].sort(compareCostsDesc)).toEqual([money, time, hidden, none]);
    expect([none, hidden, time, money].sort(compareCostsDesc)).toEqual([money, time, none, hidden]);
  });
});
