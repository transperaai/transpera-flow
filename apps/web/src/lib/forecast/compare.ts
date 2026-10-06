// Two plans side by side (B7, issue #36): monthly recurring revenue, clients at risk per client group, and how busy each
// role gets, with both plans' averages and 10-90% ranges and the difference of the averages. Both plans run with the same
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
  mrr: CompareRow;
  /** One per client group (service), named by the service; pooled models: empty. */
  atRisk: CompareRow[];
  /** One per role with work in either plan (as the timeline filters), in the model's role order. `a`/`b` are `MonthBusy`. */
  roles: CompareRow[];
  /** Headline numbers for the tiles: last month's MRR, last month's clients at risk (all groups), months too busy (all roles). */
  totals: { mrr: [number, number]; atRisk: [number, number] | null; tooBusyMonths: [number, number] };
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
  return {
    months,
    mrr: row("mrr", "Monthly recurring revenue", a.mrr, b.mrr),
    atRisk,
    roles,
    totals: {
      mrr: [a.mrr[last]?.mean ?? 0, b.mrr[last]?.mean ?? 0],
      atRisk: atRisk.length ? [sumLast("a"), sumLast("b")] : null,
      tooBusyMonths: [roles.reduce((n, r) => n + tooBusy(r, "a"), 0), roles.reduce((n, r) => n + tooBusy(r, "b"), 0)],
    },
  };
}
