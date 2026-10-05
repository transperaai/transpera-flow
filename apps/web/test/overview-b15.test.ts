import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamIssues, partOf, toEngineModel, type IssueRow, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import { simulate, type DetectedIssue, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { FindingsByProcess, countsLine } from "@/components/overview/findings-by-process";
import { FlowEfficiencyCard, ImprovementCard, OpenIssuesCard, ProcessHealthCard } from "@/components/overview/health-cards";
import { BeforeAfterChart, IssuesDonut, OpenedResolvedChart, TimeSplitChart } from "@/components/overview/trend-charts";
import { buildInsights } from "@/lib/insights/insights";
import { registerEntries } from "@/lib/issues/register";
import { COMPANY_GROUP, findingsByProcess, groupOfFinding, groupOfIssue } from "@/lib/overview/by-process";
import { countByRating, flowEfficiencyWords, openIssues, openedVersusResolved, timeSplitByProcess, timeSplitOf, workingShare } from "@/lib/overview/health";
import { impactNumbers, impactPairs, improvementDelivered, measureImpact, solutionsToCompare, type SolutionImpact } from "@/lib/overview/impact";
import { playbackRun, rolledUpSteps } from "@/lib/playback/graph";
import { rerate } from "@/lib/rules/edit";
import { solutionCopy } from "@/lib/solutions/bundle";
import { demoBundle } from "@/lib/sources/demo";

// The Overview's B15 redesign (issue #173): the aggregations behind the health strip, the findings by process and the
// trends, and each card and chart rendered with data and empty. The browser behaviour (play, horizon, expand) is in
// overview-browser.test.ts.

const live = demoBundle();
const parts = [partOf(live), ...(live.otherProcesses ?? [])];
const model = toEngineModel(live);
const result = simulate(model, 6, 1);

/** A model and result by hand: two steps, with per-visit times and visits. */
function handMade(): { model: Pick<EngineModel, "steps">; result: Pick<SimulationResult, "steps" | "stepFacts"> } {
  const fact = (handsOnHours: number, queueWaitHours: number, stretchHours: number, fixedWaitHours: number) => ({
    handsOnHours,
    queueWaitHours,
    stretchHours,
    fixedWaitHours,
    handsOnShare: 0,
    keyPerson: null,
    nobodyCanDo: false,
  });
  return {
    model: { steps: [{ id: "a" }, { id: "b" }, { id: "c" }] as EngineModel["steps"] },
    result: {
      steps: { a: { arrivals: 10 }, b: { arrivals: 5 }, c: { arrivals: 0 } } as unknown as SimulationResult["steps"],
      stepFacts: { a: fact(2, 1, 1, 6), b: fact(4, 2, 0, 0), c: fact(100, 0, 0, 0) },
    },
  };
}

describe("flow efficiency", () => {
  it("is hands-on time over all elapsed time at the steps, each step weighted by its visits", () => {
    const { model, result } = handMade();
    const split = timeSplitOf(model, result)!;
    // a: 10 visits × (2 hands-on, 1+1 waiting for a person, 6 on others); b: 5 × (4, 2, 0); c has no visits.
    expect(split).toEqual({ handsOn: 40, waitingForPerson: 30, waitingOnOthers: 60 });
    expect(workingShare(split)).toBeCloseTo(40 / 130);
    expect(timeSplitOf(model, result, new Set(["b"]))).toEqual({ handsOn: 20, waitingForPerson: 10, waitingOnOthers: 0 });
  });
  it("says it in words that add up to 100", () => {
    expect(flowEfficiencyWords(0.184).text).toBe("18% working, 82% waiting");
    expect(flowEfficiencyWords(0.995)).toMatchObject({ working: 100, waiting: 0 });
  });
  it("has nothing to split with no visits, or a run without step facts", () => {
    const { model, result } = handMade();
    expect(workingShare(timeSplitOf(model, result, new Set(["c"]))!)).toBeNull();
    expect(timeSplitOf(model, { steps: result.steps })).toBeNull();
  });
  it("reads a real run, and splits it by process", () => {
    const split = timeSplitOf(model, result)!;
    const share = workingShare(split)!;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(1);
    const rows = timeSplitByProcess(model, result, parts);
    expect(rows.map((r) => r.name)).toEqual(parts.map((p) => p.process.name));
    // The processes' parts add up to the whole.
    expect(rows.reduce((a, r) => a + r.handsOn, 0)).toBeCloseTo(split.handsOn);
  });
});

const issue = (over: Partial<IssueRow>): IssueRow => ({ ...northbeamIssues()[0]!, id: crypto.randomUUID(), detected_key: null, links: [], ...over });

describe("open issues", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const issues = [
    issue({ status: "open", severity: "critical" }),
    issue({ status: "testing", severity: "serious" }),
    issue({ status: "resolved", severity: "serious", resolved_at: "2026-10-02T09:00:00Z" }),
    issue({ status: "resolved", severity: "serious", resolved_at: "2026-09-30T09:00:00Z" }),
    issue({ status: "wont_fix", severity: "warning", resolved_at: "2026-10-03T09:00:00Z" }),
    issue({ status: "dismissed", severity: "critical" }),
  ];
  it("counts open and testing issues by rating, and those resolved this calendar month", () => {
    const o = openIssues(issues, now);
    expect(o.total).toBe(2);
    expect(o.byRating).toEqual([
      { rating: "risk", count: 1 },
      { rating: "bad", count: 1 },
      { rating: "good", count: 0 },
      { rating: "great", count: 0 },
    ]);
    expect(o.resolvedThisMonth).toBe(1);
  });
  it("counts processes by rating, a process with nothing open as Great", () => {
    expect(countByRating(["risk", null, "bad", "risk"]).map((c) => c.count)).toEqual([2, 1, 0, 1]);
  });
});

