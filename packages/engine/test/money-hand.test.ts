import { describe, expect, it } from "vitest";
import { runOnce, simulate, type EngineClient, type EngineModel, type EngineService } from "../src";

// Profit (engine 1.11.0) checked by hand (a fee bills fee / 4.33 a week, as `billed` always has) on tiny deterministic models: one person, constant times, no leads unless
// said. Every expected number below is worked out from the inputs, not read off the engine.

const HPW = 40;

const svc = (pricingModel: EngineService["pricingModel"], price: number, extra: Partial<EngineService> = {}): EngineService => ({
  name: pricingModel,
  pricingModel,
  price,
  margin: 0,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  ...extra,
});

/** One person (Ann, 40 h a week at 50 an hour), no leads, no churn, no warm-up. */
function tiny(extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 13,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "R", count: 1, cost: 50, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["r"], capacity: HPW } },
    entry: "s",
    sinks: { won: "won", lost: "lost" },
    steps: [{ id: "s", name: "S", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] }],
    ...extra,
  };
}

const named = (mrr: number, services: string[] = ["ret"]): EngineClient => ({ name: "Acme", services, mrr, assignments: { r: "ann" } });

describe("hand-checked: one named retainer client", () => {
  // Fee 4,330 a month = 1,000 a week. 13 weeks. Ann 40 h × 50 = 2,000 a week. Overheads 1,000 a month.
  const m = tiny({ services: { ret: svc("retainer", 4330) }, clients: { c: named(4330) }, overheadMonthly: 1000 });

  it("revenue, labour, overheads and profit over the run", () => {
    const r = simulate(m, 3, 1);
    expect(r.kpi.revenue.mean).toBeCloseTo(13_000, 6);
    expect(r.kpi.billed.mean).toBeCloseTo(13_000, 6);
    expect(r.kpi.labourCost!.mean).toBeCloseTo(26_000, 6);
    expect(r.kpi.overheads).toBeCloseTo(3_000, 9); // 1,000 × 13 / (52/12)
    expect(r.kpi.overtimeCost!.mean).toBe(0);
    expect(r.kpi.profit!.mean).toBeCloseTo(13_000 - 26_000 - 3_000, 6);
    expect(r.kpi.profit!.p10).toBeCloseTo(-16_000, 6);
    expect(r.kpi.profit!.p90).toBeCloseTo(-16_000, 6);
  });

  it("month by month: three 52/12-week months", () => {
    const mo = simulate(m, 2, 1, { monthly: true }).monthly!;
    expect(mo.months).toHaveLength(3);
    const wk = 52 / 12;
    for (let i = 0; i < 3; i++) {
      expect(mo.revenue.recurring[i]!.mean).toBeCloseTo(1000 * wk, 6);
      expect(mo.revenue.total[i]!.mean).toBeCloseTo(1000 * wk, 6);
      expect(mo.revenue.fromNew[i]!.mean).toBe(0);
      expect(mo.money!.labour[i]).toBeCloseTo(2000 * wk, 6);
      expect(mo.money!.overheads[i]).toBeCloseTo(1000, 6);
      expect(mo.money!.profit[i]!.mean).toBeCloseTo(1000 * wk - 2000 * wk - 1000, 6);
    }
  });

  it("partial calendar months: everything pro rata by the hours of the month", () => {
    // Months starting at hours 0, 100 and 300 (2.5 weeks, 5 weeks, the remaining 5.5 weeks).
    const mo = simulate(m, 2, 1, { monthly: true, monthStarts: [0, 100, 300] }).monthly!;
    const weeks = [2.5, 5, 5.5];
    weeks.forEach((w, i) => {
      expect(mo.revenue.recurring[i]!.mean).toBeCloseTo(1000 * w, 6);
      expect(mo.money!.labour[i]).toBeCloseTo(2000 * w, 6);
      expect(mo.money!.overheads[i]).toBeCloseTo((1000 * w * 12) / 52, 6);
    });
  });

  it("a client churning mid-month bills to its tick and its fee is lost in the tick's month", () => {
    // Certain churn at the first weekly tick (t = 40); months start at 0 and 40, so the tick closes month 0.
    const churny = { ...m, services: { ret: svc("retainer", 4330, { churnMonthly: 50 }) } };
    const r = runOnce(churny, 1, false);
    expect(r.clientsChurned).toBe(1);
    expect(r.revenue.recurring).toBeCloseTo(1000, 6);
    const mo = simulate(churny, 1, 1, { monthly: true, monthStarts: [0, 40, 200] }).monthly!;
    expect(mo.clientsLost[0]!.mean).toBe(1);
    expect(mo.revenue.lostToChurn[0]!.mean).toBeCloseTo(4330, 6);
    expect(mo.clientsLost[1]!.mean).toBe(0);
    expect(mo.revenue.recurring[0]!.mean).toBeCloseTo(1000, 6);
    expect(mo.revenue.recurring[1]!.mean).toBe(0);
  });
});

