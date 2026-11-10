// Market conditions (docs/PRD.md decision D29): the outside climate for demand,
// as seven factors that scale today's numbers (1 = same as today). A model
// carries a 24-month schedule of them (`EngineModel.market`) and the engine
// applies each month's factors as the run goes. Stable in every month changes
// nothing: such a model is simulated exactly as one with no market at all.
//
// What each factor does in the engine:
//   leads   arrival rate (demand.ts), month by month.
//   conv    the share of enquiries that reach a `won` end: at a step, the
//           probability of the edges that lead to a won end is scaled and the
//           other edges share the rest in proportion.
//   cycle   external wait ("time to decide") at pipeline steps.
//   price   the fee of each retainer or one-off won in that month, for its life
//           (new MRR, billed, LTV added).
//   churn   monthly churn of every active client.
//   hire, pay  stored and exposed, but the engine has no hiring or cash-flow
//           model yet, so they change no simulated number.

import { WEEKS_PER_MONTH, type EngineModel } from "./model";

/** The seven factors, as multipliers on today (1 is the same as today). */
export interface MarketFactors {
  /** Enquiries. */
  leads: number;
  /** Enquiries that sign. */
  conv: number;
  /** Time to decide. */
  cycle: number;
  /** Prices you can charge. */
  price: number;
  /** Clients leaving. */
  churn: number;
  /** Time to hire. */
  hire: number;
  /** Late payments. */
  pay: number;
}

export type MarketFactorKey = keyof MarketFactors;

export const MARKET_FACTOR_KEYS: readonly MarketFactorKey[] = ["leads", "conv", "cycle", "price", "churn", "hire", "pay"];

/** The factors' limits: the screen's sliders run 50% to 150%; the engine accepts a wider band. */
export const MARKET_FACTOR_MIN = 0;
export const MARKET_FACTOR_MAX = 5;

/** Months in a schedule. */
export const MARKET_MONTHS = 24;

/** A market's schedule for the engine: factors for each month from the start of the run; the last month holds after the end. */
export interface EngineMarket {
  months: MarketFactors[];
}

export const STABLE_MARKET: MarketFactors = { leads: 1, conv: 1, cycle: 1, price: 1, churn: 1, hire: 1, pay: 1 };

export type MarketPresetKey = "boom" | "stable" | "soft" | "downturn";

/** The four read-only presets (the prototype's values). */
export const MARKET_PRESETS: Record<MarketPresetKey, { name: string; factors: MarketFactors }> = {
  boom: { name: "Boom", factors: { leads: 1.25, conv: 1.1, cycle: 0.9, price: 1, churn: 0.85, hire: 1.3, pay: 0.9 } },
  stable: { name: "Stable", factors: STABLE_MARKET },
  soft: { name: "Soft", factors: { leads: 0.85, conv: 0.9, cycle: 1.2, price: 0.95, churn: 1.15, hire: 0.9, pay: 1.15 } },
  downturn: { name: "Downturn", factors: { leads: 0.65, conv: 0.75, cycle: 1.4, price: 0.88, churn: 1.35, hire: 0.8, pay: 1.35 } },
};

/** Whole-percent form of the factors, as the screen and the database hold them (100 = today). */
export type MarketPercents = Record<MarketFactorKey, number>;

export function factorsFromPercents(p: MarketPercents): MarketFactors {
  const out = { ...STABLE_MARKET };
  for (const k of MARKET_FACTOR_KEYS) out[k] = p[k] / 100;
  return out;
}

export function percentsFromFactors(f: MarketFactors): MarketPercents {
  const out = {} as MarketPercents;
  for (const k of MARKET_FACTOR_KEYS) out[k] = Math.round(f[k] * 100);
  return out;
}

/** Throws on a market the engine can't run. */
export function checkMarket(market: EngineMarket | undefined): void {
  if (!market) return;
  if (market.months.length < 1) throw new Error("A market needs at least one month");
  for (const m of market.months) {
    for (const k of MARKET_FACTOR_KEYS) {
      const v = m[k];
      if (!(Number.isFinite(v) && v >= MARKET_FACTOR_MIN && v <= MARKET_FACTOR_MAX)) {
        throw new Error(`Market factor '${k}' must be between ${MARKET_FACTOR_MIN} and ${MARKET_FACTOR_MAX}`);
      }
    }
  }
}

/** True when every factor of every month is 1: the market changes nothing. */
export function isNeutralMarket(market: EngineMarket | undefined): boolean {
  return !market || market.months.every((m) => MARKET_FACTOR_KEYS.every((k) => m[k] === 1));
}

/** The market the engine acts on: checked, and null when it is neutral. */
export function activeMarket(model: EngineModel): EngineMarket | null {
  checkMarket(model.market);
  return isNeutralMarket(model.market) ? null : model.market!;
}

/** Hours in one market month (the same 52/12-week month as demand.ts). */
export function marketMonthHours(model: EngineModel): number {
  return WEEKS_PER_MONTH * model.hoursPerWeek;
}

/** The factors in force at simulation hour `t` (month 1 before the run starts). Stable when the model has no active market. */
export function marketAt(model: EngineModel, t: number): MarketFactors {
  const market = activeMarket(model);
  if (!market) return STABLE_MARKET;
  if (t < 0) return market.months[0]!;
  const i = Math.min(Math.floor(t / marketMonthHours(model)), market.months.length - 1);
  return market.months[i]!;
}

/** One entry of a schedule: a condition applies from month `from` to month `to` (1-based, inclusive). */
export interface MarketScheduleEntry {
  from: number;
  to: number;
  /** Id of the condition (a preset key or a custom condition's id). */
  condition: string;
}

/**
 * Expand a schedule into the 24 months the engine uses. Months no entry
 * covers are Stable; where entries overlap, the later one in the list wins.
 */
export function marketFromSchedule(
  schedule: readonly MarketScheduleEntry[],
  factorsOf: (condition: string) => MarketFactors | undefined,
): EngineMarket {
  const months: MarketFactors[] = Array.from({ length: MARKET_MONTHS }, () => STABLE_MARKET);
  for (const e of schedule) {
    const f = factorsOf(e.condition);
    if (!f) continue;
    for (let m = Math.max(1, e.from); m <= Math.min(MARKET_MONTHS, e.to); m++) months[m - 1] = f;
  }
  return { months };
}

/**
 * The model with one condition in force for the whole run: the entry point for
 * the market stress test (A50). Run it with `simulate`, e.g.
 * `simulate(withMarketCondition(model, MARKET_PRESETS.downturn.factors), reps, seed)`.
 * It replaces any schedule the model already carries: the condition applies in
 * every month, so the result shows that condition alone, not on top of the schedule.
 *
 * Known limits: the factors act on what happens in the run, not on every derived
 * figure. `lostRevenue` is valued at today's price, LTV uses today's tenure
 * (`value`), and the pooled `weeksBilled` estimate uses the churn factor of the
 * month a client is won in, not later months'. (A roster client's reported
 * `churnMonthly` includes the factor since the churn drivers, engine 1.6.0.)
 */
export function withMarketCondition(model: EngineModel, factors: MarketFactors): EngineModel {
  return { ...model, market: { months: [factors] } };
}

/** The model with a schedule in force (or none, when `market` is omitted). */
export function withMarketSchedule(model: EngineModel, market: EngineMarket | undefined): EngineModel {
  const { market: _old, ...rest } = model;
  return market ? { ...rest, market } : rest;
}
