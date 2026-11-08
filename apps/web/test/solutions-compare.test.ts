import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamStepIds as ids, type SolutionRow } from "@transpera-flow/db";
import { MrrChart } from "@/components/overview/charts";
import { solutionCopy } from "@/lib/solutions/bundle";
import { compareMaps } from "@/lib/solutions/compare";
import { demoBundle } from "@/lib/sources/demo";

// The Solution page's two maps (issue #115, A50; Q12, D44). The measures, the stress test and their
// runner were taken off the page, and their tests with them.

const base = demoBundle();
const edited = { ...base, steps: base.steps.map((s) => (s.id === ids.audit ? { ...s, work_hours: 2, work_dist: "constant" as const } : s)) };
const stamp = "2026-10-05T10:00:00.000Z";
const solution: SolutionRow = {
  id: "00000000-0000-4000-8000-0000000000aa",
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  process_id: NORTHBEAM_PROCESS_ID,
  base_revision_id: base.revision.id,
  name: "Faster audit",
  notes: "",
  status: "testing",
  steps: solutionCopy(edited),
  changed_step_ids: [ids.audit],
  lever_changes: [],
  step_changes: [],
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

describe("the revenue chart with a second line", () => {
  const points = [0, 1, 2].map((m) => ({ month: m, mean: 1000 + m * 100, lo: 900 + m * 100, hi: 1100 + m * 100 }));
  it("draws the solution's line and carries its numbers for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(MrrChart, { points, compare: points.map((p) => ({ ...p, mean: p.mean + 50 })), horizonMonths: 2, currency: "GBP", compareName: "With solution" }));
    expect(html).toContain("data-compare-line");
    expect(html).toContain("With solution");
    expect(renderToStaticMarkup(createElement(MrrChart, { points, horizonMonths: 2, currency: "GBP" }))).not.toContain("data-compare-line");
  });
});
