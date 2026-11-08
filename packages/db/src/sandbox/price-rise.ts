// The price rise's trade-off (docs/plans/sandbox-p3-brief.md §2.5): what a rise gains from the clients who stay, what it loses from the
// extra clients who leave, and what it nets, measured by pairing the scenario with the same scenario without its rise (same seed, same pinned
// warm-up, so a client leaves in both unless the rise pushed its chance over its own draw). Pure.

import { stat, type Stat } from "@transpera-flow/engine";

/** Each replication's own months (SimulationResult.monthlySamples): replication × month. */
export interface RunSamples {
  revenue: number[][];
  rise: number[][];
  clientsLost: number[][];
}

export interface PriceRiseTradeoff {
  /** Per month, over replications: gained (the stayers' extra fees), lost (the rest of the difference), net (revenue with minus without), extra leavers. */
  gained: Stat[];
  lost: Stat[];
  net: Stat[];
  extraLeavers: Stat[];
  /** Over the run: the sum of the months, taken per replication, then the stat. */
  total: { gained: Stat; lost: Stat; net: Stat; extraLeavers: Stat };
  /** The month the first rise starts in. */
  firstRise: number;
  /** Revenue lost per extra leaver (run totals), and the extra leavers the rise can lose before its net is 0, set against the extra leavers it loses now. */
  lossPerLeaver: number;
  breakEven: number;
  extraNow: number;
  /** The loss per leaver is a guess (the rise lost almost nobody to measure it by): the fee after the rise times half the months left. */
  estimated: boolean;
  /** The break-even as extra monthly churn (a share of client-months after the rise), when the client-months are known. */
  breakEvenRate: number | null;
  /**
   * What the break-even line can say: `breakEven` (the rise gains, and each extra leaver costs something), `cut` (the change gains nothing
   * from the clients who stay: a cut, so there is nothing to break even), `free` (it gains, but no cost per leaver could be measured or
   * estimated, so there is no number of leavers that cancels it). Only `breakEven` has a meaningful `breakEven` and `breakEvenRate`.
   */
  outcome: "breakEven" | "cut" | "free";
}

const MIN_LEAVERS = 0.05;

/**
 * Two runs that agree to the last bits can still differ by float noise in money (a stay's fee is spread over a month's weeks as
 * amount / length x overlap, and a run with a fee channel adds the weeks in a different order). A difference under a millionth of a unit
 * is nothing: months before the rise read exactly 0, not -0.00000000001.
 */
const NOISE = 1e-6;
const clean = (v: number) => (Math.abs(v) < NOISE ? 0 : v);

export function priceRiseTradeoff(
  withRise: RunSamples,
  withoutRise: RunSamples,
  riseMonths: readonly number[],
  opts: { monthlyFee?: number; clientMonthsAfter?: number } = {},
): PriceRiseTradeoff | null {
  const reps = Math.min(withRise.revenue.length, withoutRise.revenue.length);
  const months = withRise.revenue[0]?.length ?? 0;
  if (!reps || !months || !riseMonths.length) return null;
  const G: number[][] = [];
  const L: number[][] = [];
  const N: number[][] = [];
  const X: number[][] = [];
  for (let i = 0; i < reps; i++) {
    G.push(withRise.rise[i]!.map(clean));
    N.push(withRise.revenue[i]!.map((v, m) => clean(v - withoutRise.revenue[i]![m]!)));
    L.push(G[i]!.map((g, m) => clean(g - N[i]![m]!)));
    X.push(withRise.clientsLost[i]!.map((v, m) => v - withoutRise.clientsLost[i]![m]!));
  }
  const perMonth = (rows: number[][]) => Array.from({ length: months }, (_, m) => stat(rows.map((r) => r[m]!)));
  const sums = (rows: number[][]) => rows.map((r) => r.reduce((a, b) => a + b, 0));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const tg = sums(G);
  const tl = sums(L);
  const tx = sums(X);
  const firstRise = Math.min(...riseMonths);
  const meanG = sum(tg) / reps;
  const meanX = sum(tx) / reps;
  const monthsAfter = months - firstRise;
  const estimated = meanX < MIN_LEAVERS;
  const lossPerLeaver = estimated ? (opts.monthlyFee ?? 0) * (monthsAfter / 2) : sum(tl) / sum(tx);
  const outcome: PriceRiseTradeoff["outcome"] = !(meanG > 0) ? "cut" : lossPerLeaver > 0 ? "breakEven" : "free";
  const breakEven = outcome === "breakEven" ? meanG / lossPerLeaver : 0;
  return {
    gained: perMonth(G),
    lost: perMonth(L),
    net: perMonth(N),
    extraLeavers: perMonth(X),
    total: { gained: stat(tg), lost: stat(tl), net: stat(sums(N)), extraLeavers: stat(tx) },
    firstRise,
    lossPerLeaver,
    breakEven,
    extraNow: meanX,
    estimated,
    breakEvenRate: outcome === "breakEven" && opts.clientMonthsAfter && opts.clientMonthsAfter > 0 ? breakEven / opts.clientMonthsAfter : null,
    outcome,
  };
}
