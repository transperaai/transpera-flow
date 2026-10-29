"use client";

// A one-page summary to print or save as a PDF (docs/plans/sandbox-p5-brief.md §6.2): the numbers already on screen, for "No changes" and
// the scenario, or for the columns of a comparison. The time split is the team's only (never a role's or a person's); costs only with `costs`. It is rendered into <body> beside the app, hidden on screen, and the print styles
// (app/globals.css) show only it on one A4 page. No server PDF: the browser prints what it draws, and the chart stays vector.

import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ProcessBundle, PurposeCategory } from "@transpera-flow/db";
import type { EffectiveChange, PriceRiseTradeoff } from "@transpera-flow/db/sandbox";
import type { EngineModel, MonthlyResult } from "@transpera-flow/engine";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { compareSandbox } from "@/lib/sandbox/compare";
import { describeChange, whenOf, type DescribeContext } from "@/lib/sandbox/describe";
import { CompareChart, SERIES_STYLES } from "./compare-chart";

export const PRINT_MAX_CHANGES = 10;

export interface PrintColumn {
  name: string;
  monthly: MonthlyResult;
  priceRise: PriceRiseTradeoff | null;
  changes: readonly EffectiveChange[];
}

export interface PrintSummaryProps {
  workspaceName: string;
  /** The scenario's name, or "Comparison". */
  title: string;
  /** ISO date printed on it. */
  printedOn: string;
  startDate: string;
  /** The run's horizon, in months. */
  horizonMonths: number;
  engineVersion: string;
  model: EngineModel;
  bundle: Pick<ProcessBundle, "services">;
  columns: PrintColumn[];
  cutoffs: readonly [number, number, number];
  categories: readonly PurposeCategory[];
  currency: string;
  /** Show profit (the admin ticked "Include costs and profit" and the runs have it). */
  costs: boolean;
  /** The "When" headline: the month capacity runs out, or that it doesn't. */
  timingLine: string | null;
  ctx: Omit<DescribeContext, "changes">;
  /** Draw it in place and visible (Storybook): the page itself renders it into <body>, hidden until it is printed. */
  inline?: boolean;
}

