import { describe, expect, it } from "vitest";
import {
  demandFactor,
  mulberry32,
  northbeamModel,
  northbeamWithServices,
  runOnce,
  simulate,
  WEEKS_PER_CALENDAR_MONTH,
  type EngineDemand,
  type EngineModel,
  type EngineService,
} from "../src";
import { arrivalTimes } from "../src/demand";
import { largeModel } from "./fixtures/large-model";

// Demand over the calendar (docs/PRD.md §6.3.2, issue #13): seasonality by
// calendar month and compounded monthly growth modulate a Poisson arrival
// rate; a model without them simulates exactly as before.

const JAN_TO_DEC = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2 in January, 0.5 in July, nothing in December, 1 otherwise. */
const SEASONS = [2, 1, 1, 1, 1, 1, 0.5, 1, 1, 1, 1, 0];

/** A pass-through model: arrivals go straight to `won`, so only arrivals matter. Weeks of 1 hour. */
function stream(leadsPerWeek: number, horizonWeeks: number, demand?: EngineDemand, overrides: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks,
    hoursPerWeek: 1,
    leadsPerWeek,
    ...(demand ? { demand } : {}),
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    roles: {},
    warmupWeeks: 0,
    entry: "in",
    sinks: { won: "won", lost: "lost" },
    steps: [{ id: "in", name: "In", role: null, work: 0, wait: 0, rework: 0, next: [{ to: "won", p: 1 }] }],
    ...overrides,
  };
}

/** Measured-window arrival times of one replication, drawn as the engine draws them. */
function draw(model: EngineModel, seed = 1, warmupHours = 0): number[] {
  const H = model.horizonWeeks * model.hoursPerWeek;
  return arrivalTimes(model, H, warmupHours, mulberry32(seed), mulberry32(seed + 1));
}

/** Counts by calendar month (0 = January) of times in hours, for a model whose t = 0 is `startMonth`. */
function byCalendarMonth(times: number[], model: EngineModel): number[] {
  const monthHours = WEEKS_PER_CALENDAR_MONTH * model.hoursPerWeek;
  const counts = new Array<number>(12).fill(0);
  for (const t of times) {
    const j = Math.floor((model.demand?.startMonth ?? 0) + t / monthHours);
    counts[((j % 12) + 12) % 12]!++;
  }
  return counts;
}

/** Poisson count: within `z` standard deviations of `expected`. */
function expectPoisson(count: number, expected: number, z = 4) {
  expect(Math.abs(count - expected)).toBeLessThanOrEqual(z * Math.sqrt(expected));
}

describe("without demand settings nothing changes", () => {
  // The golden model's numbers, byte for byte, with no demand, flat demand,
  // or flat demand placed anywhere in the calendar.
  const flat: (EngineDemand | undefined)[] = [
    {},
    { seasonality: new Array(12).fill(1) },
    { seasonality: new Array(12).fill(1), growthMonthly: 0, startMonth: 8.5 },
  ];
  it.each(flat)("Northbeam with demand %j simulates exactly as without", (demand) => {
    const golden = JSON.stringify(simulate(northbeamModel(), 30, 1));
    expect(JSON.stringify(simulate({ ...northbeamModel(), demand }, 30, 1))).toBe(golden);
    const services = JSON.stringify(simulate(northbeamWithServices(), 10, 3));
    expect(JSON.stringify(simulate({ ...northbeamWithServices(), demand }, 10, 3))).toBe(services);
  });

  it("demandFactor is 1 everywhere", () => {
    expect(demandFactor(northbeamModel(), 0)).toBe(1);
    expect(demandFactor({ ...northbeamModel(), demand: { startMonth: 3 } }, 5000)).toBe(1);
  });
});

describe("arrival rate", () => {
  it("averages leadsPerWeek over a long horizon (constant rate)", () => {
    // 10 a week for 10,000 weeks: 100,000 expected, σ ≈ 316.
    expectPoisson(draw(stream(10, 10_000)).length, 100_000);
  });

  it("averages leadsPerWeek × the mean multiplier over whole years", () => {
    // 120 years of 52 weeks at 10 a week × mean(SEASONS) = 10 × 11.5/12.
    const model = stream(10, 52 * 120, { seasonality: SEASONS });
    expectPoisson(draw(model).length, 10 * 52 * 120 * (11.5 / 12));
  });
});

