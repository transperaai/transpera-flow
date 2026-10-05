"use client";

// The Overview (issue #173, B15; before it #100, A35): the landing page of a workspace, in tiers. Top to bottom:
//
// 1. The company map, with Play and the horizon (1, 3, 6, 12 or 24 months). The cards and charts follow the horizon.
// 2. The health strip: Process health, Open issues, Flow efficiency, Improvement delivered.
// 3. Findings by process: the AI analysis of the company (Analyse, its read, the findings waiting for review, Add a
//    finding), "Across the company", then one row per process, each with its accepted findings and the run's facts (B17).
// 4. Trends: open issues, time split by process, team load by role, issues opened versus resolved, before and after per
//    solution.
//
// Two simulations of the company model feed it, in workers, each once:
// - one at the workspace's own length, with today's team, which the findings are rated from (so they don't move with the
//   horizon);
// - one at the horizon picked, month by month, with planned hires, end dates and leave (the forecast's model, B6), which
//   the map plays and the flow efficiency, time split, team load and the forecast's "too busy" alerts read.
// When the two models are the same (the horizon is the workspace's length and nobody joins, leaves or is away), the one
// run serves both.
// Solutions' before and after (Improvement delivered, and its chart) add two runs per solution compared, in their own
// worker, only once the two runs above are first in and only when something needs them; they don't depend on the horizon
// and are kept for the session, so changing the horizon doesn't run them again. The trend charts load on their own.

import { useSuccessMeasures } from "@/lib/first-principles/use-measures";
import type { FirstPrinciples } from "@transpera-flow/engine";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { ExportMenu } from "@/components/export/export-menu";
import { ratingOfRank } from "@/lib/map/rating";
import { ModelError, toEngineModel, type FindingRow, type IssueRow, type ProcessBundle, type ProcessPart, type SourceRow } from "@transpera-flow/db";
import { RATING_LABELS, ratingOfStored, resolveMoney, toRatingConfig, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
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
import { COMPANY_GROUP, findingsByProcess, type FindingGroup } from "@/lib/overview/by-process";
import { countByRating, openIssues, openedVersusResolved, processHealth, timeSplitByProcess, timeSplitOf, workingShare } from "@/lib/overview/health";
import { improvementDelivered, impactPairs, solutionsToCompare, type SolutionBases } from "@/lib/overview/impact";
import { useImpacts } from "@/lib/overview/use-impacts";
import { forecastInsights, forecastModel, today } from "@/lib/forecast/forecast";
import { calendarMonthStarts, timelineData } from "@/lib/forecast/timeline";
import { rerate, visibleFindings } from "@/lib/rules/edit";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { useAbsenceTest } from "@/lib/sim/absence";
import { useSimulation } from "@/lib/sim/use-simulation";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { NO_SOLUTIONS_DATA, type SolutionsData } from "@/lib/solutions/cards";
import { analyseCompany } from "@/app/w/[slug]/ai-actions";
import { AnalysisPanel } from "@/components/findings/analysis-panel";
import { FactsList } from "@/components/findings/facts-list";
import type { FindingDialogOptions } from "@/components/findings/finding-dialog";
import type { AiPanelData } from "@/lib/ai/types";
import { demoAnalyse } from "@/lib/findings/demo";
import { useFindings } from "@/lib/findings/use-findings";
import { pageDetections, proposedFindings } from "@/lib/findings/view";
import { InsightsSection } from "@/components/insights";
import { buildInsights } from "@/lib/insights/insights";
import { useIssues } from "@/lib/issues/use-issues";
import { FindingsByProcess } from "./findings-by-process";
import { FlowEfficiencyCard, ImprovementCard, OpenIssuesCard, ProcessHealthCard } from "./health-cards";
import { RatingPill } from "./rating-pill";

// The trend charts and the team load timeline load after the map and the cards.
const chartLoading = () => <Skeleton className="h-[180px] w-full" aria-busy="true" />;
const IssuesDonut = dynamic(() => import("./trend-charts").then((m) => m.IssuesDonut), { ssr: false, loading: chartLoading });
const TimeSplitChart = dynamic(() => import("./trend-charts").then((m) => m.TimeSplitChart), { ssr: false, loading: chartLoading });
const OpenedResolvedChart = dynamic(() => import("./trend-charts").then((m) => m.OpenedResolvedChart), { ssr: false, loading: chartLoading });
const BeforeAfterChart = dynamic(() => import("./trend-charts").then((m) => m.BeforeAfterChart), { ssr: false, loading: chartLoading });
const ForecastTimeline = dynamic(() => import("@/components/forecast/forecast-timeline").then((m) => m.ForecastTimeline), { ssr: false, loading: chartLoading });
const TimelineLegend = dynamic(() => import("@/components/forecast/forecast-timeline").then((m) => m.TimelineLegend), { ssr: false });

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
  /** The pipeline's live first principles, whose success measures rule 11 (goals met) rates. */
  firstPrinciples?: FirstPrinciples | null;
  /** The workspace's solutions and their verdicts (the demo reads the ones built in this tab instead). */
  solutions?: SolutionsData;
  /** For solutions compared whose process has been published since: the version they were copied from. */
  solutionBases?: SolutionBases;
  /** The ISO date the horizon run starts on (its months are calendar months); today when omitted. Fixed on the demo. */
  startDate?: string;
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
  /** The Forecast page, linked from the team load chart. */
  forecastHref?: string;
  /** The latest AI analysis of the whole company (B17): its read, and whether it is out of date. */
  ai?: AiPanelData;
  /** The workspace's findings (B17): the accepted ones are listed by process, the proposed ones wait for review. */
  findings?: FindingRow[];
}

