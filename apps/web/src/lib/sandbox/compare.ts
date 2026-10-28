// Scenarios side by side (docs/plans/sandbox-p1-brief.md §4): monthly recurring revenue, clients at risk per client group, active
// clients per type and how busy each role gets, for "No changes" and up to three scenarios, with each column's average and 10-90%
// range and its difference from column 0 ("No changes"). Every column runs with the same seed, so a difference comes from the
// scenarios, not from chance. Pure: no React.

import type { ProcessBundle } from "@transpera-flow/db";
import { isTooBusy, type EngineModel, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { timelineMonths, type TimelineMonth } from "@/lib/forecast/timeline";

/** One series across the columns: `values[c][month]`, and `diff[c][month]` = column c's mean − column 0's (null when either is missing; column 0 is all null). */
export interface CompareRow {
  id: string;
  name: string;
  values: (Stat | null)[][];
  diff: (number | null)[][];
}

/** A headline number per column and its difference from column 0 (null for column 0). */
export interface CompareTile {
  values: number[];
  diff: (number | null)[];
}

export interface SandboxComparison {
  months: TimelineMonth[];
  mrr: CompareRow;
  /** Active clients, one per type (service); empty when the model has no services. */
  clients: CompareRow[];
  /** One per client group (service), named by the service; pooled models: empty. */
  atRisk: CompareRow[];
  /** One per role with work in any column (as the timeline filters), in the model's role order. Values are `MonthBusy`. */
  roles: CompareRow[];
  /** Last month's MRR, last month's clients at risk (all groups; null when pooled), months too busy (all roles), late tasks in the last month. */
  totals: { mrr: CompareTile; atRisk: CompareTile | null; tooBusyMonths: CompareTile; lateTasks: CompareTile };
}

const row = (id: string, name: string, columns: (Stat | null)[][]): CompareRow => ({
  id,
  name,
  values: columns,
  diff: columns.map((col, c) => col.map((s, i) => (c === 0 || !s || !columns[0]![i] ? null : s.mean - columns[0]![i]!.mean))),
});

const tile = (values: number[]): CompareTile => ({ values, diff: values.map((v, c) => (c === 0 ? null : v - values[0]!)) });

/** A role has work in a run when any month's 90th percentile is above half a percent (as the timeline's rows are filtered). */
const hasWork = (series: readonly (MonthBusy | null)[] | undefined, uncovered: readonly (number | null)[] | undefined) =>
  !!series?.some((m) => m && m.p90 > 0.005) || !!uncovered?.some((h) => h !== null);

export function compareSandbox(
  model: EngineModel,
  columns: readonly MonthlyResult[],
  bundle: Pick<ProcessBundle, "services">,
  startDate: string,
  cutoffs: readonly [number, number, number],
): SandboxComparison {
  const first = columns[0]!;
  const months = timelineMonths(startDate, first.months, model.hoursPerWeek);
  const last = months.length - 1;
  const serviceName = new Map(bundle.services.map((s) => [s.id, s.name]));
  const zero = (): Stat[] => months.map(() => ({ mean: 0, p10: 0, p90: 0 }));
  const keys = (pick: (m: MonthlyResult) => Record<string, unknown>) => [...new Set(columns.flatMap((m) => Object.keys(pick(m))))].sort();
  const nameOf = (key: string) => (key ? (serviceName.get(key) ?? model.services?.[key]?.name ?? "Other") : "Clients");
  const atRisk = keys((m) => m.atRisk).map((key) => row(key, nameOf(key), columns.map((m) => m.atRisk[key] ?? zero())));
  const clients = keys((m) => m.clients).map((key) => row(key, nameOf(key), columns.map((m) => m.clients[key] ?? zero())));
  const roles = Object.entries(model.roles)
    .filter(([id]) => columns.some((m) => hasWork(m.roles[id], m.uncovered[id])))
    .map(([id, r]) => row(id, r.name, columns.map((m) => m.roles[id] ?? months.map(() => null))));
  const tooBusy = (r: CompareRow, c: number) => r.values[c]!.filter((m) => m !== null && isTooBusy((m as MonthBusy).mean, cutoffs)).length;
  const sumLast = (c: number) => atRisk.reduce((sum, r) => sum + (r.values[c]![last]?.mean ?? 0), 0);
  const idx = columns.map((_, c) => c);
  return {
    months,
    mrr: row("mrr", "Monthly recurring revenue", columns.map((m) => m.mrr)),
    clients,
    atRisk,
    roles,
    totals: {
      mrr: tile(columns.map((m) => m.mrr[last]?.mean ?? 0)),
      atRisk: atRisk.length ? tile(idx.map(sumLast)) : null,
      tooBusyMonths: tile(idx.map((c) => roles.reduce((n, r) => n + tooBusy(r, c), 0))),
      lateTasks: tile(columns.map((m) => m.lateTasks[last]?.mean ?? 0)),
    },
  };
}
