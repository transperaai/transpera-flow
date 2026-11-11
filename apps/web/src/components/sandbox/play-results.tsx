"use client";

// The free-play Sandbox's results, under the company map and the levers (D54, after capacity build P7; QA round 2 picks A1 and C1). In
// order: the verdict in a sentence and a flat strip of its figures (worst month, clients, profit, DLER, each against today's path), then clients, MRR
// and DLER by department side by side in an auto-fit grid over the horizon picked in the toolbar (12 to 60 months), each with how far this scene is ahead of today's path at the horizon, then who's overloaded and when (a team-by-month
// heatmap of the first year with a This scene / Today switch and its worst month named and outlined) and where the time goes (Today and This scene as
// stacked bars by purpose, with what moved). On today's path there is no change and no dashed copy. Goal seek and "What matters most" stay hidden (D33).

import { useMemo, useState, type ReactNode } from "react";
import { DLER_GOAL, DEFAULT_PURPOSES, type CapacitySetup, type PurposeCategory } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { BASELINE_COLOUR, categoricalColour, departmentColours, OTHER_COLOUR } from "@/lib/chart-colours";
import { formatCurrency, formatNumber } from "@/lib/format";
import { PLAY_HELP } from "@/lib/sandbox/play-help";
import { heatRows, purposeMoves, purposeSlices, signedCount, signedMoney, worstMonth, type WorstMonth } from "@/lib/sandbox/play-results-data";
import type { PlayRuns } from "@/lib/sandbox/use-play-runs";
import { KpiStrip, KpiTile } from "@/components/capacity/widgets";
import { Heatmap, type HeatView } from "./play-busy";
import { PlayChart, type PlayChartSeries } from "./play-chart";
import { MovedLine, PurposeBar, PurposeLegend } from "./play-donuts";
import { Segmented } from "./segmented";
import type { PlayHorizon, PlayMonths } from "./play-types";

/** The charts' grid: two or three side by side from about 1440px, one on a phone. */
const CHART_GRID = "grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-4";

/** The heatmap and its worst month cover the first year, whatever the horizon: past that a column a month is too narrow to read. */
const HEAT_MONTHS = 12;

