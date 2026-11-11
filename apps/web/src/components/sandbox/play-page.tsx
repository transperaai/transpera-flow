"use client";

// The free-play Sandbox, on the workspace's own data (capacity build P7): builds what `PlayView` needs from the live process bundle, Set up and the
// workspace's solutions (their step changes, D53, run when a version is picked). The company map is the Overview's, with its controls (D25), playing the run on screen. The model-driven `PlayView` is
// what the browser test mounts.

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  companyBundle,
  defaultPlay,
  liveMapDifferences,
  partOf,
  playChanges,
  playIsDefault,
  winMix,
  workspacePurposes,
  type CompanyRevisionListing,
  type CapacitySetup,
  type CompanyRunNote,
  type IssueRow,
  type PlayContext,
  type PlayState,
  type ProcessBundle,
  type ProcessPart,
  type SolutionIssueRow,
  type SolutionRow,
} from "@transpera-flow/db";
import { preparePlay } from "@transpera-flow/db/sandbox";
import { ENGINE_VERSION, toRatingConfig } from "@transpera-flow/engine";
import { NO_SELECTION, ProcessCanvas } from "@/components/process-canvas";
import { EmptyState } from "@/components/page-kit";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { today as todayIso, DEFAULT_FORECAST_MONTHS } from "@/lib/forecast/forecast";
import { timelineMonths } from "@/lib/forecast/timeline";
import { horizonLabel } from "@/lib/horizon";
import { companyMap } from "@/lib/overview/company-map";
import { laneOfProcesses, laneSpecs, type DepartmentLaneInput } from "@/lib/overview/department-lanes";
import { PROCESS_CATEGORY_LABELS } from "@transpera-flow/db";
import { capacityLine, capacityRunsOut } from "@/lib/sandbox/timing";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import type { PlayRuns } from "@/lib/sandbox/use-play-runs";
import { SandboxExportMenu, type ExportData } from "./export-menu";
import { PrintSummary, type PrintColumn } from "./print-summary";
import { NativeSelect } from "@/components/ui/native-select";
import { Help } from "@/components/help";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { shortDate } from "@/lib/processes/rows";
import { PlayView } from "./play-view";
import type { PlayMapApi } from "./play-map";
import type { PlayHorizon, PlayProcess } from "./play-types";

export interface PlayPageProps {
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Every process at its live revision, for the company map. */
  parts: ProcessPart[];
  /** The company map process at its live revision: where each process sits and the handoff lines. */
  company: ProcessPart | null;
  setup: CapacitySetup;
  solutions: SolutionRow[];
  solutionLinks: SolutionIssueRow[];
  issues: IssueRow[];
  canEdit: boolean;
  /** `/w/<slug>`. */
  base: string;
  /** `?solution=<id>`: a solution to have picked as its process's map version when the page opens. */
  initialSolutionId?: string | null;
  /** The departments, tier services and servicing links the map's lanes are worked out from (Q4). */
  laneInput?: DepartmentLaneInput;
  /** The company map's revisions (draft, live, earlier versions) for the "Company map" select, and the one `company` is. */
  companyRevisions?: CompanyRevisionListing[];
  companyRevisionId?: string | null;
}

/** The processes of the company model with their steps and solutions, in words. */
export function playProcesses(live: ProcessBundle, solutions: readonly SolutionRow[], links: readonly SolutionIssueRow[], issues: readonly IssueRow[]): PlayProcess[] {
  const roles = new Map(live.roles.map((r) => [r.id, r.name]));
  const people = new Map(namedForViewer(viewerOf(live), live.people).map((p) => [p.id, p.name]));
  const issueTitle = new Map(issues.map((i) => [i.id, i.title]));
  return [partOf(live), ...(live.otherProcesses ?? [])].map((p) => ({
    id: p.process.id,
    name: p.process.name,
    steps: p.steps
      .filter((s) => s.kind === "task" || s.kind === "wait" || s.kind === "decision")
      .map((s) => ({
        id: s.id,
        name: s.name,
        who: s.to_client_manager ? "The client's manager" : s.person_id ? (people.get(s.person_id) ?? "A named person") : s.role_id ? (roles.get(s.role_id) ?? "No one assigned") : "No one assigned",
      })),
    solutions: solutions
      .filter((s) => s.process_id === p.process.id)
      .map((s) => {
        const link = links.find((l) => l.solution_id === s.id);
        return { id: s.id, name: s.name, issue: link ? (issueTitle.get(link.issue_id) ?? null) : null, status: s.status };
      }),
  }));
}

