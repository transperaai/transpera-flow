import { describe, expect, it } from "vitest";
import { northbeamPersonIds, northbeamRoleIds, type SandboxChange } from "@transpera-flow/db";
import { simulate, type MonthlyResult } from "@transpera-flow/engine";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { spliceMonthly } from "@/lib/forecast/splice";
import { prepareScenario } from "@/lib/sandbox/run";

// Sandbox phase 3, §1: a change from a month leaves the months before it exactly as the run without it. Each kind of timed change, run
// through the Sandbox's own preparation (pinned warm-up, channels, segments), is compared with the scenario that has no changes.

const START = DEMO_FORECAST_START;
const bundle = demoForecastBundle();
const PPC = northbeamRoleIds.ppc;
const DAN = northbeamPersonIds["Dan Okafor"]!;
/** 2027-04 is the seventh month of a forecast that starts in October 2026: months 0 to 5 come before it. */
const MONTH = "2027-04";
const BEFORE = 6;
let n = 0;
const change = (c: Omit<SandboxChange, "id">): SandboxChange => ({ id: `7e000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, ...c }) as SandboxChange;
const eff = (list: SandboxChange[]) => list.map((c) => ({ change: c, scenarioId: "s", scenarioName: "S", inherited: false }));

function runOf(changes: SandboxChange[]): MonthlyResult {
  const p = prepareScenario(bundle, eff(changes), [DEMO_FORECAST_SOLUTION], 12, START);
  if (p.error !== null) throw new Error(p.error);
  expect(p.problems.filter((x) => !x.note)).toEqual([]);
  const runs = p.segments.map((s) => ({ from: s.from, monthly: simulate(s.model, 8, 1, { monthly: true, monthStarts: p.monthStarts, ...(p.start ? { initialState: p.start } : {}) }).monthly! }));
  return runs.length === 1 ? runs[0]!.monthly : spliceMonthly(runs);
}

/** Null or 0 all through, in a number, a list or an object of them (a `Stat` of zeros, or a split of hours by purpose, is nobody's too). */
function isNobody(value: unknown): boolean {
  if (value === null || value === 0) return true;
  if (Array.isArray(value)) return value.every(isNobody);
  if (typeof value === "object" && value !== undefined) return Object.values(value as object).every(isNobody);
  return false;
}

/** Equal, except a money figure may differ in its last bits (a stay's fee is spread over its months by amount / length x overlap). */
function expectSame(received: unknown, expected: unknown, path = "monthly"): void {
  if (typeof received === "number" && typeof expected === "number") {
    const tolerance = /\.(revenue|money|mrr)(\.|\[|$)/.test(path) ? 1e-9 * Math.max(1, Math.abs(received), Math.abs(expected)) : 0;
    if (Math.abs(received - expected) > tolerance) throw new Error(`${path}: ${received} is not ${expected}`);
    return;
  }
  if (Array.isArray(received) && Array.isArray(expected)) {
    expect(received.length, path).toBe(expected.length);
    received.forEach((v, i) => expectSame(v, expected[i], `${path}[${i}]`));
    return;
  }
  if (received && expected && typeof received === "object" && typeof expected === "object") {
    // A person added by the scenario is not in the run without it: before the change they are nobody (null or 0 all through).
    const extra = Object.keys(received).filter((k) => !(k in expected));
    for (const k of extra) expect(isNobody((received as Record<string, unknown>)[k]), `${path}.${k}`).toBe(true);
    expect(Object.keys(received).filter((k) => k in expected).sort(), path).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected)) expectSame((received as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    return;
  }
  expect(received, path).toEqual(expected);
}
const firstMonths = (x: unknown, k: number): unknown => {
  if (Array.isArray(x)) return x.length === 12 ? x.slice(0, k).map((v) => firstMonths(v, k)) : x.map((v) => firstMonths(v, k));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([key]) => key !== "months").map(([key, v]) => [key, firstMonths(v, k)]));
  return x;
};

describe("months before a timed change are exactly the run without it", () => {
  const base = runOf([]);
  const cases: [string, () => SandboxChange[]][] = [
    ["leads (A1)", () => [change({ lever: "A1", target: null, op: "multiply", value: 1.5, from: MONTH })]],
    ["conversion (A3)", () => [change({ lever: "A3", target: null, op: "multiply", value: 1.3, from: MONTH })]],
    ["the fee new clients pay (B2)", () => [change({ lever: "B2", target: null, op: "multiply", value: 1.2, from: MONTH })]],
    ["base churn (B3)", () => [change({ lever: "B3", target: null, op: "multiply", value: 2, from: MONTH })]],
    ["a price rise (B5)", () => [change({ lever: "B5", target: null, op: "set", value: 0.1, from: MONTH })]],
    ["hours available (D6)", () => [change({ lever: "D6", target: null, op: "multiply", value: 0.7, from: MONTH })]],
    ["role cost (C1)", () => [change({ lever: "C1", target: PPC, op: "multiply", value: 1.3, from: MONTH })]],
    ["overheads (C2)", () => [change({ lever: "C2", target: null, op: "add", value: 4000, from: MONTH })]],
    ["a hire (D1)", () => [change({ lever: "D1", target: PPC, op: "set", value: 1, from: MONTH })]],
    ["leave (D3)", () => [change({ lever: "D3", target: DAN, op: "set", value: 2, from: "2027-04-05" })]],
    ["an FTE change (D4)", () => [change({ lever: "D4", target: DAN, op: "multiply", value: 0.5, from: MONTH })]],
    ["a headcount cut (D5, spliced)", () => [change({ lever: "D5", target: PPC, op: "add", value: 1, from: MONTH })]],
    ["a solution going live (E6, spliced)", () => [change({ lever: "E6", target: DEMO_FORECAST_SOLUTION_ID, op: "set", value: 1, from: MONTH })]],
  ];
  for (const [what, make] of cases) {
    it(what, () => {
      const changes = make();
      const scenario = runOf(changes);
      expectSame(firstMonths(scenario, BEFORE), firstMonths(base, BEFORE));
      // And the change does something after its month (the comparison is not of two equal runs).
      expect(JSON.stringify(firstMonths({ ...scenario }, 12))).not.toBe(JSON.stringify(firstMonths({ ...base }, 12)));
    });
  }
});
