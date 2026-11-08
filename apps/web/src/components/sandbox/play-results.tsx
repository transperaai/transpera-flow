"use client";

// The free-play Sandbox's results, on the right (D54, after capacity build P7; QA round 2 picks A1, B1, C1): charts, not words. In order: who's
// overloaded and when (a team-by-month heatmap of the first year with a This scene / Today switch and its worst month named and outlined), then, under
// one "how far ahead" filter (12 to 60 months), clients, MRR and DLER by department, each on a row of its own with how far this scene is ahead of
// today's path at the horizon, and where the time goes (Today and This scene as stacked bars by purpose, with what moved). Each card's header carries its
// one number with the change; on today's path there is no change and no dashed copy. Goal seek and "What matters most" stay hidden (D33).

import { useMemo, useState, type ReactNode } from "react";
import { DLER_GOAL, DEFAULT_PURPOSES, type CapacitySetup, type PurposeCategory } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/format";
import { PLAY_HELP } from "@/lib/sandbox/play-help";
import { heatRows, purposeMoves, purposeSlices, signedCount, signedMoney, worstMonth, type WorstMonth } from "@/lib/sandbox/play-results-data";
import type { PlayRuns } from "@/lib/sandbox/use-play-runs";
import { cn } from "@/lib/utils";
import { Heatmap, type HeatView } from "./play-busy";
import { PlayChart, type PlayChartSeries } from "./play-chart";
import { MovedLine, PurposeBar, PurposeLegend } from "./play-donuts";
import { PLAY_HORIZONS, type PlayHorizon, type PlayMonths } from "./play-types";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

/** The heatmap and its worst month cover the first year, whatever the horizon: past that a column a month is too narrow to read. */
const HEAT_MONTHS = 12;