describe("issues opened versus resolved", () => {
  it("counts each of the last months, up to this one, by when issues were opened and resolved", () => {
    const issues = [
      issue({ created_at: "2026-10-01T00:00:00Z", status: "open" }),
      issue({ created_at: "2026-08-10T00:00:00Z", status: "resolved", resolved_at: "2026-10-04T00:00:00Z" }),
      issue({ created_at: "2026-09-10T00:00:00Z", status: "wont_fix", resolved_at: "2026-09-12T00:00:00Z" }),
      issue({ created_at: "2026-09-11T00:00:00Z", status: "dismissed" }),
      issue({ created_at: "2025-01-01T00:00:00Z", status: "open" }),
    ];
    const months = openedVersusResolved(issues, new Date("2026-10-20T00:00:00Z"), 3);
    expect(months).toEqual([
      { month: "2026-08", label: "Aug 26", opened: 1, resolved: 0 },
      { month: "2026-09", label: "Sep", opened: 1, resolved: 0 },
      { month: "2026-10", label: "Oct", opened: 1, resolved: 1 },
    ]);
  });
  it("marks the year on January", () => {
    expect(openedVersusResolved([], new Date("2027-02-03T00:00:00Z"), 3).map((m) => m.label)).toEqual(["Dec 26", "Jan 27", "Feb"]);
  });
});

