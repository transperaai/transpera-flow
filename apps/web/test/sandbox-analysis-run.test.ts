import { describe, expect, it } from "vitest";
import { northbeamRoleIds, DEFAULT_PURPOSES } from "@transpera-flow/db";
import { toRatingConfig } from "@transpera-flow/engine";
import { forecastModel } from "@/lib/forecast/forecast";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { Cancel, runGoalSeek, runTornado, syncRunner, type Job, type Runner } from "@/lib/sandbox/analysis-run";
import { GOAL_LEVERS, answerSentence, clampRange, goalChange, monotoneWarning, seekSpecFor, targetSpec, type GoalChoice } from "@/lib/sandbox/goal-targets";
import { MAX_RUNS } from "@/lib/sandbox/goal-seek";
import { tornadoValue } from "@/lib/sandbox/measures";
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