describe("seasonality changes arrival counts by simulated month", () => {
  // 200 years of 1-hour weeks at 12 a week: a calendar month (52/12 weeks)
  // expects 12 × 52/12 = 52 arrivals × its multiplier, 200 times over.
  const years = 200;
  const perMonth = 12 * WEEKS_PER_CALENDAR_MONTH * years;

  it("counts per calendar month follow the multipliers, starting in January", () => {
    const model = stream(12, 52 * years, { seasonality: SEASONS });
    const counts = byCalendarMonth(draw(model), model);
    counts.forEach((count, m) => {
      if (SEASONS[m] === 0) expect(count, JAN_TO_DEC[m]).toBe(0);
      else expectPoisson(count, perMonth * SEASONS[m]!);
    });
    // January (×2) sees about twice February's and four times July's.
    expect(counts[0]! / counts[1]!).toBeCloseTo(2, 1);
    expect(counts[0]! / counts[6]!).toBeCloseTo(4, 0);
  });

  it("follows the calendar from a start month partway through the year", () => {
    // t = 0 is mid-September, so the first half-month is September's and December has none.
    const model = stream(12, 52 * years, { seasonality: SEASONS, startMonth: 8.5 });
    const counts = byCalendarMonth(draw(model), model);
    expect(counts[11]).toBe(0);
    expectPoisson(counts[0]!, perMonth * 2);
    expectPoisson(counts[6]!, perMonth * 0.5);
  });

  it("demandFactor reads the calendar month a simulation hour falls in", () => {
    const model: EngineModel = { ...northbeamModel(), demand: { seasonality: SEASONS, startMonth: 11.5 } };
    const month = WEEKS_PER_CALENDAR_MONTH * model.hoursPerWeek;
    expect(demandFactor(model, 0)).toBe(0); // mid-December
    expect(demandFactor(model, month / 2)).toBe(2); // 1 January
    expect(demandFactor(model, month / 2 - 1e-9)).toBe(0);
    expect(demandFactor(model, month * 7)).toBe(0.5); // mid-July
    expect(demandFactor(model, -month)).toBe(1); // mid-November, in a warm-up
  });

  it("applies to the warm-up too, going back through the calendar", () => {
    // Starting 1 January: a year's warm-up covers the previous year, whose December has no demand.
    const model = stream(12, 52, { seasonality: SEASONS, startMonth: 0 });
    const W = 52 * years;
    const warm = arrivalTimes(model, 52, W, mulberry32(1), mulberry32(2)).filter((t) => t < 0);
    expect(warm.every((t) => t >= -W)).toBe(true);
    const counts = byCalendarMonth(warm, model);
    expect(counts[11]).toBe(0);
    expectPoisson(counts[0]!, perMonth * 2);
  });

  it("shows up in the simulation: more leads arrive in the busy season", () => {
    // Northbeam from 1 January for a year, with a ×2 January and an empty December, 20 reps.
    const model: EngineModel = {
      ...northbeamWithServices(),
      horizonWeeks: 52,
      warmupWeeks: 0,
      demand: { seasonality: SEASONS, startMonth: 0 },
    };
    const month = WEEKS_PER_CALENDAR_MONTH * model.hoursPerWeek;
    const counts = new Array<number>(12).fill(0);
    for (let rep = 0; rep < 20; rep++) {
      for (const e of runOnce(model, 1 + rep, true).entities!) if (e.t0 >= 0) counts[Math.floor(e.t0 / month)]!++;
    }
    // 7 a week × 52/12 weeks × 20 reps ≈ 607 in a normal month.
    const normal = 7 * WEEKS_PER_CALENDAR_MONTH * 20;
    expectPoisson(counts[0]!, normal * 2);
    expectPoisson(counts[1]!, normal);
    expectPoisson(counts[6]!, normal * 0.5);
    expect(counts[11]).toBe(0);
  });
});

