import { describe, expect, it } from "vitest";
import { northbeamRoleIds, DEFAULT_PURPOSES, parseChanges } from "@transpera-flow/db";
import type { ScenarioRun } from "@transpera-flow/db/sandbox";
import { simulate, toRatingConfig, type EngineModel } from "@transpera-flow/engine";
import { forecastModel } from "@/lib/forecast/forecast";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { Cancel, runGoalSeek, runTornado, syncRunner, type Job, type Runner } from "@/lib/sandbox/analysis-run";
import { GOAL_LEVERS, answerSentence, clampRange, goalChange, goalLevers, goalNote, monotoneWarning, seekSpecFor, targetSpec, type GoalChoice } from "@/lib/sandbox/goal-targets";
import { MAX_RUNS } from "@/lib/sandbox/goal-seek";
import { peakBusy, tornadoValue } from "@/lib/sandbox/measures";
import { tornadoVariants } from "@/lib/sandbox/tornado";

// Goal seek and the tornado end to end on the demo workspace (sandbox phase 5b): the real runner and engine on the calling thread, a short horizon.

const bundle = demoForecastBundle();
const ctx = { bundle, solutions: [], months: 3, startDate: DEMO_FORECAST_START };
const run = syncRunner(ctx);
const cutoffs = toRatingConfig(ANALYSIS_DEFAULTS, bundle.workspace.settings.hours_per_week).rules.busy.cutoffs;
const PPC = northbeamRoleIds.ppc;

describe("goal seek over headcount", { timeout: 120_000 }, () => {
  const d5 = GOAL_LEVERS.find((l) => l.id === "D5")!;
  const choice: GoalChoice = { lever: d5, targetId: PPC, from: null, lo: 0, hi: 10 };

  it("answers 'how many more stay under X% busy' in at most 8 runs, and the answer holds when run again", async () => {
    const t = targetSpec({ kind: "busy", roleId: PPC, roleName: "PPC specialist", limit: 0.6, nines: false }, "GBP");
    const out = await runGoalSeek(seekSpecFor(choice, t), run, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), new Cancel());
    expect(out.finished).toBe(true);
    expect(out.state.probes.length).toBeLessThanOrEqual(MAX_RUNS);
    const a = out.answer;
    expect(["boundary", "already", "unreachable"]).toContain(a.kind);
    expect(answerSentence(a, choice, t, "PPC specialists")).toMatch(/\./);
    if (a.kind === "boundary") {
      // Re-run the answer and the value one step away: one meets the target, the other does not.
      const at = async (x: number) => t.measure((await run([{ change: goalChange(choice, x), scenarioId: "p", scenarioName: "", inherited: false }]).promise).result.monthly!)!;
      expect(t.meets(await at(a.x))).toBe(true);
      expect(t.meets(await at(a.failsAt))).toBe(false);
    }
  });

  it("is no more than the 'about N runs' the dialog says", async () => {
    const t = targetSpec({ kind: "busy", roleId: null, roleName: null, limit: 0.85, nines: false }, "GBP");
    const out = await runGoalSeek(seekSpecFor(choice, t), run, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), new Cancel());
    expect(out.state.probes.length).toBeLessThanOrEqual(6);
  });

  it("stops at once when cancelled, and releases what is running", async () => {
    const t = targetSpec({ kind: "busy", roleId: null, roleName: null, limit: 0.4, nines: false }, "GBP");
    const cancel = new Cancel();
    let started = 0;
    let cancelled = 0;
    const slow: Runner = (changes) => {
      started++;
      const inner = run(changes);
      return { promise: inner.promise.then((r) => (started === 2 ? cancel.cancel() : undefined, r)), cancel: () => void cancelled++ } satisfies Job;
    };
    const out = await runGoalSeek(seekSpecFor(choice, t), slow, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), cancel);
    expect(out.finished).toBe(false);
    expect(started).toBe(2);
    expect(cancelled).toBeGreaterThan(0);
  });

  it("monthly churn and profit targets read their own measures; a run without costs has no profit", async () => {
    const b2 = GOAL_LEVERS.find((l) => l.id === "B5")!;
    const c: GoalChoice = { lever: b2, targetId: "", from: null, lo: -0.1, hi: 0.2 };
    const churn = targetSpec({ kind: "churn", limit: 0.5 }, "GBP");
    const out = await runGoalSeek(seekSpecFor(c, churn), run, [], (x) => goalChange(c, x), (r) => churn.measure(r.result.monthly!), new Cancel());
    expect(out.answer.kind).toBe("already");
    const profit = targetSpec({ kind: "profit", threshold: 1, month: null, monthName: null, low: false }, "GBP");
    const hidden = { ...bundle, payHidden: true as const };
    const noCosts = await runGoalSeek(seekSpecFor(c, profit), syncRunner({ ...ctx, bundle: hidden }), [], (x) => goalChange(c, x), (r) => profit.measure(r.result.monthly!), new Cancel());
    expect(noCosts.answer.kind).toBe("cannot");
  });

  it("the range is held inside the registry's and on the lever's grid", () => {
    expect(clampRange(d5, -50, 99)).toEqual({ lo: -20, hi: 20 });
    expect(clampRange(d5, 3, 3)).toEqual({ lo: 3, hi: 4 });
    const e1 = GOAL_LEVERS.find((l) => l.id === "E1")!;
    expect(clampRange(e1, 0, 5)).toEqual({ lo: 0.1, hi: 2 });
  });

  it("a non-steady measure is explained in words", () => {
    const t = targetSpec({ kind: "busy", roleId: null, roleName: null, limit: 0.85, nines: false }, "GBP");
    const w = monotoneWarning({ kind: "boundary", x: 5, failsAt: 4, side: "high", monotone: { ok: false, between: [2, 3], direction: "rose" } }, choice, "Busy", "Designers");
    expect(w).toContain("doesn't move steadily with people in a role");
    expect(w).toContain("it rose between 2 more Designers and 3 more Designers");
    expect(t.clause).toContain("85%");
  });
});

