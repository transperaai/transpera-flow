"use client";

// The process page (issue #103, A38): a read-only review of one process on a single scrolling column, no tabs and no
// drawers. About this process, First principles, Map, Findings (the AI analysis with its review list, and the accepted
// findings), Facts from the run (the evidence, B17), Issues and solutions (one section, each issue with its status track), then Supporting data and, closed at the bottom, Sources. Editing happens in the
// Editor (A39), which "✎ Open in Editor" opens; History (A40) lists the earlier versions this page can show.

import { isReadOnly } from "@/lib/mode";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { FindingRow, IssueRow, ProcessBundle, ScenarioRow, SourceRow } from "@transpera-flow/db";
import { RATING_LABELS, type FirstPrinciples, type Rating } from "@transpera-flow/engine";
import { AboutProcess } from "@/components/about-process";
import { Help } from "@/components/help";
import { IssueTrackView } from "@/components/issue-track";
import { CycleSpreadPanel, KeyPersonPanel, ReworkLoopsPanel, TimeSplit } from "@/components/process-supporting-data";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { AnalysisPanel } from "@/components/findings/analysis-panel";
import { FactsList } from "@/components/findings/facts-list";
import type { FindingDialogOptions } from "@/components/findings/finding-dialog";
import { analyseProcess } from "@/app/w/[slug]/ai-actions";
import type { AiPanelData } from "@/lib/ai/types";
import { demoAnalyse } from "@/lib/findings/demo";
import { useFindings } from "@/lib/findings/use-findings";
import { findingsIn, proposedFindings } from "@/lib/findings/view";
import { FirstPrinciplesCard } from "@/components/first-principles/first-principles-card";
import { findGaps, gapInputFromBundle } from "@transpera-flow/db/simulation-gaps";
import { MissingForSimulation } from "@/components/simulation-gaps";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { aboutProcess } from "@/lib/process-page/about";
import { cycleSpread, keyPersonRows, loopRows, timeSplitRows } from "@/lib/process-page/supporting";
import { linkedSolutions, trackOf } from "@/lib/process-page/track";
import { buildSolutionHref } from "@/lib/solutions/links";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { withHorizon } from "@/lib/editor/modes";
import { useDemoFirstPrinciples } from "@/lib/first-principles/demo-store";
import { useSuccessMeasures } from "@/lib/first-principles/use-measures";
import { horizonWeeks, isHorizonMonths } from "@/lib/horizon";
import { processStepIds, processSteps } from "@/lib/process-steps";
import { useSimulation } from "@/lib/sim/use-simulation";
import { ExportMenu } from "@/components/export/export-menu";
import { ratingOfRank } from "@/lib/map/rating";
import { ProcessCanvas } from "./process-canvas";
import { ProcessSolutions, type SolutionsData } from "./solutions/process-solutions";
import { NO_SOLUTIONS_DATA } from "@/lib/solutions/cards";
import { useProcessIssues } from "./process-issues";
import { useEngineModel, type EditMode } from "./process-view";
import { ServicingBanner } from "./servicing-banner";
import { UtilisationBars } from "./utilisation-bars";
import { WaitByStep } from "./wait-by-step";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { PLAY_HELP, PlaySection, type PlayConfig } from "@/components/share/play-section";

const NO_FINDINGS: FindingRow[] = [];

const RATING_PILL: Record<Rating, string> = {
  risk: "border-crit bg-crit-soft",
  bad: "border-serious bg-crit-soft/60",
  good: "border-warn bg-warn-soft",
  great: "border-line bg-panel-2",
};

/** A process inside this one, for the "Inside:" chips. */
export interface ChildProcess {
  id: string;
  name: string;
  href: string;
}

