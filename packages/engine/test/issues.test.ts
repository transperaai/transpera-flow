import { describe, expect, it } from "vitest";
import {
  absenceCandidates,
  absenceTest,
  applyPatches,
  detectIssues,
  isBlocking,
  larkspurModel,
  northbeamModel,
  northbeamWithServicing,
  RATINGS,
  pct,
  simulate,
  type DetectedIssue,
  type EngineModel,
  type EnginePerson,
  type EngineStep,
  type RatingConfigInput,
} from "../src";
import { SEED_STRIDE } from "../src/simulate";

// Detected issues (issue #17): one small, hand-checkable model per detector,
// Northbeam as it is and overloaded, and stable keys.

/** One pipeline of steps in a row, each staffed by `role` unless given. 40 h weeks, 26-week horizon, no warm-up. */
function line(
  leadsPerWeek: number,
  steps: (Partial<EngineStep> & { id: string })[],
  roles: Record<string, number> = { r: 1 },
  extra: Partial<EngineModel> = {},
): EngineModel {
  return {
    horizonWeeks: 26,
    hoursPerWeek: 40,
    leadsPerWeek,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    warmupWeeks: 4,
    roles: Object.fromEntries(Object.entries(roles).map(([id, count]) => [id, { name: `Role ${id}`, count, cost: 0, ongoing: 0 }])),
    entry: steps[0]!.id,
    sinks: { won: "won", lost: "lost" },
    steps: steps.map((s, i) => ({
      name: `Step ${s.id}`,
      role: "r",
      work: 1,
      wait: 0,
      rework: 0,
      workDist: { kind: "constant" },
      next: [{ to: steps[i + 1]?.id ?? "won", p: 1 }],
      ...s,
    })),
    ...extra,
  };
}

const run = (m: EngineModel, reps = 12, config: RatingConfigInput = {}) => detectIssues(m, simulate(m, reps, 1), config);
/** Bands only: both escalators off, so the rating is the average's band. */
const NO_ESC: RatingConfigInput = { escalators: { badMonth: false, bottleneck: false } };
const keys = (issues: DetectedIssue[]) => issues.map((i) => i.key);
const find = (issues: DetectedIssue[], key: string) => issues.find((i) => i.key === key);
const person = (roles: string[], extra: Partial<EnginePerson> = {}): EnginePerson => ({ name: "", roles, capacity: 40, ...extra });

/** Every suggested fix is a patch the scenario code can apply to the model. */
function fixesApply(m: EngineModel, issues: DetectedIssue[]) {
  for (const i of issues) {
    if (!i.fix) continue;
    expect(applyPatches(m, i.fix.patch).issues.filter(isBlocking), i.key).toEqual([]);
  }
}