export function PlayResults({
  runs,
  setup,
  months,
  moved,
  purposes = DEFAULT_PURPOSES,
  horizon = 12,
  onHorizon,
}: {
  runs: PlayRuns;
  setup: CapacitySetup;
  months: PlayMonths;
  moved: boolean;
  purposes?: readonly PurposeCategory[];
  horizon?: PlayHorizon;
  onHorizon?: (h: PlayHorizon) => void;
}) {
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
          Working out today&apos;s path over the next {horizon} months…
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
  const by = `by ${months.long[last] ?? `month ${n}`}`;
  const deptName = new Map(setup.departments.map((d) => [d.id, d.name]));
  const pair = (now: { id: string; name: string; values: (number | null)[] }[], was: { id: string; values: (number | null)[] }[]): PlayChartSeries[] => [
    ...now.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: COLORS[i % 5]! })),
    ...(moved ? now.map((d, i) => ({ name: deptName.get(d.id) ?? d.name, values: was.find((w) => w.id === d.id)?.values ?? [], color: COLORS[i % 5]!, dashed: true })) : []),
  ];

  // Who's overloaded, over the first year.
  const heatN = Math.min(HEAT_MONTHS, n);
  const teamName = (id: string) => setup.roles.find((r) => r.id === id)?.name;
  const showToday = moved && view === "today";
  const worst = worstMonth(showToday ? today.outcome.people : changed.outcome.people, heatN, teamName);
  // The other run's worst month, for comparison: only once something has changed (on today's path both runs are the same).
  const worstOther = moved ? worstMonth(showToday ? changed.outcome.people : today.outcome.people, heatN, teamName) : undefined;
  const first = (rs: typeof c.teams) => rs.map((tm) => ({ ...tm, values: tm.values.slice(0, heatN), p90: tm.p90.slice(0, heatN) }));
  const rows = heatRows(first(c.teams), first(view === "scene" || !moved ? c.teams : t.teams));
  const heatLabel = showToday ? "today's path" : "this scene";

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
  // Is the change worth it: MRR added over the horizon, month by month, against today's path.
  const mrrAdded = changed.outcome.retainers.reduce((sum, v, i) => sum + v - (today.outcome.retainers[i] ?? 0), 0);
  const atGoal = (lines: { values: (number | null)[] }[]) => lines.filter((l) => (l.values[last] ?? 0) >= DLER_GOAL).length;

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
        <WorstLine worst={worst} other={worstOther} months={months.long} otherLabel={showToday ? "this scene" : "today's path"} />
        <Heatmap rows={rows} months={monthNames.slice(0, heatN)} view={moved ? view : "today"} worst={worst?.month ?? null} />
        <p className="sr-only" data-heat-shows>
          Showing {heatLabel}, the next {heatN} months
        </p>
      </SectionCard>

      <div className="flex min-w-0 flex-wrap items-center gap-2" data-play-horizon>
        <span className="text-sm text-muted-foreground" id="play-horizon-label">
          Show the next
        </span>
        <div role="group" aria-labelledby="play-horizon-label" className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
          {PLAY_HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={horizon === h}
              data-play-horizon-option={h}
              disabled={!onHorizon || busy}
              onClick={() => onHorizon?.(h)}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                horizon === h ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {h}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground">months</span>
        <Help {...PLAY_HELP.horizon} />
      </div>

      <div className="flex min-w-0 flex-col gap-4" data-play-charts>
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
            full
            tipExtra={(i) => (
              <div className="mt-0.5 border-t border-line pt-1 text-muted-foreground tabular-nums" data-tip-won-lost>
                Won {formatNumber(c.won[i] ?? 0, 1)} · Lost {formatNumber(c.lost[i] ?? 0, 1)}
              </div>
            )}
          />
          {(lostNow > 0.05 || lostThen > 0.05) && (
            <p className="text-xs" data-price-loss>
              <span className="font-semibold">Clients lost to the price rise: {formatNumber(lostNow, 1)}</span>
              <span className="text-muted-foreground"> over the {n} months ({formatNumber(lostThen, 1)} on today&apos;s path).</span>
            </p>
          )}
          {moved && (
            <Payoff data-payoff="clients">
              {clientsDelta >= 0 ? "Ahead of" : "Behind"} today&apos;s path by <b>{formatNumber(Math.abs(clientsDelta), 0)} clients</b> at {n} months.
            </Payoff>
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
            full
            series={[
              { name: "MRR", values: c.retainers, color: "var(--accent)" },
              ...(moved ? [{ name: "MRR", values: t.retainers, color: "var(--accent)", dashed: true }] : []),
            ]}
          />
          {moved && (
            <Payoff data-payoff="mrr">
              <span>
                MRR at {n} months: <b>{signedMoney(retDelta, money)} a month</b> on today&apos;s path.
              </span>{" "}
              <span>
                Added over the {n} months: <b>{signedMoney(mrrAdded, money)}</b>.
              </span>
            </Payoff>
          )}
        </ChartCard>
        <ChartCard title="DLER by department" help={PLAY_HELP.dler}>
          {dlerKnown ? (
            <>
              <Header data-chart-header="dler">
                DLER {dlerNow == null ? "n/a" : formatNumber(dlerNow, 1)} {by}
                {moved && dlerThen != null && <Change> ({formatNumber(dlerThen, 1)} today)</Change>}
              </Header>
              <PlayChart title="DLER by department" months={monthNames} series={pair(c.dler, t.dler)} format={(v) => formatNumber(v, 1)} goal={{ value: DLER_GOAL, label: `Goal ${formatNumber(DLER_GOAL, 1)}` }} full />
              {moved && (
                <Payoff data-payoff="dler">
                  Departments at the {formatNumber(DLER_GOAL, 1)} goal at {n} months: <b>{atGoal(c.dler)} of {c.dler.length}</b> ({atGoal(t.dler)} on today&apos;s path).
                </Payoff>
              )}
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
        <div className="flex min-w-0 flex-col gap-2" data-play-time>
          <PurposeBar title="Today" slices={todaySlices} order={order} strong={!moved} />
          {moved && <PurposeBar title="This scene" slices={sceneSlices} order={order} strong />}
        </div>
        <PurposeLegend slices={todaySlices.filter((s) => order.includes(s.id))} />
        <p className="text-xs text-muted-foreground tabular-nums" data-time-total>
          {formatNumber(hoursOf(todaySlices), 0)}
          {moved && <> → {formatNumber(hoursOf(sceneSlices), 0)}</>} working hours a month, on average over the next {n} months.
        </p>
        {moved && <MovedLine moves={moves} />}
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

const hoursOf = (slices: readonly { hours: number }[]) => slices.reduce((a, s) => a + s.hours, 0);

/** The worst month of the heatmap's year in one line (option A1): when, how many people over their threshold, which teams, and the other run's worst. */
function WorstLine({ worst, other, months, otherLabel }: { worst: WorstMonth | null; other: WorstMonth | null | undefined; months: string[]; otherLabel: string }) {
  const name = (w: WorstMonth) => months[w.month] ?? `month ${w.month + 1}`;
  if (!worst)
    return (
      <p className="text-base font-semibold" data-chart-header="worst">
        Nobody goes over their utilisation threshold in the next 12 months
        {other && <Change> ({otherLabel}: {other.count} in {name(other)})</Change>}
      </p>
    );
  return (
    <div className="flex flex-col gap-0.5 rounded-r-md border-l-[3px] border-crit bg-crit-soft px-3 py-2" data-chart-header="worst" data-worst-month={worst.month}>
      <p className="text-base font-semibold tabular-nums">
        Worst month: {name(worst)} · {worst.count} {worst.count === 1 ? "person" : "people"} over their utilisation threshold
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">
        {worst.teams.map((tm) => `${tm.name} ${tm.count}`).join(", ")}
        {other !== undefined && ` · ${otherLabel}: ${other ? `${other.count} in ${name(other)}` : "nobody over"}`}
      </p>
    </div>
  );
}

function Payoff({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <p className="text-sm text-fg-2 [&_b]:font-semibold [&_b]:text-fg [&_b]:tabular-nums" {...rest}>
      {children}
    </p>
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
