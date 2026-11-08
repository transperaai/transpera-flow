import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALTH_RULES,
  applyPatches,
  applyScenarios,
  busiestRole,
  healthRules,
  heaviestStep,
  isBlocking,
  northbeamModel,
  northbeamWithServicing,
  offeredLoad,
  parsePatchPath,
  parsePatches,
  simulate,
  type EngineModel,
  type ScenarioPatch,
} from "../src";

const step = (m: EngineModel, id: string) => m.steps.find((s) => s.id === id)!;
const withPeople = (): EngineModel => {
  const m = northbeamModel();
  m.people = {
    p1: { name: "Maya", roles: ["strat"], capacity: 40 },
    p2: { name: "Priya", roles: ["sales"], capacity: 40 },
    p3: { name: "Tom", roles: ["sales"], capacity: 40 },
    p4: { name: "Leah", roles: ["am", "sales"], capacity: 32 },
  };
  return m;
};

describe("applyPatches: operations", () => {
  it("sets, multiplies and adds", () => {
    const { model, issues } = applyPatches(northbeamModel(), [
      { path: "steps.audit.work_hours", op: "multiply", value: 0.5 },
      { path: "steps.onboard.wait_hours", op: "add", value: 8 },
      { path: "demand.leads_per_week", op: "set", value: 10 },
      { path: "finances.retainer", op: "multiply", value: 1.1 },
      { path: "roles.strat.headcount", op: "add", value: 1 },
      { path: "roles.am.cost_rate", op: "set", value: 60 },
      { path: "roles.seo.ongoing_hours", op: "multiply", value: 0.5 },
      { path: "steps.seo.rework_rate", op: "set", value: 0.2 },
      { path: "demand.churn_monthly", op: "add", value: 0.01 },
      { path: "demand.active_clients", op: "add", value: 4 },
    ]);
    expect(issues).toEqual([]);
    expect(step(model, "audit").work).toBe(3);
    expect(step(model, "onboard").wait).toBe(24);
    expect(model.leadsPerWeek).toBe(10);
    expect(model.retainer).toBeCloseTo(4180);
    expect(model.roles.strat!.count).toBe(2);
    expect(model.roles.am!.cost).toBe(60);
    expect(model.roles.seo!.ongoing).toBe(1.2);
    expect(step(model, "seo").rework).toBe(0.2);
    expect(model.churnMonthly).toBeCloseTo(0.04);
    expect(model.activeClients).toBe(30);
  });

  it("finances.overhead_monthly sets, multiplies and adds, never below 0; finances.retainer is unchanged", () => {
    const base: EngineModel = { ...northbeamModel(), overheadMonthly: 18000 };
    const run = (op: "set" | "multiply" | "add", value: number, m = base) => applyPatches(m, [{ path: "finances.overhead_monthly", op, value }]);
    expect(run("set", 12000).model.overheadMonthly).toBe(12000);
    expect(run("multiply", 1.5).model.overheadMonthly).toBe(27000);
    expect(run("add", -3000).model.overheadMonthly).toBe(15000);
    // From none: 0 is the starting point, and it is clamped at 0 with a report.
    expect(run("add", 5000, northbeamModel()).model.overheadMonthly).toBe(5000);
    const clamped = run("add", -99999);
    expect(clamped.model.overheadMonthly).toBe(0);
    expect(clamped.issues.map((i) => i.problem)).toEqual(["clamped"]);
    const retainer = applyPatches(base, [{ path: "finances.retainer", op: "set", value: 5000 }]);
    expect(retainer.model.retainer).toBe(5000);
    expect(retainer.model.overheadMonthly).toBe(18000);
    expect(applyPatches(northbeamModel(), [{ path: "finances.margin", op: "set", value: 1 }]).issues.map((i) => i.problem)).toEqual(["invalid"]);
  });

  it("leaves the input model untouched", () => {
    const base = northbeamModel();
    const before = structuredClone(base);
    applyPatches(base, [{ path: "steps.audit.work_hours", op: "multiply", value: 0.5 }]);
    expect(base).toEqual(before);
  });

  it("an empty patch list is the baseline", () => {
    expect(applyPatches(northbeamModel(), []).model).toEqual(northbeamModel());
  });

  it("scales a triangular range with its step's time, so its mean moves the same way", () => {
    const m = northbeamModel();
    step(m, "audit").workDist = { kind: "triangular", min: 4, mode: 6, max: 8 };
    const { model } = applyPatches(m, [{ path: "steps.audit.work_hours", op: "multiply", value: 0.5 }]);
    expect(step(model, "audit").workDist).toEqual({ kind: "triangular", min: 2, mode: 3, max: 4 });
  });

  it("changes a person's FTE as capacity, and removes someone set to 0 FTE", () => {
    const { model, issues } = applyPatches(withPeople(), [
      { path: "people.p4.fte", op: "set", value: 0.5 },
      { path: "people.p3.fte", op: "set", value: 0 },
    ]);
    expect(issues).toEqual([]);
    expect(model.people!.p4!.capacity).toBe(20);
    expect(model.people!.p3).toBeUndefined();
  });

  it("hires named people into a role, and removes hires before existing staff", () => {
    const hired = applyPatches(withPeople(), [{ path: "roles.strat.headcount", op: "add", value: 2 }]).model;
    expect(Object.entries(hired.people!).filter(([, p]) => p.roles.includes("strat")).map(([id, p]) => [id, p.name])).toEqual([
      ["p1", "Maya"],
      ["hire:strat:1", "New Strategist"],
      ["hire:strat:2", "New Strategist 2"],
    ]);
    expect(hired.people!["hire:strat:1"]).toMatchObject({ capacity: 40, roles: ["strat"] });

    const back = applyPatches(hired, [{ path: "roles.strat.headcount", op: "add", value: -1 }]).model;
    expect(Object.keys(back.people!)).toContain("p1");
    expect(Object.keys(back.people!)).toContain("hire:strat:1");
    expect(Object.keys(back.people!)).not.toContain("hire:strat:2");
  });

  it("reports when a role can't shrink further (people with other roles are kept)", () => {
    // Sales: Priya, Tom (sales only) and Leah (am + sales).
    const { model, issues } = applyPatches(withPeople(), [{ path: "roles.sales.headcount", op: "set", value: 0 }]);
    expect(Object.keys(model.people!)).toEqual(["p1", "p4"]);
    expect(issues).toMatchObject([{ problem: "clamped", path: "roles.sales.headcount" }]);
  });

  it("clamps out-of-range results and reports them", () => {
    const { model, issues } = applyPatches(northbeamModel(), [
      { path: "steps.audit.rework_rate", op: "set", value: 1.5 },
      { path: "demand.leads_per_week", op: "add", value: -100 },
      { path: "roles.strat.headcount", op: "add", value: 0.4 },
    ]);
    expect(step(model, "audit").rework).toBe(0.95);
    expect(model.leadsPerWeek).toBe(0);
    expect(model.roles.strat!.count).toBe(1);
    expect(issues.map((i) => [i.index, i.problem])).toEqual([
      [0, "clamped"],
      [1, "clamped"],
      [2, "clamped"],
    ]);
    expect(issues.some(isBlocking)).toBe(false);
  });
});