describe("hand-checked: one-off jobs", () => {
  it("bill their price at the win, once, in the month won", () => {
    // 5 items of work in progress at s (1 h each, Ann alone): won at t = 1, 2, 3, 4, 5.
    const m = tiny({ services: { job: svc("one_off", 2500) }, overheadMonthly: 0 });
    m.steps = [{ ...m.steps[0]!, currentWip: 5 }];
    const r = simulate(m, 2, 1, { monthly: true });
    expect(r.kpi.won.mean).toBe(5);
    expect(r.kpi.revenue.mean).toBeCloseTo(12_500, 6);
    expect(r.kpi.billed.mean).toBeCloseTo(12_500, 6);
    const mo = r.monthly!;
    expect(mo.revenue.oneOff[0]!.mean).toBeCloseTo(12_500, 6);
    expect(mo.revenue.fromNew[0]!.mean).toBeCloseTo(12_500, 6);
    expect(mo.revenue.recurring[0]!.mean).toBe(0);
    expect(mo.clientsWon[0]!.mean).toBe(0);
    expect(mo.sales.won[0]!.mean).toBe(5);
    expect(mo.sales.conversion[0]!.mean).toBe(1);
    expect(r.kpi.profit!.mean).toBeCloseTo(12_500 - 13 * 2000, 6);
  });
});

describe("hand-checked: hourly", () => {
  it("a won hourly client bills its fallback hours from the win, at the rate, and the onboarding step", () => {
    // 2 items at s (1 h each) won at t = 1 and 2, each then carrying 8.66 h a month = 2 h a week of fallback work.
    // A named client on a retainer (fee 433 = 100 a week) makes it a roster model.
    const m = tiny({ services: { h: svc("hourly", 100, { fallbackOngoing: { r: 8.66 } }), ret: svc("retainer", 433, { mixShare: 0 }) }, clients: { c: named(433) } });
    m.steps = [{ ...m.steps[0]!, currentWip: 2 }];
    const r = runOnce(m, 1, false);
    const H = 13 * HPW;
    const hours = (2 * (H - 1)) / HPW + (2 * (H - 2)) / HPW; // no post-sale steps: the selling hour isn't billed
    expect(r.won).toBe(2);
    expect(r.hourly.h!.hours).toBeCloseTo(hours, 9);
    expect(r.revenue.hourly).toBeCloseTo(hours * 100, 6);
    expect(r.revenue.fromNew).toBeCloseTo(hours * 100, 6);
    expect(r.revenue.recurring).toBeCloseTo(1300, 6);
    expect(r.billed).toBeCloseTo(1300, 6);
  });

  it("an existing client on an hourly service bills its fee, not hours", () => {
    const m = tiny({ services: { h: svc("hourly", 100, { fallbackOngoing: { r: 8.66 } }) }, clients: { c: named(4330, ["h"]) } });
    const r = runOnce(m, 1, false);
    expect(r.revenue.recurring).toBeCloseTo(13_000, 6);
    expect(r.revenue.hourly).toBe(0);
    expect(r.hourly.h!.hours).toBe(0);
  });
});

