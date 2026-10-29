import { describe, expect, it } from "vitest";
import { northbeamStepIds as ids, toEngineModel, type IssueRow, type ProcessBundle } from "@transpera-flow/db";
import { simulate, SEED_STRIDE } from "@transpera-flow/engine";
import { diffBundles } from "@/lib/drafts/diff";
import { withDemoGroups, DEMO_GROUP_IDS } from "@/lib/demo/nested";
import { buildSolutionHref, newSolutionHref, solutionEditorHref } from "@/lib/solutions/links";
import { currentArea, issueProcessId, leafIds, solutionIssueOf, verdictArea } from "@/lib/solutions/area";
import { changedStepIds, solutionCopy, solutionProblem } from "@/lib/solutions/bundle";
import { bundleFromSolution } from "@transpera-flow/db/sandbox";
import { parseSolutionInput } from "@/lib/solutions/save";
import { checkTarget, formatSpan, formatSpanLike, measureKind, parseGoal } from "@/lib/solutions/verdict";
import { demoBundle } from "@/lib/sources/demo";

// Solutions (issue #114, A49): the automatic verdict, the stored copy, the issue area and the links into the Editor.

/** The demo's pipeline with Audit & proposal's hands-on time cut, as a solution would. */
function faster(base: ProcessBundle, hours: number): ProcessBundle {
  return { ...base, steps: base.steps.map((s) => (s.id === ids.audit ? { ...s, work_hours: hours, work_dist: "constant" as const } : s)) };
}

