"use client";

// The Solution page's comparison (issue #115, A50 slice 2; prototype: route "compare"): the two maps side by side, the measures,
// the monthly recurring revenue chart and the market stress test. The simulations run in Web Workers (the page's own simulation,
// the projection and the stress test each have one), so the page stays responsive and each part fills in when it is ready.

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { compareRuns, compareTable } from "@transpera-flow/engine";
import { toEngineModel, type IssueRow, type MarketConditionRow, type ProcessBundle, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { HorizonPicker } from "@/components/horizon-picker";
import { MrrChart } from "@/components/overview/charts";
import { useEngineModel } from "@/components/process-view";
import { VerdictWord } from "@/components/solutions/solution-cards";
import { Card } from "@/components/ui/card";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { Skeleton } from "@/components/ui/skeleton";
import { horizonWeeks, monthsForWeeks } from "@/lib/horizon";
import { checkpointMonths, checkpointWeeks, mrrSeries } from "@/lib/overview/projection";
import { useProjection } from "@/lib/overview/use-projection";
import { formatCurrency } from "@/lib/format";
import { MoneyHidden } from "@/components/money-hidden";
import { useShareFinancialsHidden } from "@/components/share/share-context";
import { useSimulation } from "@/lib/sim/use-simulation";
import { SCHEDULE_KEY, compareMaps, overallResult, pinProblems, stressConditions, stressTargets, toneWord } from "@/lib/solutions/compare";
import { SOLUTION_PAGE_HELP } from "@/lib/solutions/help";
import { withLeverChanges } from "@/lib/solutions/levers";
import { useStress } from "@/lib/solutions/use-stress";
import { cn } from "@/lib/utils";

// The map is heavy: load it once the page has drawn.
const ProcessCanvas = dynamic(() => import("@/components/process-canvas").then((m) => m.ProcessCanvas), {
  ssr: false,
  loading: () => <MapSkeleton height={256} />,
});

const CARD_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

export interface SolutionCompareProps {
  /** The version of the process the solution was copied from, with the workspace's roles, people and market. */
  base: ProcessBundle;
  solution: SolutionRow;
  links: SolutionIssueRow[];
  issues: IssueRow[];
  /** A sentence when the process has been published since, so "live" here is not today's live. */
  movedOn?: string | null;
  /** The workspace's market conditions (the demo passes its sample). */
  marketConditions?: MarketConditionRow[];
}

export function SolutionCompare({ base, solution, links, issues, movedOn, marketConditions }: SolutionCompareProps) {
  const comparison = useMemo(() => compareMaps(base, solution), [base, solution]);
  const [months, setMonths] = useState<number | null>(null);
  const weeks = months === null ? null : horizonWeeks(months);
  const liveBuilt = useEngineModel(comparison.base, weeks);
  const solvedBuilt = useEngineModel(comparison.solved, weeks, solution.lever_changes);
  const error = liveBuilt.error ?? solvedBuilt.error;
  // A solution the engine can't read has nothing to compare: no run starts for either side.
  const live = { model: error ? null : liveBuilt.model, error: liveBuilt.error };
  const solved = { model: error ? null : solvedBuilt.model, error: solvedBuilt.error };
  const liveSim = useSimulation(live.model);
  const solvedSim = useSimulation(solved.model);
  const currency = base.workspace.settings.currency;
  // A lever change whose target has gone (a step, role or service removed since) is left out; say so.
  const leverNotes = useMemo(() => {
    if (!solution.lever_changes.length) return [];
    try {
      const problems = withLeverChanges(toEngineModel(comparison.solved), solution.lever_changes).problems;
      return problems.length ? [`${problems.length === 1 ? "One lever change" : `${problems.length} lever changes`} in this solution no longer apply (${problems.join(" ")})`] : [];
    } catch {
      return [];
    }
  }, [comparison.solved, solution.lever_changes]);
  const notes = useMemo(() => [...(movedOn ? [movedOn] : []), ...leverNotes, ...pinProblems(comparison.base)], [movedOn, leverNotes, comparison.base]);

  return (
    <div className="flex flex-col gap-6" data-solution-compare>
      <MapsSection
        comparison={comparison}
        notes={notes}
        // Only the first run of each side, and only while a model exists to run (an error leaves it null).
        computing={{
          live: live.model !== null && liveSim.status === "running" && liveSim.run === null,
          solution: solved.model !== null && solvedSim.status === "running" && solvedSim.run === null,
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-section="horizon">
        <p className="text-sm text-muted-foreground">The measures, the revenue chart and the stress test look this far ahead.</p>
        <span className="flex items-center">
          <HorizonPicker weeks={liveBuilt.model?.horizonWeeks ?? solvedBuilt.model?.horizonWeeks ?? 13} onChange={setMonths} />
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-cant-simulate>
          The solution can&apos;t be simulated, so there are no numbers to compare: {error}. The maps above still show what it changed.
        </p>
      )}

      <section className="flex flex-col gap-2" data-section="measures">
        <h2 className={`${CARD_TITLE} flex items-center`}>
          Measures
          <Help {...SOLUTION_PAGE_HELP.measures} />
        </h2>
        <MeasuresTable
          live={liveSim.status === "done" ? liveSim.run.result : null}
          solution={solvedSim.status === "done" ? solvedSim.run.result : null}
          failed={liveSim.status === "error" || solvedSim.status === "error"}
          blocked={error}
          horizonWeeks={live.model?.horizonWeeks ?? 13}
          hoursPerWeek={live.model?.hoursPerWeek ?? 40}
          currency={currency}
        />
      </section>

      <section className="flex flex-col gap-2" data-section="mrr">
        <h2 className={`${CARD_TITLE} flex items-center`}>
          MRR over time
          <Help {...SOLUTION_PAGE_HELP.mrr} />
        </h2>
        <MrrCompare live={live.model} solved={solved.model} blocked={error} currency={currency} />
      </section>

      <section className="flex flex-col gap-2" data-section="stress">
        <div>
          <h2 className={`${CARD_TITLE} flex items-center`}>
            Market stress test
            <Help {...SOLUTION_PAGE_HELP.stress} />
          </h2>
          <p className="text-sm text-muted-foreground">Does it still work under different market conditions?</p>
        </div>
        <StressTable comparison={comparison} liveModel={live.model} solvedModel={solved.model} blocked={error} links={links} issues={issues} solution={solution} marketConditions={marketConditions} currency={currency} />
      </section>
    </div>
  );
}

function MapsSection({ comparison, notes, computing }: { comparison: ReturnType<typeof compareMaps>; notes: string[]; computing: { live: boolean; solution: boolean } }) {
  // One set of open groups for both maps: open or close a group on either and it follows on the other.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(comparison.open);
  return (
    <section className="flex flex-col gap-2" data-section="compare">
      <div>
        <h2 className={`${CARD_TITLE} flex items-center`}>
          Live vs this solution
          <Help {...SOLUTION_PAGE_HELP.compare} />
        </h2>
        <p className="text-sm text-muted-foreground">
          The two maps open and close together. New or changed steps are marked on the solution&apos;s map.
          <Help {...SOLUTION_PAGE_HELP.compareSide} />
        </p>
        <p className="mt-1 text-xs text-muted-foreground" data-diff-key>
          <span aria-hidden className="mr-1 inline-block h-2.5 w-4 border border-dashed border-edit align-middle" />
          new or changed · <s>removed</s>. The maps open on what changed; Fit shows the whole process.
        </p>
        {notes.map((n) => (
          <p key={n} className="mt-1 text-xs text-muted-foreground" data-compare-note>
            {n}
          </p>
        ))}
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2" data-maps>
        {(
          [
            ["live", "Live", comparison.base, null],
            ["solution", "With this solution", comparison.solved, comparison.diff],
          ] as const
        ).map(([id, title, bundle, diff]) => (
          <div key={id} className="flex min-w-0 flex-col gap-1" data-map-side={id}>
            <h3 className="text-sm font-semibold">{title}</h3>
            <div className="min-w-0 overflow-hidden rounded-token border bg-card">
              <ProcessCanvas
                bundle={bundle}
                diff={diff}
                expanded={expanded}
                onExpandedChange={setExpanded}
                showPlayback={false}
                showLanes={false}
                legend={false}
                diffLegend={false}
                focus={comparison.changed}
                height="auto"
                stepDetail={false}
                computing={computing[id]}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MeasuresTable({
  live,
  solution,
  failed,
  blocked,
  horizonWeeks: weeks,
  hoursPerWeek,
  currency,
}: {
  live: Parameters<typeof compareRuns>[0] | null;
  solution: Parameters<typeof compareRuns>[1] | null;
  failed: boolean;
  /** Why there is nothing to show (the solution can't be simulated), or null. */
  blocked: string | null;
  horizonWeeks: number;
  hoursPerWeek: number;
  currency: string;
}) {
  const rows = useMemo(() => (live && solution ? compareTable(compareRuns(live, solution), { horizonWeeks: weeks, hoursPerWeek, currency }) : null), [live, solution, weeks, hoursPerWeek, currency]);
  // A share link without Financials hides the labour cost: role rates are zero there, so it would read as £0 (B3).
  const hideMoney = useShareFinancialsHidden();
  if (blocked) return <p className="text-sm text-muted-foreground">No measures: the solution can&apos;t be simulated.</p>;
  if (failed) return <p className="text-sm text-muted-foreground">The measures couldn&apos;t be worked out.</p>;
  if (!rows) return <Skeleton className="h-40 w-full" aria-busy="true" />;
  return (
    <Card className="overflow-x-auto p-0" data-measures>
      <table className="w-full min-w-[26rem] text-left text-sm">
        <caption className="sr-only">Measures for live and for the solution, with whether the solution is better or worse</caption>
        <thead>
          <tr className="border-b border-border text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            <th scope="col" className="px-4 py-2">
              Measure
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Live
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Solution
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="flex items-center">
                Change
                <Help {...SOLUTION_PAGE_HELP.measuresChange} />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.metric} className="border-b border-border last:border-0" data-measure={r.metric}>
              <th scope="row" className="px-4 py-2 font-normal">
                {r.label}
              </th>
              {hideMoney && r.metric === "labour" ? (
                <td colSpan={3} className="px-3 py-2 text-right text-muted-foreground">
                  <MoneyHidden />
                </td>
              ) : (
                <>
                  <td className="px-3 py-2 text-right tabular-nums">{r.text.baseline}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.text.scenario}</td>
                  <td className={cn("px-3 py-2 whitespace-nowrap", r.tone === "good" ? "text-good" : r.tone === "bad" ? "text-crit" : "text-muted-foreground")}>
                    <span className="font-semibold">{r.better ? toneWord(r.tone) : "Not rated"}</span> <span className="tabular-nums">{r.text.change}</span>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function MrrCompare({ live, solved, blocked, currency }: { live: ReturnType<typeof useEngineModel>["model"]; solved: ReturnType<typeof useEngineModel>["model"]; blocked: string | null; currency: string }) {
  const horizon = live?.horizonWeeks ?? solved?.horizonWeeks ?? 13;
  const horizonMonths = monthsForWeeks(horizon) ?? Math.max(1, Math.round(horizon / (52 / 12)));
  const marks = useMemo(() => checkpointMonths(horizonMonths), [horizonMonths]);
  const weeks = useMemo(() => checkpointWeeks(marks), [marks]);
  const liveRuns = useProjection(live, weeks);
  const solvedRuns = useProjection(solved, weeks);
  const liveSeries = live && liveRuns.status === "done" ? mrrSeries(live, marks, liveRuns.runs) : null;
  const solvedSeries = solved && solvedRuns.status === "done" ? mrrSeries(solved, marks, solvedRuns.runs) : null;
  const failed = liveRuns.status === "error" || solvedRuns.status === "error";
  return (
    <Card className="gap-3 px-4 py-4" data-chart="mrr-compare">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold">MRR over {horizonMonths} {horizonMonths === 1 ? "month" : "months"}</h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="h-0.5 w-4 rounded bg-accent" />
            Live
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="h-0.5 w-4 rounded border-t-2 border-dashed border-edit" />
            With solution
          </span>
        </div>
      </div>
      {blocked ? <p className="text-sm text-muted-foreground">No chart: the solution can&apos;t be simulated.</p> : liveSeries && solvedSeries ? <MrrChart points={liveSeries} compare={solvedSeries} horizonMonths={horizonMonths} currency={currency} /> : failed ? <p className="text-sm text-muted-foreground">The revenue projection couldn&apos;t be worked out.</p> : <Skeleton className="h-[244px] w-full" aria-busy="true" />}
    </Card>
  );
}

function StressTable({
  comparison,
  liveModel,
  solvedModel,
  blocked,
  links,
  issues,
  solution,
  marketConditions,
  currency,
}: {
  comparison: ReturnType<typeof compareMaps>;
  liveModel: ReturnType<typeof useEngineModel>["model"];
  solvedModel: ReturnType<typeof useEngineModel>["model"];
  blocked: string | null;
  links: SolutionIssueRow[];
  issues: IssueRow[];
  solution: SolutionRow;
  marketConditions?: MarketConditionRow[];
  currency: string;
}) {
  const hasSchedule = Boolean(liveModel?.market || solvedModel?.market);
  const conditions = useMemo(() => stressConditions(marketConditions ?? comparison.base.marketConditions, hasSchedule), [marketConditions, comparison.base.marketConditions, hasSchedule]);
  const mine = useMemo(() => links.filter((l) => l.solution_id === solution.id), [links, solution.id]);
  const targets = useMemo(() => stressTargets(comparison, mine, issues, solution.process_id), [comparison, mine, issues, solution.process_id]);
  const stress = useStress({ base: liveModel, solved: solvedModel, conditions, targets });
  const byKey = new Map(stress.rows.map((r) => [r.key, r]));
  const money = (v: number) => formatCurrency(v, currency);
  return (
    <Card className="overflow-x-auto p-0" data-stress>
      <table className="w-full min-w-[30rem] text-left text-sm">
        <caption className="sr-only">Result and key number for the solution under each market condition</caption>
        <thead>
          <tr className="border-b border-border text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            <th scope="col" className="px-4 py-2">
              Market
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="flex items-center">
                Result
                <Help {...SOLUTION_PAGE_HELP.stressResult} />
              </span>
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="flex items-center">
                Key number
                <Help {...SOLUTION_PAGE_HELP.stressNumber} />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {conditions.map((c) => {
            const row = byKey.get(c.key);
            const result = row ? overallResult(row.verdicts) : null;
            return (
              <tr key={c.key} className="border-b border-border align-top last:border-0" data-stress-row={c.key} data-stress-name={c.name}>
                <th scope="row" className="px-4 py-2 font-normal">
                  {c.name}
                  {c.key === SCHEDULE_KEY ? <span className="ml-1.5 text-xs text-muted-foreground">from Settings</span> : !c.preset && <span className="ml-1.5 text-xs text-muted-foreground">yours</span>}
                </th>
                <td className="px-3 py-2">
                  {row ? <VerdictWord verdict={result === "pass" || result === "fail" ? result : null} /> : blocked || stress.status === "error" ? <span className="text-muted-foreground">—</span> : <Skeleton className="h-4 w-14" aria-busy="true" />}
                </td>
                <td className="px-3 py-2 text-xs" data-key-number>
                  {row ? (
                    <div className="flex flex-col gap-1">
                      {row.verdicts.map((v) => (
                        <span key={v.issueId} className="font-mono">
                          {row.verdicts.length > 1 && (
                            <b className="mr-1">#{targets.find((t) => t.issueId === v.issueId)?.number ?? "?"}</b>
                          )}
                          {v.note}
                        </span>
                      ))}
                      <span className="font-mono text-muted-foreground">
                        MRR {money(row.mrr.solution)}, live {money(row.mrr.live)}
                      </span>
                    </div>
                  ) : blocked ? (
                    <span className="text-muted-foreground">Can&apos;t be simulated</span>
                  ) : (
                    <Skeleton className="h-4 w-40" aria-busy="true" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {stress.status === "error" && (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          The stress test couldn&apos;t finish: {stress.error}
        </p>
      )}
    </Card>
  );
}
