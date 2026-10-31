"use client";

// The free-play Sandbox, on the workspace's own data (capacity build P7): builds what `PlayView` needs from the live process bundle, Set up and the
// workspace's solutions and changes. The company map is the Overview's, with its controls (D25), playing the run on screen. The model-driven `PlayView` is
// what the browser test mounts.

import { useCallback, useMemo, useState } from "react";
import {
  defaultPlay,
  partOf,
  playChanges,
  playIsDefault,
  winMix,
  workspacePurposes,
  type CapacityChangeRow,
  type CapacitySetup,
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
import { Card } from "@/components/ui/card";
import { deleteCapacityChange, saveCapacityChange } from "@/app/w/[slug]/capacity-change-actions";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { today as todayIso, DEFAULT_FORECAST_MONTHS } from "@/lib/forecast/forecast";
import { timelineMonths } from "@/lib/forecast/timeline";
import { horizonLabel } from "@/lib/horizon";
import { companyMap } from "@/lib/overview/company-map";
import { capacityLine, capacityRunsOut } from "@/lib/sandbox/timing";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import type { PlayRuns } from "@/lib/sandbox/use-play-runs";
import { SandboxExportMenu, type ExportData } from "./export-menu";
import { PrintSummary, type PrintColumn } from "./print-summary";
import { PlayView } from "./play-view";
import type { PlayProcess } from "./play-types";

export interface PlayPageProps {
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Every process at its live revision, for the company map. */
  parts: ProcessPart[];
  /** The company map process at its live revision: where each process sits and the handoff lines. */
  company: ProcessPart | null;
  setup: CapacitySetup;
  library: CapacityChangeRow[];
  solutions: SolutionRow[];
  solutionLinks: SolutionIssueRow[];
  issues: IssueRow[];
  canEdit: boolean;
  /** `/w/<slug>`. */
  base: string;
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
        return { id: s.id, name: s.name, issue: link ? (issueTitle.get(link.issue_id) ?? null) : null };
      }),
  }));
}

export function PlayPage({ live, parts, company, setup, library, solutions, solutionLinks, issues, canEdit, base }: PlayPageProps) {
  const [start] = useState(() => todayIso());
  const processes = useMemo(() => playProcesses(live, solutions, solutionLinks, issues), [live, solutions, solutionLinks, issues]);

  // Today's path, and the way to prepare the levers' path. The model of today's path gives the win mix for "Win new clients".
  const base0 = useMemo(() => {
    const ctx: PlayContext = { startDate: start, setup, library, winMix: () => ({}) };
    return preparePlay(live, defaultPlay(), ctx, solutions, DEFAULT_FORECAST_MONTHS);
  }, [live, start, setup, library, solutions]);
  const ctx: PlayContext = useMemo(() => {
    const model = base0.segments[0]?.model;
    return { startDate: start, setup, library, winMix: (d) => (model ? winMix(setup, model, d) : {}) };
  }, [base0, start, setup, library]);
  const prepare = useCallback((play: PlayState) => preparePlay(live, play, ctx, solutions, DEFAULT_FORECAST_MONTHS), [live, ctx, solutions]);

  // The company map, open groups in place, playing the run on screen.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const map = useMemo(() => companyMap(live, parts, expanded, company), [live, parts, expanded, company]);
  const scrollToStep = (stepId: string) => {
    const row = document.querySelector<HTMLElement>(`[data-step-row="${CSS.escape(stepId)}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.querySelector<HTMLElement>("select")?.focus({ preventScroll: true });
  };
  const renderMap = (runs: PlayRuns) =>
    map.bundle.steps.length ? (
      <Card className="gap-0 overflow-hidden p-0" data-company-map>
        <ProcessCanvas
          // Opening a card changes the map's size: start again so it is framed whole.
          key={[...expanded].sort().join("|")}
          bundle={map.bundle}
          result={runs.changed?.run.result ?? null}
          selection={NO_SELECTION}
          expanded={expanded}
          onExpandedChange={setExpanded}
          playbackRollUp
          playbackAbove
          showLanes={false}
          handoffs
          height="auto"
          stepDetail={false}
          onStepClick={scrollToStep}
          computing={runs.status === "running" && runs.changed === null}
        />
      </Card>
    ) : (
      <p className="text-sm text-muted-foreground">No process has been published yet.</p>
    );

  const exportSlot = ({ runs, play }: { runs: PlayRuns; play: PlayState }) => <PlayExport live={live} runs={runs} play={play} ctx={ctx} solutions={solutions} start={start} canSeeMoney={canEdit} />;

  return (
    <PlayView
      setup={setup}
      library={library}
      processes={processes}
      startDate={start}
      today={base0}
      prepare={prepare}
      map={renderMap}
      canEdit={canEdit}
      issues={issues.filter((i) => i.status !== "resolved").map((i) => ({ id: i.id, title: i.title }))}
      saveChange={(id, input) => saveCapacityChange(live.workspace.id, id, input)}
      removeChange={(id) => deleteCapacityChange(live.workspace.id, id)}
      exportSlot={exportSlot}
      base={base}
      modelError={base0.error}
    />
  );
}

/** The Export menu for the run on screen: today's path and the levers' path, as CSV, or printed (CSV and print are made in the browser). */
function PlayExport({ live, runs, play, ctx, solutions, start, canSeeMoney }: { live: ProcessBundle; runs: PlayRuns; play: PlayState; ctx: PlayContext; solutions: SolutionRow[]; start: string; canSeeMoney: boolean }) {
  const [includeCosts, setIncludeCosts] = useState(true);
  const hpw = live.workspace.settings.hours_per_week;
  const cutoffs = useMemo(() => toRatingConfig(ANALYSIS_DEFAULTS, hpw).rules.busy.cutoffs, [hpw]);
  const changes = useMemo(() => playChanges(play, ctx).map((change) => ({ change, scenarioId: "play", scenarioName: "Free play", inherited: false })), [play, ctx]);
  const today = runs.today;
  const changed = runs.changed;
  const ready = runs.status === "done" && today && changed && changed.run.result.monthly && today.run.result.monthly;
  const columns: PrintColumn[] | null = ready
    ? [
        { name: "Today's path", monthly: today.run.result.monthly!, priceRise: null, changes: [] },
        ...(playIsDefault(play) ? [] : [{ name: "Free play", monthly: changed.run.result.monthly!, priceRise: null, changes }]),
      ]
    : null;
  const months = useMemo(() => (ready ? timelineMonths(start, changed.run.result.monthly!.months, changed.run.model.hoursPerWeek) : null), [ready, changed, start]);
  const exportCtx = useMemo(() => ({ bundle: live, solutions, changes: changes.map((e) => e.change), mix: {} as Record<string, number> }), [live, solutions, changes]);
  const data: ExportData | null = ready && columns && months ? { columns, months, model: changed.run.model, categories: workspacePurposes(live.workspace.settings), currency: live.workspace.settings.currency, ctx: exportCtx } : null;
  const roleNames = useMemo(() => Object.fromEntries(Object.entries(changed?.run.model.roles ?? {}).map(([id, r]) => [id, r.name])), [changed]);
  const timingLine = ready && months ? capacityLine(capacityRunsOut(changed.run.result.monthly!, roleNames, cutoffs), months, horizonLabel(DEFAULT_FORECAST_MONTHS)) : null;
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
          horizonMonths={DEFAULT_FORECAST_MONTHS}
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
