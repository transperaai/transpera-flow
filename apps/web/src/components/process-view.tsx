"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PanelRight } from "lucide-react";
import { isUnpublished, ModelError, toEngineModel, type IssueRow, type ProcessBundle, type ScenarioRow, type SourceRow } from "@transpera-flow/db";
import type { AnalysisSettings, EngineModel, FirstPrinciples } from "@transpera-flow/engine";
import { useSuccessMeasures } from "@/lib/first-principles/use-measures";
import { discardChange, revertField } from "@/lib/drafts/discard";
import { EMPTY_DIFF, diffBundles, unresolvedSteps } from "@/lib/drafts/diff";
import { useDraftSession } from "@/lib/drafts/use-draft-session";
import { PASTE_OFFSET, copySteps, deleteSelection, duplicateSteps, pasteSteps, type StepClipboard } from "@/lib/editor/commands";
import { describeValue, fieldLabel, namesOf } from "@/lib/editor/describe";
import type { Conflict, ProcessEditor } from "@/lib/editor/editor";
import type { Table, Value } from "@/lib/editor/ops";
import { isProvenanceField } from "@/lib/editor/provenance";
import { splitStep } from "@/lib/editor/split";
import { newlyBroken, retiredSteps } from "@/lib/scenarios/broken";
import { connect } from "@/lib/realtime/connect";
import type { RealtimeSync } from "@/lib/realtime/sync";
import type { View, Viewer } from "@/lib/realtime/transport";
import { useRealtime } from "@/lib/realtime/use-realtime";
import { useSimulation } from "@/lib/sim/use-simulation";
import { horizonWeeks, isHorizonMonths } from "@/lib/horizon";
import { useHiddenLevers } from "@/lib/levers/use-hidden-levers";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { ChangesPanel, DraftBar, DraftCompare, type DraftView } from "./draft-panels";
import { MapSidePanel, type PanelOpen, type PanelTabId } from "./map/side-panel";
import { useMapPanelRequest } from "./shell/map-panel-request";
import { AssumptionChecklist } from "./evidence";
import { ConflictPrompt } from "./fields";
import { withHorizon } from "@/lib/editor/modes";
import { panelTabs } from "@/lib/map/panel-tabs";
import { HorizonPicker } from "./horizon-picker";
import { KpiStrip } from "./kpi-strip";
import { PresenceBar } from "./presence-bar";
import { SaveRunBar } from "./save-run";
import { NO_SELECTION, ProcessCanvas, type CanvasCommands, type Selection } from "./process-canvas";
import { useProcessIssues } from "./process-issues";
import { ScenarioPanel } from "./scenario-panel";
import { StepInspector } from "./step-inspector";
import { UtilisationBars } from "./utilisation-bars";
import { BottleneckPanel } from "./bottleneck-panel";
import { ServicingBanner } from "./servicing-banner";

/**
 * How edits are saved: `live` to the database as the signed-in user, `demo`
 * in memory (lost on reload), `readonly` not at all (viewers). Either way
 * edits go into the process's draft, never the live revision (issue #9).
 */
export type EditMode = "live" | "demo" | "readonly";

/** Who you are on the public demo, where nobody signs in. */
const DEMO_VIEWER: Viewer = { userId: "demo-you", name: "You", email: null };

/** A bundle's engine model, the same object while the model is unchanged (moving a step doesn't change it). */
export function useEngineModel(bundle: ProcessBundle, weeks: number | null): { model: EngineModel | null; error: string | null } {
  const resolved = useMemo(() => {
    try {
      return { model: toEngineModel(bundle), error: null };
    } catch (err) {
      if (err instanceof ModelError) return { model: null, error: err.message };
      throw err;
    }
  }, [bundle]);
  const modelKey = resolved.model ? JSON.stringify(resolved.model) : null;
  // The horizon picked on the page replaces the workspace's (issue #123); null keeps the workspace's.
  const model = useMemo(() => {
    if (!modelKey) return null;
    const m = JSON.parse(modelKey) as EngineModel;
    return weeks === null ? m : { ...m, horizonWeeks: weeks };
  }, [modelKey, weeks]);
  return { model, error: resolved.error };
}

