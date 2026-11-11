"use client";

// The Editor (issue #104): editing a process on its own full-screen page, in the edit colour, not a mode of the map.
// A left column with the palette, the map in the middle, the inspector on the right, and "Compared with live" below
// after Simulate. Edits go to the process's single draft (D18); Publish makes it the next live version.
//
// The mode is a parameter (`draft`, `solution`, `block`): the hint and the save buttons change with it. Draft mode is
// built here, block mode (issue #116: an empty map saved to the block library, nothing of the process touched) and solution
// mode (issue #114: a copy of live, edited in memory and saved as a solution of its own; the process's live version and its
// single draft are never touched, D18).

import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { retiredSteps, isUnpublished, workspacePurposes, type BlockBundle, type BlockRow, type ProcessBundle, type PurposeCategory, type ScenarioRow, type StoredStepChange } from "@transpera-flow/db";
import { createSolution } from "@/app/w/[slug]/solution-actions";
import { addPurpose } from "@/app/w/[slug]/settings/actions";
import { createLibraryProcess } from "@/app/w/[slug]/library-actions";
import type { LibraryProcess } from "@/lib/editor/library";
import type { LibraryCreate } from "@/lib/editor/library-create";
import { blockFromSteps, bundleFromBlock, turnIntoSteps, turnIntoStepsProblem } from "@/lib/blocks/blocks";
import { firstProblem, nodeProblems, problemsLine, publishBlocker } from "@/lib/editor/problems";
import type { PurposeTools } from "@/components/step-inspector";
import { parseBlockInput } from "@/lib/blocks/save";
import { newStepRow } from "@/lib/editor/commands";
import type { ViewHint } from "@/lib/editor/groups";
import { discardChange, revertField } from "@/lib/drafts/discard";
import { EMPTY_DIFF, diffBundles, publishableChanges, unresolvedSteps } from "@/lib/drafts/diff";
import { useDraftSession } from "@/lib/drafts/use-draft-session";
import { namesOf } from "@/lib/editor/describe";
import type { Table } from "@/lib/editor/ops";
import { MODE_INFO, NO_ISSUE_REFUSAL, editorHorizonWeeks, type EditorMode } from "@/lib/editor/modes";
import { connect, connectScratch } from "@/lib/drafts/connect";
import { newlyBroken } from "@/lib/scenarios/broken";
import { currentArea, type SolutionIssue } from "@/lib/solutions/area";
import { changedStepIds, solutionCopy } from "@/lib/solutions/bundle";
import { addDemoSolution } from "@/lib/solutions/demo";
import { parseSolutionInput, type SaveSolutionResult } from "@/lib/solutions/save";
import { PROCESS_CATEGORY_LABELS } from "@transpera-flow/db";
import { NO_SELECTION, ProcessCanvas, type Selection } from "@/components/process-canvas";
import { laneOfProcesses, laneSpecs, type DepartmentLaneInput } from "@/lib/overview/department-lanes";
import { SaveProblems } from "@/components/save-problems";
import { useEngineModel, type EditMode } from "@/lib/sim/use-engine-model";
import { BAR_CLASS, BarButton, BlockFormFields, DraftMessages, EditorBar, EditorGuide, EditorTag, SolutionFormFields, type BlockForm, type SolutionForm } from "./editor-bar";
import { PanelResizer, PanelToggle } from "./panel-chrome";
import { usePanelLayout } from "./use-panel-layout";
import { cn } from "@/lib/utils";
import { IssueArea } from "./issue-area";
import { Inspector } from "./inspector";
import { Palette } from "./palette";
import { useEditorTour } from "./editor-tour";
import type { TierSetup } from "@/lib/tier-setup";
import { useBlockTools } from "./use-blocks";
import { useEditCommands } from "./use-edit-commands";

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
  userId = null,
  canAddPurpose,
  settingsHref,
  exitHref,
  horizonMonths = null,
  issue = null,
  processEditorHref,
  blockEditorHref,
  editBlock,
  solutionSeed,
  tourDismissed = false,
  historyHref,
  library,
  tierSetup,
  stepChanges: storedStepChanges,
  laneInput,
}: {
  /** The departments, tier services and servicing links the company map's lanes come from (Q4). Absent: no lanes. */
  laneInput?: DepartmentLaneInput;
  /** The workspace's tiers and their deliverables, for the step base values (capacity P4). */
  tierSetup?: TierSetup;
  /** The automations and augmentations already stored on the solution being edited (D53). The Editor no longer edits them (editor brainstorm, item 11); they are kept and saved with the solution as they are. */
  stepChanges?: readonly StoredStepChange[];
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
  userId?: string | null;
  /**
   * "+ New purpose…" on a step's "What it achieves": the signed-in person can edit the workspace's purposes (the Editor only opens for those who
   * can edit the workspace). Default: in a workspace yes, on the demo no (nothing there to save to).
   */
  canAddPurpose?: boolean;
  /** The database says this person has already dismissed the Editor's written tour. */
  tourDismissed?: boolean;
  /** The History page of what is being edited, for the bar's History button. */
  historyHref?: string;
  /** The workspace's Settings page, which "Missing for simulation" links to for incoming volume. */
  settingsHref?: string;
  /** Where Exit editor goes. */
  exitHref: string;
  /** The horizon picked on the map, in months; null runs the model at its own length. */
  horizonMonths?: number | null;
  /** Solution mode: the issue the solution is built for, whose steps are outlined and whose target the verdict is checked against. */
  issue?: SolutionIssue | null;
  /** Solution mode: where "Edit the process instead" (the process's draft) and "Save as a block" (block mode) go when a save is refused for want of an issue. */
  processEditorHref?: string;
  blockEditorHref?: string;
  /** Block mode only: a block of the library to edit (Q15); without it block mode starts on an empty map. */
  editBlock?: { id: string; name: string; description: string; bundle: BlockBundle };
  /** Solution mode opened from a solution's page ("Open in editor", `?solution=<id>`): the map starts as that solution's copy, not as live. */
  solutionSeed?: { bundle: ProcessBundle; name: string };
  /** The process library (B12): the workspace's processes, and where each sits (live links). */
  library?: { processes: LibraryProcess[]; /** Makes a process for the library; default in a workspace is the server action (a harness stands in). */ onCreate?: LibraryCreate };
}) {
  const router = useRouter();
  // The company map (B11): the processes of the business as cards, moved and joined by handoff lines. It is not run from here (the Sandbox runs the company from it), so no Simulate or problems.
  const company = initialLive.process.is_company === true;
  const stamp = useCallback(() => ({ at: new Date().toISOString(), by: userId }), [userId]);
  const blockMode = editorMode === "block";
  // The library makes new processes on the server, as the signed-in editor; the demo (memory) only places existing ones.
  const workspaceId = initialLive.workspace.id;
  const onCreate = useCallback<LibraryCreate>((input) => createLibraryProcess(workspaceId, input), [workspaceId]);
  const libraryProps = useMemo(() => (library ? { ...library, ...(library.onCreate ? {} : mode === "live" ? { onCreate } : {}) } : undefined), [library, mode, onCreate]);
  // The solution's stored automations and augmentations (D53), carried unchanged into Save solution so a copy keeps them.
  const stepChanges = storedStepChanges ?? [];
  const solutionMode = editorMode === "solution";
  // Block and solution modes edit a map of their own, in memory: never the process's live version or its draft. A block
  // starts empty; a solution starts as a copy of live.
  const scratch = blockMode || solutionMode;
  // A solution opened from its own page starts as its copy; what is marked as changed, simulated and saved is still measured against live.
  const fromSolution = solutionMode && solutionSeed !== undefined;
  const [seed] = useState(() => (blockMode ? (editBlock ? bundleFromBlock(initialLive, editBlock.bundle, editBlock.name) : blockScratch(initialLive)) : fromSolution ? solutionSeed!.bundle : initialLive));
  const [backend] = useState(() => (scratch ? connectScratch(seed) : connect(mode, seed)));
  const [session, drafts, state] = useDraftSession(seed, scratch ? null : initialDraft, () => backend, () => ({ at: new Date().toISOString(), by: userId }));
  const editor = session.editor;
  const info = MODE_INFO[editorMode];
  const hasDraft = !scratch && (drafts.draft !== null || drafts.opening);
  // What the map marks as new or changed: against the draft's live version, or the solution's copy of it.
  const marksChanges = hasDraft || solutionMode;
  const live = fromSolution ? initialLive : drafts.live;
  const working = state.bundle;
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  // The written tour: opens the first time this user opens the Editor, and again from "Take the tour".
  const tour = useEditorTour({ userId, company, dismissed: tourDismissed });
  // The palette and the inspector fold to a rail, and the inspector's width is dragged; both are remembered per browser.
  const panels = usePanelLayout();

  const diff = useMemo(() => (marksChanges ? diffBundles(live, working) : EMPTY_DIFF), [marksChanges, live, working]);
  const names = useMemo(() => namesOf(working, live), [working, live]);
  // The company map's department lanes (Q4): each holder card goes in the lane of the process it holds.
  // A pill with the category of the process each holder card holds (Q4, with Q3's labels).
  const cardTags = useMemo(() => {
    if (!company) return undefined;
    const label = new Map((working.otherProcesses ?? []).map((p) => [p.process.id, PROCESS_CATEGORY_LABELS[p.process.category]] as const));
    return new Map(working.steps.flatMap((s) => (s.child_process_id && label.has(s.child_process_id) ? [[s.id, label.get(s.child_process_id)!] as const] : [])));
  }, [company, working.otherProcesses, working.steps]);
  const departmentLanes = useMemo(() => {
    if (!company || !laneInput) return undefined;
    const lane = laneOfProcesses((working.otherProcesses ?? []).map((p) => p.process), laneInput);
    const laneOf = new Map(working.steps.flatMap((s) => (s.child_process_id && lane.has(s.child_process_id) ? [[s.id, lane.get(s.child_process_id)!] as const] : [])));
    return { spec: { lanes: laneSpecs(laneInput), laneOf } };
  }, [company, laneInput, working.otherProcesses, working.steps]);
  const weeks = editorHorizonWeeks(editorMode, horizonMonths);
  const workingModel = useEngineModel(working, weeks);
  const liveModel = useEngineModel(live, weeks);
  const unresolved = useMemo(() => unresolvedSteps(working), [working]);
  // Selection can outlive what it points at (after a delete or an undo).
  const selected = useMemo(() => {
    const steps = new Set(working.steps.map((s) => s.id));
    const edges = new Set(working.edges.map((e) => e.id));
    return { steps: selection.steps.filter((id) => steps.has(id)), edges: selection.edges.filter((id) => edges.has(id)) };
  }, [working, selection]);

  // A branch of a decision, picked on its line or its row or its "Go back to" node, is the decision in the panel with that branch's fields in
  // focus (the keys and the map keep the line selected, so Delete takes the line, not the decision).
  const { inspected, branchFocus } = useMemo(() => {
    // On the company map too: a decision there has branches (QA round 2, item 7).
    const only = selected.steps.length === 0 && selected.edges.length === 1 ? working.edges.find((e) => e.id === selected.edges[0]) : undefined;
    const from = only && working.steps.find((s) => s.id === only.from_step_id);
    return from?.kind === "decision" ? { inspected: { steps: [from.id], edges: [] as string[] }, branchFocus: only!.id } : { inspected: selected, branchFocus: null };
  }, [selected, working.edges, working.steps]);
  // A branch just added is put in focus even though the line isn't selected.
  const pickKey = `${selection.steps.join(",")}|${selection.edges.join(",")}`;
  const [freshBranch, setFreshBranch] = useState<{ key: string; id: string } | null>(null);
  const focusBranch = useCallback((edgeId: string | null) => setFreshBranch(edgeId ? { key: pickKey, id: edgeId } : null), [pickKey]);
  const addedBranch = freshBranch && freshBranch.key === pickKey ? freshBranch.id : null;

  // What stops the process simulating, by step and by line: the red marks on the map, and the bar's line that jumps to the first.
  // A block is a piece of a process, which is joined up where it is used: its loose ends are not things to fix, so it has no line (its steps keep the map's own marks).
  const problems = useMemo(() => (company || blockMode ? null : nodeProblems(working)), [company, blockMode, working]);
  const problemLine = problems ? problemsLine(problems.total) : null;
  const jumpToProblem = () => {
    const first = problems ? firstProblem(working, problems) : null;
    if (first?.kind === "step") setSelection({ steps: [first.id], edges: [] });
    else if (first) setSelection({ steps: [], edges: [first.id] });
  };

  // Purposes: the workspace's list as loaded, plus any added here (a purpose is saved to the workspace at once, so the step can take it).
  const [storedPurposes, setStoredPurposes] = useState<PurposeCategory[] | null>(() => working.workspace.settings.purposes ?? null);
  const purposeTools = useMemo<PurposeTools>(() => {
    const settings = { ...working.workspace.settings, purposes: storedPurposes };
    const list = workspacePurposes(settings);
    const workspaceId = working.workspace.id;
    const may = canAddPurpose ?? mode === "live";
    return {
      list,
      settings,
      adder: may
        ? {
            count: list.length,
            add: async (input) => {
              const out = await addPurpose(workspaceId, storedPurposes, input);
              if (out.status === "saved") {
                setStoredPurposes(out.purposes);
                return { ok: true, key: out.key };
              }
              if (out.status === "conflict") {
                // Someone else changed the list meanwhile: show theirs, and the person can add theirs again.
                setStoredPurposes(out.theirs);
                return { ok: false, message: "Someone else just changed the purposes. The list is up to date now: add yours again." };
              }
              return { ok: false, message: out.status === "error" ? out.message : "That purpose couldn't be added." };
            },
          }
        : null,
    };
  }, [working.workspace.settings, working.workspace.id, storedPurposes, canAddPurpose, mode]);

  // "Turn into steps" on a step that holds a linked process: copy its steps in, cut the link.
  const [turnNote, setTurnNote] = useState<string | null>(null);
  const partOf = useCallback((holderId: string) => working.otherProcesses?.find((p) => p.process.id === working.steps.find((s) => s.id === holderId)?.child_process_id), [working.otherProcesses, working.steps]);
  const turnInto = useMemo(
    () => ({
      problem: (holderId: string) => turnIntoStepsProblem(working, holderId, partOf(holderId)),
      said: turnNote,
      run: (holderId: string) => {
        let made: string | null = null;
        let said: string | null = null;
        editor.run((b) => {
          const part = b.otherProcesses?.find((p) => p.process.id === b.steps.find((s) => s.id === holderId)?.child_process_id);
          const r = turnIntoSteps(b, holderId, part);
          if (!r) said = turnIntoStepsProblem(b, holderId, part) ?? "That couldn't be turned into steps.";
          made = r?.id ?? null;
          return r?.edit ?? null;
        });
        setTurnNote(said);
        setSelection(made ? { steps: [made], edges: [] } : { steps: [holderId], edges: [] });
      },
    }),
    [working, partOf, turnNote, editor],
  );

  // "Open process page" on a node that links to a process (QA round 2, item 7). The demo has no process pages to open.
  const slug = initialLive.workspace.slug;
  const openProcess = useCallback((processId: string) => router.push(`/w/${slug}/p/${processId}`), [router, slug]);
  const { commands, inspectFocus, clearInspectFocus } = useEditCommands({ editor, bundle: working, selected, setSelection, ...(mode === "live" ? { openProcess } : {}) });
  // Where the map is looking, for the palette (new steps appear there).
  const viewRef = useRef<(() => ViewHint | null) | null>(null);
  const blockTools = useBlockTools({
    mode: mode === "demo" ? "demo" : "live",
    workspaceId: live.workspace.id,
    blocks,
    bundle: working,
    editor,
    selected,
    setSelection,
    processName: initialLive.process.name,
    viewRef,
  });

  // Block mode: what the block is called, and saving it. Nothing is written until then.
  const [blockName, setBlockName] = useState(editBlock?.name ?? "");
  const [blockDescription, setBlockDescription] = useState(editBlock?.description ?? "");
  const [blockSaving, setBlockSaving] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const saveToLibrary = async () => {
    setBlockError(null);
    await editor.settled();
    const input = { name: blockName, description: blockDescription, bundle: blockFromSteps(session.editor.getState().bundle) };
    const checked = parseBlockInput(input);
    if (!checked.ok) return setBlockError(checked.error);
    setBlockSaving(true);
    const result = editBlock ? await blockTools.update(editBlock.id, checked.value) : await blockTools.save(checked.value);
    setBlockSaving(false);
    if (result.status === "error") return setBlockError(result.message);
    router.push(exitHref);
  };
  const blockForm: BlockForm | undefined = blockMode
    ? { name: blockName, description: blockDescription, onName: setBlockName, onDescription: setBlockDescription, onSave: saveToLibrary, saving: blockSaving, error: blockError, editing: !!editBlock }
    : undefined;

  // Solution mode: what the solution is called, the automatic verdict against the issue's target, and saving. Nothing is
  // written until then, and then only the solution's own rows: not live, not the draft.
  const [solutionName, setSolutionName] = useState(() => (solutionSeed ? `Copy of ${solutionSeed.name}` : ""));
  const [solutionSaving, setSolutionSaving] = useState(false);
  const [solutionError, setSolutionError] = useState<string | null>(null);
  // Set when the save was refused because no issue is linked: the two ways out are offered beside the message.
  const [refusedWithout, setRefusedWithout] = useState(false);
  const added = useMemo(() => [...diff.steps.values()].filter((c) => c.kind === "added").map((c) => c.id), [diff]);
  const outlined = useMemo(() => (solutionMode && issue ? currentArea(issue, working.steps, added) : null), [solutionMode, issue, working.steps, added]);
  const saveSolution = async () => {
    setSolutionError(null);
    setRefusedWithout(false);
    // Every solution fixes an issue (Q12): without one there is nothing to test it against, and it would have no place in the list.
    if (!issue) {
      setRefusedWithout(true);
      return setSolutionError(NO_ISSUE_REFUSAL);
    }
    if (!solutionName.trim()) return setSolutionError("Name the solution first.");
    if (isUnpublished(live)) return setSolutionError("Publish the process first: a solution is a copy of its live version.");
    await editor.settled();
    const now = session.editor.getState().bundle;
    const changes = diffBundles(live, now);
    if (!changes.list.length && !stepChanges.length) return setSolutionError("Change at least one step first. A solution with no changes has nothing to test.");
    setSolutionSaving(true);
    const input = {
      name: solutionName,
      processId: live.process.id,
      baseRevisionId: live.revision.id,
      copy: solutionCopy(now),
      changedStepIds: changedStepIds(changes),
      levers: [],
      // Only the effects on the saved copy's steps are kept, and the server checks them again.
      stepChanges: [...stepChanges],
      // No automatic verdict (QA round 2): the person gives their own on the issue.
      links: issue ? [{ issueId: issue.id, autoVerdict: null, holdsPct: null, autoNote: "" }] : [],
    };
    const checked = parseSolutionInput(input);
    let result: SaveSolutionResult;
    if (!checked.ok) result = { status: "error", message: checked.error };
    else if (mode === "demo") {
      const made = addDemoSolution(checked.value);
      result = { status: "ok", ...made };
    } else result = await createSolution(live.workspace.id, input);
    setSolutionSaving(false);
    if (result.status === "error") return setSolutionError(result.message);
    router.push(exitHref);
  };
  const solutionForm: SolutionForm | undefined = solutionMode
    ? { name: solutionName, onName: setSolutionName, onSave: saveSolution, saving: solutionSaving, error: solutionError, refusedWithout: refusedWithout && processEditorHref && blockEditorHref ? { processHref: processEditorHref, blockHref: blockEditorHref } : null }
    : undefined;
  const restore = useCallback(
    (table: Table, id: string) => {
      editor.run((b) => discardChange(session.getState().live, b, table, id));
    },
    [editor, session],
  );

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

  const select = (id: string) => setSelection({ steps: [id], edges: [] });

  // A mode that isn't built: nothing on this screen may touch the draft.
  if (!info.available) {
    return (
      <div data-editor={editorMode} className="flex min-h-svh flex-col bg-bg text-fg">
        <div className={BAR_CLASS}>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <EditorTag />
            <h1 className="min-w-0 truncate text-base font-semibold">{info.title(live.process.name)}</h1>
          </div>
          <BarButton onClick={() => router.push(exitHref)}>Exit editor</BarButton>
        </div>
        <main className="flex w-full flex-1 flex-col gap-3 p-6">
          <h2 className="text-base font-semibold">Coming soon</h2>
          <p className="max-w-prose text-sm text-fg-2">
            {info.arrivesWith} aren&apos;t built yet, so this mode can&apos;t save anything. Nothing here changes {live.process.name} or its draft.
            To change the process itself, exit and open it in the Editor.
          </p>
        </main>
      </div>
    );
  }

  const problemsProp = problemLine ? { line: problemLine, onJump: jumpToProblem, canJump: !!problems && !!firstProblem(working, problems) } : null;
  const { paletteCollapsed, inspectorCollapsed, inspectorWidth } = panels.layout;
  // Something in the folded inspector wants attention: things to fix, or a form's refusal.
  const inspectorAlert = !!problemsProp || !!blockForm?.error || !!solutionForm?.error;

  // From lg the Editor is exactly the screen: the page itself never scrolls (only the panels and the map do), so a fast scroll in a
  // panel can't carry past it into empty space.
  return (
    <div data-editor={editorMode} className="flex min-h-svh flex-col bg-bg text-fg lg:h-svh lg:max-h-svh lg:overflow-hidden">
      <EditorBar
        mode={editorMode}
        subject={live.process.name}
        session={session}
        drafts={drafts}
        changes={publishableChanges(diff)}
        saving={state.saving}
        blocked={blocked}
        unresolved={unresolved}
        breaks={breaks}
        company={company}
        publishBlocked={problems ? publishBlocker(problems.total) : null}
        onTour={tour.start}
        historyHref={historyHref}
        history={{ undoLabel: state.undoLabel, redoLabel: state.redoLabel, onUndo: () => editor.undo(), onRedo: () => editor.redo() }}
        onReview={select}
        exitHref={exitHref}
        // The demo lives in this tab, so it stays here to be looked at; a workspace goes back to the map, now live.
        onPublished={() => mode !== "demo" && router.push(exitHref)}
        canSave={info.available}
        blockForm={blockForm}
        solutionForm={solutionForm}
        issue={solutionMode ? issue : null}
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside aria-label="Palette"
          data-collapsed={paletteCollapsed ? "" : undefined}
          className={cn("flex shrink-0 flex-col border-b border-line bg-panel lg:min-h-0 lg:border-r lg:border-b-0", paletteCollapsed ? "lg:w-11" : "lg:w-60")}
        >
          <PanelToggle side="left" collapsed={paletteCollapsed} onToggle={panels.togglePalette} label="palette" />
          <div className={cn("flex min-h-0 flex-1 flex-col gap-4 p-3.5 lg:overflow-y-auto lg:overscroll-contain lg:pt-0", paletteCollapsed && "lg:hidden")}>
            <Palette bundle={working} editor={editor} selected={inspected} setSelection={setSelection} blocks={blockTools} company={company} viewRef={viewRef} library={libraryProps} />
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
          </div>
        </aside>
        <main className="relative flex min-h-[28rem] min-w-0 flex-1 flex-col bg-bg lg:min-h-0">
          {(state.conflicts.length > 0 || state.error || drafts.notice || drafts.error) && (
            <div className="flex flex-col gap-2 border-b border-line p-2">
              <SaveProblems editor={editor} bundle={working} conflicts={state.conflicts} error={state.error} />
              <DraftMessages drafts={drafts} session={session} />
            </div>
          )}
          {/* Edge to edge: the map's own frame (a rounded border) is dropped, the panels' borders are its edges. */}
          <div className="flex min-h-0 flex-1 [&>[data-process-map]]:rounded-none [&>[data-process-map]]:border-0" data-tour="canvas" data-highlight-tone={solutionMode ? "issue" : undefined}>
            <ProcessCanvas
              bundle={working}
              result={null}
              editor={editor}
              editorState={state}
              selection={selected}
              onSelectionChange={setSelection}
              // The same right-click menu on both maps (QA round 2, item 7); a linked card can't be copied, and offers its process's page.
              commands={commands}
              handoffs={company}
              departmentLanes={departmentLanes}
              cardTags={cardTags}
              diff={marksChanges ? diff : null}
              highlight={outlined}
              onRestore={restore}
              savedLabel={scratch ? "Edited" : hasDraft ? "Saved to draft" : "Saved"}
              hideAdd
              problems={problems}
              branchNodes
              onTurnIntoSteps={turnInto.run}
              viewRef={viewRef}
              // The Editor edits; it doesn't run the process (brainstorm round 2, item 7), so there is nothing to play.
              showPlayback={false}
            />
          </div>
        </main>
        <aside aria-label="Inspector"
          data-collapsed={inspectorCollapsed ? "" : undefined}
          style={{ "--inspector-w": `${inspectorWidth}px` } as CSSProperties}
          className={cn("relative flex shrink-0 flex-col border-t border-line bg-panel lg:min-h-0 lg:border-t-0 lg:border-l", inspectorCollapsed ? "lg:w-11" : "lg:w-(--inspector-w)")}
        >
          {!inspectorCollapsed && <PanelResizer width={inspectorWidth} onWidth={panels.setInspectorWidth} />}
          <PanelToggle side="right" collapsed={inspectorCollapsed} onToggle={panels.toggleInspector} label="inspector" alert={inspectorAlert} />
          <div className={cn("flex min-h-0 flex-1 flex-col gap-4 p-3.5 lg:overflow-y-auto lg:overscroll-contain lg:pt-0", inspectorCollapsed && "lg:hidden")}>
            {blockForm && <BlockFormFields form={blockForm} />}
            {solutionForm && <SolutionFormFields form={solutionForm} />}
            <EditorGuide mode={editorMode} company={company} issue={solutionMode ? issue : null} blockEditing={!!blockForm?.editing} problems={problemsProp} />
            <Inspector
              bundle={working}
              editor={editor}
              selected={inspected}
              setSelection={setSelection}
              inspectFocus={inspectFocus}
              onFocused={clearInspectFocus}
              stamp={stamp}
              purposes={purposeTools}
              branchFocus={branchFocus ?? addedBranch}
              onFocusBranch={focusBranch}
              turnInto={turnInto}
              blocks={blockTools}
              company={company}
              tierSetup={tierSetup}
              settingsHref={settingsHref}
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
          </div>
        </aside>
      </div>
      {tour.node}
    </div>
  );
}
