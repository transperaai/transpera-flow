"use client";

// Compare two plans (B7, issue #36): monthly recurring revenue, clients at risk per client group and how busy each role
// gets, for plan A and plan B side by side, with each plan's average and 10-90% range and the difference of the averages.
// "No changes" is the live model and counts as a plan. Both plans run with the same seed, so a difference comes from the
// plans, not from chance.

import { useMemo } from "react";
import type { ForecastPlanMarker, ForecastPlanRow, ProcessBundle, SolutionRow } from "@transpera-flow/db";
import type { Stat } from "@transpera-flow/engine";
import { Help, type HelpProps } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { comparePlans, type CompareRow } from "@/lib/forecast/compare";
import { PLAN_HELP } from "@/lib/forecast/help";
import { usePlanForecast } from "@/lib/forecast/use-plan-forecast";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { PlanCompareChart } from "./plan-compare-chart";

/** The id of "No changes" in `?compare=a,b`. */
export const COMPARE_LIVE = "live";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const NO_MARKERS: ForecastPlanMarker[] = [];

const signed = (v: number, text: (abs: number) => string) => (Math.abs(v) < 1e-9 ? text(0) : `${v > 0 ? "+" : "−"}${text(Math.abs(v))}`);

export interface PlanCompareProps {
  live: ProcessBundle;
  startDate: string;
  months: number;
  plans: ForecastPlanRow[];
  solutions: SolutionRow[];
  /** Each a saved plan's id or "live". */
  ids: [string, string];
  cutoffs: readonly [number, number, number];
  onChange: (ids: [string, string]) => void;
  onBack: () => void;
}

