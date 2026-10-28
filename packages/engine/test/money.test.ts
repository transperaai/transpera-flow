import { describe, expect, it } from "vitest";
import { SEED_STRIDE, northbeamModel, northbeamWithClientGroups, runOnce, simulate, type EngineModel, type EnginePerson, type EngineService } from "../src";

// Profit first (engine 1.11.0, sandbox phase 2): paid labour, overheads, profit and the monthly money series.

const HPW = 40;
const MONTH = (52 / 12) * HPW;
const months = (n: number) => Math.round((n * 52) / 12);

/** Northbeam with named people (one per head-count), cost rates from the roles, and `extra` people or changes. */
function named(extra: Record<string, Partial<EnginePerson>> = {}, weeks = months(12)): EngineModel {
  const base = northbeamModel();
  const people: Record<string, EnginePerson> = {};
  for (const [rid, role] of Object.entries(base.roles)) {
    for (let i = 1; i <= role.count; i++) people[`${rid}-${i}`] = { name: `${role.name} ${i}`, roles: [rid], capacity: HPW };
  }
  for (const [id, p] of Object.entries(extra)) people[id] = { name: id, roles: [], capacity: HPW, ...people[id], ...p };
  return { ...base, horizonWeeks: weeks, people };
}

/** Role-count model's total payroll a week: head-count × hours × cost. */
const payroll = (m: EngineModel) => Object.values(m.roles).reduce((a, r) => a + r.count * HPW * r.cost, 0);

/** One person in two roles on 50 and 70 an hour, with more client work than their week: they work overtime. */
function overloaded(extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 10,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 30,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    overtimeCap: 0.25,
    roles: { a: { name: "A", count: 1, cost: 50, ongoing: 1.5 }, b: { name: "B", count: 1, cost: 70, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["a", "b"], capacity: HPW } },
    entry: "s",
    sinks: { won: "won", lost: "lost" },
    steps: [{ id: "s", name: "S", role: "a", work: 1, wait: 0, rework: 0, next: [{ to: "won", p: 1 }] }],
    ...extra,
  };
}

