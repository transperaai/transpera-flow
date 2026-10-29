import { describe, expect, it } from "vitest";
import {
  applyPatches,
  flattenModel,
  larkspurModel,
  larkspurWithPurposes,
  northbeamModel,
  northbeamWithMoney,
  northbeamWithServicing,
  saleSideSteps,
  simulate,
  type EngineModel,
  type EngineStep,
  type MonthlyResult,
  type TimeSplit,
} from "../src";

// Sandbox G (engine 1.14.0): where working time goes, by what each step achieves.

const KEYS = ["client_job", "winning", "fixing", "coordination"];
/** A model with a purpose on every step, cycling through a few keys. */
const withPurposes = (m: EngineModel): EngineModel => ({ ...m, steps: m.steps.map((s, i) => ({ ...s, purpose: KEYS[i % KEYS.length]! })) });
const opts = { monthly: true } as const;
const noTime = (r: ReturnType<typeof simulate>) => {
  const { monthly, ...rest } = JSON.parse(JSON.stringify(r)) as typeof r;
  if (monthly) delete (monthly as Partial<MonthlyResult>).time;
  return { ...rest, monthly };
};

describe("purposes never change a number", () => {
  const cases: [string, () => EngineModel][] = [
    ["northbeam seeded", northbeamWithServicing],
    ["larkspur", larkspurModel],
    ["northbeam money", northbeamWithMoney],
  ];
  for (const [name, f] of cases) {
    it(`${name}: everything but monthly.time is identical`, () => {
      for (const seed of [1, 7]) {
        expect(noTime(simulate(withPurposes(f()), 6, seed, opts))).toEqual(noTime(simulate(f(), 6, seed, opts)));
      }
    });
  }
  it("a step with no purpose lands under the empty key", () => {
    const t = simulate(northbeamWithServicing(), 4, 1, opts).monthly!.time;
    expect(t.purposes).toEqual([""]);
    expect(t.team.purpose[""]!.some((s) => s.mean > 0)).toBe(true);
  });
});

const sumStat = (xs: { mean: number }[][]) => xs[0]!.map((_, m) => xs.reduce((a, x) => a + x[m]!.mean, 0));
const lineSum = (t: TimeSplit) => sumStat([...Object.values(t.purpose), t.rework, t.ongoing, t.idle]);

describe("the split adds up", () => {
  const r = simulate(larkspurWithPurposes(), 10, 1, opts);
  const mo = r.monthly!;
  it("per person and month, in one replication: purposes + rework + client hours + idle = max(hours, work), exactly", () => {
    const one = simulate(larkspurWithPurposes(), 1, 3, opts).monthly!;
    for (const [id, t] of Object.entries(one.time.people)) {
      const total = lineSum(t);
      one.months.forEach((mm, m) => {
        const b = one.people[id]![m];
        if (!b) return;
        const weeks = (mm.end - mm.start) / 37.5;
        expect(total[m]!).toBeCloseTo(Math.max(t.hours[m]!.mean, b.work * weeks), 6);
        expect(t.idle[m]!.mean).toBeCloseTo(Math.max(0, t.hours[m]!.mean - b.work * weeks), 6);
      });
    }
  });
  it("across replications the lines add up to at least the hours available", () => {
    for (const t of Object.values(mo.time.people)) {
      const total = lineSum(t);
      mo.months.forEach((_, m) => expect(total[m]!).toBeGreaterThanOrEqual(t.hours[m]!.mean - 1e-9));
    }
  });
  it("the team is the sum over people", () => {
    const people = Object.values(mo.time.people);
    for (const k of mo.time.purposes) {
      mo.months.forEach((_, m) => {
        const sum = people.reduce((a, p) => a + p.purpose[k]![m]!.mean, 0);
        expect(mo.time.team.purpose[k]![m]!.mean).toBeCloseTo(sum, 6);
      });
    }
    mo.months.forEach((_, m) => {
      expect(mo.time.team.hours[m]!.mean).toBeCloseTo(people.reduce((a, p) => a + p.hours[m]!.mean, 0), 6);
      expect(mo.time.team.rework[m]!.mean).toBeCloseTo(people.reduce((a, p) => a + p.rework[m]!.mean, 0), 6);
    });
  });
  it("a role's purposes + rework + client hours equal its work", () => {
    const first = simulate(larkspurWithPurposes(), 1, 3, opts).monthly!;
    for (const [id, t] of Object.entries(first.time.roles)) {
      const b = first.roles[id]!;
      first.months.forEach((mm, m) => {
        const row = b[m];
        if (!row) return;
        const weeks = (mm.end - mm.start) / 37.5;
        const used = lineSum(t)[m]! - t.idle[m]!.mean;
        expect(used / weeks).toBeCloseTo(row.work, 6);
      });
    }
  });
  it("every row of the Larkspur split is non-zero somewhere", () => {
    const t = mo.time.team;
    expect(t.rework.some((s) => s.mean > 0)).toBe(true);
    expect(t.ongoing.some((s) => s.mean > 0)).toBe(true);
    expect(t.idle.some((s) => s.mean > 0)).toBe(true);
    for (const k of mo.time.purposes) expect(t.purpose[k]!.some((s) => s.mean > 0)).toBe(true);
    expect(t.uncovered).not.toBeNull();
    expect(Object.values(mo.time.people).every((p) => p.uncovered === null)).toBe(true);
  });
});

