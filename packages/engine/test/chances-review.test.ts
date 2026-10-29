import { describe, expect, it } from "vitest";
import {
  equivalentEvents,
  northbeamWithClients,
  priceEffectOfWeight,
  projectChurn,
  simulate,
  type EngineChurnDriver,
  type EngineModel,
  type EngineService,
} from "../src";

// Findings of the sandbox phase 3 review (engine 1.13.0), each checked by hand on a tiny model: hits during the warm-up, the price
// driver's chance-and-effect equivalent, a churn channel on merged clients, and the overtime limit rounding as it did before channels.

const HPW = 40;
const MONTH = (52 / 12) * HPW;
const WEEKS_PER_MONTH = 4.33;

const svc = (extra: Partial<EngineService> = {}): EngineService => ({
  name: "Retainer",
  pricingModel: "retainer",
  price: 4330,
  margin: 0,
  tenureMonths: 12,
  churnMonthly: 0.0433,
  mixShare: 1,
  pathTags: [],
  ...extra,
});

/** `count` unnamed clients of one retainer (0.01 a week of base churn), no servicing, no leads, one person; a warm-up of `warmupWeeks`. */
function group(count: number, drivers: EngineChurnDriver[], extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 1,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 26,
    roles: { r: { name: "R", count: 1, cost: 50, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["r"], capacity: HPW } },
    entry: "s",
    sinks: { won: "won", lost: "lost" },
    steps: [{ id: "s", name: "S", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] }],
    services: { ret: svc() },
    clientGroups: { ret: { count, fee: 4330, churnMonthly: 0.0433, stayMonths: 12, health: 100 } },
    churnDrivers: [{ id: "late", weight: 1, enabled: false }, ...drivers],
    ...extra,
  };
}

const cause = (m: EngineModel, id: string, reps = 4) => simulate(m, reps, 1).churnCauses!.causes.find((c) => c.id === id)!;

describe("review: hits during the warm-up carry into the window (brief Q11)", () => {
  // An entered chance of 50% a month, a hit lasting 3 months (13 weeks). The weekly chance of a hit is q = 1 - 0.5^(1/4.33) = 0.1479. At any tick
  // of a long run a client is under a hit when one of the last 13 ticks hit it (a hit 13 weeks ago has just ended): 1 - (1 - q)^13 = 0.878. With
  // the warm-up's hits that holds at the first tick too; without a warm-up only the tick itself can hit: q.
  const drivers = (): EngineChurnDriver[] => [{ id: "results", weight: 1, enabled: true, value: 5, chance: 0.5, effect: 1, effectMonths: 3 }];
  const q = 1 - Math.pow(0.5, 1 / WEEKS_PER_MONTH);

  it("a client on the book from the start is as likely to be under a hit at the first tick as later on: 1 - (1 - q)^13 = 0.878", () => {
    const c = cause(group(4000, drivers()), "results", 2);
    expect(Math.abs(c.exposure - (1 - Math.pow(1 - q, 13)))).toBeLessThan(0.01);
  });

  it("without a warm-up there is nothing to carry: only the first tick's own draw, q = 0.148", () => {
    const c = cause(group(4000, drivers(), { warmupWeeks: 0 }), "results", 2);
    expect(Math.abs(c.exposure - q)).toBeLessThan(0.01);
  });

  it("the warm-up's hits are not hits of the run: the measured chance a month is still the entered 50%", () => {
    const c = cause(group(2000, drivers(), { horizonWeeks: 26 }), "results", 2);
    expect(c.chance!).toBeGreaterThan(0.47);
    expect(c.chance!).toBeLessThan(0.53);
  });

  it("a warm-up shorter than a hit only carries the weeks it has: 4 weeks of warm-up, 1 - (1 - q)^5 at the first tick (the 4 warm-up ticks and the tick)", () => {
    const c = cause(group(4000, drivers(), { warmupWeeks: 4 }), "results", 2);
    expect(Math.abs(c.exposure - (1 - Math.pow(1 - q, 5)))).toBeLessThan(0.01);
  });

  it("a driver a channel switches to a chance from a month starts that month fresh (no warm-up hits): the months before stay the run without it", () => {
    const starts = [MONTH, 2 * MONTH];
    const base = group(2000, [{ id: "results", weight: 1, enabled: true, value: 5 }], { horizonWeeks: 13 });
    const withCh = { ...base, channels: { starts, drivers: { results: [null, { chance: 0.5, effect: 1, months: 3 }] } } };
    const c = cause(withCh, "results", 2);
    // Hits only from month 1 (8.67 weeks of the 13): exposure well under the stationary 0.878.
    expect(c.exposure).toBeLessThan(0.6);
    expect(c.exposure).toBeGreaterThan(0.3);
  });
});

