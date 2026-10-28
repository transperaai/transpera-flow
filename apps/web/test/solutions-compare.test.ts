import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues, northbeamStepIds as ids, toEngineModel, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import { STABLE_MARKET, withMarketCondition } from "@transpera-flow/engine";
import { MrrChart } from "@/components/overview/charts";
import { demoMarket } from "@/lib/market-demo";
import { solutionCopy } from "@/lib/solutions/bundle";
import { SCHEDULE_KEY, compareMaps, overallResult, pinProblems, stressConditions, stressTargets, toneWord } from "@/lib/solutions/compare";
import { solutionType } from "@/lib/solutions/cards";
import { runStress, stressKey, type StressRow } from "@/lib/solutions/stress";
import { demoSolutionsNow, markDemoSolutionAi } from "@/lib/solutions/demo";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTarget } from "@/lib/solutions/verdict";
import { simulate } from "@transpera-flow/engine";
import { demoBundle } from "@/lib/sources/demo";

// The Solution page's comparison (issue #115, A50 slice 2): the two maps, the market conditions to stress under, the targets checked,
// and the stress runner itself, which the worker calls.

const base = demoBundle();
const issues = northbeamIssues();
const [issue] = issues;
const edited = { ...base, steps: base.steps.map((s) => (s.id === ids.audit ? { ...s, work_hours: 2, work_dist: "constant" as const } : s)) };
const stamp = "2026-10-05T10:00:00.000Z";
const solution: SolutionRow = {
  id: "00000000-0000-4000-8000-0000000000aa",
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  process_id: NORTHBEAM_PROCESS_ID,
  base_revision_id: base.revision.id,
  name: "Faster audit",
  notes: "",
  steps: solutionCopy(edited),
  changed_step_ids: [ids.audit],
  lever_changes: [],
  created_at: stamp,
  updated_at: stamp,
  created_by: null,
};
const link: SolutionIssueRow = {
  solution_id: solution.id,
  issue_id: issue!.id,
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  auto_verdict: null,
  holds_pct: null,
  auto_note: "",
  user_verdict: null,
  user_notes: "",
  created_at: stamp,
  updated_at: stamp,
  created_by: null,
};

describe("the two maps", () => {
  it("sets the solution's copy against the version it was copied from and finds what changed", () => {
    const c = compareMaps(base, solution);
    expect(c.changed).toEqual([ids.audit]);
    expect(c.diff.steps.get(ids.audit)?.kind).toBe("changed");
    expect(c.solved.steps.find((s) => s.id === ids.audit)?.work_hours).toBe(2);
    expect(c.base.steps.find((s) => s.id === ids.audit)?.work_hours).not.toBe(2);
  });

  it("opens the groups that hold a changed step, on both maps", () => {
    const group = { ...base.steps[0]!, id: "00000000-0000-4000-8000-0000000000c1", kind: "group" as const, name: "Sales", parent_step_id: null };
    const nested = { ...base, steps: [group, ...base.steps.map((s) => (s.id === ids.audit ? { ...s, parent_step_id: group.id } : s))] };
    const c = compareMaps(nested, { steps: solutionCopy({ steps: nested.steps.map((s) => (s.id === ids.audit ? { ...s, work_hours: 1 } : s)), edges: nested.edges }) });
    expect([...c.open]).toEqual([group.id]);
  });
});

describe("the markets", () => {
  it("runs the workspace's conditions, presets first and then its own", () => {
    const conditions = stressConditions(demoMarket().marketConditions);
    expect(conditions.map((c) => c.name)).toEqual(["Boom", "Stable", "Soft", "Downturn", "Cautious 2027"]);
    expect(conditions.at(-1)).toMatchObject({ preset: null, factors: { leads: 0.92, churn: 1.08 } });
    expect(conditions[1]!.factors).toEqual(STABLE_MARKET);
  });

  it("falls back to the four presets when the workspace has none", () => {
    expect(stressConditions(undefined).map((c) => c.name).sort()).toEqual(["Boom", "Downturn", "Soft", "Stable"]);
    expect(stressConditions([]).length).toBe(4);
  });
});

describe("your schedule", () => {
  it("is a row of its own, first, only when the workspace has a schedule", () => {
    const rows = demoMarket().marketConditions;
    expect(stressConditions(rows, false).some((c) => c.key === SCHEDULE_KEY)).toBe(false);
    const withIt = stressConditions(rows, true);
    expect(withIt[0]).toMatchObject({ key: SCHEDULE_KEY, name: "Your schedule", factors: null });
    expect(withIt).toHaveLength(6);
  });
});

describe("steps nobody can do", () => {
  it("says so when a step is given to someone no longer active, or to a role that isn't there", () => {
    expect(pinProblems(base)).toEqual([]);
    const gone = { ...base, people: base.people.map((p) => ({ ...p, active: false })), steps: base.steps.map((s) => (s.id === ids.audit ? { ...s, person_id: base.people[0]!.id } : s)) };
    const [note] = pinProblems(gone);
    expect(note).toMatch(/no longer active \(Audit & proposal\)/);
    const noRole = { ...base, roles: [], steps: base.steps.map((s) => (s.id === ids.audit ? { ...s, role_id: "nope" } : s)) };
    expect(pinProblems(noRole).join(" ")).toMatch(/use a role that isn't in the workspace any more \(.*Audit & proposal.*\)/);
  });
});

describe("the targets and the result", () => {
  it("checks each issue the solution solves, over the steps the solution's map has in its area", () => {
    const c = compareMaps(base, solution);
    const targets = stressTargets(c, [link, { ...link, issue_id: "gone" }], issues, NORTHBEAM_PROCESS_ID);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ issueId: issue!.id, number: issue!.number, target: { goal: issue!.target_goal } });
    expect(targets[0]!.area).toContain(ids.audit);
  });

  it("is a pass only if every issue that could be checked passes", () => {
    expect(overallResult([{ status: "pass" }, { status: "pass" }])).toBe("pass");
    expect(overallResult([{ status: "pass" }, { status: "fail" }])).toBe("fail");
    expect(overallResult([{ status: "pass" }, { status: "unchecked" }])).toBe("pass");
    expect(overallResult([{ status: "unchecked" }])).toBe("unchecked");
    expect(overallResult([])).toBe("unchecked");
  });

  it("words the engine's tone as better, worse or about the same", () => {
    expect([toneWord("good"), toneWord("bad"), toneWord(null)]).toEqual(["Better", "Worse", "About the same"]);
  });
});