describe("findings by process", () => {
  const stepOf = new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, p.process.id] as const)));
  const processOfStep = (id: string) => stepOf.get(id);
  const pipeline = live.process.id;
  const monthly = parts[1]!;
  const monthlyStep = monthly.steps.find((s) => s.kind === "task")!.id;
  it("puts a step's finding in its process, and roles, people, clients and the forecast across the company", () => {
    expect(groupOfFinding({ key: `wait:step:${monthlyStep}`, stepId: monthlyStep }, processOfStep, pipeline)).toBe(monthly.process.id);
    expect(groupOfFinding({ key: "capacity:role:r1", stepId: monthlyStep }, processOfStep, pipeline)).toBe(COMPANY_GROUP);
    expect(groupOfFinding({ key: "churn_risk:group:svc", stepId: null }, processOfStep, pipeline)).toBe(COMPANY_GROUP);
    expect(groupOfFinding({ key: "forecast:role:r1", stepId: monthlyStep }, processOfStep, pipeline)).toBe(COMPANY_GROUP);
    expect(groupOfFinding({ key: "cycle:process:pipeline", stepId: null }, processOfStep, pipeline)).toBe(pipeline);
    expect(groupOfFinding({ key: `cycle:process:${monthly.process.id}`, stepId: null }, processOfStep, pipeline)).toBe(monthly.process.id);
    expect(groupOfFinding({ key: "success:measure:m1", stepId: null }, processOfStep, pipeline)).toBe(pipeline);
    expect(groupOfFinding({ key: "ai:insight:abc", stepId: null }, processOfStep, pipeline)).toBe(COMPANY_GROUP);
  });
  it("puts an issue logged by hand in the process it names, else its step's", () => {
    const ids = new Set(parts.map((p) => p.process.id));
    expect(groupOfIssue(issue({ process_id: monthly.process.id }), processOfStep, pipeline, ids)).toBe(monthly.process.id);
    expect(groupOfIssue(issue({ process_id: null, step_id: monthlyStep }), processOfStep, pipeline, ids)).toBe(monthly.process.id);
    expect(groupOfIssue(issue({ process_id: null, step_id: null }), processOfStep, pipeline, ids)).toBe(COMPANY_GROUP);
  });
  it("rates each group by the worst of its open issues and open insights, with its top finding and counts", () => {
    const detected = rerate(model, result, {}, pipeline);
    const tracked = northbeamIssues();
    const insights = buildInsights(registerEntries(tracked, detected));
    const solutions = [{ id: "s1", process_id: pipeline }, { id: "s2", process_id: pipeline }];
    const resolvedBy = issue({ status: "resolved", resolved_solution_id: "s2", process_id: pipeline });
    const groups = findingsByProcess({ parts, pipelineId: pipeline, insights, issues: [...tracked, resolvedBy], solutions });
    expect(groups[0]!.id).toBe(COMPANY_GROUP);
    expect(groups.slice(1).map((g) => g.id)).toEqual(parts.map((p) => p.process.id));
    // Every insight lands in exactly one group.
    expect(groups.reduce((a, g) => a + g.insights.length, 0)).toBe(insights.length);
    const lead = groups.find((g) => g.id === pipeline)!;
    expect(lead.openIssues).toBe(tracked.filter((i) => i.status === "open" || i.status === "testing").length);
    // s2 resolved an issue: only s1 is still in progress.
    expect(lead.solutionsInProgress).toBe(1);
    expect(lead.top?.title).toBe(lead.insights.find((i) => !i.issue || i.issue.status === "open" || i.issue.status === "testing")?.title);
    for (const g of groups) {
      const ratings = [...g.insights.map((i) => i.rating)];
      if (!ratings.length && !g.openIssues) expect(g.rating).toBe("great");
    }
  });
  it("says a group's counts in words, leaving out zeros", () => {
    expect(countsLine({ openIssues: 2, newInsights: 1, solutionsInProgress: 1 })).toBe("2 open issues · 1 new insight · 1 solution in progress");
    expect(countsLine({ openIssues: 0, newInsights: 0, solutionsInProgress: 0 })).toBe("Nothing open");
  });
});

const solution = (over: Partial<SolutionRow>): SolutionRow => ({
  id: "s",
  workspace_id: live.workspace.id,
  process_id: live.process.id,
  base_revision_id: live.revision.id,
  name: "Faster audits",
  notes: "",
  steps: solutionCopy(live),
  changed_step_ids: [],
  lever_changes: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  created_by: null,
  ...over,
});
const link = (solution_id: string, verdict: "pass" | "fail" | null): SolutionIssueRow => ({
  solution_id,
  issue_id: "i",
  workspace_id: live.workspace.id,
  auto_verdict: verdict,
  holds_pct: null,
  auto_note: "",
  user_verdict: null,
  user_notes: "",
  created_at: "",
  updated_at: "",
  created_by: null,
});

