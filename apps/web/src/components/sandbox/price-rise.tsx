"use client";

// The price rise's trade-off (sandbox phase 3, docs/plans/sandbox-p3-brief.md §6.2): what a rise gains from the clients who stay, what it
// loses from the extra clients who leave, what it nets and how many extra clients it can lose before it stops paying, worked out by running
// the same months without the rise. Revenue is shown to every role; nothing here is pay.

import { Help } from "@/components/help";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/format";
import type { TimelineMonth } from "@/lib/forecast/timeline";
import type { PriceRiseTradeoff } from "@/lib/sandbox/price-rise";
import type { Stat } from "@transpera-flow/engine";
import { CompareChart } from "./compare-chart";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

const HELP = {
  section: {
    label: "Price rise",
    description:
      "What the rise gains and what it costs, month by month and over the run. Lost includes everything the rise changed besides the higher fees: clients who left because of it and the work and fees they would have brought. Worked out by running the same months without the rise.",
    example: "Gained £9K, lost £6K, net +£3K means the rise pays for itself, with room for a few more leavers.",
  },
  breakEven: {
    label: "Break-even",
    description: "How many extra clients the rise can lose before it stops paying: the fees it gains divided by what each extra leaver costs.",
    example: "Loses 2.1 now against 6.2 to break even means a wide margin.",
  },
};

export function PriceRise({ tradeoff: t, months, currency }: { tradeoff: PriceRiseTradeoff; months: TimelineMonth[]; currency: string }) {
  const money = (v: number) => formatCurrency(v, currency);
  const signed = (v: number) => `${v < 0 ? "−" : "+"}${money(Math.abs(v))}`;
  const range = (s: Stat, f: (v: number) => string) => `${f(s.p10)} to ${f(s.p90)}`;
  const tiles: { id: string; label: string; stat: Stat; format: (v: number) => string }[] = [
    { id: "gained", label: "Gained from clients who stay", stat: t.total.gained, format: money },
    { id: "lost", label: "Lost from extra leavers", stat: t.total.lost, format: money },
    { id: "net", label: "Net change", stat: t.total.net, format: signed },
    { id: "leavers", label: "Extra clients lost", stat: t.total.extraLeavers, format: (v) => formatNumber(v, 1) },
  ];
  const rows: { id: string; label: string; values: Stat[]; total: Stat; format: (v: number) => string }[] = [
    { id: "gained", label: "Gained", values: t.gained, total: t.total.gained, format: money },
    { id: "lost", label: "Lost", values: t.lost, total: t.total.lost, format: money },
    { id: "net", label: "Net", values: t.net, total: t.total.net, format: signed },
    { id: "leavers", label: "Extra leavers", values: t.extraLeavers, total: t.total.extraLeavers, format: (v) => formatNumber(v, 1) },
  ];
  return (
    <section className="flex min-w-0 flex-col gap-3" data-price-rise>
      <div className="flex flex-col gap-0.5">
        <h2 className={`${SECTION_TITLE} flex items-center`}>
          Price rise
          <Help {...HELP.section} />
        </h2>
        <p className="text-sm text-muted-foreground">What the rise earns and what it costs in clients, with the 10–90% range from 30 runs.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-price-rise-tiles>
        {tiles.map((tile) => (
          <Card key={tile.id} className="gap-0.5 px-4 py-3" data-price-rise-tile={tile.id}>
            <span className="text-xs text-muted-foreground">{tile.label}</span>
            <span className="text-xl font-semibold tabular-nums">{tile.format(tile.stat.mean)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{range(tile.stat, tile.format)}</span>
          </Card>
        ))}
      </div>
      <Card className="px-4 py-3 text-sm" data-price-rise-break-even>
        <span className="flex items-center" data-price-rise-outcome={t.outcome}>
          {t.outcome === "cut" ? (
            "This change lowers what the clients who stay pay, so there is no break-even: a cut doesn't change churn here."
          ) : t.outcome === "free" ? (
            <>No cost per extra leaver could be worked out (it loses {formatNumber(t.extraNow, 1)} extra clients now), so there is no break-even to show.</>
          ) : (
            <>
              The rise pays for itself while it loses fewer than {formatNumber(t.breakEven, 1)} extra clients over the run (it loses {formatNumber(t.extraNow, 1)} now)
              {t.breakEvenRate !== null ? `, or about ${formatNumber(t.breakEvenRate * 100, 1)} points of extra monthly churn` : ""}.
            </>
          )}
          <Help {...HELP.breakEven} />
        </span>
        {t.estimated && t.outcome === "breakEven" ? <span className="mt-1 block text-xs text-muted-foreground">Estimated: the rise lost almost nobody to measure it by, so each lost client is taken as half the months left at the fee after the rise.</span> : null}
      </Card>
      <Card className="gap-2 px-4 py-4" data-price-rise-chart>
        <h3 className="text-sm font-medium">Net change per month</h3>
        <CompareChart title="Net change per month" months={months} series={[{ name: "Net change", values: t.net }]} format={signed} reference={{ value: 0, label: "No change" }} />
      </Card>
      <Card className="min-w-0 px-4 py-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-xs tabular-nums" data-price-rise-table>
            <caption className="sr-only">Price rise by month, average of 30 runs</caption>
            <thead>
              <tr className="text-right text-muted-foreground">
                <th scope="col" className="sticky left-0 bg-card py-1 pr-3 text-left font-medium"></th>
                {months.map((mo) => (
                  <th key={mo.index} scope="col" className="px-2 py-1 font-medium">
                    {mo.short}
                  </th>
                ))}
                <th scope="col" className="py-1 pl-3 font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="text-right" data-price-rise-row={r.id}>
                  <th scope="row" className="sticky left-0 bg-card py-1 pr-3 text-left font-medium">
                    {r.label}
                  </th>
                  {r.values.map((v, i) => (
                    <td key={i} className="px-2 py-1">
                      {r.format(v.mean)}
                    </td>
                  ))}
                  <td className="py-1 pl-3 font-medium">{r.format(r.total.mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