describe("too busy (rule 1): role or person", () => {
  it("flags a role at ~90% (9 items/wk × 4 h on 40 h) and not one at ~50%", () => {
    // Offered load 9 × 4 / 40 = 0.9: 85–95% is Bad on the average alone.
    const busy = line(9, [{ id: "a", work: 4 }]);
    const issues = run(busy, 12, NO_ESC);
    const issue = find(issues, "capacity:role:r")!;
    expect(issue.type).toBe("capacity");
    expect(issue.rating).toBe("bad");
    expect(issue.escalation).toEqual({ base: "bad", badMonth: false, bottleneck: false });
    expect(issue.metrics.utilisation).toBeGreaterThan(0.85);
    expect(issue.metrics.utilisation).toBeLessThan(0.95);
    expect(issue.title).toMatch(/^Role r at (8[6-9]|9\d)% utilisation$/);
    expect(issue.stepId).toBe("a");
    expect(issue.fix?.patch).toEqual([{ path: "roles.r.headcount", op: "add", value: 1 }]);
    fixesApply(busy, issues);

    expect(keys(run(line(5, [{ id: "a", work: 4 }])))).not.toContain("capacity:role:r");
    // 70–85% is Good, could improve.
    expect(find(run(line(7.5, [{ id: "a", work: 4 }]), 12, NO_ESC), "capacity:role:r")?.rating).toBe("good");
  });

  it("is Operational risk when client work alone exceeds capacity (50 clients × 1 h/wk on 40 h)", () => {
    // Every lead is lost, so no client is won and the load stays at 50 h/wk
    // (ongoing load follows the live client count; docs/PRD.md §6.8 item 2).
    const m = line(1, [{ id: "a", work: 1, next: [{ to: "lost", p: 1 }] }], { r: 1 }, { activeClients: 50 });
    m.roles.r!.ongoing = 1;
    const issue = find(run(m), "capacity:role:r")!;
    expect(issue.rating).toBe("risk");
    expect(issue.title).toBe("Role r: client work alone exceeds capacity");
    expect(issue.metrics.ongoing_hours_week).toBeCloseTo(50);
  });

  it("flags a person overloaded by a pinned step while their role has room, and names them", () => {
    // Ann is pinned to `a` (9 × 4 h = 36 h of 40); Bob does the light step `b`. The role is at ~50%.
    const m = line(9, [{ id: "a", work: 4, person: "ann" }, { id: "b", work: 0.5 }], { r: 2 }, {
      people: { ann: person(["r"], { name: "Ann", skills: ["a"] }), bob: person(["r"], { name: "Bob", skills: ["b"] }) },
    });
    const issues = run(m);
    expect(keys(issues)).not.toContain("capacity:role:r");
    const issue = find(issues, "capacity:person:ann")!;
    expect(issue.title).toMatch(/^Ann at (8[6-9]|9\d)% utilisation$/);
    expect(issue.personId).toBe("ann");
    expect(issue.stepId).toBe("a");
    fixesApply(m, issues);
  });

  it("names the only member of a flagged role on the role's issue instead of adding a person issue", () => {
    const m = line(9, [{ id: "a", work: 4 }], { r: 1 }, { people: { ann: person(["r"], { name: "Ann" }) } });
    const issues = run(m);
    expect(find(issues, "capacity:role:r")?.title).toMatch(/^Role r \(Ann\) at (8[6-9]|9\d)% utilisation$/);
    expect(find(issues, "capacity:role:r")?.personId).toBe("ann");
    expect(keys(issues)).not.toContain("capacity:person:ann");
  });
});

describe("work piling up (rule 4)", () => {
  it("flags a step offered 10 items/wk that can clear 8 (5 h each on 40 h): the queue grows ~2 a week", () => {
    const m = line(10, [{ id: "a", work: 5 }]);
    const r = simulate(m, 12, 1);
    // Hand check: arrivals 10/wk, service 8/wk, so the backlog grows by ~2 items a week.
    expect(r.steps.a!.queueGrowth).toBeGreaterThan(1.5);
    expect(r.steps.a!.queueGrowth).toBeLessThan(2.5);
    const issues = detectIssues(m, r);
    const issue = find(issues, "queue:step:a")!;
    expect(issue.type).toBe("bottleneck");
    expect(issue.rating).toBe("risk");
    expect(issue.title).toBe("The queue at Step a keeps growing");
    // Its wait is unbounded too; the queue issue covers it.
    expect(keys(issues)).not.toContain("wait:step:a");
  });

  it("doesn't flag a stable queue (70% load)", () => {
    const r = simulate(line(7, [{ id: "a", work: 4 }]), 12, 1);
    expect(Math.abs(r.steps.a!.queueGrowth)).toBeLessThan(0.2);
    expect(keys(detectIssues(line(7, [{ id: "a", work: 4 }]), r))).not.toContain("queue:step:a");
  });
});

