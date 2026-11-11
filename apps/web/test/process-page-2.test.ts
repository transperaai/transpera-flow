import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { simulate, type EngineModel, type EngineStep } from "@transpera-flow/engine";
import { northbeamIssues, type IssueRow, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import type { RegisterEntry } from "@/lib/issues/register";
import { IssuesCard } from "@/components/process-issues-card";
import { ProcessHeader } from "@/components/process-header";
import { IssueTrackView } from "@/components/issue-track";
import { KeyPersonPanel, TimeSplit } from "@/components/process-supporting-data";
import { aboutLine, aboutSummary, type About } from "@/lib/process-page/about";
import { keyPersonGroups, keyPersonRows, timeSplitRows, timeSplitSummary, type KeyPersonRow, type TimeSplitRow } from "@/lib/process-page/supporting";
import { issueGroups, linkedSolutions, otherImprovements, solvedBy, trackOf, TRACK_STAGES } from "@/lib/process-page/track";

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
  step_changes: [],
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
    const data = { solutions: [sol("a")], links: [link("a", "i", { user_verdict: "fail" })] };
    expect(trackOf(issue("open"), linkedSolutions(data, "i")).stage).toBe(2);
    expect(trackOf(issue("testing"), []).stage).toBe(2);
  });
  it("a resolved issue is Implemented, and Verified once the solution it was resolved by passed", () => {
    expect(trackOf(issue("resolved", "process_change"), []).stage).toBe(3);
    const failed = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "pass", user_verdict: "fail" })] };
    expect(trackOf(issue("resolved", "solution", "a"), linkedSolutions(failed, "i")).stage).toBe(3);
    const passed = { solutions: [sol("a")], links: [link("a", "i", { user_verdict: "pass" })] };
    const t = trackOf(issue("resolved", "solution", "a"), linkedSolutions(passed, "i"));
    expect(t.stage).toBe(4);
  });
  it("a pass by a solution that did not fix the issue does not verify it", () => {
    const data = { solutions: [sol("a"), sol("bb")], links: [link("a", "i", { user_verdict: "fail" }), link("bb", "i", { user_verdict: "pass" })] };
    const t = trackOf(issue("resolved", "solution", "a"), linkedSolutions(data, "i"));
    expect(t.stage).toBe(3);
    expect(t.verified).toBeNull();
    // Resolved by a solution with none picked, or by a change to the process: nothing to verify against.
    expect(trackOf(issue("resolved", "solution", null), linkedSolutions(data, "i")).stage).toBe(3);
    expect(trackOf(issue("resolved", "process_change", "bb"), linkedSolutions(data, "i")).stage).toBe(3);
  });
  it("only the person's verdict counts: an automatic pass stored before QA round 2 verifies nothing", () => {
    const data = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "fail", holds_pct: 20, user_verdict: "pass" })] };
    const t = trackOf(issue("resolved", "solution", "a"), linkedSolutions(data, "i"));
    expect(t.stage).toBe(4);
    expect(t.verified?.solution.id).toBe("a");
    const html = renderToStaticMarkup(createElement(IssueTrackView, { track: t, base: "/demo" }));
    expect(html).toMatch(/Pass.*\(your verdict\)/);
    expect(html).not.toMatch(/holds in|simulation:/);
    const autoOnly = { solutions: [sol("a")], links: [link("a", "i", { auto_verdict: "pass", user_verdict: null })] };
    expect(trackOf(issue("resolved", "solution", "a"), linkedSolutions(autoOnly, "i")).stage).toBe(3);
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
    const data = { solutions: [sol("a")], links: [link("a", "i", { user_verdict: "pass" })] };
    const done = renderToStaticMarkup(createElement(IssueTrackView, { track: trackOf(issue("resolved", "solution", "a"), linkedSolutions(data, "i")), base: "/demo" }));
    for (const label of TRACK_STAGES) expect(done).toContain(label);
    expect(done).toContain('data-state="here"');
    expect(done).toContain("Before and after");
    expect(done).not.toContain("holds in");
    expect(done).toContain("/demo/solutions/a");
    const open = renderToStaticMarkup(createElement(IssueTrackView, { track: trackOf(issue("open"), []), base: "/w/x", buildHref: "/w/x/p/p1/edit?mode=solution" }));
    expect(open).toContain("✎ Build solution");
    const closed = renderToStaticMarkup(createElement(IssueTrackView, { track: trackOf(issue("wont_fix"), []), base: "/w/x" }));
    expect(closed).toContain("Won&#x27;t fix");
    expect(closed).not.toContain("data-stage");
  });
});

