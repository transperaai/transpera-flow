"use client";

// The Overview (issue #100, A35; decisions D21-D37): the landing page of a workspace. Where the whole company
// stands: four headline numbers for the horizon picked, the company map, what the analysis found, and the trends.
//
// Two simulations of the company model feed it, in workers: one at the workspace's own length, which the findings
// are rated from (so they don't change when you look further ahead), and one at the horizon picked, which the
// cards and the busy chart read. The recurring-revenue chart adds a few shorter runs, so it has a point for each
// stretch of the way. Everything is the same 30 runs the process pages use.

import { useSuccessMeasures } from "@/lib/first-principles/use-measures";
import type { FirstPrinciples } from "@transpera-flow/engine";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { ExportMenu } from "@/components/export/export-menu";
import { ratingOfRank } from "@/lib/map/rating";
import { ModelError, toEngineModel, type IssueRow, type ProcessBundle, type ProcessPart, type SourceRow } from "@transpera-flow/db";
import { resolveMoney, toRatingConfig, type AnalysisSettings, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { HorizonPicker } from "@/components/horizon-picker";
import { NO_SELECTION, ProcessCanvas } from "@/components/process-canvas";
import { PageHeader } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { horizonLabel, horizonWeeks, isHorizonMonths, monthsForWeeks } from "@/lib/horizon";
import { perceptionGapDetections } from "@/lib/issues/perception";
import { issueFormOptions } from "@/lib/issues/draft";
import { mapFeed, registerEntries, stepRatingOf } from "@/lib/issues/register";
import { litIds } from "@/lib/map/highlight";
import { companyMap } from "@/lib/overview/company-map";
import { sortFindings } from "@/lib/overview/findings";
import { headlineCards } from "@/lib/overview/headline";
import { checkpointMonths, checkpointWeeks, mrrAfter, mrrSeries, roleBusy, startingMrr, summarise } from "@/lib/overview/projection";
import { useProjection } from "@/lib/overview/use-projection";
import { rerate, visibleFindings } from "@/lib/rules/edit";
import { useRatingSettings } from "@/lib/rules/use-rating-settings";
import { useAbsenceTest } from "@/lib/sim/absence";
import { useSimulation } from "@/lib/sim/use-simulation";
import { AiRead } from "@/components/ai/ai-read";
import { aiDetections, type AiPanelData } from "@/lib/ai/types";
import { RatingCounts } from "./analysis-found";
import { LegendItem, MrrChart, RoleBusyChart } from "./charts";
import { HeadlineCards } from "./headline-cards";
import { InsightsSection } from "@/components/insights";
import { buildInsights } from "@/lib/insights/insights";
import { useIssues } from "@/lib/issues/use-issues";

export interface OverviewProps {
  /** The workspace's name, as the page's title. */
  workspaceName: string;
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Every process at its live revision, for the company map. */
  parts: ProcessPart[];
  /** The company map process at its live revision: where each process sits and the handoff lines (B11). Absent: the default layout. */
  company?: ProcessPart | null;
  /** Tracked issues: the confirmed ones colour and badge the map. */
  issues: IssueRow[];
  /** The workspace's sources, which the Acknowledge dialog can link to an issue. */
  sources?: SourceRow[];
  mode: "live" | "demo" | "readonly";
  /** The workspace's analysis rules; omitted means the defaults. On the demo, the ones edited in this tab. */
  analysisRules?: AnalysisSettings;
  /** The pipeline's live first principles, whose success measures rule 11 (goals met) rates. */
  firstPrinciples?: FirstPrinciples | null;
  /** Where each process's page is, by process id. */
  hrefs: Record<string, string>;
  processesHref: string;
  /** Editors only: the Editor on the company map (its draft, handoff lines and publishing), and its History (B11). */
  companyEditHref?: string;
  companyHistoryHref?: string;
  /** Where the workspace's JSON bundle is downloaded (live workspaces only; the demo has none). */
  bundleHref?: string;
  /** The earlier version of the company map being shown (`?version=N`, read only), or null for live. Only the map changes. */
  viewingMapVersion?: number | null;
  issuesHref: string;
  rulesHref?: string;
  /** What AI wrote about the company model's live version, for the AI read and the AI insights (A46). */
  ai?: AiPanelData;
}

const NO_SOURCES: SourceRow[] = [];

/** The company's engine model, the same object while it is unchanged. */
function useCompanyModel(bundle: ProcessBundle): { model: EngineModel | null; error: string | null } {
  const resolved = useMemo(() => {
    try {
      return { model: toEngineModel(bundle), error: null };
    } catch (err) {
      if (err instanceof ModelError) return { model: null, error: err.message };
      throw err;
    }
  }, [bundle]);
  const key = resolved.model ? JSON.stringify(resolved.model) : null;
  const model = useMemo(() => (key ? (JSON.parse(key) as EngineModel) : null), [key]);
  return { model, error: resolved.error };
}

/** A run is only shown for the model it was made from: the worker's last answer outlives a change of horizon by a moment. */
const current = (result: SimulationResult | null, model: EngineModel | null): SimulationResult | null =>
  result && model && Math.abs(result.H - model.horizonWeeks * model.hoursPerWeek) < 1e-6 ? result : null;

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

function Section({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={SECTION_TITLE}>
            {title}
          </h2>
          {description && <div className="text-sm text-muted-foreground">{description}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Overview({ workspaceName, live, parts, company, issues, sources = NO_SOURCES, mode, analysisRules, firstPrinciples, hrefs, processesHref, companyEditHref, companyHistoryHref, bundleHref, viewingMapVersion = null, issuesHref, rulesHref, ai }: OverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { model: base, error } = useCompanyModel(live);
  const currency = live.workspace.settings.currency;

  // The horizon: the workspace's own length until one is picked (or ?horizon= says), as on the process pages.
  const horizonParam = Number(searchParams.get("horizon"));
  const [picked, setPicked] = useState<number | null>(isHorizonMonths(horizonParam) ? horizonParam : null);
  const pickHorizon = (months: number) => {
    setPicked(months);
    const next = new URLSearchParams(searchParams.toString());
    next.set("horizon", String(months));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  // Back to live: the same address without ?version=.
  const backToLive = (() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("version");
    const q = next.toString();
    return q ? `${pathname}?${q}` : pathname;
  })();
  const weeks = picked === null ? (base?.horizonWeeks ?? live.workspace.settings.horizon_weeks) : horizonWeeks(picked);
  const months = picked ?? monthsForWeeks(weeks) ?? Math.max(1, Math.round(weeks / (52 / 12)));

  const horizonModel = useMemo(() => (base ? { ...base, horizonWeeks: weeks } : null), [base, weeks]);
  const sameLength = !!base && base.horizonWeeks === weeks;
  const baseSim = useSimulation(base);
  const horizonSim = useSimulation(sameLength ? null : horizonModel);
  const baseResult = current(baseSim.status === "done" ? baseSim.run.result : null, base);
  const horizonResult = sameLength ? baseResult : current(horizonSim.status === "done" ? horizonSim.run.result : null, horizonModel);

  // The findings, from the run at the workspace's own length, re-rated under the workspace's rules.
  const rules = useRatingSettings(mode === "demo", analysisRules);
  const absence = useAbsenceTest(base && baseResult ? base : null, baseResult?.seed ?? 1, resolveMoney(rules).absenceWeeks);
  const successMeasures = useSuccessMeasures(live.process.id, mode === "demo", firstPrinciples);
  const gaps = useMemo(() => visibleFindings(rules, perceptionGapDetections(parts.flatMap((p) => p.steps))), [rules, parts]);
  // What AI wrote about the live version (A46) joins the rules' findings, marked AI; it isn't rated by a rule, so no rule switch hides it.
  const aiFindings = useMemo(() => aiDetections(ai?.view?.insights ?? []), [ai]);
  const findings = useMemo(
    () => (base && baseResult ? sortFindings([...visibleFindings(rules, [...rerate(base, baseResult, rules, live.process.id, absence, { successMeasures }), ...gaps]), ...aiFindings]) : null),
    [base, baseResult, rules, live.process.id, absence, gaps, successMeasures, aiFindings],
  );
  // Acknowledging an insight tracks it here, so it badges the map straight away.
  // A dismissed insight stays away until its process's next published version: each part is at its live revision.
  const liveRevisions = useMemo(() => Object.fromEntries(parts.map((p) => [p.process.id, p.revision.id])), [parts]);
  const state = useIssues(live.workspace.id, issues, mode, liveRevisions);
  const entries = useMemo(() => registerEntries(state.issues, findings ?? [], state.revisionOf), [state.issues, state.revisionOf, findings]);
  const formOptions = useMemo(
    () =>
      issueFormOptions({
        processes: parts.map((p) => ({ id: p.process.id, name: p.process.name })),
        steps: parts.flatMap((p) => p.steps),
        people: live.people.filter((p) => p.active),
        sources,
      }),
    [parts, live.people, sources],
  );
  // What the header counts and the list shows: the same insights (a dismissed one is in neither).
  const insightList = useMemo(() => (findings ? buildInsights(entries) : null), [findings, entries]);
  const feed = useMemo(() => mapFeed(entries), [entries]);
  const openIssues = useMemo(() => Object.fromEntries(Object.entries(feed.badges).map(([id, b]) => [id, b.count])), [feed]);
  const rating = useMemo(() => stepRatingOf(feed.ratings), [feed]);

  // The company map: open groups in place; opening one moves its neighbours.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [lit, setLit] = useState<string[] | null>(null);
  const map = useMemo(() => companyMap(live, parts, expanded, company), [live, parts, expanded, company]);
  const stepNames = useMemo(() => new Map(map.bundle.steps.map((s) => [s.id, s.name])), [map]);
  const processNames = useMemo(() => new Map(parts.map((p) => [p.process.id, p.process.name])), [parts]);
  const openProcess = (stepId: string) => {
    const process = map.processOfStep.get(stepId);
    const href = process ? hrefs[process] : undefined;
    if (href) router.push(href);
  };
  const processOfStep = (stepId: string) => map.processOfStep.get(stepId) ?? null;
  const processNameOfStep = (stepId: string) => {
    const process = processOfStep(stepId);
    return process ? (processNames.get(process) ?? null) : null;
  };

  // The numbers for the horizon picked.
  const start = useMemo(() => (base ? startingMrr(base) : null), [base]);
  const finalMonths = useMemo(() => checkpointMonths(months), [months]);
  const earlier = useMemo(() => checkpointWeeks(finalMonths.slice(0, -1)), [finalMonths]);
  const projection = useProjection(horizonModel, earlier);
  const finalRun = useMemo(() => (horizonModel && horizonResult ? summarise(horizonModel, horizonResult) : null), [horizonModel, horizonResult]);
  const mrr = useMemo(() => (horizonModel && finalRun && start ? mrrAfter(horizonModel, finalRun, start) : null), [horizonModel, finalRun, start]);
  const cards = useMemo(
    () => (horizonModel && horizonResult && mrr && start ? headlineCards({ model: horizonModel, result: horizonResult, mrr, start, months, currency }) : null),
    [horizonModel, horizonResult, mrr, start, months, currency],
  );
  const series = useMemo(
    () => (horizonModel && finalRun && projection.status === "done" ? mrrSeries(horizonModel, finalMonths, [...projection.runs, finalRun]) : null),
    [horizonModel, finalRun, projection, finalMonths],
  );
  const busy = useMemo(() => (horizonModel && horizonResult ? roleBusy(horizonModel, horizonResult) : null), [horizonModel, horizonResult]);
  const busyLine = useMemo(() => (base ? toRatingConfig(rules, base.hoursPerWeek).rules.busy.cutoffs[1] : 0.85), [base, rules]);

  // "Updated" is when the run came in: the numbers are simulated each time the page opens.
  const updated = useMemo(() => (baseResult ? new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null), [baseResult]);

  const span = horizonLabel(months);

  return (
    <div>
      <ShellHeader title="Overview" />
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-4 pb-14 pt-6 sm:px-6">
        <PageHeader
          eyebrow="Overview"
          title={workspaceName}
          description={
            <span className="inline-flex items-center gap-2">
              <i aria-hidden className={`size-2 rounded-full ${base && !baseResult ? "animate-pulse bg-warn" : "bg-good"}`} />
              {error ? "Can't be simulated yet" : baseResult ? `Live model · 30 simulated runs · updated ${updated ?? ""}`.trim() : "Live model · simulating 30 runs…"}
            </span>
          }
          actions={<HorizonPicker weeks={weeks} onChange={pickHorizon} help={false} />}
        />

        {error ? (
          <Card className="px-4 py-3 text-sm" role="alert">
            The company can&apos;t be simulated yet: {error}. The map below still works; fix this under{" "}
            <Link href={processesHref} className="underline">
              Processes
            </Link>
            .
          </Card>
        ) : null}

        <HeadlineCards cards={error ? [] : cards} />

        <Section
          title="Company map"
          description="Every process in the business. Expand one in place, or click it to open its page."
          action={
            <div className="flex flex-wrap items-center gap-1.5">
              {companyEditHref && (
                <Link href={companyEditHref} data-edit-company-map className={cn(buttonVariants({ size: "sm" }), "bg-edit text-edit-fg hover:bg-edit/90")}>
                  ✎ Edit company map
                </Link>
              )}
              <ExportMenu
                name={`${workspaceName} company map`}
                bundleHref={bundleHref}
                note="Drawn as it is on screen."
                input={() => ({
                  title: `${workspaceName}: company map`,
                  subtitle: viewingMapVersion !== null ? `Version ${viewingMapVersion}` : "Live",
                  steps: map.bundle.steps,
                  edges: map.bundle.edges,
                  expanded,
                  rating: (id) => {
                    const r = rating(id);
                    return r ? ratingOfRank(r.rank) : null;
                  },
                  issues: openIssues,
                  handoffs: true,
                })}
              />
              {companyHistoryHref && (
                <Link href={companyHistoryHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  History
                </Link>
              )}
              <Link href={processesHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                All processes
                <ArrowRight aria-hidden />
              </Link>
            </div>
          }
        >
          {viewingMapVersion !== null && (
            <div data-viewing-map-version className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warn bg-warn-soft px-2.5 py-0.5 text-xs font-medium">Viewing version {viewingMapVersion} of the company map · read only</span>
              <Link href={backToLive} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Back to live
              </Link>
            </div>
          )}
          <Card className="gap-0 overflow-hidden p-0">
            {map.bundle.steps.length ? (
              <ProcessCanvas
                // Opening a card changes the map's size: start again so it is framed whole.
                key={[...expanded].sort().join("|")}
                bundle={map.bundle}
                selection={NO_SELECTION}
                openIssues={openIssues}
                rating={rating}
                expanded={expanded}
                onExpandedChange={setExpanded}
                highlight={lit ? [...litIds(map.bundle.steps, expanded, lit)] : null}
                showPlayback={false}
                showLanes={false}
                handoffs
                height="auto"
                stepDetail={false}
                onStepClick={openProcess}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">No process has been published yet.</p>
            )}
          </Card>
        </Section>

        <Section
          title="What the analysis found"
          description={<RatingCounts findings={insightList} />}
          action={
            <Link href={issuesHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              See all insights
              <ArrowRight aria-hidden />
            </Link>
          }
        >
          {ai && <AiRead mode={mode} scope="company" processId={live.process.id} ai={ai} firstPrinciplesHref={hrefs[live.process.id] ? `${hrefs[live.process.id]}/first-principles` : undefined} />}
          <InsightsSection
            state={state}
            detected={findings}
            processId={live.process.id}
            scenarios={[]}
            formOptions={formOptions}
            currency={currency}
            stepName={(id) => stepNames.get(id) ?? null}
            processName={processNameOfStep}
            processOfStep={processOfStep}
            onLight={setLit}
            rulesHref={rulesHref}
            registerHref={issuesHref}
            canEdit={mode !== "readonly"}
            initialLimit={5}
          />
        </Section>

        <Section
          title="Trends"
          description={`Projected over the next ${span}, with the 10–90% range from 30 runs.`}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="gap-3 px-4 py-4" data-chart="mrr">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h3 className="flex items-center text-sm font-semibold">
                  Monthly recurring revenue
                  <Help
                    label="Monthly recurring revenue"
                    description="What clients pay you every month. It starts from today's clients, adds the ones you win and takes away the ones who leave. The band behind the line is the 10–90% range of 30 runs."
                    example="A line that climbs from 80k to 91k with a band of 86k–97k at the end means growth is likely, and very unlikely to fall below 86k."
                  />
                </h3>
                <div className="flex items-center gap-3">
                  <LegendItem swatch={<i aria-hidden className="h-0.5 w-4 rounded bg-accent" />}>Average</LegendItem>
                  <LegendItem swatch={<i aria-hidden className="h-2.5 w-4 rounded-sm bg-accent/20" />}>10–90% range</LegendItem>
                </div>
              </div>
              {series ? <MrrChart points={series} horizonMonths={months} currency={currency} /> : <Skeleton className="h-[244px] w-full" aria-busy="true" />}
              {projection.status === "error" && <p className="text-xs text-muted-foreground">The revenue projection couldn&apos;t be worked out.</p>}
            </Card>
            <Card className="gap-3 px-4 py-4" data-chart="busy">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h3 className="flex items-center text-sm font-semibold">
                  How busy each role is
                  <Help
                    label="How busy each role is"
                    description="The share of each role's working time that is spent on work, averaged over the run, with its 10–90% range as a whisker. The dashed line is where the analysis rules call a role too busy; you can change it in Settings, Analysis rules."
                    example="A bar past the line at 91% means that role has little room for a bad month or a new client."
                  />
                </h3>
                <div className="flex items-center gap-3">
                  <LegendItem swatch={<i aria-hidden className="h-2.5 w-4 rounded-sm bg-accent" />}>Average</LegendItem>
                  <LegendItem swatch={<i aria-hidden className="h-px w-4 bg-fg-2" />}>10–90% range</LegendItem>
                </div>
              </div>
              {busy ? (
                busy.length ? (
                  <RoleBusyChart roles={busy} busyLine={busyLine} />
                ) : (
                  <p className="text-sm text-muted-foreground">No role has any work in this run.</p>
                )
              ) : (
                <Skeleton className="h-[244px] w-full" aria-busy="true" />
              )}
              {rulesHref && (
                <p className="text-xs text-muted-foreground">
                  The line follows your{" "}
                  <Link href={rulesHref} className="underline">
                    analysis rules
                  </Link>
                  .
                </p>
              )}
            </Card>
          </div>
        </Section>
      </div>
    </div>
  );
}