describe("growth", () => {
  it("compounds by calendar month from the start month", () => {
    const model: EngineModel = { ...northbeamModel(), demand: { growthMonthly: 0.1, startMonth: 3.5 } };
    const month = WEEKS_PER_CALENDAR_MONTH * model.hoursPerWeek;
    expect(demandFactor(model, 0)).toBe(1); // the rest of April
    expect(demandFactor(model, month / 2)).toBeCloseTo(1.1, 12); // May
    expect(demandFactor(model, month * 2.5)).toBeCloseTo(1.1 ** 3, 12); // July
    expect(demandFactor(model, -month)).toBeCloseTo(1 / 1.1, 12); // March, in a warm-up
  });

  it("raises monthly counts by the growth rate, times seasonality", () => {
    // 5% a month for two years; month k expects 60 × 52/12 × 1.05^k × its season, 50 reps.
    const seasonality = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5];
    const model = stream(60, 104, { growthMonthly: 0.05, seasonality });
    const month = WEEKS_PER_CALENDAR_MONTH;
    const counts = new Array<number>(24).fill(0);
    for (let seed = 1; seed <= 50; seed++) for (const t of draw(model, seed * 2)) counts[Math.floor(t / month)]!++;
    counts.forEach((count, k) => expectPoisson(count, 50 * 60 * month * 1.05 ** k * seasonality[k % 12]!));
  });
});

describe("the services mix splits the calendar's arrivals", () => {
  it("each service gets its share of the seasonal rate", () => {
    const service = (mixShare: number): EngineService => ({
      name: "S",
      pricingModel: "retainer",
      price: 1,
      margin: 0,
      tenureMonths: 1,
      churnMonthly: 0,
      mixShare,
      pathTags: [],
    });
    const model = stream(8, 52 * 50, { seasonality: SEASONS }, { services: { a: service(3), b: service(1) } });
    const res = simulate(model, 1, 1);
    // 8 a week × 11.5/12 over 2,600 weeks = 19,933, split 3 : 1.
    const total = 8 * 52 * 50 * (11.5 / 12);
    expectPoisson(res.kpi.services.a!.arrivals.mean, total * 0.75);
    expectPoisson(res.kpi.services.b!.arrivals.mean, total * 0.25);
  });
});

describe("determinism and common random numbers", () => {
  it("gives identical results for the same seed", () => {
    const model: EngineModel = { ...northbeamModel(), demand: { seasonality: SEASONS, growthMonthly: 0.02, startMonth: 8.5 } };
    expect(simulate(model, 10, 5)).toEqual(simulate(model, 10, 5));
  });

  it("changing a later month's multiplier leaves earlier arrivals untouched", () => {
    const busyJune = [...SEASONS];
    busyJune[5] = 3;
    const a = draw(stream(12, 52 * 3, { seasonality: SEASONS }));
    const b = draw(stream(12, 52 * 3, { seasonality: busyJune }));
    const june = 5 * WEEKS_PER_CALENDAR_MONTH;
    expect(b.filter((t) => t < june)).toEqual(a.filter((t) => t < june));
    expect(b.length).toBeGreaterThan(a.length);
  });
});

describe("checks", () => {
  const run = (demand: EngineDemand) => () => simulate({ ...northbeamModel(), demand }, 1, 1);
  it("rejects malformed settings", () => {
    expect(run({ seasonality: [1, 1, 1] })).toThrow(/12 monthly multipliers/);
    expect(run({ seasonality: [...SEASONS.slice(0, 11), -1] })).toThrow(/0 or more/);
    expect(run({ seasonality: [...SEASONS.slice(0, 11), Number.NaN] })).toThrow(/0 or more/);
    expect(run({ growthMonthly: -1 })).toThrow(/more than -100%/);
    expect(run({ growthMonthly: 0.1, startMonth: Number.POSITIVE_INFINITY })).toThrow(/start month/);
  });
});

describe("performance", () => {
  it("keeps the 40-step, 25-person model within the PRD target with seasonality and growth", { tags: ["perf"] }, () => {
    const model: EngineModel = { ...largeModel(), demand: { seasonality: SEASONS.map((m) => m || 1), growthMonthly: 0.03, startMonth: 2.2 } };
    simulate(model, 3, 1);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      simulate(model, 30, 1);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(1500);
  });
});
