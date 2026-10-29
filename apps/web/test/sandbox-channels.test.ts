import { describe, expect, it } from "vitest";
import type { SandboxChange } from "@transpera-flow/db";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { monthBounds } from "@/lib/forecast/positions";
import { channelsOf, isChannelChange, overheadsCarried } from "@/lib/sandbox/channels";
import { scenarioModel } from "@/lib/sandbox/run";

// The levers that change from a month become the engine's monthly channels (docs/plans/sandbox-p3-brief.md §5.4): an array per target
// that is exactly 1 (or the model's own value) before the first change, and each change applies on what is in force at its month.

const START = DEMO_FORECAST_START;
const bundle = demoForecastBundle();
const live = scenarioModel(bundle, 12, START);
if (!live.model) throw new Error("the demo's live model should build");
const model = live.model;
const bounds = monthBounds(live.monthStarts, model.horizonWeeks * model.hoursPerWeek);
const options = { bundle, bounds, startDate: START, hoursPerWeek: model.hoursPerWeek, d4Unhandled: new Set<string>() };
let n = 0;
const ch = (lever: string, op: SandboxChange["op"], value: number, from?: string, target: string | null = null, params?: SandboxChange["params"]): SandboxChange =>
  ({ id: `7c000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, lever, target, op, value, ...(from ? { from } : {}), ...(params ? { params } : {}) }) as SandboxChange;
const SV = Object.keys(model.services!)[0]!;

describe("channelsOf", () => {
  it("is nothing for no timed change, and for one at or after the horizon (which the runner lists as later)", () => {
    expect(channelsOf(model, [], options).channels).toBeUndefined();
    expect(channelsOf(model, [ch("A1", "multiply", 2, "2030-01")], options).channels).toBeUndefined();
  });

  it("writes the leads as 1 before the month and the multiple from it, with the starts of the run's months", () => {
    const { channels, problems } = channelsOf(model, [ch("A1", "multiply", 1.5, "2027-04")], options);
    expect(problems).toEqual([]);
    expect(channels!.starts).toEqual(live.monthStarts);
    expect(channels!.leads).toEqual([1, 1, 1, 1, 1, 1, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5]);
  });

  it("applies several changes to one target in month order, each on what is in force then", () => {
    const { channels } = channelsOf(model, [ch("A1", "multiply", 2, "2027-06"), ch("A1", "multiply", 1.5, "2027-04")], options);
    expect(channels!.leads).toEqual([1, 1, 1, 1, 1, 1, 1.5, 1.5, 3, 3, 3, 3]);
  });

  it("makes a conversion change a channel of its own and leaves the others out", () => {
    const { channels } = channelsOf(model, [ch("A3", "multiply", 1.2, "2027-04")], options);
    expect(channels!.conv).toEqual([1, 1, 1, 1, 1, 1, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2]);
    expect(channels!.leads).toBeUndefined();
    expect(channels!.churn).toBeUndefined();
  });

  it("starts a change on or before the start of the run in month 0", () => {
    const { channels } = channelsOf(model, [ch("A3", "multiply", 1.2, "2026-10")], options);
    expect(channels!.conv).toEqual(new Array(12).fill(1.2));
  });

  it("turns a change with no month into a channel from month 0 only for the levers that have no other way (A3, D6, B5)", () => {
    const none = new Set<string>();
    expect(isChannelChange(ch("A3", "multiply", 1.2), none)).toBe(true);
    expect(isChannelChange(ch("D6", "multiply", 0.9), none)).toBe(true);
    expect(isChannelChange(ch("B5", "set", 0.1), none)).toBe(true);
    expect(isChannelChange(ch("A1", "multiply", 1.2), none)).toBe(false);
    expect(isChannelChange(ch("B3", "multiply", 1.2), none)).toBe(false);
    expect(isChannelChange(ch("B2", "multiply", 1.1), none)).toBe(false);
    expect(isChannelChange(ch("B2", "multiply", 1.1, undefined, null, { who: "all" }), none)).toBe(true);
    // A timed change is a channel except a headcount cut, a solution and a person row; a D4 only when it was not done as a person row.
    expect(isChannelChange(ch("D5", "add", 1, "2027-04"), none)).toBe(false);
    expect(isChannelChange(ch("E6", "set", 1, "2027-04"), none)).toBe(false);
    const d4 = ch("D4", "multiply", 0.5, "2027-04");
    expect(isChannelChange(d4, none)).toBe(false);
    expect(isChannelChange(d4, new Set([d4.id]))).toBe(true);
  });

  it("moves a service's fee and its fee range, and says what it could not do", () => {
    const { channels, problems } = channelsOf(model, [ch("B2", "multiply", 1.1, "2027-04", SV), ch("A1", "multiply", 2, "2027-04", "5ead0000-0000-4000-8000-00000000dead")], options);
    expect(channels!.newFee?.[SV]).toEqual([1, 1, 1, 1, 1, 1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1]);
    expect(problems.map((p) => p.message)).toEqual(["A lead source in this scenario is no longer there"]);
  });

  it("writes a base churn change as a ratio per month, and overheads as the months' own amounts", () => {
    const { channels } = channelsOf(model, [ch("B3", "multiply", 2, "2027-04", SV), ch("C2", "add", 1000, "2027-04")], options);
    expect(channels!.churn?.[SV]).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    // The demo has no overheads: the model carries the highest month's amount and the channel is the share of it each month.
    expect(model.overheadMonthly ?? 0).toBe(0);
    expect(channels!.overheads).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(overheadsCarried(model, channels, [ch("C2", "add", 1000, "2027-04")])).toBe(1000);
  });
});

describe("channelsOf: review fixes", () => {
  it("a fee for everyone set from a month after an earlier rise is the value itself, not the value times the rise; a plus adds to the fee in force", () => {
    const price = model.services![SV]!.price;
    const { channels } = channelsOf(model, [ch("B5", "set", 0.1, "2027-04", SV), ch("B2", "set", 5000, "2027-06", SV, { who: "all" })], options);
    // Months 6 and 7 (April, May) at +10%; from June (month 8) the fee is 5,000 whatever came before.
    expect(channels!.fee![SV]!.slice(0, 8)).toEqual([1, 1, 1, 1, 1, 1, 1.1, 1.1]);
    for (const f of channels!.fee![SV]!.slice(8)) expect(f * price).toBeCloseTo(5000, 9);
    const plus = channelsOf(model, [ch("B5", "set", 0.1, "2027-04", SV), ch("B2", "add", 100, "2027-06", SV, { who: "all" })], options).channels!;
    for (const f of plus.fee![SV]!.slice(8)) expect(f * price).toBeCloseTo(price * 1.1 + 100, 9);
  });

  it("base churn from a month on clients in one pool is the '*' factor on the model's churn (per-service arrays never reach a pool)", () => {
    const pooledBundle = { ...bundle, clientGroups: (bundle.clientGroups ?? []).map((g) => ({ ...g, client_count: 0 })), clients: [] };
    const pooled = scenarioModel(pooledBundle, 12, START);
    if (!pooled.model) throw new Error("the pooled demo should build");
    expect(pooled.model.clients).toBeUndefined();
    const { channels, problems } = channelsOf(pooled.model, [ch("B3", "multiply", 1.5, "2027-04")], { ...options, bundle: pooledBundle });
    expect(problems).toEqual([]);
    expect(channels!.churn).toEqual({ "*": [1, 1, 1, 1, 1, 1, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5] });
  });
});
