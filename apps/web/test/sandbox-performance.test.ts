import { describe, expect, it } from "vitest";
import { DEFAULT_PURPOSES, northbeamPersonIds, northbeamRoleIds, type SandboxChange } from "@transpera-flow/db";
import { toRatingConfig } from "@transpera-flow/engine";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { forecastModel } from "@/lib/forecast/forecast";
import { Cancel, runGoalSeek, runTornado, syncRunner } from "@/lib/sandbox/analysis-run";
import { GOAL_LEVERS, goalChange, seekSpecFor, targetSpec } from "@/lib/sandbox/goal-targets";
import { tornadoValue } from "@/lib/sandbox/measures";
import { tornadoVariants } from "@/lib/sandbox/tornado";
import { simulate } from "@transpera-flow/engine";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { spliceMonthly, prepareScenario, MAX_SEGMENTS } from "@transpera-flow/db/sandbox";

// The worst scenarios the Sandbox will run (docs/plans/sandbox-p1-brief.md §6, sandbox-p3-brief.md §9). Only a headcount cut (D5) and a
// solution going live (E6) still cost a run per month; every other timed change is a channel read inside one run. So the worst case is
// still seven runs (six D5/E6 months), each at 30 replications from the pinned warm-up, and the channel-heavy case is one run with
// every channel on. A price rise also runs its pair without the rise (two runs). Limits: each run 4 x 250 ms (the 12-month forecast's
// budget, as horizon-performance.test.ts scales it), the seven together under 7 s one after the other (the app spreads them over the
// worker pool, so this is the slowest case), and the one-run cases under 2 s. Timing tests can fail on a loaded machine: re-run alone.
// The numbers are recorded in docs/engine-versioning.md ("Sandbox scenarios").