const NO_SOURCES: SourceRow[] = [];
const NO_FINDINGS: FindingRow[] = [];
const NO_BASES: SolutionBases = {};

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

/** True once the element has come within a screen of view (and stays true). */
function useNear<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

function Section({ id, title, description, action, children, sectionRef }: { id: string; title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; sectionRef?: React.Ref<HTMLElement> }) {
  return (
    <section ref={sectionRef} className="flex min-w-0 flex-col gap-3" data-tier={id} aria-labelledby={`tier-${id}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={`tier-${id}`} className={SECTION_TITLE}>
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

function ChartCard({ id, title, note, wide = false, children }: { id: string; title: string; note?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <Card className={cn("min-w-0 gap-3 px-4 py-4", wide && "lg:col-span-2")} data-chart={id}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </Card>
  );
}

export function Overview({
  workspaceName,
  live,
  parts,
  company,
  issues,
  sources = NO_SOURCES,
  mode,
  firstPrinciples,
  solutions,
  solutionBases = NO_BASES,
  startDate,
  hrefs,
  processesHref,
  companyEditHref,
  companyHistoryHref,
  bundleHref,
  viewingMapVersion = null,
  issuesHref,
  forecastHref,
  ai,
  findings: initialFindings = NO_FINDINGS,
}: OverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { model: base, error } = useCompanyModel(live);
  const hoursPerWeek = live.workspace.settings.hours_per_week;

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
  const span = horizonLabel(months);

  // The run at the horizon: the forecast's model (planned hires, end dates and leave), month by month in calendar months.
  const [start] = useState(() => startDate ?? today());
  const horizon = useMemo(() => {
    const built = forecastModel(live, 1, start);
    if (!built.model) return { model: null, monthStarts: null };
    const model: EngineModel = { ...built.model, horizonWeeks: weeks };
    return { model, monthStarts: calendarMonthStarts(start, weeks, model.hoursPerWeek) };
  }, [live, start, weeks]);
  const horizonModel = error ? null : horizon.model;

  // The same model at the same length: one run serves both (its monthly numbers don't change the rest of it).
  const sameModel = useMemo(() => !!base && !!horizonModel && JSON.stringify(base) === JSON.stringify(horizonModel), [base, horizonModel]);
  const horizonSim = useSimulation(horizonModel, 30, 1, { monthly: true, monthStarts: horizon.monthStarts });
  const horizonResult = current(horizonSim.status === "done" ? horizonSim.run.result : null, horizonModel);
  // The shared run is kept as the base run, so picking another horizon afterwards doesn't simulate the base again.
  const [shared, setShared] = useState<{ model: EngineModel; result: SimulationResult } | null>(null);
  if (sameModel && base && horizonResult && shared?.result !== horizonResult) setShared({ model: base, result: horizonResult });
  const haveBase = sameModel || (!!shared && shared.model === base);
  const baseSim = useSimulation(haveBase ? null : base);
  const baseResult = sameModel ? horizonResult : shared && shared.model === base ? shared.result : current(baseSim.status === "done" ? baseSim.run.result : null, base);

  // The facts (D40), from the run at the workspace's own length, rated with the documented defaults: evidence, never findings.
  const rules = ANALYSIS_DEFAULTS;
  const absence = useAbsenceTest(base && baseResult ? base : null, baseResult?.seed ?? 1, resolveMoney(rules).absenceWeeks);
  const successMeasures = useSuccessMeasures(live.process.id, mode === "demo", firstPrinciples);
  const gaps = useMemo(() => visibleFindings(rules, perceptionGapDetections(parts.flatMap((p) => p.steps))), [rules, parts]);
  // Who gets too busy, and when, over the horizon (B6): "Across the company".
  const forecastFindings = useMemo(() => (horizonModel && horizonResult ? forecastInsights(horizonModel, horizonResult, rules, start) : []), [horizonModel, horizonResult, rules, start]);
  const facts = useMemo(
    () => (base && baseResult ? sortFindings([...visibleFindings(rules, [...rerate(base, baseResult, rules, live.process.id, absence, { successMeasures }), ...gaps]), ...forecastFindings]) : null),
    [base, baseResult, rules, live.process.id, absence, gaps, successMeasures, forecastFindings],
  );
  // Acknowledging an insight tracks it here, so it badges the map straight away.
  // A dismissed insight stays away until its process's next published version: each part is at its live revision.
  const liveRevisions = useMemo(() => Object.fromEntries(parts.map((p) => [p.process.id, p.revision.id])), [parts]);
  const state = useIssues(live.workspace.id, issues, mode, liveRevisions);
  // The findings (B17): the accepted ones are listed, with the issues acknowledged before; the proposed ones wait for review.
  const findingsState = useFindings(live.workspace.id, initialFindings, mode);
  const findings = useMemo(() => (facts ? pageDetections({ findings: findingsState.findings, issues: state.issues, facts }) : null), [facts, findingsState.findings, state.issues]);
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
  const findingOptions = useMemo<FindingDialogOptions>(
    () => ({
      processes: parts.map((p) => ({ id: p.process.id, name: p.process.name })),
      company: true,
      steps: parts.flatMap((p) => p.steps.filter((s) => s.kind !== "start" && s.kind !== "end").map((s) => ({ id: s.id, name: s.name, processId: p.process.id }))),
    }),
    [parts],
  );
  const insightList = useMemo(() => (findings ? buildInsights(entries) : null), [findings, entries]);
  const feed = useMemo(() => mapFeed(entries), [entries]);
  const openIssueBadges = useMemo(() => Object.fromEntries(Object.entries(feed.badges).map(([id, b]) => [id, b.count])), [feed]);
  const rating = useMemo(() => stepRatingOf(feed.ratings), [feed]);

  // Solutions: the workspace's, or on the demo the ones built in this tab.
  const inTab = useDemoSolutions();
  const solutionsData = mode === "demo" ? inTab : (solutions ?? NO_SOLUTIONS_DATA);

  const groups = useMemo(
    () => (insightList ? findingsByProcess({ parts, pipelineId: live.process.id, insights: insightList, facts: facts ?? [], issues: state.issues, solutions: solutionsData.solutions }) : null),
    [insightList, parts, live.process.id, facts, state.issues, solutionsData.solutions],
  );

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

  // The health strip.
  const [now] = useState(() => new Date());
  // Each process as the map and the Processes table rate it: by its confirmed open issues (D24).
  const health = useMemo(() => (groups ? processHealth(groups.filter((g) => g.id !== COMPANY_GROUP).map((g) => g.rating)) : null), [groups]);
  // Months in the browser's time zone (workspaces have none of their own yet), for this card and the chart alike.
  const open = useMemo(() => openIssues(state.issues, now), [state.issues, now]);
  const flowShare = useMemo(() => {
    if (!horizonModel || !horizonResult) return undefined;
    const split = timeSplitOf(horizonModel, horizonResult);
    return split ? workingShare(split) : null;
  }, [horizonModel, horizonResult]);

  // Before and after per solution, once the main runs are in, and only when the card or the chart needs them.
  const [trendsRef, trendsNear] = useNear<HTMLElement>();
  const chosen = useMemo(() => solutionsToCompare(solutionsData, state.issues), [solutionsData, state.issues]);
  const pairs = useMemo(() => (base ? impactPairs(live, chosen, solutionBases, base.horizonWeeks) : []), [base, live, chosen, solutionBases]);
  const anyImplemented = chosen.some((c) => c.implemented);
  // Implemented solutions whose before and after can't be worked out (the version they were copied from isn't loaded, or a side can't be simulated).
  const unmeasured = chosen.filter((c) => c.implemented).length - pairs.filter((p) => p.implemented).length;
  // Once wanted, the runs stay wanted: a horizon change empties the horizon run for a moment, which mustn't stop them.
  const wanted = !!baseResult && !!horizonResult && (anyImplemented || trendsNear);
  const [impactsWanted, setImpactsWanted] = useState(false);
  if (wanted && !impactsWanted) setImpactsWanted(true);
  const impacts = useImpacts(pairs, impactsWanted);
  const delivered = useMemo(() => (impacts.status === "done" ? improvementDelivered(impacts.impacts, hoursPerWeek) : null), [impacts, hoursPerWeek]);

  // The trends.
  const timeSplit = useMemo(() => (horizonModel && horizonResult ? timeSplitByProcess(horizonModel, horizonResult, parts) : null), [horizonModel, horizonResult, parts]);
  const issuesByProcess = useMemo(
    () => (groups ? groups.filter((g) => g.id !== COMPANY_GROUP || g.openIssues > 0).map((g) => ({ id: g.id, name: g.name, count: g.openIssues })) : null),
    [groups],
  );
  const monthsOfIssues = useMemo(() => openedVersusResolved(state.issues, now, 6), [state.issues, now]);
  const cutoffs = useMemo(() => toRatingConfig(rules, hoursPerWeek).rules.busy.cutoffs, [rules, hoursPerWeek]);
  const teamLoad = useMemo(() => (horizonModel && horizonResult ? timelineData(horizonModel, horizonResult, live, start) : null), [horizonModel, horizonResult, live, start]);

  // "Updated" is when the run came in: the numbers are simulated each time the page opens.
  const updated = useMemo(() => (baseResult ? new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null), [baseResult]);

  const renderFindings = (g: FindingGroup) => {
    const own = new Set(g.issues.map((i) => i.id));
    const manual = g.issues.filter((i) => !i.detected_key && (i.status === "open" || i.status === "testing"));
    return (
      <div className="flex flex-col gap-3">
        {g.insights.length > 0 && (
          <InsightsSection
            state={{ ...state, issues: state.issues.filter((i) => own.has(i.id)) }}
            detected={g.insights.map((i) => i.detection)}
            processId={g.id === COMPANY_GROUP ? live.process.id : g.id}
            scenarios={[]}
            formOptions={formOptions}
            currency={live.workspace.settings.currency}
            stepName={(id) => stepNames.get(id) ?? null}
            processName={processNameOfStep}
            processOfStep={processOfStep}
            onLight={setLit}
            registerHref={issuesHref}
            canEdit={mode !== "readonly"}
            findings={findingsState}
            findingOptions={findingOptions}
          />
        )}
        {g.facts.length > 0 && (
          <div className="flex flex-col gap-1.5" data-group-facts>
            <p className="text-xs font-medium text-muted-foreground">Facts from the run</p>
            <FactsList facts={g.facts} currency={live.workspace.settings.currency} stepName={(id) => stepNames.get(id) ?? null} onLight={setLit} initialLimit={4} />
          </div>
        )}
        {manual.length > 0 && (
          <div className="flex flex-col gap-1.5" data-manual-issues>
            <p className="text-xs font-medium text-muted-foreground">Logged by hand</p>
            <ul className="flex flex-col gap-1 text-sm">
              {manual.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <RatingPill rating={ratingOfStored(i.severity)} />
                  <Link href={`${issuesHref}/${i.number ?? i.id}`} className="hover:underline">
                    {i.number ? `#${i.number} ` : ""}
                    {i.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  const simulating = !error && (!baseResult || !horizonResult);

  return (
    <div>
      <ShellHeader title="Overview" />
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-4 pb-14 pt-6 sm:px-6">
        <PageHeader
          eyebrow="Overview"
          title={workspaceName}
          description={
            <span className="inline-flex items-center gap-2">
              <i aria-hidden className={`size-2 rounded-full ${simulating ? "animate-pulse bg-warn" : "bg-good"}`} />
              {error ? "Can't be simulated yet" : baseResult ? `Live model · 30 simulated runs · updated ${updated ?? ""}`.trim() : "Live model · simulating 30 runs…"}
            </span>
          }
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

        <Section
          id="map"
          title="Company map"
          description="Every process in the business. Press play to watch the work move; expand a process in place, or click it to open its page."
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
                  issues: openIssueBadges,
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
          <Card className="gap-0 overflow-hidden p-0" data-company-map>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-3 py-2" data-map-controls>
              <HorizonPicker weeks={weeks} onChange={pickHorizon} help={false} />
              <p className="text-xs text-muted-foreground" data-horizon-note>
                {horizonResult ? `Playing ${span} of work, with planned hires and leave.` : error ? "Nothing to play until the company can be simulated." : `Simulating ${span}…`}
              </p>
            </div>
            {map.bundle.steps.length ? (
              <ProcessCanvas
                // Opening a card changes the map's size: start again so it is framed whole.
                key={[...expanded].sort().join("|")}
                bundle={map.bundle}
                result={horizonResult}
                selection={NO_SELECTION}
                openIssues={openIssueBadges}
                rating={rating}
                expanded={expanded}
                onExpandedChange={setExpanded}
                highlight={lit ? [...litIds(map.bundle.steps, expanded, lit)] : null}
                playbackRollUp
                playbackAbove
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

        <section aria-label="Health" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-tier="health">
          <ProcessHealthCard health={health} />
          <OpenIssuesCard issues={open} />
          <FlowEfficiencyCard share={flowShare} span={span} error={!!error} />
          <ImprovementCard delivered={delivered} status={!anyImplemented ? "done" : impacts.status} unmeasured={unmeasured} />
        </section>

        <Section
          id="findings"
          title="Findings by process"
          description={<FindingsLine groups={groups} />}
          action={
            <Link href={issuesHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              See all issues
              <ArrowRight aria-hidden />
            </Link>
          }
        >
          {ai && (
            <AnalysisPanel
              mode={mode}
              scope="company"
              ai={ai}
              findings={findingsState}
              proposed={proposedFindings(findingsState.findings)}
              options={findingOptions}
              defaultProcessId={null}
              stepName={(id) => stepNames.get(id) ?? null}
              analyse={() => (mode === "demo" ? demoAnalyse(findingsState, live.process.id) : analyseCompany(live.workspace.id))}
              canRun={viewingMapVersion === null}
              firstPrinciplesHref={hrefs[live.process.id] ? `${hrefs[live.process.id]}/first-principles` : undefined}
              short
            />
          )}
          <FindingsByProcess groups={groups} renderFindings={renderFindings} />
        </Section>

        <Section id="trends" title="Trends" description={`Simulated over the next ${span} where a chart looks ahead; the issues are as recorded.`} sectionRef={trendsRef}>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard id="issues" title="Open issues" note="By rating, and by the process they are in.">
              <IssuesDonut byRating={open.byRating} byProcess={issuesByProcess ?? []} />
            </ChartCard>
            <ChartCard id="time-split" title="Time split by process" note={`Of the time work spends in each process over the next ${span}, the share someone is working on it.`}>
              {timeSplit ? <TimeSplitChart rows={timeSplit} months={months} /> : error ? <p className="text-sm text-muted-foreground">Nothing to show until the company can be simulated.</p> : chartLoading()}
            </ChartCard>
            <ChartCard
              id="team-load"
              title="Team load by role"
              wide
              note={
                <>
                  How busy each role is, month by month over the next {span}, with planned hires and leave.{" "}
                  {forecastHref && (
                    <Link href={forecastHref} className="underline">
                      Open the forecast
                    </Link>
                  )}
                </>
              }
            >
              {teamLoad ? (
                teamLoad.roles.length ? (
                  <>
                    <TimelineLegend busyLine={cutoffs[1]} hasUncovered={teamLoad.roles.some((r) => r.uncovered)} hasMarkers={teamLoad.markers.length > 0} hasMarket={teamLoad.market.length > 0} />
                    <ForecastTimeline data={teamLoad} rows="roles" cutoffs={cutoffs} label={`How busy each role is per month over the next ${span}, against the ${Math.round(cutoffs[1] * 100)}% too busy line.`} />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No role has any work in this run.</p>
                )
              ) : error ? (
                <p className="text-sm text-muted-foreground">Nothing to show until the company can be simulated.</p>
              ) : (
                <Skeleton className="h-[260px] w-full" aria-busy="true" />
              )}
            </ChartCard>
            <ChartCard id="opened-resolved" title="Issues opened and resolved" note="Per month, over the last six months.">
              <OpenedResolvedChart months={monthsOfIssues} />
            </ChartCard>
            <ChartCard id="before-after" title="Before and after, per solution" note="Each solution against the version it was copied from, over the same 30 simulated runs.">
              {impacts.status === "done" ? (
                <BeforeAfterChart impacts={impacts.impacts} hoursPerWeek={hoursPerWeek} />
              ) : impacts.status === "error" ? (
                <p className="text-sm text-muted-foreground">The before and after couldn&apos;t be worked out: {impacts.error}</p>
              ) : (
                chartLoading()
              )}
            </ChartCard>
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Under the tier's title: the processes' findings counted by rating, worst first. */
function FindingsLine({ groups }: { groups: FindingGroup[] | null }) {
  if (!groups) return <Skeleton className="h-5 w-72 max-w-full" />;
  const counts = countByRating(groups.flatMap((g) => g.insights.filter((i) => !i.issue || i.issue.status === "open" || i.issue.status === "testing").map((i) => i.rating))).filter((c) => c.rating !== "great");
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground" data-findings-counts>
      {counts.map((c, i) => (
        <span key={c.rating} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          <i aria-hidden className="size-2 rounded-full" style={{ background: `var(--rate-${c.rating})` }} />
          <b className="font-semibold text-foreground tabular-nums">{c.count}</b> {RATING_LABELS[c.rating].toLowerCase()}
        </span>
      ))}
    </p>
  );
}
