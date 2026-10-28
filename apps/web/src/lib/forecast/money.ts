// "Sales and money" for the Forecast page and the plan compare view (sandbox phase 2, profit first): what a run earns, what its
// team and overheads cost, and the profit that leaves, month by month, from the engine's monthly series. The same numbers the
// Sandbox page reads. Pure (no React), so it is tested without a browser.
//
// Pay privacy: a Viewer's model hides pay (`payHidden`), so the engine returns no labour, overtime cost or profit; nothing here
// puts a cost back, and the view says who sees them. Revenue, sales, clients and overtime hours are never hidden.

import type { SimulationResult, Stat } from "@transpera-flow/engine";
import type { TimelineMonth } from "./timeline";

/** How a row's numbers read. */
export type MoneyUnit = "count" | "money" | "percent" | "hours";

export interface MoneyTile {
  id: "revenue" | "labour" | "overheads" | "profit";
  label: string;
  /** The mean over the run with its 10-90% range; a figure with no spread (overheads) has p10 = p90 = mean. */
  stat: Stat;
  /**
   * False for a plan's spliced run: the tile is the sum of the months' averages, and the run has no 10-90% range of its own
   * (p10 = p90 = mean; the months keep theirs). A sum of the months' 10th percentiles is not the run's 10th percentile.
   */
  ranged: boolean;
}

export interface MoneyRow {
  id: string;
  label: string;
  unit: MoneyUnit;
  /** A row set under the one above it (revenue by kind). */
  indent: boolean;
  /** One per month: the mean with its 10-90% range (a fixed figure has p10 = p90 = mean). */
  cells: Stat[];
  /** The months added up (the means), or null for a ratio. */
  total: number | null;
  /** Rows that put a cost against the revenue: the last four. */
  cost: boolean;
}

export interface ForecastMoneyView {
  /** The months the columns are, named. */
  months: readonly TimelineMonth[];
  /** Revenue, labour (with overtime), overheads and profit over the run. Costs and profit are missing when pay is hidden. */
  tiles: MoneyTile[];
  rows: MoneyRow[];
  /** Profit per month with its 10-90% range, for the chart; null when pay is hidden. */
  profit: Stat[] | null;
  /** Pay is hidden (a Viewer): no labour, overtime cost, profit or overheads shown. */
  costsHidden: boolean;
  /** No overheads are set in Settings (not said to someone who can't see costs). */
  noOverheads: boolean;
  /** Names of hourly services whose clients have no work modelled, so they earned nothing. */
  hourlyWithoutHours: string[];
}

const fixed = (v: number): Stat => ({ mean: v, p10: v, p90: v });
const sum = (cells: readonly Stat[]) => cells.reduce((a, s) => a + s.mean, 0);

/**
 * The money view of a monthly run. `serviceName` names an hourly service for the note about one that earned nothing (its id
 * when omitted). A result saved before engine 1.11.0 has none of these numbers: the view is then empty rather than wrong.
 *
 * `spliced`: the run is a plan's, spliced month by month from several runs (`spliceMonthly`). Its `kpi` is then only the
 * first segment's, a run without the plan's later changes, so the tiles are worked out from the spliced months instead.
 */
export function forecastMoney(
  result: SimulationResult,
  months: readonly TimelineMonth[],
  serviceName: (id: string) => string = (id) => id,
  { spliced = false }: { spliced?: boolean } = {},
): ForecastMoneyView | null {
  const mo = result.monthly;
  const kpi = result.kpi;
  if (!mo || !mo.revenue || !kpi.revenue || months.length === 0) return null;
  const costsHidden = mo.money === null || kpi.labourCost === null || kpi.profit === null;

  const tiles: MoneyTile[] = [];
  if (spliced) {
    // Sums of the months' means (a mean of sums is the sum of the means); no run-wide range exists for a spliced run.
    const ranged = false;
    tiles.push({ id: "revenue", label: "Revenue", stat: fixed(sum(mo.revenue.total)), ranged });
    if (!costsHidden) {
      const money = mo.money!;
      const labour = money.labour.reduce((a, v) => a + v, 0) + sum(money.overtimeCost);
      tiles.push({ id: "labour", label: "Labour", stat: fixed(labour), ranged });
      tiles.push({ id: "overheads", label: "Overheads", stat: fixed(money.overheads.reduce((a, v) => a + v, 0)), ranged: true });
      tiles.push({ id: "profit", label: "Profit", stat: fixed(sum(money.profit)), ranged });
    }
  } else {
    tiles.push({ id: "revenue", label: "Revenue", stat: kpi.revenue, ranged: true });
    if (!costsHidden) {
      // Labour is the same in every run, so adding overtime's range gives labour with overtime's range.
      const labour = kpi.labourCost!;
      const overtime = kpi.overtimeCost ?? fixed(0);
      tiles.push({ id: "labour", label: "Labour", stat: { mean: labour.mean + overtime.mean, p10: labour.p10 + overtime.p10, p90: labour.p90 + overtime.p90 }, ranged: true });
      tiles.push({ id: "overheads", label: "Overheads", stat: fixed(kpi.overheads), ranged: true });
      tiles.push({ id: "profit", label: "Profit", stat: kpi.profit!, ranged: true });
    }
  }

  const row = (id: string, label: string, unit: MoneyUnit, cells: Stat[], opts: { indent?: boolean; cost?: boolean; total?: boolean } = {}): MoneyRow => ({
    id,
    label,
    unit,
    indent: opts.indent ?? false,
    cells,
    total: opts.total === false ? null : sum(cells),
    cost: opts.cost ?? false,
  });
  const rows: MoneyRow[] = [
    row("opportunities", "Opportunities", "count", mo.sales.opportunities),
    row("won", "Won", "count", mo.sales.won),
    row("lost", "Lost", "count", mo.sales.lost),
    row("conversion", "Conversion", "percent", mo.sales.conversion, { total: false }),
    row("revenue", "Billed revenue", "money", mo.revenue.total),
    row("recurring", "Recurring", "money", mo.revenue.recurring, { indent: true }),
    row("oneOff", "One-off", "money", mo.revenue.oneOff, { indent: true }),
    row("hourly", "Hourly", "money", mo.revenue.hourly, { indent: true }),
    row("fromNew", "From new clients", "money", mo.revenue.fromNew),
    row("lostToChurn", "Monthly fees lost to churn", "money", mo.revenue.lostToChurn),
    row("clientsWon", "Clients won", "count", mo.clientsWon),
    row("clientsLost", "Clients lost", "count", mo.clientsLost),
    row("overtimeHours", "Overtime hours", "hours", mo.overtimeHours),
  ];
  if (mo.money) {
    rows.push(
      row("labour", "Labour", "money", mo.money.labour.map(fixed), { cost: true }),
      row("overtimeCost", "Overtime cost", "money", mo.money.overtimeCost, { cost: true }),
      row("overheads", "Overheads", "money", mo.money.overheads.map(fixed), { cost: true }),
      row("profit", "Profit", "money", mo.money.profit, { cost: true }),
    );
  }

  // Hourly services that billed nothing because the clients they bring generate no work in the model (for a plan, as its first
  // segment runs them: a plan's solutions change the work, not which services are hourly).
  const hourlyWithoutHours = Object.entries(kpi.hourly ?? {})
    .filter(([, h]) => h.hours.mean === 0)
    .map(([id]) => serviceName(id))
    .sort((a, b) => a.localeCompare(b));

  return { tiles, rows, profit: mo.money ? mo.money.profit : null, costsHidden, months, noOverheads: !costsHidden && !(kpi.overheads > 0), hourlyWithoutHours };
}
