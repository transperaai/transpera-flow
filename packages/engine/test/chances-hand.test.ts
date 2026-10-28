import { describe, expect, it, vi } from "vitest";
import { initialState, runOnce, simulate, type EngineChannels, type EngineModel, type EngineService } from "../src";
import { Streams } from "../src/random";

// Churn drivers as chances, fee ranges, price rises and monthly channels (engine 1.12.0, sandbox phase 3) checked by hand, in the style of
// money-hand.test.ts: tiny deterministic models (one person, constant times), every expected number worked out from the inputs.

const HPW = 40;
const MONTH = (52 / 12) * HPW; // 173.33 hours: three months fill the 13-week runs below
const WEEKS_PER_MONTH = 4.33;

const svc = (pricingModel: EngineService["pricingModel"], price: number, extra: Partial<EngineService> = {}): EngineService => ({
  name: pricingModel,
  pricingModel,
  price,
  margin: 0,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  ...extra,
});

/** One person (Ann, 40 h a week at 50 an hour), no leads, no churn, no warm-up. */
function tiny(extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 13,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "R", count: 1, cost: 50, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["r"], capacity: HPW } },
    entry: "s",
    sinks: { won: "won", lost: "lost" },
    steps: [{ id: "s", name: "S", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] }],
    ...extra,
  };
}

/** A hundred unnamed clients of one retainer service, each churning at 0.0433 a month (0.01 a week), no servicing, no market, no leads. */
function group(extra: Partial<EngineModel> = {}): EngineModel {
  return tiny({
    horizonWeeks: 1,
    services: { ret: svc("retainer", 4330, { churnMonthly: 0.0433 }) },
    clientGroups: { ret: { count: 100, fee: 4330, churnMonthly: 0.0433, stayMonths: 12, health: 80 } },
    churnDrivers: [{ id: "results", weight: 1, enabled: true, value: 6 }],
    ...extra,
  });
}

const cause = (m: EngineModel, id: string, reps = 4) => simulate(m, reps, 1).churnCauses!.causes.find((c) => c.id === id)!;

