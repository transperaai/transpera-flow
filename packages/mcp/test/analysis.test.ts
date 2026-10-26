import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamRoleIds, northbeamScenarios, toEngineModel } from "@transpera-flow/db";
import {
  applyPatches,
  compareHeadline,
  compareRuns,
  compareTable,
  headlineSubject,
  northbeamModel,
  rankBottlenecks,
  shadowPrice,
  simulate,
} from "@transpera-flow/engine";
import { bottleneckReport, checkScenarioRobustness, compareScenarios, matchNamed, robustnessParameters, stackPatches, ToolError } from "../src";

// The analysis tools' logic (issue #26), without a database. The tools
// themselves are covered end to end in end-to-end.test.ts.

const startDate = "2026-10-05";
const model = () => toEngineModel(northbeamBundle(), { startDate });
const scenario = (name: string) => northbeamScenarios().find((s) => s.name === name)!;

function toolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error("expected a ToolError");
}

describe("matchNamed", () => {
  const items = [
    { id: "a1", name: "Hire a strategist" },
    { id: "b2", name: "Hire an account manager" },
    { id: "c3", name: "More leads" },
  ];

  it("finds by id, exact name (any case) or a unique partial name", () => {
    expect(matchNamed(items, "b2", "scenario").name).toBe("Hire an account manager");
    expect(matchNamed(items, "more LEADS", "scenario").id).toBe("c3");
    expect(matchNamed(items, "strategist", "scenario").id).toBe("a1");
  });

  it("returns candidates instead of guessing", () => {
    const ambiguous = toolError(() => matchNamed(items, "hire", "scenario"));
    expect(ambiguous.code).toBe("ambiguous");
    expect(ambiguous.candidates).toEqual([items[0], items[1]]);
    const missing = toolError(() => matchNamed(items, "downturn", "scenario", " in 'Northbeam'"));
    expect(missing.code).toBe("not_found");
    expect(missing.message).toBe("No scenario in 'Northbeam' matches 'downturn'");
  });
});

describe("stackPatches", () => {
  it("stacks scenarios in order and refuses one that needs attention", () => {
    const m = model();
    expect(stackPatches(m, [scenario("Hire a strategist"), scenario("More leads")])).toEqual([
      ...scenario("Hire a strategist").patch,
      ...scenario("More leads").patch,
    ]);
    const broken = { id: "x", name: "Old fix", patch: [{ path: "steps.gone.work_hours", op: "set" as const, value: 1 }] };
    const err = toolError(() => stackPatches(m, [broken]));
    expect(err.code).toBe("needs_attention");
    expect(err.message).toMatch(/^“Old fix” needs attention/);
  });
});

describe("compareScenarios", () => {
  it("returns the app's delta table and headline for the same model, scenario, seed and replications", () => {
    const m = model();
    const s = scenario("Automate proposals");
    const out = compareScenarios({ model: m, a: [], b: [s], reps: 30, seed: 1, currency: "GBP" });

    // The app (components/scenario-panel.tsx + compare-view.tsx): the baseline's
    // run, the scenario's run with the same seed and replications, compareRuns,
    // compareHeadline with headlineSubject, and compareTable's rows.
    const baseline = simulate(m, 30, 1);
    const run = simulate(applyPatches(m, s.patch).model, 30, 1);
    const comparison = compareRuns(baseline, run);
    const roleNames = Object.fromEntries(Object.entries(m.roles).map(([id, r]) => [id, r.name]));
    const app = compareHeadline({
      comparison,
      ...headlineSubject([s.name], false),
      horizonWeeks: m.horizonWeeks,
      hoursPerWeek: m.hoursPerWeek,
      currency: "GBP",
      roleNames,
    });
    const rows = compareTable(comparison, { horizonWeeks: m.horizonWeeks, hoursPerWeek: m.hoursPerWeek, currency: "GBP" });

    expect(out.headline).toBe(app.headline);
    expect(out.details).toEqual(app.details);
    expect(out.headline).toMatch(/^“Automate proposals” /);
    expect(out.table.map((r) => [r.label, r.baseline, r.baselineRange, r.scenario, r.scenarioRange, r.change, r.changeRange, r.tone])).toEqual(
      rows.map((r) => [r.label, r.text.baseline, r.text.baselineRange, r.text.scenario, r.text.scenarioRange, r.text.change, r.text.changeRange, r.tone]),
    );
    expect(out.table.every((r) => r.paired)).toBe(true);
    expect(out.bottleneck.baseline).toEqual({ id: northbeamRoleIds.strat, name: "Strategist" });
  });

  it("compares two scenarios against each other", () => {
    const out = compareScenarios({ model: model(), a: [scenario("More leads")], b: [scenario("Downturn")], reps: 5, seed: 1, currency: "GBP" });
    expect(out.headline).toMatch(/^“Downturn”, against “More leads”, /);
    expect(out.table[0]!.stats.delta.mean).toBeLessThan(0);
  });

  it("needs a scenario", () => {
    expect(toolError(() => compareScenarios({ model: model(), a: [], b: [], reps: 5, seed: 1, currency: "GBP" })).code).toBe("invalid_input");
  });
});

