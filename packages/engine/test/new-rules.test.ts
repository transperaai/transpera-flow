import { describe, expect, it } from "vitest";
import {
  absenceCandidates,
  absenceTest,
  checkSuccessMeasures,
  detectIssues,
  NO_SUCCESS_MEASURES,
  northbeamWithServicing,
  simulate,
  type AbsenceFinding,
  type AbsenceTest,
  type DetectedIssue,
  type EngineModel,
  type EngineStep,
  type RatingConfigInput,
  type SimulationResult,
  type SuccessMeasure,
} from "../src";

// The new rules (issue #107): spare time (2), the absence test (8), goals met
// (11), work lost at a step (12) and too slow overall (13), and the step
// fields behind them. Band boundaries are checked on constructed numbers; the
// real engine runs check the numbers are read from the right place.

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

const NO_ESC: RatingConfigInput = { escalators: { badMonth: false, bottleneck: false } };
const find = (issues: DetectedIssue[], key: string) => issues.find((i) => i.key === key);
const eps = 1e-9;

describe("spare time (rule 2)", () => {
  // One role, one step of 1 h each lead: 10 leads a week is 10 h of a 40 h week, 25% busy.
  const m = line(10, [{ id: "a", work: 1 }]);
  const r = simulate(m, 12, 1);

  it("shows an opportunity, rated Good, with the hours free", () => {
    const issue = find(detectIssues(m, r, NO_ESC), "spare:role:r")!;
    expect(issue.type).toBe("capacity");
    expect(issue.rating).toBe("good");
    expect(issue.title).toMatch(/^Role r has about \d+ h a week free$/);
    expect(issue.metrics.free_hours_week).toBeCloseTo(40 - issue.metrics.busy_hours_week!, 9);
    expect(issue.metrics.free_hours_week).toBeGreaterThan(25);
    expect(issue.fix).toBeNull();
  });

  it("is not raised at 40% busy or more, and never goes above Good (not by a bad month, not on the bottleneck)", () => {
    const busy = (util: number) => ({ ...r, roles: { r: { ...r.roles.r!, util } }, bnRole: "r" });
    const rating = (util: number) => find(detectIssues(m, busy(util), {}), "spare:role:r")?.rating ?? "great";
    expect([0, 0.2, 0.4 - eps, 0.4, 0.41, 0.9].map(rating)).toEqual(["good", "good", "good", "great", "great", "great"]);
  });

  it("follows the rule's cut-off, switch and overrides", () => {
    expect(find(detectIssues(m, r, { rules: { spare: { cutoffs: [0.2, 0, 0] } } }), "spare:role:r")).toBeUndefined();
    expect(find(detectIssues(m, r, { rules: { spare: { enabled: false } } }), "spare:role:r")).toBeUndefined();
    const overridden = { rules: { spare: { overrides: [{ kind: "role" as const, id: "r", cutoffs: [0.2, 0, 0] as const }] } } };
    expect(find(detectIssues(m, r, overridden), "spare:role:r")).toBeUndefined();
  });

  it("is per person when the model has named people", () => {
    const named = line(10, [{ id: "a" }], { r: 1 }, { people: { ann: { name: "Ann", roles: ["r"], capacity: 40 } } });
    const issue = find(detectIssues(named, simulate(named, 12, 1), NO_ESC), "spare:person:ann")!;
    expect(issue.title).toMatch(/^Ann has about \d+ h a week free$/);
    expect(issue.personId).toBe("ann");
  });
});