export function PlanCompare({ live, startDate, months, plans, solutions, ids, cutoffs, onChange, onBack }: PlanCompareProps) {
  const planOf = (id: string) => (id === COMPARE_LIVE ? null : (plans.find((p) => p.id === id) ?? null));
  const a = planOf(ids[0]);
  const b = planOf(ids[1]);
  const nameA = a?.name ?? "No changes";
  const nameB = b?.name ?? "No changes";
  const same = ids[0] === ids[1];
  const runA = usePlanForecast({ bundle: live, markers: a ? a.markers : NO_MARKERS, solutions, months, startDate });
  const runB = usePlanForecast({ bundle: live, markers: b ? b.markers : NO_MARKERS, solutions, months, startDate });
  const currency = live.workspace.settings.currency;
  const money = (v: number) => formatCurrency(v, currency);
  const comparison = useMemo(
    () => (runA.run && runB.run && runA.status === "done" && runB.status === "done" ? comparePlans(runA.run.model, runA.run.result.monthly!, runB.run.result.monthly!, live, startDate, cutoffs) : null),
    [runA.run, runB.run, runA.status, runB.status, live, startDate, cutoffs],
  );
  const error = runA.error ?? runB.error;
  const running = runA.status === "running" || runB.status === "running";
  const last = comparison ? comparison.months[comparison.months.length - 1]!.long : "";

  const picker = (label: "Plan A" | "Plan B", index: 0 | 1, help: HelpProps) => (
    <label className="flex min-w-[12rem] flex-col gap-0.5">
      <span className="flex items-center text-xs font-medium text-fg-2">
        {label}
        <Help {...help} />
      </span>
      <NativeSelect
        aria-label={label}
        value={ids[index]}
        onChange={(e) => onChange(index === 0 ? [e.target.value, ids[1]] : [ids[0], e.target.value])}
        data-compare-pick={label}
      >
        <option value={COMPARE_LIVE}>No changes</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <section className="flex min-w-0 flex-col gap-4" data-forecast-compare data-compare-status={same ? "same" : running ? "running" : error ? "error" : "done"}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={SECTION_TITLE}>Compare plans</h2>
          <p className="text-sm text-muted-foreground">Recurring revenue, clients at risk and how busy each role gets, plan A against plan B, with the 10–90% range from 30 runs.</p>
        </div>
        <Button variant="outline" onClick={onBack}>
          Back to the plan
        </Button>
      </div>

      <Card className="gap-3 px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          {picker("Plan A", 0, PLAN_HELP.planA)}
          {picker("Plan B", 1, PLAN_HELP.planB)}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" data-compare-legend>
            <span className="inline-flex items-center gap-1.5">
              <i aria-hidden className="h-0.5 w-5 rounded bg-accent" />
              Plan A: {nameA}
              <i aria-hidden className="ml-1 h-2.5 w-4 rounded-sm bg-accent/20" />
              10–90%
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i aria-hidden className="w-5 border-t-2 border-dashed border-edit" />
              Plan B: {nameB}
              <i aria-hidden className="ml-1 h-2.5 w-4 rounded-sm bg-edit/15" />
              10–90%
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite" data-compare-progress>
          {same
            ? "Pick two different plans."
            : error
              ? `A plan couldn't be worked out: ${error}`
              : running
                ? `Running plan ${runA.status === "running" ? "A" : "B"}…`
                : comparison
                  ? "Both plans run with the same random runs, so a difference comes from the plans."
                  : ""}
        </p>
      </Card>

      {same ? null : comparison ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-compare-tiles>
            <Tile title={`Recurring revenue in ${last}`} a={money(comparison.totals.mrr[0])} b={money(comparison.totals.mrr[1])} diff={signed(comparison.totals.mrr[1] - comparison.totals.mrr[0], money)} nameA={nameA} nameB={nameB} />
            {comparison.totals.atRisk ? (
              <Tile
                title={`Clients at risk in ${last}`}
                a={formatNumber(comparison.totals.atRisk[0], 1)}
                b={formatNumber(comparison.totals.atRisk[1], 1)}
                diff={signed(comparison.totals.atRisk[1] - comparison.totals.atRisk[0], (v) => formatNumber(v, 1))}
                nameA={nameA}
                nameB={nameB}
              />
            ) : (
              <Tile title={`Clients at risk in ${last}`} a="—" b="—" diff="—" note="Needs clients counted per service" nameA={nameA} nameB={nameB} />
            )}
            <Tile
              title="Months a role is too busy"
              a={String(comparison.totals.tooBusyMonths[0])}
              b={String(comparison.totals.tooBusyMonths[1])}
              diff={signed(comparison.totals.tooBusyMonths[1] - comparison.totals.tooBusyMonths[0], (v) => String(v))}
              nameA={nameA}
              nameB={nameB}
            />
          </div>

          <Section title="Monthly recurring revenue" help={PLAN_HELP.revenue}>
            <ChartAndNumbers row={comparison.mrr} months={comparison.months} nameA={nameA} nameB={nameB} format={money} formatDiff={(v) => signed(v, money)} />
          </Section>

          <Section title="Clients at risk, by group" help={PLAN_HELP.atRisk}>
            {comparison.atRisk.length ? (
              comparison.atRisk.map((row) => (
                <ChartAndNumbers key={row.id} row={row} months={comparison.months} nameA={nameA} nameB={nameB} format={(v) => formatNumber(v, 1)} formatDiff={(v) => signed(v, (x) => formatNumber(x, 1))} />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Needs clients counted per service (Settings, Clients).</p>
            )}
          </Section>

          <Section title="How busy each role gets" help={PLAN_HELP.busy}>
            {comparison.roles.map((row) => (
              <ChartAndNumbers
                key={row.id}
                row={row}
                months={comparison.months}
                nameA={nameA}
                nameB={nameB}
                format={formatPercent}
                formatDiff={(v) => signed(v, (x) => `${Math.round(x * 100)} points`)}
                reference={{ value: cutoffs[1], label: `${formatPercent(cutoffs[1])} “Too busy” line` }}
                minTop={1}
              />
            ))}
          </Section>
        </>
      ) : error || same ? null : (
        <Skeleton className="h-[320px] w-full" aria-busy="true" />
      )}
    </section>
  );
}

function Tile({ title, a, b, diff, note, nameA, nameB }: { title: string; a: string; b: string; diff: string; note?: string; nameA: string; nameB: string }) {
  return (
    <Card className="gap-1 px-4 py-3" data-compare-tile={title}>
      <h3 className="text-xs font-medium text-fg-2">{title}</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm tabular-nums">
        <dt className="truncate text-muted-foreground">{nameA}</dt>
        <dd className="text-right font-semibold">{a}</dd>
        <dt className="truncate text-muted-foreground">{nameB}</dt>
        <dd className="text-right font-semibold">{b}</dd>
        <dt className="text-muted-foreground">B − A</dt>
        <dd className="text-right font-semibold">{diff}</dd>
      </dl>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </Card>
  );
}

function Section({ title, help, children }: { title: string; help: HelpProps; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" data-compare-section={title}>
      <h2 className={`${SECTION_TITLE} flex items-center`}>
        {title}
        <Help {...help} />
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function ChartAndNumbers({
  row,
  months,
  nameA,
  nameB,
  format,
  formatDiff,
  reference,
  minTop,
}: {
  row: CompareRow;
  months: { index: number; long: string; short: string; name: string }[];
  nameA: string;
  nameB: string;
  format: (v: number) => string;
  formatDiff: (v: number) => string;
  reference?: { value: number; label: string };
  minTop?: number;
}) {
  const cell = (s: Stat | null) => (s ? `${format(s.mean)} (${format(s.p10)}–${format(s.p90)})` : "—");
  return (
    <Card className="gap-2 px-4 py-4" data-compare-row={row.id}>
      <h3 className="text-sm font-medium">{row.name}</h3>
      <PlanCompareChart title={row.name} months={months} a={row.a} b={row.b} nameA={nameA} nameB={nameB} format={format} formatDiff={formatDiff} reference={reference} minTop={minTop} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Show the numbers</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs tabular-nums" data-compare-table={row.id}>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Month
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Plan A (10–90%)
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Plan B (10–90%)
                </th>
                <th scope="col" className="py-1 font-medium">
                  <span className="inline-flex items-center">
                    Difference (B − A)
                    <Help {...PLAN_HELP.difference} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((mo, i) => (
                <tr key={mo.index} className="border-t border-line">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {mo.long}
                  </th>
                  <td className="py-1 pr-3">{cell(row.a[i] ?? null)}</td>
                  <td className="py-1 pr-3">{cell(row.b[i] ?? null)}</td>
                  <td className="py-1">{row.diff[i] === null || row.diff[i] === undefined ? "—" : formatDiff(row.diff[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