describe("labour cost: paid hours times rate", () => {
  it("a constant team is paid capacity x weeks x rate, overtime excluded", () => {
    const m = named({}, months(6));
    const r = simulate(m, 5, 1);
    expect(r.kpi.labourCost!.mean).toBeCloseTo(payroll(m) * months(6), 6);
    expect(r.kpi.labourCost!.p10).toBe(r.kpi.labourCost!.p90);
  });

  it("a role-count model is covered by the people the engine synthesises", () => {
    const m = { ...northbeamModel(), horizonWeeks: months(3) };
    expect(simulate(m, 3, 1).kpi.labourCost!.mean).toBeCloseTo(payroll(m) * months(3), 6);
  });

  it("a person with their own cost is paid at it, and the mean of their roles' otherwise", () => {
    const r = simulate(named({ "seo-1": { cost: 100 } }, 10), 3, 1);
    const base = payroll(named({}, 10)) * 10;
    expect(r.kpi.labourCost!.mean).toBeCloseTo(base + HPW * 10 * (100 - 50), 6);
    const two = simulate(overloaded(), 2, 1);
    expect(two.kpi.labourCost!.mean).toBeCloseTo(HPW * 10 * 60, 6);
  });

  it("a hire is paid from their first hour, month by month and in total", () => {
    const start = 2 * MONTH + 100;
    const m = named({ "ppc-3": { roles: ["ppc"], from: start } });
    const r = simulate(m, 4, 1, { monthly: true });
    const bare = named();
    const weeksPaid = (m.horizonWeeks * HPW - start) / HPW;
    expect(r.kpi.labourCost!.mean).toBeCloseTo(payroll(bare) * m.horizonWeeks + weeksPaid * HPW * 50, 6);
    const hire = r.monthly!.money!.labourByPerson["ppc-3"]!;
    expect(hire[0]).toBe(0);
    expect(hire[1]).toBe(0);
    expect(hire[2]).toBeCloseTo((HPW * 50 * (3 * MONTH - start)) / HPW, 6);
    expect(hire[3]).toBeCloseTo(HPW * 50 * (MONTH / HPW), 6);
    // The months add up to the run.
    expect(r.monthly!.money!.labour.reduce((a, b) => a + b, 0)).toBeCloseTo(r.kpi.labourCost!.mean, 6);
  });

  it("leave is still paid", () => {
    const base = simulate(named({}, months(6)), 3, 1);
    const away = simulate(named({ "seo-1": { leave: [[200, 500]] } }, months(6)), 3, 1, { monthly: true });
    expect(away.kpi.labourCost!.mean).toBeCloseTo(base.kpi.labourCost!.mean, 6);
    const person = away.monthly!.money!.labourByPerson["seo-1"]!;
    expect(person[0]).toBeCloseTo(HPW * 50 * (MONTH / HPW), 6);
  });

  it("a leaver stops being paid at their end date", () => {
    const until = 3 * MONTH;
    const r = simulate(named({ "am-2": { until } }), 3, 1, { monthly: true });
    const bare = named();
    expect(r.kpi.labourCost!.mean).toBeCloseTo(payroll(bare) * bare.horizonWeeks - (HPW * 55 * (bare.horizonWeeks * HPW - until)) / HPW, 6);
    const person = r.monthly!.money!.labourByPerson["am-2"]!;
    expect(person[2]).toBeGreaterThan(0);
    expect(person[3]).toBe(0);
    expect(person[11]).toBe(0);
  });

  it("splits each person's cost evenly over their roles, and the roles add up to the total", () => {
    const r = simulate(overloaded(), 2, 1, { monthly: true });
    const money = r.monthly!.money!;
    expect(money.labourByRole.a![0]).toBeCloseTo(money.labourByRole.b![0]!, 9);
    for (let m = 0; m < money.labour.length; m++) expect(money.labourByRole.a![m]! + money.labourByRole.b![m]!).toBeCloseTo(money.labour[m]!, 9);
  });

  it("uses the same rate as overtime", () => {
    const r = simulate(overloaded(), 3, 1);
    expect(r.kpi.overtimeHours.mean).toBeCloseTo(5 * 10, 6);
    expect(r.kpi.overtimeCost!.mean / r.kpi.overtimeHours.mean).toBeCloseTo(60, 9);
    expect(r.kpi.labourCost!.mean / (HPW * 10)).toBeCloseTo(60, 9);
    // Monthly overtime hours and cost agree with it too.
    const mo = simulate(overloaded(), 3, 1, { monthly: true }).monthly!;
    mo.overtimeHours.forEach((s, i) => expect(mo.money!.overtimeCost[i]!.mean).toBeCloseTo(s.mean * 60, 6));
  });
});

describe("overheads", () => {
  it("12 months of a 52-week run cost exactly 12 times the figure, month by month too", () => {
    const m = { ...named({}, 52), overheadMonthly: 18000 };
    const r = simulate(m, 3, 1, { monthly: true });
    expect(r.kpi.overheads).toBe(216_000);
    expect(r.monthly!.money!.overheads.reduce((a, b) => a + b, 0)).toBeCloseTo(216_000, 6);
    expect(r.monthly!.money!.overheads[0]).toBeCloseTo(18000, 6);
  });

  it("none unless set", () => {
    const r = simulate(named({}, 13), 2, 1, { monthly: true });
    expect(r.kpi.overheads).toBe(0);
    expect(r.monthly!.money!.overheads.every((v) => v === 0)).toBe(true);
  });
});

