import { describe, expect, it } from "vitest";
import {
  activeChannels,
  initialState,
  northbeamWithMoney,
  northbeamWithServicing,
  northbeamWithServices,
  simulate,
  type EngineChannels,
  type EngineModel,
  type MonthlyResult,
} from "../src";

// Monthly channels (engine 1.12.0, sandbox phase 3): a change from a month is one run, and the months before it are exactly the run
// without it (the pinned warm-up keeps every arrival and draw where it was).

const MONTHS = 12;
const REPS = 6;

/** Where months 1..11 start in a 52-week run of 40-hour weeks (52/12-week months). */
const STARTS = Array.from({ length: MONTHS - 1 }, (_, i) => ((i + 1) * 52 * 40) / 12);

/** An array of `MONTHS` ones with `value` from month `from` on. */
const from = (month: number, value: number, base = 1): number[] => Array.from({ length: MONTHS }, (_, m) => (m < month ? base : value));

/**
 * Equal, except that a decimal may differ in its last bits: a client's fee is spread over the months of its whole stay by
 * `amount / length × overlap`, so a client who leaves at another time after the change has early months that differ by a rounding
 * (1e-16 of the figure). Any real leak (another arrival, draw or wait) moves figures by far more than the 1e-9 allowed here.
 */
function expectSame(received: unknown, expected: unknown, path = "monthly"): void {
  if (typeof received === "number" && typeof expected === "number") {
    // Only the money figures spread a stay's fee over its months, so only they can differ in the last bits.
    const spreadFigure = /\.(revenue|money|mrr)(\.|\[|$)/.test(path);
    const tolerance = spreadFigure ? 1e-9 * Math.max(1, Math.abs(received), Math.abs(expected)) : 0;
    if (Math.abs(received - expected) > tolerance) throw new Error(`${path}: ${received} is not ${expected}`);
    return;
  }
  if (Array.isArray(received) && Array.isArray(expected)) {
    expect(received.length, path).toBe(expected.length);
    received.forEach((v, i) => expectSame(v, expected[i], `${path}[${i}]`));
    return;
  }
  if (received && expected && typeof received === "object" && typeof expected === "object") {
    expect(Object.keys(received).sort(), path).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(received)) expectSame((received as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    return;
  }
  expect(received, path).toEqual(expected);
}

/** Keep only the first `k` months of every per-month array in a monthly result. */
function firstMonths(x: unknown, k: number): unknown {
  if (Array.isArray(x)) return x.length === MONTHS ? x.slice(0, k).map((v) => firstMonths(v, k)) : x.map((v) => firstMonths(v, k));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([key, v]) => [key, firstMonths(v, k)]));
  return x;
}

/** Both runs start from the live model's own warm-up (the Sandbox pins it): a channel in the horizon would otherwise size another one. */
const run = (model: EngineModel, channels?: EngineChannels) =>
  simulate(channels ? { ...model, channels } : model, REPS, 1, { monthly: true, monthStarts: STARTS, initialState: initialState(model) });

function monthsBefore(model: EngineModel, channels: EngineChannels, k = 3): { live: MonthlyResult; scenario: MonthlyResult; liveCut: unknown; scenarioCut: unknown } {
  const live = run(model).monthly!;
  const scenario = run(model, channels).monthly!;
  return { live, scenario, liveCut: firstMonths(live, k), scenarioCut: firstMonths(scenario, k) };
}

const base = (): EngineModel => ({ ...northbeamWithMoney(), horizonWeeks: 52 });
const named = (): EngineModel => ({ ...northbeamWithServicing(), horizonWeeks: 52 });
const pooled = (): EngineModel => ({ ...northbeamWithServices(), horizonWeeks: 52 });

