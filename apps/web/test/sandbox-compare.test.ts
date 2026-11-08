import { describe, expect, it } from "vitest";
import { fakeTime } from "./fake-time";
import { DEFAULT_PURPOSES, type ProcessBundle } from "@transpera-flow/db";
import type { MonthBusy, MonthlyResult, Stat } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { compareSandbox } from "@/lib/sandbox/compare";

// Scenarios side by side (docs/plans/sandbox-p1-brief.md §4): "No changes" and up to three columns, each figure with its difference
// from column 0. Pure.

const START = DEMO_FORECAST_START;
const live = forecastModel(demoForecastBundle(), 12, START).model!;
const stat = (mean: number, spread = 0.1): Stat => ({ mean, p10: mean - spread, p90: mean + spread });
const busy = (mean: number): MonthBusy => ({ ...stat(mean), capacity: 40, work: mean * 40 });
function fake(n: number, level: number, c: number, m: number, extra: Partial<MonthlyResult> = {}): MonthlyResult {
  return {
    months: Array.from({ length: n }, (_, i) => ({ start: i * 100, end: (i + 1) * 100 })),
    time: fakeTime(n, level),
    roles: { r: Array.from({ length: n }, () => busy(level)) },
    uncovered: { r: Array.from({ length: n }, () => null) },
    people: { p: Array.from({ length: n }, () => busy(level)) },
    waits: { s: Array.from({ length: n }, () => level) },
    lateTasks: Array.from({ length: n }, () => stat(level)),
    clients: { svc: Array.from({ length: n }, (_, i) => stat(c + i)) },
    mrr: Array.from({ length: n }, (_, i) => stat(m + i * 10)),
    atRisk: { svc: Array.from({ length: n }, () => stat(1, 0.5)) },
    // Sales, revenue and money (sandbox phase 2): every series moves with `level` and `m` so a splice shows which run a month came from.
    sales: {
      opportunities: Array.from({ length: n }, () => stat(level * 100)),
      won: Array.from({ length: n }, (_, i) => stat(level * 10 + i)),
      lost: Array.from({ length: n }, () => stat(level * 20)),
      conversion: Array.from({ length: n }, () => stat(level / 2)),
    },
    clientsWon: Array.from({ length: n }, () => stat(level * 3)),
    clientsLost: Array.from({ length: n }, () => stat(level)),
    revenue: {
      total: Array.from({ length: n }, (_, i) => stat(m * 10 + i)),
      recurring: Array.from({ length: n }, () => stat(m * 8)),
      oneOff: Array.from({ length: n }, () => stat(m)),
      hourly: Array.from({ length: n }, () => stat(m)),
      fromNew: Array.from({ length: n }, () => stat(m / 2)),
      lostToChurn: Array.from({ length: n }, () => stat(level * 7)),
      rise: Array.from({ length: n }, () => stat(0)),
    },
    overtimeHours: Array.from({ length: n }, () => stat(level * 2)),
    money: {
      labour: Array.from({ length: n }, () => level * 200),
      labourByRole: { r: Array.from({ length: n }, () => level * 200) },
      labourByPerson: { p: Array.from({ length: n }, () => level * 200) },
      overtimeCost: Array.from({ length: n }, () => stat(level * 10)),
      overheads: Array.from({ length: n }, () => 50),
      profit: Array.from({ length: n }, (_, i) => stat(m * 10 - level * 200 + i)),
    },
    ...extra,
  };
}

const a = fake(4, 0.5, 10, 100);
const b = fake(4, 0.9, 10, 160, { atRisk: { svc: Array.from({ length: 4 }, () => stat(3, 0.5)) }, roles: { r: Array.from({ length: 4 }, () => busy(0.9)), extra: Array.from({ length: 4 }, () => null) } });
const c3 = fake(4, 0.7, 14, 90, { atRisk: { svc: Array.from({ length: 4 }, () => stat(0, 0.5)) }, lateTasks: Array.from({ length: 4 }, () => stat(2)) });
const model = { ...live, roles: { ...live.roles, r: { name: "Role R", count: 1 }, extra: { name: "Extra", count: 0 } } } as unknown as typeof live;
const services = [{ id: "svc", name: "PPC" }] as ProcessBundle["services"];
const cutoffs = [0.7, 0.85, 0.95] as const;

