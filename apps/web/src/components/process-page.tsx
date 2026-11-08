"use client";

// The process page (issue #103, A38): a read-only review of one process on a single scrolling column, no tabs and no
// drawers. About this process, Map, Facts from the run (the evidence, B17), Issues and solutions (one section, each issue with its status track), then Supporting data and, closed at the bottom, Sources. Editing happens in the
// Editor (A39), which "✎ Open in Editor" opens; History (A40) lists the earlier versions this page can show.

import { isReadOnly } from "@/lib/mode";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Pencil } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { IssueRow, ProcessBundle, ProcessCategory, ScenarioRow, SourceRow } from "@transpera-flow/db";
import type { ProcessAdminResult } from "@/lib/processes/admin";
import { ProcessHeader } from "@/components/process-header";
import { ProcessDepartmentField } from "@/components/process-department-field";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DepartmentFieldData } from "@/lib/process-page/department";
import { IssueTrackView } from "@/components/issue-track";
import { HeaviestSteps, HoursByRole, KeyPersonPanel, SupportingHeadline, TimeSplit } from "@/components/process-supporting-data";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { FactsList } from "@/components/facts-list";
import type { FactNames } from "@/lib/insights/fact-sentence";
import { capacityBlockers, findGaps, gapInputFromBundle } from "@transpera-flow/db/simulation-gaps";
import { MissingForSimulation } from "@/components/simulation-gaps";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { aboutProcess } from "@/lib/process-page/about";
import { processHeadline, processHours } from "@/lib/process-page/hours";
import { keyPersonRows, timeSplitRows } from "@/lib/process-page/supporting";
import { linkedSolutions, trackOf } from "@/lib/process-page/track";
import { buildSolutionHref } from "@/lib/solutions/links";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { withHorizon } from "@/lib/editor/modes";
import { horizonWeeks, isHorizonMonths } from "@/lib/horizon";
import { processStepIds, processSteps } from "@/lib/process-steps";
import { useSimulation } from "@/lib/sim/use-simulation";
import { ExportMenu } from "@/components/export/export-menu";
import { ratingOfRank } from "@/lib/map/rating";
import { ProcessCanvas } from "./process-canvas";
import { StepBaseValues } from "./step-base-values";
import type { ProcessEditor } from "@/lib/editor/editor";
import type { TierSetup } from "@/lib/tier-setup";
import { ProcessSolutions, type SolutionsData } from "./solutions/process-solutions";
import { NO_SOLUTIONS_DATA } from "@/lib/solutions/cards";
import { useProcessIssues } from "./process-issues";
import { IssuesCard } from "./process-issues-card";
import { useEngineModel, type EditMode } from "@/lib/sim/use-engine-model";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { EDIT_ONLY } from "@/lib/phone";

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
  registerHref,
  settingsHref,
  editCategory,
  editHref,
  historyHref,
  solutions,
  inside = [],
  processPicker,
  notice,
  tierSetup,
  department,
}: {
  /** The Department field of "About this process" (Q4): omitted where there is no workspace to read departments from. */
  department?: DepartmentFieldData;
  /** The tiers and what each service's tier gets, for the step base values (a driver recurrence is read from them). */
  tierSetup?: TierSetup;
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
  registerHref?: string;
  settingsHref?: string;
  /** Saves a new category for this process (a server action bound to it): the Owner and Agency admins; absent for everyone else and on an earlier version. */
  editCategory?: (category: ProcessCategory) => Promise<ProcessAdminResult>;
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
  processPicker?: ReactNode;
  notice?: ReactNode;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const horizonParam = Number(searchParams.get("horizon"));
  // A ?horizon= in the address still sets how far ahead the run looks (the Overview and the Editor use it); this page has no picker.
  const pickedMonths = isHorizonMonths(horizonParam) ? horizonParam : null;
  const { model, error } = useEngineModel(bundle, pickedMonths === null ? null : horizonWeeks(pickedMonths));
  // personTime on: the Supporting data's hours a month by role, person and step come from it.
  const sim = useSimulation(model, 30, 1, { personTime: true });
  const result = sim.run?.result ?? null;

  const sourceTitles = Object.fromEntries(sources.map((s) => [s.id, s.title]));

  // Back to live: the same address without ?version=.
  const backToLive = (() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("version");
    const q = next.toString();
    return q ? `${pathname}?${q}` : pathname;
  })();

  // Solutions: the demo keeps its own in this tab. Each issue's status track and the "Other improvements" read them.
  const inTab = useDemoSolutions();
  const solData = mode === "demo" ? inTab : (solutions?.data ?? NO_SOLUTIONS_DATA);
  const solBase = solutions?.base ?? (mode === "demo" ? "/demo" : "");
  const canBuild = !isReadOnly(mode) && viewingVersion === null && !!solutions?.base;
  const issueExtra = (issue: IssueRow) => (
    <IssueTrackView
      track={trackOf(issue, linkedSolutions(solData, issue.id))}
      base={solBase}
      buildHref={canBuild && (issue.status === "open" || issue.status === "testing") ? buildSolutionHref(solBase, issue, `${solBase}/p/${bundle.process.id}#issues`) : null}
    />
  );

  const old = viewingVersion !== null;
  const stepNameOf = useMemo(() => new Map(processSteps(bundle).map((s) => [s.id, s.name])), [bundle]);

  const issuesUi = useProcessIssues({
    cardView: (c) => (
      <IssuesCard
        {...c}
        loading={c.loading && model !== null}
        base={solBase}
        solutions={solData}
        onShowStep={showGapStep}
        buildHref={(issue) => (canBuild && (issue.status === "open" || issue.status === "testing") ? buildSolutionHref(solBase, issue, `${solBase}/p/${bundle.process.id}#issues`) : null)}
        registerHref={registerHref}
        other={
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
        }
      />
    ),
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
    // A badge on the map takes you down to the issues on that step.
  });

  // What the process still lacks for meaningful numbers (issue #167): the same check as the upload preview, on this version.
  const gaps = useMemo(
    () => (bundle.process.is_company ? [] : [...findGaps(gapInputFromBundle(bundle)), ...capacityBlockers(model)]),
    [bundle, model],
  );
  const [gapStep, setGapStep] = useState<string | null>(null);
  // `?step=<id>` (the Capacity page's bottleneck, the Overview): that step is selected, lit and scrolled to. An id this version doesn't have is ignored.
  const stepParam = searchParams.get("step");
  const linkedStep = useMemo(() => (stepParam && bundle.steps.some((s) => s.id === stepParam) ? stepParam : null), [stepParam, bundle.steps]);
  useEffect(() => {
    if (linkedStep) document.getElementById("map")?.scrollIntoView({ block: "start" });
  }, [linkedStep]);
  // The map is read only here: the step's base values show in its detail with every control off, and nothing they would save is ever sent.
  const readOnlyEditor = useMemo(() => ({ run: () => undefined }) as unknown as ProcessEditor, []);
  const stampNow = useCallback(() => ({ at: new Date().toISOString() }), []);
  const showGapStep = (id: string) => {
    setGapStep(id);
    document.getElementById("map")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // The steps of this process and of the processes inside it, which the wait chart is about (the model may hold more).
  const stepIds = useMemo(() => processStepIds(bundle), [bundle]);
  const factNames = useMemo<FactNames>(
    () => ({ step: (id) => stepNameOf.get(id) ?? null, role: (id) => model?.roles[id]?.name ?? null, person: (id) => model?.people?.[id]?.name ?? null }),
    [stepNameOf, model],
  );
  const unpublished = liveVersion === 0;
  const about = useMemo(() => aboutProcess({ bundle, liveVersion }), [bundle, liveVersion]);
  const supporting = useMemo(
    () =>
      model
        ? {
            headline: processHeadline(model, result, stepIds, tierSetup?.departments ?? null),
            hours: processHours(model, result, stepIds),
            timeSplit: timeSplitRows(model, result, stepIds),
            keyPeople: keyPersonRows(model, result, stepIds),
          }
        : null,
    [model, result, stepIds, tierSetup],
  );

  const exportMenu = (
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
          who: (step) => names.get(step.person_id ?? step.role_id ?? "") ?? null,
        };
      }}
    />
  );

  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <div className="sticky top-0 z-20 flex items-center gap-x-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        {/* Slots arrive from a Server Component; a keyed Fragment keeps React from asking them for keys. */}
        <Fragment key="picker">{processPicker ?? <p className="truncate px-1 font-display text-base font-bold">{bundle.process.name}</p>}</Fragment>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5">
        <Fragment key="notice">{notice}</Fragment>

        <ProcessHeader
          name={bundle.process.name}
          about={about}
          department={department}
          departmentEditor={department && mode === "live" ? <ProcessDepartmentField processId={bundle.process.id} data={department} canEdit /> : undefined}
          editCategory={editCategory}
          status={
            old ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-warn bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-fg">Viewing version {viewingVersion} · read only</span>
                <Button asChild variant="outline" size="sm">
                  <Link href={backToLive}>Back to live</Link>
                </Button>
              </>
            ) : undefined
          }
          inside={
            inside.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-fg-2">Inside:</span>
                {inside.map((c) => (
                  <Link key={c.id} href={c.href} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-panel-2">
                    {c.name}
                  </Link>
                ))}
              </div>
            ) : undefined
          }
          actions={
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={historyHref}>History</Link>
              </Button>
              {editHref && (
                <Button asChild size="sm" className={`bg-edit text-edit-fg hover:bg-edit/90 ${EDIT_ONLY}`} data-edit-entry>
                  <Link href={withHorizon(editHref, pickedMonths)}>
                    <Pencil aria-hidden /> Edit
                  </Link>
                </Button>
              )}
              {exportMenu}
            </>
          }
        />

        <Card id="map" className="scroll-mt-16 gap-0 py-0" aria-labelledby="map-heading">
          <ProcessCanvas
            card={{
              title: "Process map",
              help: {
                label: "Map colours",
                description: "A step is coloured by the worst rating among its confirmed open issues. Red badges count confirmed issues. Facts from the run show under Facts until someone logs an issue.",
                example: "A step with one Bad issue is orange with a badge of 1; a step with only an unconfirmed insight stays plain.",
              },
              below:
                gaps.length > 0 || error ? (
                  <>
                    <MissingForSimulation gaps={gaps} onSelectStep={showGapStep} settingsHref={settingsHref} />
                    {error && (
                      <Alert className="border-crit bg-crit-soft">
                        <AlertDescription className="text-fg">This process can&apos;t be simulated yet: {error}.</AlertDescription>
                      </Alert>
                    )}
                  </>
                ) : undefined,
            }}
            bundle={bundle}
            result={result}
            savedLabel="Saved"
            defaultLanes
            branchNodes
            rating={issuesUi.rating}
            stepExtras={issuesUi.stepExtras}
            highlight={issuesUi.highlight ?? (gapStep ? [gapStep] : linkedStep ? [linkedStep] : null)}
            initialStepId={linkedStep}
            stepBaseValues={(step) => <StepBaseValues bundle={bundle} step={step} editor={readOnlyEditor} stamp={stampNow} tierSetup={tierSetup} readOnly settingsHref={settingsHref} />}
            sourceTitles={sourceTitles}
            // Only while there is a model to run: one that can't be built never starts a run.
            computing={model !== null && sim.status === "running" && sim.run === null}
            emptyAction={
              editHref ? (
                <Button asChild variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry>
                  <Link href={withHorizon(editHref, pickedMonths)}>Open in Editor</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>

        <Card id="run" className="scroll-mt-16" aria-labelledby="run-heading">
          <CardHeader>
            <CardTitle id="run-heading" className="font-display text-base font-bold">
              What the run shows
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {model && supporting ? (
              <>
                <SupportingHeadline headline={supporting.headline} result={result} />
                <div className="grid gap-4 md:grid-cols-2">
                  <section id="facts" aria-labelledby="facts-heading" data-panel="facts" className="flex h-full min-w-0 scroll-mt-16 flex-col rounded-lg bg-muted/40 p-4">
                    <h3 id="facts-heading" className="text-sm font-bold">
                      Facts
                    </h3>
                    <p className="mb-3 text-xs text-fg-3">What the simulation measured. Evidence, not issues: log an issue below when one matters.</p>
                    <FactsList facts={issuesUi.facts} names={factNames} onLight={issuesUi.light} />
                  </section>
                  <HoursByRole hours={supporting.hours} result={result} viewer={bundle.viewer} />
                </div>
                <div id="supporting-data" className="grid scroll-mt-16 gap-4 lg:grid-cols-3">
                  <HeaviestSteps hours={supporting.hours} result={result} />
                  <TimeSplit rows={supporting.timeSplit} result={result} />
                  <KeyPersonPanel rows={supporting.keyPeople} result={result} />
                </div>
              </>
            ) : (
              <p className="text-sm text-fg-2">Nothing to show until the process can be simulated.</p>
            )}
          </CardContent>
        </Card>

        {issuesUi.issuesList}

        <ProcessSources processId={bundle.process.id} name={bundle.process.name} />
      </div>
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
