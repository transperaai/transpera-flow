// When (docs/plans/sandbox-p5-brief.md §6.4): the month capacity runs out in the run on screen, and the month a hire pays for itself.
// Pure: no React. Both read runs already made (the payback needs one more run per hire, made by the component).

import { firstCrossing, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { formatPercent, formatWholeCurrency } from "@/lib/format";
import type { TimelineMonth } from "@/lib/forecast/timeline";

export interface CapacityRunsOut {
  /** The month index (0 is the first month of the run). */
  month: number;
  roleId: string;
  roleName: string;
  /** "busy": the role's average busy share passes the Too busy line; "uncovered": there is work in the role and nobody there to do it. */
  kind: "busy" | "uncovered";
  /** The busy share (kind "busy") or the hours a week with nobody there (kind "uncovered"). */
  value: number;
}

/**
 * The earliest month any role's average busy share passes the "Too busy" line, or has work and nobody to do it. Roles with no work
 * never cross. A tie goes to the busy line, then to the role listed first.
 */
export function capacityRunsOut(monthly: MonthlyResult, roleNames: Readonly<Record<string, string>>, cutoffs: readonly [number, number, number]): CapacityRunsOut | null {
  let best: CapacityRunsOut | null = null;
  const consider = (candidate: CapacityRunsOut) => {
    if (!best || candidate.month < best.month) best = candidate;
  };
  for (const id of Object.keys(monthly.roles)) {
    const crossing = firstCrossing((monthly.roles[id] ?? []) as (MonthBusy | null)[], cutoffs).average;
    if (crossing) consider({ month: crossing.month, roleId: id, roleName: roleNames[id] ?? id, kind: "busy", value: crossing.value });
    const uncovered = monthly.uncovered[id]?.findIndex((h) => h !== null && h > 0) ?? -1;
    if (uncovered >= 0) consider({ month: uncovered, roleId: id, roleName: roleNames[id] ?? id, kind: "uncovered", value: monthly.uncovered[id]![uncovered]! });
  }
  return best;
}

/** The headline sentence for `capacityRunsOut`: "Capacity runs out in March 2027: Designers are 88% busy on average." */
export function capacityLine(out: CapacityRunsOut | null, months: readonly Pick<TimelineMonth, "long">[], horizonLabel: string): string {
  if (!out) return `Capacity doesn't run out within these ${horizonLabel}: no role passes the Too busy line on average.`;
  const when = months[out.month]?.long ?? `month ${out.month + 1}`;
  const lead = out.month === 0 ? `Capacity has already run out (${when})` : `Capacity runs out in ${when}`;
  if (out.kind === "uncovered") return `${lead}: nobody in ${out.roleName} is there for ${Math.round(out.value * 10) / 10} hours a week of its work.`;
  return `${lead}: ${out.roleName} ${/s$/.test(out.roleName) ? "are" : "is"} ${formatPercent(out.value)} busy on average.`;
}

export interface Payback {
  /** The month index the hire has paid for itself by (the first month after which the running difference stays at or above 0), or null when it hasn't by the horizon. */
  month: number | null;
  /** The running difference in profit (with the hire minus without it) from the hire's month, per month of the run (0 before it). */
  cumulative: number[];
  /** The running difference at the horizon: positive is ahead, negative still behind. */
  atHorizon: number;
}

/**
 * When a change pays for itself: the difference in mean monthly profit with it and without it, added up from `fromMonth`. The month it
 * "pays for itself by" is the first month after which that running total stays at or above zero: at once (`fromMonth`) when it never
 * goes below, later after a dip, and `null` when it ends below zero. Means only; there is no range on a payback month.
 */
export function paybackMonth(withChange: readonly Stat[], without: readonly Stat[], fromMonth: number): Payback {
  const n = Math.min(withChange.length, without.length);
  const cumulative: number[] = [];
  let running = 0;
  for (let m = 0; m < n; m++) {
    if (m >= fromMonth) running += withChange[m]!.mean - without[m]!.mean;
    cumulative.push(m >= fromMonth ? running : 0);
  }
  const atHorizon = cumulative[n - 1] ?? 0;
  if (n === 0 || fromMonth >= n) return { month: null, cumulative, atHorizon };
  let lastBelow = -1;
  for (let m = fromMonth; m < n; m++) if (cumulative[m]! < 0) lastBelow = m;
  if (lastBelow === n - 1) return { month: null, cumulative, atHorizon };
  return { month: lastBelow < 0 ? fromMonth : lastBelow + 1, cumulative, atHorizon };
}

/** "pays for itself by August 2027 (+£4,100 by the horizon, on average)" or "doesn't pay for itself within these 12 months (-£9,800 by September 2027, on average)". */
export function paybackLine(p: Payback, months: readonly Pick<TimelineMonth, "long">[], currency: string, horizonLabel: string): string {
  const last = months[months.length - 1]?.long ?? "the horizon";
  const money = (v: number) => `${v >= 0 ? "+" : "−"}${formatWholeCurrency(Math.abs(Math.round(v)), currency)}`;
  if (p.month === null) return `doesn't pay for itself within these ${horizonLabel} (${money(p.atHorizon)} by ${last}, on average)`;
  return `pays for itself by ${months[p.month]?.long ?? `month ${p.month + 1}`} (${money(p.atHorizon)} by ${last}, on average)`;
}