describe("reading a goal", () => {
  it("reads a direction, a number and a unit", () => {
    expect(parseGoal("under 4 hours")).toEqual({ direction: "atMost", value: 4, unit: "hours", period: null });
    expect(parseGoal("below 80%")).toEqual({ direction: "atMost", value: 80, unit: "percent", period: null });
    expect(parseGoal("at least 6 a quarter")).toEqual({ direction: "atLeast", value: 6, unit: "none", period: "quarter" });
    expect(parseGoal("Over 2 days")).toEqual({ direction: "atLeast", value: 2, unit: "days", period: null });
    expect(parseGoal("less than 30 minutes")).toEqual({ direction: "atMost", value: 30, unit: "minutes", period: null });
    expect(parseGoal("no more than 1.5 weeks")).toEqual({ direction: "atMost", value: 1.5, unit: "weeks", period: null });
    expect(parseGoal("under £2,500")).toEqual({ direction: "atMost", value: 2500, unit: "money", period: null });
    expect(parseGoal("at least 12k")).toEqual({ direction: "atLeast", value: 12000, unit: "none", period: null });
  });

  it("reads negated phrases, trailing or-less, and the number after the direction word", () => {
    const g = (text: string) => parseGoal(text);
    expect(g("10 min or less")).toEqual({ direction: "atMost", value: 10, unit: "minutes", period: null });
    expect(g("5 days or more")).toEqual({ direction: "atLeast", value: 5, unit: "days", period: null });
    expect(g("no less than 10 wins")).toEqual({ direction: "atLeast", value: 10, unit: "none", period: null });
    expect(g("no fewer than 5")).toEqual({ direction: "atLeast", value: 5, unit: "none", period: null });
    expect(g("not more than 3 days")).toEqual({ direction: "atMost", value: 3, unit: "days", period: null });
    expect(g("from 1.4 d to under 4 hours")).toEqual({ direction: "atMost", value: 4, unit: "hours", period: null });
    expect(g("within 1 month")).toEqual({ direction: "atMost", value: 1, unit: "months", period: null });
    expect(g("under 90 seconds")).toEqual({ direction: "atMost", value: 90, unit: "seconds", period: null });
    expect(g("under 2 business days")).toEqual({ direction: "atMost", value: 2, unit: "days", period: null });
    expect(g("under £2m")).toEqual({ direction: "atMost", value: 2_000_000, unit: "money", period: null });
    expect(g("at least 2k")).toEqual({ direction: "atLeast", value: 2000, unit: "none", period: null });
    // Bare "min" is minutes, not a direction; a goal with no direction can't be read.
    expect(g("30 min")).toBeNull();
    expect(g("£2m")).toBeNull();
    expect(g("min 10 wins")).toBeNull();
    expect(g("minimum 10 wins")).toEqual({ direction: "atLeast", value: 10, unit: "none", period: null });
    expect(g("under 10m")).toEqual({ direction: "atMost", value: 10, unit: "minutes", period: null });
    expect(g("at least 6 per month")?.period).toBe("month");
    expect(g("under 4 hours per proposal")?.period).toBeNull();
  });

  it("reads compact units, decimals, compound times and a trailing max or minimum", () => {
    const g = (text: string) => parseGoal(text);
    const t = (direction: "atMost" | "atLeast", value: number, unit: string) => ({ direction, value, unit, period: null });
    expect(g("<4h")).toEqual(t("atMost", 4, "hours"));
    expect(g("under 4h")).toEqual(t("atMost", 4, "hours"));
    expect(g("within 2d")).toEqual(t("atMost", 2, "days"));
    expect(g("under 30min")).toEqual(t("atMost", 30, "minutes"));
    expect(g("under 4.5h")).toEqual(t("atMost", 4.5, "hours"));
    expect(g("at least 1.5x")).toEqual(t("atLeast", 1.5, "none"));
    expect(g("under 1 hr 30 min")).toEqual(t("atMost", 90, "minutes"));
    expect(g("under 1h 30m")).toEqual(t("atMost", 90, "minutes"));
    expect(g("under 2 min 30 s")).toEqual(t("atMost", 150, "seconds"));
    expect(g("4 hours max")).toEqual(t("atMost", 4, "hours"));
    expect(g("4 hours maximum")).toEqual(t("atMost", 4, "hours"));
    expect(g("10 wins minimum")).toEqual(t("atLeast", 10, "none"));
    expect(g("maximum 4 hours")).toEqual(t("atMost", 4, "hours"));
    // No direction, or a sign or mix it can't read: no verdict.
    expect(g("more or less 3 days")).toBeNull();
    expect(g("less or more 3 days")).toBeNull();
    expect(g("≤ -5")).toBeNull();
    expect(g("under -5 hours")).toBeNull();
    expect(g("under 1 hr 30")).toBeNull();
    expect(g("under 1 day 2 hours")).toBeNull();
    expect(g("≤ 5")).toEqual(t("atMost", 5, "none"));
  });

  it("gives up on what it can't read", () => {
    for (const text of ["faster", "", null, undefined, "about 4 hours", "under"]) expect(parseGoal(text), String(text)).toBeNull();
  });

  it("names what the measure's words describe, in a fixed order", () => {
    expect(measureKind("Wait at Check fit", true)).toBe("wait");
    expect(measureKind("Wait at Check fit", false)).toBeNull();
    expect(measureKind("Hands-on time per proposal", true)).toBe("handsOn");
    expect(measureKind("Strategist busy in a bad month (P90)", false)).toBe("busy");
    expect(measureKind("Time to first contact", true)).toBe("areaTime");
    expect(measureKind("Time to complete", false)).toBe("cycle");
    expect(measureKind("Cycle time", true)).toBe("cycle");
    expect(measureKind("Win rate", false)).toBe("winRate");
    expect(measureKind("Clients won a month", false)).toBe("won");
    expect(measureKind("New MRR", false)).toBe("mrr");
    expect(measureKind("Reports past the 5th working day", false)).toBeNull();
    expect(measureKind("", true)).toBeNull();
    expect(measureKind(null, true)).toBeNull();
  });

  it("shows a time in the unit the goal was written in", () => {
    expect(formatSpanLike(9, 40, "hours")).toBe("9 h");
    expect(formatSpanLike(9, 40, "days")).toBe("1.1 d");
    expect(formatSpanLike(0.5, 40, "minutes")).toBe("30 min");
    expect(formatSpanLike(80, 40, "weeks")).toBe("2 w");
    expect(formatSpanLike(9, 40, "none")).toBe("1.1 d");
  });

  it("shows a span as hours under a working day, and days after", () => {
    expect(formatSpan(3.1, 40)).toBe("3.1 h");
    expect(formatSpan(16, 40)).toBe("2 d");
    expect(formatSpan(12, 40)).toBe("1.5 d");
    expect(formatSpan(80, 40)).toBe("10 d");
  });
});