function casesFor(model: EngineModel, roster: boolean): [string, EngineChannels, Partial<EngineModel>?][] {
  const heaviest = model.steps.filter((s) => s.role).sort((a, b) => b.work - a.work)[0]!;
  const waitStep = model.steps.find((s) => s.wait > 0)!;
  const noWaitStep = model.steps.find((s) => s.wait === 0 && s.role)!;
  const noReworkStep = model.steps.find((s) => s.rework === 0 && s.role && s.id !== heaviest.id)!;
  const role = Object.keys(model.roles)[0]!;
  const svc = Object.keys(model.services!);
  const person = model.people ? Object.keys(model.people)[0]! : "*";
  const own: [string, EngineChannels, Partial<EngineModel>?][] = [
    ["leads x1.4", { starts: STARTS, leads: from(3, 1.4) }],
    ["conv x0.7", { starts: STARTS, conv: from(3, 0.7) }],
    ["mix", { starts: STARTS, mix: { [svc[0]!]: from(3, 5, model.services![svc[0]!]!.mixShare) } }],
    ["newFee x1.2", { starts: STARTS, newFee: { "*": from(3, 1.2) } }],
    ["fee +8% for all", { starts: STARTS, fee: { "*": from(3, 1.08) } }],
    ["fee cut", { starts: STARTS, fee: { "*": from(3, 0.9) } }],
    ["churn x1.5", { starts: STARTS, churn: { "*": from(3, 1.5) } }],
    ["work x0.7", { starts: STARTS, work: { [heaviest.id]: from(3, 0.7) } }],
    ["wait +8 h", { starts: STARTS, wait: { [waitStep.id]: from(3, waitStep.wait + 8, waitStep.wait) } }],
    ["wait from none", { starts: STARTS, wait: { [noWaitStep.id]: from(3, 8, 0) } }],
    ["rework from none", { starts: STARTS, rework: { [noReworkStep.id]: from(3, 0.3, 0) } }],
    ["role cost x1.1", { starts: STARTS, roleCost: { [role]: from(3, 1.1) } }],
    ["overheads x1.25", { starts: STARTS, overheads: from(3, 1.25) }, { overheadMonthly: 18000 }],
    ["capacity x0.8", { starts: STARTS, capacity: { [person]: from(3, 0.8) } }],
    ["fee range", { starts: STARTS, priceRange: { [svc[0]!]: [null, null, null, { low: 100, high: 9000 }] } }],
  ];
  if (!roster) return own;
  return [
    ...own,
    ["fee +8% for one service", { starts: STARTS, fee: { [svc[0]!]: from(3, 1.08) } }],
    ["a driver as a chance", { starts: STARTS, drivers: { late: [null, null, null, { chance: null, effect: 0.6, months: 3 }] } }],
    ["an entered driver as a chance", { starts: STARTS, drivers: { results: [null, null, null, { chance: 0.2, effect: 1, months: 2 }] } }, { churnDrivers: [{ id: "results", weight: 1, enabled: true, value: 5 }] }],
    ["the price driver on a rise", { starts: STARTS, fee: { "*": from(3, 1.1) }, drivers: { price: [null, null, null, { chance: 0.5, effect: 1, months: 3 }] } }, { churnDrivers: [{ id: "price", weight: 1, enabled: true, value: 0 }] }],
  ];
}

describe.each([
  ["client groups with servicing and hourly PPC", base, true],
  ["a named roster", named, true],
  ["pooled clients", pooled, false],
])("channels: the months before a change are exactly the run without it (%s)", (_name, make, roster) => {
  const model = make();
  for (const [name, channels, patch] of casesFor(model, roster)) {
    it(`${name}: months 0 to 2 equal the run without it, and the run differs`, () => {
      const { scenario, live, liveCut, scenarioCut } = monthsBefore({ ...model, ...patch }, channels);
      expectSame(scenarioCut, liveCut);
      // It does something: the whole run differs.
      expect(JSON.stringify(scenario)).not.toEqual(JSON.stringify(live));
    });
  }
});

