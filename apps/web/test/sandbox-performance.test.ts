import { describe, expect, it } from "vitest";
import { northbeamPersonIds, northbeamRoleIds, type SandboxChange } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { spliceMonthly } from "@/lib/forecast/splice";
import { prepareScenario, MAX_SEGMENTS } from "@/lib/sandbox/run";

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