describe("waiting too long (rule 5)", () => {
  it("rates queueing against the step's expected wait: M/D/1 at 80% with 4 h service waits ~8 h (Pollaczek–Khinchine)", () => {
    // Wq = ρ / (2(1 − ρ)) × S = 0.8 / 0.4 × 4 h = 8 h. The default expected wait for a pipeline step is 8 h.
    const m = line(8, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    expect(r.steps.a!.avgWait).toBeGreaterThan(6);
    expect(r.steps.a!.avgWait).toBeLessThan(10);
    const wait = (config: RatingConfigInput) => find(detectIssues(m, r, { ...NO_ESC, ...config }), "wait:step:a");
    // ~8 h against 8 h expected is about 1x: Great or just into Good, nowhere near Bad.
    expect(["great", "good"]).toContain(wait({})?.rating ?? "great");
    // A 4 h expected wait makes it ~2x: Bad (1.5-3x).
    const issue = wait({ expectedWaitDays: { pipeline: 0.5 } })!;
    expect(issue.type).toBe("delay");
    expect(issue.rating).toBe("bad");
    expect(issue.metrics.expected_wait_hours).toBe(4);
    expect(issue.metrics.wait_ratio).toBeGreaterThan(1.5);
    expect(issue.title).toMatch(/^Work waits [\d.]+ working days? for Step a$/);
    // A 2 h expected wait: ~4x, Operational risk.
    expect(wait({ expectedWaitDays: { pipeline: 0.25 } })?.rating).toBe("risk");
  });

  it("takes the expected wait from the step, or an override, before the default", () => {
    const base = line(8, [{ id: "a", work: 4 }]);
    const r = simulate(base, 12, 1);
    const withStep = line(8, [{ id: "a", work: 4, expectedWaitHours: 2 }]);
    expect(find(detectIssues(withStep, r, NO_ESC), "wait:step:a")?.rating).toBe("risk");
    const override: RatingConfigInput = { ...NO_ESC, rules: { wait: { overrides: [{ kind: "step", id: "a", expectedWaitHours: 40 }] } } };
    expect(find(detectIssues(withStep, r, override), "wait:step:a")).toBeUndefined();
  });

  it("defaults to 1 working day for pipeline steps and 2 for servicing steps, of the model's week", () => {
    for (const hoursPerWeek of [40, 37.5]) {
      const day = hoursPerWeek / 5;
      const pipeline = { ...line(8, [{ id: "a", work: 4 }]), hoursPerWeek };
      const r = simulate(pipeline, 4, 1);
      const asServicing: EngineModel = { ...pipeline, servicingProcesses: { sp: { name: "Monthly report", entry: "a", steps: ["a"] } } };
      // The same long wait held to each default.
      const slow = { ...r, steps: { a: { ...r.steps.a!, avgWait: 100, p90: undefined } } };
      expect(find(detectIssues(pipeline, slow, NO_ESC), "wait:step:a")?.metrics.expected_wait_hours).toBeCloseTo(day);
      expect(find(detectIssues(asServicing, slow, NO_ESC), "wait:step:a")?.metrics.expected_wait_hours).toBeCloseTo(2 * day);
    }
  });

  it("takes the most specific expected wait: person/step override, the step's own, role/service/process override, default", () => {
    const base = line(8, [{ id: "a", work: 4, expectedWaitHours: 20 }], { r: 1 });
    const r = simulate(base, 4, 1);
    const slow = { ...r, steps: { a: { ...r.steps.a!, avgWait: 100, p90: undefined } } };
    const expected = (m: EngineModel, overrides: NonNullable<RatingConfigInput["rules"]>["wait"] extends infer W ? (W extends { overrides?: infer O } ? O : never) : never) =>
      find(detectIssues(m, slow, { ...NO_ESC, rules: { wait: { overrides } } }), "wait:step:a")?.metrics.expected_wait_hours;
    const noOwn = line(8, [{ id: "a", work: 4 }], { r: 1 });
    // A role override loses to the step's own setting, but beats the default.
    expect(expected(base, [{ kind: "role", id: "r", expectedWaitHours: 30 }])).toBe(20);
    expect(expected(noOwn, [{ kind: "role", id: "r", expectedWaitHours: 30 }])).toBe(30);
    expect(expected(noOwn, [{ kind: "process", id: "p", expectedWaitHours: 30 }])).toBe(8);
    // A step override beats the step's own setting.
    expect(expected(base, [{ kind: "role", id: "r", expectedWaitHours: 30 }, { kind: "step", id: "a", expectedWaitHours: 10 }])).toBe(10);
  });
});

describe("single point of failure (rule 8, the absence test; see new-rules.test.ts for the rating)", () => {
  /** The same run, with the absence test beside it. */
  const runWithAbsence = (m: EngineModel, reps = 12) => detectIssues(m, simulate(m, reps, 1), {}, { absence: absenceTest(m, { reps: 6 }) });

  it("tests a person who is the only one for a step, and not a step two people can do", () => {
    const m = line(2, [{ id: "a", role: "solo", work: 18 }, { id: "b", role: "pair", work: 1 }], { solo: 1, pair: 2 });
    expect(absenceCandidates(m)).toEqual([{ personId: "solo#1", stepIds: ["a"] }]);
    const issues = runWithAbsence(m);
    const issue = find(issues, "spof:step:a")!;
    expect(issue.type).toBe("spof");
    expect(issue.title).toBe("Only one Role solo can do Step a");
    expect(issue.fix?.patch).toEqual([{ path: "roles.solo.headcount", op: "add", value: 1 }]);
    expect(keys(issues).filter((k) => k.startsWith("spof"))).toEqual(["spof:step:a"]);
  });

  it("raises nothing without an absence test, however structural the single point is", () => {
    const m = line(2, [{ id: "a", role: "solo", work: 18 }], { solo: 1 });
    expect(keys(run(m)).filter((k) => k.startsWith("spof"))).toEqual([]);
  });

  it("counts skills: two people in the role but only one with the skill", () => {
    const m = line(2, [{ id: "a", work: 18 }], { r: 2 }, {
      people: { ann: person(["r"], { name: "Ann", skills: ["a"] }), bob: person(["r"], { name: "Bob", skills: [] }) },
    });
    expect(absenceCandidates(m)).toEqual([{ personId: "ann", stepIds: ["a"] }]);
    expect(find(runWithAbsence(m), "spof:step:a")?.title).toBe("Only Ann can do Step a");
  });

  it("ignores unstaffed steps", () => {
    const m = line(2, [{ id: "a", role: null, work: 0 }, { id: "b", role: "solo" }], { solo: 1 });
    m.steps[0]!.next = [{ to: "b", p: 1 }];
    expect(absenceCandidates(m).map((c) => c.stepIds)).toEqual([["b"]]);
  });
});

describe("rework (rule 6): rated from the simulation, not the rate typed in", () => {
  it("rates 12% Bad, 30% and 45% Operational risk, and leaves 3% alone", () => {
    const m = line(2, [{ id: "a", rework: 0.3 }, { id: "b", rework: 0.45 }, { id: "c", rework: 0.03 }, { id: "d", rework: 0.12 }], { r: 4 });
    const issues = run(m, 12, NO_ESC);
    expect(find(issues, "rework:step:a")).toMatchObject({ type: "failure", rating: "risk" });
    expect(find(issues, "rework:step:b")?.rating).toBe("risk");
    expect(find(issues, "rework:step:d")?.rating).toBe("bad");
    expect(keys(issues)).not.toContain("rework:step:c");
    expect(find(issues, "rework:step:a")?.fix?.patch).toEqual([{ path: "steps.a.rework_rate", op: "multiply", value: 0.5 }]);
    // The title and metrics carry the simulated share, which is close to the model's 30%.
    const share = find(issues, "rework:step:a")!.metrics.observed_share!;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.4);
    expect(find(issues, "rework:step:a")!.title).toBe(`${Math.round(share * 100)}% of Step a is done twice`);
    fixesApply(m, issues);
  });

  it("follows the simulated result, whatever the model says", () => {
    const m = line(2, [{ id: "a", rework: 0.3 }, { id: "b", rework: 0 }], { r: 2 });
    const r = simulate(m, 12, 1);
    // Typed 30% but nothing was repeated in the run: no issue. Typed 0% but half of visits repeated: an issue.
    const tampered = {
      ...r,
      steps: {
        a: { ...r.steps.a!, reworks: 0, p90: undefined },
        b: { ...r.steps.b!, reworks: r.steps.b!.departures / 2, p90: undefined },
      },
    };
    const issues = detectIssues(m, tampered, NO_ESC);
    expect(keys(issues)).not.toContain("rework:step:a");
    expect(find(issues, "rework:step:b")).toMatchObject({ rating: "risk", title: "50% of Step b is done twice" });
  });
});

