import { describe, expect, it } from "vitest";
import { firstCrossing, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { capacityLine, capacityRunsOut, paybackLine, paybackMonth } from "@/lib/sandbox/timing";
import { hireChanges } from "@/components/sandbox/timing";

// "When" (sandbox phase 5a, docs/plans/sandbox-p5-brief.md §6.4): the month capacity runs out, and the month a hire pays for itself. Pure.

const CUTOFFS = [0.7, 0.85, 0.95] as const;
const busy = (mean: number): MonthBusy => ({ mean, p10: mean - 0.05, p90: mean + 0.05, capacity: 40, work: 40 * mean });
const profit = (...v: number[]): Stat[] => v.map((m) => ({ mean: m, p10: m - 100, p90: m + 100 }));
const months = ["Oct 2026", "Nov 2026", "Dec 2026", "Jan 2027", "Feb 2027", "Mar 2027"].map((long) => ({ long }));
const monthly = (roles: Record<string, (MonthBusy | null)[]>, uncovered: Record<string, (number | null)[]> = {}): MonthlyResult => ({ roles, uncovered }) as unknown as MonthlyResult;

describe("capacityRunsOut", () => {
  it("is the earliest month any role's average passes the Too busy line, the same crossing the alerts use", () => {
    const m = monthly({ design: [0.5, 0.6, 0.7, 0.88, 0.9, 0.9].map(busy), ppc: [0.4, 0.5, 0.86, 0.9, 0.9, 0.9].map(busy) });
    const out = capacityRunsOut(m, { design: "Designers", ppc: "PPC specialists" }, CUTOFFS)!;
    expect(out).toMatchObject({ month: 2, roleId: "ppc", roleName: "PPC specialists", kind: "busy" });
    expect(out.month).toBe(firstCrossing(m.roles.ppc!, CUTOFFS).average!.month);
    expect(out.value).toBeCloseTo(0.86);
  });

  it("is null when no role crosses, and a role with nobody there never does", () => {
    const m = monthly({ design: [0.5, 0.6, 0.7, 0.7, 0.6, 0.6].map(busy), idle: [null, null, null, null, null, null] });
    expect(capacityRunsOut(m, {}, CUTOFFS)).toBeNull();
  });

  it("counts the first month with work and nobody there to do it, and takes whichever is earlier", () => {
    const m = monthly({ design: [0.5, 0.6, 0.7, 0.9, 0.9, 0.9].map(busy) }, { design: [null, null, 6, null, null, null] });
    expect(capacityRunsOut(m, { design: "Designers" }, CUTOFFS)).toMatchObject({ month: 2, kind: "uncovered", value: 6 });
    const later = monthly({ design: [0.5, 0.88, 0.9, 0.9, 0.9, 0.9].map(busy) }, { design: [null, null, null, null, 4, null] });
    expect(capacityRunsOut(later, {}, CUTOFFS)).toMatchObject({ month: 1, kind: "busy" });
  });
});

describe("capacityLine", () => {
  it("says the month and the role, and that it is on average", () => {
    expect(capacityLine({ month: 5, roleId: "d", roleName: "Designers", kind: "busy", value: 0.88 }, months, "12 months")).toBe("Capacity runs out in Mar 2027: Designers are 88% busy on average.");
    expect(capacityLine({ month: 3, roleId: "d", roleName: "Strategist", kind: "busy", value: 0.9 }, months, "12 months")).toContain("Strategist is 90% busy");
    expect(capacityLine({ month: 2, roleId: "d", roleName: "Designers", kind: "uncovered", value: 6 }, months, "12 months")).toMatch(/nobody in Designers is there for 6 hours a week/);
  });

  it("says so when it already has, and when it does not within the horizon", () => {
    expect(capacityLine({ month: 0, roleId: "d", roleName: "Designers", kind: "busy", value: 0.9 }, months, "12 months")).toMatch(/^Capacity has already run out \(Oct 2026\)/);
    expect(capacityLine(null, months, "12 months")).toMatch(/doesn't run out within these 12 months/);
  });
});

describe("paybackMonth", () => {
  it("is never when the hire ends behind", () => {
    const p = paybackMonth(profit(100, 100, 100, 100), profit(100, 120, 130, 140), 1);
    expect(p.month).toBeNull();
    expect(p.atHorizon).toBeCloseTo(-90);
  });

  it("is at once when the hire never costs more than it brings", () => {
    const p = paybackMonth(profit(100, 150, 160, 170), profit(100, 100, 100, 100), 1);
    expect(p.month).toBe(1);
    expect(p.cumulative).toEqual([0, 50, 110, 180]);
    expect(p.atHorizon).toBe(180);
  });

  it("is the month after a dip, when the running total is below zero and then stays at or above it", () => {
    // The hire costs 300 a month for two months, then brings 250 more than nothing: -300, -600, -350, -100, +150.
    const p = paybackMonth(profit(500, 200, 200, 750, 750, 750), profit(500, 500, 500, 500, 500, 500), 1);
    expect(p.cumulative).toEqual([0, -300, -600, -350, -100, 150]);
    expect(p.month).toBe(5);
    expect(p.atHorizon).toBe(150);
  });

  it("does not count a month that comes back above zero and then falls below it again", () => {
    const p = paybackMonth(profit(0, 100, -300, 100, 100), profit(0, 0, 0, 0, 0), 1);
    expect(p.cumulative).toEqual([0, 100, -200, -100, 0]);
    expect(p.month).toBe(4);
  });

  it("ignores the months before the hire and is null for a hire after the horizon", () => {
    const p = paybackMonth(profit(900, 900, 100, 100), profit(100, 100, 100, 100), 2);
    expect(p.cumulative.slice(0, 2)).toEqual([0, 0]);
    expect(p.month).toBe(2);
    expect(paybackMonth(profit(1, 1), profit(0, 0), 5).month).toBeNull();
  });
});

describe("paybackLine", () => {
  it("says the month and what it comes to by the horizon, as an average", () => {
    expect(paybackLine({ month: 4, cumulative: [], atHorizon: 4100 }, months, "GBP", "6 months")).toBe("pays for itself by Feb 2027 (+£4,100 by Mar 2027, on average)");
    expect(paybackLine({ month: null, cumulative: [], atHorizon: -9800 }, months, "GBP", "6 months")).toBe("doesn't pay for itself within these 6 months (−£9,800 by Mar 2027, on average)");
  });
});

describe("hireChanges", () => {
  const e = (lever: string, op: string, value: number, id: string) => ({ change: { id, lever, target: null, op, value } as never, scenarioId: "s", scenarioName: "S", inherited: false });
  it("takes each hire and each headcount increase, at most four, and nothing else", () => {
    const list = [e("D1", "set", 1, "a"), e("D5", "add", 1, "b"), e("D5", "add", -1, "c"), e("A1", "multiply", 1.2, "d"), e("D1", "set", 1, "e"), e("D1", "set", 1, "f"), e("D1", "set", 1, "g")];
    expect(hireChanges(list).map((x) => x.change.id)).toEqual(["a", "b", "e", "f"]);
  });
});