describe("compareSandbox", () => {
  it("has the difference from column 0 for every column, and none for column 0 itself", () => {
    const c = compareSandbox(model, [a, b, c3], { services }, START, cutoffs);
    expect(c.mrr.values).toHaveLength(3);
    expect(c.mrr.values[0]).toBe(a.mrr);
    expect(c.mrr.diff[0]).toEqual([null, null, null, null]);
    expect(c.mrr.diff[1]).toEqual([60, 60, 60, 60]);
    expect(c.mrr.diff[2]).toEqual([-10, -10, -10, -10]);
    expect(c.atRisk.map((r) => [r.id, r.name])).toEqual([["svc", "PPC"]]);
    expect(c.atRisk[0]!.diff[1]).toEqual([2, 2, 2, 2]);
    expect(c.atRisk[0]!.diff[2]).toEqual([-1, -1, -1, -1]);
    expect(c.clients.map((r) => r.name)).toEqual(["PPC"]);
    expect(c.clients[0]!.diff[2]).toEqual([4, 4, 4, 4]);
    expect(c.roles.map((r) => r.id)).toEqual(["r"]);
  });

  it("is a null difference where a column has no value, and a role only one column has work in is still there", () => {
    const lopsided = compareSandbox(model, [{ ...a, roles: { r: a.roles.r!, extra: [busy(0.4), null, null, null] } }, b], { services }, START, cutoffs);
    expect(lopsided.roles.find((r) => r.id === "extra")!.diff[1]).toEqual([null, null, null, null]);
    const onlyLater = compareSandbox(model, [a, { ...b, roles: { r: b.roles.r!, extra: [busy(0.6), busy(0.6), null, null] } }], { services }, START, cutoffs);
    expect(onlyLater.roles.map((r) => r.id)).toEqual(["r", "extra"]);
  });

  it("compares profit, billed revenue, labour with overtime, wins and conversion in every column", () => {
    // fake(): profit is m * 10 - level * 200 + month; labour level * 200 and overtime level * 10; revenue m * 10 + month.
    const c = compareSandbox(model, [a, b, c3], { services }, START, cutoffs);
    expect(c.profit!.values[0]).toBe(a.money!.profit);
    expect(c.profit!.diff[1]).toEqual([0, 1, 2, 3].map(() => 1600 - 180 - (1000 - 100)));
    expect(c.revenue.diff[1]).toEqual([600, 600, 600, 600]);
    expect(c.revenue.diff[2]).toEqual([-100, -100, -100, -100]);
    expect(c.labour!.values[0]!.map((s) => s!.mean)).toEqual([105, 105, 105, 105]);
    expect(c.labour!.values[1]!.map((s) => s!.mean)).toEqual([189, 189, 189, 189]);
    expect(c.won.id).toBe("won");
    // Every win, one-off jobs included: not "Clients won", which is a different series (wins that become clients).
    expect(c.won.name).toBe("Wins");
    expect(c.won.diff[1]).toEqual([4, 4, 4, 4]);
    expect(c.conversion.diff[1]).toEqual([0.2, 0.2, 0.2, 0.2].map((v) => expect.closeTo(v, 9)));
    // Over the run: the sum of the months' means, with the difference from column 0.
    expect(c.totals.profit!.values.slice(0, 2)).toEqual([900 * 4 + 6, 1420 * 4 + 6]);
    expect(c.totals.profit!.diff[0]).toBeNull();
    expect(c.totals.profit!.diff[1]).toBe(1420 * 4 - 900 * 4);
  });

  it("has no profit or labour when any column's costs are hidden, and still compares revenue", () => {
    const hidden = compareSandbox(model, [a, { ...b, money: null }, c3], { services }, START, cutoffs);
    expect(hidden.profit).toBeNull();
    expect(hidden.labour).toBeNull();
    expect(hidden.totals.profit).toBeNull();
    expect(hidden.revenue.diff[1]).toEqual([600, 600, 600, 600]);
  });

  it("totals the last month for every column, with the difference from column 0", () => {
    const c = compareSandbox(model, [a, b, c3], { services }, START, cutoffs);
    expect(c.totals.mrr.values).toEqual([130, 190, 120]);
    expect(c.totals.mrr.diff).toEqual([null, 60, -10]);
    expect(c.totals.atRisk).toEqual({ values: [1, 3, 0], diff: [null, 2, -1] });
    expect(c.totals.tooBusyMonths.values).toEqual([0, 4, 0]);
    expect(c.totals.lateTasks.values).toEqual([0.5, 0.9, 2]);
    expect(c.totals.lateTasks.diff[2]).toBeCloseTo(1.5);
    expect(c.months).toHaveLength(4);
  });

  it("compares where the time goes (sandbox phase 4): a row per category, then Idle and uncovered, hours a month and whole-run shares", () => {
    const c = compareSandbox(model, [a, b, c3], { services }, START, cutoffs);
    expect(c.time.rows.map((r) => r.id)).toEqual(["client_job", "client_upkeep", "required", "winning", "coordination", "fixing", "removable", "idle", "uncovered"]);
    // fakeSplit(level): client job level * 10, winning level * 4, fixing's own level * 2 plus rework level, client hours level * 3, idle 10, hours the sum of those.
    const row = (id: string) => c.time.rows.findIndex((r) => r.id === id);
    const j = row("client_job");
    expect(c.time.rows[j]!.values.map((col) => col[0]!.mean)).toEqual([5, 9, 7]);
    expect(c.time.rows[j]!.diff[1]).toEqual([4, 4, 4, 4]);
    const f = row("fixing");
    expect(c.time.rows[f]!.values.map((col) => col[0]!.mean)).toEqual([1.5, 2.7, 2.1].map((v) => expect.closeTo(v, 9)));
    expect(c.time.runHours[0]![f]).toBeCloseTo(6, 9);
    // Shares are of the hours available, whole run; they add up to 100% with Idle (no uncovered inside it).
    for (const col of c.time.shares.keys()) {
      const inside = c.time.rows.reduce((sum, r, i) => (r.id === "uncovered" ? sum : sum + c.time.shares[col]![i]!), 0);
      expect(inside, `column ${col}`).toBeCloseTo(1, 9);
    }
    expect(c.time.runHours[0]![row("uncovered")]).toBe(20);
    // A custom list renames and reorders the rows without changing a number.
    const custom = compareSandbox(model, [a, b], { services }, START, cutoffs, [], [{ key: "fixing", name: "Putting right", description: "" }, ...DEFAULT_PURPOSES.filter((p) => p.key !== "fixing")]);
    expect(custom.time.rows[0]!.name).toBe("Putting right");
    expect(custom.time.runHours[0]![0]).toBeCloseTo(6, 9);
  });

  it("lines the time rows up by id when one column has a row the others lack (a key not in the list: Not set)", () => {
    const t = fakeTime(4, 0.9);
    const mystery = Array.from({ length: 4 }, () => stat(3));
    const withMystery = { ...b, time: { ...t, purposes: [...t.purposes, "mystery"], team: { ...t.team, purpose: { ...t.team.purpose, mystery }, withRework: { ...t.team.withRework, mystery } } } };
    const c = compareSandbox(model, [a, withMystery], { services }, START, cutoffs);
    expect(c.time.rows.map((r) => r.id)).toEqual(["client_job", "client_upkeep", "required", "winning", "coordination", "fixing", "removable", "not_set", "idle", "uncovered"]);
    const at = (id: string) => c.time.rows.findIndex((r) => r.id === id);
    // Column 0 has no Not set row: zero there. Idle and uncovered are each column's own, not a neighbour's.
    expect(c.time.rows[at("not_set")]!.values.map((col) => col[0]!.mean)).toEqual([0, 3]);
    expect(c.time.rows[at("idle")]!.values.map((col) => col[0]!.mean)).toEqual([10, 10]);
    expect(c.time.runHours[0]![at("uncovered")]).toBe(20);
    expect(c.time.runHours[1]![at("uncovered")]).toBe(20);
    expect(c.time.shares[0]![at("not_set")]).toBe(0);
    expect(c.time.shares[1]![at("idle")]).toBeCloseTo(10 / (0.9 * 20 + 10), 9);
  });

  it("has two tiles: hours fixing (its steps and all rework) and hours on steps that could be removed, over the run", () => {
    const c = compareSandbox(model, [a, b, c3], { services }, START, cutoffs);
    expect(c.totals.fixingHours.values).toEqual([6, 10.8, 8.4].map((v) => expect.closeTo(v, 9)));
    expect(c.totals.fixingHours.diff[0]).toBeNull();
    expect(c.totals.fixingHours.diff[1]).toBeCloseTo(4.8, 9);
    expect(c.totals.removableHours.values).toEqual([0, 0, 0]);
  });

  it("has the price rises' net per column only when some column has a rise, null for the columns without one", () => {
    expect(compareSandbox(model, [a, b, c3], { services }, START, cutoffs).totals.priceNet).toBeNull();
    expect(compareSandbox(model, [a, b, c3], { services }, START, cutoffs, [null, 1200, null]).totals.priceNet).toEqual([null, 1200, null]);
    expect(compareSandbox(model, [a, b], { services }, START, cutoffs, [null, -300]).totals.priceNet).toEqual([null, -300]);
  });

  it("works with 'No changes' alone, and with a pooled model (no clients at risk)", () => {
    const alone = compareSandbox(model, [a], { services }, START, cutoffs);
    expect(alone.totals.mrr).toEqual({ values: [130], diff: [null] });
    const pooled = compareSandbox(model, [{ ...a, atRisk: {}, clients: {} }, { ...b, atRisk: {}, clients: {} }], { services }, START, cutoffs);
    expect(pooled.atRisk).toEqual([]);
    expect(pooled.clients).toEqual([]);
    expect(pooled.totals.atRisk).toBeNull();
  });
});
