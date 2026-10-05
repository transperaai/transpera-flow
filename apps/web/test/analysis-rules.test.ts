import { describe, expect, it } from "vitest";
import { ANALYSIS_RULE_IDS, absenceTest, detectIssues, isDefaultAnalysisSettings, northbeamModel, northbeamWithServicing, simulate } from "@transpera-flow/engine";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { RULES_UI } from "@/lib/rules/catalogue";
import { rerate, visibleFindings } from "@/lib/rules/edit";

// The analysis rules (issue #109) since B17 (#175, D40): the editor in Settings is gone, the rules give the facts every
// page shows as evidence, and every page rates a run with the documented defaults (docs/analysis-rules.md). What a
// workspace stored in `analysis_rules` is kept and no longer read.

describe("how each rule reads", () => {
  it("has a plain name, a description and an example for each of the 15 rules", () => {
    expect(ANALYSIS_RULE_IDS).toHaveLength(15);
    for (const id of ANALYSIS_RULE_IDS) {
      const ui = RULES_UI[id];
      expect(ui.name, id).toBeTruthy();
      expect(ui.help.description.length, id).toBeGreaterThan(10);
      expect(ui.help.example.length, id).toBeGreaterThan(10);
    }
  });

  it("uses the prototype's names", () => {
    expect(["busy", "wait", "sla", "spof"].map((id) => RULES_UI[id as keyof typeof RULES_UI].name)).toEqual([
      "Too busy",
      "Waiting too long",
      "Missed deadlines",
      "Only one person can do it",
    ]);
  });
});

describe("every page rates with the documented defaults", () => {
  it("is the empty settings document, which the engine reads as its defaults, and can't be changed by accident", () => {
    expect(ANALYSIS_DEFAULTS).toEqual({});
    expect(isDefaultAnalysisSettings(ANALYSIS_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(ANALYSIS_DEFAULTS)).toBe(true);
  });

  // Northbeam as the engine ships it.
  const model = northbeamModel();
  const result = simulate(model, 8, 1);

  it("matches the engine's default rating", () => {
    const base = rerate(model, result, ANALYSIS_DEFAULTS);
    expect(base.length).toBeGreaterThan(0);
    expect(base).toEqual(detectIssues(model, result));
  });

  it("takes the run it is given and leaves it as it was", () => {
    const before = JSON.stringify(result);
    rerate(model, result, ANALYSIS_DEFAULTS);
    expect(JSON.stringify(result)).toBe(before);
  });

  it("leaves out nothing: no rule is off by default", () => {
    const withServicing = northbeamWithServicing();
    const all = rerate(withServicing, simulate(withServicing, 8, 1), ANALYSIS_DEFAULTS, null, absenceTest(withServicing));
    expect(visibleFindings(ANALYSIS_DEFAULTS, all)).toEqual(all);
    const extra = [
      { key: "broken_scenario:scenario:x", type: "broken_scenario" },
      { key: "perception_gap:step:y", type: "perception_gap" },
      { key: "churn_risk:client:c1", type: "churn_risk" },
    ] as never[];
    expect(visibleFindings(ANALYSIS_DEFAULTS, extra)).toHaveLength(3);
  });
});