export function ProcessView({
  live: initialLive,
  draft: initialDraft,
  mode,
  scenarios = [],
  issues = [],
  registerHref,
  settingsHref,
  userId = null,
  viewer = null,
  sources = [],
  liveRevisions,
  analysisRules,
  firstPrinciples,
  hiddenLevers,
  processPicker,
  notice,
  editHref,
}: {
  live: ProcessBundle;
  draft: ProcessBundle | null;
  mode: EditMode;
  /** Saved scenarios of the workspace (in memory on the demo). */
  scenarios?: ScenarioRow[];
  /** Tracked issues of the workspace (in memory on the demo). */
  issues?: IssueRow[];
  /** The full issues register, if the workspace has one to link to. */
  registerHref?: string;
  /** The workspace settings, where services are linked to servicing processes (issue #19). */
  settingsHref?: string;
  /** The signed-in user, recorded as who entered the values they change. */
  userId?: string | null;
  /** The signed-in user as others see them in presence (issue #10). */
  viewer?: Viewer | null;
  /** The workspace's sources, which values cite as evidence (issue #21). */
  sources?: SourceRow[];
  /** Each process's live revision id, which a dismissed insight is measured against. Omitted: this bundle's own. */
  liveRevisions?: Record<string, string>;
  /** The workspace's analysis rules, which rate the run (Settings → Analysis rules). Omitted: the defaults. */
  analysisRules?: AnalysisSettings;
  /** The live version's first principles (success measures for rule 11). */
  firstPrinciples?: FirstPrinciples | null;
  /** The lever kinds the workspace has switched off in Settings -> Levers (the demo keeps its own in the tab). */
  hiddenLevers?: string[];
  /** The process picker (and page heading), shown at the left of the top bar. */
  processPicker?: ReactNode;
  /** A notice above the results, such as the demo's. */
  notice?: ReactNode;
  /** Where the Editor for this process is, if the viewer may edit. Editing is its own screen (issue #104). */
  editHref?: string;
}) {
  const stamp = () => ({ at: new Date().toISOString(), by: userId });
  const sourcesHref = registerHref ? registerHref.replace(/\/issues$/, "/sources") : mode === "demo" ? "/demo/sources" : undefined;
  // Saves, catch-up reads and Realtime: the database and Supabase, or memory on the demo.
  const [connection] = useState(() => connect(mode, initialLive));
  const [session, drafts, state] = useDraftSession(
    initialLive,
    initialDraft,
    () => connection.backend,
    () => ({ at: new Date().toISOString(), by: userId }),
  );
  const editor = session.editor;
  const hasDraft = drafts.draft !== null || drafts.opening;
  // The map shows the live model by default, for editors too (the draft is one toggle away, read-only); a process never published has only its draft (issue #76).
  const unpublished = isUnpublished(initialLive);
  const [view, setView] = useState<DraftView>(unpublished ? "draft" : "live");
  const showingLive = hasDraft && view === "live";
  const working = state.bundle;
  const live = drafts.live;
  const bundle = showingLive ? live : working;
  // The map is for reading. Editing happens on the Editor's own screen (issue #104), so nothing here changes the draft.
  const editable = false;
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [compare, setCompare] = useState(false);
  const me = viewer ?? (mode === "demo" ? DEMO_VIEWER : null);
  const presenceView: View = hasDraft && !showingLive ? "draft" : "live";
  const [sync, realtime] = useRealtime(session, connection.transport, me, presenceView);

  const diff = useMemo(() => (hasDraft ? diffBundles(live, working) : EMPTY_DIFF), [hasDraft, live, working]);
  const names = useMemo(() => namesOf(working, live), [working, live]);

  // How far ahead to simulate: 1 to 24 months from the picker, or the workspace's own length until one is picked.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const horizonParam = Number(searchParams.get("horizon"));
  const [pickedMonths, setPickedMonths] = useState<number | null>(isHorizonMonths(horizonParam) ? horizonParam : null);
  // A pick goes in the address too, so a reload or a shared link keeps it.
  const pickHorizon = (months: number) => {
    setPickedMonths(months);
    const next = new URLSearchParams(searchParams.toString());
    next.set("horizon", String(months));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const weeks = pickedMonths === null ? null : horizonWeeks(pickedMonths);
  const hidden = useHiddenLevers(mode === "demo", hiddenLevers);
  const leversHref = settingsHref ? `${settingsHref}/levers` : mode === "demo" ? "/demo/settings/levers" : undefined;

  const workingModel = useEngineModel(working, weeks);
  const liveModel = useEngineModel(live, weeks);
  const resolved = showingLive ? liveModel : workingModel;
  const model = resolved.model;
  // While an edit leaves the process unsimulatable, keep showing the last results.
  const [lastModel, setLastModel] = useState(workingModel.model);
  if (workingModel.model && workingModel.model !== lastModel) setLastModel(workingModel.model);
  // The draft (or, with no draft, live as the editor holds it) runs always; live runs too when shown or compared.
  const draftSim = useSimulation(workingModel.model);
  const liveSim = useSimulation(hasDraft && (showingLive || compare) ? liveModel.model : null);
  const sim = showingLive ? liveSim : draftSim;
  const result = sim.run?.result ?? null;

  const restore = useCallback(
    (table: Table, id: string) => {
      editor.run((b) => discardChange(session.getState().live, b, table, id));
    },
    [editor, session],
  );

  // Selection can outlive what it points at (after a delete or an undo).
  const selected = useMemo(() => {
    const steps = new Set(bundle.steps.map((s) => s.id));
    const edges = new Set(bundle.edges.map((e) => e.id));
    return { steps: selection.steps.filter((id) => steps.has(id)), edges: selection.edges.filter((id) => edges.has(id)) };
  }, [bundle, selection]);
  const inspected = selected.steps.length === 1 && !selected.edges.length ? bundle.steps.find((s) => s.id === selected.steps[0]) : undefined;

  // Copied steps, and how many times they've been pasted (each paste lands further along).
  const clipboard = useRef<{ clip: StepClipboard; pastes: number } | null>(null);
  // A step whose inspector should take focus once it shows ("Edit in the inspector").
  const [inspectFocus, setInspectFocus] = useState<string | null>(null);

  const commands = useMemo<CanvasCommands>(
    () => ({
      duplicate: (ids) => {
        let made: string[] = [];
        editor.run((b) => {
          const r = duplicateSteps(b, ids);
          made = r?.ids ?? [];
          return r?.edit ?? null;
        });
        if (made.length) setSelection({ steps: made, edges: [] });
      },
      copy: (ids) => {
        const clip = copySteps(editor.getState().bundle, ids);
        if (clip) clipboard.current = { clip, pastes: 0 };
      },
      remove: (ids) => {
        if (editor.run((b) => deleteSelection(b, ids, []))) setSelection(NO_SELECTION);
      },
      inspect: (id) => {
        setSelection({ steps: [id], edges: [] });
        setInspectFocus(id);
      },
      split: (id) => {
        let made: string[] = [];
        editor.run((b) => {
          const r = splitStep(b, id);
          made = r?.ids ?? [];
          return r?.edit ?? null;
        });
        if (made.length) setSelection({ steps: made, edges: [] });
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (!editable) return;
    const paste = () => {
      const held = clipboard.current;
      if (!held) return;
      const n = held.pastes + 1;
      let made: string[] = [];
      editor.run((b) => {
        const r = pasteSteps(b, held.clip, { x: PASTE_OFFSET * n, y: PASTE_OFFSET * n });
        made = r?.ids ?? [];
        return r?.edit ?? null;
      });
      if (!made.length) return;
      held.pastes = n;
      setSelection({ steps: made, edges: [] });
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // Text fields keep their own undo, copy and delete keys.
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // Map keys work from the map (not its buttons or menu) or from nowhere in particular.
      const onMap = !target || target === document.body || (!!target.closest("[data-process-map]") && !target.closest("button, summary"));
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        editor.redo();
      } else if (!onMap) {
        return;
      } else if ((e.key === "Delete" || e.key === "Backspace") && !mod) {
        let { steps, edges } = selected;
        // Nothing selected: delete the step or connection that has focus.
        const focused = target?.closest(".react-flow__node, .react-flow__edge");
        const id = focused?.getAttribute("data-id");
        if (!steps.length && !edges.length && focused && id) {
          if (focused.classList.contains("react-flow__node")) steps = [id];
          else edges = [id];
        }
        if (editor.run((b) => deleteSelection(b, steps, edges))) {
          e.preventDefault();
          setSelection(NO_SELECTION);
          // What had focus is gone; keep it on the map.
          requestAnimationFrame(() => {
            if (document.activeElement === document.body) document.querySelector<HTMLElement>("[data-process-map]")?.focus();
          });
        }
      } else if (mod && key === "c" && selected.steps.length && !window.getSelection()?.toString()) {
        e.preventDefault();
        commands.copy(selected.steps);
      } else if (mod && key === "v" && clipboard.current) {
        e.preventDefault();
        paste();
      } else if (mod && key === "d" && selected.steps.length) {
        e.preventDefault();
        commands.duplicate(selected.steps);
      } else if (mod && key === "a" && target?.closest("[data-process-map]")) {
        e.preventDefault();
        setSelection({ steps: bundle.steps.map((s) => s.id), edges: [] });
      } else if (e.key === "Escape" && target?.closest("[data-process-map]")) {
        setSelection(NO_SELECTION);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, editor, selected, commands, bundle.steps]);

  const shownModel = showingLive ? model : (model ?? lastModel);
  const unresolved = useMemo(() => unresolvedSteps(working), [working]);
  const blocked = state.saving
    ? "Wait for your edits to save."
    : state.conflicts.length
      ? "Settle the conflicting edits first (keep mine / keep theirs)."
      : workingModel.error
        ? `The draft can't be simulated: ${workingModel.error}.`
        : null;

  // Steps the model on screen no longer has (split, replaced or deleted), to explain broken scenarios (issue #16).
  const retired = useMemo(() => (showingLive ? retiredSteps(live) : retiredSteps(working, live)), [showingLive, live, working]);
  // Whose values are estimated, for the robustness check: the steps (servicing processes' too), the
  // services (churn sensitivity) and the workspace settings (health rules; issue #79).
  const provenance = useMemo(
    () => ({
      steps: [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)],
      services: bundle.services,
      workspace: bundle.workspace.provenance,
      // Calibrated lead volumes (issue #41): measured qualified leads are not perturbed.
      leadSources: bundle.leadSources ?? [],
    }),
    [bundle],
  );

  // The side panel (issue #93): open state, and which tab is showing. Docked from lg up until told otherwise.
  const panelParam = useSearchParams().get("panel");
  const tabsAtStart = panelTabs({ hasDraft, showingLive, unresolved: unresolved.length, changes: diff.list.length, hasModel: !!shownModel, wanted: "draft" });
  const draftHasContent = tabsAtStart.hasContent;
  const [panelOpen, setPanelOpen] = useState<PanelOpen>(panelParam === "issues" ? true : "auto");
  const [panelTab, setPanelTab] = useState<PanelTabId>(panelParam === "issues" ? "insights" : draftHasContent ? "draft" : "insights");
  const isNarrow = useIsMobile();
  const { request: panelRequest } = useMapPanelRequest();
  const [seenRequest, setSeenRequest] = useState(panelRequest?.nonce ?? null);

  const sourceTitles = useMemo(() => Object.fromEntries(sources.map((s) => [s.id, s.title])), [sources]);

  // Rule 11 (goals met) reads the live version's first principles, as every page does.
  const successMeasures = useSuccessMeasures(live.process.id, mode === "demo", firstPrinciples);
  // Issues, levers and scenarios follow the model on screen (the draft, or live when shown).
  const issuesUi = useProcessIssues({
    bundle,
    model: shownModel,
    result,
    running: sim.status === "running",
    mode,
    initialIssues: issues,
    initialScenarios: scenarios,
    registerHref,
    retired,
    analysisRules,
    sources,
    liveRevisions: liveRevisions ?? { [bundle.process.id]: bundle.revision.id },
    successMeasures,
    onShowIssues: () => {
      setPanelOpen(true);
      setPanelTab("insights");
    },
  });
  // Saved scenarios that work on live but not on the draft: publishing would break them (issue #16).
  const breaks = useMemo(
    () =>
      hasDraft && liveModel.model && workingModel.model
        ? newlyBroken(liveModel.model, workingModel.model, issuesUi.scenarios, retiredSteps(working, live))
        : [],
    [hasDraft, liveModel.model, workingModel.model, issuesUi.scenarios, working, live],
  );

  // Opening the panel follows what you do (compare-in-render, as elsewhere in this file):
  // 1. a step becomes inspected: show it on the Step tab.
  const inspectedId = inspected && editable ? inspected.id : null;
  const [seenInspected, setSeenInspected] = useState<string | null>(null);
  if (inspectedId !== seenInspected) {
    setSeenInspected(inspectedId);
    if (inspectedId) {
      setPanelOpen(true);
      setPanelTab("step");
    }
  }
  // 2. the sidebar asks for a tab (its Issues item).
  if (panelRequest && panelRequest.nonce !== seenRequest) {
    setSeenRequest(panelRequest.nonce);
    setPanelOpen(true);
    setPanelTab("insights");
    issuesUi.showIssues();
  }
  // A tab that no longer exists (the step was deselected, the draft is hidden) gives way to one that does.
  const tabs = panelTabs({ hasDraft, showingLive, unresolved: unresolved.length, changes: diff.list.length, hasModel: !!shownModel, wanted: panelTab });
  const hasTab: Record<PanelTabId, boolean> = { ...tabs.has, step: editable && !!inspected };
  const activeTab: PanelTabId = hasTab[panelTab] ? panelTab : tabs.active;
  const panelShown = panelOpen === true || (panelOpen === "auto" && !isNarrow);

  const select = (table: Table, id: string) => {
    setView("draft");
    setSelection(table === "steps" ? { steps: [id], edges: [] } : { steps: [], edges: [id] });
  };

  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-2 gap-y-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        {/* Slots arrive from a Server Component; a keyed Fragment keeps React from asking them for keys. */}
        <Fragment key="picker">{processPicker ?? <h1 className="truncate px-1 font-display text-base font-bold">{live.process.name}</h1>}</Fragment>
        <DraftBar
          session={session}
          drafts={drafts}
          canEdit={false}
          view={showingLive ? "live" : "draft"}
          onView={(v) => {
            setView(v);
            setSelection(NO_SELECTION);
          }}
          changes={diff.list.length}
          blocked={blocked}
          unresolved={unresolved}
          compare={compare}
          onCompare={setCompare}
          onReview={(id) => select("steps", id)}
          breaks={breaks}
        />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {editHref && (
            <>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {showingLive || !hasDraft
                  ? `Viewing live · version ${live.revision.number}`
                  : `Viewing draft version ${drafts.draft?.number ?? live.revision.number + 1} (read-only)`}
              </span>
              <Button asChild size="sm" className="bg-edit text-edit-fg hover:bg-edit/90">
                <Link href={withHorizon(editHref, pickedMonths)}>{hasDraft ? "✎ Open draft in Editor" : "✎ Edit process"}</Link>
              </Button>
            </>
          )}
          <PresenceBar
            variant="compact"
            sync={sync}
            state={realtime}
            me={me}
            processName={live.process.name}
            colleague={connection.colleague}
            selectedStep={selected.steps.length === 1 ? selected.steps[0]! : null}
          />
          {shownModel && mode !== "readonly" && (!hasDraft || showingLive) && (
            // Saved runs are of the live model (issue #25).
            <SaveRunBar
              mode={mode}
              bundle={live}
              model={shownModel}
              result={sim.status === "done" ? result : null}
              durationMs={sim.run?.durationMs ?? null}
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={panelShown ? "Hide panel" : "Show panel"}
            aria-expanded={panelShown}
            aria-controls="map-panel"
            onClick={() => setPanelOpen(!panelShown)}
          >
            <PanelRight />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3 empty:hidden">
        <Fragment key="notice">{notice}</Fragment>
        {working.process.kind === "servicing" && <ServicingBanner bundle={working} settingsHref={settingsHref} />}
        {compare && hasDraft && (
          <DraftCompare
            live={liveModel.model ? { model: liveModel.model, result: liveSim.run?.result ?? null } : null}
            draft={workingModel.model ? { model: workingModel.model, result: draftSim.run?.result ?? null } : null}
            currency={working.workspace.settings.currency}
            liveNumber={live.revision.number}
            draftNumber={drafts.draft?.number ?? live.revision.number + 1}
          />
        )}
        {resolved.error && (
          <Alert className="border-crit bg-crit-soft">
            <AlertDescription className="text-fg">
              This process can&apos;t be simulated yet: {resolved.error}.{shownModel && result ? " The figures above are from before this change." : ""}
            </AlertDescription>
          </Alert>
        )}
        {editable && <SaveProblems editor={editor} bundle={bundle} conflicts={state.conflicts} error={state.error} sync={sync} />}
      </div>
      {shownModel ? (
        <div className="flex flex-col gap-2 px-4 pt-3">
          <HorizonPicker weeks={shownModel.horizonWeeks} onChange={pickHorizon} />
          <KpiStrip model={shownModel} currency={bundle.workspace.settings.currency} result={result} status={sim.status} durationMs={sim.run?.durationMs} />
        </div>
      ) : null}
      <div className="relative flex min-h-[28rem] flex-1 gap-3 p-4 lg:min-h-[calc(100svh-4rem)]">
        <ProcessCanvas
          bundle={bundle}
          result={result}
          editor={editable ? editor : null}
          editorState={editable ? state : null}
          selection={selected}
          onSelectionChange={setSelection}
          commands={editable ? commands : null}
          diff={showingLive || !hasDraft ? null : diff}
          onRestore={editable ? restore : null}
          savedLabel={hasDraft ? "Saved to draft" : "Saved"}
          openIssues={issuesUi.openIssues}
          rating={issuesUi.rating}
          stepExtras={issuesUi.stepExtras}
          highlight={issuesUi.highlight}
          sourceTitles={sourceTitles}
        />
        <MapSidePanel
          open={panelOpen}
          tab={activeTab}
          onTab={setPanelTab}
          onClose={() => setPanelOpen(false)}
          stepTab={editable}
          hasStep={hasTab.step}
          draftTab={hasTab.draft}
          draftLabel={tabs.draftLabel}
          unresolved={unresolved.length}
          modelTabs={!!shownModel}
          step={
            inspected && editable ? (
              <StepInspector
                key={inspected.id}
                bundle={bundle}
                step={inspected}
                editor={editor}
                autoFocus={inspectFocus === inspected.id}
                onFocused={() => setInspectFocus(null)}
                onClose={() => setSelection(NO_SELECTION)}
                onDelete={() => {
                  editor.run((b) => deleteSelection(b, [inspected.id], []));
                  setSelection(NO_SELECTION);
                }}
                sources={sources}
                stamp={stamp}
                sourcesHref={sourcesHref}
                draft={
                  hasDraft
                    ? {
                        change: diff.steps.get(inspected.id),
                        names,
                        onRevert: (field) => editor.run((b) => revertField(session.getState().live, b, "steps", inspected.id, field)),
                        onDiscard: () => editor.run((b) => discardChange(session.getState().live, b, "steps", inspected.id)),
                      }
                    : null
                }
              />
            ) : null
          }
          draft={
            <>
              <AssumptionChecklist bundle={working} editor={editable ? editor : null} sources={sources} stamp={stamp} onSelect={(id) => select("steps", id)} />
              <ChangesPanel diff={diff} live={live} bundle={working} editor={editable ? editor : null} names={names} onSelect={select} />
              {!draftHasContent && <p className="py-6 text-center text-muted-foreground">Nothing to confirm and no changes against live.</p>}
            </>
          }
          insights={
            shownModel &&
            issuesUi.rail(
              <div className="flex flex-col gap-3">
                <BottleneckPanel model={shownModel} result={result} ready={sim.status === "done"} />
                <UtilisationBars model={shownModel} result={result} />
              </div>,
            )
          }
          scenarios={
            shownModel && (
              <ScenarioPanel
                model={shownModel}
                baseline={sim.run}
                currency={bundle.workspace.settings.currency}
                workspaceId={bundle.workspace.id}
                initialScenarios={scenarios}
                mode={mode}
                onScenariosChange={issuesUi.onScenariosChange}
                provenance={provenance}
                retired={retired}
                hiddenLevers={hidden}
                leversHref={leversHref}
              />
            )
          }
        />
      </div>
      {issuesUi.badges}
    </div>
  );
}

/** Same-field conflicts waiting for "keep mine / keep theirs", and the last failed save. */
export function SaveProblems({
  editor,
  bundle,
  conflicts,
  error,
  sync,
}: {
  editor: ProcessEditor;
  bundle: ProcessBundle;
  conflicts: Conflict[];
  error: string | null;
  /** Names who made the other change, when their note has arrived. */
  sync: RealtimeSync | null;
}) {
  // A value's provenance is settled along with the value, so it gets no prompt of its own.
  conflicts = conflicts.filter((c) => !isProvenanceField(c.field));
  if (!conflicts.length && !error) return null;
  const names = namesOf(bundle);
  const show = (field: string, v: Value): string => describeValue(field, v, names);
  const subject = (c: Conflict) => {
    const label = fieldLabel(c.field);
    if (c.table === "steps") return `${names.get(c.id) ?? "a step"}'s ${label}`;
    const edge = bundle.edges.find((e) => e.id === c.id);
    return edge ? `the ${label} of ${names.get(edge.from_step_id)} → ${names.get(edge.to_step_id)}` : `a connection's ${label}`;
  };
  return (
    <div className="flex flex-col gap-2">
      {conflicts.map((c) => (
        <ConflictPrompt
          key={`${c.table}:${c.id}:${c.field}`}
          subject={subject(c)}
          by={sync?.who(c.table, c.id, c.field, c.theirs) ?? null}
          theirs={show(c.field, c.theirs)}
          mine={show(c.field, c.mine)}
          onKeepMine={() => void editor.keepMine(c)}
          onKeepTheirs={() => editor.keepTheirs(c)}
        />
      ))}
      {error && (
        <p role="alert" className="rounded-token border border-crit bg-crit-soft p-2 text-xs">
          {error}{" "}
          <button type="button" onClick={() => editor.dismissError()} className="underline">
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
