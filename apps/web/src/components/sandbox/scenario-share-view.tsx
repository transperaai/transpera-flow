"use client";

// A saved Sandbox scenario behind a share link (sandbox phase 5b, docs/plans/sandbox-p5-brief.md section 11.4): read only, from the frozen copy
// (`ScenarioShare`) and nothing else. The visitor's browser runs the scenario at the copy's start date and horizon (fixed: they can't change
// either), so the numbers are the ones the copy was made with. No server call, no scenario picker, no goal seek, no tornado, no Settings or share
// links, no acknowledging an alert. The copy is built `payHidden`, so there is no profit or labour whatever the toggles say: "Financials" on shows
// a role's rate in a change, never pay. It is the Sandbox page's sections (alerts, timeline, "When", time, sales and money, price rise) over
// the same runner, and the page's compare, print and numbers file, with the costs and the person-level views taken out.

import { useEffect, useMemo, useState } from "react";
import { workspacePurposes, type SandboxScenarioRow, type ScenarioShare } from "@transpera-flow/db";
import { effectiveChanges, effectiveLimitProblem, type EffectiveChange } from "@transpera-flow/db/sandbox";
import { ENGINE_VERSION, toRatingConfig } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { ForecastMoney } from "@/components/forecast/forecast-money";
import { ForecastTimeline, TimelineLegend } from "@/components/forecast/forecast-timeline";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { forecastInsights, forecastModel } from "@/lib/forecast/forecast";
import { forecastMoney } from "@/lib/forecast/money";
import { viewerOf } from "@/lib/viewer";
import { runKey, sharedSimPool } from "@/lib/forecast/sim-pool";
import { partMonthNote, timelineData, timelineMonths } from "@/lib/forecast/timeline";
import { horizonLabel } from "@/lib/horizon";
import { describeChangeFor, whenOf, type DescribeContext } from "@/lib/sandbox/describe";
import { useScenarioRun } from "@/lib/sandbox/use-scenario-run";
import { capacityLine, capacityRunsOut } from "@/lib/sandbox/timing";
import { useSimulation } from "@/lib/sim/use-simulation";
import { SandboxExportMenu, type ExportData } from "./export-menu";
import { PrintSummary, type PrintColumn } from "./print-summary";
import { PriceRise } from "./price-rise";
import { SandboxCompare } from "./sandbox-compare";
import { TimeByPurpose } from "./time-by-purpose";
import { Timing } from "./timing";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const NO_COSTS_NOTE = "Costs and profit aren't part of a shared view.";

/** The snapshot's scenarios as the rows the runner reads (the columns a visitor's copy doesn't carry are empty). */
export function scenarioRowsOf(snapshot: Pick<ScenarioShare, "scenarios" | "bundle">): SandboxScenarioRow[] {
  return snapshot.scenarios.map((s) => ({ ...s, workspace_id: snapshot.bundle.workspace.id, start_date: null, created_at: "", updated_at: "", created_by: null }));
}

