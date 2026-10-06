"use client";

// The Editor (issue #104): editing a process on its own full-screen page, in the edit colour, not a mode of the map.
// A left column with the palette, the map in the middle, the inspector on the right, and "Compared with live" below
// after Simulate. Edits go to the process's single draft (D18); Publish makes it the next live version.
//
// The mode is a parameter (`draft`, `solution`, `block`): the hint and the save buttons change with it. Draft mode is
// built here, block mode (issue #116: an empty map saved to the block library, nothing of the process touched) and solution
// mode (issue #114: a copy of live, edited in memory and saved as a solution of its own; the process's live version and its
// single draft are never touched, D18).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isUnpublished, type BlockRow, type ProcessBundle, type ScenarioRow, type SourceRow } from "@transpera-flow/db";
import { createSolution } from "@/app/w/[slug]/solution-actions";
import { createLibraryProcess } from "@/app/w/[slug]/library-actions";
import type { LibraryProcess, LibraryTemplate } from "@/lib/editor/library";
import type { LibraryCreate } from "@/lib/editor/library-create";
import { blockFromSteps } from "@/lib/blocks/blocks";
import { markDemoIdeaBuilt } from "@/lib/demo/company-store";
import type { ScenarioPatch } from "@transpera-flow/engine";
import { LeverChangesBox } from "@/components/editor/lever-changes-box";
import { placeIdea, type IdeaSeed } from "@/lib/suggestions/idea";
import { parseBlockInput } from "@/lib/blocks/save";
import { newStepRow } from "@/lib/editor/commands";
import type { ViewHint } from "@/lib/editor/groups";
import { discardChange, revertField } from "@/lib/drafts/discard";
import { EMPTY_DIFF, diffBundles, publishableChanges, unresolvedSteps } from "@/lib/drafts/diff";
import { useDraftSession } from "@/lib/drafts/use-draft-session";
import { namesOf } from "@/lib/editor/describe";
import type { Table } from "@/lib/editor/ops";
import { MODE_INFO, editorHorizonWeeks, type EditorMode } from "@/lib/editor/modes";
import { connect, connectScratch } from "@/lib/realtime/connect";
import type { Viewer } from "@/lib/realtime/transport";
import { useRealtime } from "@/lib/realtime/use-realtime";
import { newlyBroken, retiredSteps } from "@/lib/scenarios/broken";
import { useSimulation } from "@/lib/sim/use-simulation";
import type { EngineModel } from "@transpera-flow/engine";
import { currentArea, verdictArea, type SolutionIssue } from "@/lib/solutions/area";
import { changedStepIds, solutionCopy } from "@/lib/solutions/bundle";
import { addDemoSolution } from "@/lib/solutions/demo";
import { parseSolutionInput, type SaveSolutionResult } from "@/lib/solutions/save";
import type { TargetVerdict } from "@/lib/solutions/verdict";
import { verdictInWorker } from "@/lib/solutions/verdict-client";
import { Button } from "@/components/ui/button";
import { NO_SELECTION, ProcessCanvas, type Selection } from "@/components/process-canvas";
import { PresenceBar } from "@/components/presence-bar";
import { SaveProblems, useEngineModel, type EditMode } from "@/components/process-view";
import { EditorBar, type BlockForm, type SolutionForm } from "./editor-bar";
import { IssueArea } from "./issue-area";
import { Inspector } from "./inspector";
import { Palette } from "./palette";
import { useEditorTour } from "./editor-tour";
import { findGaps, gapInputFromBundle } from "@transpera-flow/db/simulation-gaps";
import { MissingForSimulation } from "@/components/simulation-gaps";
import { SimulateFooter, type SimulatedPair } from "./simulate-footer";
import { useBlockTools } from "./use-blocks";
import { useEditCommands } from "./use-edit-commands";

const DEMO_VIEWER: Viewer = { userId: "demo-you", name: "You", email: null };

/** What block mode edits: the workspace's roles and people (so steps can be given to them), and one new step on an empty map. */
function blockScratch(base: ProcessBundle): ProcessBundle {
  const step = { ...newStepRow(base, "task", null, 24, 56), name: "New step" };
  return { ...base, process: { ...base.process, name: "New block" }, steps: [step], edges: [], retired: [] };
}