export function PlayPage({ live, parts, company, setup, solutions, solutionLinks, issues, canEdit, base, initialSolutionId, laneInput, companyRevisions = [], companyRevisionId = null }: PlayPageProps) {
  const initialSolution = useMemo(() => {
    const s = initialSolutionId ? solutions.find((x) => x.id === initialSolutionId) : undefined;
    return s ? { id: s.id, processId: s.process_id } : null;
  }, [initialSolutionId, solutions]);
  const [start] = useState(() => todayIso());
  // How far ahead the run goes (QA round 2: 12 to 60 months, picked above the charts). Every run of the page uses it.
  const [horizon, setHorizon] = useState<PlayHorizon>(DEFAULT_FORECAST_MONTHS as PlayHorizon);

  // The company map decides what is simulated (Q17, ADR 0023). `live` is the loader's bundle: the live map's run once a person has published a company
  // map version, today's run before. Today's path is always that. The map chosen in the select, when it isn't the live one (the open draft or an
  // earlier version), is the levers' path's own scene: the same processes and levers, run from that map.
  const liveRevisionId = companyRevisions.find((r) => r.live)?.id ?? null;
  const mapKey = companyRevisionId !== null && companyRevisionId !== liveRevisionId ? companyRevisionId : null;
  const mapDrives = company?.process.map_drives_run !== false;
  const made = useMemo(() => (company ? companyBundle(live, company, parts) : null), [live, company, parts]);
  const run = useMemo(() => (mapKey !== null && made?.bundle ? made.bundle : live), [mapKey, made, live]);
  const mapProblem = mapKey !== null && made && !made.bundle ? made.problem : null;
  // What to say about the map: a map that runs says what it can't honour; the live map before a person has published one says how it differs.
  const mapNotes: CompanyRunNote[] = useMemo(() => {
    if (!made) return [];
    return mapKey === null && !mapDrives ? liveMapDifferences(live, made) : made.notes;
  }, [made, mapKey, mapDrives, live]);
  const processes = useMemo(() => playProcesses(run, solutions, solutionLinks, issues), [run, solutions, solutionLinks, issues]);

  // The issue each solution is for (the first it is linked to): put on its step changes in the engine's input, as a change's issue was (reporting only).
  const issueOf = useCallback((solutionId: string) => solutionLinks.find((l) => l.solution_id === solutionId)?.issue_id, [solutionLinks]);

  // Today's path, and the way to prepare the levers' path. The model of today's path gives the win mix for "Win new clients".
  const base0 = useMemo(() => {
    const ctx: PlayContext = { startDate: start, setup, issueOf, winMix: () => ({}) };
    return preparePlay(live, defaultPlay(), ctx, solutions, horizon);
  }, [live, start, setup, issueOf, solutions, horizon]);
  const ctx: PlayContext = useMemo(() => {
    const model = base0.segments[0]?.model;
    return { startDate: start, setup, issueOf, winMix: (d) => (model ? winMix(setup, model, d) : {}) };
  }, [base0, start, setup, issueOf]);
  const prepare = useCallback(
    (play: PlayState) => {
      const prepared = preparePlay(run, play, ctx, solutions, horizon);
      // A map the run can't start from (no sales pipeline on it) is an error of the levers' path, not of today's.
      return mapProblem !== null ? { ...prepared, segments: [], error: mapProblem } : prepared;
    },
    [run, ctx, solutions, mapProblem, horizon],
  );

  // The company map, open groups in place, playing the run on screen.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const map = useMemo(() => companyMap(live, parts, expanded, company), [live, parts, expanded, company]);
  // Department lanes and each process's category on its card, as on the Overview (Q4).
  const departmentLanes = useMemo(
    () => (laneInput ? { spec: { lanes: laneSpecs(laneInput), laneOf: laneOfProcesses(parts.map((p) => p.process), laneInput) }, always: true } : undefined),
    [laneInput, parts],
  );
  const cardTags = useMemo(() => new Map(parts.map((p) => [p.process.id, PROCESS_CATEGORY_LABELS[p.process.category]] as const)), [parts]);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const pickCompany = (revisionId: string) => {
    const next = new URLSearchParams(search.toString());
    const picked = companyRevisions.find((r) => r.id === revisionId);
    if (!picked || picked.live) next.delete("company");
    else next.set("company", picked.status === "draft" ? "draft" : picked.id);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // What the run can't honour, folded to one line: open it for the list.
  const noteList = mapNotes.length ? (
    <details className="text-xs text-muted-foreground" data-company-run-notes>
      <summary className="w-fit cursor-pointer hover:text-foreground">
        {mapNotes.length} {mapNotes.length === 1 ? "note" : "notes"} on this run
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 pl-4">
        {mapNotes.map((n, i) => (
          <li key={`${n.kind}:${i}`} data-company-run-note={n.kind}>
            {n.message}
          </li>
        ))}
      </ul>
    </details>
  ) : null;
  // In the toolbar: which version of the company map runs (sized to its content). What that means is behind its (i) and in the map section's line.
  const companySelect =
    companyRevisions.length > 1 ? (
      <label className="flex min-w-0 items-center gap-2 text-xs" data-company-version-select>
        <span className="font-medium text-muted-foreground">Company map</span>
        <NativeSelect value={companyRevisionId ?? ""} onChange={(e) => pickCompany(e.target.value)} aria-label="Company map version" className="h-7 w-auto">
          {companyRevisions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.status === "draft" ? "Draft" : r.live ? `Live · version ${r.number}` : `Version ${r.number}${r.publishedAt ? ` · ${shortDate(r.publishedAt)}` : ""}`}
            </option>
          ))}
        </NativeSelect>
        <Help {...SANDBOX_HELP.companyMap} />
      </label>
    ) : null;
  // In the map section: only what the run can't honour (what the version picker means is behind its (i)).
  const mapHeader = noteList;
  const renderMap = (runs: PlayRuns, api: PlayMapApi) =>
    map.bundle.steps.length ? (
      // The star of the page: full width, most of the window tall, the canvas filling it (zoom, fit, full screen and playback on the map).
      <div className="flex h-[82svh] min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-xl border border-line" data-company-map>
        <ProcessCanvas
          // Opening a card changes the map's size: frame it again, with playback going on.
          refitOn={[...expanded].sort().join("|")}
          bundle={map.bundle}
          result={runs.changed?.run.result ?? null}
          selection={NO_SELECTION}
          expanded={expanded}
          onExpandedChange={setExpanded}
          playbackRollUp
          showLanes={false}
          departmentLanes={departmentLanes}
          cardTags={cardTags}
          cardBadges={api.badges}
          handoffs
          height="fill"
          stepDetail={false}
          onStepClick={(stepId) => {
            const process = map.processOfStep.get(stepId);
            if (process) api.onProcess(process, stepId);
          }}
          computing={runs.status === "running" && runs.changed === null}
        />
      </div>
    ) : (
      <EmptyState>No process has been published yet.</EmptyState>
    );

  const exportSlot = ({ runs, play }: { runs: PlayRuns; play: PlayState }) => <PlayExport live={run} runs={runs} play={play} ctx={ctx} solutions={solutions} start={start} canSeeMoney={canEdit} mapMoved={mapKey !== null} horizon={horizon} />;

  return (
    <PlayView
      setup={setup}
      processes={processes}
      startDate={start}
      horizon={horizon}
      onHorizon={setHorizon}
      purposes={workspacePurposes(live.workspace.settings)}
      today={base0}
      prepare={prepare}
      map={renderMap}
      mapHeader={mapHeader}
      versionSelect={companySelect}
      exportSlot={exportSlot}
      base={base}
      modelError={base0.error ?? mapProblem}
      mapKey={mapKey}
      initialSolution={initialSolution}
    />
  );
}