describe("applyPatches: invalid paths are reported, not ignored", () => {
  it("reports paths outside the grammar and missing targets, and applies the rest", () => {
    const patches = [
      { path: "steps.audit.colour", op: "set", value: 1 },
      { path: "steps.gone.work_hours", op: "multiply", value: 0.5 },
      { path: "people.nobody.fte", op: "set", value: 1 },
      { path: "roles.nope.headcount", op: "add", value: 1 },
      { path: "services.none.price", op: "set", value: 1 },
      { path: "demand.leads_per_week", op: "divide", value: 2 },
      { path: "demand.leads_per_week", op: "set", value: Number.NaN },
      { path: "steps.audit.work_hours", op: "multiply", value: 0.5 },
    ] as ScenarioPatch[];
    const { model, issues } = applyPatches(northbeamModel(), patches);
    expect(issues.map((i) => [i.index, i.problem])).toEqual([
      [0, "invalid"],
      [1, "missing_target"],
      [2, "missing_target"],
      [3, "missing_target"],
      [4, "missing_target"],
      [5, "invalid"],
      [6, "invalid"],
    ]);
    expect(issues.every(isBlocking)).toBe(true);
    expect(step(model, "audit").work).toBe(3);
    expect(model.leadsPerWeek).toBe(7);
  });

  it("parses the path grammar", () => {
    expect(parsePatchPath("steps.e1.work_hours")).toEqual({ kind: "steps", id: "e1", field: "work_hours" });
    expect(parsePatchPath("demand.leads_per_week")).toEqual({ kind: "demand", field: "leads_per_week" });
    expect(parsePatchPath("roles.@busiest.headcount")).toEqual({ kind: "roles", id: "@busiest", field: "headcount" });
    for (const bad of ["", "steps", "steps..work_hours", "steps.a.b.work_hours", "roles.@heaviest.headcount", "steps.@x.work_hours", "demand.retainer", "workspace.leads_per_week", "steps.a b.work_hours"]) {
      expect(parsePatchPath(bad), bad).toBeNull();
    }
  });

  it("parses the health-rule and churn-sensitivity paths (issue #79)", () => {
    for (const field of ["initial", "recover", "late_penalty", "missed_penalty"]) {
      expect(parsePatchPath(`health.${field}`)).toEqual({ kind: "health", field });
    }
    expect(parsePatchPath("services.seo.churn_health_sensitivity")).toEqual({ kind: "services", id: "seo", field: "churn_health_sensitivity" });
    for (const bad of ["health", "health.missed_threshold", "health.x.recover", "health.@busiest", "roles.r.churn_health_sensitivity", "services.@busiest.churn_health_sensitivity"]) {
      expect(parsePatchPath(bad), bad).toBeNull();
    }
  });

  it("parsePatches checks the shape of untrusted input", () => {
    expect(parsePatches([{ path: "steps.a.work_hours", op: "multiply", value: 0.5 }])).toEqual({
      ok: true,
      patches: [{ path: "steps.a.work_hours", op: "multiply", value: 0.5 }],
    });
    expect(parsePatches([])).toEqual({ ok: true, patches: [] });
    for (const bad of [
      null,
      {},
      [null],
      [{ path: "steps.a.work_hours", op: "multiply" }],
      [{ path: "steps.a.work_hours", op: "multiply", value: "0.5" }],
      [{ path: "steps.a.work_hours", op: "multiply", value: 0.5, extra: 1 }],
      [{ path: "steps.a.nope", op: "multiply", value: 0.5 }],
      [{ path: "steps.a.work_hours", op: "pow", value: 2 }],
      [{ path: "steps.a.work_hours", op: "set", value: Infinity }],
      Array.from({ length: 201 }, () => ({ path: "demand.leads_per_week", op: "add", value: 0 })),
    ]) {
      expect(parsePatches(bad).ok, JSON.stringify(bad)?.slice(0, 80)).toBe(false);
    }
  });
});