describe("missed deadlines (rule 7)", () => {
  it("flags every visit breaching a 2 h SLA on a 3 h constant step, and none under a 5 h one", () => {
    const m = line(2, [{ id: "a", work: 3, sla: 2 }, { id: "b", work: 3, sla: 5 }], { r: 2 });
    const r = simulate(m, 12, 1);
    expect(r.steps.a!.slaBreaches).toBe(r.steps.a!.departures);
    const issues = detectIssues(m, r);
    const issue = find(issues, "sla:step:a")!;
    expect(issue).toMatchObject({ type: "sla", rating: "risk", title: "Step a misses its 2 h SLA 100% of the time" });
    expect(issue.metrics.breach_share).toBe(1);
    // Under a 5 h SLA nothing breaches on average; a rare bad month at most.
    expect(find(issues, "sla:step:b")?.rating ?? "great").not.toBe("risk");
    expect(find(issues, "sla:step:b")?.metrics.breach_share ?? 0).toBeLessThan(0.05);
  });

  it("suggests halving the external wait when that, not the queue, breaks the SLA", () => {
    const m = line(2, [{ id: "a", work: 1, wait: 20, waitDist: { kind: "constant" }, sla: 8 }], { r: 2 });
    const issue = find(run(m), "sla:step:a")!;
    expect(issue.fix?.patch).toEqual([{ path: "steps.a.wait_hours", op: "multiply", value: 0.5 }]);
  });

  it("counts no breaches when a step has no SLA", () => {
    const r = simulate(line(2, [{ id: "a", work: 3 }]), 4, 1);
    expect(r.steps.a!.slaBreaches).toBe(0);
    expect(r.steps.a!.departures).toBeGreaterThan(0);
  });
});

