import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamIssues, partOf, toEngineModel, type IssueRow, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import { RATING_LABELS, simulate, type DetectedIssue, type EngineModel, type Rating, type SimulationResult } from "@transpera-flow/engine";
import { FindingsByProcess, countsLine } from "@/components/overview/findings-by-process";
import { FlowEfficiencyCard, ImprovementCard, OpenIssuesCard, ProcessHealthCard } from "@/components/overview/health-cards";
import { BeforeAfterChart, IssuesDonut, OpenedResolvedChart, TimeSplitChart } from "@/components/overview/trend-charts";
import { buildInsights } from "@/lib/insights/insights";
import { mapFeed, registerEntries, stepRatingOf } from "@/lib/issues/register";
import { ratingOfRank } from "@/lib/map/rating";
import { COMPANY_GROUP, findingsByProcess, groupOfFinding, groupOfIssue } from "@/lib/overview/by-process";
import { countByRating, flowEfficiencyWords, monthOf, openIssues, openedVersusResolved, processHealth, timeSplitByProcess, timeSplitOf, workingShare } from "@/lib/overview/health";
import { hoursAMonth, impactNumbers, impactPairs, improvementDelivered, measureImpact, solutionsToCompare, type SolutionImpact } from "@/lib/overview/impact";
import { processRatings } from "@/lib/processes/rows";
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

/** A model and result by hand: two steps, with per-visit times and visits, over a 100-hour run. */
function handMade(): { model: Pick<EngineModel, "steps">; result: Pick<SimulationResult, "steps" | "stepFacts" | "H"> } {
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
      // Queues: a averages 0.1 items over the 100 hours (10 item-hours queued), b 0.1 (10 item-hours); nothing left queued.
      steps: { a: { arrivals: 10, wip: 0, avgQueue: 0.1 }, b: { arrivals: 5, wip: 0, avgQueue: 0.1 }, c: { arrivals: 0, wip: 0, avgQueue: 0 } } as unknown as SimulationResult["steps"],
      stepFacts: { a: fact(2, 1, 1, 6), b: fact(4, 2, 0, 0), c: fact(100, 0, 0, 0) },
      H: 100,
    },
  };
}