describe("the absence test (rule 8)", () => {
  // A lone worker with more work than hours: two weeks away lose two weeks of it for good.
  const solo = line(2, [{ id: "a", role: "solo", work: 25 }, { id: "b", role: "pair", work: 1 }], { solo: 1, pair: 2 });

  it("is deterministic: the same model and seed give the same result", () => {
    expect(absenceTest(solo, { reps: 4 })).toEqual(absenceTest(solo, { reps: 4 }));
    expect(absenceTest(solo, { reps: 4, seed: 7 })).not.toEqual(absenceTest(solo, { reps: 4, seed: 8 }));
  });

  it("tests only people who are the sole holder of a step, one extra run each", () => {
    const t = absenceTest(solo, { reps: 4 });
    expect(t.people.map((p) => p.personId)).toEqual(["solo#1"]);
    expect(t).toMatchObject({ reps: 4, seed: 1, weeksAway: 2, startWeek: 2, complete: true });
  });

  it("reports the work lost and the weeks to recover", () => {
    const f = absenceTest(solo, { reps: 6 }).people[0]!;
    expect(f.workLost).toBeGreaterThan(0.03);
    expect(f.itemsLost).toBeGreaterThan(0);
    expect(f.clientDeadlineMissed).toBe(false);
  });

  it("finds nothing to lose when the person has plenty of slack", () => {
    const easy = line(2, [{ id: "a", role: "solo", work: 2 }], { solo: 1 });
    const f = absenceTest(easy, { reps: 6 }).people[0]!;
    expect(f.workLost).toBeLessThan(0.05);
    expect(f.recovered).toBe(true);
    expect(f.recoveryWeeks).toBeLessThanOrEqual(1);
  });

  it("runs nothing when nobody is a sole holder, or the absence is 0 weeks", () => {
    const pair = line(2, [{ id: "a", role: "pair" }], { pair: 2 });
    expect(absenceCandidates(pair)).toEqual([]);
    expect(absenceTest(pair).people).toEqual([]);
    expect(absenceTest(solo, { weeks: 0 }).people).toEqual([]);
  });

  it("can be limited to some people, a most number of people, and a time budget", () => {
    const m = line(2, [{ id: "a", role: "x", work: 10 }, { id: "b", role: "y", work: 10 }], { x: 1, y: 1 });
    expect(absenceTest(m, { reps: 2 }).people.map((p) => p.personId)).toEqual(["x#1", "y#1"]);
    expect(absenceTest(m, { reps: 2, personIds: ["y#1"] }).people.map((p) => p.personId)).toEqual(["y#1"]);
    expect(absenceTest(m, { reps: 2, maxPeople: 1 }).people).toHaveLength(1);
    // Out of time after the first person: the rest are left, and the result says so.
    let clock = 0;
    const budgeted = absenceTest(m, { reps: 2, timeBudgetMs: 5, now: () => (clock += 10) });
    expect(budgeted.people).toHaveLength(1);
    expect(budgeted.complete).toBe(false);
  });

  it("covers every month of a short horizon without running past it", () => {
    const short = line(2, [{ id: "a", role: "solo", work: 10 }], { solo: 1 }, { horizonWeeks: 4 });
    const t = absenceTest(short, { reps: 2 });
    expect(t.startWeek).toBe(0);
    expect(t.people).toHaveLength(1);
    expect(absenceTest({ ...short, horizonWeeks: 1 }, { reps: 2 }).people).toEqual([]);
  });

  describe("rating", () => {
    const person: AbsenceFinding = { personId: "solo#1", stepIds: ["a"], workLost: 0, itemsLost: 0, winsLost: 0, recoveryWeeks: 0, recovered: true, extraMissed: 0, clientDeadlineMissed: false };
    const rate = (over: Partial<AbsenceFinding>, config: RatingConfigInput = {}) => {
      const test: AbsenceTest = { reps: 10, seed: 1, weeksAway: 2, startWeek: 2, complete: true, people: [{ ...person, ...over }] };
      return find(detectIssues(solo, simulate(solo, 6, 1), config, { absence: test }), "spof:step:a")?.rating ?? "great";
    };

    it("rates work lost: under 5% Great, 5-20% Bad, 20% or more Operational risk", () => {
      expect([0, 0.05 - eps, 0.05, 0.2 - eps, 0.2, 0.9].map((workLost) => rate({ workLost }))).toEqual(["great", "great", "bad", "bad", "risk", "risk"]);
    });

    it("rates weeks to recover: within 1 week Great, up to 4 Bad, longer or not recovered Operational risk", () => {
      const weeks = (recoveryWeeks: number) => rate({ recoveryWeeks });
      expect([0, 1, 1 + eps, 4, 4 + eps, 9].map(weeks)).toEqual(["great", "great", "bad", "bad", "risk", "risk"]);
    });

    it("takes the worse of the two, and a missed client deadline is Operational risk whatever else", () => {
      expect(rate({ workLost: 0.1, recoveryWeeks: 9 })).toBe("risk");
      expect(rate({ workLost: 0.1, recoveryWeeks: 0 })).toBe("bad");
      expect(rate({ clientDeadlineMissed: true, extraMissed: 3 })).toBe("risk");
    });

    it("uses the workspace's cut-offs, switch and overrides", () => {
      expect(rate({ workLost: 0.1 }, { rules: { spof: { cutoffs: [0.2, 0.3, 0.4] } } })).toBe("great");
      expect(rate({ recoveryWeeks: 3 }, { absence: { recoveryCutoffs: [1, 2, 3] } })).toBe("bad");
      expect(rate({ workLost: 0.5 }, { rules: { spof: { enabled: false } } })).toBe("great");
      expect(rate({ workLost: 0.5 }, { rules: { spof: { overrides: [{ kind: "role", id: "solo", enabled: false }] } } })).toBe("great");
    });

    it("carries the numbers behind it and no escalation", () => {
      const test: AbsenceTest = { reps: 10, seed: 1, weeksAway: 2, startWeek: 2, complete: true, people: [{ ...person, workLost: 0.12, itemsLost: 3, recoveryWeeks: 3 }] };
      const issue = find(detectIssues(solo, simulate(solo, 6, 1), {}, { absence: test }), "spof:step:a")!;
      expect(issue.metrics).toMatchObject({ work_lost: 0.12, items_lost: 3, recovery_weeks: 3, weeks_away: 2, absences_per_year: 2, recovered: 1 });
      expect(issue.escalation).toEqual({ base: "bad", badMonth: false, bottleneck: false });
      expect(issue.evidence).toContain("12% of the work");
    });
  });

  describe("on the seeded Northbeam agency (golden)", () => {
    const m = northbeamWithServicing();
    const t = absenceTest(m);

    it("tests the strategist and the finance lead, who are the sole holders of steps", () => {
      expect(t.people.map((p) => [p.personId, p.stepIds])).toEqual([
        ["maya", ["audit", "kickoff", "report_strat"]],
        ["rosa", ["report_fin"]],
      ]);
    });

    it("finds the strategist's absence costs work and does not recover, and a missed client deadline", () => {
      const maya = t.people[0]!;
      expect(maya.workLost).toBeGreaterThan(0.05);
      expect(maya.recovered).toBe(false);
      expect(maya.clientDeadlineMissed).toBe(true);
      const issues = detectIssues(m, simulate(m, 30, 1), {}, { absence: t });
      expect(find(issues, "spof:step:audit")?.rating).toBe("risk");
    });

    it("is cheap enough to run beside the baseline: its own pass within the seeded target (250 ms)", { tags: ["perf"] }, () => {
      absenceTest(m, { reps: 2 }); // warm up
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        absenceTest(m);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(250);
    });
  });
});