describe("improvement delivered", () => {
  it("compares implemented solutions first, then those with a verdict, newest first", () => {
    const data = {
      solutions: [solution({ id: "a", created_at: "2026-10-03T00:00:00Z" }), solution({ id: "b", created_at: "2026-10-02T00:00:00Z" }), solution({ id: "c" }), solution({ id: "d" })],
      links: [link("a", "pass"), link("c", null), link("d", "fail")],
    };
    const chosen = solutionsToCompare(data, [issue({ status: "resolved", resolved_solution_id: "b" })]);
    expect(chosen.map((c) => [c.solution.id, c.implemented])).toEqual([
      ["b", true],
      ["a", false],
      ["d", false],
    ]);
  });
  it("adds up hours a month saved and days cut, from each implemented solution's before and after", () => {
    const n = (handsOnPerMonth: number, cycleHours: number | null) => ({ handsOnPerMonth, cycleHours });
    const impacts: SolutionImpact[] = [
      { id: "a", name: "A", implemented: true, before: n(100, 80), after: n(70, 64) },
      { id: "b", name: "B", implemented: true, before: n(20, null), after: n(25, null) },
      { id: "c", name: "C", implemented: false, before: n(500, 500), after: n(0, 0) },
    ];
    // 40 h a week: a working day is 8 h. Saved 30 − 5 = 25 h a month; cut (80 − 64) / 8 = 2 days.
    expect(improvementDelivered(impacts, 40)).toEqual({ count: 2, hoursSaved: 25, daysCut: 2 });
    expect(improvementDelivered(impacts.slice(2), 40)).toBeNull();
  });
  it("measures a solution's before and after with the same runs; one that removes work saves hours", () => {
    const copy = solutionCopy(live);
    const target = copy.steps.find((s) => s.kind === "task" && Number(s.work_hours) > 1)!;
    target.work_hours = 0.1 as never;
    const pairs = impactPairs(live, [{ solution: solution({ steps: copy }), implemented: true }], {}, 13);
    expect(pairs).toHaveLength(1);
    const impact = measureImpact(pairs[0]!, 4, 1);
    expect(impact.after.handsOnPerMonth).toBeLessThan(impact.before.handsOnPerMonth);
    // The same model on both sides measures the same.
    const same = impactNumbers(model, result);
    expect(impactNumbers(model, result)).toEqual(same);
  });
  it("leaves out a solution copied from an earlier version that wasn't loaded", () => {
    expect(impactPairs(live, [{ solution: solution({ base_revision_id: "older" }), implemented: true }], {}, 13)).toEqual([]);
    const older = { older: { steps: live.steps, edges: live.edges } };
    expect(impactPairs(live, [{ solution: solution({ id: "older", base_revision_id: "older" }), implemented: true }], older, 13)).toHaveLength(1);
  });
});

describe("playing the company map", () => {
  it("plays every item, the pipeline's and the servicing tasks", () => {
    const all = playbackRun(result, "all")!;
    expect(all.entities.length).toBe(result.trace!.length);
    expect(all.entities.some((e) => e.outcome === "done")).toBe(true);
    expect(playbackRun(result)!.entities.length).toBeLessThan(all.entities.length);
  });
  it("counts the steps inside a closed card on the card", () => {
    const steps = [
      { id: "p", name: "P", kind: "group" as const, parent_step_id: null },
      { id: "g", name: "G", kind: "group" as const, parent_step_id: "p" },
      { id: "x", name: "X", kind: "task" as const, parent_step_id: "g" },
      { id: "y", name: "Y", kind: "task" as const, parent_step_id: "p" },
    ];
    expect(rolledUpSteps(steps, new Set()).map((s) => [s.id, s.members])).toEqual([["p", ["p", "g", "x", "y"]]]);
    expect(rolledUpSteps(steps, new Set(["p"])).map((s) => [s.id, s.members])).toEqual([
      ["p", ["p"]],
      ["g", ["g", "x"]],
      ["y", ["y"]],
    ]);
  });
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the health cards", () => {
  it("Process health: how many need attention, and the counts by rating", () => {
    const out = html(createElement(ProcessHealthCard, { counts: countByRating(["risk", "bad", null]) }));
    expect(out).toContain("2 of 3");
    expect(out).toContain("need attention");
    expect(out).toContain("Operational risk");
    expect(html(createElement(ProcessHealthCard, { counts: countByRating([]) }))).toContain("No process is published yet.");
    expect(html(createElement(ProcessHealthCard, { counts: null }))).toContain('aria-busy="true"');
  });
  it("Open issues: the total by rating, and how many were resolved this month", () => {
    const out = html(createElement(OpenIssuesCard, { issues: { total: 3, byRating: countByRating(["bad", "bad", "risk"]), resolvedThisMonth: 1 } }));
    expect(out).toContain(">3<");
    expect(out).toContain("1 issue resolved this month");
    const none = html(createElement(OpenIssuesCard, { issues: { total: 0, byRating: countByRating([]), resolvedThisMonth: 0 } }));
    expect(none).toContain("Nothing open.");
  });
  it("Flow efficiency: working against waiting over the horizon, and its empty states", () => {
    const out = html(createElement(FlowEfficiencyCard, { share: 0.18, span: "3 months" }));
    expect(out).toContain("18% working, 82% waiting over the next 3 months");
    expect(html(createElement(FlowEfficiencyCard, { share: null, span: "3 months" }))).toContain("nothing to split");
    expect(html(createElement(FlowEfficiencyCard, { share: undefined, span: "3 months", error: true }))).toContain("simulated");
  });
  it("Improvement delivered: hours saved and days cut, or how it fills in", () => {
    const out = html(createElement(ImprovementCard, { delivered: { count: 2, hoursSaved: 25, daysCut: 2 }, status: "done" }));
    expect(out).toContain("25 h");
    expect(out).toContain("a month saved");
    expect(out).toContain("2 days cut from the time to complete");
    expect(out).toContain("By 2 implemented solutions");
    const empty = html(createElement(ImprovementCard, { delivered: null, status: "done" }));
    expect(empty).toContain("Nothing implemented yet.");
    expect(empty).toContain("When an issue is resolved by a solution");
  });
});

