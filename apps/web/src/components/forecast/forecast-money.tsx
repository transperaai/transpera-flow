"use client";

// "Sales and money" (sandbox phase 2, profit first): the run on screen, as revenue, labour, overheads and profit over the run
// and month by month, with the sales and client movement behind them. It lives on the Forecast page (the live run, or the open
// plan's spliced run) until the Sandbox page takes it over: the Sandbox imports this component and `forecastMoney` as they are.
//
// A Viewer's model hides pay, so the engine gives no labour, overtime cost or profit and this says who sees them; revenue,
// sales and clients are shown to everyone.

import Link from "next/link";
import { Help } from "@/components/help";
import { Card } from "@/components/ui/card";
import { SANDBOX_HELP as PLAN_HELP } from "@/lib/forecast/help";
import type { ForecastMoneyView, MoneyRow, MoneyTile, MoneyUnit } from "@/lib/forecast/money";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { partMonthNote } from "@/lib/forecast/timeline";
import { CompareChart } from "@/components/sandbox/compare-chart";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

/** The sentence a Viewer reads where the costs would be. */
export const COSTS_HIDDEN_NOTE = "Costs and profit are shown to Agency admins and the Owner.";

const TILE_HELP: Record<MoneyTile["id"], { label: string; description: string; example: string }> = {
  revenue: {
    label: "Revenue over the run",
    description: "Everything billed in the forecast: monthly fees from every active client, one-off prices, and hourly work done for clients won in the forecast. The range is the middle 80% of the 30 simulated runs.",
    example: "£348K (£320K to £385K) means most runs bill between those two.",
  },
  labour: {
    label: "Labour over the run",
    description: "The team's pay for the hours they're contracted to work (leave is paid), plus the cost of overtime.",
    example: "Eleven full-time people at about £50 an hour is about £290K over 13 weeks.",
  },
  overheads: {
    label: "Overheads over the run",
    description: "Your fixed costs a month from Settings, for every month of the forecast.",
    example: "18,000 a month is 54,000 over 3 months.",
  },
  profit: PLAN_HELP.profit,
};

const ROW_HELP: Partial<Record<string, { label: string; description: string; example: string }>> = {
  revenue: PLAN_HELP.billed,
  profit: PLAN_HELP.profit,
  labour: PLAN_HELP.labour,
  won: PLAN_HELP.winsPerMonth,
  conversion: PLAN_HELP.conversion,
  fromNew: {
    label: "From new clients",
    description: "The part of billed revenue that comes from clients won during the forecast: their fees, one-off prices and hourly work.",
    example: "£18K of £112K means the clients you have today bill the other £94K.",
  },
  lostToChurn: {
    label: "Monthly fees lost to churn",
    description: "The monthly fees of the clients who left in the month. It is what they would have paid each month from then on, not what was billed.",
    example: "£3.8K means clients paying £3.8K a month in total left that month.",
  },
  overtimeHours: {
    label: "Overtime hours",
    description: "Hours worked beyond contracted capacity because client work outgrew someone's week, up to the overtime cap in Settings.",
    example: "12 means the team worked 12 hours of overtime in the month.",
  },
};

const money = (v: number, currency: string) => formatCurrency(v, currency);

function format(unit: MoneyUnit, v: number, currency: string): string {
  switch (unit) {
    case "money":
      return money(v, currency);
    case "percent":
      return formatPercent(v);
    case "hours":
      return `${formatNumber(v, 0)} h`;
    case "count":
      return formatNumber(v, 1);
  }
}

export interface ForecastMoneyProps {
  view: ForecastMoneyView;
  currency: string;
  /** Where Agency admins and the Owner set overheads (Settings, Workspace); omitted when they can't (a Viewer, the demo). */
  overheadsHref?: string | null;
  /** The span in words, "12 months". */
  span: string;
  /** What stands where the costs would be, when the run has none (default: the Viewer's sentence). */
  costsNote?: string;
}

