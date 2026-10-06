"use client";

// Issues on the process page (issue #17): the Issues tab in the map's Insights panel, badges on the steps, Kept out of process-view.tsx so that file only wires it in.

import { isReadOnly } from "@/lib/mode";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FindingRow, IssueRow, ProcessBundle, ScenarioRow, SourceRow } from "@transpera-flow/db";
import { detectBrokenScenarios, resolveMoney, type DetectedIssue, type EngineModel, type RetiredSteps, type SimulationResult, type SuccessMeasureSource } from "@transpera-flow/engine";
import type { FindingDialogOptions } from "@/components/findings/finding-dialog";
import type { FindingsState } from "@/lib/findings/use-findings";
import { pageDetections } from "@/lib/findings/view";
import { processStepIds, processSteps } from "@/lib/process-steps";
import { perceptionGapDetections } from "@/lib/issues/perception";
import { visibleFindings } from "@/lib/rules/edit";
import { useDetectedIssues } from "@/lib/issues/use-detected";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { entryView, mapFeed, promoteInput, registerEntries, stepRatingOf } from "@/lib/issues/register";
import { useIssues } from "@/lib/issues/use-issues";
import { issueFormOptions } from "@/lib/issues/draft";
import { useAbsenceTest } from "@/lib/sim/absence";
import { IssuesRegister } from "./issues-register";
import { InsightsSection } from "./insights";
import type { EditMode } from "./process-view";
import { StepIssueBadges } from "./step-issue-badges";
import type { StepExtras } from "./map/step-detail";
import { namedForViewer, viewerOf } from "@/lib/viewer";

export interface ProcessIssues {
  /** Badges on the map's steps (portals; render anywhere). */
  badges: ReactNode;
  /** The Insights panel: `utilisation` in one tab, the issues in another. */
  rail: (utilisation: ReactNode) => ReactNode;
  /** The process page's Findings list: the accepted findings, each with Acknowledge as issue. */
  insightsList: ReactNode;
  /** The run's facts (the evidence the findings rest on), worst first; null until the run is in. */
  facts: DetectedIssue[] | null;
  /** The process page's Issues section: confirmed issues linked to this process or its steps, with "+ New issue". */
  issuesList: ReactNode;
  /** Switch the rail to its Issues tab (the sidebar's Issues item, on the demo). */
  showIssues: () => void;
  /** Open issues per step, which a closed group on the map adds up. */
  openIssues: Record<string, number>;
  /** A step's worst open-issue rating, which a closed group takes the worst of. */
  rating: (stepId: string) => { rank: number; label: string } | null;
  /** What the analysis found on a step and the confirmed issues on it, for a step's detail on the map. */
  stepExtras: (stepId: string) => StepExtras | null;
  /** The steps to highlight on the map: those of the issue the pointer or focus is on. */
  highlight: string[] | null;
  /** The scenario panel reports its saved scenarios here, so issues can link and run them. */
  onScenariosChange: (scenarios: ScenarioRow[]) => void;
  /** The saved scenarios as the scenario panel last reported them. */
  scenarios: ScenarioRow[];
}

const NO_RETIRED: RetiredSteps = {};
const NO_SOURCES: SourceRow[] = [];