describe("the stress runner", () => {
  const c = compareMaps(base, solution);
  const baseModel = toEngineModel(c.base);
  const solved = toEngineModel(c.solved);
  const targets = stressTargets(c, [link], issues, NORTHBEAM_PROCESS_ID);
  const conditions = stressConditions(demoMarket().marketConditions).filter((x) => ["stable", "downturn"].includes(x.preset ?? ""));
  const run = (): StressRow[] => {
    const rows: StressRow[] = [];
    runStress({ base: baseModel, solved, conditions, targets, reps: 6, seed: 1 }, (r) => rows.push(r));
    return rows;
  };

  it("hands back a row per condition, in order, as each is done", () => {
    const rows = run();
    expect(rows.map((r) => r.name)).toEqual(["Stable", "Downturn"]);
    for (const r of rows) {
      expect(r.verdicts).toHaveLength(1);
      expect(["pass", "fail", "unchecked"]).toContain(r.verdicts[0]!.status);
      expect(r.mrr.live).toBeGreaterThan(0);
      expect(r.mrr.solution).toBeGreaterThan(0);
    }
    // The market changes the numbers: a downturn bills less than a stable market.
    expect(rows[1]!.mrr.solution).toBeLessThan(rows[0]!.mrr.solution);
  });

  it("uses the same goal reading and verdict as the Editor and the server", () => {
    const stable = run()[0]!;
    const model = withMarketCondition(solved, STABLE_MARKET);
    const direct = checkTarget({ target: targets[0]!.target, model, result: simulate(model, 6, 1), area: targets[0]!.area });
    expect(stable.verdicts[0]).toMatchObject({ status: direct.status, holdsPct: direct.holdsPct, note: direct.note });
  });

  it("gives the same answer every time", () => {
    expect(run()).toEqual(run());
  });

  it("runs the models as they are for the schedule row, not a flat market", () => {
    const rows: StressRow[] = [];
    runStress({ base: baseModel, solved, conditions: [{ key: SCHEDULE_KEY, name: "Your schedule", preset: null, factors: null }], targets, reps: 6, seed: 1 }, (r) => rows.push(r));
    const direct = simulate(solved, 6, 1);
    const v = checkTarget({ target: targets[0]!.target, model: solved, result: direct, area: targets[0]!.area });
    expect(rows[0]!.verdicts[0]).toMatchObject({ status: v.status, holdsPct: v.holdsPct, note: v.note });
  });

  it("is keyed by content: the same targets and conditions in new arrays are the same request, so a re-render doesn't restart it", () => {
    expect(stressKey(targets, conditions)).toBe(stressKey(structuredClone(targets), structuredClone(conditions)));
    expect(stressKey(targets, conditions)).not.toBe(stressKey(targets, conditions.slice(1)));
    const hook = readFileSync(join(__dirname, "..", "src", "lib", "solutions", "use-stress.ts"), "utf8");
    // The run starts on the key, not on the arrays; the old rows are cleared when a new request starts; the worker is stopped on an error.
    expect(hook).toContain("stressKey(targets, conditions)");
    expect(hook).toMatch(/\[base, solved, key, reps, seed\]/);
    expect(hook).toMatch(/onerror[\s\S]*stop\(\)/);
    expect(hook).toMatch(/\? held\.value : WAITING/);
  });
});

describe("the demo marks an AI solution as an AI block", () => {
  it("records the solution once", () => {
    expect(demoSolutionsNow().aiIds).not.toContain("sol-direct");
    markDemoSolutionAi("sol-direct");
    expect(demoSolutionsNow().aiIds).toContain("sol-direct");
    markDemoSolutionAi("sol-direct");
    expect(demoSolutionsNow().aiIds.filter((i) => i === "sol-direct")).toHaveLength(1);
    expect(solutionType({ id: "sol-direct" }, demoSolutionsNow().aiIds)).toBe("AI block");
  });
});

describe("the solution's type", () => {
  it("reads AI block for a solution built from an AI idea, and By hand otherwise or when nothing is known", () => {
    expect(solutionType({ id: "s1" }, ["s1"])).toBe("AI block");
    expect(solutionType({ id: "s2" }, ["s1"])).toBe("By hand");
    expect(solutionType({ id: "s1" })).toBe("By hand");
  });
});

describe("the revenue chart with a second line", () => {
  const points = [0, 1, 2].map((m) => ({ month: m, mean: 1000 + m * 100, lo: 900 + m * 100, hi: 1100 + m * 100 }));
  it("draws the solution's line and carries its numbers for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(MrrChart, { points, compare: points.map((p) => ({ ...p, mean: p.mean + 50 })), horizonMonths: 2, currency: "GBP", compareName: "With solution" }));
    expect(html).toContain("data-compare-line");
    expect(html).toContain("With solution");
    expect(renderToStaticMarkup(createElement(MrrChart, { points, horizonMonths: 2, currency: "GBP" }))).not.toContain("data-compare-line");
  });
});
