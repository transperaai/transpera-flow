"use client";

// The Overview (issue #173, B15; before it #100, A35; the department figures are capacity build P6; laid out as a dashboard by
// docs/plans/ui-cleanup.md): the landing page of a workspace, full width:
//
// 1. The header (the workspace, when the numbers were worked out, how many processes) with Export, History and All processes.
// 2. One row of headline tiles: the whole business's clients, MRR ÷ people and DLER (WB1), who is over their utilisation threshold
//    and the open issues.
// 3. The company map (about two thirds of the width, 60% of the screen's height), with Play and the horizon (1, 3 or 6 months; the
//    Sandbox goes further), beside a rail of what needs attention: open issues (OI1) and the busiest people (BP1).
// 4. The charts: team load by role (TL1), where the time goes (WT1), what the time achieves (TA1) and the time split by process (TS2),
//    two to a row from a wide screen, the last one wide when there is an odd number. Then the departments side by side (DS1).
//    Team load, what the time achieves and the time split follow the horizon picked on the map.
//
// Money's figures and People's busiest people and time read the Capacity page's "Today" run, from the same cache (department-cards.tsx).
//
// Two simulations of the company model feed it, in workers, each once:
// - one at the workspace's own length, with today's team, which the facts are rated from (so they don't move with the
//   horizon);
// - one at the horizon picked, month by month, with planned hires, end dates and leave (the forecast's model, B6), which
//   the map plays and the flow efficiency, time split, team load and the forecast's "too busy" alerts read.
// When the two models are the same (the horizon is the workspace's length and nobody joins, leaves or is away), the one
// run serves both.
// The trend charts load on their own.