describe("Northbeam", () => {
  it("the strategist example from docs/analysis-rules.md: Good on 82%, Bad after a bad month, Operational risk as the bottleneck", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    const strat = r.kpi.roles.strat!.util;
    // Average ~82%: Good, could improve (70-85%). A bad month (P90) is over the 85% cut-off. She is the bottleneck.
    expect(strat.mean).toBeGreaterThan(0.8);
    expect(strat.mean).toBeLessThan(0.85);
    expect(strat.p90).toBeGreaterThan(0.85);
    expect(r.bnRole).toBe("strat");

    const issue = find(detectIssues(m, r), "capacity:role:strat")!;
    expect(issue.rating).toBe("risk");
    expect(issue.escalation).toEqual({ base: "good", badMonth: true, bottleneck: true });
    expect(issue.title).toMatch(/^Strategist \(Maya Collins\) at 8[0-4]% utilisation$/);
    expect(issue.evidence).toContain("Rated Good, could improve on the average, raised to Operational risk");

    // Each step of the example, with the escalators switched on one at a time.
    const only = (badMonth: boolean, bottleneck: boolean) =>
      find(detectIssues(m, r, { escalators: { badMonth, bottleneck } }), "capacity:role:strat")!.rating;
    expect(only(false, false)).toBe("good");
    expect(only(true, false)).toBe("bad");
    expect(only(false, true)).toBe("bad");
    expect(only(true, true)).toBe("risk");
  });

  it("the old engine didn't flag her (82% is under 85%); the same run now lists her", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    expect(r.roles.strat!.util).toBeLessThan(0.85);
    expect(keys(detectIssues(m, r))).toContain("capacity:role:strat");
  });

  it("absence test: the strategist is the only one who can do audits and kickoffs, and is a risk when away", () => {
    const m = northbeamModel();
    const issues = detectIssues(m, simulate(m, 30, 1), {}, { absence: absenceTest(m) });
    const strat = issues.filter((i) => i.type === "spof");
    expect(strat.map((i) => i.key)).toEqual(["spof:step:audit", "spof:step:kickoff"]);
    expect(strat[0]!.title).toBe("Only one Strategist can do Audit & proposal");
    expect(strat.map((i) => i.rating)).toEqual(["risk", "risk"]);
    expect(strat[0]!.fix?.name).toBe("Hire another Strategist");
    fixesApply(m, issues);
  });

  it("with 80% more leads: the audit queue grows, the strategist is over 100%, kickoffs wait", () => {
    const m = northbeamModel();
    m.leadsPerWeek *= 1.8;
    const issues = run(m, 30);
    expect(find(issues, "capacity:role:strat")?.rating).toBe("risk");
    expect(find(issues, "queue:step:audit")?.rating).toBe("risk");
    expect(find(issues, "wait:step:kickoff")?.rating).toBe("risk");
    // Most severe first.
    const ranks = issues.map((i) => RATINGS.indexOf(i.rating));
    expect(ranks).toEqual([...ranks].sort((x, y) => y - x));
    // The suggested fix clears the growing queue.
    const fixed = applyPatches(m, find(issues, "queue:step:audit")!.fix!.patch).model;
    expect(keys(run(fixed, 30))).not.toContain("queue:step:audit");
  });
});

