// Two plans side by side (B7, issue #36): profit, billed revenue, labour, wins and conversion (sandbox phase 2), monthly
// recurring revenue, clients at risk per client group, and how busy each role gets, with both plans' averages and
// 10-90% ranges and the difference of the averages. Both plans run with the same
// seed, so a difference comes from the plans, not from chance. Pure: no React.

import type { ProcessBundle } from "@transpera-flow/db";
import { isTooBusy, type EngineModel, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { timelineMonths, type TimelineMonth } from "./timeline";

export interface CompareRow {
  id: string;
  name: string;
  a: (Stat | null)[];
  b: (Stat | null)[];
  /** b.mean − a.mean, null when either is null. */
  diff: (number | null)[];
}

export interface PlanComparison {
  months: TimelineMonth[];
  /** Profit per month; null when either plan's costs are hidden (pay hidden). Plans are for Agency admins and the Owner, but guard anyway. */
  profit: CompareRow | null;
  /** Billed revenue (recurring, one-off and hourly) per month. */
  revenue: CompareRow;
  /** Labour with overtime per month; null as `profit` is. */
  labour: CompareRow | null;
  /** Wins per month, and wins as a share of wins and losses. */
  won: CompareRow;
  conversion: CompareRow;
  mrr: CompareRow;
  /** One per client group (service), named by the service; pooled models: empty. */
  atRisk: CompareRow[];
  /** One per role with work in either plan (as the timeline filters), in the model's role order. `a`/`b` are `MonthBusy`. */
  roles: CompareRow[];
  /** Headline numbers for the tiles: last month's MRR, last month's clients at risk (all groups), months too busy (all roles). */
  totals: {
    mrr: [number, number];
    atRisk: [number, number] | null;
    tooBusyMonths: [number, number];
    /** Profit over the run, the sum of the months' means; null with `profit`. */
    profit: [number, number] | null;
  };
}

const row = (id: string, name: string, a: (Stat | null)[], b: (Stat | null)[]): CompareRow => ({
  id,
  name,
  a,
  b,
  diff: a.map((s, i) => (s && b[i] ? b[i]!.mean - s.mean : null)),
});

/** A role has work in a run when any month's 90th percentile is above half a percent (as the timeline's rows are filtered). */
const hasWork = (series: readonly (MonthBusy | null)[] | undefined, uncovered: readonly (number | null)[] | undefined) =>
  !!series?.some((m) => m && m.p90 > 0.005) || !!uncovered?.some((h) => h !== null);

export function comparePlans(
  model: EngineModel,
  a: MonthlyResult,
  b: MonthlyResult,
  bundle: Pick<ProcessBundle, "services">,
  startDate: string,
  cutoffs: readonly [number, number, number],
): PlanComparison {
  const months = timelineMonths(startDate, a.months, model.hoursPerWeek);
  const last = months.length - 1;
  const serviceName = new Map(bundle.services.map((s) => [s.id, s.name]));
  const riskKeys = [...new Set([...Object.keys(a.atRisk), ...Object.keys(b.atRisk)])].sort();
  const zero = (): Stat[] => months.map(() => ({ mean: 0, p10: 0, p90: 0 }));
  const atRisk = riskKeys.map((key) => row(key, key ? (serviceName.get(key) ?? model.services?.[key]?.name ?? "Other") : "Clients", a.atRisk[key] ?? zero(), b.atRisk[key] ?? zero()));
  const roles = Object.entries(model.roles)
    .filter(([id]) => hasWork(a.roles[id], a.uncovered[id]) || hasWork(b.roles[id], b.uncovered[id]))
    .map(([id, r]) => row(id, r.name, a.roles[id] ?? months.map(() => null), b.roles[id] ?? months.map(() => null)));
  const tooBusy = (r: CompareRow, side: "a" | "b") => r[side].filter((m) => m !== null && isTooBusy(m.mean, cutoffs)).length;
  const sumLast = (side: "a" | "b") => atRisk.reduce((sum, r) => sum + (r[side][last]?.mean ?? 0), 0);
  // Labour is the same in every run, so adding overtime's range gives labour with overtime's range.
  const labourWithOvertime = (m: MonthlyResult): Stat[] | null =>
    m.money ? m.money.labour.map((v, i) => ({ mean: v + m.money!.overtimeCost[i]!.mean, p10: v + m.money!.overtimeCost[i]!.p10, p90: v + m.money!.overtimeCost[i]!.p90 })) : null;
  const labourA = labourWithOvertime(a);
  const labourB = labourWithOvertime(b);
  const profit = a.money && b.money ? row("profit", "Profit", a.money.profit, b.money.profit) : null;
  const total = (stats: readonly Stat[]) => stats.reduce((sum, s) => sum + s.mean, 0);
  return {
    months,
    profit,
    revenue: row("revenue", "Billed revenue", a.revenue.total, b.revenue.total),
    labour: labourA && labourB ? row("labour", "Labour and overtime", labourA, labourB) : null,
    won: row("won", "Wins", a.sales.won, b.sales.won),
    conversion: row("conversion", "Conversion", a.sales.conversion, b.sales.conversion),
    mrr: row("mrr", "Monthly recurring revenue", a.mrr, b.mrr),
    atRisk,
    roles,
    totals: {
      mrr: [a.mrr[last]?.mean ?? 0, b.mrr[last]?.mean ?? 0],
      atRisk: atRisk.length ? [sumLast("a"), sumLast("b")] : null,
      tooBusyMonths: [roles.reduce((n, r) => n + tooBusy(r, "a"), 0), roles.reduce((n, r) => n + tooBusy(r, "b"), 0)],
      profit: a.money && b.money ? [total(a.money.profit), total(b.money.profit)] : null,
    },
  };
}