describe("flow efficiency", () => {
  it("is hands-on time over all elapsed time at the steps, each step weighted by its visits", () => {
    const { model, result } = handMade();
    const split = timeSplitOf(model, result)!;
    // a: 10 visits × (2 hands-on, 1 stretched, 6 on others) and 10 item-hours queued; b: 5 × (4, 0, 0) and 10 queued; c has no visits.
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
    expect(timeSplitOf(model, { steps: result.steps, H: 100 })).toBeNull();
  });
  it("counts the items still queued at the horizon as waiting, and only the visits that started as worked", () => {
    const { model, result } = handMade();
    // b has a backlog: of its 5 arrivals, 3 are still queued at the end, and its queue averaged 2 items over the 100 hours.
    const backlog = { ...result, steps: { ...result.steps, b: { ...result.steps.b!, wip: 3, avgQueue: 2 } } };
    expect(timeSplitOf(model, backlog, new Set(["b"]))).toEqual({ handsOn: 2 * 4, waitingForPerson: 200, waitingOnOthers: 0 });
  });
  it("isn't flattered by a backlog: a real overloaded run reads as more waiting than its finished visits alone", () => {
    const overloaded: EngineModel = { ...model, steps: model.steps.map((s) => ({ ...s, work: s.work * 6, workDist: undefined })) };
    const run = simulate(overloaded, 4, 1);
    expect(Object.values(run.steps).some((r) => r.wip > 0)).toBe(true);
    // The old reading: every arrival times the per-visit times of the visits that finished.
    let handsOn = 0;
    let all = 0;
    for (const s of overloaded.steps) {
      const f = run.stepFacts![s.id];
      const n = run.steps[s.id]?.arrivals ?? 0;
      if (!f || !n) continue;
      handsOn += n * f.handsOnHours;
      all += n * (f.handsOnHours + f.queueWaitHours + f.stretchHours + f.fixedWaitHours);
    }
    expect(workingShare(timeSplitOf(overloaded, run)!)!).toBeLessThan(handsOn / all);
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
    const o = openIssues(issues, now, "UTC");
    expect(o.total).toBe(2);
    expect(o.byRating).toEqual([
      { rating: "risk", count: 1 },
      { rating: "bad", count: 1 },
      { rating: "good", count: 0 },
      { rating: "great", count: 0 },
    ]);
    expect(o.resolvedThisMonth).toBe(1);
  });
  it("counts processes by rating, a process with no confirmed issue as not rated", () => {
    const h = processHealth(["risk", null, "bad", "risk"]);
    expect(h.byRating.map((c) => c.count)).toEqual([2, 1, 0, 0]);
    expect(h).toMatchObject({ notRated: 1, total: 4, attention: 3 });
  });
  it("takes this month in the time zone given, the same for the card and the chart, around a month's end", () => {
    // 23:30 UTC on 31 October: still October in Los Angeles, already November in Auckland.
    const late = [issue({ status: "resolved", severity: "serious", created_at: "2026-10-31T23:30:00Z", resolved_at: "2026-10-31T23:30:00Z" })];
    const now = new Date("2026-11-01T00:10:00Z");
    expect(monthOf("2026-10-31T23:30:00Z", "America/Los_Angeles")).toBe("2026-10");
    expect(monthOf("2026-10-31T23:30:00Z", "Pacific/Auckland")).toBe("2026-11");
    // In Los Angeles both instants are October; in London the issue is October and now is November; in Auckland both are November.
    expect(openIssues(late, now, "America/Los_Angeles").resolvedThisMonth).toBe(1);
    expect(openIssues(late, now, "Europe/London").resolvedThisMonth).toBe(0);
    expect(openIssues(late, now, "Pacific/Auckland").resolvedThisMonth).toBe(1);
    const la = openedVersusResolved(late, now, 2, "America/Los_Angeles");
    expect(la.map((m) => [m.month, m.opened, m.resolved])).toEqual([
      ["2026-09", 0, 0],
      ["2026-10", 1, 1],
    ]);
    const london = openedVersusResolved(late, now, 2, "Europe/London");
    expect(london.map((m) => [m.month, m.opened, m.resolved])).toEqual([
      ["2026-10", 1, 1],
      ["2026-11", 0, 0],
    ]);
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
    const months = openedVersusResolved(issues, new Date("2026-10-20T00:00:00Z"), 3, "UTC");
    expect(months).toEqual([
      { month: "2026-08", label: "Aug 26", opened: 1, resolved: 0 },
      { month: "2026-09", label: "Sep", opened: 1, resolved: 0 },
      { month: "2026-10", label: "Oct", opened: 1, resolved: 1 },
    ]);
  });
  it("marks the year on January", () => {
    expect(openedVersusResolved([], new Date("2027-02-03T00:00:00Z"), 3, "UTC").map((m) => m.label)).toEqual(["Dec 26", "Jan 27", "Feb"]);
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
  it("rates each process by its confirmed open issues, as the map and Processes table do, with its top finding and counts", () => {
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
    // The processes' ratings are the Processes table's; insights nobody has acknowledged don't rate them.
    const table = processRatings(
      parts.map((p) => ({ id: p.process.id, name: p.process.name, kind: p.process.kind, parentId: p.process.parent_process_id })),
      tracked,
      parts.flatMap((p) => p.steps),
    );
    for (const g of groups.slice(1)) expect(g.rating).toBe(table[g.id] ?? null);
    const quiet = findingsByProcess({ parts, pipelineId: pipeline, insights, issues: [], solutions: [] });
    expect(quiet.map((g) => g.rating)).toEqual(quiet.map(() => null));
  });
  it("agrees with the map and the Process health card for the seeded Lead to live", () => {
    const nb = northbeamBundle();
    const nbParts = [partOf(nb), ...(nb.otherProcesses ?? [])];
    const nbModel = toEngineModel(nb);
    const issues = northbeamIssues();
    const detected = rerate(nbModel, simulate(nbModel, 4, 1), {}, nb.process.id);
    const entries = registerEntries(issues, detected);
    const groups = findingsByProcess({ parts: nbParts, pipelineId: nb.process.id, insights: buildInsights(entries), issues, solutions: [] });
    const row = groups.find((g) => g.id === nb.process.id)!;
    // The map's closed card: the worst rating of the steps inside, from the confirmed issues (mapFeed).
    const stepRating = stepRatingOf(mapFeed(entries).ratings);
    const ranks = nbParts[0]!.steps.map((s) => stepRating(s.id)?.rank ?? -1);
    const card: Rating | null = Math.max(...ranks) >= 0 ? ratingOfRank(Math.max(...ranks)) : null;
    expect(card).not.toBeNull();
    expect(row.rating).toBe(card);
    const health = processHealth(groups.slice(1).map((g) => g.rating));
    expect(health.byRating.find((c) => c.rating === card)!.count).toBeGreaterThanOrEqual(1);
    const out = html(createElement(FindingsByProcess, { groups, renderFindings: () => null }));
    const at = out.indexOf(`data-findings-group="${nb.process.id}"`);
    expect(out.slice(at, out.indexOf("data-top-finding", at))).toContain(RATING_LABELS[card!]);
  });
  it("says a group's counts in words, leaving out zeros", () => {
    expect(countsLine({ openIssues: 2, newInsights: 1, solutionsInProgress: 1 })).toBe("2 open issues · 1 new finding · 1 solution in progress");
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
  const n = (handsOnPerItem: number, itemsPerMonth: number, cycleHours: number | null) => ({ handsOnPerItem, itemsPerMonth, cycleHours });
  const at = (id: string, processId: string, baseRevisionId = `${processId}-v1`) => ({ id, name: id.toUpperCase(), processId, processName: processId.toUpperCase(), baseRevisionId });
  it("adds up hours a month saved at the same demand, and names the biggest cut in time to complete", () => {
    const impacts: SolutionImpact[] = [
      // 10 items a month: 10 h each before, 7 after: 30 h saved; (80 − 64) / 8 = 2 days cut from P1.
      { ...at("a", "p1"), implemented: true, before: n(10, 10, 80), after: n(7, 10, 64) },
      // 2 h an item before, 2.5 after, at 10 a month: 5 h added. No completion times.
      { ...at("b", "p2"), implemented: true, before: n(2, 10, null), after: n(2.5, 10, null) },
      // More items got through after, the same work each: nothing saved, nothing added.
      { ...at("c", "p3"), implemented: true, before: n(5, 10, 40), after: n(5, 20, 16) },
      { ...at("d", "p1"), implemented: false, before: n(500, 10, 500), after: n(0, 10, 0) },
    ];
    // 40 h a week: a working day is 8 h. P3's (40 − 16) / 8 = 3 days is the largest cut; it isn't added to P1's 2.
    expect(improvementDelivered(impacts, 40)).toEqual({ count: 3, superseded: 0, hoursSaved: 25, daysCut: { days: 3, processName: "P3" } });
    expect(improvementDelivered(impacts.slice(3), 40)).toBeNull();
  });
  it("doesn't read a rise in throughput as hours added", () => {
    const h = hoursAMonth({ before: n(5, 10, null), after: n(5, 20, null) });
    expect(h.after - h.before).toBe(0);
  });
  it("counts only the latest of two implemented solutions built from the same version", () => {
    const impacts: SolutionImpact[] = [
      { ...at("new", "p1"), implemented: true, before: n(10, 10, 80), after: n(6, 10, 64) },
      { ...at("old", "p1"), implemented: true, before: n(10, 10, 80), after: n(8, 10, 72) },
    ];
    expect(improvementDelivered(impacts, 40)).toEqual({ count: 1, superseded: 1, hoursSaved: 40, daysCut: { days: 2, processName: "P1" } });
  });
  it("measures a solution's before and after with the same runs; one that removes work saves hours", () => {
    const copy = solutionCopy(live);
    const target = copy.steps.find((s) => s.kind === "task" && Number(s.work_hours) > 1)!;
    target.work_hours = 0.1 as never;
    const pairs = impactPairs(live, [{ solution: solution({ steps: copy }), implemented: true }], {}, 13);
    expect(pairs).toHaveLength(1);
    const impact = measureImpact(pairs[0]!, 4, 1);
    expect(impact.after.handsOnPerItem).toBeLessThan(impact.before.handsOnPerItem);
    const h = hoursAMonth(impact);
    expect(h.after).toBeLessThan(h.before);
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
    const out = html(createElement(ProcessHealthCard, { health: processHealth(["risk", "bad", null]) }));
    expect(out).toContain("2 of 3");
    expect(out).toContain("need attention");
    expect(out).toContain("Operational risk");
    expect(out).toContain("Not rated");
    expect(html(createElement(ProcessHealthCard, { health: processHealth([]) }))).toContain("No process is published yet.");
    expect(html(createElement(ProcessHealthCard, { health: null }))).toContain('aria-busy="true"');
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
    const out = html(createElement(ImprovementCard, { delivered: { count: 2, superseded: 1, hoursSaved: 25, daysCut: { days: 2, processName: "Lead to live" } }, status: "done" }));
    expect(out).toContain("25 h");
    expect(out).toContain("a month saved");
    expect(out).toContain("2 days cut from Lead to live&#x27;s time to complete");
    expect(out).toContain("By 2 implemented solutions");
    expect(out).toContain("1 earlier solution built from the same version isn&#x27;t counted again.");
    const empty = html(createElement(ImprovementCard, { delivered: null, status: "done" }));
    expect(empty).toContain("Nothing implemented yet.");
    expect(empty).toContain("When an issue is resolved by a solution");
    // Implemented, but none could be measured: say so, not "Nothing implemented yet".
    const unmeasured = html(createElement(ImprovementCard, { delivered: null, status: "done", unmeasured: 2 }));
    expect(unmeasured).not.toContain("Nothing implemented yet.");
    expect(unmeasured).toContain("Couldn&#x27;t measure 2 implemented solutions");
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
    const impacts: SolutionImpact[] = [
      { id: "a", name: "Faster audits", implemented: true, processId: "p", processName: "P", baseRevisionId: "v1", before: { handsOnPerItem: 10, itemsPerMonth: 10, cycleHours: 80 }, after: { handsOnPerItem: 7, itemsPerMonth: 12, cycleHours: 64 } },
    ];
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
    // A collapsed row points at no panel; an open one points at its panel.
    expect(out).not.toContain("aria-controls");
    const open = html(createElement(FindingsByProcess, { groups, renderFindings: () => "FINDINGS", initiallyOpen: [live.process.id] }));
    expect(open).toContain("FINDINGS");
    expect(open).toContain(`aria-controls="findings-${live.process.id}"`);
    expect(open).toContain(`id="findings-${live.process.id}"`);
  });
  it("gives the top finding its rating in words, and an open row with nothing open a short line", () => {
    const detected: DetectedIssue[] = rerate(model, result, {}, live.process.id);
    const groups = findingsByProcess({ parts, pipelineId: live.process.id, insights: buildInsights(registerEntries([], detected)), issues: [], solutions: [] });
    const withTop = groups.find((g) => g.top)!;
    const out = html(createElement(FindingsByProcess, { groups: [withTop], renderFindings: () => "FINDINGS" }));
    const top = out.slice(out.indexOf("data-top-finding"));
    expect(top.slice(0, top.indexOf(withTop.top!.title))).toContain(RATING_LABELS[withTop.top!.rating]);
    const empty = { ...withTop, insights: [], issues: [], top: null, newInsights: 0, openIssues: 0 };
    const openEmpty = html(createElement(FindingsByProcess, { groups: [empty], renderFindings: () => "FINDINGS", initiallyOpen: [empty.id] }));
    expect(openEmpty).toContain("Nothing open.");
    expect(openEmpty).not.toContain("FINDINGS");
  });
});

describe("one run for both, when the models are the same", () => {
  it("a run's month-by-month numbers don't change the rest of it", () => {
    const plain = simulate(model, 3, 1);
    const monthly = simulate(model, 3, 1, { monthly: true });
    expect(monthly.monthly).toBeDefined();
    expect(monthly.kpi).toEqual(plain.kpi);
    expect(monthly.steps).toEqual(plain.steps);
    expect(monthly.stepFacts).toEqual(plain.stepFacts);
  });
});