describe("re-rating a run with a new config, without simulating again", () => {
  it("gives new ratings from the same result", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    const frozen = JSON.stringify(r);
    const before = find(detectIssues(m, r), "capacity:role:strat")!;
    // Stricter: the strategist's cut-offs lowered to 40/50/60% put her at Operational risk on the average alone.
    const strict: RatingConfigInput = { escalators: { badMonth: false, bottleneck: false }, rules: { busy: { cutoffs: [0.4, 0.5, 0.6] } } };
    expect(find(detectIssues(m, r, strict), "capacity:role:strat")?.rating).toBe("risk");
    // Looser: 90/95/99% leaves her Great, so she's no longer listed.
    const loose: RatingConfigInput = { rules: { busy: { cutoffs: [0.9, 0.95, 0.99] } }, escalators: { badMonth: false, bottleneck: false } };
    expect(keys(detectIssues(m, r, loose))).not.toContain("capacity:role:strat");
    // Switching the rule off removes its findings; the default again gives the first answer.
    expect(keys(detectIssues(m, r, { rules: { busy: { enabled: false } } })).filter((k) => k.startsWith("capacity:"))).toEqual([]);
    expect(find(detectIssues(m, r), "capacity:role:strat")).toEqual(before);
    // The result was only read.
    expect(JSON.stringify(r)).toBe(frozen);
  });

  it("an override for a person or role changes only their rating", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    const cfg: RatingConfigInput = {
      escalators: { badMonth: false, bottleneck: false },
      rules: { busy: { overrides: [{ kind: "role", id: "strat", cutoffs: [0.1, 0.2, 0.3] }] } },
    };
    const issues = detectIssues(m, r, cfg);
    expect(find(issues, "capacity:role:strat")?.rating).toBe("risk");
    expect(find(issues, "capacity:role:ppc")?.rating).toBe(find(detectIssues(m, r, NO_ESC), "capacity:role:ppc")?.rating);
  });

  it("an override for a servicing process or service applies to its steps' waits", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    const process = Object.keys(m.servicingProcesses!)[0]!;
    const stepId = m.servicingProcesses![process]!.steps.find((id) => find(detectIssues(m, r, NO_ESC), `wait:step:${id}`))!;
    expect(stepId).toBeTruthy();
    const serviceId = Object.keys(m.services!).find((sv) => m.services![sv]!.servicing?.some((l) => l.process === process))!;
    const lax = { cutoffs: [1000, 2000, 3000] as [number, number, number] };
    for (const kind of [{ kind: "process" as const, id: process }, { kind: "service" as const, id: serviceId }, { kind: "step" as const, id: stepId }]) {
      const issues = detectIssues(m, r, { ...NO_ESC, rules: { wait: { overrides: [{ ...kind, ...lax }] } } });
      expect(keys(issues), JSON.stringify(kind)).not.toContain(`wait:step:${stepId}`);
    }
  });
});