export function PlayResults({
  runs,
  setup,
  months,
  moved,
  purposes = DEFAULT_PURPOSES,
  horizon = 12,
}: {
  runs: PlayRuns;
  setup: CapacitySetup;
  months: PlayMonths;
  moved: boolean;
  purposes?: readonly PurposeCategory[];
  horizon?: PlayHorizon;
}) {
  const { today, changed } = runs;
  const [view, setView] = useState<HeatView>("scene");
  const currency = setup.currency;
  const money = (v: number) => formatCurrency(v, currency);

  const todaySlices = useMemo(() => (today?.run.result.monthly ? purposeSlices(today.run.result.monthly, purposes) : []), [today, purposes]);
  const sceneSlices = useMemo(() => (changed?.run.result.monthly ? purposeSlices(changed.run.result.monthly, purposes) : []), [changed, purposes]);

  if (runs.status === "error") {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <div role="alert" data-run-error className="rounded-md border border-crit bg-crit-soft p-4 text-sm">
          The simulation could not run: {runs.error}
        </div>
      </div>
    );
  }
  if (!today || !changed) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <div role="status" aria-busy="true" data-running className="flex min-w-0 flex-col gap-3">
          <p className="text-sm text-muted-foreground">Working out today&apos;s path over the next {horizon} months…</p>
          <Skeleton className="h-[4.5rem] w-full rounded-xl" />
        </div>
        <div className={CHART_GRID} aria-hidden>
          {[0, 1, 2].map((i) => (
            <SectionCard key={i} id={`play-skeleton-${i}`} title={<Skeleton className="h-5 w-32" />} contentClassName="gap-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-40 w-full" />
            </SectionCard>
          ))}
        </div>
        <SectionCard id="play-overloaded" title="Who's overloaded, and when" contentClassName="gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-40 w-full" />
        </SectionCard>
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
  // A department keeps its slot on every chart (by name, lib/chart-colours.ts), whichever departments a chart shows.
  const deptColour = departmentColours(setup.departments);
  const pair = (now: { id: string; name: string; values: (number | null)[] }[], was: { id: string; values: (number | null)[] }[]): PlayChartSeries[] => [
    ...now.map((d) => ({ name: deptName.get(d.id) ?? d.name, values: d.values, color: deptColour.get(d.id) ?? OTHER_COLOUR })),
    ...(moved ? now.map((d) => ({ name: deptName.get(d.id) ?? d.name, values: was.find((w) => w.id === d.id)?.values ?? [], color: BASELINE_COLOUR, dashed: true })) : []),
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

  // The verdict's figures: the levers' path at the horizon, against today's path once something has moved.
  const sceneWorst = worstMonth(changed.outcome.people, heatN, teamName);
  const todayWorst = moved ? worstMonth(today.outcome.people, heatN, teamName) : undefined;
  const profitOf = (r: typeof changed) => r.run.result.monthly?.money?.profit[last]?.mean ?? null;
  const profitNow = profitOf(changed);
  const profitThen = profitOf(today);
  const monthName = (w: WorstMonth) => months.long[w.month] ?? `month ${w.month + 1}`;
  const atEnd = months.long[last] ?? `month ${n}`;

  return (
    <div className="@container flex min-w-0 flex-col gap-6" data-play-results aria-busy={busy || undefined}>
      <section aria-label="Verdict" className="flex min-w-0 flex-col gap-3" data-play-verdict-section>
        <div className="flex flex-col gap-1">
          <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase" data-run-status>
            {busy ? `Working it out (${runs.progress[0]} of ${runs.progress[1] || 1})…` : moved ? "This scene against today's path" : "Today's path"}
          </p>
          <p className="max-w-prose text-base text-fg [&_b]:font-semibold" data-play-summary>
            {sceneWorst ? (
              <>
                Worst month is <b>{monthName(sceneWorst)}</b>, with {sceneWorst.count} {sceneWorst.count === 1 ? "person" : "people"} over their utilisation threshold
                {todayWorst !== undefined && <> ({todayWorst ? `${todayWorst.count} in ${monthName(todayWorst)}` : "nobody"} on today&apos;s path)</>}.
              </>
            ) : (
              <>Nobody goes over their utilisation threshold in the next {heatN} months{todayWorst ? ` (${todayWorst.count} in ${monthName(todayWorst)} on today's path)` : ""}.</>
            )}{" "}
            By {atEnd}: <b>{formatNumber(clientsNow, 0)} clients</b>
            {moved && ` (${signedCount(clientsDelta)})`}
            {profitNow !== null ? (
              <>
                {" "}
                and <b>{money(profitNow)} profit</b> a month{moved && profitThen !== null && ` (${signedMoney(profitNow - profitThen, money)})`}.
              </>
            ) : (
              <>
                {" "}
                and <b>{money(retNow)} MRR</b>{moved && ` (${signedMoney(retDelta, money)})`}.
              </>
            )}
            {!moved && <span className="text-muted-foreground"> Move a lever or swap a process version to see a change.</span>}
          </p>
          {runs.problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground" data-play-problems>
              {runs.problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          )}
        </div>
        <KpiStrip data-play-kpis>
          <KpiTile
            data-play-kpi="worst"
            label="Worst month"
            value={sceneWorst ? monthName(sceneWorst) : "None"}
            edge={sceneWorst ? "crit" : "good"}
            sub={
              <>
                {sceneWorst ? `${sceneWorst.count} over their threshold` : "Nobody over their threshold"}
                {todayWorst !== undefined && ` · today: ${todayWorst ? monthName(todayWorst) : "none"}`}
              </>
            }
          />
          <KpiTile data-play-kpi="clients" label={`Clients by ${atEnd}`} value={formatNumber(clientsNow, 0)} sub={moved ? `${signedCount(clientsDelta)} against today's path` : "On today's path"} />
          {profitNow !== null ? (
            <KpiTile
              data-play-kpi="profit"
              label={`Profit in ${atEnd}`}
              value={money(profitNow)}
              edge={profitNow < 0 ? "crit" : undefined}
              sub={moved && profitThen !== null ? `${signedMoney(profitNow - profitThen, money)} a month against today's path` : "A month, on today's path"}
            />
          ) : (
            <KpiTile data-play-kpi="mrr" label={`MRR in ${atEnd}`} value={money(retNow)} sub={moved ? `${signedMoney(retDelta, money)} against today's path` : "On today's path"} />
          )}
          {dlerKnown && (
            <KpiTile
              data-play-kpi="dler"
              label={`DLER by ${atEnd}`}
              value={dlerNow == null ? "n/a" : formatNumber(dlerNow, 1)}
              edge={dlerNow == null ? undefined : dlerNow >= DLER_GOAL ? "good" : "warn"}
              sub={moved && dlerThen != null ? `From ${formatNumber(dlerThen, 1)} today · goal ${formatNumber(DLER_GOAL, 1)}` : `Goal ${formatNumber(DLER_GOAL, 1)}`}
            />
          )}
        </KpiStrip>
      </section>

      <div className={CHART_GRID} data-play-charts>
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
            series={[
              { name: "MRR", values: c.retainers, color: categoricalColour(0) },
              ...(moved ? [{ name: "MRR", values: t.retainers, color: BASELINE_COLOUR, dashed: true }] : []),
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
              <PlayChart title="DLER by department" months={monthNames} series={pair(c.dler, t.dler)} format={(v) => formatNumber(v, 1)} goal={{ value: DLER_GOAL, label: `Goal ${formatNumber(DLER_GOAL, 1)}` }} />
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

      <div className="grid min-w-0 items-start gap-4 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
    </div>
  );
}

function HeatSwitch({ view, onChange }: { view: HeatView; onChange: (v: HeatView) => void }) {
  return (
    <Segmented
      aria-label="Show"
      data-heat-switch=""
      value={view}
      onChange={onChange}
      options={(["scene", "today"] as const).map((k) => ({ value: k, label: k === "scene" ? "This scene" : "Today", attrs: { "data-heat-switch-option": k } }))}
    />
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