import type { ScreenMode } from "@/lib/mode";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { ExportMenu } from "@/components/export/export-menu";
import { ratingOfRank } from "@/lib/map/rating";
import { ModelError, toEngineModel, workspacePurposes, type CapacitySetup, type IssueRow, type ProcessBundle, type ProcessPart } from "@transpera-flow/db";
import { resolveMoney, toRatingConfig, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { HorizonPicker } from "@/components/horizon-picker";
import { NO_SELECTION, ProcessCanvas } from "@/components/process-canvas";
import { EmptyState, MetaLine, PageHeader, SectionCard } from "@/components/page-kit";
import { Eyebrow, pageBodyClass } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { OVERVIEW_HORIZONS, horizonLabel, horizonWeeks, isOverviewHorizon, nearestOverviewHorizon } from "@/lib/horizon";
import { perceptionGapDetections } from "@/lib/issues/perception";
import { mapFeed, registerEntries, stepRatingOf } from "@/lib/issues/register";
import { PROCESS_CATEGORY_LABELS } from "@transpera-flow/db";
import { companyMap } from "@/lib/overview/company-map";
import { laneOfProcesses, laneSpecs, type DepartmentLaneInput } from "@/lib/overview/department-lanes";
import { sortFindings } from "@/lib/overview/findings";
import { COMPANY_GROUP, groupByProcess } from "@/lib/overview/by-process";
import { openIssues, timeSplitByProcess } from "@/lib/overview/health";
import { forecastInsights, forecastModel, today } from "@/lib/forecast/forecast";
import { timelineData } from "@/lib/forecast/timeline";
import { calendarMonthStarts } from "@transpera-flow/db/sandbox";
import { hiringAdvice, hiringDelayAt } from "@transpera-flow/db";
import { rerate, visibleFindings } from "@/lib/rules/edit";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { useAbsenceTest } from "@/lib/sim/absence";
import { useSimulation } from "@/lib/sim/use-simulation";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { NO_SOLUTIONS_DATA, type SolutionsData } from "@/lib/solutions/cards";
import { recordHeadline } from "@/app/w/[slug]/headline-actions";
import { headlineNumbers } from "@/lib/overview/headline";
import { useIssues } from "@/lib/issues/use-issues";
import { capacityBaseModel } from "@/lib/capacity/model";
import { HeroKpi } from "@/components/capacity/widgets";
import { BusiestPeople } from "./busiest-people";
import { OPEN_ISSUES_HOW, TIME_SPLIT_HOW, timeAchievesHow } from "./how-texts";
import { PanelActions, PanelHow } from "./panel-how";
import { DepartmentAlerts, DepartmentTiles, StartChecklist, useDepartmentFigures, WholeBusinessHero } from "./department-cards";
import { TeamLoad, teamLoadHow } from "./team-load";
import { WhereTimeGoes } from "./where-time-goes";
import { EDIT_ONLY } from "@/lib/phone";

// The trend charts and the team load timeline load after the map and the cards.
const chartLoading = () => <Skeleton className="h-[180px] w-full" aria-busy="true" />;
const OpenIssuesSummary = dynamic(() => import("./trend-charts").then((m) => m.OpenIssuesSummary), { ssr: false, loading: chartLoading });
const TimeSplitChart = dynamic(() => import("./trend-charts").then((m) => m.TimeSplitChart), { ssr: false, loading: chartLoading });
const TimeAchieves = dynamic(() => import("./time-achieves").then((m) => m.TimeAchieves), { ssr: false, loading: chartLoading });

export interface OverviewProps {
  /** The workspace's name, as the page's title. */
  workspaceName: string;
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Every process at its live revision, for the company map. */
  parts: ProcessPart[];
  /** The company map process at its live revision: where each process sits and the handoff lines (B11). Absent: the default layout. */
  company?: ProcessPart | null;
  /** The departments, tier services and servicing links the map's lanes come from (Q4). Absent: no lanes. */
  laneInput?: DepartmentLaneInput;
  /** Tracked issues: the confirmed ones colour and badge the map. */
  issues: IssueRow[];
  mode: ScreenMode;
  /** The workspace's solutions and their verdicts (the demo reads the ones built in this tab instead). */
  solutions?: SolutionsData;
  /** The ISO date the horizon run starts on (its months are calendar months); today when omitted. Fixed on the demo. */
  startDate?: string;
  /** Where each process's page is, by process id. */
  hrefs: Record<string, string>;
  processesHref: string;
  /** The Issues list, linked from the open issues panel. */
  issuesHref?: string;
  /** Editors only: the Editor on the company map (its draft, handoff lines and publishing), and its History (B11). */
  companyEditHref?: string;
  companyHistoryHref?: string;
  /** Where the workspace's JSON bundle is downloaded (live workspaces only; the demo has none). */
  bundleHref?: string;
  /** The earlier version of the company map being shown (`?version=N`, read only), or null for live. Only the map changes. */
  viewingMapVersion?: number | null;
  /** The Forecast page, linked from the team load chart. */
  forecastHref?: string;
  /**
   * Set up's data for the Money section and the people figures (P6), with `/w/<slug>`. Absent (the demo): no Money section. `model` is the
   * capacity model when the caller has built it already (a test harness); otherwise it is built from `live` as the Capacity page does.
   */
  capacity?: { setup: CapacitySetup; base: string; model?: EngineModel } | null;
}

/** The company's engine model, the same object while it is unchanged. */
function useCompanyModel(bundle: ProcessBundle): {
  model: EngineModel | null;
  error: string | null;
} {
  const resolved = useMemo(() => {
    try {
      return { model: toEngineModel(bundle, { purposes: true }), error: null };
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
const current = (result: SimulationResult | null, model: EngineModel | null): SimulationResult | null => (result && model && Math.abs(result.H - model.horizonWeeks * model.hoursPerWeek) < 1e-6 ? result : null);

/** Shown where a chart has nothing to draw until the company can be simulated. */
const Unavailable = () => <EmptyState data-chart-unavailable>Nothing to show until the company can be simulated.</EmptyState>;

export function Overview({
  workspaceName,
  live,
  parts,
  company,
  laneInput,
  issues,
  mode,
  solutions,
  startDate,
  hrefs,
  processesHref,
  issuesHref,
  companyEditHref,
  companyHistoryHref,
  bundleHref,
  viewingMapVersion = null,
  forecastHref,
  capacity = null,
}: OverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { model: base, error } = useCompanyModel(live);
  const hoursPerWeek = live.workspace.settings.hours_per_week;
  const purposeCategories = useMemo(() => workspacePurposes(live.workspace.settings), [live.workspace.settings]);
  // The department cards' model: the Capacity page's own (a year long), so its "Today" run is shared through the cache.
  const capacityModel = useMemo(() => (capacity?.model ? { model: capacity.model, error: null } : capacity ? capacityBaseModel(live) : { model: null, error: null }), [capacity, live]);
  // Step id → its process's name, for the cards' "Where the time goes" by process.
  const processOfStep = useMemo(() => new Map(parts.flatMap((p) => p.steps.map((st) => [st.id, p.process.name] as const))), [parts]);
  const purposeNames = useMemo(() => Object.fromEntries(purposeCategories.map((c) => [c.key, c.name])), [purposeCategories]);
  // A model handed in (a harness) is not `parts`' company, so its steps' processes come from the model itself.
  const departmentFigures = useDepartmentFigures({ setup: capacity?.setup ?? null, model: capacityModel.model, modelError: capacityModel.error, purposeNames, processOfStep: capacity?.model ? undefined : processOfStep });

  // The horizon: 1, 3 or 6 months (the Sandbox goes further). Until one is picked (or ?horizon= says) it is the nearest of those to the
  // workspace's own length: 3 months for the usual 13 weeks.
  const horizonParam = Number(searchParams.get("horizon"));
  const [picked, setPicked] = useState<number | null>(isOverviewHorizon(horizonParam) ? horizonParam : null);
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
  const months = picked ?? nearestOverviewHorizon(base?.horizonWeeks ?? live.workspace.settings.horizon_weeks);
  const weeks = horizonWeeks(months);
  const span = horizonLabel(months);

  // The run at the horizon: the forecast's model (planned hires, end dates and leave), month by month in calendar months.
  const [start] = useState(() => startDate ?? today());
  const horizon = useMemo(() => {
    const built = forecastModel(live, 1, start);
    if (!built.model) return { model: null, monthStarts: null };
    const model: EngineModel = { ...built.model, horizonWeeks: weeks };
    return {
      model,
      monthStarts: calendarMonthStarts(start, weeks, model.hoursPerWeek),
    };
  }, [live, start, weeks]);
  const horizonModel = error ? null : horizon.model;

  // The same model at the same length: one run serves both (its monthly numbers don't change the rest of it).
  const sameModel = useMemo(() => !!base && !!horizonModel && JSON.stringify(base) === JSON.stringify(horizonModel), [base, horizonModel]);
  const horizonSim = useSimulation(horizonModel, 30, 1, {
    monthly: true,
    monthStarts: horizon.monthStarts,
  });
  const horizonResult = current(horizonSim.status === "done" ? horizonSim.run.result : null, horizonModel);
  // The shared run is kept as the base run, so picking another horizon afterwards doesn't simulate the base again.
  const [shared, setShared] = useState<{
    model: EngineModel;
    result: SimulationResult;
  } | null>(null);
  if (sameModel && base && horizonResult && shared?.result !== horizonResult) setShared({ model: base, result: horizonResult });
  const haveBase = sameModel || (!!shared && shared.model === base);
  const baseSim = useSimulation(haveBase ? null : base);
  const baseResult = sameModel ? horizonResult : shared && shared.model === base ? shared.result : current(baseSim.status === "done" ? baseSim.run.result : null, base);

  // The facts (D40), from the run at the workspace's own length, rated with the documented defaults: evidence, never findings.
  const rules = ANALYSIS_DEFAULTS;
  const absence = useAbsenceTest(base && baseResult ? base : null, baseResult?.seed ?? 1, resolveMoney(rules).absenceWeeks);
  const gaps = useMemo(() => visibleFindings(rules, perceptionGapDetections(parts.flatMap((p) => p.steps))), [rules, parts]);
  // Who gets too busy, and when, over the horizon (B6): "Across the company".
  const forecastFindings = useMemo(() => (horizonModel && horizonResult ? forecastInsights(horizonModel, horizonResult, rules, start) : []), [horizonModel, horizonResult, rules, start]);
  const facts = useMemo(
    () => (base && baseResult ? sortFindings([...visibleFindings(rules, [...rerate(base, baseResult, rules, live.process.id, absence), ...gaps]), ...forecastFindings]) : null),
    [base, baseResult, rules, live.process.id, absence, gaps, forecastFindings],
  );
  // Issues logged here badge the map straight away. Each part is at its live revision.
  const liveRevisions = useMemo(() => Object.fromEntries(parts.map((p) => [p.process.id, p.revision.id])), [parts]);
  const state = useIssues(live.workspace.id, issues, mode, liveRevisions);
  const entries = useMemo(() => registerEntries(state.issues, [], state.revisionOf), [state.issues, state.revisionOf]);
  const feed = useMemo(() => mapFeed(entries), [entries]);
  const rating = useMemo(() => stepRatingOf(feed.ratings), [feed]);

  // Solutions: the workspace's, or on the demo the ones built in this tab.
  const inTab = useDemoSolutions();
  const solutionsData = mode === "demo" ? inTab : (solutions ?? NO_SOLUTIONS_DATA);

  const groups = useMemo(
    () =>
      facts
        ? groupByProcess({
            parts,
            pipelineId: live.process.id,
            facts,
            issues: state.issues,
            solutions: solutionsData.solutions,
          })
        : null,
    [facts, parts, live.process.id, state.issues, solutionsData.solutions],
  );

  // The company map: open groups in place; opening one moves its neighbours.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const map = useMemo(() => companyMap(live, parts, expanded, company), [live, parts, expanded, company]);
  // Department lanes (Q4): Sales and whole business first, then each department; always on here.
  const departmentLanes = useMemo(
    () =>
      laneInput
        ? {
            spec: {
              lanes: laneSpecs(laneInput),
              laneOf: laneOfProcesses(
                parts.map((p) => p.process),
                laneInput,
              ),
            },
            always: true,
          }
        : undefined,
    [laneInput, parts],
  );
  // A pill with each process's category on its card (Q4, with Q3's labels).
  const cardTags = useMemo(() => new Map(parts.map((p) => [p.process.id, PROCESS_CATEGORY_LABELS[p.process.category]] as const)), [parts]);
  const openProcess = (stepId: string) => {
    const process = map.processOfStep.get(stepId);
    const href = process ? hrefs[process] : undefined;
    if (href) router.push(`${href}?step=${encodeURIComponent(stepId)}`);
  };

  const [now] = useState(() => new Date());
  // The agency list's headline numbers (B1 3/3): once the run at the workspace's own horizon and the ratings are in, an editor's
  // browser records them (the server skips it when the stored ones are for the same engine and revisions and under an hour old).
  // Once per set of numbers, so a re-render or a change of horizon and back doesn't ask again.
  const recorded = useRef("");
  useEffect(() => {
    if (mode !== "live" || error || !groups || !horizonModel || !horizonResult) return;
    if (weeks !== live.workspace.settings.horizon_weeks) return;
    const numbers = headlineNumbers(
      horizonModel,
      horizonResult,
      groups.filter((g) => g.id !== COMPANY_GROUP),
    );
    const revisionIds = parts.map((p) => p.revision.id).sort();
    const key = JSON.stringify([live.workspace.id, weeks, revisionIds, numbers]);
    if (recorded.current === key) return;
    recorded.current = key;
    void recordHeadline(live.workspace.id, revisionIds, weeks, numbers).catch(() => {
      recorded.current = "";
    });
  }, [mode, error, groups, horizonModel, horizonResult, weeks, parts, live.workspace.id, live.workspace.settings.horizon_weeks]);
  // Months in the browser's time zone (workspaces have none of their own yet), for this card and the chart alike.
  const open = useMemo(() => openIssues(state.issues, now), [state.issues, now]);

  // The trends.
  const timeSplit = useMemo(() => (horizonModel && horizonResult ? timeSplitByProcess(horizonModel, horizonResult, parts) : null), [horizonModel, horizonResult, parts]);
  const issuesByProcess = useMemo(
    () => (groups ? groups.filter((g) => g.id !== COMPANY_GROUP || g.openIssues > 0).map((g) => ({ id: g.id, name: g.name, count: g.openIssues, href: hrefs[g.id] })) : null),
    [groups, hrefs],
  );
  const cutoffs = useMemo(() => toRatingConfig(rules, hoursPerWeek).rules.busy.cutoffs, [rules, hoursPerWeek]);
  // The Capacity page's "What to do" for this run, and each role's own line (Set up); without Set up the sentence is worked out from the rows.
  const advice = useMemo(
    () => (capacity && horizonModel && horizonResult?.monthly ? hiringAdvice(capacity.setup, horizonResult, (m) => hiringDelayAt(horizonModel.market, m)) : null),
    [capacity, horizonModel, horizonResult],
  );
  const roleLines = useMemo(() => Object.fromEntries((capacity?.setup.roles ?? []).map((r) => [r.id, r.line])), [capacity]);
  const teamLoad = useMemo(() => (horizonModel && horizonResult ? timelineData(horizonModel, horizonResult, live, start) : null), [horizonModel, horizonResult, live, start]);

  // "Last updated": the numbers are simulated each time the page opens, so this is when it opened.
  const updated = useMemo(
    () =>
      now.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [now],
  );

  const peopleReady = !!capacity && departmentFigures.rows.length > 0;
  const overThreshold = departmentFigures.people ? departmentFigures.people.filter((p) => p.over).length : null;
  const risks = open.byRating.find((r) => r.rating === "risk")?.count ?? 0;

  // The charts under the map, in a grid of two from a wide screen; with an odd number the last runs the full width, so a card
  // that isn't there never leaves a hole.
  const charts: { key: string; node: React.ReactNode }[] = [
    {
      key: "team-load",
      node: (
        <SectionCard
          id="team-load"
          section="team-load"
          level={2}
          title="Team load by role"
          description={`When to hire, then how busy each role is month by month over the next ${span}, with planned hires and leave.`}
          action={<PanelHow {...teamLoadHow(span)} />}
          className="min-w-0 flex-1"
        >
          {teamLoad ? (
            teamLoad.roles.length ? (
              <TeamLoad rows={teamLoad.roles} months={teamLoad.months} lines={roleLines} fallbackLine={cutoffs[1]} advice={advice} span={span} sandboxHref={forecastHref} how={false} />
            ) : (
              <EmptyState>No role has any work in this run.</EmptyState>
            )
          ) : error ? (
            <Unavailable />
          ) : (
            <Skeleton className="h-[160px] w-full" aria-busy="true" />
          )}
        </SectionCard>
      ),
    },
    ...(peopleReady
      ? [
          {
            key: "where-time-goes",
            node: <WhereTimeGoes rows={departmentFigures.rows} categories={purposeCategories} failed={!!departmentFigures.failure} className="min-w-0 flex-1" />,
          },
        ]
      : []),
    {
      key: "time-achieves",
      node: (
        <SectionCard
          id="time-achieves"
          section="time-achieves"
          level={2}
          title="What the time achieves"
          description={`Is the team's time going on work clients pay for? Over the next ${span}; change the horizon on the company map.`}
          action={<PanelHow {...timeAchievesHow(span, purposeCategories)} />}
          className="min-w-0 flex-1"
        >
          {horizonResult?.monthly ? (
            <TimeAchieves
              monthly={horizonResult.monthly}
              hoursPerWeek={horizonModel?.hoursPerWeek ?? hoursPerWeek}
              start={start}
              categories={purposeCategories}
              sandboxHref={forecastHref}
              span={span}
              how={false}
            />
          ) : error ? (
            <Unavailable />
          ) : (
            chartLoading()
          )}
        </SectionCard>
      ),
    },
    {
      key: "time-split",
      node: (
        <SectionCard
          id="time-split"
          section="time-split"
          level={2}
          title="Time split by process"
          description={`Of the time work spends in each process over the next ${span}, the share someone is working on it.`}
          action={timeSplit ? <PanelHow {...TIME_SPLIT_HOW} /> : undefined}
          className="min-w-0 flex-1"
        >
          {timeSplit ? <TimeSplitChart rows={timeSplit} months={months} how={false} /> : error ? <Unavailable /> : chartLoading()}
        </SectionCard>
      ),
    },
  ];

  const mapToolbar = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-map-controls title={horizonResult ? `Playing ${span} of work, with planned hires and leave.` : error ? "Nothing to play until the company can be simulated." : `Simulating ${span}…`}>
      <div className="flex items-center gap-1">
        <h2 id="company-map-heading" className="text-sm font-semibold">
          Company map
        </h2>
        <PanelHow
          works="Every process in the business, in a lane for its department. Press play to watch the work move over the horizon picked, with planned hires and leave; expand a process in place, or click it to open its page."
          tells="How work moves between the processes, and where it piles up."
        />
      </div>
      <HorizonPicker weeks={weeks} onChange={pickHorizon} help={false} options={OVERVIEW_HORIZONS} />
      {forecastHref && (
        <Link href={forecastHref} data-sandbox-link className={buttonVariants({ variant: "link", size: "sm" })}>
          Simulate further in the Sandbox
        </Link>
      )}
      {/* What is playing: read out to a screen reader and shown on hover, not a second line in the bar. */}
      <span className="sr-only" data-horizon-note>
        {horizonResult ? `Playing ${span} of work, with planned hires and leave.` : error ? "Nothing to play until the company can be simulated." : `Simulating ${span}…`}
      </span>
    </div>
  );
  return (
    <div>
      <ShellHeader title="Overview" />
      <div className={pageBodyClass()} data-overview>
        <PageHeader
          label="Overview"
          eyebrow={<Eyebrow>Overview</Eyebrow>}
          title={workspaceName}
          meta={
            <MetaLine>
              <span>Last updated {updated}</span>
              <span>
                {parts.length} {parts.length === 1 ? "process" : "processes"}
              </span>
            </MetaLine>
          }
          actionsLabel="Company map"
          actions={
            <>
              {companyEditHref && (
                <Link href={companyEditHref} data-edit-company-map data-edit-entry className={cn(buttonVariants({ variant: "outline", size: "sm" }), EDIT_ONLY)}>
                  <span aria-hidden className="text-edit">
                    ✎
                  </span>
                  Edit company map
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
                  handoffs: true,
                })}
              />
              {companyHistoryHref && (
                <Button asChild variant="outline" size="sm">
                  <Link href={companyHistoryHref} data-company-history>
                    History
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline" size="sm">
                <Link href={processesHref}>
                  All processes
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </>
          }
        />

        {error ? (
          <div className="rounded-xl border border-crit bg-crit-soft px-4 py-3 text-sm" role="alert">
            The company can&apos;t be simulated yet: {error}. The map below still works; fix this under{" "}
            <Link href={processesHref} className="underline">
              Processes
            </Link>
            .
          </div>
        ) : null}

        {/* The headline tiles: one row, every tile the same width. */}
        {capacity &&
          (peopleReady ? (
            <div className="flex min-w-0 flex-col gap-3" data-kpi-row>
              <DepartmentAlerts failure={departmentFigures.failure} />
              <WholeBusinessHero
                setup={capacity.setup}
                base={capacity.base}
                extra={
                  <>
                    <HeroKpi
                      label="Over their utilisation threshold"
                      value={
                        overThreshold !== null ? (
                          <span data-over-threshold>
                            {overThreshold}
                            <span className="text-sm font-medium text-muted-foreground"> of {departmentFigures.people!.length}</span>
                          </span>
                        ) : departmentFigures.failure ? (
                          "—"
                        ) : (
                          <Skeleton className="h-7 w-16" aria-busy="true" aria-label="Who is over their utilisation threshold is being worked out" />
                        )
                      }
                      sub="people, in a simulation of today's clients"
                    />
                    <HeroKpi
                      label="Open issues"
                      value={<span data-open-issues-total>{open.total}</span>}
                      sub={
                        <>
                          {risks} {risks === 1 ? "operational risk" : "operational risks"}
                          {issuesHref && (
                            <>
                              {" · "}
                              <Link href={issuesHref} className="font-medium text-accent hover:underline">
                                Issues →
                              </Link>
                            </>
                          )}
                        </>
                      }
                    />
                  </>
                }
              />
            </div>
          ) : (
            <StartChecklist setup={capacity.setup} base={capacity.base} />
          ))}

        {/* The company map, the full width of the page; what needs attention sits under it. */}
          <section
            id="company-map"
            data-section="company-map"
            data-company-map
            aria-labelledby="company-map-heading"
            className="flex h-[78svh] min-h-[32rem] min-w-0 scroll-mt-16 flex-col overflow-hidden rounded-xl border border-line bg-card [&_[data-process-map]]:rounded-none [&_[data-process-map]]:border-0"
          >
            {viewingMapVersion !== null && (
              <div data-viewing-map-version className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-warn bg-warn-soft px-2.5 py-0.5 text-xs font-medium">Viewing version {viewingMapVersion} of the company map · read only</span>
                <Link href={backToLive} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Back to live
                </Link>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {map.bundle.steps.length ? (
                <ProcessCanvas
                  refitOn={[...expanded].sort().join("|")}
                  bundle={map.bundle}
                  result={horizonResult}
                  selection={NO_SELECTION}
                  rating={rating}
                  expanded={expanded}
                  onExpandedChange={setExpanded}
                  playbackRollUp
                  toolbarStart={mapToolbar}
                  showLanes={false}
                  departmentLanes={departmentLanes}
                  cardTags={cardTags}
                  handoffs
                  height="fill"
                  stepDetail={false}
                  onStepClick={openProcess}
                  computing={horizonModel !== null && horizonSim.status === "running" && horizonSim.run === null}
                />
              ) : (
                <div className="p-4">
                  <EmptyState>No process has been published yet.</EmptyState>
                </div>
              )}
            </div>
          </section>

        {/* Under the map, cards sized by what they hold: open issues beside the busiest people, team load the full width, where the time goes beside what it achieves, then the time split the full width. */}
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2" data-cards data-rail>
            <div data-chart="issues" className={cn("flex min-w-0 flex-col [&>*]:flex-1", !peopleReady && "lg:col-span-2")}>
              <SectionCard
                id="open-issues"
                section="issues"
                level={2}
                title="Open issues"
                description="How many are open, how bad, and where."
                action={
                  <PanelActions how={OPEN_ISSUES_HOW}>
                    {issuesHref && (
                      <Link href={issuesHref} className="text-xs font-medium text-accent hover:underline" data-issues-link>
                        Issues →
                      </Link>
                    )}
                  </PanelActions>
                }
                className="min-w-0"
              >
                <OpenIssuesSummary byRating={open.byRating} byProcess={issuesByProcess ?? []} how={false} />
              </SectionCard>
            </div>
            {peopleReady && (
              <div data-chart="busiest" className="flex min-w-0 flex-col [&>*]:flex-1">
                <BusiestPeople people={departmentFigures.people} failed={!!departmentFigures.failure} capacityHref={`${capacity!.base}/capacity`} />
              </div>
            )}
          {charts.map((c) => (
            <div key={c.key} data-chart={c.key} className={cn("@container flex min-w-0 flex-col", spanFor(c.key, peopleReady))}>
              {c.node}
            </div>
          ))}
        </div>

        {peopleReady && <DepartmentTiles figures={departmentFigures} base={capacity!.base} currency={capacity!.setup.currency} />}
      </div>
    </div>
  );
}

/**
 * How wide each card under the map is, from what it holds (two columns from `lg`): the month-by-month team load and the per-process time split
 * are wide tables, so they take the full width; open issues and the busiest people, and where the time goes and what it achieves, sit in pairs.
 * A pair whose partner isn't shown (no capacity set up) takes the full width, so no row ends in a hole.
 */
function spanFor(key: string, peopleReady: boolean): string | false {
  if (key === "team-load" || key === "time-split") return "lg:col-span-2";
  if (key === "time-achieves" && !peopleReady) return "lg:col-span-2";
  return false;
}
