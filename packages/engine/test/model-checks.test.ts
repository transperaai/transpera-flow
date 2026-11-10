import { describe, expect, it } from "vitest";
import { larkspurModel, ModelError, northbeamModel, pct, simulate, stat, WEEKS_PER_MONTH, type EngineModel, type EngineStep } from "../src";

// Guards and consistency fixes from the engine review (engine 1.18.0): a zero-time loop, overtime totals, one month
// length, weekly churn, nearest-rank percentiles, branch chances, and inputs that can't be run.

const withStep = (m: EngineModel, id: string, patch: Partial<EngineStep>): EngineModel => ({ ...m, steps: m.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

describe("a loop that takes no time", () => {
  it("a step with no hands-on time, no wait and rework 1 throws a ModelError instead of hanging", () => {
    const m = withStep(northbeamModel(), "decision", { work: 0, wait: 0, rework: 1 });
    expect(() => simulate(m, 2, 1)).toThrow(ModelError);
    expect(() => simulate(m, 2, 1)).toThrow(/'Client decision'.*without any time passing/);
  });

  it("a cycle of zero-time steps with chance 1 throws a ModelError instead of hanging", () => {
    let m = northbeamModel();
    m = withStep(m, "decision", { wait: 0, next: [{ to: "qualify", p: 1 }] });
    for (const id of ["qualify", "discovery", "audit"]) m = withStep(m, id, { role: null, work: 0, wait: 0, rework: 0 });
    m = withStep(m, "qualify", { next: [{ to: "discovery", p: 1 }] });
    m = withStep(m, "discovery", { next: [{ to: "audit", p: 1 }] });
    m = withStep(m, "audit", { next: [{ to: "decision", p: 1 }] });
    expect(() => simulate(m, 2, 1)).toThrow(ModelError);
  });

  it("a zero-time step with high (but not certain) rework still runs", () => {
    const m = withStep(northbeamModel(), "decision", { work: 0, wait: 0, rework: 0.9 });
    expect(simulate(m, 2, 1).won).toBeGreaterThan(0);
  });
});

describe("overtime", () => {
  it("the run's overtime hours are the sum of the months'", () => {
    // Larkspur at its 15% cap (binding) and at a cap of 100% (rarely binding).
    for (const m of [larkspurModel(), { ...larkspurModel(), overtimeCap: 1 }]) {
      const r = simulate(m, 4, 1, { monthly: true });
      const months = r.monthly!.overtimeHours.reduce((a, x) => a + x.mean, 0);
      expect(r.kpi.overtimeHours.mean).toBeGreaterThan(0);
      expect(r.kpi.overtimeHours.mean).toBeCloseTo(months, 6);
    }
  });

  it("a run with and without the monthly series works out the same overtime", () => {
    const m = larkspurModel();
    expect(simulate(m, 3, 1).kpi.overtimeHours.mean).toBeCloseTo(simulate(m, 3, 1, { monthly: true }).kpi.overtimeHours.mean, 6);
  });
});

describe("one month length", () => {
  it("is 52/12 weeks", () => {
    expect(WEEKS_PER_MONTH).toBe(52 / 12);
  });

  it("a pooled retainer bills its fee every 52/12 weeks: 13 weeks of 10 clients at 1,000 is 30,000", () => {
    const m: EngineModel = { ...northbeamModel(), horizonWeeks: 13, leadsPerWeek: 0, activeClients: 10, churnMonthly: 0, retainer: 1000, warmupWeeks: 0 };
    expect(simulate(m, 1, 1).samples.revenue[0]).toBeCloseTo(30000, 6);
  });
});

describe("weekly churn", () => {
  it("keeps (1 - c)^(1 / weeks a month) a week, so a month keeps 1 - c, even at high rates", () => {
    for (const c of [0.03, 0.5]) {
      const m: EngineModel = { ...northbeamModel(), horizonWeeks: 26, leadsPerWeek: 0, activeClients: 1000, churnMonthly: c, retainer: 1, warmupWeeks: 0 };
      const mrr = simulate(m, 1, 1, { monthly: true }).monthly!.mrr.map((x) => x.mean);
      // A month's figure is the pool's fees averaged over its weekly ticks, so five months on it is about (1 - c)^5 of month 1's
      // (within the ticks' offsets). The old c / 4.33 a week kept 0.071 of it at c = 0.5, not 0.031.
      expect(Math.abs(mrr[5]! / mrr[0]! / (1 - c) ** 5 - 1)).toBeLessThan(0.1);
    }
  });
});

describe("percentiles are nearest-rank", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("pct gives the ceil(p n)-th smallest value", () => {
    expect(pct(ten, 0.9)).toBe(9);
    expect(pct(ten, 0.1)).toBe(1);
    expect(pct(ten, 0.5)).toBe(5);
    expect(pct(ten, 0.95)).toBe(10);
    expect(pct(ten, 0)).toBe(1);
    expect(pct(ten, 1)).toBe(10);
    expect(pct([7], 0.9)).toBe(7);
    expect(pct(Array.from({ length: 30 }, (_, i) => i + 1), 0.9)).toBe(27);
  });

  it("stat's band uses the same rule", () => {
    expect(stat(ten)).toEqual({ mean: 5.5, p10: 1, p90: 9 });
  });
});

describe("branch chances", () => {
  const edit = (next: EngineStep["next"]) => withStep({ ...northbeamModel(), warmupWeeks: 0 }, "qualify", { next });
  const share = (m: EngineModel) => {
    const r = simulate(m, 100, 2);
    return r.steps.discovery!.arrivals / r.steps.qualify!.arrivals;
  };

  it("are normalised, as cost.ts reads them: 0.25 / 0.25 and 1 / 1 both split evenly", () => {
    expect(share(edit([{ to: "discovery", p: 0.25 }, { to: "lost", p: 0.25 }]))).toBeCloseTo(0.5, 1);
    expect(share(edit([{ to: "discovery", p: 1 }, { to: "lost", p: 1 }]))).toBeCloseTo(0.5, 1);
  });

  it("a negative chance is refused before the run", () => {
    expect(() => simulate(edit([{ to: "discovery", p: 1.2 }, { to: "lost", p: -0.2 }]), 1, 1)).toThrow(ModelError);
    expect(() => simulate(edit([{ to: "discovery", p: 1.2 }, { to: "lost", p: -0.2 }]), 1, 1)).toThrow(/'Qualify lead'.*negative chance/);
  });
});

describe("inputs that can't be run", () => {
  const m = northbeamModel();
  it.each([
    ["no replications", () => simulate(m, 0), /at least one replication/],
    ["negative leads", () => simulate({ ...m, leadsPerWeek: -1 }), /Leads a week/],
    ["a horizon of 0 weeks", () => simulate({ ...m, horizonWeeks: 0 }), /horizon/],
    ["a 0-hour week", () => simulate({ ...m, hoursPerWeek: 0 }), /working week has to have more than 0 hours/],
  ] as const)("%s throws a ModelError", (_, run, message) => {
    expect(run).toThrow(ModelError);
    expect(run).toThrow(message);
  });
});