describe("stacking", () => {
  const halve: ScenarioPatch = { path: "steps.audit.work_hours", op: "multiply", value: 0.5 };
  const plusOne: ScenarioPatch = { path: "steps.audit.work_hours", op: "add", value: 1 };

  it("applies scenarios in the order given, each patch on the result of the ones before", () => {
    const ab = applyScenarios(northbeamModel(), [{ patch: [halve] }, { patch: [plusOne] }]).model;
    const ba = applyScenarios(northbeamModel(), [{ patch: [plusOne] }, { patch: [halve] }]).model;
    expect(step(ab, "audit").work).toBe(4); // 6 × 0.5 + 1
    expect(step(ba, "audit").work).toBe(3.5); // (6 + 1) × 0.5
  });

  it("is the same as applying the concatenated patches", () => {
    const a = { patch: [halve, { path: "demand.leads_per_week", op: "set", value: 9 } as ScenarioPatch] };
    const b = { patch: [plusOne, { path: "roles.strat.headcount", op: "add", value: 1 } as ScenarioPatch] };
    expect(applyScenarios(northbeamModel(), [a, b]).model).toEqual(applyPatches(northbeamModel(), [...a.patch, ...b.patch]).model);
  });

  it("a later set overrides an earlier change to the same field", () => {
    const m = applyScenarios(northbeamModel(), [{ patch: [halve] }, { patch: [{ path: "steps.audit.work_hours", op: "set", value: 5 }] }]).model;
    expect(step(m, "audit").work).toBe(5);
  });

  it("says which scenario an issue belongs to", () => {
    const { issues } = applyScenarios(northbeamModel(), [{ patch: [halve] }, { patch: [plusOne, { path: "steps.gone.work_hours", op: "add", value: 1 }] }]);
    expect(issues).toMatchObject([{ scenario: 1, index: 2, problem: "missing_target" }]);
  });
});

describe("multiply survives re-measurement", () => {
  const automate: ScenarioPatch = { path: "steps.audit.work_hours", op: "multiply", value: 0.4 };
  const remeasured = (hours: number) => {
    const m = northbeamModel();
    step(m, "audit").work = hours;
    return m;
  };

  it("scales with the baseline: re-measuring the step changes the scenario's value proportionally", () => {
    for (const hours of [6, 8, 3]) {
      expect(step(applyPatches(remeasured(hours), [automate]).model, "audit").work).toBeCloseTo(hours * 0.4);
    }
    // A set, by contrast, ignores the new measurement.
    const set: ScenarioPatch = { path: "steps.audit.work_hours", op: "set", value: 2.4 };
    expect(step(applyPatches(remeasured(8), [set]).model, "audit").work).toBe(2.4);
  });

  it("and so the scenario's simulated result follows the re-measured baseline", () => {
    const run = (m: EngineModel) => simulate(m, 5, 3);
    // After re-measuring 6 h → 8 h, the scenario runs exactly the model with 0.4 × 8 h.
    expect(run(applyPatches(remeasured(8), [automate]).model)).toEqual(run(remeasured(3.2)));
    // The strategist's pipeline hours follow it: 3.2 h per audit instead of 2.4 h.
    const hours = (m: EngineModel) => run(m).roles.strat!.pipelineHours;
    expect(hours(applyPatches(remeasured(8), [automate]).model)).toBeGreaterThan(hours(applyPatches(remeasured(6), [automate]).model));
  });
});