describe("a bad month (P90) and the bottleneck on steps", () => {
  it("raises a step's wait rating when P90 crosses the next cut-off, and when it is the bottleneck step", () => {
    const m = line(8, [{ id: "a", work: 4 }]);
    const r = simulate(m, 12, 1);
    // Held to a 6 h expected wait (~1.3x): Good. P90 over 1.5x makes it Bad; a single step is the bottleneck step too.
    const cfg = { expectedWaitDays: { pipeline: 0.75 } };
    const step = r.steps.a!;
    const fake = (avgWait: number, p90: number, bn: string | null) => ({ ...r, bnStep: bn, steps: { a: { ...step, avgWait, p90: { ...step.p90!, avgWait: p90 } } } });
    const wait = (res: typeof r, c: RatingConfigInput = cfg) => find(detectIssues(m, res, c), "wait:step:a")!;
    expect(wait(fake(7, 8, null)).rating).toBe("good");
    expect(wait(fake(7, 10, null))).toMatchObject({ rating: "bad", escalation: { base: "good", badMonth: true, bottleneck: false } });
    expect(wait(fake(7, 8, "a"))).toMatchObject({ rating: "bad", escalation: { base: "good", badMonth: false, bottleneck: true } });
    expect(wait(fake(7, 10, "a")).rating).toBe("risk");
  });
});

describe("overtime (rule 3)", () => {
  it("is rated on the share of the overtime cap used", () => {
    const m = northbeamWithServicing();
    const r = simulate(m, 30, 1);
    const ot = detectIssues(m, r, NO_ESC).filter((i) => i.key.startsWith("overtime:"));
    for (const i of ot) {
      const share = i.metrics.overtime_hours_week! / i.metrics.capacity_hours_week! / i.metrics.overtime_cap!;
      expect(i.rating, i.key).toBe(share >= 0.95 ? "risk" : "bad");
    }
  });
});

describe("stable keys", () => {
  it("an unchanged model gives identical issues run after run", () => {
    const m = northbeamModel();
    m.leadsPerWeek *= 1.8;
    expect(detectIssues(m, simulate(m, 30, 1))).toEqual(detectIssues(m, simulate(m, 30, 1)));
  });

  it("keys name the subject, not the numbers: another seed gives the same keys", () => {
    const m = northbeamModel();
    m.leadsPerWeek *= 1.8;
    expect(keys(detectIssues(m, simulate(m, 30, 99))).sort()).toEqual(keys(detectIssues(m, simulate(m, 30, 1))).sort());
  });

  it("is a pure function: the model and result are not changed", () => {
    const m = northbeamModel();
    const r = simulate(m, 5, 1);
    const before = JSON.stringify([m, r]);
    detectIssues(m, r);
    expect(JSON.stringify([m, r])).toBe(before);
  });
});

