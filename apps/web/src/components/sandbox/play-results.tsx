"use client";

// The free-play Sandbox's results, on the right (D54, after capacity build P7): charts, not words. In order: who's overloaded and when (a team-by-month
// heatmap with a This scene / Today switch, and paired bars of people over their line), clients, retainers a month and DLER by department against its goal
// (line charts, today's path dashed), and where the time goes (Today and This scene donuts by purpose, with what moved). Each card's header carries its one
// number with the change; on today's path there is no change and no dashed copy. Goal seek and "What matters most" stay hidden (D33).

import { useMemo, useState, type ReactNode } from "react";
import { DLER_GOAL, DEFAULT_PURPOSES, overByMonth, type CapacitySetup, type PurposeCategory } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/format";
import { PLAY_HELP } from "@/lib/sandbox/play-help";
import { heatRows, purposeMoves, purposeSlices, signedCount, signedMoney } from "@/lib/sandbox/play-results-data";
import type { PlayRuns } from "@/lib/sandbox/use-play-runs";
import { cn } from "@/lib/utils";
import { Heatmap, OverBars, type HeatView } from "./play-busy";
import { PlayChart, type PlayChartSeries } from "./play-chart";
import { Donut, MovedLine, PurposeLegend } from "./play-donuts";
import type { PlayMonths } from "./play-types";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function PlayResults({ runs, setup, months, moved, purposes = DEFAULT_PURPOSES }: { runs: PlayRuns; setup: CapacitySetup; months: PlayMonths; moved: boolean; purposes?: readonly PurposeCategory[] }) {
  const { today, changed } = runs;
  const [view, setView] = useState<HeatView>("scene");
  const currency = setup.currency;
  const money = (v: number) => formatCurrency(v, currency);

  const todaySlices = useMemo(() => (today?.run.result.monthly ? purposeSlices(today.run.result.monthly, purposes) : []), [today, purposes]);
  const sceneSlices = useMemo(() => (changed?.run.result.monthly ? purposeSlices(changed.run.result.monthly, purposes) : []), [changed, purposes]);

  if (runs.status === "error") {
    return (
      <div role="alert" data-run-error className="rounded-token border border-crit bg-crit-soft p-4 text-sm">
        The simulation could not run: {runs.error}
      </div>
    );
  }
  if (!today || !changed) {
    return (
      <div role="status" aria-busy="true" data-running className="flex min-w-0 flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Working out today&apos;s path over the next 12 months…
        </p>
        <SectionCard id="play-overloaded" title="Who's overloaded, and when" contentClassName="gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-40 w-full" />
        </SectionCard>
        <div className="grid min-w-0 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <SectionCard key={i} id={`play-skeleton-${i}`} title="Loading…" contentClassName="gap-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </SectionCard>
          ))}
        </div>
      </div>
    );
  }

  const busy = runs.status === "running";
  const c = changed.outcome.charts;
  const t = today.outcome.charts;
  const n = changed.outcome.clients.length;
  const last = n - 1;
  const monthNames = Array.from({ length: n }, (_, i) => months.short[i] ?? `Month ${i + 1}`);
  const by = `by month ${n}`;
  const deptName = new Map(setup.departments.map((d) => [d.id, d.name]));
  const pair = (now: { id: string; name: string; values: (number | null)[] }[], was: { id: string; values: (number | null)[] }[]): PlayChartSeries[] => [
    ...now.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: COLORS[i % 5]! })),
    ...(moved ? now.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: was.find((w) => w.id === d.id)?.values ?? [], color: COLORS[i % 5]!, dashed: true })) : []),
  ];

  // Who's overloaded.
  const overScene = overByMonth(changed.outcome.people, n);
  const overToday = overByMonth(today.outcome.people, n);
  const worst = Math.max(0, ...overScene);
  const worstToday = Math.max(0, ...overToday);
  const rows = heatRows(c.teams, view === "scene" || !moved ? c.teams : t.teams);
  const heatLabel = moved && view === "today" ? "today's path" : "this scene";

  // Clients, MRR, DLER.
  const clientsNow = changed.outcome.clients[last] ?? 0;
  const clientsDelta = clientsNow - (today.outcome.clients[last] ?? 0);
  const retNow = changed.outcome.retainers[last] ?? 0;
  const retDelta = retNow - (today.outcome.retainers[last] ?? 0);
  const dlerNow = c.dlerWhole[last] ?? null;
  const dlerThen = t.dlerWhole[last] ?? null;
  const dlerKnown = c.dlerWhole.some((v) => v !== null);
  const lostNow = c.lostToPrice;
  const lostThen = t.lostToPrice;

  // Where the time goes.
  const order = [...sceneSlices, ...todaySlices].map((s) => s.id).filter((id, i, all) => all.indexOf(id) === i);
  const moves = purposeMoves(todaySlices, sceneSlices);

  return (
    <div className="@container flex min-w-0 flex-col gap-4" data-play-results aria-busy={busy || undefined}>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground" data-run-status>
          {busy ? `Working it out (${runs.progress[0]} of ${runs.progress[1] || 1})…` : moved ? "This scene against today's path" : "Today's path. Move a lever or swap a block to see a change."}
        </p>
        {runs.problems.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-muted-foreground" data-play-problems>
            {runs.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        )}
      </div>

      <SectionCard
        id="play-overloaded"
        title={
          <span className="inline-flex items-center">
            Who&apos;s overloaded, and when
            <Help {...PLAY_HELP.overloaded} />
          </span>
        }
        action={moved ? <HeatSwitch view={view} onChange={setView} /> : undefined}
        contentClassName="gap-3"
      >
        <Header data-chart-header="worst">
          Worst month: {worst} {worst === 1 ? "person" : "people"} over their utilisation threshold{moved && <Change> ({worstToday} today)</Change>}
        </Header>
        <Heatmap rows={rows} months={monthNames} view={moved ? view : "today"} />
        <p className="sr-only" data-heat-shows>
          Showing {heatLabel}
        </p>
        <OverBars months={monthNames} today={overToday} scene={moved ? overScene : null} />
      </SectionCard>

      <div className="grid min-w-0 gap-4 @2xl:grid-cols-3" data-play-charts>
        <ChartCard title="Clients by department" help={PLAY_HELP.clients}>
          <Header data-chart-header="clients">
            {formatNumber(clientsNow, 0)} clients {by}
            {moved && <Change> ({signedCount(clientsDelta)})</Change>}
          </Header>
          <PlayChart
            title="Clients by department"
            months={monthNames}
            series={pair(c.clients, t.clients)}
            format={(v) => formatNumber(v, 0)}
            narrow
            tipExtra={(i) => (
              <div className="mt-0.5 border-t border-line pt-1 text-muted-foreground tabular-nums" data-tip-won-lost>
                Won {formatNumber(c.won[i] ?? 0, 1)} · Lost {formatNumber(c.lost[i] ?? 0, 1)}
              </div>
            )}
          />
          {(lostNow > 0.05 || lostThen > 0.05) && (
            <p className="text-xs" data-price-loss>
              <span className="font-semibold">Clients lost to the price rise: {formatNumber(lostNow, 1)}</span>
              <span className="text-muted-foreground"> over the year ({formatNumber(lostThen, 1)} on today&apos;s path).</span>
            </p>
          )}
        </ChartCard>
        <ChartCard title="MRR" help={PLAY_HELP.retainers}>
          <Header data-chart-header="retainers">
            {money(retNow)} MRR
            {moved && <Change> ({signedMoney(retDelta, money)})</Change>}
          </Header>
          <PlayChart
            title="MRR"
            months={monthNames}
            format={money}
            narrow
            series={[
              { name: "MRR", values: c.retainers, color: "var(--accent)" },
              ...(moved ? [{ name: "MRR", values: t.retainers, color: "var(--accent)", dashed: true }] : []),
            ]}
          />
        </ChartCard>
        <ChartCard title="DLER by department" help={PLAY_HELP.dler}>
          {dlerKnown ? (
            <>
              <Header data-chart-header="dler">
                DLER {dlerNow == null ? "n/a" : formatNumber(dlerNow, 1)} {by}
                {moved && dlerThen != null && <Change> ({formatNumber(dlerThen, 1)} today)</Change>}
              </Header>
              <PlayChart title="DLER by department" months={monthNames} series={pair(c.dler, t.dler)} format={(v) => formatNumber(v, 1)} goal={{ value: DLER_GOAL, label: `Goal ${formatNumber(DLER_GOAL, 1)}` }} narrow />
            </>
          ) : (
            <EmptyState data-dler-hidden>DLER needs the salaries, which your role can&apos;t see.</EmptyState>
          )}
        </ChartCard>
      </div>

      <SectionCard
        id="play-time"
        title={
          <span className="inline-flex items-center">
            Where the time goes
            <Help {...PLAY_HELP.time} />
          </span>
        }
        contentClassName="gap-3"
      >
        <PurposeLegend slices={todaySlices.filter((s) => order.includes(s.id))} />
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4" data-play-time>
          <div className={cn("grid min-w-0 flex-1 gap-4", moved ? "grid-cols-2" : "max-w-48 grid-cols-1")}>
            <Donut title="Today" slices={todaySlices} order={order} />
            {moved && <Donut title="This scene" slices={sceneSlices} order={order} />}
          </div>
          {moved && (
            <div className="min-w-48 flex-1">
              <MovedLine moves={moves} />
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

function HeatSwitch({ view, onChange }: { view: HeatView; onChange: (v: HeatView) => void }) {
  return (
    <div role="group" aria-label="Show" data-heat-switch className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
      {(["scene", "today"] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={view === k}
          data-heat-switch-option={k}
          onClick={() => onChange(k)}
          className={cn("rounded-md px-2.5 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", view === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {k === "scene" ? "This scene" : "Today"}
        </button>
      ))}
    </div>
  );
}

function Header({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <p className="text-base font-semibold tabular-nums" {...rest}>
      {children}
    </p>
  );
}

function Change({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}

function ChartCard({ title, help, children }: { title: string; help: Parameters<typeof Help>[0]; children: ReactNode }) {
  return (
    <div className="min-w-0" data-play-card={title}>
      <SectionCard
        id={`play-card-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        title={
          <span className="inline-flex items-center">
            {title}
            <Help {...help} />
          </span>
        }
        className="h-full"
        contentClassName="gap-2"
      >
        {children}
      </SectionCard>
    </div>
  );
}