export function ProcessPage({
  bundle,
  viewingVersion = null,
  liveVersion,
  mode,
  scenarios = [],
  issues = [],
  sources = [],
  liveRevisions,
  rating,
  registerHref,
  settingsHref,
  editHref,
  historyHref,
  solutions,
  inside = [],
  firstPrinciples,
  processPicker,
  notice,
  play,
  ai,
  findings: initialFindings = NO_FINDINGS,
  aboutInfo,
  ideaIssueIds = [],
  share,
}: {
  /** The Share button (owners and editors, B3), made by the page that knows what is shared. */
  share?: ReactNode;
  /** The workspace's findings (B17): this process's accepted ones are listed, its proposed ones wait for review. */
  findings?: FindingRow[];
  /** What "About this process" needs from the server: where the process sits on the company map, whether a draft is open, and who last changed it. */
  aboutInfo?: { trail: string[]; hasDraft: boolean; lastChange: { at: string | null; by: string } | null };
  /** Issues with an AI solution idea waiting, for the status track's "Solution idea". */
  ideaIssueIds?: readonly string[];
  /** The latest AI analysis of this process (B17): its read, when and by what it was written, and whether it is out of date. */
  ai?: AiPanelData;
  /** The process at the version on screen: live, or an earlier one when `viewingVersion` is set. */
  bundle: ProcessBundle;
  /** The earlier version being shown (`?version=N`), or null for live. */
  viewingVersion?: number | null;
  /** The live version's number, 0 if never published. */
  liveVersion: number;
  /** How issues are saved: to the database, in memory on the demo, or not at all for viewers. The process itself is never edited here. */
  mode: EditMode;
  scenarios?: ScenarioRow[];
  issues?: IssueRow[];
  sources?: SourceRow[];
  /** Each process's live revision id, which a dismissed insight is measured against. Omitted: this bundle's, when it is the live one. */
  liveRevisions?: Record<string, string>;
  /** The process's rating: the worst of its open issues and of those of the processes inside it, as the switcher shows it. */
  rating?: Rating | null;
  registerHref?: string;
  settingsHref?: string;
  /** The Editor for this process, if the viewer may edit. */
  editHref?: string;
  /** The History page (A40, not built yet): a plain link to its route. */
  historyHref: string;
  /**
   * This process's solutions and where the Editor lives for them (A49): `base` is `/w/<slug>` or `/demo`. The section lists them,
   * and offers New solution and Build solution to those who can edit.
   */
  solutions?: { data: SolutionsData; base: string; viewerId?: string | null; memberNames?: Readonly<Record<string, string>> };
  /** Processes inside this one. */
  inside?: ChildProcess[];
  /** The version's first principles for the card at the top (A54); on the demo the answers edited in this tab replace `doc`. */
  firstPrinciples?: { doc: FirstPrinciples | null; href: string; draftChanged?: boolean; inheritedFrom?: number | null };
  processPicker?: ReactNode;
  notice?: ReactNode;
  /** A play link's visitor (B4): shows "Try your own changes" after the map, with the levers the workspace shows and "Send this idea". Nowhere else renders levers on this page. */
  play?: PlayConfig;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const horizonParam = Number(searchParams.get("horizon"));
  // A ?horizon= in the address still sets how far ahead the run looks (the Overview and the Editor use it); this page has no picker.
  const pickedMonths = isHorizonMonths(horizonParam) ? horizonParam : null;
  const { model, error } = useEngineModel(bundle, pickedMonths === null ? null : horizonWeeks(pickedMonths));
  const sim = useSimulation(model);
  const result = sim.run?.result ?? null;

  const sourceTitles = Object.fromEntries(sources.map((s) => [s.id, s.title]));

  // Back to live: the same address without ?version=.
  const backToLive = (() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("version");
    const q = next.toString();
    return q ? `${pathname}?${q}` : pathname;
  })();

  // First principles (A54): the card shows them, and their success measures feed rule 11 (goals met) in the insights.
  const demoFirstPrinciples = useDemoFirstPrinciples(bundle.process.id);
  const fpDoc = mode === "demo" ? demoFirstPrinciples : (firstPrinciples?.doc ?? null);
  const successMeasures = useSuccessMeasures(bundle.process.id, mode === "demo", firstPrinciples?.doc);

  // Solutions: the demo keeps its own in this tab. Each issue's status track and the "Other improvements" read them.
  const inTab = useDemoSolutions();
  const solData = mode === "demo" ? inTab : (solutions?.data ?? NO_SOLUTIONS_DATA);
  const solBase = solutions?.base ?? (mode === "demo" ? "/demo" : "");
  const canBuild = !isReadOnly(mode) && viewingVersion === null && !!solutions?.base;
  const ideaSet = useMemo(() => new Set(ideaIssueIds), [ideaIssueIds]);
  const issueExtra = (issue: IssueRow) => (
    <IssueTrackView
      track={trackOf(issue, linkedSolutions(solData, issue.id), ideaSet.has(issue.id))}
      base={solBase}
      buildHref={canBuild && (issue.status === "open" || issue.status === "testing") ? buildSolutionHref(solBase, issue, `${solBase}/p/${bundle.process.id}#issues`) : null}
    />
  );

  // Findings (B17): this process's and those of the processes inside it. Written in the live version only.
  const old = viewingVersion !== null;
  const findingsState = useFindings(bundle.workspace.id, initialFindings, mode === "demo" || mode === "share" ? mode : mode === "live" && !old ? "live" : "readonly");
  const scope = useMemo(() => {
    const steps = processSteps(bundle);
    const ids = new Set(steps.map((s) => s.id));
    const processIds = new Set([bundle.process.id, ...(bundle.otherProcesses ?? []).filter((o) => o.steps.some((s) => ids.has(s.id))).map((o) => o.process.id)]);
    const processOfStep = new Map<string, string>([...bundle.steps.map((s) => [s.id, bundle.process.id] as const), ...(bundle.otherProcesses ?? []).flatMap((o) => o.steps.map((s) => [s.id, o.process.id] as const))]);
    const options: FindingDialogOptions = {
      processes: [bundle.process, ...(bundle.otherProcesses ?? []).map((o) => o.process)].filter((p) => processIds.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
      company: false,
      steps: steps.filter((s) => s.kind !== "start" && s.kind !== "end").map((s) => ({ id: s.id, name: s.name, processId: processOfStep.get(s.id) ?? bundle.process.id })),
    };
    return { processIds, options };
  }, [bundle]);
  const ownFindings = useMemo(() => findingsIn(findingsState.findings, { processIds: scope.processIds }), [findingsState.findings, scope]);
  const stepNameOf = useMemo(() => new Map(processSteps(bundle).map((s) => [s.id, s.name])), [bundle]);

  const issuesUi = useProcessIssues({
    issueExtra,
    bundle,
    model,
    result,
    running: sim.status === "running",
    mode,
    initialIssues: issues,
    initialScenarios: scenarios,
    registerHref,
    sources,
    // A dismissed insight is measured against the live revision; an earlier version or a draft isn't one.
    liveRevisions: liveRevisions ?? (viewingVersion === null && liveVersion > 0 ? { [bundle.process.id]: bundle.revision.id } : undefined),
    successMeasures,
    findings: ownFindings,
    findingsState,
    findingOptions: scope.options,
    // A badge on the map takes you down to the issues on that step.
    onShowIssues: () => document.getElementById("issues")?.scrollIntoView({ behavior: "smooth", block: "start" }),
  });

  // What the process still lacks for meaningful numbers (issue #167): the same check as the upload preview, on this version.
  const gaps = useMemo(() => (bundle.process.is_company ? [] : findGaps(gapInputFromBundle(bundle))), [bundle]);
  const [gapStep, setGapStep] = useState<string | null>(null);
  const showGapStep = (id: string) => {
    setGapStep(id);
    document.getElementById("map")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // The steps of this process and of the processes inside it, which the wait chart is about (the model may hold more).
  const stepIds = useMemo(() => processStepIds(bundle), [bundle]);
  const unpublished = liveVersion === 0;
  const linking = useSourceLinking();
  const about = useMemo(() => {
    const ids = new Set([bundle.process.id, ...(bundle.otherProcesses ?? []).map((o) => o.process.id)]);
    const linked = linking
      ? new Set(linking.links.filter((l) => (l.kind === "process" && l.process_id && ids.has(l.process_id)) || (l.kind === "step" && l.step_id && stepIds.has(l.step_id))).map((l) => l.source_id))
      : null;
    return aboutProcess({ bundle, doc: fpDoc, trail: aboutInfo?.trail ?? [], liveVersion, hasDraft: aboutInfo?.hasDraft ?? false, sources: linked ? linked.size : null, lastChange: aboutInfo?.lastChange ?? null });
  }, [bundle, fpDoc, aboutInfo, liveVersion, linking, stepIds]);
  const supporting = useMemo(
    () =>
      model
        ? {
            timeSplit: timeSplitRows(model, result, stepIds),
            spread: cycleSpread(result),
            keyPeople: keyPersonRows(model, result, stepIds),
            loops: loopRows(model, result, { processId: bundle.process.id, stepIds, issues, solutions: solData.solutions.filter((s) => s.process_id === bundle.process.id) }),
          }
        : null,
    [model, result, stepIds, bundle.process.id, issues, solData.solutions],
  );

  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <div className="sticky top-0 z-20 flex items-center gap-x-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        {/* Slots arrive from a Server Component; a keyed Fragment keeps React from asking them for keys. */}
        <Fragment key="picker">{processPicker ?? <h1 className="truncate px-1 font-display text-base font-bold">{bundle.process.name}</h1>}</Fragment>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3" aria-label="Process">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
            {old ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-warn bg-warn-soft px-2.5 py-0.5 text-xs font-medium">
                  Viewing version {viewingVersion} · read only
                </span>
                <Button asChild variant="outline" size="sm">
                  <Link href={backToLive}>Back to live</Link>
                </Button>
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 py-0.5 text-xs font-medium">
                <i aria-hidden className="size-1.5 rounded-full bg-accent" />
                {unpublished ? "Viewing the draft · not published yet" : `Viewing live · version ${liveVersion}`}
              </span>
            )}
            {rating && (
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${RATING_PILL[rating]}`} data-process-rating={rating}>
                {RATING_LABELS[rating]}
                <Help
                  label="Process rating"
                  description="The worst rating among the confirmed open issues on this process and the processes inside it: Great, Good, Bad or Operational risk. Insights nobody has confirmed yet don't count."
                  example="Bad, not urgent: one confirmed issue is rated Bad and none is worse."
                />
              </span>
            )}
            {inside.length > 0 && (
              <>
                <span className="ml-1.5 text-xs text-fg-2">Inside:</span>
                {inside.map((c) => (
                  <Link key={c.id} href={c.href} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-panel-2">
                    {c.name}
                  </Link>
                ))}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {share}
            {mode !== "share" && (
              <Button asChild variant="outline">
                <Link href={historyHref}>History</Link>
              </Button>
            )}
            {editHref && (
              <Button asChild className="bg-edit text-edit-fg hover:bg-edit/90">
                <Link href={withHorizon(editHref, pickedMonths)}>✎ Open in Editor</Link>
              </Button>
            )}
          </div>
        </header>

        {(notice || bundle.process.kind === "servicing" || error || gaps.length > 0) && (
          <div className="flex flex-col gap-2">
            <Fragment key="notice">{notice}</Fragment>
            <MissingForSimulation gaps={gaps} onSelectStep={showGapStep} settingsHref={settingsHref} />
            {bundle.process.kind === "servicing" && <ServicingBanner bundle={bundle} settingsHref={settingsHref} />}
            {error && (
              <Alert className="border-crit bg-crit-soft">
                <AlertDescription className="text-fg">This process can&apos;t be simulated yet: {error}.</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <AboutProcess about={about} />

        <Section
          id="first-principles"
          title="First principles"
        >
          <FirstPrinciplesCard
            bundle={bundle}
            doc={fpDoc}
            model={model}
            result={result}
            href={firstPrinciples?.href ?? "#first-principles"}
            canEdit={!isReadOnly(mode) && !old}
            draftChanged={firstPrinciples?.draftChanged}
            inheritedFrom={firstPrinciples?.inheritedFrom}
          />
        </Section>

        <Section
          id="map"
          title="Map"
          action={
            <ExportMenu
              name={bundle.process.name}
              note="Groups are drawn open."
              input={() => {
                const names = new Map([...bundle.roles.map((r) => [r.id, r.name] as const), ...namedForViewer(viewerOf(bundle), bundle.people).map((x) => [x.id, x.name] as const)]);
                return {
                  title: bundle.process.name,
                  subtitle: old ? `Version ${viewingVersion}` : unpublished ? "Draft, not published yet" : `Live, version ${liveVersion}`,
                  steps: bundle.steps,
                  edges: bundle.edges,
                  expanded: "all",
                  rating: (id) => {
                    const r = issuesUi.rating(id);
                    return r ? ratingOfRank(r.rank) : null;
                  },
                  issues: issuesUi.openIssues,
                  who: (step) => names.get(step.person_id ?? step.role_id ?? "") ?? null,
                };
              }}
            />
          }
          hint="Coloured by rating. Red badges are confirmed issues. Click a step for detail."
          help={{
            label: "Map colours",
            description: "A step is coloured by the worst rating among its confirmed open issues. Red badges count confirmed issues. Things the analysis only noticed show under Insights until someone confirms them.",
            example: "A step with one Bad issue is orange with a badge of 1; a step with only an unconfirmed insight stays plain.",
          }}
        >
          <ProcessCanvas
            bundle={bundle}
            result={result}
            savedLabel="Saved"
            openIssues={issuesUi.openIssues}
            rating={issuesUi.rating}
            stepExtras={issuesUi.stepExtras}
            highlight={issuesUi.highlight ?? (gapStep ? [gapStep] : null)}
            sourceTitles={sourceTitles}
          />
        </Section>

        {play && model && (
          <Section id="try-changes" title="Try your own changes" hint="Move the levers the team shows to see what would change. Nothing is saved unless you send it." help={PLAY_HELP.section}>
            <PlaySection model={model} baseline={sim.run} bundle={bundle} play={play} />
          </Section>
        )}

        <Section id="insights" title="Findings" hint="What AI and your team concluded from the facts. Nothing reaches the map until someone acknowledges it as an issue.">
          <div className="flex flex-col gap-3">
            {ai && (
              <AnalysisPanel
                mode={mode}
                scope="process"
                ai={ai}
                findings={findingsState}
                proposed={proposedFindings(ownFindings)}
                options={scope.options}
                defaultProcessId={bundle.process.id}
                stepName={(id) => stepNameOf.get(id) ?? null}
                analyse={(force) => (mode === "demo" ? demoAnalyse(findingsState, bundle.process.id) : analyseProcess(bundle.process.id, force))}
                facts={issuesUi.facts}
                canRun={!old && !unpublished}
                firstPrinciplesHref={firstPrinciples?.href}
              />
            )}
            {issuesUi.insightsList}
          </div>
        </Section>

        <Section id="facts" title="Facts from the run" hint="What the simulation measured. These are evidence, not findings: AI and your team draw findings from them.">
          <FactsList facts={issuesUi.facts} currency={bundle.workspace.settings.currency} stepName={(id) => stepNameOf.get(id) ?? null} />
        </Section>

        <Section
          id="issues"
          title="Issues and solutions"
          hint="Each issue with its solutions, and how far it has got. Solutions never change the live map."
        >
          {issuesUi.issuesList}
          {registerHref && (
            <Link href={registerHref} className="mt-2 block text-xs text-fg-2 hover:underline">
              Open the full register →
            </Link>
          )}
          <div id="solutions" className="mt-2 flex scroll-mt-16 flex-col gap-2">
            <h3 className="text-sm font-bold">Other improvements</h3>
            <p className="-mt-1.5 text-xs text-fg-3">Solutions that are not for a particular issue.</p>
            <ProcessSolutions
              otherOnly
              processId={bundle.process.id}
              processName={bundle.process.name}
              viewerId={solutions?.viewerId}
              memberNames={solutions?.memberNames}
              base={solBase}
              demo={mode === "demo"}
              canEdit={canBuild}
              data={solutions?.data ?? NO_SOLUTIONS_DATA}
              issues={issues}
            />
          </div>
        </Section>

        <Section id="supporting-data" title="Supporting data" hint="From the latest run.">
          {model && supporting ? (
            <div className="grid gap-3 md:grid-cols-2">
              <WaitByStep model={model} result={result} stepIds={stepIds} />
              <UtilisationBars model={model} result={result} viewer={bundle.viewer} />
              <TimeSplit rows={supporting.timeSplit} result={result} />
              <CycleSpreadPanel spread={supporting.spread} hoursPerWeek={model.hoursPerWeek} result={result} />
              <KeyPersonPanel rows={supporting.keyPeople} result={result} />
              <div className="min-w-0 md:col-span-2">
                <ReworkLoopsPanel rows={supporting.loops} result={result} hoursPerWeek={model.hoursPerWeek} base={solBase} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-fg-2">Nothing to show until the process can be simulated.</p>
          )}
        </Section>

        <ProcessSources processId={bundle.process.id} name={bundle.process.name} />
      </div>
      {issuesUi.badges}
    </div>
  );
}

/**
 * The sources that are evidence for the whole process, with "+ Link", in a section at the very bottom that starts closed
 * (and opens for a #sources address). A heading holding a button that opens and closes it. Only where the page loads source
 * links (the others have nothing to show).
 */
function ProcessSources({ processId, name }: { processId: string; name: string }) {
  const linking = useSourceLinking();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash !== "#sources") return;
      setOpen(true);
      document.getElementById("sources")?.scrollIntoView({ block: "start" });
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  if (!linking) return null;
  return (
    <section id="sources" aria-labelledby="sources-heading" className="min-w-0 scroll-mt-16 rounded-xl border bg-card">
      <h2 id="sources-heading" className="font-display text-lg font-bold">
        <button type="button" aria-expanded={open} aria-controls="sources-body" onClick={() => setOpen((o) => !o)} className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left">
          <ChevronRight aria-hidden className={`size-4 shrink-0 text-fg-2 transition-transform ${open ? "rotate-90" : ""}`} />
          Sources
          <span className="text-sm font-normal text-fg-2">The interviews, notes and data that are evidence for this process as a whole.</span>
        </button>
      </h2>
      <div id="sources-body" hidden={!open} className="px-4 pb-4">
        <LinkedSources target={{ kind: "process", processId }} label={`Process: ${name}`} empty="No source linked to this process yet." hideTitle className="flex flex-col gap-2" />
      </div>
    </section>
  );
}

function Section({
  id,
  title,
  hint,
  help,
  action,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  help?: { label: string; description: string; example: string };
  /** Sits at the right of the heading (the map's Export menu). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex min-w-0 scroll-mt-16 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center">
            <h2 id={`${id}-heading`} className="font-display text-lg font-bold">
              {title}
            </h2>
            {help && <Help {...help} />}
          </div>
          {hint && <p className="text-sm text-fg-2">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