describe("hand-checked: churn drivers as chances", () => {
  it("weight mode: a rating of 6 is pressure 0.5, so a weekly chance of 0.01 × 1.5 = 0.015 for 100 clients", () => {
    const r = simulate(group(), 4, 1).churnCauses!;
    // One weekly tick: expected clients lost = 100 × 0.015, of which 100 × 0.01 normal churn and 100 × 0.005 the rating.
    expect(r.clients).toBeCloseTo(1.5, 9);
    expect(r.normal.clients).toBeCloseTo(1, 9);
    const results = r.causes.find((c) => c.id === "results")!;
    expect(results.pressure).toBe(0.5);
    expect(results.clients).toBeCloseTo(0.5, 9);
    expect(results.mode).toBe("weight");
    expect(results.exposure).toBe(0);
    expect(results.effect).toBeNull();
  });

  it("chance 1 with effect 0.5 gives the weight mode's churn exactly (the same draws against the same weekly chance)", () => {
    const weight = group({ horizonWeeks: 13 });
    const chance = group({ horizonWeeks: 13, churnDrivers: [{ id: "results", weight: 1, enabled: true, value: 6, chance: 1, effect: 0.5, effectMonths: 1 }] });
    const a = simulate(weight, 6, 1);
    const b = simulate(chance, 6, 1);
    expect(b.kpi).toEqual(a.kpi);
    expect(b.samples).toEqual(a.samples);
    expect(b.churnCauses!.clients).toBeCloseTo(a.churnCauses!.clients, 6);
    const c = b.churnCauses!.causes.find((x) => x.id === "results")!;
    expect(c.mode).toBe("chance");
    expect(c.effect).toBe(0.5);
    expect(c.chance).toBe(1);
    expect(c.exposure).toBe(1);
  });

  it("an entered chance of 1 with effect 1 doubles the weekly chance while hit: 100 × 0.02 clients in the first week", () => {
    const m = group({ churnDrivers: [{ id: "results", weight: 1, enabled: true, value: 6, chance: 1, effect: 1, effectMonths: 1 }] });
    const r = simulate(m, 4, 1).churnCauses!;
    expect(r.clients).toBeCloseTo(2, 9);
    expect(r.normal.clients).toBeCloseTo(1, 9);
    const c = r.causes.find((x) => x.id === "results")!;
    expect(c.clients).toBeCloseTo(1, 9);
    expect(c.chance).toBe(1);
    expect(c.exposure).toBe(1);
    expect(c.pressure).toBe(1);
  });

  it("a chance of 0 draws nothing and gives the churn of the driver switched off", () => {
    const get = vi.spyOn(Streams.prototype, "get");
    const zero = simulate(group({ horizonWeeks: 13, churnDrivers: [{ id: "results", weight: 1, enabled: true, value: 6, chance: 0, effect: 1 }] }), 4, 1);
    const labels = get.mock.calls.map((c) => c[0]);
    get.mockRestore();
    expect(labels.some((l) => l.startsWith("hit:"))).toBe(false);
    const off = simulate(group({ horizonWeeks: 13, churnDrivers: [{ id: "results", weight: 1, enabled: false, value: 6 }] }), 4, 1);
    expect(zero.kpi).toEqual(off.kpi);
    expect(zero.churnCauses!.causes.find((c) => c.id === "results")!.exposure).toBe(0);
  });

  it("a chance between 0 and 1 draws once a tick for each client from its own stream, and a hit is at the weekly chance 1 - (1 - c)^(1/4.33)", () => {
    const get = vi.spyOn(Streams.prototype, "get");
    const m = group({ horizonWeeks: 13, churnDrivers: [{ id: "results", weight: 1, enabled: true, value: 6, chance: 0.5, effect: 0.5, effectMonths: 1 }] });
    const r = simulate(m, 4, 1);
    const labels = new Set(get.mock.calls.map((c) => c[0]));
    get.mockRestore();
    expect(labels.has("hit:results:group:ret:1")).toBe(true);
    expect(labels.has("hit:results:group:ret:100")).toBe(true);
    // The realised chance a month is about 0.5 (100 clients × 13 weeks × 4 replications of draws).
    const c = r.churnCauses!.causes.find((x) => x.id === "results")!;
    expect(c.chance!).toBeGreaterThan(0.45);
    expect(c.chance!).toBeLessThan(0.55);
    expect(c.exposure).toBeGreaterThan(0);
    expect(c.exposure).toBeLessThan(1);
  });

  it("a hit lasts its months after the last hit: hits only in month 1, a 2-month effect covers 12 of the 13 weekly ticks", () => {
    // Month 0 (4 ticks: weeks 1 to 4): chance 1; later months: chance 0. The last hit is at week 4 (t = 160); 2 months of 173.33 hours
    // later is t = 506.67, so the ticks at weeks 5 to 12 are still under the effect, and week 13 (t = 520) is not.
    const channels: EngineChannels = {
      starts: [MONTH, 2 * MONTH],
      drivers: { results: [{ chance: 1, effect: 1, months: 2 }, { chance: 0, effect: 1, months: 2 }, { chance: 0, effect: 1, months: 2 }] },
    };
    const m = group({ horizonWeeks: 13, churnMonthly: 0, services: { ret: svc("retainer", 4330) }, clientGroups: { ret: { count: 100, fee: 4330, churnMonthly: 0, stayMonths: 12, health: 80 } }, channels });
    const c = simulate(m, 2, 1).churnCauses!.causes.find((x) => x.id === "results")!;
    expect(c.mode).toBe("chance");
    expect(c.exposure).toBeCloseTo(12 / 13, 12);
  });

  it("a measured driver is hit by the event itself, draws nothing, and keeps exposure 1 while the event repeats (an overloaded team, every tick)", () => {
    // Ann carries one client's 35 hours a week of ongoing work: 87.5% busy, above the 85% line, at every tick.
    const m = tiny({
      horizonWeeks: 13,
      services: { ret: svc("retainer", 4330, { fallbackOngoing: { r: 35 * WEEKS_PER_MONTH } }) },
      clients: { c: { name: "Acme", services: ["ret"], mrr: 4330, assignments: { r: "ann" } } },
      churnDrivers: [{ id: "load", weight: 1, enabled: true, chance: null, effect: 1, effectMonths: 2 }],
    });
    const get = vi.spyOn(Streams.prototype, "get");
    const c = simulate(m, 2, 1).churnCauses!.causes.find((x) => x.id === "load")!;
    const labels = get.mock.calls.map((x) => x[0]);
    get.mockRestore();
    expect(labels.some((l) => l.startsWith("hit:"))).toBe(false);
    expect(c.mode).toBe("chance");
    expect(c.exposure).toBe(1);
    expect(c.chance).toBe(1);
  });

  it("measured chances are counted in weight mode too, so Settings can show them before anyone switches", () => {
    const m = tiny({
      horizonWeeks: 13,
      services: { ret: svc("retainer", 4330, { fallbackOngoing: { r: 35 * WEEKS_PER_MONTH } }) },
      clients: { c: { name: "Acme", services: ["ret"], mrr: 4330, assignments: { r: "ann" } } },
      churnDrivers: [{ id: "load", weight: 1, enabled: true }],
    });
    const c = simulate(m, 2, 1).churnCauses!.causes.find((x) => x.id === "load")!;
    expect(c.mode).toBe("weight");
    expect(c.chance).toBe(1);
    expect(c.exposure).toBe(0);
  });

  it("tenure and market have no chances: an effect on them is ignored", () => {
    const m = group({ horizonWeeks: 13, churnDrivers: [{ id: "tenure", weight: 1, enabled: true, value: 2, chance: 0.5, effect: 1 }, { id: "market", weight: 1, enabled: true, effect: 1 }] });
    const plain = group({ horizonWeeks: 13, churnDrivers: [{ id: "tenure", weight: 1, enabled: true, value: 2 }, { id: "market", weight: 1, enabled: true }] });
    expect(simulate(m, 3, 1).kpi).toEqual(simulate(plain, 3, 1).kpi);
    expect(cause(m, "tenure").mode).toBe("weight");
  });
});