describe("checkScenarioRobustness", () => {
  // The pipeline's steps and its servicing processes' (issue #19).
  const steps = [...northbeamBundle().steps, ...northbeamBundle().otherProcesses!.flatMap((p) => p.steps)];

  it("returns the templated verdict when it finishes within the budget", () => {
    // Only the audit step's hands-on time is estimated: every other input is entered.
    const m = model();
    const only = steps.map((s) => ({ id: s.id, provenance: s.id === steps.find((x) => x.name === "Audit & proposal")!.id ? {} : { source: "entered" } }));
    const params = robustnessParameters(m, { steps: only }).map((p) => p.path);
    expect(params.filter((p) => p.startsWith("steps."))).toHaveLength(2);
    const out = checkScenarioRobustness({
      model: m,
      scenario: [scenario("Hire a strategist")],
      provenance: { steps: only },
      metric: "won",
      currency: "GBP",
      timeBudgetMs: 60_000,
    });
    expect(out).toMatchObject({ complete: true, partial: false });
    expect(out.verdict).toMatch(/^Strategist is the bottleneck .*; “Hire a strategist” (adds|costs|makes no difference to) wins in \d+% of cases\.$/);
    expect(out.screened).toBe(out.parameters);
  });

  it("returns a partial result, flagged as such, when the time cap is hit", () => {
    let t = 0;
    const out = checkScenarioRobustness({
      model: model(),
      scenario: [scenario("Hire a strategist")],
      provenance: { steps },
      metric: "won",
      currency: "GBP",
      timeBudgetMs: 5,
      now: () => (t += 1),
    });
    expect(out).toMatchObject({ complete: false, partial: true });
    expect(out.screened).toBeLessThan(out.parameters);
    expect(out.details.join(" ")).toMatch(/Stopped early: \d+ of \d+ inputs checked\./);
    expect(out.verdict).toMatch(/is the bottleneck/);
  });
});

describe("bottleneckReport", () => {
  it("ranks the constraints and prices one more FTE at the top one", () => {
    const m = northbeamModel();
    const out = bottleneckReport({ model: m, reps: 30, seed: 1, timeBudgetMs: 60_000 });
    const run = simulate(m, 30, 1);
    expect(out.top?.id).toBe("strat");
    expect(out.roles).toEqual(rankBottlenecks(m, run).roles);
    const sp = shadowPrice(m, "strat", { reps: 30, seed: 1 })!;
    expect(out.shadow_price).toMatchObject({ role: { id: "strat", name: "Strategist" }, per_quarter: sp.perQuarter, complete: true, reps: 30 });
    expect(out.shadow_price!.per_quarter.mean).toBeGreaterThan(0);
    expect(out.text).toContain(out.shadow_price!.text);
  });
});
