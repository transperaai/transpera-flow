import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { simulate, type EngineModel, type EngineStep } from "@transpera-flow/engine";
import type { IssueRow, SolutionIssueRow, SolutionRow } from "@transpera-flow/db";
import { ProcessHeader } from "@/components/process-header";
import { IssueTrackView } from "@/components/issue-track";
import { KeyPersonPanel, TimeSplit } from "@/components/process-supporting-data";
import { aboutLine, aboutSummary, type About } from "@/lib/process-page/about";
import { keyPersonRows, timeSplitRows } from "@/lib/process-page/supporting";
import { linkedSolutions, otherImprovements, trackOf, TRACK_STAGES } from "@/lib/process-page/track";

// Issue #174, part 2: the process page's About line, the issue status track, "Other improvements" and the supporting data
// (time split and key-person risk; the hours panels are in process-hours.test.ts), as pure functions and as rendered markup.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

const sol = (id: string, extra: Partial<SolutionRow> = {}): SolutionRow => ({
  id,
  workspace_id: "w",
  process_id: "p1",
  base_revision_id: "r",
  name: `Solution ${id}`,
  notes: "",
  status: "testing",
  steps: { steps: [], edges: [], entry_step_id: null },
  changed_step_ids: [],
  lever_changes: [],
  created_at: `2026-10-0${id.length}T00:00:00Z`,
  updated_at: "",
  created_by: null,
  ...extra,
});
const link = (solution_id: string, issue_id: string, extra: Partial<SolutionIssueRow> = {}): SolutionIssueRow => ({
  solution_id,
  issue_id,
  workspace_id: "w",
  auto_verdict: null,
  holds_pct: null,
  auto_note: "",
  user_verdict: null,
  user_notes: "",
  created_at: "",
  updated_at: "",
  created_by: null,
  ...extra,
});
const issue = (status: IssueRow["status"], resolved_how: IssueRow["resolved_how"] = null, resolved_solution_id: string | null = null) => ({ status, resolved_how, resolved_solution_id });

describe("the issue status track", () => {
  it("has the five stages in order", () => {
    expect([...TRACK_STAGES]).toEqual(["Open", "Solution idea", "Being built", "Implemented", "Verified"]);
  });
  it("an open issue with nothing proposed is at Open", () => {
    expect(trackOf(issue("open"), []).stage).toBe(0);
  });
  it("a solution with no verdict yet is a Solution idea", () => {
    const data = { solutions: [sol("a")], links: [link("a", "i")] };
    expect(trackOf(issue("open"), linkedSolutions(data, "i")).stage).toBe(1);
  });
  it("a solution with a verdict, or the Testing solutions status, is Being built", () => {
    const data = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "fail" })] };
    expect(trackOf(issue("open"), linkedSolutions(data, "i")).stage).toBe(2);
    expect(trackOf(issue("testing"), []).stage).toBe(2);
  });
  it("a resolved issue is Implemented, and Verified once the solution it was resolved by passed", () => {
    expect(trackOf(issue("resolved", "process_change"), []).stage).toBe(3);
    const failed = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "pass", user_verdict: "fail" })] };
    expect(trackOf(issue("resolved", "solution", "a"), linkedSolutions(failed, "i")).stage).toBe(3);
    const passed = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "pass", holds_pct: 92 })] };
    const t = trackOf(issue("resolved", "solution", "a"), linkedSolutions(passed, "i"));
    expect(t.stage).toBe(4);
    expect(t.verified?.holdsPct).toBe(92);
  });
  it("a pass by a solution that did not fix the issue does not verify it", () => {
    const data = { solutions: [sol("a"), sol("bb")], links: [link("a", "i", { auto_verdict: "fail" }), link("bb", "i", { auto_verdict: "pass" })] };
    const t = trackOf(issue("resolved", "solution", "a"), linkedSolutions(data, "i"));
    expect(t.stage).toBe(3);
    expect(t.verified).toBeNull();
    // Resolved by a solution with none picked, or by a change to the process: nothing to verify against.
    expect(trackOf(issue("resolved", "solution", null), linkedSolutions(data, "i")).stage).toBe(3);
    expect(trackOf(issue("resolved", "process_change", "bb"), linkedSolutions(data, "i")).stage).toBe(3);
  });
  it("a person's Pass over a simulation Fail verifies, and shows both", () => {
    const data = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "fail", holds_pct: 20, user_verdict: "pass" })] };
    const t = trackOf(issue("resolved", "solution", "a"), linkedSolutions(data, "i"));
    expect(t.stage).toBe(4);
    expect(t.verified?.solution.id).toBe("a");
    const html = renderToStaticMarkup(createElement(IssueTrackView, { track: t, base: "/demo" }));
    expect(html).toMatch(/Pass.*\(your verdict\).*simulation: holds in 20% of runs/);
    // A person's Pass where the simulation could not check it, or agreed, is a plain verified pass.
    const unchecked = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: null, user_verdict: "pass" })] };
    expect(trackOf(issue("resolved", "solution", "a"), linkedSolutions(unchecked, "i")).stage).toBe(4);
  });
  it("won't fix and not a problem leave the track", () => {
    expect(trackOf(issue("wont_fix"), [])).toMatchObject({ stage: null, closed: "wont_fix" });
    expect(trackOf(issue("resolved", "not_a_problem"), [])).toMatchObject({ stage: null, closed: "not_a_problem" });
  });
  it("lists linked solutions newest first, and the rest as Other improvements", () => {
    const data = { solutions: [sol("a"), sol("bb"), sol("ccc"), sol("d", { process_id: "p2" })], links: [link("a", "i"), link("bb", "i")] };
    expect(linkedSolutions(data, "i").map((s) => s.solution.id)).toEqual(["bb", "a"]);
    expect(otherImprovements(data, "p1").solutions.map((s) => s.id)).toEqual(["ccc"]);
  });

  it("renders the track with the current stage marked, the verdict and a build link", () => {
    const data = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "pass", holds_pct: 90 })] };
    const done = renderToStaticMarkup(createElement(IssueTrackView, { track: trackOf(issue("resolved", "solution", "a"), linkedSolutions(data, "i")), base: "/demo" }));
    for (const label of TRACK_STAGES) expect(done).toContain(label);
    expect(done).toContain('data-state="here"');
    expect(done).toContain("Before and after");
    expect(done).toContain("holds in 90% of runs");
    expect(done).toContain("/demo/solutions/a");
    const open = renderToStaticMarkup(createElement(IssueTrackView, { track: trackOf(issue("open"), []), base: "/w/x", buildHref: "/w/x/p/p1/edit?mode=solution" }));
    expect(open).toContain("✎ Build solution");
    const closed = renderToStaticMarkup(createElement(IssueTrackView, { track: trackOf(issue("wont_fix"), []), base: "/w/x" }));
    expect(closed).toContain("Won&#x27;t fix");
    expect(closed).not.toContain("data-stage");
  });
});