export function useProcessIssues({
  bundle,
  model,
  result,
  running,
  mode,
  initialIssues,
  initialScenarios,
  registerHref,
  retired = NO_RETIRED,
  successMeasures,
  findings,
  findingsState,
  findingOptions,
  onShowIssues,
  sources = NO_SOURCES,
  liveRevisions,
  issueExtra,
}: {
  /** Drawn under each confirmed issue in the page's Issues section (the status track). */
  issueExtra?: (issue: IssueRow) => ReactNode;
  /** This process's findings (B17): the accepted ones are listed, and can be acknowledged as issues. */
  findings?: readonly FindingRow[];
  /** Where a finding is dismissed and edited. */
  findingsState?: FindingsState;
  findingOptions?: FindingDialogOptions;
  bundle: ProcessBundle;
  model: EngineModel | null;
  result: SimulationResult | null;
  running: boolean;
  mode: EditMode;
  initialIssues: IssueRow[];
  initialScenarios: ScenarioRow[];
  /** Link to the full register page, if there is one. */
  registerHref?: string;
  /** Steps the model no longer has and what replaced them, for broken-scenario issues (issue #16). */
  retired?: RetiredSteps;
  /** The process's success measures (its first principles), which rule 11 rates; none rates nothing. */
  successMeasures?: SuccessMeasureSource;
  /** A step's issue badge was clicked: the caller opens the panel the Issues tab is in. */
  onShowIssues?: () => void;
  /** The workspace's sources, which the Acknowledge dialog can link to an issue. */
  sources?: SourceRow[];
  /** Each process's live revision id: a dismissed insight stays away until its process is published again. */
  liveRevisions?: Record<string, string>;
}): ProcessIssues {
  const state = useIssues(bundle.workspace.id, initialIssues, mode, liveRevisions);
  const [scenarios, setScenarios] = useState(initialScenarios);
  const [tab, setTab] = useState<"utilisation" | "issues">("utilisation");
  const [stepFilter, setStepFilter] = useState("");
  const [lit, setLit] = useState<string[] | null>(null);

  // Saved scenarios whose targets no longer resolve raise a broken_scenario issue each (issue #16).
  const broken = useMemo(() => (model ? detectBrokenScenarios(model, scenarios, retired) : []), [model, scenarios, retired]);
  // Every page rates the run with the documented defaults (D40): the rules give facts, not findings.
  const rules = ANALYSIS_DEFAULTS;
  // Perception gaps from the steps' evidence (issue #21), unless that rule is off.
  const gaps = useMemo(() => visibleFindings(rules, perceptionGapDetections(bundle.steps)), [bundle.steps, rules]);
  // The absence test (rule 8) runs in its own worker once the baseline is done; until it returns, that rule raises nothing.
  const absence = useAbsenceTest(model && result && !running ? model : null, result?.seed ?? 1, resolveMoney(rules).absenceWeeks);
  const found = useDetectedIssues(model, result, rules, bundle.process.id, bundle.workspace.settings.currency, absence, successMeasures);
  // The run's facts (D40): evidence, never listed as findings. The list is the accepted findings, and the issues
  // acknowledged before (each costed by its live fact).
  const facts = useMemo(() => (found ? visibleFindings(rules, [...broken, ...found, ...gaps]) : null), [found, broken, gaps, rules]);
  const detected = useMemo(() => (facts ? pageDetections({ findings: findings ?? [], issues: state.issues, facts }) : null), [facts, findings, state.issues]);
  const brokenScenarios = useMemo(() => new Set(broken.flatMap((d) => (d.scenarioId ? [d.scenarioId] : []))), [broken]);

  // A tracked broken-scenario issue resolves itself once its scenario is fixed (re-pointed or deleted).
  const resolving = useRef(new Set<string>());
  const { issues: tracked, saver, promote } = state;
  useEffect(() => {
    if (isReadOnly(mode) || !model) return;
    const still = new Set(broken.map((d) => d.key));
    for (const i of tracked) {
      if (i.type !== "broken_scenario" || !i.detected_key || still.has(i.detected_key)) continue;
      if ((i.status !== "open" && i.status !== "testing") || resolving.current.has(i.id)) continue;
      resolving.current.add(i.id);
      void saver(i.id, "status")(i.status, "resolved").finally(() => resolving.current.delete(i.id));
    }
  }, [mode, model, broken, tracked, saver]);

  // The database logs a perception gap as a tracked issue when it is saved; the demo has no database, so it tracks it here.
  const logged = useRef(new Set<string>());
  useEffect(() => {
    if (mode !== "demo") return;
    for (const g of gaps) {
      if (logged.current.has(g.key) || tracked.some((i) => i.detected_key === g.key)) continue;
      logged.current.add(g.key);
      void promote(promoteInput(g, bundle.process.id, scenarios));
    }
  }, [mode, gaps, tracked, promote, bundle.process.id, scenarios]);
  const entries = useMemo(() => registerEntries(state.issues, detected ?? [], state.revisionOf), [state.issues, state.revisionOf, detected]);
  // Issues on this process, or on none in particular.
  const here = useMemo(
    () =>
      entries.filter((e) => {
        if (e.kind === "detected") return true;
        const { processIds } = entryView(e);
        return processIds.length === 0 || processIds.includes(bundle.process.id);
      }),
    [entries, bundle.process.id],
  );
  // Nothing reaches the map until it is acknowledged (D24): badges count, and colours come from, confirmed issues only.
  const { badges, ratings } = useMemo(() => mapFeed(here), [here]);
  // Per step: the titles of what was found and not acknowledged yet (insights), and of the confirmed issues.
  const extras = useMemo(() => {
    const out = new Map<string, StepExtras>();
    for (const e of here) {
      const v = entryView(e);
      if (!v.open) continue;
      for (const stepId of v.stepIds) {
        const x = out.get(stepId) ?? { insights: [], issues: [] };
        (e.kind === "tracked" ? x.issues : x.insights).push(v.title);
        out.set(stepId, x);
      }
    }
    return out;
  }, [here]);
  const highlight = lit;
  const openCount = here.filter((e) => entryView(e).open).length;

  // Steps of this process and of those inside it, named for the register; the page's sections keep to them.
  const stepIds = useMemo(() => processStepIds(bundle), [bundle]);
  const steps = useMemo(
    () => processSteps(bundle).filter((s) => s.kind !== "start" && s.kind !== "end").map((s) => ({ id: s.id, name: s.name })),
    [bundle],
  );
  const people = namedForViewer(viewerOf(bundle), bundle.people.filter((p) => p.active)).map((p) => ({ id: p.id, name: p.name }));
  const formOptions = useMemo(
    () =>
      issueFormOptions({
        processes: [{ id: bundle.process.id, name: bundle.process.name }],
        steps: processSteps(bundle),
        people: namedForViewer(viewerOf(bundle), bundle.people.filter((p) => p.active)),
        sources,
      }),
    [bundle, sources],
  );

  const stepNames = useMemo(() => new Map(processSteps(bundle).map((s) => [s.id, s.name])), [bundle]);

  const section = (view: "issues") => (
    <IssuesRegister
      issueExtra={issueExtra}
      includeClosed={Boolean(issueExtra)}
      layout="page"
      view={view}
      stepIds={stepIds}
      state={state}
      detected={detected}
      running={running}
      processId={bundle.process.id}
      processes={[{ id: bundle.process.id, name: bundle.process.name }]}
      steps={steps}
      people={people}
      options={formOptions}
      scenarios={scenarios}
      brokenScenarios={brokenScenarios}
      canEdit={!isReadOnly(mode)}
      currency={bundle.workspace.settings.currency}
      stepFilter={stepFilter}
      onStepFilterChange={setStepFilter}
      onHighlight={(id) => setLit(id ? [id] : null)}
    />
  );

  const insights = (
    <InsightsSection
      state={state}
      detected={detected}
      running={running}
      processId={bundle.process.id}
      stepIds={stepIds}
      scenarios={scenarios}
      formOptions={formOptions}
      currency={bundle.workspace.settings.currency}
      stepName={(id) => stepNames.get(id) ?? null}
      onLight={setLit}
      registerHref={registerHref}
      canEdit={!isReadOnly(mode)}
      findings={findingsState}
      findingOptions={findingOptions}
    />
  );

  const rail = (utilisation: ReactNode) => (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="tablist" aria-label="Insights" className="flex gap-0.5 self-start rounded-md bg-muted p-0.5">
        {(
          [
            ["utilisation", "Utilisation"],
            ["issues", `Issues${detected === null ? "" : ` · ${openCount}`}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`rail-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`rail-panel-${id}`}
            onClick={() => setTab(id)}
            className={`rounded-sm px-2.5 py-1 text-xs ${tab === id ? "bg-panel font-semibold text-fg shadow-token" : "text-muted-foreground hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`rail-panel-${tab}`} aria-labelledby={`rail-tab-${tab}`} className="min-w-0">
        {tab === "utilisation" ? (
          utilisation
        ) : (
          <div>
            <IssuesRegister
              layout="rail"
              state={state}
              detected={detected}
              running={running}
              processId={bundle.process.id}
              processes={[{ id: bundle.process.id, name: bundle.process.name }]}
              steps={steps}
              people={people}
              options={formOptions}
              scenarios={scenarios}
              brokenScenarios={brokenScenarios}
              canEdit={!isReadOnly(mode)}
              currency={bundle.workspace.settings.currency}
              stepFilter={stepFilter}
              onStepFilterChange={setStepFilter}
              onHighlight={(id) => setLit(id ? [id] : null)}
            />
            {registerHref && (
              <a href={registerHref} className="mt-2 block text-xs text-fg-2 hover:underline">
                Open the full register →
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return {
    badges: (
      <StepIssueBadges
        badges={badges}
        onOpen={(id) => {
          setStepFilter(id);
          setTab("issues");
          onShowIssues?.();
        }}
      />
    ),
    openIssues: Object.fromEntries(Object.entries(badges).map(([id, b]) => [id, b.count])),
    rating: stepRatingOf(ratings),
    stepExtras: (id) => extras.get(id) ?? null,
    highlight,
    rail,
    insightsList: insights,
    facts,
    issuesList: section("issues"),
    showIssues: () => setTab("issues"),
    onScenariosChange: setScenarios,
    scenarios,
  };
}