describe("work lost at a step (rule 12)", () => {
  // Half the visits to a go to a lost end.
  const m = line(4, [{ id: "a", work: 1, dropoffBenchmark: 0.5, next: [{ to: "won", p: 0.5 }, { to: "lost", p: 0.5 }] }], { r: 2 });
  const r = simulate(m, 12, 1);

  it("counts the visits a step sends straight to a lost end", () => {
    const st = r.steps.a!;
    expect(st.lostHere).toBeGreaterThan(0);
    expect(st.lostHere! / st.departures).toBeCloseTo(r.lost / (r.won + r.lost), 1);
    expect(st.p90!.lostShare).toBeGreaterThan(0.3);
  });

  it("rates the lost share against the step's benchmark: at or better is Great, then 1.25x, 1.5x", () => {
    const at = (lostShare: number, benchmark = 0.2) => {
      const model = { ...m, steps: [{ ...m.steps[0]!, dropoffBenchmark: benchmark }] };
      const departures = r.steps.a!.departures;
      const tampered: SimulationResult = { ...r, steps: { a: { ...r.steps.a!, lostHere: lostShare * departures, p90: undefined } } };
      return find(detectIssues(model, tampered, NO_ESC), "dropoff:step:a")?.rating ?? "great";
    };
    // Benchmark 20%: 20% is the benchmark, 25% is 1.25x, 30% is 1.5x.
    expect([0, 0.2, 0.2 + 1e-6, 0.25, 0.25 + 1e-6, 0.3, 0.3 + 1e-6, 0.6].map((s) => at(s))).toEqual(["great", "great", "good", "good", "bad", "bad", "risk", "risk"]);
  });

  it("reads the benchmark from the step, and rates nothing without one", () => {
    // About half the visits are lost against a benchmark of 30%: 1.7x, Operational risk.
    const strict = { ...m, steps: [{ ...m.steps[0]!, dropoffBenchmark: 0.3 }] };
    const issue = find(detectIssues(strict, r, NO_ESC), "dropoff:step:a")!;
    expect(issue.type).toBe("failure");
    expect(issue.rating).toBe("risk");
    expect(issue.title).toMatch(/^\d+% of work is lost at Step a$/);
    expect(issue.metrics.benchmark).toBe(0.3);
    expect(issue.metrics.benchmark_ratio).toBeCloseTo(issue.metrics.lost_share! / 0.3, 9);
    const none = { ...m, steps: [{ ...m.steps[0]!, dropoffBenchmark: undefined }] };
    expect(find(detectIssues(none, r, NO_ESC), "dropoff:step:a")).toBeUndefined();
  });

  it("raises a bad month (P90) one level, like the other rules", () => {
    // A benchmark of 50% and 40% lost on average is 0.8x: Great.
    const tight = { ...m, steps: [{ ...m.steps[0]!, dropoffBenchmark: 0.5 }] };
    const at = (p90: number) => ({ ...r, steps: { a: { ...r.steps.a!, lostHere: 0.4 * r.steps.a!.departures, p90: { ...r.steps.a!.p90!, lostShare: p90 } } } });
    const NO_BN = { escalators: { bottleneck: false } };
    expect(find(detectIssues(tight, at(0.45), NO_BN), "dropoff:step:a")).toBeUndefined();
    // A bad month of 70% lost is 1.4x, past the next cut-off (1x): raised one level, to Good.
    expect(find(detectIssues(tight, at(0.7), NO_BN), "dropoff:step:a")).toMatchObject({ rating: "good", escalation: { base: "great", badMonth: true } });
  });

  it("is switched off by the rule's switch, and an override on the step", () => {
    expect(find(detectIssues(m, r, { rules: { dropoff: { enabled: false } } }), "dropoff:step:a")).toBeUndefined();
    expect(find(detectIssues(m, r, { rules: { dropoff: { overrides: [{ kind: "step", id: "a", cutoffs: [9, 9, 9] }] } } }), "dropoff:step:a")).toBeUndefined();
  });

  it("does not count work lost further on, nor a win that is lost downstream", () => {
    const m2 = line(4, [{ id: "a", next: [{ to: "b", p: 1 }] }, { id: "b", next: [{ to: "won", p: 0.5 }, { to: "lost", p: 0.5 }] }], { r: 2 });
    const r2 = simulate(m2, 8, 1);
    expect(r2.steps.a!.lostHere).toBe(0);
    expect(r2.steps.b!.lostHere).toBeGreaterThan(0);
  });
});