export function EditorView({
  live: initialLive,
  draft: initialDraft,
  mode,
  editorMode = "draft",
  scenarios = [],
  blocks = [],
  sources = [],
  userId = null,
  viewer = null,
  sourcesHref,
  settingsHref,
  exitHref,
  horizonMonths = null,
  extraChanges = 0,
  issue = null,
  idea = null,
  tourDismissed = false,
  historyHref,
  library,
}: {
  live: ProcessBundle;
  draft: ProcessBundle | null;
  /** How edits are saved: to the database as the signed-in user, or in memory on the demo. Viewers can't open the Editor. */
  mode: Exclude<EditMode, "readonly">;
  /** What is being edited: a process's draft, a solution or a block. */
  editorMode?: EditorMode;
  /** Saved scenarios of the workspace, which publishing could break. */
  scenarios?: ScenarioRow[];
  /** The workspace's block library (the demo keeps its own). */
  blocks?: BlockRow[];
  /** Kept for the sources a step cites (issue #21). */
  sources?: SourceRow[];
  userId?: string | null;
  /** The database says this person has already dismissed the Editor's written tour. */
  tourDismissed?: boolean;
  /** The History page of what is being edited, for the bar's History button. */
  historyHref?: string;
  viewer?: Viewer | null;
  sourcesHref?: string;
  /** The workspace's Settings page, which "Missing for simulation" links to for incoming volume. */
  settingsHref?: string;
  /** Where Exit editor goes. */
  exitHref: string;
  /** The horizon picked on the map, in months; null runs the model at its own length. */
  horizonMonths?: number | null;
  /** Changes the draft has that aren't steps or edges (its first principles differ from live's), which Publish counts too. */
  extraChanges?: number;
  /** Solution mode: the issue the solution is built for, whose steps are outlined and whose target the verdict is checked against. */
  issue?: SolutionIssue | null;
  /** Solution mode opened from a solution idea (A52, "Build it"): its steps are placed on first load, and saving marks it built. */
  idea?: IdeaSeed | null;
  /** The process library (B12): the workspace's processes, where each sits (live links), and the templates. */
  library?: { processes: LibraryProcess[]; templates: LibraryTemplate[] };
}) {
  const router = useRouter();
  // The company map (B11): a picture of the business. Cards are moved and joined by handoff lines; nothing is simulated.
  const company = initialLive.process.is_company === true;
  const stamp = useCallback(() => ({ at: new Date().toISOString(), by: userId }), [userId]);
  const blockMode = editorMode === "block";
  // The library makes new processes on the server, as the signed-in editor; the demo (memory) only places existing ones.
  const workspaceId = initialLive.workspace.id;
  const onCreate = useCallback<LibraryCreate>((input) => createLibraryProcess(workspaceId, input), [workspaceId]);
  const libraryProps = useMemo(() => (library ? { ...library, ...(mode === "live" ? { onCreate } : {}) } : undefined), [library, mode, onCreate]);
  const solutionMode = editorMode === "solution";
  // Block and solution modes edit a map of their own, in memory: never the process's live version or its draft. A block
  // starts empty; a solution starts as a copy of live.
  const scratch = blockMode || solutionMode;
  const [seed] = useState(() => (blockMode ? blockScratch(initialLive) : initialLive));
  const [connection] = useState(() => (scratch ? connectScratch(seed) : connect(mode, seed)));
  const [session, drafts, state] = useDraftSession(seed, scratch ? null : initialDraft, () => connection.backend, () => ({ at: new Date().toISOString(), by: userId }));
  const editor = session.editor;
  const info = MODE_INFO[editorMode];
  const hasDraft = !scratch && (drafts.draft !== null || drafts.opening);
  // What the map marks as new or changed: against the draft's live version, or the solution's copy of it.
  const marksChanges = hasDraft || solutionMode;
  const live = drafts.live;
  const working = state.bundle;
  // Worked out up front, on the live map the copy starts as, so the steps are selected as soon as they arrive.
  const [placement] = useState(() => (solutionMode && idea ? placeIdea(initialLive, idea) : null));
  const [selection, setSelection] = useState<Selection>(placement?.id ? { steps: [placement.id], edges: [] } : NO_SELECTION);
  const me = viewer ?? (mode === "demo" ? DEMO_VIEWER : null);
  // The written tour: opens the first time this user opens the Editor, and again from "Take the tour".
  const tour = useEditorTour({ userId, company, dismissed: tourDismissed });
  const [sync, realtime] = useRealtime(session, connection.transport, me, "draft");

  const diff = useMemo(() => (marksChanges ? diffBundles(live, working) : EMPTY_DIFF), [marksChanges, live, working]);
  const names = useMemo(() => namesOf(working, live), [working, live]);
  const weeks = editorHorizonWeeks(editorMode, horizonMonths);
  // Solution mode (B4): the lever changes an idea brought (a visitor's moves), kept with the solution and applied when it is simulated.
  const [levers, setLevers] = useState<ScenarioPatch[]>(() => (solutionMode ? (idea?.levers ?? []) : []));
  const workingModel = useEngineModel(working, weeks, solutionMode ? levers : undefined);
  const liveModel = useEngineModel(live, weeks);
  const unresolved = useMemo(() => unresolvedSteps(working), [working]);
  // What the draft still lacks for meaningful numbers (issue #167): the same check as the upload preview, on the draft as edited.
  const gaps = useMemo(() => (company || scratch ? [] : findGaps(gapInputFromBundle(working))), [company, scratch, working]);

  // Selection can outlive what it points at (after a delete or an undo).
  const selected = useMemo(() => {
    const steps = new Set(working.steps.map((s) => s.id));
    const edges = new Set(working.edges.map((e) => e.id));
    return { steps: selection.steps.filter((id) => steps.has(id)), edges: selection.edges.filter((id) => edges.has(id)) };
  }, [working, selection]);

  const { commands, inspectFocus, clearInspectFocus } = useEditCommands({ editor, bundle: working, selected, setSelection });
  const blockTools = useBlockTools({
    mode: mode === "demo" ? "demo" : "live",
    workspaceId: live.workspace.id,
    blocks,
    bundle: working,
    editor,
    selected,
    setSelection,
    processName: initialLive.process.name,
  });

  // Block mode: what the block is called, and saving it. Nothing is written until then.
  const [blockName, setBlockName] = useState("");
  const [blockDescription, setBlockDescription] = useState("");
  const [blockSaving, setBlockSaving] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const saveToLibrary = async () => {
    setBlockError(null);
    await editor.settled();
    const input = { name: blockName, description: blockDescription, bundle: blockFromSteps(session.editor.getState().bundle) };
    const checked = parseBlockInput(input);
    if (!checked.ok) return setBlockError(checked.error);
    setBlockSaving(true);
    const result = await blockTools.save(checked.value);
    setBlockSaving(false);
    if (result.status === "error") return setBlockError(result.message);
    router.push(exitHref);
  };
  const blockForm: BlockForm | undefined = blockMode
    ? { name: blockName, description: blockDescription, onName: setBlockName, onDescription: setBlockDescription, onSave: saveToLibrary, saving: blockSaving, error: blockError }
    : undefined;

  // Solution mode: what the solution is called, the automatic verdict against the issue's target, and saving. Nothing is
  // written until then, and then only the solution's own rows: not live, not the draft.
  const [solutionName, setSolutionName] = useState(solutionMode && idea ? idea.title : "");
  // Build it: the AI's steps go into the copy once, in place of the step the idea would replace (or, with none, at the end of the map).
  const seeded = useRef(false);
  // Where the map is looking, for the palette (new steps appear there).
  const viewRef = useRef<(() => ViewHint | null) | null>(null);
  useEffect(() => {
    if (!placement?.edit || seeded.current) return;
    seeded.current = true;
    const edit = placement.edit;
    editor.run(() => edit);
  }, [placement, editor]);
  const [solutionSaving, setSolutionSaving] = useState(false);
  const [solutionError, setSolutionError] = useState<string | null>(null);
  const added = useMemo(() => [...diff.steps.values()].filter((c) => c.kind === "added").map((c) => c.id), [diff]);
  const outlined = useMemo(() => (solutionMode && issue ? currentArea(issue, working.steps, added) : null), [solutionMode, issue, working.steps, added]);
  const area = useMemo(() => (issue ? verdictArea(working.steps, issue, added) : []), [issue, working.steps, added]);
  const saveSolution = async () => {
    setSolutionError(null);
    if (!solutionName.trim()) return setSolutionError("Name the solution first.");
    if (isUnpublished(live)) return setSolutionError("Publish the process first: a solution is a copy of its live version.");
    await editor.settled();
    const now = session.editor.getState().bundle;
    const changes = diffBundles(live, now);
    if (!changes.list.length && !levers.length) return setSolutionError("Change at least one step or lever first. A solution with no changes has nothing to test.");
    setSolutionSaving(true);
    // The automatic verdict. In a workspace the server works it out again from the stored copy and ignores what is sent; the demo has no
    // server, so it keeps the one worked out here, in a worker.
    let auto: TargetVerdict | null = null;
    if (issue && mode === "demo" && workingModel.model) {
      const addedIds = changedStepIds(changes).filter((id) => changes.steps.get(id)?.kind === "added");
      try {
        auto = await verdictInWorker({ target: issue.target, model: workingModel.model, area: verdictArea(now.steps, issue, addedIds) }).promise;
      } catch {
        auto = null;
      }
    }
    const input = {
      name: solutionName,
      processId: live.process.id,
      baseRevisionId: live.revision.id,
      copy: solutionCopy(now),
      changedStepIds: changedStepIds(changes),
      levers,
      links: issue ? [{ issueId: issue.id, autoVerdict: auto && auto.status !== "unchecked" ? auto.status : null, holdsPct: auto?.holdsPct ?? null, autoNote: auto?.note ?? "" }] : [],
    };
    const checked = parseSolutionInput(input);
    let result: SaveSolutionResult;
    if (!checked.ok) result = { status: "error", message: checked.error };
    else if (mode === "demo") {
      const made = addDemoSolution(checked.value);
      result = { status: "ok", ...made };
      if (idea) markDemoIdeaBuilt(idea.id, made.solution.id);
    } else result = await createSolution(live.workspace.id, input, idea?.id);
    setSolutionSaving(false);
    if (result.status === "error") return setSolutionError(result.message);
    router.push(exitHref);
  };
  const solutionForm: SolutionForm | undefined = solutionMode
    ? { name: solutionName, onName: setSolutionName, onSave: saveSolution, saving: solutionSaving, error: solutionError }
    : undefined;
  const restore = useCallback(
    (table: Table, id: string) => {
      editor.run((b) => discardChange(session.getState().live, b, table, id));
    },
    [editor, session],
  );

  // ▶ Simulate: both versions run 30 times, on the models as they were when it was pressed.
  const [pressed, setAsked] = useState<{
    draft: EngineModel;
    live: EngineModel | null;
    draftKey: string;
    liveKey: string | null;
    liveId: string;
    draftId: string | null;
  } | null>(null);
  const workingKey = useMemo(() => (workingModel.model ? JSON.stringify(workingModel.model) : null), [workingModel.model]);
  const liveKey = useMemo(() => (liveModel.model ? JSON.stringify(liveModel.model) : null), [liveModel.model]);
  // The comparison is dropped when a publish made a new live version, or the draft it described was discarded.
  const asked = pressed && pressed.liveId === live.revision.id && !(pressed.draftId !== null && drafts.draft === null) ? pressed : null;
  const draftSim = useSimulation(asked?.draft ?? null);
  const liveSim = useSimulation(asked?.live ?? null);
  const simulating = !!asked && (draftSim.status === "running" || (!!asked.live && liveSim.status === "running"));
  const failed = draftSim.status === "error" ? draftSim.error : liveSim.status === "error" && asked?.live ? liveSim.error : null;
  const pair: SimulatedPair | null = asked
    ? {
        draft: { model: asked.draft, result: draftSim.status === "done" ? draftSim.run.result : null },
        live: asked.live ? { model: asked.live, result: liveSim.status === "done" ? liveSim.run.result : null } : null,
      }
    : null;
  // Stale: the draft, or the live model, is no longer what was simulated.
  const stale = !!asked && (asked.draftKey !== workingKey || asked.liveKey !== liveKey);

  // Solution mode: the automatic verdict for the run on screen, against the issue's target.
  const draftResult = draftSim.status === "done" ? draftSim.run.result : null;
  const liveResult = liveSim.status === "done" ? liveSim.run.result : null;
  const [verdictState, setVerdictState] = useState<{ key: string; result: TargetVerdict } | null>(null);
  const verdictKey = solutionMode && issue && !stale && asked && draftResult && asked.live && liveResult ? `${asked.draftKey}|${area.join(",")}` : null;
  useEffect(() => {
    if (!verdictKey || !issue || !asked) return;
    const job = verdictInWorker({ target: issue.target, model: asked.draft, area });
    job.promise.then((result) => setVerdictState({ key: verdictKey, result })).catch(() => undefined);
    return () => job.cancel();
    // `asked` and `area` are what verdictKey is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdictKey]);
  const verdict = issue && verdictKey && verdictState?.key === verdictKey ? { issue, result: verdictState.result } : null;

  const breaks = useMemo(
    () =>
      hasDraft && liveModel.model && workingModel.model
        ? newlyBroken(liveModel.model, workingModel.model, scenarios, retiredSteps(working, live))
        : [],
    [hasDraft, liveModel.model, workingModel.model, scenarios, working, live],
  );
  const blocked = state.saving
    ? "Wait for your edits to save."
    : state.conflicts.length
      ? "Settle the conflicting edits first (keep mine / keep theirs)."
      : workingModel.error && !company
        ? `The draft can't be simulated: ${workingModel.error}.`
        : null;

  const simulate = () => {
    if (workingModel.model && workingKey) {
      setAsked({ draft: workingModel.model, live: liveModel.model, draftKey: workingKey, liveKey, liveId: live.revision.id, draftId: drafts.draft?.id ?? null });
    }
  };
  const select = (id: string) => setSelection({ steps: [id], edges: [] });

  // A mode that isn't built: nothing on this screen may touch the draft.
  if (!info.available) {
    return (
      <div data-editor={editorMode} className="flex min-h-svh flex-col bg-bg text-fg">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-edit px-4 py-2.5 text-edit-fg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="rounded border-[1.5px] border-current px-1.5 py-px font-mono text-[11px] font-semibold tracking-widest uppercase">✎ Editor</span>
            <h1 className="text-[17px] font-bold">{info.title(live.process.name)}</h1>
          </div>
          <Button type="button" variant="outline" size="sm" className="border-edit-fg/50 bg-transparent text-edit-fg hover:bg-edit-fg/15 hover:text-edit-fg dark:bg-transparent" onClick={() => router.push(exitHref)}>
            Exit editor
          </Button>
        </div>
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-3 p-6">
          <h2 className="text-base font-bold">Coming soon</h2>
          <p className="text-sm text-fg-2">
            {info.arrivesWith} aren&apos;t built yet, so this mode can&apos;t save anything. Nothing here changes {live.process.name} or its draft.
            To change the process itself, exit and open it in the Editor.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div data-editor={editorMode} className="flex min-h-svh flex-col bg-bg text-fg lg:h-svh">
      <EditorBar
        mode={editorMode}
        subject={live.process.name}
        session={session}
        drafts={drafts}
        changes={publishableChanges(diff, hasDraft, extraChanges)}
        saving={state.saving}
        blocked={blocked}
        unresolved={unresolved}
        breaks={breaks}
        company={company}
        onTour={tour.start}
        historyHref={historyHref}
        simulating={simulating}
        onSimulate={simulate}
        onReview={select}
        exitHref={exitHref}
        // The demo lives in this tab, so it stays here to be looked at; a workspace goes back to the map, now live.
        onPublished={() => mode !== "demo" && router.push(exitHref)}
        canSave={info.available}
        blockForm={blockForm}
        solutionForm={solutionForm}
        issue={solutionMode ? issue : null}
      />
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[264px_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)]">
        <aside aria-label="Palette" className="flex flex-col gap-4 border-b border-line bg-panel p-3.5 lg:overflow-y-auto lg:border-r lg:border-b-0">
          <Palette bundle={working} editor={editor} selected={selected} setSelection={setSelection} blocks={blockTools} company={company} viewRef={viewRef} library={libraryProps} />
          {solutionMode && placement && (
            <p role="note" data-idea-note className="rounded-token border border-edit/50 bg-edit-soft p-2 text-xs">
              {placement.note}
            </p>
          )}
          {solutionMode && (levers.length > 0 || (idea?.leverNotes.length ?? 0) > 0) && (
            <LeverChangesBox levers={levers} notes={idea?.leverNotes ?? []} bundle={working} onRemove={(i) => setLevers((l) => l.filter((_, n) => n !== i))} />
          )}
          {solutionMode && <IssueArea issue={issue} steps={[...live.steps, ...working.steps]} present={new Set(working.steps.map((s) => s.id))} onSelect={select} />}
          {mode === "demo" && (
            <p role="note" className="text-xs text-muted-foreground">
              {blockMode
                ? "Demo: the block library lives in this tab only. Reloading starts the sample again."
                : solutionMode
                  ? "Demo: solutions live in this tab only. Reloading starts the sample again."
                  : "Demo: your edits live in this tab only. Leaving the Editor or reloading starts the sample again."}
            </p>
          )}
          <div className="mt-auto flex flex-col gap-2 empty:hidden">
            {!scratch && (
            <PresenceBar
              variant="compact"
              sync={sync}
              state={realtime}
              me={me}
              processName={live.process.name}
              colleague={connection.colleague}
              selectedStep={selected.steps.length === 1 ? selected.steps[0]! : null}
            />
            )}
          </div>
        </aside>
        <main className="flex min-h-[28rem] min-w-0 flex-col gap-2 bg-bg p-3 lg:min-h-0">
          {(state.conflicts.length > 0 || state.error) && <SaveProblems editor={editor} bundle={working} conflicts={state.conflicts} error={state.error} sync={sync} />}
          <MissingForSimulation gaps={gaps} onSelectStep={select} settingsHref={settingsHref} />
          {workingModel.error && !blockMode && !company && (
            <p role="status" className="rounded-token border border-warn bg-warn-soft px-2 py-1.5 text-xs">
              This {solutionMode ? "solution" : "draft"} can&apos;t be simulated yet: {workingModel.error}.
            </p>
          )}
          <div className="flex min-h-0 flex-1" data-tour="canvas" data-highlight-tone={solutionMode ? "issue" : undefined}>
            <ProcessCanvas
              bundle={working}
              result={!stale && pair?.draft.result ? pair.draft.result : null}
              editor={editor}
              editorState={state}
              selection={selected}
              onSelectionChange={setSelection}
              // The company map's cards can't be copied or split (removing one is Delete or the inspector's Remove from this map), so the card menu has nothing to offer.
              commands={company ? null : commands}
              handoffs={company}
              diff={marksChanges ? diff : null}
              highlight={outlined}
              onRestore={restore}
              savedLabel={scratch ? "Edited" : hasDraft ? "Saved to draft" : "Saved"}
              hideAdd
              viewRef={viewRef}
              // Nothing to play until Simulate has run.
              showPlayback={!company && !stale && !!pair?.draft.result}
            />
          </div>
        </main>
        <aside aria-label="Inspector" className="flex flex-col gap-4 border-t border-line bg-panel p-3.5 lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <Inspector
            bundle={working}
            editor={editor}
            selected={selected}
            setSelection={setSelection}
            inspectFocus={inspectFocus}
            onFocused={clearInspectFocus}
            sources={sources}
            stamp={stamp}
            sourcesHref={sourcesHref}
            mode={editorMode}
            blocks={blockTools}
            company={company}
            draft={
              marksChanges
                ? (step) => ({
                    change: diff.steps.get(step.id),
                    names,
                    onRevert: (field) => editor.run((b) => revertField(session.getState().live, b, "steps", step.id, field)),
                    onDiscard: () => editor.run((b) => discardChange(session.getState().live, b, "steps", step.id)),
                  })
                : null
            }
          />
        </aside>
      </div>
      {tour.node}
      {!blockMode && !company && (
      <SimulateFooter
        asked={!!asked}
        pair={pair}
        failed={failed}
        stale={stale}
        currency={working.workspace.settings.currency}
        liveNumber={live.revision.number}
        solution={solutionMode}
        verdict={verdict}
        incomplete={gaps.length}
      />
      )}
    </div>
  );
}