describe("About this process", () => {
  const about: About = { category: "sales", steps: 6, roles: 3, version: 4 };
  it("reads as plain attributes, with the version as a bare number", () => {
    expect(aboutLine(about)).toEqual([
      { label: "Type", value: "Sales" },
      { label: "Size", value: "6 steps, 3 roles" },
      { label: "Version", value: "4" },
    ]);
  });
  it("says so when there is no live version", () => {
    const rows = aboutLine({ ...about, version: null, steps: 1, roles: 1 });
    expect(rows.map((r) => r.value)).toEqual(["Sales", "1 step, 1 role", "Not published yet"]);
  });
  it("no longer shows the company map trail, sources or last published", () => {
    const labels = aboutLine(about).map((r) => r.label);
    expect(labels).not.toContain("On the company map");
    expect(labels).not.toContain("Sources");
    expect(labels).not.toContain("Last published");
  });
  it("says the same in one muted line under the title", () => {
    expect(aboutSummary(about)).toBe("6 steps · 3 roles · Version 4");
    expect(aboutSummary({ ...about, version: null, steps: 1, roles: 1 })).toBe("1 step · 1 role · Draft, not published yet");
  });
  const header = (props: Partial<Parameters<typeof ProcessHeader>[0]> = {}) =>
    renderToStaticMarkup(createElement(ProcessHeader, { name: "Lead to live", about, actions: createElement("span", null, "actions"), ...props }));
  it("is the page title with the category and department as pills, and the summary line, with no (i)", () => {
    const html = header({ department: { value: null, options: [], workedOut: "Sales", current: "Performance", chosen: false } });
    expect(html).toContain("<h1");
    expect(html).toContain("Lead to live");
    expect(html).toContain("Sales");
    expect(html).toContain("Performance");
    expect(html).toContain("6 steps · 3 roles · Version 4");
    expect(html).not.toContain("About this process");
    expect(read("components/process-header.tsx")).not.toContain("<Help");
  });
  it("gives a reader the pills only, and someone who can edit a pencil that opens the Type and Department selects", () => {
    const reader = header();
    expect(reader).not.toContain("data-process-edit");
    expect(reader).not.toContain("<select");
    const editor = header({ editCategory: async () => ({ status: "ok" as const }) });
    expect(editor).toContain("data-process-edit");
    expect(editor).toContain("Edit type and department");
    // The selects live in the popover, which opens on a click (the browser test of the page covers that).
    const src = read("components/process-header.tsx");
    expect(src).toContain("PROCESS_CATEGORIES.map");
    expect(src).toContain("{departmentEditor}");
    expect(read("components/process-page.tsx")).toMatch(/departmentEditor=\{department && mode === "live" \? <ProcessDepartmentField/);
  });
});

// A small process: Draft (Pat only) -> Review -> back to Draft 40% of the time, Review redoes itself sometimes.
type Next = EngineStep["next"];
const step = (id: string, next: Next, extra: Partial<EngineStep> = {}): EngineStep => ({ id, name: id.toUpperCase(), role: "r", work: 2, wait: 1, rework: 0, workDist: { kind: "constant" }, next, ...extra });
const model: EngineModel = {
  horizonWeeks: 26,
  hoursPerWeek: 40,
  leadsPerWeek: 2,
  activeClients: 0,
  churnMonthly: 0,
  retainer: 0,
  roles: { r: { name: "R", count: 3, cost: 10, ongoing: 0 } },
  entry: "draft",
  sinks: { won: "done", lost: "lost" },
  steps: [
    step("draft", [{ to: "review", p: 1 }]),
    step("review", [{ to: "draft", p: 0.4 }, { to: "done", p: 0.6 }], { rework: 0.2 }),
  ],
};
const ids = new Set(["draft", "review"]);
const result = simulate(model, 8, 3);

describe("the supporting data", () => {
  it("splits each step's time into hands-on and waiting, most total time first", () => {
    const rows = timeSplitRows(model, result, ids);
    expect(rows.map((r) => r.id).sort()).toEqual(["draft", "review"]);
    for (const r of rows) {
      expect(r.total).toBeCloseTo(r.handsOn + r.waitingForPerson + r.fixedWait, 9);
      expect(r.handsOnShare).toBeGreaterThan(0);
      expect(r.handsOnShare).toBeLessThanOrEqual(1);
    }
    expect(rows[0]!.total).toBeGreaterThanOrEqual(rows[1]!.total);
    expect(timeSplitRows(model, null, ids)).toEqual([]);
    expect(timeSplitRows(model, result, new Set())).toEqual([]);
  });
  it("lists the steps one person can do, and steps nobody can", () => {
    const one: EngineModel = {
      ...model,
      roles: { r: { name: "R", count: 3, cost: 10, ongoing: 0 }, solo: { name: "Solo", count: 1, cost: 10, ongoing: 0 } },
      steps: [step("draft", [{ to: "review", p: 1 }], { role: "solo" }), step("review", [{ to: "done", p: 1 }])],
    };
    const r = simulate(one, 3, 1);
    const rows = keyPersonRows(one, r, ids);
    expect(rows.map((x) => x.id)).toEqual(["draft"]);
    // No named people here, so the name is the engine's own ("Solo 1"), flagged as a placeholder.
    expect(rows[0]!.placeholder).toBe(true);
    expect(rows[0]!.person).toBeTruthy();
    expect(keyPersonRows(model, simulate(model, 3, 1), ids)).toEqual([]);
  });
});

describe("the supporting data panels", () => {
  const html = renderToStaticMarkup(
    createElement("div", null, [
      createElement(TimeSplit, { key: 1, rows: timeSplitRows(model, result, ids), result }),
      createElement(KeyPersonPanel, { key: 3, rows: [{ id: "draft", step: "Draft", person: "Pat", placeholder: false }, { id: "x", step: "Send", person: null, placeholder: false }, { id: "y", step: "Check", person: "Reviewer 1", placeholder: true }], result }),
    ]),
  );
  it("shows the time split and key-person panels with plain headings, and says what the time split shows", () => {
    for (const h of ["Time split per step", "Key-person risk per step"]) expect(html).toContain(h);
    expect(html).toContain("Hands-on work against waiting (for a person, or on others), for one visit to the step.");
    for (const gone of ["Cycle time spread", "Rework loops"]) expect(html).not.toContain(gone);
    expect(html).toContain("Hands-on");
    expect(html).toContain("Pat");
    expect(html).toContain("Nobody can do it");
    expect(html).toContain("Reviewer 1");
    expect(html).toContain("placeholder, no named person");
    expect(html).toContain("Waiting on others (hatched)");
  });
  it("says what is missing instead of an empty chart", () => {
    expect(renderToStaticMarkup(createElement(TimeSplit, { rows: [], result: null }))).toContain("Simulating");
    expect(renderToStaticMarkup(createElement(KeyPersonPanel, { rows: [], result }))).toContain("No step depends on one person.");
  });
  it("the new panels add no (i)s", () => {
    expect(read("components/process-supporting-data.tsx")).not.toContain("<Help");
    expect(read("components/issue-track.tsx")).not.toContain("<Help");
  });
});

describe("the process page layout", () => {
  const page = read("components/process-page.tsx");
  const at = (s: string) => page.indexOf(s);
  it("runs the header, Process map, What the run shows (facts, then the supporting panels), Issues and solutions, then Sources", () => {
    const order = ["<ProcessHeader", 'id="map"', 'id="run"', 'id="facts"', 'id="supporting-data"', "issuesUi.issuesList", "<ProcessSources"].map(at);
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(page).toContain("Other improvements");
    expect(page).not.toContain('title="Solutions"');
  });
  it("keeps what QA wave 1 removed out", () => {
    for (const gone of ["HeadlineCards", "HorizonPicker", "LeverPanel", 'id="projection"']) expect(page).not.toContain(gone);
    expect((page.match(/<Help\b/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});