describe("the tornado", { timeout: 180_000 }, () => {
  const model = forecastModel(bundle, 3, DEMO_FORECAST_START).model!;
  const o = { cutoffs, categories: DEFAULT_PURPOSES };

  it("ranks the levers for peak busy: every bar has two numbers, sorted, the scenario's own value in the middle", async () => {
    const variants = tornadoVariants(model, [], "peakBusy");
    const seen: number[] = [];
    const out = await runTornado(variants, run, [], (r) => tornadoValue("peakBusy", r.result.monthly!, o), new Cancel(), (_bars, _base, done) => void seen.push(done));
    expect(out.finished).toBe(true);
    expect(out.runs).toBe(1 + variants.length * 2 + 1);
    expect(out.bars.length).toBeGreaterThan(3);
    expect(out.bars.length).toBeLessThanOrEqual(10);
    expect(out.bars.map((b) => b.size)).toEqual([...out.bars.map((b) => b.size)].sort((a, b) => b - a));
    expect(out.bars[0]!.size).toBeGreaterThan(0);
    // Bars arrive as lever after lever finishes.
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(out.runs);
    // Headcount moves peak busy the right way: one more person on the busiest role cannot make it busier.
    const d5 = out.results.find((r) => r.leverId === "D5");
    if (d5) expect(d5.high!).toBeLessThanOrEqual(d5.low! + 1e-9);
  });

  it("ranks for profit including the money levers: a dearer role or heavier overheads cut profit", async () => {
    const variants = tornadoVariants(model, [], "profit");
    const out = await runTornado(variants, run, [], (r) => tornadoValue("profit", r.result.monthly!, o), new Cancel());
    const get = (id: string) => out.results.find((r) => r.leverId === id)!;
    // The demo workspace has no overheads, so there is nothing for ×0.9 and ×1.1 to move: the lever is not tried.
    expect(variants.some((v) => v.leverId === "C2")).toBe(false);
    expect(get("C1").high!).toBeLessThanOrEqual(get("C1").low!);
    const rich = { ...bundle, workspace: { ...bundle.workspace, settings: { ...bundle.workspace.settings, overhead_monthly: 9000 } } };
    const withOverheads = tornadoVariants({ ...model, overheadMonthly: 9000 }, [], "profit");
    const dear = await runTornado(withOverheads.filter((v) => v.leverId === "C2"), syncRunner({ ...ctx, bundle: rich }), [], (r) => tornadoValue("profit", r.result.monthly!, o), new Cancel());
    expect(dear.results[0]!.high!).toBeLessThan(dear.results[0]!.low!);
  });

  it("cancelling stops asking and reports an unfinished tornado", async () => {
    const variants = tornadoVariants(model, [], "lost");
    const cancel = new Cancel();
    let n = 0;
    const cancelling: Runner = (c) => {
      if (++n === 4) cancel.cancel();
      return run(c);
    };
    const out = await runTornado(variants, cancelling, [], (r) => tornadoValue("lost", r.result.monthly!, o), cancel);
    expect(out.finished).toBe(false);
  });
});