const dayText = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function PrintSummary(p: PrintSummaryProps) {
  // Rendered into <body>, so the print styles can hide the whole app beside it; nothing on the server.
  const host = useSyncExternalStore(
    () => () => {},
    () => document.body,
    () => null,
  );
  const comparison = useMemo(
    () => compareSandbox(p.model, p.columns.map((c) => c.monthly), p.bundle, p.startDate, p.cutoffs, p.columns.map((c) => c.priceRise?.total.net.mean ?? null), p.categories),
    [p.model, p.columns, p.bundle, p.startDate, p.cutoffs, p.categories],
  );
  if (!host && !p.inline) return null;
  const names = p.columns.map((c) => c.name);
  const last = comparison.months[comparison.months.length - 1]!.long;
  const money = (v: number) => formatCurrency(Math.round(v), p.currency);
  const runTotal = (stats: readonly { mean: number }[][], c: number) => stats[c]!.reduce((a, s) => a + s.mean, 0);
  const tiles: { title: string; values: string[] }[] = [];
  if (p.costs && comparison.totals.profit) tiles.push({ title: "Profit over the run", values: comparison.totals.profit.values.map(money) });
  tiles.push({ title: "Billed revenue over the run", values: names.map((_, c) => money(runTotal(comparison.revenue.values as { mean: number }[][], c))) });
  tiles.push({ title: `Recurring revenue in ${last}`, values: comparison.totals.mrr.values.map(money) });
  if (comparison.totals.atRisk) tiles.push({ title: `Clients at risk in ${last}`, values: comparison.totals.atRisk.values.map((v) => formatNumber(v, 1)) });
  tiles.push({ title: "Months a role is too busy", values: comparison.totals.tooBusyMonths.values.map(String) });
  const chartRow = p.costs && comparison.profit ? comparison.profit : comparison.mrr;
  const shownTiles = tiles.slice(0, 5);
  // The changes, with their notes: at most ten across the scenarios, then a pointer to the CSV.
  const changes = p.columns.flatMap((c) => c.changes.map((e) => ({ column: c.name, e, all: c.changes.map((x) => x.change) })));
  const shownChanges = changes.slice(0, PRINT_MAX_CHANGES);

  const page = (
    <div {...(p.inline ? {} : { "data-print-root": "" })} className={`${p.inline ? "block w-[186mm] border border-line" : "hidden print:block"} bg-panel p-0 text-[11px] leading-snug text-fg`} aria-hidden={p.inline ? undefined : true}>
      <header className="border-b border-line pb-2">
        <h1 className="text-lg font-semibold leading-tight">
          {p.workspaceName}: {p.title}
        </h1>
        <p className="text-fg-2" data-print-meta>
          Printed {dayText(p.printedOn)}. Starts {comparison.months[0]!.long}, {p.horizonMonths} month{p.horizonMonths === 1 ? "" : "s"}. 30 runs, seed 1, engine {p.engineVersion}.
        </p>
      </header>

      <div className="mt-2 grid grid-cols-3 gap-2" data-print-tiles>
        {shownTiles.map((t) => (
          <div key={t.title} className="min-w-0 rounded border border-line px-2 py-1.5">
            <p className="text-[10px] font-medium text-fg-2">{t.title}</p>
            <dl className="mt-0.5 grid grid-cols-[1fr_auto] gap-x-2 tabular-nums">
              {t.values.map((v, c) => (
                <div key={names[c]! + c} className="contents">
                  <dt className="truncate text-fg-2">{names[c]}</dt>
                  <dd className="text-right font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        {p.timingLine ? (
          <div className="min-w-0 rounded border border-line px-2 py-1.5" data-print-timing>
            <p className="text-[10px] font-medium text-fg-2">When</p>
            <p className="mt-0.5">{p.timingLine}</p>
          </div>
        ) : null}
      </div>

      <section className="mt-2" data-print-chart>
        <h2 className="text-xs font-semibold">{chartRow.name} per month</h2>
        <ul className="mb-0.5 flex flex-wrap gap-x-4 text-[10px] text-fg-2">
          {names.map((name, c) => (
            <li key={name + c} className="flex items-center">
              <i aria-hidden className="mr-1 inline-block h-0.5 w-4 rounded" style={{ background: SERIES_STYLES[Math.min(c, SERIES_STYLES.length - 1)]!.color }} />
              {name}
            </li>
          ))}
        </ul>
        <CompareChart title={chartRow.name} months={comparison.months} series={names.map((name, c) => ({ name, values: chartRow.values[c]! }))} format={(v) => (chartRow.id === "profit" || chartRow.id === "mrr" ? formatCurrency(Math.round(v), p.currency) : formatNumber(v, 1))} fixedWidth={680} />
      </section>

      <section className="mt-2" data-print-time>
        <h2 className="text-xs font-semibold">Where the team&apos;s time goes over the run</h2>
        <ul className="flex flex-col gap-0.5">
          {names.map((name, c) => (
            <li key={name + c}>
              <span className="font-medium">{name}:</span>{" "}
              {comparison.time.rows
                .map((r, i) => ({ name: r.name, share: comparison.time.shares[c]?.[i] ?? 0 }))
                .filter((r) => r.share >= 0.005)
                .map((r) => `${r.name} ${formatPercent(r.share)}`)
                .join(", ") || "No hours."}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-2" data-print-changes>
        <h2 className="text-xs font-semibold">Changes and notes</h2>
        {changes.length === 0 ? (
          <p className="text-fg-2">No changes: the live model as it is.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {shownChanges.map(({ column, e, all }) => (
              <li key={column + e.change.id}>
                <span className="font-medium">{column}:</span> {describeChange(e.change, { ...p.ctx, changes: all })} <span className="text-fg-2">{whenOf(e.change) ?? "the whole run"}</span>
                {e.inherited ? <span className="text-fg-2"> (from {e.scenarioName})</span> : null}
                {e.change.note ? <span className="text-fg-2">. {e.change.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {changes.length > shownChanges.length ? <p className="text-fg-2">and {changes.length - shownChanges.length} more: see the changes CSV.</p> : null}
      </section>

      <footer className="mt-2 border-t border-line pt-1 text-[9px] text-fg-3">
        Every figure is an average of 30 simulated runs; the shaded band is the 10th to 90th percentile, so one run in ten is below it and one in ten above. All columns use the same random runs, so a difference comes from the changes. A simulation, not a forecast.
      </footer>
    </div>
  );
  return p.inline || !host ? page : createPortal(page, host);
}