describe("profit", () => {
  it("is revenue less labour, overtime and overheads in every replication", () => {
    for (const m of [{ ...northbeamWithClientGroups(), overheadMonthly: 9000 }, overloaded({ overheadMonthly: 500 })]) {
      const res = simulate(m, 6, 4, { monthly: true });
      res.samples.profit!.forEach((p, i) => {
        const run = runOnce(m, 4 + i * SEED_STRIDE, false);
        expect(run.profit).toBeCloseTo(p, 6);
        expect(p).toBeCloseTo(res.samples.revenue[i]! - run.labourCost! - run.overtimeCost! - run.overheads, 6);
        expect(run.revenue.recurring + run.revenue.oneOff + run.revenue.hourly).toBeCloseTo(res.samples.revenue[i]!, 6);
      });
    }
  });

  it("per month is the spread of each replication's own profit", () => {
    const m = { ...overloaded({ overheadMonthly: 500 }), horizonWeeks: months(3) };
    const mo = simulate(m, 4, 1, { monthly: true }).monthly!;
    mo.money!.profit.forEach((p, i) => {
      const expected = mo.revenue.total[i]!.mean - mo.money!.labour[i]! - mo.money!.overtimeCost[i]!.mean - mo.money!.overheads[i]!;
      expect(p.mean).toBeCloseTo(expected, 6);
    });
  });
});

describe("pay privacy", () => {
  it("payHidden gives no labour, overtime cost or profit, the same revenue, and still the overheads", () => {
    const m = { ...overloaded({ overheadMonthly: 500 }), horizonWeeks: months(3), retainer: 1000 };
    const open = simulate(m, 4, 1, { monthly: true });
    const hidden = simulate({ ...m, payHidden: true }, 4, 1, { monthly: true });
    expect(hidden.kpi.labourCost).toBeNull();
    expect(hidden.kpi.overtimeCost).toBeNull();
    expect(hidden.kpi.profit).toBeNull();
    expect(hidden.samples.profit).toBeNull();
    expect(hidden.monthly!.money).toBeNull();
    expect(hidden.kpi.overheads).toBe(open.kpi.overheads);
    expect(hidden.kpi.overheads).toBeGreaterThan(0);
    expect(hidden.kpi.revenue).toEqual(open.kpi.revenue);
    expect(hidden.monthly!.revenue).toEqual(open.monthly!.revenue);
    expect(hidden.monthly!.overtimeHours).toEqual(open.monthly!.overtimeHours);
    expect(open.kpi.profit).not.toBeNull();
    expect(open.monthly!.money).not.toBeNull();
  });
});

describe("sales and revenue series", () => {
  it("conversion is won over won plus lost, as a ratio of sums", () => {
    const m = { ...northbeamWithClientGroups(), horizonWeeks: months(6) };
    const res = simulate(m, 12, 2, { monthly: true });
    const mo = res.monthly!;
    mo.sales.conversion.forEach((c, i) => {
      const won = mo.sales.won[i]!.mean;
      const lost = mo.sales.lost[i]!.mean;
      expect(c.mean).toBeCloseTo(won + lost > 0 ? won / (won + lost) : 0, 9);
    });
    // Months add up to the run's counts.
    expect(mo.sales.won.reduce((a, s) => a + s.mean, 0)).toBeCloseTo(res.kpi.won.mean, 9);
    expect(mo.sales.lost.reduce((a, s) => a + s.mean, 0)).toBeCloseTo(res.kpi.lost.mean, 9);
    expect(mo.sales.opportunities.reduce((a, s) => a + s.mean, 0)).toBeCloseTo(Object.values(res.kpi.services).reduce((a, s) => a + s.arrivals.mean, 0), 9);
  });

  it("an hourly service whose clients generate no work earns nothing, and says 0 hours", () => {
    const svc = (pricingModel: EngineService["pricingModel"], price: number, mixShare: number): EngineService => ({ name: pricingModel, pricingModel, price, margin: 0, tenureMonths: 12, churnMonthly: 0, mixShare, pathTags: [] });
    const m = { ...northbeamModel(), horizonWeeks: months(3), services: { r: svc("retainer", 2000, 1), h: svc("hourly", 90, 1) } };
    // Roles have no ongoing hours, so the pooled hourly clients take none.
    const quiet = { ...m, roles: Object.fromEntries(Object.entries(m.roles).map(([id, r]) => [id, { ...r, ongoing: 0 }])) };
    const r = simulate(quiet, 5, 1);
    expect(r.kpi.won.mean).toBeGreaterThan(0);
    expect(r.kpi.hourly.h!.hours.mean).toBe(0);
    expect(r.kpi.hourly.h!.revenue.mean).toBe(0);
    expect(r.kpi.revenueHourly.mean).toBe(0);
  });
});