describe("goal seek, hand-checked on a model whose answer is arithmetic", () => {
  // One role "r" of 1 person (40 h a week), 30 pooled clients each needing 4 h a week of it, constant times, no leads, no churn: the work is
  // exactly 120 h a week in every month and every run, so busy = 120 / (40 × people) = 3 / people. "At most 85% busy" needs 3 / n <= 0.85,
  // n >= 3.53, so 4 people: 3 more. The bisection over 0 to 10 more: the ends (1 person: 300%, fails; 11: 27%, meets), then 5 (6 people: 50%,
  // meets), then 3 (4 people: 75%, meets; the middle of 0 and 5 is 2.5, which rounds up), then 2 (3 people: 100%, fails). 3 and 2 are one
  // apart: the answer is "at least 3 more", failing at 2, in 5 runs.
  const model = (people: number): EngineModel =>
    ({
      horizonWeeks: 13,
      hoursPerWeek: 40,
      leadsPerWeek: 0,
      activeClients: 30,
      churnMonthly: 0,
      retainer: 1000,
      warmupWeeks: 0,
      roles: { r: { name: "R", count: people, cost: 50, ongoing: 4 } },
      people: {},
      entry: "s1",
      sinks: { won: "won", lost: "lost" },
      steps: [{ id: "s1", name: "s1", role: "r", work: 2, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] }],
    }) as unknown as EngineModel;
  /** A runner for this model: the probe's D5 "add x" is x more people (the scenario's own changes are none). */
  const asked: number[] = [];
  const handRun: Runner = (changes) => {
    const x = changes.at(-1)!.change.value;
    asked.push(x);
    const result = simulate(model(1 + x), 30, 1, { monthly: true, monthStarts: [200, 400] });
    return { promise: Promise.resolve({ result } as unknown as ScenarioRun), cancel: () => {} };
  };
  const d5 = GOAL_LEVERS.find((l) => l.id === "D5")!;
  const choice: GoalChoice = { lever: d5, targetId: "r", from: null, lo: 0, hi: 10 };
  const busy = (limit: number) => targetSpec({ kind: "busy", roleId: "r", roleName: "R", limit, nines: false }, "GBP");

  it("the measured busy share is the arithmetic one at every headcount", () => {
    for (const n of [1, 2, 3, 4, 6]) expect(peakBusy(simulate(model(n), 30, 1, { monthly: true, monthStarts: [200, 400] }).monthly!, { roleId: "r" })).toBeCloseTo(3 / n, 9);
  });

  it("finds 3 more people for 85%, failing at 2, in the 5 runs worked out above, in that order", async () => {
    asked.length = 0;
    const t = busy(0.85);
    const out = await runGoalSeek(seekSpecFor(choice, t), handRun, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), new Cancel());
    expect(asked).toEqual([0, 10, 5, 3, 2]);
    expect(out.answer).toEqual({ kind: "boundary", x: 3, failsAt: 2, side: "high", monotone: { ok: true } });
    expect(answerSentence(out.answer, choice, t, "R")).toBe("At least 3 more R: R stays under 85% busy in every month.");
    // 9 in 10 runs is the same here: every run is the same.
    const t9 = targetSpec({ kind: "busy", roleId: "r", roleName: "R", limit: 0.85, nines: true }, "GBP");
    expect((await runGoalSeek(seekSpecFor(choice, t9), handRun, [], (x) => goalChange(choice, x), (r) => t9.measure(r.result.monthly!), new Cancel())).answer).toMatchObject({ kind: "boundary", x: 3 });
  });

  it("other limits land where the arithmetic says: 3 / n <= limit", async () => {
    for (const [limit, want] of [[0.5, 5], [0.6, 4], [0.75, 3], [1, 2], [0.3, 9]] as const) {
      const t = busy(limit);
      const out = await runGoalSeek(seekSpecFor(choice, t), handRun, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), new Cancel());
      expect(out.answer, `${limit}`).toMatchObject({ kind: "boundary", x: want, failsAt: want - 1 });
    }
  });

  it("already met across the range names the end nearest today; not reachable names the closest probe", async () => {
    const t = busy(0.85);
    const met = await runGoalSeek(seekSpecFor({ ...choice, lo: 4, hi: 10 }, t), handRun, [], (x) => goalChange({ ...choice, lo: 4, hi: 10 }, x), (r) => t.measure(r.result.monthly!), new Cancel());
    expect(met.answer).toMatchObject({ kind: "already", x: 4 });
    expect(met.state.probes).toHaveLength(2);
    const far = await runGoalSeek(seekSpecFor({ ...choice, lo: 0, hi: 1 }, t), handRun, [], (x) => goalChange({ ...choice, lo: 0, hi: 1 }, x), (r) => t.measure(r.result.monthly!), new Cancel());
    expect(far.answer).toMatchObject({ kind: "unreachable", closest: { x: 1, value: 1.5 } });
  });

  it("a measure that doesn't move one way is flagged, and the probes are all kept", async () => {
    // A made-up model in which 3 more people are as quiet as 10 more (busy 27%), then 5 more busier again (50%): it rises between 3 and 5.
    const t = busy(0.85);
    const bumpy: Runner = (changes) => {
      const x = changes.at(-1)!.change.value;
      const result = simulate(model(x === 3 ? 11 : 1 + x), 30, 1, { monthly: true, monthStarts: [200, 400] });
      return { promise: Promise.resolve({ result } as unknown as ScenarioRun), cancel: () => {} };
    };
    const out = await runGoalSeek(seekSpecFor(choice, t), bumpy, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), new Cancel());
    expect(out.answer).toMatchObject({ kind: "boundary", x: 3, failsAt: 2, monotone: { ok: false, between: [3, 5], direction: "rose" } });
    expect(out.state.probes.map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 2, 3, 5, 10]);
  });
});

