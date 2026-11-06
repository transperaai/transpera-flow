"use client";

// The free-play Sandbox's results, on the right (capacity build P7, brief section 4): "What happens" (the verdict, with today's path against this one) and
// four charts against today's path (dashed): clients by department, retainers a month, DLER by department with the 4.5 goal line, and the busy share of the
// five busiest teams with their lines. Goal seek and "What matters most" stay hidden (D33).

import { useMemo } from "react";
import { DLER_GOAL, verdict, type CapacitySetup, type VerdictLine } from "@transpera-flow/db";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import type { PlayRuns } from "@/lib/sandbox/use-play-runs";
import { cn } from "@/lib/utils";
import { PlayChart, type PlayChartSeries } from "./play-chart";
import type { PlayMonths } from "./play-types";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function PlayVerdict({ lines }: { lines: VerdictLine[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm" data-verdict-lines>
      {lines.map((line, i) => (
        <li key={i} data-verdict-line={i}>
          {line.map((seg, j) => (
            <span key={j} className={cn(seg.bold && "font-semibold", seg.tone === "flag" && "font-medium text-crit", seg.tone === "ok" && "font-medium text-good")}>
              {seg.text}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function PlayResults({ runs, setup, months, moved }: { runs: PlayRuns; setup: CapacitySetup; months: PlayMonths; moved: boolean }) {
  const { today, changed } = runs;
  const currency = setup.currency;
  const lines = useMemo(() => (today && changed ? verdict(today.outcome, changed.outcome, { monthNames: months.short, money: (v) => formatCurrency(v, currency) }) : null), [today, changed, months.short, currency]);

  if (runs.status === "error") {
    return (
      <div role="alert" data-run-error className="rounded-token border border-crit bg-crit-soft p-4 text-sm">
        The simulation could not run: {runs.error}
      </div>
    );
  }
  if (!today || !changed || !lines) {
    return (
      <div role="status" aria-busy="true" data-running>
        <SectionCard id="play-verdict" title="What happens" description="Working out today's path over the next 12 months…">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-40 w-full" />
        </SectionCard>
      </div>
    );
  }

  const busy = runs.status === "running";
  const c = changed.outcome.charts;
  const t = today.outcome.charts;
  const deptName = new Map(setup.departments.map((d) => [d.id, d.name]));
  const clientSeries: PlayChartSeries[] = [
    ...c.clients.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: COLORS[i % 5]! })),
    ...t.clients.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: COLORS[i % 5]!, dashed: true })),
  ];
  const dlerKnown = c.dlerWhole.some((v) => v !== null);
  const dlerSeries: PlayChartSeries[] = [
    ...c.dler.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: COLORS[i % 5]! })),
    ...t.dler.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: COLORS[i % 5]!, dashed: true })),
  ];
  const teams = c.teams.slice(0, 5);
  const teamSeries: PlayChartSeries[] = [
    ...teams.map((x, i) => ({ name: x.name, values: x.values, color: COLORS[i % 5]!, line: x.line })),
    ...teams.map((x, i) => ({ name: x.name, values: t.teams.find((y) => y.id === x.id)?.values ?? [], color: COLORS[i % 5]!, dashed: true })),
  ];
  const money = (v: number) => formatCurrency(v, currency);
  const lostNow = c.lostToPrice;
  const lostThen = t.lostToPrice;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-play-results aria-busy={busy || undefined}>
      <div data-verdict>
        <SectionCard
          id="play-verdict"
          title="What happens"
          description={
            <span data-run-status>
              {busy ? `Working it out (${runs.progress[0]} of ${runs.progress[1] || 1})…` : moved ? "This path against today's path" : "Today's path. Move a lever or swap a block to see a change."}
            </span>
          }
          contentClassName="gap-3"
        >
          <PlayVerdict lines={lines} />
          {(lostNow > 0.05 || lostThen > 0.05) && (
            <p className="text-sm" data-price-loss>
              <span className="font-semibold">Clients lost to the price rise: {formatNumber(lostNow, 1)}</span>
              <span className="text-muted-foreground"> over the year ({formatNumber(lostThen, 1)} on today&apos;s path).</span>
            </p>
          )}
          {runs.problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground" data-play-problems>
              {runs.problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="grid min-w-0 gap-4 md:grid-cols-2" data-play-charts>
        <ChartCard title="Clients">
          <PlayChart title="Clients by department" months={months.short} series={clientSeries} format={(v) => formatNumber(v, 0)} />
        </ChartCard>
        <ChartCard title="Retainers a month">
          <PlayChart
            title="Retainers a month"
            months={months.short}
            format={money}
            series={[
              { name: "This path", values: c.retainers, color: "var(--accent)" },
              { name: "Today's path", values: t.retainers, color: "var(--accent)", dashed: true },
            ]}
          />
        </ChartCard>
        <ChartCard title="DLER">
          {dlerKnown ? (
            <PlayChart title="DLER by department" months={months.short} series={dlerSeries} format={(v) => formatNumber(v, 1)} goal={{ value: DLER_GOAL, label: `Goal ${formatNumber(DLER_GOAL, 1)}` }} />
          ) : (
            <EmptyState data-dler-hidden>DLER needs the salaries, which your role can&apos;t see.</EmptyState>
          )}
        </ChartCard>
        <ChartCard title="How busy each team is">
          <PlayChart title="Busy share of the five busiest teams" months={months.short} series={teamSeries} format={(v) => formatPercent(v)} min={0} />
        </ChartCard>
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0" data-play-card={title}>
      <SectionCard id={`play-card-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} title={title} className="h-full" contentClassName="gap-2">
        {children}
      </SectionCard>
    </div>
  );
}