describe("the automatic verdict", () => {
  const live = demoBundle();
  const liveModel = toEngineModel(live);
  const liveRun = simulate(liveModel, 30, 1);
  const area = [ids.audit];

  it("re-runs each run with the seed the full run gave it, so its per-run numbers are the run's own", () => {
    const each = Array.from({ length: liveRun.reps }, (_, i) => simulate(liveModel, 1, liveRun.seed + i * SEED_STRIDE).steps[ids.audit]!.avgWait);
    const mean = each.reduce((a, b) => a + b, 0) / each.length;
    expect(mean).toBeCloseTo(liveRun.steps[ids.audit]!.avgWait, 9);
  });

  it("fails live against a target it misses, and says how often it holds", () => {
    const v = checkTarget({ target: { measure: "Wait at Audit & proposal", goal: "under 20 hours" }, model: liveModel, result: liveRun, area });
    expect(v.status).toBe("fail");
    expect(v.holdsPct).toBeLessThan(50);
    expect(v.note).toMatch(/Wait at Audit & proposal: .* on average, against under 20 hours/);
    expect(v.note).toMatch(/in \d+% of runs/);
  });

  it("passes a solution that fixes it, against the same seeds, and holds more often than live", () => {
    const base = checkTarget({ target: { measure: "Wait at Audit & proposal", goal: "under 20 hours" }, model: liveModel, result: liveRun, area });
    const model = toEngineModel(faster(live, 3));
    const run = simulate(model, 30, 1);
    const v = checkTarget({ target: { measure: "Wait at Audit & proposal", goal: "under 20 hours" }, model, result: run, area });
    expect(v.status).toBe("pass");
    expect(v.holdsPct!).toBeGreaterThan(base.holdsPct!);
    expect(v.value!).toBeLessThan(base.value!);
  });

  it("is deterministic: the same model and run give the same verdict", () => {
    const args = { target: { measure: "Wait at Audit & proposal", goal: "under 20 hours" }, model: liveModel, result: liveRun, area };
    expect(checkTarget(args)).toEqual(checkTarget(args));
    expect(checkTarget(args)).toEqual(checkTarget({ ...args, result: simulate(liveModel, 30, 1) }));
  });

  it("reads the goal's unit: days and hours name the same target", () => {
    const hours = checkTarget({ target: { measure: "Wait at Audit & proposal", goal: "under 40 hours" }, model: liveModel, result: liveRun, area });
    const days = checkTarget({ target: { measure: "Wait at Audit & proposal", goal: "under 1 week" }, model: liveModel, result: liveRun, area });
    expect(days.status).toBe(hours.status);
    expect(days.holdsPct).toBe(hours.holdsPct);
  });

  it("checks hands-on time from the steps themselves, and the busiest role, and the time to complete", () => {
    expect(checkTarget({ target: { measure: "Hands-on time per proposal", goal: "under 10 hours" }, model: liveModel, result: liveRun, area })).toMatchObject({ status: "pass", holdsPct: 100 });
    expect(checkTarget({ target: { measure: "Hands-on time per proposal", goal: "under 3 hours" }, model: liveModel, result: liveRun, area })).toMatchObject({ status: "fail", holdsPct: 0 });
    const busy = checkTarget({ target: { measure: "Strategist busy", goal: "below 80%" }, model: liveModel, result: liveRun, area });
    expect(busy.status).toBe("fail");
    expect(busy.note).toMatch(/9\d%|100%/);
    expect(checkTarget({ target: { measure: "Time to complete", goal: "under 1000 days" }, model: liveModel, result: liveRun, area: [] })).toMatchObject({ status: "pass", holdsPct: 100 });
    expect(checkTarget({ target: { measure: "Clients won", goal: "at least 1" }, model: liveModel, result: liveRun, area: [] }).status).toBe("pass");
  });

  it("converts every time unit, and gives no verdict for a time with no unit or a period", () => {
    const ver = (measure: string, goal: string, area: string[] = [ids.audit]) => checkTarget({ target: { measure, goal }, model: liveModel, result: liveRun, area });
    // Audit & proposal waits about 50 working hours: 1.25 working weeks, 6.25 working days, under a month.
    expect(ver("Wait at Audit & proposal", "under 300000 seconds").status).toBe("pass");
    expect(ver("Wait at Audit & proposal", "under 3000 seconds").status).toBe("fail");
    expect(ver("Wait at Audit & proposal", "under 60 minutes").status).toBe("fail");
    expect(ver("Wait at Audit & proposal", "under 2 business days").status).toBe("fail");
    expect(ver("Wait at Audit & proposal", "under 7 business days").status).toBe("pass");
    expect(ver("Wait at Audit & proposal", "within 1 month").status).toBe("pass");
    expect(ver("Wait at Audit & proposal", "under 1 week").status).toBe("fail");
    expect(ver("Wait at Audit & proposal", "under 4").status).toBe("unchecked");
    for (const [measure, goal] of [["Clients won", "at least 6 a quarter"], ["Clients won", "at least 2 per month"], ["New MRR", "at least 5k a month"], ["Revenue billed", "under 10k per week"]]) {
      const v = ver(measure!, goal!, []);
      expect(v.status, `${measure} ${goal}`).toBe("unchecked");
      expect(v.note).toMatch(/is per (quarter|month|week)/);
    }
  });

  it("gives no verdict, and says why, when the target can't be checked", () => {
    const cases: [string | null, string | null, RegExp][] = [
      ["Wait at Audit & proposal", "faster", /Couldn't read the goal/],
      ["Wait at Audit & proposal", null, /no goal/],
      ["Reports past the 5th working day", "below 5%", /doesn't compute/],
      ["Wait at Audit & proposal", "under 5%", /doesn't match|isn't/],
      ["Strategist busy", "under 4 hours", /isn't a percentage/],
    ];
    for (const [measure, goal, why] of cases) {
      const v = checkTarget({ target: { measure, goal }, model: liveModel, result: liveRun, area });
      expect(v.status, `${measure} / ${goal}`).toBe("unchecked");
      expect(v.holdsPct).toBeNull();
      expect(v.note).toMatch(why);
      expect(v.note).toMatch(/Give your own verdict/);
    }
  });
});

describe("the issue area", () => {
  const nested = withDemoGroups(demoBundle());
  const issue = (over: Partial<IssueRow>): IssueRow =>
    ({
      id: "3f1c2b4a-0000-4000-8000-000000000001",
      number: 7,
      title: "Proposals wait",
      process_id: nested.process.id,
      step_id: null,
      links: [{ process_id: nested.process.id, step_id: ids.audit }],
      target_measure: "Wait at Audit & proposal",
      target_now: "50 h",
      target_goal: "under 20 hours",
      ...over,
    }) as IssueRow;

  it("lists the steps of the process the issue touches, with its target", () => {
    const a = solutionIssueOf(issue({}), nested.process.id, nested.steps);
    expect(a).toEqual({ id: "3f1c2b4a-0000-4000-8000-000000000001", number: 7, title: "Proposals wait", stepIds: [ids.audit], whole: false, target: { measure: "Wait at Audit & proposal", now: "50 h", goal: "under 20 hours" } });
  });

  it("is the whole process when the issue names no step, or only steps of another process", () => {
    expect(solutionIssueOf(issue({ links: [{ process_id: nested.process.id, step_id: null }] }), nested.process.id, nested.steps).whole).toBe(true);
    expect(solutionIssueOf(issue({ links: [{ process_id: "other", step_id: ids.audit }] }), nested.process.id, nested.steps).whole).toBe(true);
    expect(solutionIssueOf(issue({ links: [{ process_id: nested.process.id, step_id: "gone" }] }), nested.process.id, nested.steps).whole).toBe(true);
  });

  it("opens a group out to the steps inside it, and leaves the start and end markers out", () => {
    const inside = leafIds(nested.steps, [DEMO_GROUP_IDS.conversation]);
    expect(inside.sort()).toEqual([ids.qualify, ids.discovery].sort());
    expect(leafIds(nested.steps, [ids.start, ids.won])).toEqual([]);
    expect(verdictArea(nested.steps, { stepIds: [DEMO_GROUP_IDS.conversation], whole: false }).sort()).toEqual([ids.qualify, ids.discovery].sort());
    expect(verdictArea(nested.steps, { stepIds: [], whole: true }).length).toBeGreaterThan(5);
  });

  it("follows the area to what the solution put in place of a step it took out", () => {
    const base = { stepIds: [ids.audit], whole: false };
    // Nothing taken out: the issue's own steps.
    expect(currentArea(base, nested.steps, ["new1"])).toEqual([ids.audit]);
    // The step was replaced: what the solution added stands in for it (only what is in the map).
    const without = nested.steps.filter((s) => s.id !== ids.audit);
    const added = { ...nested.steps[0]!, id: "new1" };
    expect(currentArea(base, [...without, added], ["new1", "gone"])).toEqual(["new1"]);
    expect(verdictArea([...without, added], base, ["new1"])).toEqual(["new1"]);
    // An issue about the whole process has no particular steps to outline.
    expect(currentArea({ stepIds: [], whole: true }, nested.steps, ["new1"])).toEqual([]);
  });

  it("takes the issue's process from its first link", () => {
    expect(issueProcessId({ links: [{ process_id: "p1", step_id: null }], process_id: "p2" })).toBe("p1");
    expect(issueProcessId({ links: [], process_id: "p2" })).toBe("p2");
    expect(issueProcessId({ links: [], process_id: null })).toBeNull();
  });
});

describe("links into the Editor", () => {
  it("opens solution mode on the issue's process, for A48's button", () => {
    const i = { id: "i1", process_id: "p0", links: [{ process_id: "p1", step_id: null }] };
    expect(buildSolutionHref("/w/acme", i)).toBe("/w/acme/p/p1/edit?mode=solution&issue=i1");
    expect(buildSolutionHref("/w/acme", i, "/w/acme/issues/i1")).toBe("/w/acme/p/p1/edit?mode=solution&issue=i1&from=%2Fw%2Facme%2Fissues%2Fi1");
    expect(buildSolutionHref("/w/acme", { id: "i2", process_id: null, links: [] })).toBeNull();
  });

  it("starts a solution with no issue, in the workspace and on the demo", () => {
    expect(newSolutionHref("/w/acme", "p1")).toBe("/w/acme/p/p1/edit?mode=solution");
    expect(solutionEditorHref("/demo", "p1", { issueId: "i1" })).toBe("/demo/edit?mode=solution&issue=i1&process=p1");
  });
});

describe("a solution's stored copy", () => {
  const live = demoBundle();
  const frozen = structuredClone(live);

  it("keeps the whole map, the start and end included, and where every step sits", () => {
    const copy = solutionCopy(faster(live, 4));
    expect(copy.steps).toHaveLength(live.steps.length);
    expect(copy.edges).toHaveLength(live.edges.length);
    for (const s of copy.steps) {
      expect(s).not.toHaveProperty("revision_id");
      expect(s).not.toHaveProperty("workspace_id");
      expect(s).not.toHaveProperty("process_id");
    }
    const was = live.steps.find((s) => s.id === ids.start)!;
    expect(copy.steps.find((s) => s.id === ids.start)).toMatchObject({ x: was.x, y: was.y, kind: "start" });
    expect(solutionProblem(copy)).toBeNull();
  });

  it("comes back as the same map on the same process, and simulates as the edited map did", () => {
    const edited = faster(live, 4);
    const back = bundleFromSolution(live, { steps: JSON.parse(JSON.stringify(solutionCopy(edited))) });
    expect(back.steps).toEqual(edited.steps);
    expect(back.edges).toEqual(edited.edges);
    expect(back.process).toBe(live.process);
    expect(simulate(toEngineModel(back), 5, 1).won).toBe(simulate(toEngineModel(edited), 5, 1).won);
  });

  it("names the steps it changed, against live, and leaves live exactly as it was", () => {
    const edited = faster(live, 4);
    const diff = diffBundles(live, edited);
    expect(changedStepIds(diff)).toEqual([ids.audit]);
    solutionCopy(edited);
    expect(live).toEqual(frozen);
    // A removed step is no longer in the copy, so it isn't named.
    const without = { ...edited, steps: edited.steps.filter((s) => s.id !== ids.kickoff), edges: edited.edges.filter((e) => e.from_step_id !== ids.kickoff && e.to_step_id !== ids.kickoff) };
    expect(changedStepIds(diffBundles(live, without))).not.toContain(ids.kickoff);
  });

  it("refuses a copy that is malformed", () => {
    expect(solutionProblem(null)).toMatch(/aren't valid/);
    expect(solutionProblem({ steps: [], edges: [] })).toMatch(/at least one step/);
    const copy = solutionCopy(live);
    expect(solutionProblem({ ...copy, steps: [...copy.steps, copy.steps[0]] })).toMatch(/aren't valid/);
    expect(solutionProblem({ ...copy, edges: [{ ...copy.edges[0], to_step_id: "nowhere" }] })).toMatch(/aren't valid/);
    expect(solutionProblem({ ...copy, steps: copy.steps.map((s, i) => (i === 0 ? { ...s, parent_step_id: "nowhere" } : s)) })).toMatch(/aren't valid/);
  });
});

describe("what Save solution sends", () => {
  const live = demoBundle();
  const base = {
    name: "  AI lead qualifier ",
    processId: live.process.id,
    baseRevisionId: live.revision.id,
    copy: solutionCopy(live),
    changedStepIds: [ids.audit, 5],
    levers: [],
    links: [{ issueId: "3f1c2b4a-0000-4000-8000-000000000001", autoVerdict: "pass", holdsPct: 140, autoNote: "x" }],
  };

  it("cleans it up", () => {
    const r = parseSolutionInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("AI lead qualifier");
    expect(r.value.changedStepIds).toEqual([ids.audit]);
    expect(r.value.links).toEqual([{ issueId: "3f1c2b4a-0000-4000-8000-000000000001", autoVerdict: "pass", holdsPct: 100, autoNote: "x" }]);
  });

  it("drops the percentage when there is no verdict, and a link listed twice", () => {
    const r = parseSolutionInput({ ...base, links: [{ ...base.links[0], autoVerdict: null }, base.links[0]] });
    expect(r.ok && r.value.links).toEqual([{ issueId: "3f1c2b4a-0000-4000-8000-000000000001", autoVerdict: null, holdsPct: null, autoNote: "x" }]);
  });

  it("allows a solution with no issue, to be linked later", () => {
    const r = parseSolutionInput({ ...base, links: [] });
    expect(r.ok && r.value.links).toEqual([]);
  });

  it("says in plain English what is wrong", () => {
    const err = (over: object) => {
      const r = parseSolutionInput({ ...base, ...over });
      return r.ok ? null : r.error;
    };
    expect(err({ name: "  " })).toBe("Name the solution first.");
    expect(err({ name: "x".repeat(201) })).toMatch(/under 200/);
    expect(err({ processId: "nope" })).toMatch(/Publish the process first/);
    expect(err({ baseRevisionId: undefined })).toMatch(/Publish the process first/);
    expect(err({ copy: { steps: [], edges: [] } })).toMatch(/at least one step/);
    expect(err({ links: [{ issueId: "nope" }] })).toBe("That issue isn't valid.");
    expect(parseSolutionInput(null)).toEqual({ ok: false, error: "That solution isn't valid." });
  });
});