describe("hand-checked: price rises", () => {
  // One named client, fee 4,330 a month = 1,000 a week, 13 weeks. Months are 52/12 weeks, so the third starts at week 8.667.
  const named = (extra: Partial<EngineModel> = {}) =>
    tiny({
      services: { ret: svc("retainer", 4330) },
      clients: { c: { name: "Acme", services: ["ret"], mrr: 4330, assignments: { r: "ann" } } },
      ...extra,
    });
  const rise: EngineChannels = { starts: [MONTH, 2 * MONTH], fee: { "*": [1, 1, 1.1] } };

  it("revenue is the fee, plus 10% from week 8.667: 1,000 × 8.667 + 1,100 × 4.333, of which 433.33 is the rise", () => {
    const r = runOnce({ ...named(), channels: rise }, 1, false);
    expect(r.revenue.recurring).toBeCloseTo(1000 * (26 / 3) + 1100 * (13 / 3), 6);
    expect(r.revenue.recurring).toBeCloseTo(13_433.333333, 4);
    expect(r.revenue.rise).toBeCloseTo(433.333333, 4);
    expect(r.billed).toBeCloseTo(13_433.333333, 4);
    const without = runOnce(named(), 1, false);
    expect(without.revenue.recurring).toBeCloseTo(13_000, 6);
    expect(without.revenue.rise).toBe(0);
  });

  it("month by month: the rise is in the third month only, and the monthly fee follows the factor", () => {
    const mo = simulate({ ...named(), channels: rise }, 2, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] }).monthly!;
    const wk = 52 / 12;
    expect(mo.revenue.total[0]!.mean).toBeCloseTo(1000 * wk, 6);
    expect(mo.revenue.total[1]!.mean).toBeCloseTo(1000 * wk, 6);
    expect(mo.revenue.total[2]!.mean).toBeCloseTo(1100 * wk, 6);
    expect(mo.revenue.rise.map((s) => s.mean)).toEqual([0, 0, expect.closeTo(100 * wk, 6)]);
    expect(mo.mrr[2]!.mean).toBeCloseTo(4330 * 1.1, 6);
  });

  it("with the price driver in weight mode the rise (10%) adds pressure 2 × 0.1 = 0.2 for the weeks after it only: 5 of the 13 ticks", () => {
    const m = named({ churnDrivers: [{ id: "price", weight: 1, enabled: true, value: 0 }], channels: rise });
    const c = simulate(m, 3, 1).churnCauses!.causes.find((x) => x.id === "price")!;
    // Ticks at weeks 9 to 13 (t = 360 … 520) fall after the rise at t = 346.67.
    expect(c.pressure).toBeCloseTo((5 * 0.2) / 13, 9);
    expect(c.mode).toBe("weight");
  });

  it("with the price driver as a chance of 1 and effect 1.5 the rise hits the client: 15% more churn per 10% of rise, for the months", () => {
    const m = named({ churnDrivers: [{ id: "price", weight: 1, enabled: true, value: 0, effect: 1.5, effectMonths: 3 }], channels: rise });
    const c = simulate(m, 3, 1).churnCauses!.causes.find((x) => x.id === "price")!;
    expect(c.mode).toBe("chance");
    // Under the hit from the first tick after the rise (week 9 to 13): 5 ticks of 13; the pressure is r / 0.1 = 1 while hit.
    expect(c.exposure).toBeCloseTo(5 / 13, 9);
    expect(c.pressure).toBeCloseTo(5 / 13, 6);
  });

  it("a cut in fees has no churn effect", () => {
    const m = named({ churnDrivers: [{ id: "price", weight: 1, enabled: true, value: 0 }], channels: { starts: [MONTH, 2 * MONTH], fee: { "*": [1, 1, 0.9] } } });
    const r = runOnce(m, 1, false);
    expect(r.revenue.recurring).toBeCloseTo(1000 * (26 / 3) + 900 * (13 / 3), 6);
    expect(r.revenue.rise).toBeCloseTo(-100 * (13 / 3), 6);
    expect(simulate(m, 3, 1).churnCauses!.causes.find((x) => x.id === "price")!.pressure).toBe(0);
  });

  it("a one-off job is priced at the month's factor, and the rise on it is booked as the rise", () => {
    // 5 jobs in progress (1 h each, Ann alone): won at t = 1 … 5, all in month 0, so a factor from month 1 does nothing; from month 0 it does.
    const m = tiny({ services: { job: svc("one_off", 2500) }, channels: { starts: [], fee: { "*": [1.2] } } });
    m.steps = [{ ...m.steps[0]!, currentWip: 5 }];
    const r = runOnce(m, 1, false);
    expect(r.revenue.oneOff).toBeCloseTo(5 * 3000, 6);
    expect(r.revenue.rise).toBeCloseTo(5 * 500, 6);
  });
});