describe("Issues and solutions: current issues, then solved ones as their solution", () => {
  const full = (n: number, extra: Partial<IssueRow>): IssueRow => ({ ...northbeamIssues()[0]!, id: `00000000-0000-4000-8000-00000000000${n}`, number: n, owner_ids: [], owner_person_id: null, resolution_note: null, ...extra });
  const open = full(1, { title: "Slow approvals", status: "open" });
  const testing = full(2, { title: "Decks rebuilt every time", status: "testing" });
  const bySolution = full(3, { title: "Access takes weeks", status: "resolved", resolved_how: "solution", resolved_solution_id: "a", resolved_at: "2026-10-05T09:00:00Z" });
  const noSolution = full(4, { title: "Duplicate invoices", status: "resolved", resolved_how: "process_change", resolved_solution_id: null, resolution_note: "Merged the two billing steps." });
  const wont = full(5, { title: "Clients email at night", status: "wont_fix" });
  const data = { solutions: [sol("a", { name: "Access checklist" }), sol("bb", { name: "Template deck" })], links: [link("a", bySolution.id, { user_verdict: "pass" }), link("bb", testing.id)] };
  const entries: RegisterEntry[] = [open, testing, bySolution, noSolution, wont].map((issue) => ({ kind: "tracked", issue, detection: null }));
  const html = renderToStaticMarkup(
    createElement(IssuesCard, {
      entries,
      names: { step: new Map([["s", "A step"]]), person: new Map() },
      openNew: () => undefined,
      canEdit: true,
      loading: false,
      error: null,
      base: "/demo",
      solutions: data,
      buildHref: () => null,
      other: null,
    }),
  );
  const group = (g: string) => {
    const at = html.indexOf(`data-issue-group="${g}"`);
    return at < 0 ? "" : html.slice(at, html.indexOf("data-issue-group=", at + 20) > 0 ? html.indexOf("data-issue-group=", at + 20) : undefined);
  };

  it("splits the issues into current, solved and won't fix", () => {
    const g = issueGroups([open, testing, bySolution, noSolution, wont], (i) => i.status);
    expect(g.current.map((i) => i.number)).toEqual([1, 2]);
    expect(g.solved.map((i) => i.number)).toEqual([3, 4]);
    expect(g.wontFix.map((i) => i.number)).toEqual([5]);
    expect(solvedBy(bySolution, linkedSolutions(data, bySolution.id))?.solution.id).toBe("a");
    expect(solvedBy(noSolution, linkedSolutions(data, noSolution.id))).toBeNull();
    expect(solvedBy(testing, linkedSolutions(data, testing.id))).toBeNull();
  });
  it("lists the current issues first, each with the solutions tried, and no step names", () => {
    const current = group("current");
    expect(html.indexOf('data-issue-group="current"')).toBeLessThan(html.indexOf('data-issue-group="solved"'));
    expect(current).toContain("Current issues");
    expect(current).toContain("Slow approvals");
    expect(current).toContain("Solution: Template deck");
    expect(current).not.toContain("Access takes weeks");
    expect(html).not.toContain("data-issue-step");
    expect(html).not.toContain("A step");
  });
  it("shows a solved issue as the solution that resolved it, with Solved <issue> under it and the verdict", () => {
    const solved = group("solved");
    expect(solved).toMatch(/<a [^>]*href="\/demo\/solutions\/a"[^>]*>(<span[^>]*>Solution: <\/span>)?Access checklist<\/a>/);
    expect(solved).toMatch(/Solved <a [^>]*href="\/demo\/issues\/[^"]*"[^>]*>.*Access takes weeks<\/a>/);
    expect(solved).toContain('data-solved-verdict');
    expect(solved).toContain('data-verdict="pass"');
  });
  it("shows a solved issue with no solution by its title, how it was resolved and the note", () => {
    const solved = group("solved");
    expect(solved).toContain("Duplicate invoices");
    expect(solved).toContain("We changed the process directly");
    expect(solved).toContain("Merged the two billing steps.");
  });
  it("folds won't fix at the end", () => {
    const wontFix = group("wont_fix");
    expect(wontFix).toMatch(/^data-issue-group="wont_fix"/);
    expect(html).toMatch(/<details[^>]*data-issue-group="wont_fix"/);
    expect(wontFix).toContain("Clients email at night");
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
  it("is the page title with the Live pill and version, the category and department as pills, with no (i): the key numbers are in the details strip, not repeated here", () => {
    const html = header({ department: { value: null, options: [], workedOut: "Sales", current: "Performance", chosen: false } });
    expect(html).toContain("<h1");
    expect(html).toContain("Lead to live");
    expect(html).toContain("Sales");
    expect(html).toContain("Performance");
    expect(html).not.toContain("6 steps · 3 roles");
    expect(html).toMatch(/>Live<\/span>.*Version 4/);
    expect(header({ about: { ...about, version: null } })).toMatch(/>Draft<\/span>.*not published yet/);
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
    expect(rows[0]!.role).toBe("Solo");
    expect(rows[0]!.personId).toContain("solo#");
    expect(keyPersonRows(model, simulate(model, 3, 1), ids)).toEqual([]);
  });
});

describe("the supporting data panels", () => {
  const keyRows: KeyPersonRow[] = [
    { id: "draft", step: "Draft", person: "Pat", personId: "pat", role: "Writer", placeholder: false },
    { id: "plan", step: "Plan", person: "Pat", personId: "pat", role: "Writer", placeholder: false },
    { id: "x", step: "Send", person: null, personId: null, role: null, placeholder: false },
    { id: "y", step: "Check", person: "Reviewer 1", personId: "rev#1", role: "Reviewer", placeholder: true },
  ];
  const stepHours = { steps: [{ id: "draft", label: "Draft", hours: 40, split: null }, { id: "plan", label: "Plan", hours: 22, split: null }, { id: "y", label: "Check", hours: 70, split: null }] };
  const html = renderToStaticMarkup(
    createElement("div", null, [
      createElement(TimeSplit, { key: 1, rows: timeSplitRows(model, result, ids), result }),
      createElement(KeyPersonPanel, { key: 3, rows: keyRows, hours: stepHours, result }),
    ]),
  );
  it("shows the time split as three totals for one visit to each step, then the steps that wait longest", () => {
    expect(html).toContain("Time split per step");
    expect(html).toContain("Hours of hands-on work against hours of waiting, for one visit to each step, added up.");
    for (const gone of ["Cycle time spread", "Rework loops"]) expect(html).not.toContain(gone);
    for (const key of ["hands-on", "waiting-person", "waiting-others"]) expect(html).toContain(`data-time-total="${key}"`);
    expect(html).toContain("summed over the process&#x27;s 2 steps");
    expect(html).toContain("Most waiting");
    expect(html).toContain("data-wait-step");
    expect(html).toContain("How this works");
  });
  it("groups key-person risk by the person, the most hours at stake first, with the worst case as the lead and a Nobody card", () => {
    expect(html).toContain("Key-person risk per step");
    // Reviewer 1 carries 70 h, Pat 62 h: the placeholder is the worst case, and says so.
    expect(html).toMatch(/If <b>Reviewer 1<\/b><span[^>]*> \(a placeholder\)<\/span> is away, <span class="whitespace-nowrap text-crit">70 h a month<\/span> of this process stops\./);
    expect(html).toContain("placeholder, no named person");
    expect(html).toContain("2 steps · 62 h");
    expect(html).toContain("Draft · 40 h");
    expect(html).toContain("Writer");
    expect(html).toContain("Nobody can do it");
    expect(html).toContain('data-key-person="nobody"');
    expect(html.indexOf('data-key-person="rev#1"')).toBeLessThan(html.indexOf('data-key-person="pat"'));
    expect(html).not.toContain("text-white");
  });
  it("says what is missing instead of an empty chart", () => {
    expect(renderToStaticMarkup(createElement(TimeSplit, { rows: [], result: null }))).toContain("Simulating");
    expect(renderToStaticMarkup(createElement(KeyPersonPanel, { rows: [], result }))).toContain("No step depends on one person.");
    expect(renderToStaticMarkup(createElement(KeyPersonPanel, { rows: [keyRows[2]!], result }))).toContain("Nobody can do <span class=\"text-crit\">1 step</span> of this process.");
  });
  it("the new panels add no (i)s", () => {
    expect(read("components/process-supporting-data.tsx")).not.toContain("<Help");
    expect(read("components/issue-track.tsx")).not.toContain("<Help");
  });
});

describe("the time split summary and key-person groups", () => {
  const row = (id: string, handsOn: number, waitingForPerson: number, fixedWait: number, redonePer100: number | null = null): TimeSplitRow => ({
    id,
    label: id,
    handsOn,
    waitingForPerson,
    fixedWait,
    total: handsOn + waitingForPerson + fixedWait,
    handsOnShare: handsOn / (handsOn + waitingForPerson + fixedWait),
    redonePer100,
  });
  it("adds up one visit to each step, and lists the four longest waits, longest first, skipping steps with none", () => {
    const rows = [row("a", 1, 1, 30, 18), row("b", 6, 9, 0), row("c", 2, 0, 0), row("d", 1, 2, 22), row("e", 3, 3, 0), row("f", 1, 1, 0)];
    const s = timeSplitSummary(rows)!;
    expect(s).toMatchObject({ handsOn: 14, waitingForPerson: 16, fixedWait: 52, steps: 6 });
    expect(s.total).toBe(82);
    expect(s.longestWaits.map((r) => r.id)).toEqual(["a", "d", "b", "e"]);
    expect(timeSplitSummary([])).toBeNull();
  });
  it("counts how many visits in 100 to a step are a repeat pass", () => {
    const rows = timeSplitRows(model, result, ids);
    const review = rows.find((r) => r.id === "review")!;
    expect(review.redonePer100).toBe(Math.round((result.steps.review!.reworks / result.steps.review!.departures) * 100));
    expect(review.redonePer100).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === "draft")!.redonePer100).toBe(0);
  });
  it("groups the steps by the one person who can do them, with each step's hours a month", () => {
    const g = keyPersonGroups(
      [
        { id: "s1", step: "One", person: "Ann", personId: "ann", role: null, placeholder: false },
        { id: "s2", step: "Two", person: "Bo", personId: "bo", role: null, placeholder: false },
        { id: "s3", step: "Three", person: "Ann", personId: "ann", role: null, placeholder: false },
        { id: "s4", step: "Four", person: null, personId: null, role: null, placeholder: false },
      ],
      { steps: [{ id: "s1", label: "One", hours: 5, split: null }, { id: "s2", label: "Two", hours: 12, split: null }, { id: "s3", label: "Three", hours: 9, split: null }] },
    );
    expect(g.people.map((p) => [p.person, p.hours, p.steps.map((s) => s.id)])).toEqual([
      ["Ann", 14, ["s3", "s1"]],
      ["Bo", 12, ["s2"]],
    ]);
    expect(g.nobody).toEqual([{ id: "s4", step: "Four" }]);
    expect(keyPersonGroups([], null)).toEqual({ people: [], nobody: [] });
  });
});