describe("goal seek's levers and its note", () => {
  it("leaves out a lever whose kind Settings, Levers hides (as the change dialog does)", () => {
    expect(goalLevers([]).map((l) => l.id)).toEqual(["D5", "D6", "E1", "A1", "B5", "B2"]);
    expect(goalLevers(["people.headcount", "finances.prices"]).map((l) => l.id)).toEqual(["D6", "E1", "A1"]);
  });

  it("the note is cut whole characters at a time to 280, so an emoji in a name can't be split", () => {
    const long = `At least 3 more ${"\u{1F600}".repeat(300)}: every role stays under 85% busy in every month.`;
    const note = goalNote(long, "2026-10-29");
    expect(Array.from(note)).toHaveLength(280);
    expect(note.endsWith("…")).toBe(true);
    expect(note).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(parseChanges([{ id: "5e000000-0000-4000-8000-0000000000f0", lever: "D5", target: "@busiest", op: "add", value: 3, note }]).ok).toBe(true);
    expect(goalNote("Short.", "2026-10-29")).toBe("Goal seek: Short. (2026-10-29)");
  });
});

describe("a run that fails releases the others", () => {
  const model = forecastModel(bundle, 3, DEMO_FORECAST_START).model!;
  const o = { cutoffs, categories: DEFAULT_PURPOSES };
  it("the tornado: every other run is cancelled, and the error reaches the caller", async () => {
    const variants = tornadoVariants(model, [], "lost");
    let n = 0;
    let released = 0;
    const failing: Runner = (changes) => {
      const i = ++n;
      // The scenario's own run (asked first) finishes; then one variant fails while the rest are still running.
      if (i === 1) return run(changes);
      if (i === 3) return { promise: Promise.reject(new Error("bad variant")), cancel: () => {} };
      return { promise: new Promise<never>(() => {}), cancel: () => void released++ };
    };
    const cancel = new Cancel();
    await expect(runTornado(variants, failing, [], (r) => tornadoValue("lost", r.result.monthly!, o), cancel)).rejects.toThrow("bad variant");
    expect(cancel.cancelled).toBe(true);
    expect(released).toBe(n - 2);
  });

  it("goal seek: the other end's run is cancelled", async () => {
    const d5 = GOAL_LEVERS.find((l) => l.id === "D5")!;
    const choice: GoalChoice = { lever: d5, targetId: "", from: null, lo: 0, hi: 10 };
    const t = targetSpec({ kind: "busy", roleId: null, roleName: null, limit: 0.85, nines: false }, "GBP");
    let released = 0;
    let n = 0;
    const failing: Runner = () => (++n === 1 ? { promise: Promise.reject(new Error("bad probe")), cancel: () => {} } : { promise: new Promise<never>(() => {}), cancel: () => void released++ });
    await expect(runGoalSeek(seekSpecFor(choice, t), failing, [], (x) => goalChange(choice, x), (r) => t.measure(r.result.monthly!), new Cancel())).rejects.toThrow("bad probe");
    expect(released).toBe(1);
  });
});
