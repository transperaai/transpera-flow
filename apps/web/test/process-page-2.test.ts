import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { simulate, type EngineModel, type EngineStep } from "@transpera-flow/engine";
import type { IssueRow, SolutionIssueRow, SolutionRow, StepRow } from "@transpera-flow/db";
import { AboutProcess } from "@/components/about-process";
import { IssueTrackView } from "@/components/issue-track";
import { CycleSpreadPanel, KeyPersonPanel, ReworkLoopsPanel, TimeSplit } from "@/components/process-supporting-data";
import { aboutLine, citedNumbers, ownerOf, type About } from "@/lib/process-page/about";
import { cycleSpread, keyPersonRows, loopRows, timeSplitRows } from "@/lib/process-page/supporting";
import { linkedSolutions, otherImprovements, trackOf, TRACK_STAGES } from "@/lib/process-page/track";

// Issue #174, part 2: the process page's About line, the issue status track, "Other improvements" and the supporting data
// (time split, cycle spread, key-person risk, rework loops), as pure functions and as rendered markup.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

const sol = (id: string, extra: Partial<SolutionRow> = {}): SolutionRow => ({
  id,
  workspace_id: "w",
  process_id: "p1",
  base_revision_id: "r",
  name: `Solution ${id}`,
  notes: "",
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
  it("an AI idea waiting, or a solution with no verdict yet, is a Solution idea", () => {
    expect(trackOf(issue("open"), [], true).stage).toBe(1);
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
  const about: About = {
    type: "Pipeline",
    owner: "Maya Collins",
    steps: 6,
    roles: 3,
    trail: ["Sales"],
    version: 4,
    draft: true,
    sources: 2,
    cited: { cited: 3, of: 4 },
    lastChange: { at: "2026-09-29T10:00:00Z", by: "Maya Collins" },
  };
  it("reads as plain attributes", () => {
    expect(aboutLine(about)).toEqual([
      { label: "Type", value: "Pipeline" },
      { label: "Requirements owner", value: "Maya Collins" },
      { label: "Size", value: "6 steps, 3 roles" },
      { label: "On the company map", value: "Inside Sales" },
      { label: "Version", value: "Live is version 4, draft open" },
      { label: "Sources", value: "2 sources, 3 of 4 step numbers cited" },
      { label: "Last published", value: "29 Sep 2026 by Maya Collins" },
    ]);
  });
  it("says so when things are missing", () => {
    const rows = aboutLine({ ...about, owner: null, trail: [], version: null, draft: false, sources: 0, cited: null, lastChange: null, steps: 1, roles: 1 });
    expect(rows.map((r) => r.value)).toEqual(["Pipeline", "Not named yet", "1 step, 1 role", "Top level", "Not published yet", "None linked", "Not published yet"]);
    expect(aboutLine({ ...about, sources: null }).some((r) => r.label === "Sources")).toBe(false);
    expect(aboutLine({ ...about, lastChange: null }).at(-1)).toEqual({ label: "Last published", value: "Not recorded" });
  });
  it("counts cited step numbers out of all of them, whether or not an origin is recorded", () => {
    const st = (id: string, provenance: StepRow["provenance"] = {}, kind: StepRow["kind"] = "task") => ({ id, kind, child_process_id: null, provenance });
    expect(citedNumbers([], [])).toBeNull();
    // Ten steps carry thirty numbers; one has a cited source: 1 of 30.
    const ten = Array.from({ length: 10 }, (_, i) => st(`s${i}`, i === 0 ? { work_hours: { source: "entered", evidence: [{ source_id: "s", quote: "q" } as never] } } : {}));
    expect(citedNumbers(ten, [])).toEqual({ cited: 1, of: 30 });
    // Measured data counts; an estimate or an empty list of evidence does not; start and end steps carry no numbers.
    const mixed = [
      st("a", { work_hours: { source: "measured" }, wait_hours: { source: "estimated" }, rework_rate: { source: "entered", evidence: [] } }),
      st("start", {}, "start"),
      st("end", {}, "end"),
    ];
    expect(citedNumbers(mixed, [])).toEqual({ cited: 1, of: 3 });
    // A step with two ways out also counts its branch odds.
    const split = [st("a", { branch_odds: { source: "measured" } })];
    expect(citedNumbers(split, [{ from_step_id: "a" }, { from_step_id: "a" }])).toEqual({ cited: 1, of: 4 });
    expect(citedNumbers(split, [{ from_step_id: "a" }])).toEqual({ cited: 0, of: 3 });
  });
  it("names the owner most requirements name, both when two tie, and shared when more", () => {
    const req = (id: string | null, text = "") => ({ text: "", owner_person_id: id, owner_text: text, why: "", verdict: "keep" as const, step_id: null });
    const who = (id: string) => ({ a: "Rosa Diaz", b: "Maya Collins", c: "Priya Shah" })[id] ?? null;
    expect(ownerOf({ requirements: [req("a"), req(null, "Finance"), req("a")] } as never, who)).toBe("Rosa Diaz");
    expect(ownerOf({ requirements: [req("a"), req("b")] } as never, who)).toBe("Maya Collins and Rosa Diaz");
    expect(ownerOf({ requirements: [req("a"), req("b"), req("c")] } as never, who)).toBe("Shared");
    expect(ownerOf(null, () => null)).toBeNull();
  });
  it("renders in a labelled section with no (i)", () => {
    const html = renderToStaticMarkup(createElement(AboutProcess, { about }));
    expect(html).toContain("About this process");
    expect(html).toContain("Live is version 4, draft open");
    expect(read("components/about-process.tsx")).not.toContain("<Help");
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
  it("gives the cycle time's median and 90th percentile", () => {
    const s = cycleSpread(result)!;
    expect(s.p90).toBeGreaterThanOrEqual(s.p50);
    expect(s.ratio).toBeCloseTo(s.p90 / s.p50, 9);
    expect(cycleSpread(null)).toBeNull();
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
  it("makes a row per rework loop with its cost, and the issues and solutions on its steps", () => {
    const i = { id: "i1", number: 7, title: "Reviews bounce", status: "open", process_id: "p1", step_id: "review", links: [{ process_id: "p1", step_id: "review" }] } as unknown as IssueRow;
    const done = { ...i, id: "i2", number: 8, status: "resolved" } as IssueRow;
    const rows = loopRows(model, result, { processId: "p1", stepIds: ids, issues: [i, done], solutions: [{ id: "a", name: "Solution a", process_id: "p1", changed_step_ids: ["draft"] }] });
    expect(rows.map((r) => r.kind).sort()).toEqual(["back-edge", "redo"]);
    const back = rows.find((r) => r.kind === "back-edge")!;
    expect(back.title).toBe("REVIEW sends work back to DRAFT");
    expect(back.steps).toEqual(["DRAFT", "REVIEW"]);
    expect(back.share.mean).toBeGreaterThan(0.1);
    expect(back.hoursPerMonth.mean).toBeGreaterThan(0);
    expect(back.issues.map((x) => x.id)).toEqual(["i1"]);
    expect(back.solutions).toEqual([{ id: "a", name: "Solution a" }]);
    expect(rows[0]!.hoursPerMonth.mean).toBeGreaterThanOrEqual(rows[1]!.hoursPerMonth.mean);
    expect(loopRows(model, null, { processId: "p1", stepIds: ids, issues: [], solutions: [] })).toEqual([]);
  });
  it("stays quiet when nothing loops", () => {
    const straight = { ...model, steps: [step("draft", [{ to: "review", p: 1 }]), step("review", [{ to: "done", p: 1 }])] };
    expect(loopRows(straight, simulate(straight, 3, 1), { processId: "p1", stepIds: ids, issues: [], solutions: [] })).toEqual([]);
  });
});

describe("the supporting data panels", () => {
  const rows = loopRows(model, result, { processId: "p1", stepIds: ids, issues: [], solutions: [] });
  const html = renderToStaticMarkup(
    createElement("div", null, [
      createElement(TimeSplit, { key: 1, rows: timeSplitRows(model, result, ids), result }),
      createElement(CycleSpreadPanel, { key: 2, spread: cycleSpread(result), hoursPerWeek: 40, result }),
      createElement(KeyPersonPanel, { key: 3, rows: [{ id: "draft", step: "Draft", person: "Pat", placeholder: false }, { id: "x", step: "Send", person: null, placeholder: false }, { id: "y", step: "Check", person: "Reviewer 1", placeholder: true }], result }),
      createElement(ReworkLoopsPanel, { key: 4, rows, result, hoursPerWeek: 40, base: "/demo" }),
    ]),
  );
  it("shows all four panels with plain headings", () => {
    for (const h of ["Time split per step", "Cycle time spread", "Key-person risk per step", "Rework loops"]) expect(html).toContain(h);
    expect(html).toContain("Hands-on");
    expect(html).toContain("Typical (median)");
    expect(html).toContain("Pat");
    expect(html).toContain("Nobody can do it");
    expect(html).toContain("Reviewer 1");
    expect(html).toContain("placeholder, no named person");
    expect(html).toContain("Waiting on others (hatched)");
    expect(html).toContain("REVIEW sends work back to DRAFT");
    expect(html).toContain("Redo at REVIEW");
  });
  it("words a loop that never happens and a cycle with a zero median plainly", () => {
    const never = { ...rows[0]!, share: { mean: 0, p10: 0, p90: 0 } };
    expect(renderToStaticMarkup(createElement(ReworkLoopsPanel, { rows: [never], result, hoursPerWeek: 40, base: "/demo" }))).toContain("Never in this run");
    const zero = renderToStaticMarkup(createElement(CycleSpreadPanel, { spread: { p50: 0, p90: 20, ratio: 0 }, hoursPerWeek: 40, result }));
    expect(zero).toContain("Most items finish straight away");
    expect(zero).not.toContain("about as long");
  });
  it("says what is missing instead of an empty chart", () => {
    const empty = renderToStaticMarkup(createElement(ReworkLoopsPanel, { rows: [], result, hoursPerWeek: 40, base: "/demo" }));
    expect(empty).toContain("Nothing goes back to an earlier step.");
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
  it("runs About, First principles, Map, Insights, Issues and solutions, Supporting data, then Sources", () => {
    const order = ["<AboutProcess", 'id="first-principles"', 'id="map"', 'id="insights"', 'id="issues"', 'id="supporting-data"', "<ProcessSources"].map(at);
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