describe("too slow overall (rule 13)", () => {
  const m = line(2, [{ id: "a", work: 4 }, { id: "b", work: 4 }], { r: 2 });
  const r = simulate(m, 12, 1);
  const mean = r.kpi.cycle.mean;

  it("rates end-to-end time against the process's target", () => {
    const at = (ratio: number) => {
      const model = { ...m, targetCycleHours: mean / ratio };
      return find(detectIssues(model, r, NO_ESC), "cycle:process:pipeline")?.rating ?? "great";
    };
    expect([0.5, 1, 1 + 1e-6, 1.25, 1.25 + 1e-6, 1.5, 1.5 + 1e-6, 3].map(at)).toEqual(["great", "great", "good", "good", "bad", "bad", "risk", "risk"]);
  });

  it("rates nothing without a target", () => {
    expect(detectIssues(m, r, NO_ESC).map((i) => i.key).filter((k) => k.startsWith("cycle"))).toEqual([]);
  });

  it("names the process it is for, so an override on the process applies", () => {
    const model = { ...m, targetCycleHours: mean / 2 };
    expect(find(detectIssues(model, r, NO_ESC, { processId: "p1" }), "cycle:process:p1")?.rating).toBe("risk");
    const loose = { rules: { cycle: { overrides: [{ kind: "process" as const, id: "p1", cutoffs: [3, 4, 5] as const }] } }, ...NO_ESC };
    expect(find(detectIssues(model, r, loose, { processId: "p1" }), "cycle:process:p1")).toBeUndefined();
  });

  it("carries the numbers behind it", () => {
    const issue = find(detectIssues({ ...m, targetCycleHours: mean / 1.3 }, r, NO_ESC), "cycle:process:pipeline")!;
    expect(issue.type).toBe("delay");
    expect(issue.metrics.target_ratio).toBeCloseTo(1.3, 9);
    expect(issue.metrics.cycle_mean_hours).toBe(mean);
  });
});