describe("selectors", () => {
  it("resolve against the model: busiest role by offered load, heaviest step by hands-on hours per week", () => {
    const m = northbeamModel();
    const load = offeredLoad(m);
    // Northbeam's lone strategist does audits and kickoffs: the known bottleneck.
    expect(busiestRole(m)).toBe("strat");
    expect(load.visits.qualify).toBeCloseTo(1);
    expect(load.visits.audit).toBeCloseTo((0.55 * 0.7) / 0.85);
    // Audit & proposal: 7 leads × 0.385 reach it × 1/0.85 for rework × 6 h ≈ 19 h/week, the most of any step.
    expect(load.stepHours.audit).toBeCloseTo((7 * 0.385 * 6) / 0.85);
    expect(heaviestStep(m)).toBe("audit");

    const { model, issues } = applyPatches(m, [
      { path: "roles.@busiest.headcount", op: "add", value: 1 },
      { path: "steps.@heaviest.work_hours", op: "multiply", value: 0.5 },
    ]);
    expect(issues).toEqual([]);
    expect(model.roles.strat!.count).toBe(2);
    expect(step(model, "audit").work).toBe(3);
  });
});

describe("client health and churn (issue #79)", () => {
  it("health rules act on the rules in force: the workspace's, or the estimated defaults", () => {
    const m = northbeamWithServicing();
    expect(m.health).toBeUndefined();
    const { model, issues } = applyPatches(m, [
      { path: "health.recover", op: "multiply", value: 1.25 },
      { path: "health.late_penalty", op: "add", value: 1 },
      { path: "health.missed_penalty", op: "set", value: 20 },
    ]);
    expect(issues).toEqual([]);
    expect(healthRules(model)).toEqual({ ...DEFAULT_HEALTH_RULES, recover: 2.5, latePenalty: 6, missedPenalty: 20 });
    // The workspace's own value is the base when it has one; the input model is untouched.
    const set = applyPatches({ ...m, health: { initial: 60 } }, [{ path: "health.initial", op: "multiply", value: 0.5 }]).model;
    expect(set.health).toEqual({ initial: 30 });
    expect(m.health).toBeUndefined();
  });

  it("clamps health rules to 0–100 and churn sensitivity to 0–100", () => {
    const { model, issues } = applyPatches(northbeamWithServicing(), [
      { path: "health.initial", op: "add", value: 50 },
      { path: "health.recover", op: "set", value: -1 },
      { path: "services.seo.churn_health_sensitivity", op: "multiply", value: 1000 },
    ]);
    expect(model.health).toEqual({ initial: 100, recover: 0 });
    expect(model.services!.seo!.churnSensitivity).toBe(100);
    expect(issues.map((i) => i.problem)).toEqual(["clamped", "clamped", "clamped"]);
  });

  it("changes one service's churn sensitivity, and reports a missing service", () => {
    const m = northbeamWithServicing();
    const { model, issues } = applyPatches(m, [
      { path: "services.ppc.churn_health_sensitivity", op: "multiply", value: 0.5 },
      { path: "services.gone.churn_health_sensitivity", op: "set", value: 1 },
    ]);
    expect(model.services!.ppc!.churnSensitivity).toBe(1.5);
    expect(model.services!.seo!.churnSensitivity).toBe(3);
    expect(issues).toMatchObject([{ index: 1, problem: "missing_target" }]);
    // A service with none set is at 0 (churn doesn't follow health), so `add` starts from there.
    const { churnSensitivity: _c, ...plain } = m.services!.seo!;
    const added = applyPatches({ ...m, services: { ...m.services, seo: plain } }, [{ path: "services.seo.churn_health_sensitivity", op: "add", value: 2 }]).model;
    expect(added.services!.seo!.churnSensitivity).toBe(2);
  });

  it("moves the simulated health", () => {
    const m = northbeamWithServicing();
    const harsh = applyPatches(m, [
      { path: "health.recover", op: "set", value: 0 },
      { path: "health.late_penalty", op: "multiply", value: 3 },
      { path: "health.missed_penalty", op: "multiply", value: 3 },
    ]).model;
    const mean = (model: EngineModel) => {
      const r = simulate(model, 5, 1);
      return Object.values(r.clients!).reduce((a, c) => a + c.health.mean, 0) / Object.keys(r.clients!).length;
    };
    expect(mean(harsh)).toBeLessThan(mean(m));
  });
});