describe("review: the price driver's chance and effect that match its weight", () => {
  // Weight mode: a rise r adds 2 × r × weight for 13 weeks. As events: effect × r / 0.1 for `months`. Equal when effect = weight × 2 × 0.1 ×
  // 13 / (months × 52/12): 0.2 × weight for 3 months, 0.1 × weight for 6.
  it("is 0.2 per 10% rise at weight 1 for 3 months, half that for 6, capped at 5", () => {
    expect(priceEffectOfWeight(1, 3)).toBeCloseTo(0.2, 12);
    expect(priceEffectOfWeight(0.5, 3)).toBeCloseTo(0.1, 12);
    expect(priceEffectOfWeight(1, 6)).toBeCloseTo(0.1, 12);
    expect(priceEffectOfWeight(100, 1)).toBe(5);
    const eq = equivalentEvents({ id: "price", custom: false, pressure: 0.05, chance: null, value: 10 }, 0.5);
    expect(eq).toEqual({ chance: 1, effect: priceEffectOfWeight(0.5), months: 3 });
  });

  it("gives exactly the weight's churn on a planned rise (a hit of every client at the rise, for the 13 weeks the weight acts)", () => {
    const priced = (extra: Partial<EngineChurnDriver>) => group(2000, [{ id: "price", weight: 0.5, enabled: true, value: 10, month: 2, ...extra }], { horizonWeeks: 52 });
    const weight = simulate(priced({}), 6, 1);
    const eq = equivalentEvents(weight.churnCauses!.causes.find((c) => c.id === "price")!, 0.5);
    const chance = simulate(priced({ chance: eq.chance, effect: eq.effect, effectMonths: eq.months }), 6, 1);
    expect(chance.churnCauses!.clients).toBeCloseTo(weight.churnCauses!.clients, 6);
    expect(chance.kpi.clientsChurned).toEqual(weight.kpi.clientsChurned);
  });

  it("the projection reads the switch as the same churn, and doubling the effect as double the price's part", () => {
    const run = simulate(group(500, [{ id: "price", weight: 0.5, enabled: true, value: 10, month: 2 }], { horizonWeeks: 52 }), 4, 1).churnCauses!;
    const c = run.causes.find((x) => x.id === "price")!;
    const byWeight = projectChurn(run, [{ id: "price", weight: 0.5, enabled: true }]);
    const eq = equivalentEvents(c, 0.5);
    const asEvents = projectChurn(run, [{ id: "price", weight: 0.5, enabled: true, effect: eq.effect, chance: eq.chance, months: eq.months }]);
    expect(asEvents.clientsPerMonth).toBeCloseTo(byWeight.clientsPerMonth, 9);
    const none = projectChurn(run, [{ id: "price", weight: 0.5, enabled: false }]);
    const doubled = projectChurn(run, [{ id: "price", weight: 0.5, enabled: true, effect: 2 * eq.effect, chance: 1, months: 3 }]);
    expect(doubled.clientsPerMonth - none.clientsPerMonth).toBeCloseTo(2 * (byWeight.clientsPerMonth - none.clientsPerMonth), 9);
  });

  it("a measured cause that measured no hits pre-fills no effect (a chance of 0 can't carry the weight's churn)", () => {
    const eq = equivalentEvents({ id: "late", custom: false, pressure: 0.4, chance: 0, value: null }, 1);
    expect(eq).toEqual({ chance: null, effect: 0, months: 3 });
  });
});

describe("review: a churn channel on clients worked out together", () => {
  it("every client of a group without servicing reports the channel's churn, not only the first of each run of alike clients", () => {
    const base = group(40, [], { horizonWeeks: 13 });
    const doubled = { ...base, clientGroups: { ret: { ...base.clientGroups!.ret!, churnMonthly: 0.0866 } } };
    const channel = { ...base, channels: { starts: [MONTH, 2 * MONTH], churn: { "*": [2] } } };
    const a = simulate(doubled, 3, 1).clients!;
    const b = simulate(channel, 3, 1).clients!;
    for (const id of Object.keys(a)) expect(b[id]!.churnMonthly.mean).toBeCloseTo(a[id]!.churnMonthly.mean, 12);
  });
});

describe("review: the overtime limit rounds as it did before channels", () => {
  it("northbeam's named roster at seed 7: overtime hours P90 is engine 1.11.0's to the last bit", () => {
    // 1.12.0 multiplied the limit as cap × (capacity × weeks) for everyone; 1.11.0 (and every run without a capacity channel since this fix) as
    // cap × capacity × weeks, which rounds differently: 39.64915296714574 against 1.11.0's 39.64915296714573.
    const r = simulate(northbeamWithClients(), 12, 7);
    expect(r.kpi.overtimeHours.p90).toBe(39.64915296714573);
  });
});