describe("goals met (rule 11)", () => {
  const m = line(4, [{ id: "a" }], { r: 2 });
  const r = simulate(m, 10, 1);
  const source = (...measures: SuccessMeasure[]) => ({ measures: () => measures });
  const wins: SuccessMeasure = { id: "wins", name: "Win a million items", kpi: "won", direction: "atLeast", target: 1e6 };

  /** A run whose replications win 1..n items, so a target of k is met by n - k + 1 of them. */
  const tampered = (n: number): SimulationResult => ({ ...r, samples: { ...r.samples, won: Array.from({ length: n }, (_, i) => i + 1), lost: Array.from({ length: n }, () => 0) } });

  it("does nothing without a source (the stub until A54)", () => {
    expect(NO_SUCCESS_MEASURES.measures()).toEqual([]);
    expect(detectIssues(m, r, NO_ESC).map((i) => i.key).filter((k) => k.startsWith("success"))).toEqual([]);
    expect(checkSuccessMeasures(NO_SUCCESS_MEASURES, m, r)).toEqual([]);
  });

  it("rates the share of runs that meet the target: 80% or more Great, 50-80% Good, 20-50% Bad, under 20% Operational risk", () => {
    // Ten runs win 1..10 items. A target of k "at least" is met by 11 - k runs.
    const share = (met: number) => {
      const measure: SuccessMeasure = { ...wins, target: 11 - met };
      return find(detectIssues(m, tampered(10), NO_ESC, { successMeasures: source(measure) }), "success:measure:wins")?.rating ?? "great";
    };
    expect([10, 8, 7, 5, 4, 2, 1, 0].map(share)).toEqual(["great", "great", "good", "good", "bad", "bad", "risk", "risk"]);
  });

  it("checks 'at most' targets, and each KPI reads a per-replication number", () => {
    const check = (measure: SuccessMeasure) => checkSuccessMeasures(source(measure), m, tampered(10))[0]!;
    expect(check({ ...wins, direction: "atMost", target: 3 })).toMatchObject({ status: "rated", met: 3, metShare: 0.3 });
    expect(check({ ...wins, kpi: "winsPerWeek", target: 5 / 26 })).toMatchObject({ status: "rated", met: 6 });
    expect(check({ ...wins, kpi: "winRate", target: 1 })).toMatchObject({ status: "rated", met: 10 });
    expect(check({ ...wins, kpi: "cycleHours", direction: "atMost", target: 1e9 }).status).toBe("rated");
    for (const kpi of ["newMrr", "billed", "labour", "wipEnd"] as const) expect(check({ ...wins, kpi, target: 0 })).toMatchObject({ status: "rated", reps: 10 });
  });

  it("reports a measure the simulation can't compute as not checked, and does not rate it", () => {
    const manual: SuccessMeasure = { id: "nps", name: "Clients rate us 9 out of 10", kpi: null, direction: "atLeast", target: 9 };
    const checks = checkSuccessMeasures(source(manual, { ...wins, target: 1 }), m, r);
    expect(checks[0]).toMatchObject({ status: "not_checked", reason: "Not checked by simulation" });
    expect(checks[1]!.status).toBe("rated");
    expect(find(detectIssues(m, r, NO_ESC, { successMeasures: source(manual) }), "success:measure:nps")).toBeUndefined();
    expect(checkSuccessMeasures(source({ ...wins, target: Number.NaN }), m, r)[0]).toMatchObject({ status: "not_checked" });
  });

  it("raises an insight with the numbers, and follows overrides on the process", () => {
    const issue = find(detectIssues(m, r, NO_ESC, { successMeasures: source(wins) }), "success:measure:wins")!;
    expect(issue).toMatchObject({ type: "failure", rating: "risk", title: "Goal not reliably met: Win a million items" });
    expect(issue.metrics).toMatchObject({ met_share: 0, runs_met: 0, runs: 10, target: 1e6 });
    const off = { rules: { success: { overrides: [{ kind: "process" as const, id: "p1", enabled: false }] } }, ...NO_ESC };
    expect(find(detectIssues(m, r, off, { processId: "p1", successMeasures: source(wins) }), "success:measure:wins")).toBeUndefined();
  });
});

