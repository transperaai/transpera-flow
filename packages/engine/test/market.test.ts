import { describe, expect, it } from "vitest";
import {
  MARKET_PRESETS,
  STABLE_MARKET,
  checkMarket,
  factorsFromPercents,
  marketAt,
  marketFromSchedule,
  larkspurModel,
  northbeamModel,
  northbeamWithServicing,
  percentsFromFactors,
  simulate,
  withMarketCondition,
  withMarketSchedule,
  type EngineModel,
  type MarketFactors,
} from "../src";

// Market conditions (decision D29, ticket A57): seven factors per month,
// applied by the engine month by month. Stable everywhere changes nothing.

const f = (over: Partial<MarketFactors>): MarketFactors => ({ ...STABLE_MARKET, ...over });

/** One step, one hour a week, a coin-flip between won and lost, and a retainer of 1000 a month. */
function funnel(overrides: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 52,
    hoursPerWeek: 40,
    leadsPerWeek: 10,
    activeClients: 20,
    churnMonthly: 0.05,
    retainer: 1000,
    roles: {},
    warmupWeeks: 0,
    entry: "in",
    sinks: { won: "won", lost: "lost" },
    steps: [
      {
        id: "in",
        name: "In",
        role: null,
        work: 0,
        wait: 8,
        rework: 0,
        next: [
          { to: "won", p: 0.4 },
          { to: "lost", p: 0.6 },
        ],
      },
    ],
    ...overrides,
  };
}

const run = (m: EngineModel) => simulate(m, 10, 3);