describe("the process page layout", () => {
  const page = read("components/process-page.tsx");
  const at = (s: string) => page.indexOf(s);
  it("is the Issue page's detail template: breadcrumb, header, then the map card, What the process shows, Issues and solutions and Sources beside the rail", () => {
    const order = ["<DetailLayout", "breadcrumb=", "<ProcessHeader", "<MetaRail", 'id="map"', "<ProcessCanvas", 'id="run"', 'id="facts"', 'id="supporting-data"', "issuesUi.issuesList", "<ProcessSources"].map(at);
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(page).toContain("Other improvements");
    expect(page).not.toContain('title="Solutions"');
    // The map card is as tall as most of the viewport; its step detail is the map's own, not docked into an inspector.
    expect(page).toContain('className="flex h-[60svh] min-h-[28rem] min-w-0 flex-col"');
    for (const gone of ["stepDetailIn", "<Tabs", "TabsContent", 'id="inspector"', "data-process-workbench", "SidebarTrigger"]) expect(page).not.toContain(gone);
    // The rail: cost a month only where pay is visible (costAMonth is null where it is hidden).
    expect(page).toMatch(/\{monthCost !== null && \(\s*<RailItem term="Cost a month"/);
    expect(read("components/process-issues-card.tsx")).toMatch(/<SectionCard\s+id="issues"/);
    expect(read("components/process-supporting-data.tsx")).toMatch(/<SectionCard id=\{id\} section=\{id\} data-panel=\{id\}/);
  });
  it("puts the process's notes in Sources with the same editable text as a solution's notes, above the linked sources", () => {
    const sources = page.slice(at("function ProcessSources"));
    expect(sources).toContain("<EditableText");
    expect(sources).toContain("data-process-notes");
    expect(sources.indexOf("<EditableText")).toBeLessThan(sources.indexOf("<LinkedSources"));
  });
  it("keeps what QA wave 1 removed out", () => {
    for (const gone of ["HeadlineCards", "HorizonPicker", "LeverPanel", 'id="projection"']) expect(page).not.toContain(gone);
    expect((page.match(/<Help\b/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});