describe("StepResult.p90", () => {
  it("is pct of the per-replication values across the replications", () => {
    const m = line(8, [{ id: "a", work: 4, rework: 0.3, sla: 8 }]);
    const reps = 12;
    const r = simulate(m, reps, 1);
    // Rebuild the per-replication values from the same seeds, one run at a time.
    const singles = Array.from({ length: reps }, (_, i) => simulate(m, 1, 1 + i * SEED_STRIDE).steps.a!);
    const share = (n: number, d: number) => (d > 0 ? Math.min(1, n / d) : 0);
    expect(r.steps.a!.p90).toEqual({
      avgWait: pct(singles.map((x) => x.avgWait), 0.9),
      reworkShare: pct(singles.map((x) => share(x.reworks, x.departures)), 0.9),
      slaBreachShare: pct(singles.map((x) => share(x.slaBreaches, x.departures)), 0.9),
      lostShare: pct(singles.map((x) => share(x.lostHere ?? 0, x.departures)), 0.9),
    });
    expect(r.steps.a!.p90!.avgWait).toBeGreaterThan(0);
  });
});

describe("saved issues hold no pay (B1 2b)", () => {
  // An issue's evidence and metrics are saved, and every member reads them. Overtime hours and overtime money in one
  // sentence would give a rate away, so the evidence states hours only and the money stays in `cost`, which is never saved.
  const MONEY = /costing|£|\$|€|A\$/;
  for (const [name, model, hasOvertime] of [["Larkspur", larkspurModel, true], ["the seeded Northbeam", northbeamWithServicing, false]] as const) {
    it(`${name}: evidence is the same with pay hidden, states no money, and no issue has an overtime_cost metric`, () => {
      const m = model();
      const shown = detectIssues(m, simulate(m, 12, 1));
      const hidden = detectIssues({ ...m, payHidden: true }, simulate({ ...m, payHidden: true }, 12, 1));
      // Larkspur's copywriter works overtime; the seeded Northbeam has none to report.
      expect(shown.some((i) => i.key.startsWith("overtime:"))).toBe(hasOvertime);
      const evidence = (list: DetectedIssue[]) => Object.fromEntries(list.map((i) => [i.key, i.evidence]));
      expect(evidence(hidden)).toEqual(evidence(shown));
      for (const i of [...shown, ...hidden]) {
        expect(i.evidence, i.key).not.toMatch(MONEY);
        expect(i.metrics, i.key).not.toHaveProperty("overtime_cost");
      }
    });
  }

  // Detected issues sort by rating, then cost, then the detector, then the key. A member's costs that need pay are payHidden
  // and sort as no cost, so nothing in a member's order is pay: it differs from an editor's where an editor's pay-based cost
  // puts an issue higher, and that difference is required (members must not be able to rank people's pay by the order).
  it("with pay hidden, the order of issues doesn't depend on anyone's rate", () => {
    const base = larkspurModel();
    const rated = (factor: (i: number) => number): EngineModel => ({
      ...base,
      payHidden: true,
      people: Object.fromEntries(Object.entries(base.people ?? {}).map(([id, p], i) => [id, { ...p, cost: (p.cost ?? 40) * factor(i) }])),
    });
    const order = (m: EngineModel) => {
      const found = detectIssues(m, simulate(m, 12, 1));
      return found.map((i) => `${i.key}|${i.rating}|${i.cost.payHidden ? "hidden" : "shown"}`);
    };
    const reference = order(rated(() => 1));
    expect(reference.length).toBeGreaterThan(3);
    expect(reference.some((k) => k.endsWith("|hidden"))).toBe(true);
    expect(order(rated(() => 3))).toEqual(reference);
    expect(order(rated((i) => (i === 1 ? 0.1 : 3)))).toEqual(reference);
    expect(order(rated((i) => 10 - i))).toEqual(reference);
  });

  it("without payHidden, an editor's costs may order issues of one rating differently (no assertion on what they are)", () => {
    const m = larkspurModel();
    const shown = detectIssues(m, simulate(m, 12, 1));
    const hidden = detectIssues({ ...m, payHidden: true }, simulate({ ...m, payHidden: true }, 12, 1));
    // The same issues either way; only the order within a rating may differ.
    expect(shown.map((i) => i.key).sort()).toEqual(hidden.map((i) => i.key).sort());
    expect(shown.map((i) => i.rating)).toEqual(hidden.map((i) => i.rating));
  });
});