export function ForecastMoney({ view, currency, overheadsHref = null, span, costsNote = COSTS_HIDDEN_NOTE }: ForecastMoneyProps) {
  const fmt = (v: number) => money(v, currency);
  return (
    <section className="flex min-w-0 flex-col gap-3" data-forecast-money data-costs-hidden={view.costsHidden ? "" : undefined}>
      <div className="flex flex-col gap-0.5">
        <h2 className={`${SECTION_TITLE} flex items-center`}>
          Sales and money
          <Help
            label="Sales and money"
            description="What the next months bring in and cost: enquiries, wins and losses, billed revenue, the team's pay, overtime, your overheads and the profit that leaves. Each figure is the average of 30 simulated runs, with the middle 80% beside it."
            example="Profit of £4K a month with a range of −£3K to £11K means a bad month can lose money."
          />
        </h2>
        <p className="text-sm text-muted-foreground">Over the next {span}: revenue, what the team and overheads cost, and the profit left, with the 10–90% range from 30 runs.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-money-tiles>
        {view.tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} format={fmt} />
        ))}
        {view.costsHidden ? (
          <Card className="justify-center gap-1 px-4 py-3 text-sm text-muted-foreground sm:col-span-1 lg:col-span-3" data-money-hidden-note>
            {costsNote}
          </Card>
        ) : null}
      </div>

      {view.profit ? (
        <Card className="gap-2 px-4 py-4" data-money-profit-chart>
          <h3 className="flex items-center text-sm font-medium">
            Profit per month
            <Help {...PLAN_HELP.profit} />
          </h3>
          <CompareChart title="Profit per month" months={[...view.months]} series={[{ name: "Profit", values: view.profit }]} format={fmt} />
        </Card>
      ) : null}

      <Card className="min-w-0 gap-2 px-4 py-4" data-money-table-card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-xs tabular-nums" data-money-table>
            <caption className="sr-only">Sales and money by month, average of 30 runs</caption>
            <thead>
              <tr className="text-right text-muted-foreground">
                <th scope="col" className="sticky left-0 bg-card py-1 pr-3 text-left font-medium"></th>
                {view.months.map((mo) => (
                  <th key={mo.index} scope="col" className="px-2 py-1 font-medium" title={mo.partial ? `Part month: covers ${mo.span}` : undefined}>
                    {mo.short}
                    {mo.partial ? "*" : ""}
                  </th>
                ))}
                <th scope="col" className="py-1 pl-3 font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <Row key={row.id} row={row} currency={currency} />
              ))}
            </tbody>
          </table>
        </div>
        {partMonthNote(view.months) ? (
          <p className="text-xs text-muted-foreground" data-part-month-note>
            * {partMonthNote(view.months)} Totals in a part month reflect the days it covers, so a dip or rise there is not a change.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Hover a figure for its 10–90% range. Months add to the run&apos;s totals, except overtime cost and profit: overtime is worked out month by month, so those months can add to a little more or less than the Labour and Profit tiles above.
        </p>
      </Card>

      <ul className="flex flex-col gap-1 text-sm text-muted-foreground" data-money-notes>
        {view.noOverheads ? (
          <li data-money-note="no-overheads">
            No overheads set, so profit leaves out rent, software and the like.{" "}
            {overheadsHref ? (
              <Link href={overheadsHref} className="underline">
                Set them in Settings, under Workspace
              </Link>
            ) : null}
            {overheadsHref ? "." : ""}
          </li>
        ) : null}
        {view.hourlyWithoutHours.map((name) => (
          <li key={name} data-money-note="hourly-no-hours">
            Hourly service {name} earned nothing: no client work is modelled for its clients, so there are no hours to bill.
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tile({ tile, format: fmt }: { tile: MoneyTile; format: (v: number) => string }) {
  const { stat } = tile;
  const range = !tile.ranged || stat.p10 === stat.p90 ? null : `${fmt(stat.p10)} to ${fmt(stat.p90)}`;
  // A plan's tile adds up its months (each month keeps its range in the table); otherwise a figure with no spread is the same in every run.
  const below = range ? `Range ${range}` : !tile.ranged ? "The months added up; each month's range is in the table" : "The same in every run";
  return (
    <Card className="gap-1 px-4 py-3" data-money-tile={tile.id}>
      <h3 className="flex items-center text-xs font-medium text-fg-2">
        {tile.label}
        <Help {...TILE_HELP[tile.id]} />
      </h3>
      <p className="font-heading text-2xl font-semibold tabular-nums" data-money-value>
        {fmt(stat.mean)}
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">{below}</p>
    </Card>
  );
}

function Row({ row, currency }: { row: MoneyRow; currency: string }) {
  const help = ROW_HELP[row.id];
  const headline = row.id === "revenue" || row.id === "profit";
  return (
    <tr className={`border-t border-line ${row.cost && row.id === "labour" ? "border-t-2" : ""}`} data-money-row={row.id}>
      <th scope="row" className={`sticky left-0 bg-card py-1 pr-3 text-left ${row.indent ? "pl-4 font-normal text-muted-foreground" : headline ? "font-semibold" : "font-medium"}`}>
        <span className="inline-flex items-center whitespace-nowrap">
          {row.label}
          {help ? <Help {...help} /> : null}
        </span>
      </th>
      {row.cells.map((cell, i) => (
        <td
          key={i}
          className={`px-2 py-1 text-right ${headline ? "font-semibold" : ""} ${row.id === "profit" && cell.mean < 0 ? "text-destructive" : ""}`}
          title={cell.p10 === cell.p90 ? undefined : `10–90%: ${format(row.unit, cell.p10, currency)} to ${format(row.unit, cell.p90, currency)}`}
        >
          {format(row.unit, cell.mean, currency)}
        </td>
      ))}
      <td className={`py-1 pl-3 text-right ${headline ? "font-semibold" : ""} ${row.id === "profit" && (row.total ?? 0) < 0 ? "text-destructive" : ""}`}>
        {row.total === null ? "" : format(row.unit, row.total, currency)}
      </td>
    </tr>
  );
}