describe("channels: what the engine refuses and how it reads them", () => {
  const model = base();
  const at = (c: EngineChannels, extra: Partial<EngineModel> = {}) => ({ ...model, ...extra, channels: c });

  it("refuses numbers it can't run: negatives, rework above the maximum, month starts out of order or outside the run, unknown ids", () => {
    expect(() => simulate(at({ starts: STARTS, leads: from(3, -1) }), 1, 1)).toThrow(/numbers from 0/);
    expect(() => simulate(at({ starts: STARTS, rework: { audit: from(3, 0.99) } }), 1, 1)).toThrow(/0.95/);
    expect(() => simulate(at({ starts: [100, 50] }), 1, 1)).toThrow(/start/);
    expect(() => simulate(at({ starts: [0, 100] }), 1, 1)).toThrow(/start/);
    expect(() => simulate(at({ starts: [model.horizonWeeks * model.hoursPerWeek] }), 1, 1)).toThrow(/start/);
    expect(() => simulate(at({ starts: STARTS, work: { nope: from(3, 2) } }), 1, 1)).toThrow(/step 'nope'/);
    expect(() => simulate(at({ starts: STARTS, fee: { nope: from(3, 2) } }), 1, 1)).toThrow(/service 'nope'/);
    expect(() => simulate(at({ starts: STARTS, roleCost: { nope: from(3, 2) } }), 1, 1)).toThrow(/role 'nope'/);
    expect(() => simulate(at({ starts: STARTS, capacity: { nope: from(3, 2) } }), 1, 1)).toThrow(/person 'nope'/);
    expect(() => simulate(at({ starts: STARTS, leads: new Array<number>(MONTHS + 1).fill(1) }), 1, 1)).toThrow(/more months/);
  });

  it("when a run is asked month by month, the channels' months must be the run's", () => {
    expect(() => simulate(at({ starts: STARTS, leads: from(3, 2) }), 1, 1, { monthly: true, monthStarts: STARTS.map((h) => h + 1) })).toThrow(/month starts/);
    expect(() => simulate(at({ starts: STARTS, leads: from(3, 2) }), 1, 1, { monthly: true, monthStarts: STARTS })).not.toThrow();
  });

  it("an array shorter than the months holds its last value", () => {
    const short = simulate(at({ starts: STARTS, fee: { "*": [1, 1, 1.1] } }), 3, 1, { monthly: true, monthStarts: STARTS, initialState: initialState(model) }).monthly!;
    const full = simulate(at({ starts: STARTS, fee: { "*": from(2, 1.1) } }), 3, 1, { monthly: true, monthStarts: STARTS, initialState: initialState(model) }).monthly!;
    expect(short).toEqual(full);
  });

  it("a step that only gains rework from a month has its redo loop, with nothing in the months before", () => {
    const m = pooled();
    const step = m.steps.find((s) => s.rework === 0 && s.role)!;
    const res = simulate({ ...m, channels: { starts: STARTS, rework: { [step.id]: from(3, 0.3, 0) } } }, 3, 1, { initialState: initialState(m) });
    expect(res.loops!.some((l) => l.id === `redo:${step.id}`)).toBe(true);
  });

  it("people without names (head-counts) take capacity by the '*' key, and the capacity event reshares the pooled load", () => {
    const m = pooled();
    const slower = simulate({ ...m, channels: { starts: STARTS, capacity: { "*": from(3, 0.5) } } }, 3, 1, { monthly: true, monthStarts: STARTS, initialState: initialState(m) }).monthly!;
    const plain = simulate(m, 3, 1, { monthly: true, monthStarts: STARTS, initialState: initialState(m) }).monthly!;
    const someone = Object.keys(plain.people)[0]!;
    expect(slower.people[someone]![0]!.capacity).toBe(plain.people[someone]![0]!.capacity);
    expect(slower.people[someone]![5]!.capacity).toBeCloseTo(plain.people[someone]![5]!.capacity / 2, 9);
  });

  it("the replications of a model share its channels without changing them", () => {
    const channels: EngineChannels = { starts: STARTS, capacity: { "*": from(3, 0.5) } };
    const m = { ...pooled(), channels };
    const copy = structuredClone(channels);
    simulate(m, 2, 1);
    expect(m.channels).toEqual(copy);
    expect(activeChannels(m)).not.toBeNull();
  });
});