describe("market conditions", () => {
  it("Stable everywhere, or no market, simulates exactly as before", () => {
    const base = northbeamWithServicing();
    const a = simulate(base, 4, 1);
    const stable = simulate(withMarketCondition(base, STABLE_MARKET), 4, 1);
    const sched = simulate(withMarketSchedule(base, marketFromSchedule([], () => STABLE_MARKET)), 4, 1);
    expect(JSON.stringify({ ...stable, engineVersion: 0 })).toBe(JSON.stringify({ ...a, engineVersion: 0 }));
    expect(JSON.stringify({ ...sched, engineVersion: 0 })).toBe(JSON.stringify({ ...a, engineVersion: 0 }));
  });

  it("the presets match the prototype and round-trip through whole percents", () => {
    expect(percentsFromFactors(MARKET_PRESETS.downturn.factors)).toEqual({
      leads: 65,
      conv: 75,
      cycle: 140,
      price: 88,
      churn: 135,
      hire: 80,
      pay: 135,
    });
    expect(factorsFromPercents(percentsFromFactors(MARKET_PRESETS.boom.factors))).toEqual(MARKET_PRESETS.boom.factors);
  });

  it("enquiries scale the arrival rate", () => {
    const base = run(funnel());
    const boom = run(withMarketCondition(funnel(), f({ leads: 1.5 })));
    const down = run(withMarketCondition(funnel(), f({ leads: 0.5 })));
    expect(boom.won / base.won).toBeGreaterThan(1.3);
    expect(down.won / base.won).toBeLessThan(0.7);
  });

  it("applies each month's factors as the run goes", () => {
    // Enquiries stop after month 6: nothing arrives in the last half year.
    const months = Array.from({ length: 24 }, (_, i) => f({ leads: i < 6 ? 1 : 0 }));
    const model = funnel({ horizonWeeks: 52 });
    const cut = run(withMarketSchedule(model, { months }));
    const half = run(withMarketCondition(model, f({ leads: 1 })));
    expect(cut.won).toBeLessThan(half.won * 0.6);
    expect(cut.won).toBeGreaterThan(half.won * 0.35);
    expect(marketAt(withMarketSchedule(model, { months }), 40 * 4.33 * 7).leads).toBe(0);
    expect(marketAt(withMarketSchedule(model, { months }), 40).leads).toBe(1);
  });

  it("enquiries that sign scale the won share without moving the rest", () => {
    const base = run(funnel());
    const soft = run(withMarketCondition(funnel(), f({ conv: 0.5 })));
    expect(soft.won / base.won).toBeGreaterThan(0.4);
    expect(soft.won / base.won).toBeLessThan(0.6);
    expect(soft.lost).toBeGreaterThan(base.lost);
  });

  it.each([
    ["northbeamModel", northbeamModel],
    ["northbeamWithServicing", northbeamWithServicing],
    ["larkspurModel", larkspurModel],
  ])("enquiries that sign lower wins on %s, where the sale is several steps from the end", (_name, build) => {
    const base = simulate(build(), 12, 2);
    const soft = simulate(withMarketCondition(build(), f({ conv: 0.5 })), 12, 2);
    const boom = simulate(withMarketCondition(build(), f({ conv: 1.5 })), 12, 2);
    expect(soft.won).toBeLessThan(base.won * 0.8);
    expect(boom.won).toBeGreaterThan(base.won);
  });

  it("enquiries that sign leave Northbeam's SEO to PPC split alone", () => {
    const base = simulate(northbeamModel(), 12, 2);
    const soft = simulate(withMarketCondition(northbeamModel(), f({ conv: 0.5 })), 12, 2);
    const ratio = (r: typeof base) => r.steps.seo!.arrivals / r.steps.ppc!.arrivals;
    expect(ratio(soft)).toBeGreaterThan(ratio(base) * 0.85);
    expect(ratio(soft)).toBeLessThan(ratio(base) * 1.15);
  });

  it("enquiries that sign still apply when the deciding step also has an open follow-up loop", () => {
    // decide: won 30%, lost 30%, back to "talk" 40%; talk -> decide or lost, so the loop can still end either way.
    const m = funnel({
      leadsPerWeek: 20,
      steps: [
        { id: "decide", name: "D", role: null, work: 0, wait: 0, rework: 0, next: [{ to: "won", p: 0.3 }, { to: "lost", p: 0.3 }, { to: "talk", p: 0.4 }] },
        { id: "talk", name: "T", role: null, work: 0, wait: 1, rework: 0, next: [{ to: "decide", p: 0.5 }, { to: "lost", p: 0.5 }] },
      ],
      entry: "decide",
    });
    const base = simulate(m, 20, 5).won;
    const soft = simulate(withMarketCondition(m, f({ conv: 0.5 })), 20, 5).won;
    expect(soft).toBeLessThan(base * 0.85);
  });

  it("applies conv once per path: only at the step that decides the sale", () => {
    // qualify -> (decide 50% | lost 50%); decide -> (onboard 40% | lost 60%); onboard -> won. conv 0.5 halves the 40%, not the 50%.
    const m = funnel({
      steps: [
        { id: "q", name: "Q", role: null, work: 0, wait: 0, rework: 0, next: [{ to: "d", p: 0.5 }, { to: "lost", p: 0.5 }] },
        { id: "d", name: "D", role: null, work: 0, wait: 0, rework: 0, next: [{ to: "o", p: 0.4 }, { to: "lost", p: 0.6 }] },
        { id: "o", name: "O", role: null, work: 0, wait: 0, rework: 0, next: [{ to: "won", p: 1 }] },
      ],
      entry: "q",
      leadsPerWeek: 20,
    });
    const base = simulate(m, 30, 4).won;
    const half = simulate(withMarketCondition(m, f({ conv: 0.5 })), 30, 4).won;
    expect(half / base).toBeGreaterThan(0.4);
    expect(half / base).toBeLessThan(0.6);
  });

  it("time to decide only stretches waits before the sale, not onboarding", () => {
    const m = funnel({
      steps: [
        { id: "d", name: "D", role: null, work: 0, wait: 8, rework: 0, next: [{ to: "o", p: 1 }] },
        { id: "o", name: "O", role: null, work: 0, wait: 100, rework: 0, next: [{ to: "won", p: 0.5 }, { to: "lost", p: 0.5 }] },
      ],
      entry: "d",
    });
    // Both steps can still reach a lost end here, so both stretch; make onboarding unloseable and it must not.
    const safe = funnel({
      steps: [
        { id: "d", name: "D", role: null, work: 0, wait: 8, rework: 0, next: [{ to: "o", p: 0.5 }, { to: "lost", p: 0.5 }] },
        { id: "o", name: "O", role: null, work: 0, wait: 100, rework: 0, next: [{ to: "won", p: 1 }] },
      ],
      entry: "d",
    });
    const slow = (x: EngineModel) => simulate(withMarketCondition(x, f({ cycle: 2 })), 10, 3).kpi.cycle.mean - simulate(x, 10, 3).kpi.cycle.mean;
    // Only the 8 h decision wait doubles (about +8 h), not the 100 h onboarding wait (+100 h).
    expect(slow(safe)).toBeGreaterThan(5);
    expect(slow(safe)).toBeLessThan(12);
    expect(slow(m)).toBeGreaterThan(50);
  });

  it("prices scale new MRR", () => {
    const base = run(funnel());
    const cheap = run(withMarketCondition(funnel(), f({ price: 0.8 })));
    expect(cheap.won).toBe(base.won);
    expect(cheap.mrrAdded).toBeCloseTo(base.mrrAdded * 0.8, 6);
  });

  it("time to decide stretches external waits", () => {
    const base = run(funnel());
    const slow = run(withMarketCondition(funnel(), f({ cycle: 2 })));
    expect(slow.kpi.cycle.mean).toBeGreaterThan(base.kpi.cycle.mean);
  });

  it("clients leaving scales churn", () => {
    const model = funnel();
    const base = run(model);
    const lots = run(withMarketCondition(model, f({ churn: 3 })));
    expect(lots.kpi.billed.mean).toBeLessThan(base.kpi.billed.mean);
  });

  it("rejects factors out of range", () => {
    expect(() => checkMarket({ months: [f({ leads: -1 })] })).toThrow();
    expect(() => checkMarket({ months: [] })).toThrow();
    expect(() => simulate(withMarketCondition(funnel(), f({ conv: Number.NaN })), 1, 1)).toThrow();
  });

  it("expands a schedule into 24 months, Stable where nothing is set", () => {
    const m = marketFromSchedule(
      [
        { from: 7, to: 14, condition: "soft" },
        { from: 15, to: 24, condition: "mine" },
      ],
      (id) => (id === "soft" ? MARKET_PRESETS.soft.factors : id === "mine" ? f({ leads: 0.9 }) : undefined),
    );
    expect(m.months).toHaveLength(24);
    expect(m.months[0]).toEqual(STABLE_MARKET);
    expect(m.months[6]).toEqual(MARKET_PRESETS.soft.factors);
    expect(m.months[23]!.leads).toBe(0.9);
  });
});

describe("the conv channel beside the market (sandbox phase 3)", () => {
  it("multiplies the market's conv: 0.8 in the market and 0.5 in the channel is 0.4 in the market", () => {
    const viaChannel = simulate({ ...withMarketCondition(funnel(), f({ conv: 0.8 })), channels: { starts: [], conv: [0.5] } }, 10, 3);
    const viaMarket = simulate(withMarketCondition(funnel(), f({ conv: 0.4 })), 10, 3);
    expect(viaChannel.won).toBe(viaMarket.won);
    expect(viaChannel.lost).toBe(viaMarket.lost);
    expect(viaChannel.kpi).toEqual(viaMarket.kpi);
  });

  it("works without a market", () => {
    const base = run(funnel());
    const halved = simulate({ ...funnel(), channels: { starts: [], conv: [0.5] } }, 10, 3);
    expect(halved.won).toBeLessThan(base.won * 0.7);
    expect(halved.won).toBeGreaterThan(base.won * 0.3);
  });
});