describe("step fields: expected wait and lost per day of waiting", () => {
  // One busy worker: items queue, so the step waits.
  const m = line(1.9, [{ id: "a", work: 20, expectedWaitHours: 4, lostPerDayWaiting: 0.05 }], { r: 1 });
  const r = simulate(m, 12, 1);

  it("rates the wait against the step's own expected wait", () => {
    const issue = find(detectIssues(m, r, NO_ESC), "wait:step:a")!;
    expect(issue.metrics.expected_wait_hours).toBe(4);
    const looser = { ...m, steps: [{ ...m.steps[0]!, expectedWaitHours: 400 }] };
    expect(find(detectIssues(looser, r, NO_ESC), "wait:step:a")).toBeUndefined();
  });

  it("carries lost per day of waiting into the insight for A43's cost: linear in the days waited, capped", () => {
    const issue = find(detectIssues(m, r, NO_ESC), "wait:step:a")!;
    expect(issue.metrics.lost_per_day_waiting).toBe(0.05);
    expect(issue.metrics.lost_to_waiting_share).toBeCloseTo(Math.min(1, 0.05 * (r.steps.a!.avgWait / 8)), 9);
    const without = { ...m, steps: [{ ...m.steps[0]!, lostPerDayWaiting: undefined }] };
    expect(find(detectIssues(without, r, NO_ESC), "wait:step:a")!.metrics.lost_per_day_waiting).toBeUndefined();
  });

  it("changes nothing in the simulation", () => {
    const plain = { ...m, steps: [{ ...m.steps[0]!, expectedWaitHours: undefined, lostPerDayWaiting: undefined, dropoffBenchmark: undefined }], targetCycleHours: undefined };
    const withFields = { ...m, steps: [{ ...m.steps[0]!, dropoffBenchmark: 0.1 }], targetCycleHours: 10 };
    expect(simulate(withFields, 6, 3).kpi).toEqual(simulate(plain, 6, 3).kpi);
  });
});