const step = (id: string, next: EngineStep["next"], extra: Partial<EngineStep> = {}): EngineStep => ({
  id,
  name: id,
  role: "r",
  work: 1,
  wait: 0,
  rework: 0,
  workDist: { kind: "constant" },
  next,
  ...extra,
});
function tiny(steps: EngineStep[], extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 26,
    hoursPerWeek: 40,
    leadsPerWeek: 2,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    roles: { r: { name: "R", count: 4, cost: 10, ongoing: 0 } },
    entry: steps[0]!.id,
    sinks: { won: "done", lost: "lost" },
    steps,
    ...extra,
  };
}

describe("rework", () => {
  it("is zero in a model with no loops", () => {
    const m = tiny([step("a", [{ to: "done", p: 1 }], { purpose: "client_job" })]);
    const t = simulate(m, 5, 1, opts).monthly!.time.team;
    expect(t.rework.every((s) => s.mean === 0)).toBe(true);
    expect(t.purpose.client_job!.some((s) => s.mean > 0)).toBe(true);
  });
  it("a 50% redo gives repeat-pass hours about equal to the first passes at that step", () => {
    const m = tiny([step("a", [{ to: "done", p: 1 }], { rework: 0.5, purpose: "client_job" })], { horizonWeeks: 52 });
    const t = simulate(m, 10, 1, opts).monthly!.time.team;
    const first = t.purpose.client_job!.reduce((a, s) => a + s.mean, 0);
    const again = t.rework.reduce((a, s) => a + s.mean, 0);
    expect(again / first).toBeGreaterThan(0.8);
    expect(again / first).toBeLessThan(1.25);
  });
  it("per month, rework matches the run's rework hours, less passes that straddle the horizon and the warm-up", () => {
    const r = simulate(larkspurWithPurposes(), 6, 1, opts);
    const monthly = r.monthly!.time.team.rework.reduce((a, s) => a + s.mean, 0);
    // The run's own total counts a pass whole at its start (per month: over the horizon in 52/12-week months).
    const whole = (r.rework!.extraHandsOnHoursPerMonthTotal.mean * larkspurModel().horizonWeeks) / (52 / 12);
    expect(monthly / whole).toBeLessThan(1.05);
    expect(monthly / whole).toBeGreaterThan(0.8);
  });
});

describe("pay and structure", () => {
  it("payHidden changes nothing in time", () => {
    const m = larkspurWithPurposes();
    expect(simulate({ ...m, payHidden: true }, 4, 1, opts).monthly!.time).toEqual(simulate(m, 4, 1, opts).monthly!.time);
  });
  it("a nested model gives the same time as it drawn flat", () => {
    const flat = tiny([step("a", [{ to: "b", p: 1 }], { purpose: "winning" }), step("b", [{ to: "done", p: 1 }], { purpose: "client_job", rework: 0.2 })]);
    const nested: EngineModel = {
      ...flat,
      groups: { g: { name: "G", entry: "b", next: [{ to: "done", p: 1 }] } },
      steps: flat.steps.map((s) => (s.id === "b" ? { ...s, parent: "g" } : s)),
    };
    expect(simulate(nested, 5, 1, opts).monthly!.time).toEqual(simulate(flattenModel(nested), 5, 1, opts).monthly!.time);
  });
  it("patches keep a step's purpose", () => {
    const m = larkspurWithPurposes();
    const patched = applyPatches(m, [{ path: "steps.web_build.work", op: "multiply", value: 1.5 }] as never).model;
    expect(patched.steps.find((s) => s.id === "web_build")!.purpose).toBe("client_job");
  });
});

describe("saleSideSteps", () => {
  it("is the sale decision and the steps after it, on a pipeline that can lose", () => {
    const set = saleSideSteps(larkspurModel());
    expect([...set].sort()).toEqual(["decision", "launch", "onboard", "web_build", "web_design", "workshop", "content_plan", "social_setup"].sort());
  });
  it("is empty when no lost end is reachable", () => {
    expect(saleSideSteps(tiny([step("a", [{ to: "done", p: 1 }])])).size).toBe(0);
  });
  it("leaves earlier steps out for Northbeam", () => {
    const set = saleSideSteps(northbeamModel());
    expect(set.has("audit")).toBe(false);
  });
});