describe("the trend charts", () => {
  it("the issues donut: an arc per rating with a legend, bars by process, and a table", () => {
    const out = html(createElement(IssuesDonut, { byRating: countByRating(["bad", "bad", "risk"]), byProcess: [{ id: "p", name: "Lead to live", count: 3 }] }));
    expect(out).toContain('data-arc="risk"');
    expect(out).toContain('data-arc="bad"');
    expect(out).not.toContain('data-arc="good"');
    expect(out).toContain("3 open issues: 1 Operational risk, 2 Bad, not urgent.");
    expect(out).toContain("Lead to live");
    expect(out).toContain("<table");
    expect(html(createElement(IssuesDonut, { byRating: countByRating([]), byProcess: [] }))).toContain("No open issues.");
  });
  it("the time split: a stacked bar per process with its working share", () => {
    const rows = timeSplitByProcess(model, result, parts);
    const out = html(createElement(TimeSplitChart, { rows, months: 3 }));
    for (const r of rows) expect(out).toContain(r.name);
    expect(out).toContain("Waiting on others");
    expect(out).toContain("working");
    expect(html(createElement(TimeSplitChart, { rows: [], months: 3 }))).toContain("No work went through");
  });
  it("opened versus resolved: two columns a month, a legend, and an empty note", () => {
    const months = openedVersusResolved([issue({ created_at: "2026-10-01T00:00:00Z" })], new Date("2026-10-20T00:00:00Z"), 6);
    const out = html(createElement(OpenedResolvedChart, { months }));
    expect(out).toContain("Opened");
    expect(out).toContain("Resolved");
    expect(out).toContain("Oct 1 opened, 0 resolved");
    expect(html(createElement(OpenedResolvedChart, { months: openedVersusResolved([], new Date("2026-10-20T00:00:00Z"), 6) }))).toContain("No issues were opened or resolved");
  });
  it("before and after: a pair of bars per solution, and how it fills in", () => {
    const impacts: SolutionImpact[] = [{ id: "a", name: "Faster audits", implemented: true, before: { handsOnPerMonth: 100, cycleHours: 80 }, after: { handsOnPerMonth: 70, cycleHours: 64 } }];
    const out = html(createElement(BeforeAfterChart, { impacts, hoursPerWeek: 40 }));
    expect(out).toContain("Faster audits");
    expect(out).toContain("Implemented");
    expect(out).toContain("100 h");
    expect(out).toContain("70 h");
    expect(out).toContain("−30 h");
    expect(html(createElement(BeforeAfterChart, { impacts: [], hoursPerWeek: 40 }))).toContain("No solution has a verdict yet.");
  });
});

describe("the findings tier", () => {
  it("draws a collapsed row per group, Across the company first", () => {
    const detected: DetectedIssue[] = rerate(model, result, {}, live.process.id);
    const groups = findingsByProcess({ parts, pipelineId: live.process.id, insights: buildInsights(registerEntries([], detected)), issues: [], solutions: [] });
    const out = html(createElement(FindingsByProcess, { groups, renderFindings: () => "FINDINGS" }));
    expect(out.indexOf("Across the company")).toBeLessThan(out.indexOf(parts[0]!.process.name));
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("FINDINGS");
    const open = html(createElement(FindingsByProcess, { groups, renderFindings: () => "FINDINGS", initiallyOpen: [live.process.id] }));
    expect(open).toContain("FINDINGS");
  });
});
