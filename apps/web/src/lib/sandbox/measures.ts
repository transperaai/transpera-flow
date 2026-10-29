// What goal seek and "what matters most" measure (docs/plans/sandbox-p5-brief.md sections 9 and 10): one number from a run's months. Pure:
// no React, no engine call; every function reads a `MonthlyResult` (the means and 10-90% ranges of 30 runs, month by month).
//
// A measure with a range per month (busy share, a month's profit) can be read on the average or "in 9 of 10 runs" (the month's 90th or 10th
// percentile). A total over the run (churn, profit over the run, hours on a purpose) is a sum of means: there is no per-replication value, so
// it has no range, and the dialog does not offer "9 in 10" for it (open question 10).

import { isTooBusy, type MonthBusy, type MonthlyResult } from "@transpera-flow/engine";
import type { PurposeCategory } from "@transpera-flow/db";
import { timeRows } from "@transpera-flow/db/sandbox";

const sum = (xs: readonly number[]) => xs.reduce((a, v) => a + v, 0);

/**
 * The highest busy share any month reaches, of one role or of every role: on the average, or (`nines`) in the worst 1 run in 10 of that
 * month (its 90th percentile). Null when nobody in the roles has work in any month. "Every month at most 85% busy" is `peakBusy <= 0.85`.
 */
export function peakBusy(monthly: MonthlyResult, o: { roleId: string | null; nines?: boolean } = { roleId: null }): number | null {
  const ids = o.roleId ? [o.roleId] : Object.keys(monthly.roles);
  let peak: number | null = null;
  const see = (v: number) => {
    if (peak === null || v > peak) peak = v;
  };
  for (const id of ids) {
    ((monthly.roles[id] ?? []) as (MonthBusy | null)[]).forEach((m, i) => {
      // Work with nobody there to do it is as busy as a role can be: a headcount cut to nothing must not look like relief.
      if ((monthly.uncovered[id]?.[i] ?? 0) > 0) see(1);
      if (m) see(o.nines ? m.p90 : m.mean);
    });
  }
  return peak;
}

/** Clients lost over the run (the months' means added up). */
export function clientsLost(monthly: MonthlyResult): number {
  return sum(monthly.clientsLost.map((s) => s.mean));
}

/**
 * Monthly churn over the run: clients lost divided by client-months (the months' means of active clients, every type together). A ratio of
 * means, so it has no range. Null when there were no clients.
 */
export function churnRate(monthly: MonthlyResult): number | null {
  const clientMonths = sum(Object.values(monthly.clients).flatMap((stats) => stats.map((s) => s.mean)));
  return clientMonths > 0 ? clientsLost(monthly) / clientMonths : null;
}

/** Profit over the run (the months' means added up); null when pay is hidden (a Viewer's or a visitor's run has none). */
export function totalProfit(monthly: MonthlyResult): number | null {
  return monthly.money ? sum(monthly.money.profit.map((s) => s.mean)) : null;
}

/** One month's profit (0 is the first month): the average, or (`low`) the month a bad run in ten has, the 10th percentile. Null without costs. */
export function monthProfit(monthly: MonthlyResult, month: number, low = false): number | null {
  const s = monthly.money?.profit[month];
  return s ? (low ? s.p10 : s.mean) : null;
}

/** Clients at risk in the last month, every group together; null with no client roster. */
export function atRiskLast(monthly: MonthlyResult): number | null {
  const groups = Object.values(monthly.atRisk);
  if (!groups.length) return null;
  return sum(groups.map((g) => g[g.length - 1]?.mean ?? 0));
}

/** Months in which any role's average busy share is "too busy" (rule 1's Bad band or above, by the cut-offs). */
export function tooBusyMonths(monthly: MonthlyResult, cutoffs: readonly [number, number, number]): number {
  const n = monthly.months.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const busy = Object.entries(monthly.roles).some(([id, r]) => ((monthly.uncovered[id]?.[i] ?? 0) > 0) || ((r[i] ?? null) !== null && isTooBusy(r[i]!.mean, cutoffs)));
    if (busy) count++;
  }
  return count;
}

/** The share of all the team's available hours spent on one purpose category over the run (0 to 1); null when the key isn't in the list. */
export function purposeShare(monthly: MonthlyResult, categories: readonly PurposeCategory[], key: string): number | null {
  if (!categories.some((c) => c.key === key)) return null;
  const row = timeRows(monthly, monthly.months.length, categories, { kind: "team" }).rows.find((r) => r.id === key);
  return row ? row.runShare : null;
}

/** The measures the tornado ranks by. */
export const TORNADO_MEASURES = ["profit", "atRisk", "peakBusy", "tooBusy", "lost", "purpose"] as const;
export type TornadoMeasureId = (typeof TORNADO_MEASURES)[number];

export interface TornadoMeasure {
  id: TornadoMeasureId;
  label: string;
  /** How the number is read: money, a count, a share (0 to 1) of busy time or hours. */
  unit: "money" | "count" | "share";
  /** The measure needs profit (pay), so a Viewer's run can't offer it. */
  needsMoney: boolean;
  /** Which way is better, for colouring: a higher profit is better, fewer clients lost is better. */
  better: "higher" | "lower";
}

export const TORNADO_MEASURE_INFO: Readonly<Record<TornadoMeasureId, TornadoMeasure>> = {
  profit: { id: "profit", label: "Profit over the run", unit: "money", needsMoney: true, better: "higher" },
  atRisk: { id: "atRisk", label: "Clients at risk in the last month", unit: "count", needsMoney: false, better: "lower" },
  peakBusy: { id: "peakBusy", label: "Busiest month of the busiest role", unit: "share", needsMoney: false, better: "lower" },
  tooBusy: { id: "tooBusy", label: "Months a role is too busy", unit: "count", needsMoney: false, better: "lower" },
  lost: { id: "lost", label: "Clients lost over the run", unit: "count", needsMoney: false, better: "lower" },
  purpose: { id: "purpose", label: "Share of hours on one purpose", unit: "share", needsMoney: false, better: "lower" },
};

/** The value of a tornado measure for a run, or null when the run can't say (no costs, no client roster, a purpose that isn't listed). */
export function tornadoValue(measure: TornadoMeasureId, monthly: MonthlyResult, o: { cutoffs: readonly [number, number, number]; categories: readonly PurposeCategory[]; purposeKey?: string }): number | null {
  switch (measure) {
    case "profit":
      return totalProfit(monthly);
    case "atRisk":
      return atRiskLast(monthly);
    case "peakBusy":
      return peakBusy(monthly);
    case "tooBusy":
      return tooBusyMonths(monthly, o.cutoffs);
    case "lost":
      return clientsLost(monthly);
    case "purpose":
      return o.purposeKey ? purposeShare(monthly, o.categories, o.purposeKey) : null;
  }
}
