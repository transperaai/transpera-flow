import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatches, parsePatches, simulate, type ScenarioPatch } from "@transpera-flow/engine";
import { northbeamBundle, northbeamScenarios, northbeamStepIds, toEngineModel } from "../src";
import { createTestDb, type TestDb } from "./harness";

// The scenario patch grammar (issue #15): the database check `private.is_scenario_patch` (still used by `save_solution` for a solution's
// lever changes) against the engine's parsePatches, and a multiply patch surviving re-measurement. The scenarios themselves are rows of
// `sandbox_scenarios` since the Sandbox (sandbox-scenarios.test.ts); the table tests that were here moved there.

let db: TestDb;
const START = { startDate: "2026-10-05" };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("patch shape", () => {
  const healthPatches: ScenarioPatch[] = [
    { path: "health.initial", op: "set", value: 70 },
    { path: "health.recover", op: "multiply", value: 1.25 },
    { path: "health.late_penalty", op: "add", value: 1 },
    { path: "health.missed_penalty", op: "multiply", value: 0.75 },
    { path: "services.s1.churn_health_sensitivity", op: "multiply", value: 1.25 },
  ];
  const cases: unknown[] = [
    [],
    [{ path: "steps.e1.work_hours", op: "multiply", value: 0.5 }],
    [{ path: "roles.@busiest.headcount", op: "add", value: 1 }],
    [{ path: "steps.@heaviest.rework_rate", op: "set", value: 0 }],
    [{ path: "people.p-1.fte", op: "set", value: 0.8 }, { path: "finances.retainer", op: "add", value: 100 }],
    [{ path: "services.s1.mix_share", op: "set", value: 2 }, { path: "demand.churn_monthly", op: "set", value: 0.1 }],
    {},
    "x",
    [1],
    [{ path: "steps.e1.work_hours", op: "multiply" }],
    [{ path: "steps.e1.work_hours", op: "multiply", value: "0.5" }],
    [{ path: "steps.e1.work_hours", op: "multiply", value: 0.5, note: "x" }],
    [{ path: "steps.e1.colour", op: "set", value: 1 }],
    [{ path: "steps.e1.work_hours", op: "divide", value: 2 }],
    [{ path: "steps.@busiest.work_hours", op: "set", value: 1 }],
    [{ path: "roles.@anything.headcount", op: "set", value: 1 }],
    [{ path: "steps.a b.work_hours", op: "set", value: 1 }],
    [{ path: "demand.retainer", op: "set", value: 1 }],
    [{ path: 3, op: "set", value: 1 }],
    Array.from({ length: 201 }, () => ({ path: "demand.leads_per_week", op: "add", value: 0 })),
    // Client health and churn (issue #79).
    ...healthPatches.map((p) => [p]),
    healthPatches,
    [{ path: "health.missed_threshold", op: "set", value: 2 }],
    [{ path: "health.recover.x", op: "set", value: 1 }],
    [{ path: "health.s1.recover", op: "set", value: 1 }],
    [{ path: "health", op: "set", value: 1 }],
    [{ path: "health.@busiest", op: "set", value: 1 }],
    [{ path: "health.health_recover", op: "set", value: 1 }],
    [{ path: "services.s1.churn_sensitivity", op: "set", value: 1 }],
    [{ path: "services.@busiest.churn_health_sensitivity", op: "set", value: 1 }],
    [{ path: "roles.r1.churn_health_sensitivity", op: "set", value: 1 }],
    [{ path: "services.churn_health_sensitivity", op: "set", value: 1 }],
  ];

  it("accepts the health-rule and churn-sensitivity paths, in the engine and the database", async () => {
    expect(parsePatches(healthPatches).ok).toBe(true);
    const { rows } = await db.client.query("select private.is_scenario_patch($1::jsonb) as ok", [JSON.stringify(healthPatches)]);
    expect(rows[0].ok).toBe(true);
  });

  it("the database accepts exactly what the engine's parsePatches accepts", async () => {
    for (const patch of cases) {
      const { rows } = await db.client.query("select private.is_scenario_patch($1::jsonb) as ok", [JSON.stringify(patch)]);
      expect(rows[0].ok, JSON.stringify(patch).slice(0, 80)).toBe(parsePatches(patch).ok);
    }
  });
});

describe("a multiply patch survives re-measurement", () => {
  it("re-measuring the step in the stored process changes the scenario's value and result proportionally", () => {
    const automate = northbeamScenarios().find((s) => s.name === "Automate proposals")!.patch as ScenarioPatch[];
    const at = (hours: number) => {
      const bundle = northbeamBundle();
      bundle.steps.find((s) => s.id === northbeamStepIds.audit)!.work_hours = hours;
      return toEngineModel(bundle, START);
    };
    const auditWork = (hours: number) => applyPatches(at(hours), automate).model.steps.find((s) => s.id === northbeamStepIds.audit)!.work;
    expect(auditWork(6)).toBeCloseTo(2.4);
    expect(auditWork(8)).toBeCloseTo(3.2);
    // The scenario on the re-measured baseline is exactly the model with 0.4 × 8 h.
    expect(simulate(applyPatches(at(8), automate).model, 4, 2)).toEqual(simulate(at(3.2), 4, 2));
  });
});