describe("hand-checked: fee ranges", () => {
  const jobs = (extra: Partial<EngineService> = {}) => {
    const m = tiny({ services: { job: svc("one_off", 2000, extra) } });
    m.steps = [{ ...m.steps[0]!, currentWip: 100 }];
    return m;
  };

  it("a one-off with a fee range of 1,000 to 6,000 around 2,000 is paid 3,000 on average (the triangular's mean)", () => {
    const res = simulate(jobs({ priceRange: { low: 1000, high: 6000 } }), 30, 1);
    expect(res.kpi.won.mean).toBe(100);
    // 3,000 wins in all: the mean fee is within 1% of (1,000 + 2,000 + 6,000) / 3.
    expect(res.kpi.billed.mean / 100).toBeGreaterThan(3000 * 0.99);
    expect(res.kpi.billed.mean / 100).toBeLessThan(3000 * 1.01);
    // The price ends are respected.
    expect(res.kpi.billed.p10 / 100).toBeGreaterThan(1000);
    expect(res.kpi.billed.p90 / 100).toBeLessThan(6000);
    // And the expected value of a lost client is the range's mean.
    expect(res.kpi.revenue.mean).toBeCloseTo(res.kpi.billed.mean, 6);
  });

  it("the fee is drawn from the service's own stream, one draw per win, and never when the range has nothing to draw", () => {
    const get = vi.spyOn(Streams.prototype, "get");
    simulate(jobs({ priceRange: { low: 1000, high: 6000 } }), 2, 1);
    expect(get.mock.calls.some((c) => c[0] === "fee:job")).toBe(true);
    get.mockClear();
    const flat = simulate(jobs({ priceRange: { low: 2000, high: 2000 } }), 3, 1);
    expect(get.mock.calls.some((c) => String(c[0]).startsWith("fee:"))).toBe(false);
    get.mockRestore();
    expect(flat).toEqual(simulate(jobs(), 3, 1));
  });

  it("the engine uses min(low, price) and max(high, price): a range that doesn't hold the price is widened to it", () => {
    const res = simulate(jobs({ priceRange: { low: 3000, high: 4000 } }), 30, 1);
    // Triangular(2,000, 2,000, 4,000): mean 2,666.7.
    expect(res.kpi.billed.mean / 100).toBeGreaterThan(2000);
    expect(res.kpi.billed.mean / 100).toBeLessThan(2667 * 1.02);
  });

  it("a retainer won with a range bills the drawn fee for life, and a client already there keeps its entered fee", () => {
    // Five clients won at t = 1 … 5, each paying a drawn fee from 4,330 to 8,660 around 4,330 (mean 5,773.3) for the rest of the 13 weeks.
    const m = tiny({
      services: { ret: svc("retainer", 4330, { priceRange: { low: 4330, high: 8660 } }) },
      clients: { c: { name: "Acme", services: ["ret"], mrr: 4330, assignments: { r: "ann" } } },
    });
    m.steps = [{ ...m.steps[0]!, currentWip: 5 }];
    const res = simulate(m, 30, 1);
    const fromNew = res.kpi.revenue.mean - 13_000;
    // 5 clients × ~13 weeks × (mean fee 5,773 ÷ 4.33 a week) ≈ 5 × 12.99 × 1,333.3.
    expect(fromNew).toBeGreaterThan(80_000);
    expect(fromNew).toBeLessThan(92_000);
    expect(res.kpi.revenue.mean).toBeGreaterThan(13_000 + 5 * 12.99 * 1000);
  });
});

