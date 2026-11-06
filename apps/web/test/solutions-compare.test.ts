import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamStepIds as ids, type SolutionRow } from "@transpera-flow/db";
import { MrrChart } from "@/components/overview/charts";
import { solutionCopy } from "@/lib/solutions/bundle";
import { changeLines } from "@/lib/solutions/changes";
import { compareMaps } from "@/lib/solutions/compare";
import { demoBundle } from "@/lib/sources/demo";

// The Solution page's two maps and its "What it changes" lines (issue #115, A50; Q12, D44). The measures, the stress test and their
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
  created_at: stamp,
  updated_at: stamp,
  created_by: null,
};
const linesOf = (copy: { steps: typeof base.steps; edges: typeof base.edges }) => changeLines(compareMaps(base, { steps: solutionCopy(copy) }));

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

describe("what it changes", () => {
  const audit = base.steps.find((s) => s.id === ids.audit)!;

  it("says nothing differs for a copy that is the live map", () => {
    expect(linesOf({ steps: base.steps, edges: base.edges })).toEqual([]);
  });

  it("says what a changed step changed, in plain words", () => {
    const lines = changeLines(compareMaps(base, solution));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "changed" });
    expect(lines[0]!.text).toContain(`“${audit.name}”`);
    expect(lines[0]!.text).toMatch(/→/);
  });

  it("says a step was added, and a step was removed", () => {
    const extra = { ...audit, id: "00000000-0000-4000-8000-0000000000e1", name: "Second look" };
    const added = linesOf({ steps: [...base.steps, extra], edges: base.edges });
    expect(added).toEqual([{ kind: "added", text: "Added step “Second look”" }]);
    const removed = linesOf({ steps: base.steps.filter((s) => s.id !== ids.audit), edges: base.edges.filter((e) => e.from_step_id !== ids.audit && e.to_step_id !== ids.audit) });
    expect(removed.filter((l) => l.kind === "removed")).toEqual([{ kind: "removed", text: `Removed step “${audit.name}”` }]);
  });

  it("calls two steps taken out and one put in a merge", () => {
    const work = base.steps.filter((s) => s.kind !== "start" && s.kind !== "end");
    const [a, b] = work as [typeof audit, typeof audit];
    const merged = { ...a, id: "00000000-0000-4000-8000-0000000000e2", name: "One step instead of two" };
    const steps = [...base.steps.filter((s) => s.id !== a.id && s.id !== b.id), merged];
    const lines = linesOf({ steps, edges: base.edges.filter((e) => ![a.id, b.id].some((id) => e.from_step_id === id || e.to_step_id === id)) });
    expect(lines.filter((l) => l.kind === "merged")).toEqual([{ kind: "merged", text: `Merged “${a.name}” and “${b.name}” into “One step instead of two”` }]);
    expect(lines.filter((l) => l.kind === "added" || l.kind === "removed")).toEqual([]);
  });

  it("says a step turned into a group, and which steps now do its work, in one line", () => {
    const groupId = "00000000-0000-4000-8000-0000000000f0";
    const kid = (n: number) => ({ ...audit, id: `00000000-0000-4000-8000-0000000000f${n}`, name: `Part ${n}`, parent_step_id: groupId });
    const swap = (id: string) => (id === ids.audit ? groupId : id);
    const live = { ...base, steps: base.steps.map((s) => (s.id === ids.audit ? { ...s, id: groupId } : s)), edges: base.edges.map((e) => ({ ...e, from_step_id: swap(e.from_step_id), to_step_id: swap(e.to_step_id) })) };
    const steps = [...live.steps.map((s) => (s.id === groupId ? { ...s, kind: "group" as const, name: "Approval block", role_id: null, person_id: null, work_hours: 0 } : s)), kid(1), kid(2)];
    expect(changeLines(compareMaps(live, { steps: solutionCopy({ steps, edges: live.edges }) }))).toEqual([
      { kind: "replaced", text: `Replaced “${audit.name}” with the group “Approval block”: Part 1, Part 2` },
    ]);
  });

  it("says when the odds on a route between two steps were changed, and when a route was added or taken out", () => {
    const [edge] = base.edges.filter((e) => base.steps.find((s) => s.id === e.from_step_id)?.kind !== "start" && base.steps.find((s) => s.id === e.to_step_id)?.kind !== "end");
    const odds = linesOf({ steps: base.steps, edges: base.edges.map((e) => (e.id === edge!.id ? { ...e, probability: 0.25 } : e)) });
    expect(odds).toHaveLength(1);
    expect(odds[0]).toMatchObject({ kind: "rerouted" });
    expect(odds[0]!.text).toMatch(/share of the work goes from \d+% to 25%/);
    const gone = linesOf({ steps: base.steps, edges: base.edges.filter((e) => e.id !== edge!.id) });
    expect(gone[0]!.text).toMatch(/^Removed the route from/);
    const added = linesOf({ steps: base.steps, edges: [...base.edges, { ...edge!, id: "00000000-0000-4000-8000-0000000000e3", probability: 0.4 }] });
    expect(added[0]!.text).toMatch(/^New route from .* taking 40% of the work$/);
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