const START = DEMO_FORECAST_START;
const bundle = demoForecastBundle();
const id = (n: number) => `5e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PPC = northbeamRoleIds.ppc;
const eff = (list: SandboxChange[]) => list.map((change) => ({ change, scenarioId: "s", scenarioName: "S", inherited: false }));

const cuts = (): SandboxChange[] => [
  { id: id(1), lever: "D5", target: PPC, op: "add", value: 1, from: "2026-11" },
  { id: id(2), lever: "D5", target: PPC, op: "add", value: -1, from: "2027-01" },
  { id: id(3), lever: "D5", target: PPC, op: "add", value: 1, from: "2027-03" },
  { id: id(4), lever: "D5", target: PPC, op: "add", value: -1, from: "2027-05" },
  { id: id(5), lever: "E6", target: DEMO_FORECAST_SOLUTION_ID, op: "set", value: 1, from: "2027-07" },
  { id: id(6), lever: "D5", target: PPC, op: "add", value: 1, from: "2027-09" },
  // Channels and people on top: none of these costs a run.
  { id: id(7), lever: "D1", target: PPC, op: "set", value: 1, from: "2027-02" },
  { id: id(8), lever: "D3", target: northbeamPersonIds["Dan Okafor"]!, op: "set", value: 2, from: "2027-03-01" },
  { id: id(9), lever: "D2", target: northbeamPersonIds["Leah Brooks"]!, op: "set", value: 0, from: "2027-08" },
  { id: id(10), lever: "A1", target: null, op: "multiply", value: 1.1, from: "2027-01" },
  { id: id(11), lever: "B2", target: null, op: "multiply", value: 1.05, from: "2027-04" },
];

const channelHeavy = (): SandboxChange[] => [
  { id: id(21), lever: "A1", target: null, op: "multiply", value: 1.1, from: "2026-11" },
  { id: id(22), lever: "A1", target: null, op: "multiply", value: 1.05, from: "2027-03" },
  { id: id(23), lever: "B2", target: null, op: "multiply", value: 1.05, from: "2027-02" },
  { id: id(24), lever: "B3", target: null, op: "multiply", value: 0.9, from: "2027-04" },
  { id: id(25), lever: "D6", target: null, op: "multiply", value: 0.9, from: "2027-05" },
  { id: id(26), lever: "D4", target: northbeamPersonIds["Dan Okafor"]!, op: "multiply", value: 0.8, from: "2027-06" },
  { id: id(27), lever: "D1", target: PPC, op: "set", value: 1, from: "2027-02" },
];

/** Time one full prepared scenario: each segment once after a warm-up run. */
function time(changes: SandboxChange[], rise: boolean) {
  const prepared = prepareScenario(bundle, eff(changes), [DEMO_FORECAST_SOLUTION], 12, START);
  if (prepared.error !== null) throw new Error(prepared.error);
  expect(prepared.problems).toEqual([]);
  const runOf = (segments: typeof prepared.segments) => {
    const first = segments[0]!;
    simulate(first.model, 30, 1, { monthly: true, monthStarts: prepared.monthStarts, ...(prepared.start ? { initialState: prepared.start } : {}) });
    const each: number[] = [];
    const runs = segments.map((m) => {
      const t = performance.now();
      const result = simulate(m.model, 30, 1, { monthly: true, monthStarts: prepared.monthStarts, ...(prepared.start ? { initialState: prepared.start } : {}) });
      each.push(performance.now() - t);
      return { from: m.from, monthly: result.monthly! };
    });
    return { each, runs };
  };
  const main = runOf(prepared.segments);
  const pair = rise && prepared.pair ? runOf(prepared.pair) : null;
  return { prepared, main, pair };
}

describe("the largest Sandbox scenario: seven segments", { tags: ["perf"] }, () => {
  it("runs each segment under 4 x 250 ms and all seven under 7 s, sequentially", { timeout: 60_000 }, () => {
    const { prepared, main } = time(cuts(), false);
    expect(prepared.segments).toHaveLength(MAX_SEGMENTS);
    const total = main.each.reduce((a, b) => a + b, 0);
    const t = performance.now();
    const spliced = spliceMonthly(main.runs);
    const splice = performance.now() - t;
    console.info(`Sandbox, 7 segments at 12 months: ${main.each.map((e) => e.toFixed(0)).join(", ")} ms; total ${total.toFixed(0)} ms (limit 7000); splice ${splice.toFixed(1)} ms`);
    expect(spliced).toBeDefined();
    for (const e of main.each) expect(e).toBeLessThan(4 * 250);
    expect(total).toBeLessThan(7000);
  });
});

describe("a channel-heavy Sandbox scenario: one run", { tags: ["perf"] }, () => {
  it("runs once, under 1 s, with the leads, fee, churn, hours and capacity channels and a hire all on", { timeout: 60_000 }, () => {
    const { prepared, main } = time(channelHeavy(), false);
    expect(prepared.segments).toHaveLength(1);
    console.info(`Sandbox, channel-heavy, 1 run at 12 months: ${main.each[0]!.toFixed(0)} ms (limit 1000)`);
    expect(main.each[0]!).toBeLessThan(1000);
  });

  it("runs a price rise as two runs (the scenario and its pair without the rise), each under 1 s", { timeout: 60_000 }, () => {
    const rise: SandboxChange = { id: id(31), lever: "B5", target: null, op: "set", value: 0.1, from: "2027-03" };
    const { prepared, main, pair } = time([...channelHeavy(), rise], true);
    expect(prepared.segments).toHaveLength(1);
    expect(pair).not.toBeNull();
    const both = [main.each[0]!, pair!.each[0]!];
    console.info(`Sandbox, price rise, 2 runs at 12 months: ${both.map((e) => e.toFixed(0)).join(", ")} ms (limit 1000 each)`);
    for (const e of both) expect(e).toBeLessThan(1000);
  });
});

// Goal seek and the tornado (sandbox phase 5b, docs/plans/sandbox-p5-brief.md section 13): sets of ordinary runs of the scenario at 30 replications,
// one after the other here (the page spreads them over three workers, so its wall time is about a third). The numbers are recorded in
// docs/engine-versioning.md.
describe("goal seek and the tornado at 12 months", { tags: ["perf"] }, () => {
  const ctx = { bundle, solutions: [DEMO_FORECAST_SOLUTION], months: 12, startDate: START };
  const run = syncRunner(ctx);
  const cutoffs = toRatingConfig(ANALYSIS_DEFAULTS, bundle.workspace.settings.hours_per_week).rules.busy.cutoffs;

  it("a goal seek over headcount, 0 to 10 more people, is at most 8 runs and under 8 s sequentially", { timeout: 60_000 }, async () => {
    const d5 = GOAL_LEVERS.find((l) => l.id === "D5")!;
    const choice = { lever: d5, targetId: PPC, from: null, lo: 0, hi: 10 };
    // A limit between what 0 and 10 more people give, so the target flips inside the range and the search has to bisect.
    const at = async (x: number) => targetSpec({ kind: "busy", roleId: PPC, roleName: null, limit: 1, nines: false }, "GBP").measure((await run([{ change: goalChange(choice, x), scenarioId: "p", scenarioName: "", inherited: false }]).promise).result.monthly!)!;
    const limit = ((await at(0)) + (await at(10))) / 2;
    const target = targetSpec({ kind: "busy", roleId: PPC, roleName: null, limit, nines: false }, "GBP");
    const t = performance.now();
    const out = await runGoalSeek(seekSpecFor(choice, target), run, [], (x) => goalChange(choice, x), (r) => target.measure(r.result.monthly!), new Cancel());
    const ms = performance.now() - t;
    console.info(`Goal seek over D5 0 to 10 at 12 months: ${out.state.probes.length} runs, ${ms.toFixed(0)} ms (limit 8000); answer ${out.answer.kind}`);
    expect(out.finished).toBe(true);
    expect(out.answer.kind).toBe("boundary");
    expect(out.state.probes.length).toBeGreaterThan(2);
    expect(out.state.probes.length).toBeLessThanOrEqual(8);
    expect(ms).toBeLessThan(8000);
  });

  it("the tornado on seeded Northbeam is at most 25 runs and under 25 s sequentially, for profit and for peak busy", { timeout: 120_000 }, async () => {
    const model = forecastModel(bundle, 12, START).model!;
    for (const measure of ["profit", "peakBusy"] as const) {
      const variants = tornadoVariants(model, [], measure);
      const t = performance.now();
      const out = await runTornado(variants, run, [], (r) => tornadoValue(measure, r.result.monthly!, { cutoffs, categories: DEFAULT_PURPOSES }), new Cancel());
      const ms = performance.now() - t;
      console.info(`Tornado (${measure}) at 12 months: ${variants.length} levers, ${out.runs} runs, ${ms.toFixed(0)} ms (limit 25000), ${out.bars.length} bars`);
      expect(out.finished).toBe(true);
      expect(out.runs).toBeLessThanOrEqual(25);
      expect(ms).toBeLessThan(25_000);
    }
  });
});
