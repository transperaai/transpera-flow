"use client";

// The process page (issue #103, A38), on the detail-page template the Issue and Solution pages share (components/issues/detail-layout.tsx):
// the breadcrumb (Processes, then the process switcher), a flat header (the process name, its Live or Draft pill and version, its rating,
// category and department, the key numbers, History, Edit and Export), then from `xl` a main column beside a sticky metadata rail. The
// main column: the process map (its own toolbar, zoom, playback and step detail), What the process shows (the headline, the facts from
// the run, B17, and the supporting data), Issues and solutions (each issue with its status track) and Sources (the process's notes and
// its linked sources). Under `xl` the rail stacks under the main column. Links into the page (#issues, #sources, #run, ...) scroll to
// their section. Editing happens in the Editor (A39), which Edit opens; History (A40) lists the earlier versions this page can show.

import { isReadOnly } from "@/lib/mode";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { IssueRow, ProcessBundle, ProcessCategory, ScenarioRow, SourceRow } from "@transpera-flow/db";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import type { ProcessAdminResult } from "@/lib/processes/admin";
import { ProcessHeader } from "@/components/process-header";
import { ProcessDepartmentField } from "@/components/process-department-field";
import type { DepartmentFieldData } from "@/lib/process-page/department";
import { IssueTrackView } from "@/components/issue-track";
import { HeaviestSteps, HoursByRole, KeyPersonPanel, SupportingHeadline, TimeSplit } from "@/components/process-supporting-data";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { FactsList } from "@/components/facts-list";
import { EditableText } from "@/components/page-kit/editable-text";
import type { FactNames } from "@/lib/insights/fact-sentence";
import { capacityBlockers, findGaps, gapInputFromBundle } from "@transpera-flow/db/simulation-gaps";
import { MissingForSimulation } from "@/components/simulation-gaps";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DetailLayout, EditMarker, MetaRail, RailItem } from "@/components/issues/detail-layout";
import { SectionCard } from "@/components/page-kit";
import { Help } from "@/components/help";
import { shortDate } from "@/lib/issues/pages";
import { formatWholeCurrency } from "@/lib/format";
import { aboutProcess } from "@/lib/process-page/about";
import { processHeadline, processHours, type ProcessHours } from "@/lib/process-page/hours";
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
  breadcrumb,
  lastPublished = null,
  notice,
  tierSetup,
  department,
  notes,
}: {
  /**
   * The process's notes, shown in Sources above the linked sources (like a solution's "Notes and sources"). `save` stores the new text
   * and returns a sentence when it failed, null when it saved; absent, the notes are read only. Omitted: no notes field at all.
   */
  notes?: { value: string | null; save?: (next: string) => Promise<string | null> };
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
  /** The breadcrumb above the header: Processes, the processes it sits inside, then the process switcher (ProcessNav `part="crumbs"`). */
  breadcrumb: ReactNode;
  /** When the live version was published, for the rail; null when it never was. */
  lastPublished?: string | null;
  /** Above the breadcrumb: the archived banner. */
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
  // A link into the page (`#issues` from an issue or a solution, `#issue-<id>`, `#sources`, `#run`, ...) scrolls to its section once it
  // has drawn: some (an issue's row) arrive after the first paint, which the browser's own jump to the anchor misses.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }, []);
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

  // The process's rating: the worst on its steps (the map's colours), none when nothing is rated.
  const processRating = (() => {
    const worst = Math.max(-1, ...processSteps(bundle).map((st) => issuesUi.rating(st.id)?.rank ?? -1));
    return ratingOfRank(worst);
  })();
  const currency = bundle.workspace.settings.currency || "GBP";
  const monthCost = model && supporting ? costAMonth(model, result, supporting.hours) : null;
  const hoursAMonth = supporting?.hours && supporting.hours.total > 0 ? supporting.hours.total : null;

  const exportMenu = (
    <ExportMenu
      size="default"
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

  const editLink = editHref ? withHorizon(editHref, pickedMonths) : null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Slots arrive from a Server Component; a keyed Fragment keeps React from asking them for keys. */}
      {notice && <Fragment key="notice">{notice}</Fragment>}
      <DetailLayout
        data-process-page={bundle.process.id}
        breadcrumb={<Fragment key="crumbs">{breadcrumb}</Fragment>}
        header={
          <ProcessHeader
            name={bundle.process.name}
            about={about}
            rating={processRating}
            department={department}
            departmentEditor={department && mode === "live" ? <ProcessDepartmentField processId={bundle.process.id} data={department} canEdit /> : undefined}
            editCategory={editCategory}
            status={
              old ? (
                <>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-warn bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-fg">Viewing version {viewingVersion} · read only</span>
                  <Button asChild variant="outline" size="xs">
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
                <Button asChild variant="outline">
                  <Link href={historyHref}>History</Link>
                </Button>
                {editLink && (
                  // Opens the Editor: an ordinary button with the Editor's purple as a small marker, not a purple button.
                  <Button asChild variant="outline" className={EDIT_ONLY} data-edit-entry>
                    <Link href={editLink}>
                      <EditMarker /> Edit
                    </Link>
                  </Button>
                )}
                {exportMenu}
              </>
            }
          />
        }
        rail={
          <MetaRail label="Process details" data-process-rail="">
            <RailItem term="Steps">{about.steps}</RailItem>
            <RailItem term="Roles">{about.roles}</RailItem>
            <RailItem term="Hours a month" data-rail-hours="" data-process-hours="">
              {hoursAMonth !== null ? hoursText(hoursAMonth) : model ? "Simulating…" : "Not simulated"}
            </RailItem>
            {monthCost !== null && (
              <RailItem term="Cost a month" data-process-cost="">
                {formatWholeCurrency(monthCost, currency)}
              </RailItem>
            )}
            <RailItem term="Open issues">
              <a href="#issues" className="hover:underline" data-rail-issues>
                {issuesUi.openIssues ? `${issuesUi.openIssues} open` : "None open"}
              </a>
            </RailItem>
            <RailItem term="Last published">{lastPublished ? shortDate(lastPublished) : "Never"}</RailItem>
          </MetaRail>
        }
      >
        <SectionCard
          id="map"
          section="map"
          title={
            <span className="flex items-center">
              Process map
              <Help
                label="Map colours"
                description="A step is coloured by the worst rating among its confirmed open issues. Red badges count confirmed issues. Facts from the run show under What the process shows until someone logs an issue."
                example="A step with one Bad issue is orange with a badge of 1; a step with only an unconfirmed insight stays plain."
              />
            </span>
          }
        >
          {(gaps.length > 0 || error) && (
            <div className="flex flex-col gap-2">
              <MissingForSimulation gaps={gaps} onSelectStep={showGapStep} settingsHref={settingsHref} />
              {error && (
                <Alert className="border-crit bg-crit-soft">
                  <AlertDescription className="text-fg">This process can&apos;t be simulated yet: {error}.</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          <div className="flex h-[60svh] min-h-[28rem] min-w-0 flex-col">
            <ProcessCanvas
              height="fill"
              wheelZoom
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
                editLink ? (
                  <Button asChild variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry>
                    <Link href={editLink}>Open in Editor</Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        </SectionCard>

        <div id="run" className="flex min-w-0 scroll-mt-16 flex-col gap-6">
          <SectionCard
            id="facts"
            section="facts"
            data-panel="facts"
            title="What the process shows"
            description="What the simulation measured. Evidence, not issues: log an issue under Issues and solutions when one matters."
          >
            {model && supporting ? (
              <>
                <SupportingHeadline headline={supporting.headline} result={result} />
                <FactsList facts={issuesUi.facts} names={factNames} onLight={issuesUi.light} />
              </>
            ) : (
              <p className="text-sm text-fg-2">Nothing to show until the process can be simulated.</p>
            )}
          </SectionCard>
          {model && supporting && (
            <div id="supporting-data" className="flex min-w-0 scroll-mt-16 flex-col gap-6">
              <HoursByRole hours={supporting.hours} result={result} viewer={bundle.viewer} />
              <HeaviestSteps hours={supporting.hours} result={result} />
              <TimeSplit rows={supporting.timeSplit} result={result} />
              <KeyPersonPanel rows={supporting.keyPeople} hours={supporting.hours} result={result} />
            </div>
          )}
        </div>

        {issuesUi.issuesList}

        <ProcessSources processId={bundle.process.id} name={bundle.process.name} notes={notes} canEditNotes={!isReadOnly(mode) && !old && !!notes?.save} />
      </DetailLayout>
    </div>
  );
}

/** Whole hours, one decimal under 10, as the headline writes them. */
const hoursText = (h: number) => `${h < 10 ? h.toLocaleString("en-GB", { maximumFractionDigits: 1 }) : Math.round(h).toLocaleString("en-GB")} h`;

/**
 * What the process's hours cost a month: each person's hours on its steps times their rate (their own cost an hour, else the mean of
 * their roles', as the engine costs paid time). Null where pay is hidden from the viewer, or nothing costs anything.
 */
function costAMonth(model: EngineModel, result: SimulationResult | null, hours: ProcessHours | null): number | null {
  if (!hours || !result || model.payHidden) return null;
  const rateOf = (personId: string): number => {
    const person = result.resolvedPeople[personId] ?? model.people?.[personId];
    if (!person) return 0;
    if (person.cost !== undefined && person.cost !== null) return person.cost;
    const roles = person.roles.filter((r) => r in model.roles);
    return roles.length ? roles.reduce((sum, r) => sum + model.roles[r]!.cost, 0) / roles.length : 0;
  };
  const total = hours.cells.reduce((sum, c) => sum + c.hours * rateOf(c.personId), 0);
  return total > 0 ? total : null;
}

/**
 * The sources that are evidence for the whole process, with "+ Link", and the process's notes above them: the last section of the page
 * (a #sources address scrolls to it). Where the page loads neither, it says there is nothing here.
 */
function ProcessSources({
  processId,
  name,
  notes,
  canEditNotes,
}: {
  processId: string;
  name: string;
  notes?: { value: string | null; save?: (next: string) => Promise<string | null> };
  canEditNotes: boolean;
}) {
  const linking = useSourceLinking();
  // The saved text, kept here once a save succeeds so the field shows it without a reload.
  const [savedNotes, setSavedNotes] = useState<string | null | undefined>(undefined);
  return (
    <SectionCard id="sources" section="sources" title="Sources" description="Notes, and the interviews and data that are evidence for this process as a whole." contentClassName="gap-4">
      {!linking && !notes && <p className="text-sm text-fg-2">No sources for this process here.</p>}
      <div id="sources-body" className="flex flex-col gap-4">
        {notes && (
          <EditableText
            key={processId}
            value={savedNotes === undefined ? notes.value : savedNotes}
            canEdit={canEditNotes}
            label="Notes"
            emptyMessage="No notes yet. Say where this process's numbers come from: who you spoke to, what was measured, what is still a guess."
            emptyReader="No notes."
            addLabel="Add notes"
            maxLength={4000}
            data-process-notes=""
            onSave={async (next) => {
              const failed = await notes.save!(next);
              if (failed === null) setSavedNotes(next);
              return failed;
            }}
          />
        )}
        {linking && <LinkedSources target={{ kind: "process", processId }} label={`Process: ${name}`} empty="No source linked to this process yet." hideTitle className="flex flex-col gap-2" />}
      </div>
    </SectionCard>
  );
}
