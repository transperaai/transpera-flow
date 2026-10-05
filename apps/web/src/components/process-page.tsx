"use client";

// The process page (issue #103, A38): a read-only review of one process on a single scrolling column, no tabs and no
// drawers. About this process, First principles, Map, Insights, Issues and solutions (one section, each issue with its status track), then Supporting data and, closed at the bottom, Sources. Editing happens in the
// Editor (A39), which "✎ Open in Editor" opens; History (A40) lists the earlier versions this page can show.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { IssueRow, ProcessBundle, ScenarioRow, SourceRow } from "@transpera-flow/db";
import { RATING_LABELS, type AnalysisSettings, type FirstPrinciples, type Rating } from "@transpera-flow/engine";
import { AboutProcess } from "@/components/about-process";
import { Help } from "@/components/help";
import { IssueTrackView } from "@/components/issue-track";
import { CycleSpreadPanel, KeyPersonPanel, ReworkLoopsPanel, TimeSplit } from "@/components/process-supporting-data";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { AiRead } from "@/components/ai/ai-read";
import type { AiPanelData } from "@/lib/ai/types";
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
import { processStepIds } from "@/lib/process-steps";
import { useSimulation } from "@/lib/sim/use-simulation";
import { ProcessCanvas } from "./process-canvas";
import { ProcessSolutions, type SolutionsData } from "./solutions/process-solutions";
import { NO_SOLUTIONS_DATA } from "@/lib/solutions/cards";
import { useProcessIssues } from "./process-issues";
import { useEngineModel, type EditMode } from "./process-view";
import { ServicingBanner } from "./servicing-banner";
import { UtilisationBars } from "./utilisation-bars";
import { WaitByStep } from "./wait-by-step";

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
  analysisRules,
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
  ai,
  aboutInfo,
  ideaIssueIds = [],
}: {
  /** What "About this process" needs from the server: where the process sits on the company map, whether a draft is open, and who last changed it. */
  aboutInfo?: { trail: string[]; hasDraft: boolean; lastChange: { at: string | null; by: string } | null };
  /** Issues with an AI solution idea waiting, for the status track's "Solution idea". */
  ideaIssueIds?: readonly string[];
  /** What AI wrote about the version on screen (A46): its read, and the insights that join the list marked AI. */
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
  analysisRules?: AnalysisSettings;
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
  const canBuild = mode !== "readonly" && viewingVersion === null && !!solutions?.base;
  const ideaSet = useMemo(() => new Set(ideaIssueIds), [ideaIssueIds]);
  const issueExtra = (issue: IssueRow) => (
    <IssueTrackView
      track={trackOf(issue, linkedSolutions(solData, issue.id), ideaSet.has(issue.id))}
      base={solBase}
      buildHref={canBuild && (issue.status === "open" || issue.status === "testing") ? buildSolutionHref(solBase, issue, `${solBase}/p/${bundle.process.id}#issues`) : null}
    />
  );

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
    rulesHref: settingsHref ? `${settingsHref}/rules` : mode === "demo" ? "/demo/settings/rules" : undefined,
    analysisRules,
    sources,
    // A dismissed insight is measured against the live revision; an earlier version or a draft isn't one.
    liveRevisions: liveRevisions ?? (viewingVersion === null && liveVersion > 0 ? { [bundle.process.id]: bundle.revision.id } : undefined),
    successMeasures,
    aiInsights: ai?.view?.insights,
    // A badge on the map takes you down to the issues on that step.
    onShowIssues: () => document.getElementById("issues")?.scrollIntoView({ behavior: "smooth", block: "start" }),
  });

  const old = viewingVersion !== null;
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
            <Button asChild variant="outline">
              <Link href={historyHref}>History</Link>
            </Button>
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
            canEdit={mode !== "readonly" && !old}
            draftChanged={firstPrinciples?.draftChanged}
            inheritedFrom={firstPrinciples?.inheritedFrom}
          />
        </Section>

        <Section
          id="map"
          title="Map"
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

        <Section
          id="insights"
          title="Insights"
          hint="What the analysis found in the latest run. Nothing reaches the map until someone confirms it."
        >
          <div className="flex flex-col gap-3">
            {ai && <AiRead mode={mode} scope="process" processId={bundle.process.id} ai={ai} firstPrinciplesHref={firstPrinciples?.href} canRun={!old && !unpublished} />}
            {issuesUi.insightsList}
          </div>
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
              <UtilisationBars model={model} result={result} />
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
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  help?: { label: string; description: string; example: string };
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex min-w-0 scroll-mt-16 flex-col gap-3">
      <div>
        <div className="flex items-center">
          <h2 id={`${id}-heading`} className="font-display text-lg font-bold">
            {title}
          </h2>
          {help && <Help {...help} />}
        </div>
        {hint && <p className="text-sm text-fg-2">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