export function ScenarioShareView({ snapshot }: { snapshot: ScenarioShare }) {
  const live = snapshot.bundle;
  const start = snapshot.startDate;
  const months = snapshot.months;
  const solutions = snapshot.solutions;
  const rows = useMemo(() => scenarioRowsOf(snapshot), [snapshot]);
  const scenario = rows[rows.length - 1]!;
  const [comparing, setComparing] = useState(false);

  const effective = useMemo(() => {
    const eff = effectiveChanges(scenario, rows);
    if (!eff.ok) return { ok: false as const, error: eff.error };
    const limit = effectiveLimitProblem(eff.changes.map((c) => c.change));
    return limit ? { ok: false as const, error: limit } : { ok: true as const, changes: eff.changes };
  }, [scenario, rows]);
  const effectiveList: EffectiveChange[] | null = effective.ok ? effective.changes : null;

  // "No changes": the live model, which is also segment 0 of the scenario's run when nothing starts at month 0 (so it is run once).
  const built = useMemo(() => forecastModel(live, months, start), [live, months, start]);
  const sim = useSimulation(built.model, 30, 1, { monthly: true, monthStarts: built.monthStarts });
  const result = sim.status === "done" && built.model && sim.run.result.H === built.model.horizonWeeks * built.model.hoursPerWeek ? sim.run.result : null;
  useEffect(() => {
    if (built.model && built.monthStarts && result) sharedSimPool().seed(runKey(built.model, built.monthStarts, result.initialState), result);
  }, [built.model, built.monthStarts, result]);
  const plan = useScenarioRun({ bundle: live, changes: comparing ? null : effectiveList, solutions, months, startDate: start });

  const cutoffs = useMemo(() => toRatingConfig(ANALYSIS_DEFAULTS, live.workspace.settings.hours_per_week).rules.busy.cutoffs, [live.workspace.settings.hours_per_week]);
  const run = plan.status === "done" && plan.run ? plan.run : null;
  const ctx: DescribeContext = useMemo(() => ({ bundle: live, solutions, changes: effectiveList?.map((e) => e.change) ?? [], mix: Object.fromEntries(Object.entries(built.model?.services ?? {}).map(([id, sv]) => [id, sv.mixShare])) }), [live, solutions, effectiveList, built.model]);
  const alerts = useMemo(() => (run ? forecastInsights(run.model, run.result, ANALYSIS_DEFAULTS, start) : null), [run, start]);
  const data = useMemo(() => (run ? timelineData(run.model, run.result, live, start, { markersModel: run.markersModel, planPeople: run.planPeople }) : null), [run, live, start]);
  const serviceNames = useMemo(() => new Map(live.services.map((sv) => [sv.id, sv.name])), [live.services]);
  const moneyView = useMemo(
    () => (run?.result.monthly ? forecastMoney(run.result, timelineMonths(start, run.result.monthly.months, run.model.hoursPerWeek), (id) => serviceNames.get(id) ?? "Hourly", { spliced: run.spliced }) : null),
    [run, start, serviceNames],
  );
  const exportMonths = useMemo(() => (run?.result.monthly ? timelineMonths(start, run.result.monthly.months, run.model.hoursPerWeek) : null), [run, start]);
  const roleNames = useMemo(() => Object.fromEntries(Object.entries(run?.model.roles ?? {}).map(([id, r]) => [id, r.name])), [run]);
  const categories = useMemo(() => workspacePurposes(live.workspace.settings), [live.workspace.settings]);
  const span = horizonLabel(months);
  const currency = live.workspace.settings.currency;
  const printedOn = snapshot.startDate;

  const exportColumns: PrintColumn[] | null = useMemo(() => {
    if (!result?.monthly || !run?.result.monthly) return null;
    return [
      { name: "No changes", monthly: result.monthly, priceRise: null, changes: [] },
      { name: scenario.name, monthly: run.result.monthly, priceRise: plan.priceRise, changes: effectiveList ?? [] },
    ];
  }, [result, run, scenario.name, plan.priceRise, effectiveList]);
  const exportData: ExportData | null = useMemo(
    () => (exportColumns && exportMonths && run ? { columns: exportColumns, months: exportMonths, model: run.model, categories, currency, ctx } : null),
    [exportColumns, exportMonths, run, categories, currency, ctx],
  );
  const timingLine = useMemo(() => (run?.result.monthly && exportMonths ? capacityLine(capacityRunsOut(run.result.monthly, roleNames, cutoffs), exportMonths, span) : null), [run, exportMonths, roleNames, cutoffs, span]);
  const parent = rows.length > 1 ? rows[rows.length - 2]! : null;
  // A change is worded as the Sandbox words it. Role-cost and overheads changes were left out of the copy when Financials was off.
  const changes = effectiveList ?? [];

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-4 pb-12 pt-6 sm:px-6" data-scenario-share>
      <header className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">Sandbox scenario</p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight" data-scenario-name>
          {scenario.name}
        </h1>
        {scenario.description ? <p className="max-w-3xl text-sm text-muted-foreground">{scenario.description}</p> : null}
        <p className="text-sm text-muted-foreground" data-scenario-run-note>
          {parent ? `Builds on “${parent.name}”. ` : ""}
          The live model run month by month for {span}, from {start}: 30 simulated runs, engine {ENGINE_VERSION}. The start and the length are fixed in this copy.
        </p>
      </header>

      {effective.ok ? null : (
        <Card className="px-4 py-3 text-sm" role="alert" data-scenario-error>
          {effective.error}
        </Card>
      )}
      {built.error ? (
        <Card className="px-4 py-3 text-sm" role="alert">
          This copy can&apos;t be simulated: {built.error}.
        </Card>
      ) : null}

      <section className="flex min-w-0 flex-col gap-2" data-scenario-changes>
        <h2 className={`${SECTION_TITLE} flex items-center`}>Changes in this scenario</h2>
        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes: the live model as it is.</p>
        ) : (
          <Card className="gap-0 px-4 py-2">
            <ul className="divide-y divide-line">
              {changes.map((e) => (
                <li key={e.change.id} className="flex flex-col gap-0.5 py-2 text-sm" data-share-change={e.change.id}>
                  <span>
                    {describeChangeFor(e.change, ctx, true)} <span className="text-muted-foreground">{whenOf(e.change) ?? "the whole run"}</span>
                    {e.inherited ? <span className="ml-1 text-muted-foreground">(from {e.scenarioName})</span> : null}
                  </span>
                  {e.change.note ? <span className="text-xs text-muted-foreground">{e.change.note}</span> : null}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {snapshot.hiddenCostChanges > 0 ? (
          <p className="text-sm text-muted-foreground" data-hidden-cost-changes>
            {snapshot.hiddenCostChanges} change{snapshot.hiddenCostChanges === 1 ? "" : "s"} about costs {snapshot.hiddenCostChanges === 1 ? "is" : "are"} hidden on this link.
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" aria-pressed={comparing} onClick={() => setComparing((c) => !c)} data-share-compare>
          {comparing ? "Hide the comparison with No changes" : "Compare with No changes"}
        </Button>
        {comparing ? null : (
          <SandboxExportMenu
            fileName={`${live.workspace.name} ${scenario.name}`}
            disabledReason={exportData ? null : plan.status === "error" ? "The scenario couldn't be worked out." : "Wait for the runs to finish."}
            data={exportData}
            hasCosts={false}
            includeCosts={false}
            onIncludeCosts={() => {}}
            onPrint={() => window.print()}
            numbersOnly
          />
        )}
        {plan.status === "running" && !comparing ? <span className="text-sm text-muted-foreground" aria-live="polite">Running the scenario…</span> : null}
      </div>

      {comparing ? (
        <SandboxCompare live={live} startDate={start} months={months} scenarios={rows} solutions={solutions} ids={[scenario.id]} cutoffs={cutoffs} canEdit={false} onChange={() => {}} onBack={() => setComparing(false)} share />
      ) : (
        <>
          <section className="flex min-w-0 flex-col gap-3" data-forecast-alerts>
            <h2 className={`${SECTION_TITLE} flex items-center`}>
              Who gets too busy, and when
              <Help
                label="Too busy alerts"
                description="For each role, the first month its work passes the “Too busy” line, on average or in a bad month (the worst 10% of the 30 simulated runs)."
                example="“PPC specialist gets too busy in February (92% in a bad month)” means hiring or moving work before February avoids it."
              />
            </h2>
            {alerts === null ? (
              plan.status === "error" ? (
                <p className="text-sm text-muted-foreground">The scenario couldn&apos;t be worked out: {plan.error}</p>
              ) : (
                <Skeleton className="h-16 w-full" aria-busy="true" />
              )
            ) : alerts.length === 0 ? (
              <Card className="px-4 py-3 text-sm text-muted-foreground" data-forecast-empty>
                Nobody crosses the {Math.round(cutoffs[1] * 100)}% line in the next {span}, on average or in a bad month.
              </Card>
            ) : (
              <Card className="gap-0 px-4 py-2">
                <ul className="divide-y divide-line">
                  {alerts.map((a) => (
                    <li key={a.key} className="py-2 text-sm" data-share-alert>
                      <span className="font-medium">{a.title}</span> <span className="text-muted-foreground">{a.evidence}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>

          <section className="flex min-w-0 flex-col gap-3" data-forecast-timeline-section>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className={SECTION_TITLE}>Month by month</h2>
              <p className="text-sm text-muted-foreground">How busy each role is, with the 10–90% range from 30 runs, and the clients by service.</p>
            </div>
            <Card className="gap-3 px-4 py-4" data-chart="forecast" aria-busy={plan.status === "running" ? true : undefined}>
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                <TimelineLegend busyLine={cutoffs[1]} hasUncovered={data?.roles.some((r) => r.uncovered) ?? false} hasMarkers={(data?.markers.length ?? 0) > 0} hasMarket={(data?.market.length ?? 0) > 0} hasPlan={false} />
              </div>
              {data ? (
                <ForecastTimeline data={data} rows="roles" cutoffs={cutoffs} label={`How busy each role is per month over the next ${span}, against the ${Math.round(cutoffs[1] * 100)}% too busy line.`} />
              ) : plan.status === "error" ? null : (
                <Skeleton className="h-[320px] w-full" aria-busy="true" />
              )}
              {data && partMonthNote(data.months) ? <p className="text-xs text-muted-foreground">* {partMonthNote(data.months)}</p> : null}
            </Card>
          </section>

          {run?.result.monthly && exportMonths ? (
            <Timing
              monthly={run.result.monthly}
              months={exportMonths}
              model={run.model}
              roleNames={roleNames}
              cutoffs={cutoffs}
              horizonMonths={months}
              changes={changes}
              live={live}
              solutions={solutions}
              startDate={start}
              ctx={ctx}
              currency={currency}
              canSeeMoney={false}
              capacityOnly
            />
          ) : null}
          {run?.result.monthly && exportMonths ? (
            <TimeByPurpose monthly={run.result.monthly} months={exportMonths} categories={categories} roles={Object.entries(run.model.roles).map(([id, r]) => ({ id, name: r.name }))} people={[]} viewer={viewerOf(live)} span={span} noPeople />
          ) : null}
          {moneyView ? <ForecastMoney view={moneyView} currency={currency} span={span} costsNote={NO_COSTS_NOTE} /> : null}
          {plan.priceRise && run?.result.monthly ? <PriceRise tradeoff={plan.priceRise} months={timelineMonths(start, run.result.monthly.months, run.model.hoursPerWeek)} currency={currency} /> : null}

          {built.model && exportColumns && exportMonths ? (
            <PrintSummary
              workspaceName={live.workspace.name}
              title={scenario.name}
              printedOn={printedOn}
              startDate={start}
              horizonMonths={months}
              engineVersion={ENGINE_VERSION}
              model={built.model}
              bundle={live}
              columns={exportColumns}
              cutoffs={cutoffs}
              categories={categories}
              currency={currency}
              costs={false}
              timingLine={timingLine}
              ctx={ctx}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

