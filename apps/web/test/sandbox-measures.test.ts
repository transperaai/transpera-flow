import { describe, expect, it } from "vitest";
import { DEFAULT_PURPOSES, northbeamBundle, toEngineModel } from "@transpera-flow/db";
import { simulate, toRatingConfig, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { atRiskLast, churnRate, clientsLost, monthProfit, peakBusy, purposeShare, tooBusyMonths, tornadoValue, totalProfit } from "@/lib/sandbox/measures";

// What goal seek and the tornado read from a run's months (sandbox phase 5b), on fabricated months (exact) and on a real run (shape).

const st = (mean: number, p10 = mean - 1, p90 = mean + 1): Stat => ({ mean, p10, p90 }) as Stat;
const busy = (mean: number, p90: number): MonthBusy => ({ mean, p10: mean - 0.1, p90, capacity: 40, work: 30 }) as MonthBusy;
const months = (n: number) => Array.from({ length: n }, (_, i) => ({ start: i * 100, end: (i + 1) * 100 }));
const fake = (over: Partial<MonthlyResult>): MonthlyResult =>
  ({
    months: months(3),
    roles: { a: [busy(0.5, 0.7), busy(0.8, 0.9), busy(0.6, 0.97)], b: [null, busy(0.9, 0.95), busy(0.4, 0.5)] },
    uncovered: { a: [null, null, null], b: [null, null, null] },
    clients: { s1: [st(10), st(10), st(10)], "": [st(0), st(0), st(0)] },
    clientsLost: [st(0.3), st(0.3), st(0.3)],
    atRisk: { s1: [st(1), st(2), st(3)], s2: [st(0), st(1), st(2)] },
    money: { labour: [1, 1, 1], labourByRole: {}, labourByPerson: {}, overtimeCost: [st(0), st(0), st(0)], overheads: [1, 1, 1], profit: [st(100, 80, 120), st(-50, -90, 0), st(200, 150, 260)] },
    ...over,
  }) as unknown as MonthlyResult;

describe("the measures, on fabricated months", () => {
  const m = fake({});
  it("peak busy: the highest month of any role or one role, on the average or in 9 of 10 runs", () => {
    expect(peakBusy(m)).toBeCloseTo(0.9);
    expect(peakBusy(m, { roleId: "a" })).toBeCloseTo(0.8);
    expect(peakBusy(m, { roleId: null, nines: true })).toBeCloseTo(0.97);
    expect(peakBusy(m, { roleId: "b", nines: true })).toBeCloseTo(0.95);
    expect(peakBusy(m, { roleId: "gone" })).toBeNull();
    // Work with nobody there to do it counts as 100%, in the month it happens (and as too busy).
    const gap = fake({ uncovered: { a: [null, null, null], b: [4, null, null] } });
    expect(peakBusy(gap, { roleId: "b" })).toBe(1);
    expect(peakBusy(gap, { roleId: "a" })).toBeCloseTo(0.8);
    expect(tooBusyMonths(gap, [0.7, 0.85, 0.95])).toBe(2);
  });
  it("churn: clients lost over client-months, a ratio of means", () => {
    expect(clientsLost(m)).toBeCloseTo(0.9);
    expect(churnRate(m)).toBeCloseTo(0.9 / 30);
    expect(churnRate(fake({ clients: {} }))).toBeNull();
  });
  it("profit: over the run, in a month on the average or a bad month; none without costs", () => {
    expect(totalProfit(m)).toBeCloseTo(250);
    expect(monthProfit(m, 1)).toBe(-50);
    expect(monthProfit(m, 1, true)).toBe(-90);
    expect(monthProfit(m, 7)).toBeNull();
    const none = fake({ money: null });
    expect(totalProfit(none)).toBeNull();
    expect(monthProfit(none, 0)).toBeNull();
  });
  it("clients at risk in the last month, summed over groups; null without a roster", () => {
    expect(atRiskLast(m)).toBe(5);
    expect(atRiskLast(fake({ atRisk: {} }))).toBeNull();
  });
  it("months too busy: any role over the line on its average", () => {
    expect(tooBusyMonths(m, [0.7, 0.85, 0.95])).toBe(1);
    expect(tooBusyMonths(m, [0.3, 0.55, 0.95])).toBe(2);
  });
  it("tornadoValue dispatches, and a purpose measure needs a key from the list", () => {
    const o = { cutoffs: [0.7, 0.85, 0.95] as const, categories: DEFAULT_PURPOSES };
    expect(tornadoValue("profit", m, o)).toBeCloseTo(250);
    expect(tornadoValue("lost", m, o)).toBeCloseTo(0.9);
    expect(tornadoValue("purpose", m, o)).toBeNull();
  });
});

describe("on a real run", () => {
  const bundle = northbeamBundle();
  const model = { ...toEngineModel(bundle, { startDate: "2026-11-02", planned: true, purposes: true }), horizonWeeks: 13 };
  const monthly = simulate(model, 3, 1, { monthly: true }).monthly!;
  const cutoffs = toRatingConfig(ANALYSIS_DEFAULTS, bundle.workspace.settings.hours_per_week).rules.busy.cutoffs;
  it("every measure is a number in its range", () => {
    expect(peakBusy(monthly)).toBeGreaterThan(0);
    expect(churnRate(monthly)).toBeGreaterThanOrEqual(0);
    expect(churnRate(monthly)!).toBeLessThan(1);
    expect(tooBusyMonths(monthly, cutoffs)).toBeLessThanOrEqual(monthly.months.length);
    expect(totalProfit(monthly)).not.toBeNull();
    const share = purposeShare(monthly, DEFAULT_PURPOSES, "fixing");
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThanOrEqual(0);
    expect(share!).toBeLessThanOrEqual(1);
    expect(purposeShare(monthly, DEFAULT_PURPOSES, "not-a-key")).toBeNull();
  });
});