describe("hand-checked: monthly channels", () => {
  const WIP = 300;
  const chain = (extra: Partial<EngineModel> = {}) => {
    const m = tiny(extra);
    m.steps = [{ ...m.steps[0]!, currentWip: WIP, waitDist: { kind: "constant" } }];
    return m;
  };

  it("work x0.5 from month 0 equals the patch that halves the step's hours, exactly", () => {
    // (Arrivals rather than work in progress: a starting queue's ages are drawn over the step's work time, which the patch changes.)
    const m = tiny({ leadsPerWeek: 20, steps: [{ ...tiny().steps[0]!, work: 2, wait: 3, waitDist: { kind: "constant" } }] });
    const channel = simulate({ ...m, channels: { starts: [], work: { s: [0.5] } } }, 4, 1);
    const patched = { ...m, steps: m.steps.map((s) => ({ ...s, work: 1 })) };
    const direct = simulate(patched, 4, 1);
    expect(channel.kpi).toEqual(direct.kpi);
    expect(channel.steps).toEqual(direct.steps);
    expect(channel.people).toEqual(direct.people);
  });

  it("work x0.5 from month 1 halves only the visits started after it", () => {
    // 1-hour visits back to back from t = 0: those starting before 173.33 take 1 h, the rest 0.5 h.
    const res = simulate({ ...chain(), channels: { starts: [MONTH], work: { s: [1, 0.5] } } }, 2, 1);
    const before = Math.ceil(MONTH); // visits start at t = 0, 1, …, 173 (174 of them) at the full hour
    // The first 174 take 174 h; the rest 0.5 h each: 300 items finish at 174 + 0.5 × 126 = 237 h, inside the 520-hour run.
    expect(before).toBe(174);
    expect(res.kpi.won.mean).toBe(WIP);
    expect(res.steps.s!.avgHandsOn).toBeCloseTo((174 * 1 + 126 * 0.5) / 300, 9);
  });

  it("wait 0 → 8 h from month 1 adds 8-hour waits only to visits that end after month 1 starts", () => {
    const res = simulate({ ...chain(), channels: { starts: [MONTH], wait: { s: [0, 8] } } }, 2, 1);
    // Visits end at t = 1, 2, …, 300; those at 174 or later (127 of them) end after t = 173.33 and wait 8 h.
    expect(res.steps.s!.fixedWaitVisits).toBe(WIP);
    expect(res.steps.s!.avgFixedWait).toBeCloseTo((127 * 8) / 300, 9);
  });

  it("rework 0 → 0.5 from month 1 creates the redo loop, and only items finishing a visit after month 1 are sent back", () => {
    const res = simulate({ ...chain(), channels: { starts: [MONTH], rework: { s: [0, 0.5] } } }, 2, 1);
    expect(res.loops!.map((l) => l.id)).toEqual(["redo:s"]);
    expect(res.steps.s!.reworks).toBeGreaterThan(0);
    const sentBack = res.trace!.filter((e) => e.trace.length > 1);
    expect(sentBack.length).toBeGreaterThan(0);
    // No item's first visit ended (and was sent back) before month 1.
    for (const e of sentBack) expect(e.trace[0]!.tL!).toBeGreaterThanOrEqual(MONTH);
  });

  it("role cost x2 from month 2 doubles that month's labour and no other", () => {
    const res = simulate({ ...chain(), channels: { starts: [MONTH, 2 * MONTH], roleCost: { r: [1, 1, 2] } } }, 2, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] });
    const wk = 52 / 12;
    expect(res.monthly!.money!.labour[0]).toBeCloseTo(2000 * wk, 6);
    expect(res.monthly!.money!.labour[1]).toBeCloseTo(2000 * wk, 6);
    expect(res.monthly!.money!.labour[2]).toBeCloseTo(4000 * wk, 6);
    expect(res.kpi.labourCost!.mean).toBeCloseTo(2000 * 2 * wk + 4000 * wk, 6);
  });

  it("capacity x0.5 from month 2 halves paid hours and the monthly capacity from then", () => {
    const res = simulate({ ...chain(), channels: { starts: [MONTH, 2 * MONTH], capacity: { ann: [1, 1, 0.5] } } }, 2, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] });
    const wk = 52 / 12;
    expect(res.monthly!.money!.labour[1]).toBeCloseTo(2000 * wk, 6);
    expect(res.monthly!.money!.labour[2]).toBeCloseTo(1000 * wk, 6);
    expect(res.kpi.labourCost!.mean).toBeCloseTo(2000 * 2 * wk + 1000 * wk, 6);
    expect(res.monthly!.people.ann![1]!.capacity).toBeCloseTo(40, 9);
    expect(res.monthly!.people.ann![2]!.capacity).toBeCloseTo(20, 9);
    // The run's own hours follow: half the hands-on time can be done a week.
    expect(res.monthly!.people.ann![2]!.work).toBeLessThan(res.monthly!.people.ann![1]!.work);
  });

  it("overheads x2 from month 2 doubles that month's fixed costs", () => {
    const res = simulate({ ...chain({ overheadMonthly: 1000 }), channels: { starts: [MONTH, 2 * MONTH], overheads: [1, 1, 2] } }, 2, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] });
    expect(res.monthly!.money!.overheads[0]).toBeCloseTo(1000, 6);
    expect(res.monthly!.money!.overheads[1]).toBeCloseTo(1000, 6);
    expect(res.monthly!.money!.overheads[2]).toBeCloseTo(2000, 6);
    expect(res.kpi.overheads).toBeCloseTo(4000, 6);
  });

  it("leads x2 from month 1 doubles the rate of opportunities after it: about twice as many in the later months", () => {
    const m = tiny({ leadsPerWeek: 20, steps: [{ ...tiny().steps[0]!, work: 0.01 }] });
    const res = simulate({ ...m, channels: { starts: [MONTH, 2 * MONTH], leads: [1, 2, 2] } }, 30, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] });
    const [a, b, c] = res.monthly!.sales.opportunities.map((s) => s.mean);
    expect(b! / a!).toBeGreaterThan(1.7);
    expect(b! / a!).toBeLessThan(2.3);
    expect(c! / a!).toBeGreaterThan(1.7);
  });

  it("neutral channels change nothing: a model whose channels are all neutral runs as one without them", () => {
    const neutral: EngineChannels = {
      starts: [MONTH, 2 * MONTH],
      leads: [1, 1, 1],
      conv: [1],
      newFee: { "*": [1, 1] },
      fee: { "*": [1, 1, 1] },
      churn: { "*": [1] },
      work: { s: [1, 1, 1] },
      wait: { s: [0, 0, 0] },
      rework: { s: [0] },
      roleCost: { r: [1, 1, 1] },
      overheads: [1, 1],
      capacity: { ann: [1, 1, 1] },
      priceRange: { job: [null, null] },
      drivers: { late: [null] },
    };
    const m = { ...chain({ services: { job: svc("one_off", 100) } }), channels: neutral };
    expect(initialState(m)).toEqual(initialState(chain({ services: { job: svc("one_off", 100) } })));
    expect(simulate(m, 3, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] })).toEqual(simulate({ ...m, channels: undefined }, 3, 1, { monthly: true, monthStarts: [MONTH, 2 * MONTH] }));
  });
});