/** The Export menu for the run on screen: today's path and the levers' path, as CSV, or printed (CSV and print are made in the browser). */
function PlayExport({ live, runs, play, ctx, solutions, start, canSeeMoney, mapMoved, horizon }: { live: ProcessBundle; runs: PlayRuns; play: PlayState; ctx: PlayContext; solutions: SolutionRow[]; start: string; canSeeMoney: boolean; mapMoved: boolean; horizon: number }) {
  const [includeCosts, setIncludeCosts] = useState(true);
  const hpw = live.workspace.settings.hours_per_week;
  const cutoffs = useMemo(() => toRatingConfig(ANALYSIS_DEFAULTS, hpw).rules.busy.cutoffs, [hpw]);
  const changes = useMemo(() => playChanges(play, ctx).map((change) => ({ change, scenarioId: "play", scenarioName: "Free play", inherited: false })), [play, ctx]);
  const today = runs.today;
  const changed = runs.changed;
  const ready = runs.status === "done" && today && changed && changed.run.result.monthly && today.run.result.monthly;
  const columns: PrintColumn[] | null = ready
    ? [{ name: "Today's path", monthly: today.run.result.monthly!, priceRise: null, changes: [] }, ...(playIsDefault(play) && !mapMoved ? [] : [{ name: "Free play", monthly: changed.run.result.monthly!, priceRise: null, changes }])]
    : null;
  const months = useMemo(() => (ready ? timelineMonths(start, changed.run.result.monthly!.months, changed.run.model.hoursPerWeek) : null), [ready, changed, start]);
  const exportCtx = useMemo(() => ({ bundle: live, solutions, changes: changes.map((e) => e.change), mix: {} as Record<string, number> }), [live, solutions, changes]);
  const data: ExportData | null =
    ready && columns && months ? { columns, months, model: changed.run.model, categories: workspacePurposes(live.workspace.settings), currency: live.workspace.settings.currency, ctx: exportCtx } : null;
  const roleNames = useMemo(() => Object.fromEntries(Object.entries(changed?.run.model.roles ?? {}).map(([id, r]) => [id, r.name])), [changed]);
  const timingLine = ready && months ? capacityLine(capacityRunsOut(changed.run.result.monthly!, roleNames, cutoffs), months, horizonLabel(horizon)) : null;
  return (
    <>
      <SandboxExportMenu
        fileName={`${live.workspace.name} free play`}
        disabledReason={data ? null : "Wait for the run to finish."}
        data={data}
        hasCosts={canSeeMoney && Boolean(changed?.run.result.monthly?.money)}
        includeCosts={includeCosts}
        onIncludeCosts={setIncludeCosts}
        onPrint={() => window.print()}
      />
      {data && columns && (
        <PrintSummary
          workspaceName={live.workspace.name}
          title="Free play"
          printedOn={todayIso()}
          startDate={start}
          horizonMonths={horizon}
          engineVersion={ENGINE_VERSION}
          model={changed!.run.model}
          bundle={live}
          columns={columns}
          cutoffs={cutoffs}
          categories={data.categories}
          currency={data.currency}
          costs={canSeeMoney && includeCosts && columns.every((c) => c.monthly.money)}
          timingLine={timingLine}
          ctx={exportCtx}
        />
      )}
    </>
  );
}