describe("hand-checked: staffing", () => {
  it("a hire from mid-month 2 and a leaver at mid-month 2 are paid only while on the team; leave is paid", () => {
    // Months of exactly 160 h (4 weeks). Bob joins at 200 (mid month 2), Cy leaves at 260 (mid month 2), Ann is on leave for a week.
    const m = tiny({
      horizonWeeks: 12,
      people: {
        ann: { name: "Ann", roles: ["r"], capacity: HPW, leave: [[40, 80]] },
        bob: { name: "Bob", roles: ["r"], capacity: 20, cost: 30, from: 200 },
        cy: { name: "Cy", roles: ["r"], capacity: HPW, cost: 70, until: 260 },
      },
    });
    const r = simulate(m, 2, 1, { monthly: true, monthStarts: [0, 160, 320] });
    const ann = 12 * 40 * 50;
    const bob = ((480 - 200) / 40) * 20 * 30;
    const cy = (260 / 40) * 40 * 70;
    expect(r.kpi.labourCost!.mean).toBeCloseTo(ann + bob + cy, 6);
    const by = r.monthly!.money!.labourByPerson;
    expect(by.ann).toEqual([8000, 8000, 8000].map((v) => expect.closeTo(v, 6)));
    expect(by.bob![0]).toBe(0);
    expect(by.bob![1]).toBeCloseTo((120 / 40) * 20 * 30, 6);
    expect(by.bob![2]).toBeCloseTo(4 * 20 * 30, 6);
    expect(by.cy![1]).toBeCloseTo((100 / 40) * 40 * 70, 6);
    expect(by.cy![2]).toBe(0);
  });
});

describe("hand-checked: pooled", () => {
  it("interim clients bill the retainer while active, decaying with churn at each weekly tick", () => {
    // 10 clients at 4,330 (1,000 a week); churn 43.3% a month = 10% a week, applied at t = 40, 80, ...
    const m = tiny({ activeClients: 10, retainer: 4330, churnMonthly: 0.433, horizonWeeks: 4 });
    const r = runOnce(m, 1, false);
    let expected = 0;
    let n = 10;
    for (let w = 0; w < 4; w++) {
      expected += n * 1000;
      n *= 0.9;
    }
    expect(r.revenue.recurring).toBeCloseTo(expected, 6);
    expect(r.billed).toBe(0);
    const mo = simulate(m, 1, 1, { monthly: true, monthStarts: [0, 80] }).monthly!;
    expect(mo.revenue.recurring[0]!.mean).toBeCloseTo(10_000 + 9_000, 6);
    // Lost at the ticks at 40 (month 0) and 80 (closes month 0), and 120 (month 1).
    expect(mo.revenue.lostToChurn[0]!.mean).toBeCloseTo(4330 * (1 + 0.9), 6);
    expect(mo.clientsLost[0]!.mean).toBeCloseTo(1 + 0.9, 9);
  });
});

describe("hand-checked: pooled hourly", () => {
  it("a won hourly client bills the roles' ongoing hours a week from its win", () => {
    const m = tiny({ roles: { r: { name: "R", count: 1, cost: 50, ongoing: 2 } }, services: { h: svc("hourly", 100) } });
    m.steps = [{ ...m.steps[0]!, currentWip: 2 }];
    const r = runOnce(m, 1, false);
    const H = 13 * HPW;
    const hours = (2 * (H - 1)) / HPW + (2 * (H - 2)) / HPW;
    expect(r.won).toBe(2);
    expect(r.hourly.h!.hours).toBeCloseTo(hours, 9);
    expect(r.revenue.hourly).toBeCloseTo(hours * 100, 6);
    expect(r.revenue.recurring).toBe(0);
  });
});
