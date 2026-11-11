"use client";

// The process map (PRD §8.1): custom step nodes (role stripe, queue count,
// bottleneck ring, selection ring, branch warning) and branch edges. With an
// editor it is editable (issue #8): drag to move, drag handle to handle to
// connect, drag an edge end to reroute, click an edge to set its probability
// and condition tag, double-click empty canvas or use the toolbar to add a
// step. Double-click a step (or focus it and press Enter or F2) to edit it in
// place; right-click it (or Shift+F10) for its menu. Shift-click and
// Shift-drag select several steps. The swimlane view groups steps by role.
// Every change goes through the editor, so it is undoable and saved.
// In a draft (issue #9) the map shows the diff against live: new steps and
// connections dashed, removed ones as struck-through ghosts (with Restore),
// changed values old → new, and unconfirmed estimates badged.

import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  type AriaLabelConfig,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Clock, Flag, Play, Split, Undo2 } from "lucide-react";
import { RATING_LABELS, type Rating, type SimulationResult } from "@transpera-flow/engine";
import {
  EVIDENCE_COLUMNS,
  ancestorsOf,
  badgeQuote,
  isGroup,
  isOpenAssumption,
  leavesIn,
  isWorkingStep,
  openConflict,
  rollUp,
  visibleEdges,
  visibleSteps,
  type PersonRow,
  type ProcessBundle,
  type RoleRow,
  type RollUp,
  type StepOutcome,
  type StepRow,
} from "@transpera-flow/db";
import {
  KIND_LABELS,
  OUTCOME_LABELS,
  STEP_KINDS,
  addEdge,
  addStep,
  connectionProblem,
  deleteEdges,
  moveSteps,
  nextOutcome,
  bendEdge,
  reconnectEdge,
  stepWarnings,
  updateEdge,
  type NewStepKind,
} from "@/lib/editor/commands";
import type { ViewRef } from "@/lib/editor/groups";
import { discardProblem } from "@/lib/drafts/discard";
import type { ChangeKind, DraftDiff, StepChange } from "@/lib/drafts/diff";
import type { EditorState, ProcessEditor } from "@/lib/editor/editor";
import type { InlineField } from "@/lib/editor/inline-edit";
import type { Table } from "@/lib/editor/ops";
import { bandLayout, laneLayout, type BandSpec, type Lane, type LaneLayout } from "@/lib/editor/lanes";
import { CARD_SIZE, GROUP_CARD, TERMINAL_SIZE, groupIds, openGroupSize } from "@/lib/map/groups";
import { groupsToOpen, litIds, withHighlightOpen } from "@/lib/map/highlight";
import { ratingOfRank } from "@/lib/map/rating";
import { ISSUE_PILL_CLASS, tileColours, tileHeadline } from "@/lib/map/tile";
import { MIN_ZOOM, autoPanelHeight, fitViewport, stepZoom, type Padding } from "@/lib/map/zoom";
import { countRender } from "@/lib/map/render-count";
import { useStableHandler } from "@/lib/use-stable-handler";
import { MapKey, MapLegend, MapViewControls } from "./map/map-controls";
import { Button } from "./ui/button";
import { TagPill } from "./tag-pill";
import { ProblemMark } from "./editor/problem-mark";
import type { NodeProblems } from "@/lib/editor/problems";
import { GO_BACK_LINK_PREFIX, branchRows, edgeOfGoBackNode, goBackNodes, isGoBackNodeId, type BranchRow } from "@/lib/editor/branch-view";
import { addBranch, goBackProblem, setBranchShare, setBranchTarget, type BranchTarget } from "@/lib/editor/branches";
import { FirstRunStatus } from "./map/map-placeholder";
import { EmptyState } from "./shell/empty-state";
import { NO_EXTRAS, StepDetail, sourcesOf, type StepExtras } from "./map/step-detail";
import { formatHours } from "@/lib/format";
import { usePlayback } from "@/lib/playback/use-playback";
import { InlineEditContext, NodeInlineEditor, type InlineEditing } from "./node-inline-editor";
import { PlaybackBar } from "./playback-bar";
import { PlaybackLayer } from "./playback-layer";
import { NodeMenu, type CanvasCommands, type MenuState } from "./node-menu";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { SplitBar } from "./split-bar";

export type { CanvasCommands } from "./node-menu";

/** What is selected on the canvas. */
export interface Selection {
  steps: string[];
  edges: string[];
}

export const NO_SELECTION: Selection = { steps: [], edges: [] };

type StepNodeData = {
  step: StepRow;
  role: RoleRow | null;
  person: PersonRow | null;
  avgQueue: number | null;
  /** Hours an item queues before work starts, in this run; null without a run. */
  avgWait: number | null;
  bottleneck: boolean;
  /** What stops the process simulating, on this step (the Editor's red mark); empty when nothing does. */
  problems: readonly string[];
  /** A decision on a map with branch rows (`branchNodes`): its branches, one row each on the card, each with its own dot; null for any other step. */
  branches: BranchRow[] | null;
  /** The branch of this decision that is selected (its line or its row was clicked), if any. */
  branchSelected: string | null;
  /** The Editor's node types (Step, Wait, Decision, Start, End) each look their own way. */
  typed: boolean;
  editable: boolean;
  /** Name of the step its rework goes back to, if not itself. */
  reworkTo: string | null;
  /** The field to focus while the card is being edited in place; null when it isn't. */
  editing: InlineField | null;
  /** The bottleneck, while playback plays. */
  pulse: boolean;
  /** How the draft changed this step against live; null outside a draft or when unchanged. */
  change: ChangeKind | null;
  /** A step the draft removed, drawn where it is live. */
  ghost: boolean;
  /** A removed step that can be put back from its card. */
  restorable: boolean;
  /** The step's values are unconfirmed estimates (assumptions). */
  estimate: boolean;
  /** Sources disagree on one of the step's values (issue #21). */
  conflict: boolean;
  /** The quotes behind the step's conflict or assumption, for the badge's tooltip. */
  quote: string | null;
  /** Live values the draft changed, as shown on the card. */
  wasName: string | null;
  wasWho: string | null;
  wasWork: string | null;
  wasWait: string | null;
  /** The step's rating, which colours its card; null when it hasn't been rated. */
  rating: Rating | null;
  /** The map has ratings, so a tile says what its rating is (even "Nothing to fix"). */
  rated: boolean;
  /** Highlighting (issue #99): true outlined, false dimmed, null when nothing is highlighted. */
  lit: boolean | null;
};

/** Removed steps and connections are drawn under ids of their own, next to the draft's rows. */
const ghostId = (id: string) => `ghost:${id}`;

/**
 * A group of steps, or a step holding a child process (issue #102). Closed it is
 * one card with a roll-up of the steps inside it; open (groups only) it is a box
 * around them. Either way the engine simulates the steps inside, never this.
 */
type GroupNodeData = {
  step: StepRow;
  open: boolean;
  /** Only a group opens in place; a child process has a page of its own. */
  expandable: boolean;
  roll: RollUp;
  problems: readonly string[];
  editable: boolean;
  change: ChangeKind | null;
  /** The worst rating inside, which colours a closed card. */
  rating: Rating | null;
  /** The map has ratings, so a closed card says what its worst rating is (even "Nothing to fix"). */
  rated: boolean;
  /** Highlighting: true outlined, false dimmed (closed cards only), null when nothing is highlighted. */
  lit: boolean | null;
  /** The process's category as a small pill (the company map; Q4), or null. */
  tag: string | null;
  /** The Sandbox's "New version: <name>" on a process that runs a new map version: a pill under the card and an accent outline. */
  badge: string | null;
};

/** The small "Go back to X" node drawn at the end of a decision's branch that loops to an earlier step (editor brainstorm, item 6). */
type GoBackNodeData = { edgeId: string; targetName: string; branchName: string; problems: readonly string[]; editable: boolean };

type StepFlowNode = Node<StepNodeData, "step">;
type TerminalFlowNode = Node<StepNodeData, "terminal">;
type GroupFlowNode = Node<GroupNodeData, "group">;
type GoBackFlowNode = Node<GoBackNodeData, "goback">;
type FlowNode = StepFlowNode | TerminalFlowNode | GroupFlowNode | GoBackFlowNode;

/** Whether two node objects for a step would draw the same. */
function sameNode(a: StepFlowNode | TerminalFlowNode, b: StepFlowNode | TerminalFlowNode): boolean {
  if (a.type !== b.type || a.selected !== b.selected || a.ariaLabel !== b.ariaLabel || a.zIndex !== b.zIndex) return false;
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
  if (a.measured?.width !== b.measured?.width || a.measured?.height !== b.measured?.height) return false;
  // The lists (problems, branch rows) are made afresh each time: same when they hold the same.
  const same = (x: unknown, y: unknown) => x === y || (Array.isArray(x) && Array.isArray(y) && JSON.stringify(x) === JSON.stringify(y));
  return (Object.keys(a.data) as (keyof StepNodeData)[]).every((k) => same(a.data[k], b.data[k]));
}

/**
 * `alone`: it is the only thing selected, so its inline editor shows.
 * `was`: its live label, when the draft changed its share or tag.
 */
type BranchData = {
  probability: number;
  tag: string | null;
  alone: boolean;
  change: ChangeKind | null;
  was: string | null;
  ghost: boolean;
  restorable: boolean;
  /** Drawn to or from a closed group in place of the steps inside it: no share, not editable. */
  rolled?: boolean;
  /** A handoff line's label, on the company map. */
  label?: string | null;
  /** On the company map, a branch of a decision: it shows its share, not a handoff label. */
  decided?: boolean;
  /** What stops the process simulating, on this line (the Editor's red mark). */
  problems?: readonly string[];
  /** A branch of a decision in the Editor: its name shows with its share, and it is edited from the decision's panel, not on the line. */
  branch?: { name: string } | null;
  /** How far the line's middle segment is moved from where it sits automatically (`center_dx`, `center_dy`); null: automatic. */
  bend?: { x: number; y: number } | null;
  /** The line's middle can be dragged (an editable map, a line drawn as itself, not a go back): its grab handle shows when selected. */
  bendable?: boolean;
};
type BranchFlowEdge = Edge<BranchData, "branch">;

/** Lets custom nodes and edges reach the editor without threading it through React Flow's data. */
const CanvasContext = createContext<{
  editor: ProcessEditor | null;
  restore: ((table: Table, id: string) => void) | null;
  toggleGroup: (id: string) => void;
  handoffs: boolean;
  /** A click on a branch's row of a decision card: select that branch (the Editor puts its decision in the panel, with the row in focus). */
  selectBranch: (edgeId: string) => void;
  /** "Turn into steps" on a linked process's card; null where the map can't. */
  turnInto: ((stepId: string) => void) | null;
}>({
  editor: null,
  restore: null,
  toggleGroup: () => undefined,
  handoffs: false,
  selectBranch: () => undefined,
  turnInto: null,
});

const pillClass = "rounded-full border px-1.5 text-[10px] leading-4 font-semibold";

/**
 * On a tile's top-left edge: "Bottleneck" for the run's bottleneck, then "New",
 * "Changed" or "Removed" in a draft. Outside the flow, so they never change a tile's size.
 */
function TopPills({ change, bottleneck = false }: { change: ChangeKind | null; bottleneck?: boolean }) {
  const label = change === "added" ? "New" : change === "changed" ? "Changed" : change === "removed" ? "Removed" : null;
  if (!label && !bottleneck) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute -top-2.5 left-2.5 flex gap-1 whitespace-nowrap">
      {bottleneck && (
        <span title="The bottleneck in this run" className="rounded-full bg-destructive px-2 text-[10px] leading-[18px] font-semibold tracking-[0.02em] text-crit-fg">
          Bottleneck
        </span>
      )}
      {label && (
        <span className={`${pillClass} ${change === "removed" ? "border-crit bg-crit-soft text-crit" : "border-edit bg-edit-soft text-fg"}`}>{label}</span>
      )}
    </span>
  );
}

/**
 * On a tile's bottom-left edge: "Conflict" where sources disagree and "Assumption"
 * on unconfirmed values, each showing the quotes behind it on hover (the
 * inspector lists them in full on click).
 */
function FlagPills({ estimate, conflict = false, quote = null }: { estimate: boolean; conflict?: boolean; quote?: string | null }) {
  if (!estimate && !conflict) return null;
  const why = quote ? `: ${quote}` : "";
  return (
    <span aria-hidden className="pointer-events-none absolute -bottom-2.5 left-2.5 flex gap-1">
      {conflict && (
        <span data-badge="conflict" title={`Sources disagree${why}`} className={`pointer-events-auto ${pillClass} border-crit bg-crit-soft text-fg`}>
          Conflict
        </span>
      )}
      {estimate && (
        <span data-badge="assumption" title={`Unconfirmed assumption${why}`} className={`pointer-events-auto ${pillClass} border-warn bg-warn-soft text-fg`}>
          Assumption
        </span>
      )}
    </span>
  );
}

/** A live value the draft changed, struck through, then the draft's. */
function Was({ was, children }: { was: string | null; children: ReactNode }) {
  if (was === null) return <>{children}</>;
  return (
    <>
      <s className="text-fg-3">{was}</s>
      <span aria-hidden className="text-accent"> → </span>
      <span className="font-semibold text-fg">{children}</span>
    </>
  );
}

function RestoreButton({ table, id, what }: { table: Table; id: string; what: string }) {
  const { restore } = useContext(CanvasContext);
  if (!restore) return null;
  return (
    <button
      type="button"
      onClick={() => restore(table, id)}
      className="nodrag nopan pointer-events-auto rounded-token border border-line bg-panel px-1.5 py-0.5 text-[11px] font-semibold text-fg not-italic no-underline hover:bg-panel-2"
      aria-label={`Restore ${what}`}
    >
      Restore
    </button>
  );
}

/** Card classes for a step's place in the draft. */
const changeClass = (d: { ghost?: boolean; change: ChangeKind | null }) =>
  d.ghost ? "opacity-70 !border-dashed !border-crit" : d.change === "added" ? "!border-dashed !border-2 !border-edit" : d.change === "changed" ? "!border-edit" : "";

const handleClass = (editable: boolean) =>
  editable ? "!size-2.5 !border-2 !border-panel !bg-fg-3 hover:!bg-accent" : "!bg-line-2";

const selectedRing = "outline-2 outline-offset-2 outline-edit";

/** Highlighted cards get a heavy outline; the rest fade (issue #99). */
const litClass = (lit: boolean | null) => (lit === true ? "!border-accent outline-2 outline-offset-1 outline-accent" : lit === false ? "opacity-40" : "");

/** The name of the step a step's rework goes back to, or null when it is redone at the step itself. */
const reworkToOf = (steps: readonly StepRow[], step: StepRow): string | null =>
  step.rework_to_step_id && step.rework_to_step_id !== step.id ? (steps.find((s) => s.id === step.rework_to_step_id)?.name ?? null) : null;

const percent = (p: number) => `${Math.round(p * 1000) / 10}%`;

/** What a screen reader hears for a step. */
function stepLabel(data: StepNodeData): string {
  const { step, role, person, problems, branches, reworkTo, change, estimate, conflict, wasName, wasWho, wasWork, wasWait, rating, bottleneck } = data;
  const draft =
    change === "added"
      ? "new in this draft"
      : change === "removed"
        ? "removed in this draft"
        : change === "changed"
          ? `changed in this draft${[
              wasName && `, was named ${wasName}`,
              wasWho && `, was ${wasWho}`,
              wasWork && `, hands-on time was ${wasWork}`,
              wasWait && `, wait was ${wasWait}`,
            ]
              .filter(Boolean)
              .join("")}`
          : null;
  const flags = [rating && `rated ${RATING_LABELS[rating]}`, bottleneck && "bottleneck", draft, conflict && "sources disagree", estimate && "unconfirmed assumption", problems.length > 0 && `to fix: ${problems.join(" ")}`];
  if (step.kind === "start" || step.kind === "end") {
    return [step.name, step.kind === "start" ? "start" : `end, ${step.outcome}`, ...flags].filter(Boolean).join(", ");
  }
  if (branches) {
    return [step.name, "decision", `branches: ${branches.map((r) => `${r.name} ${r.percent}%${r.goBack ? " (goes back)" : ""}`).join(", ")}`, ...flags].filter(Boolean).join(", ");
  }
  return [
    step.name,
    step.kind !== "task" && KIND_LABELS[step.kind].toLowerCase(),
    person ? `pinned to ${person.name}` : role?.name,
    `${formatHours(step.work_hours)} work`,
    `${formatHours(step.wait_hours)} wait`,
    headlineOf(data).phrase,
    reworkTo && `${percent(Number(step.rework_rate))} rework back to ${reworkTo}`,
    ...flags,
  ]
    .filter(Boolean)
    .join(", ");
}

/** The one number on a step's tile (see lib/map/tile.ts). */
function headlineOf({ role, person, avgWait, avgQueue, step }: StepNodeData) {
  return tileHeadline({
    staffed: role !== null || person !== null,
    run: avgWait !== null && avgQueue !== null ? { avgWait, avgQueue } : null,
    waitHours: Number(step.wait_hours),
  });
}

/** The tile's rating row: a dot in the rating's colour, and the rating in words. */
function RatingRow({ dot, label }: { dot: string; label: string }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">
      <i aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
      <span className="truncate">{label}</span>
    </p>
  );
}

const tileClass = "relative rounded-lg shadow-token transition-[box-shadow,opacity] hover:shadow-md motion-reduce:transition-none";
/**
 * The headline row mixes a mono value with a sans caption on one baseline, so its natural height moves by about a pixel with
 * the fonts' metrics (17 px before they load, 18 after). A minimum height keeps every tile the same size at any moment, so the
 * map frames itself (and a screenshot is cut) at the same height whether or not the fonts have arrived. A minimum, not a fixed
 * height: with a larger browser font size the value (`text-base`, in rem) is taller than 18 px, and the row must grow with it
 * rather than spill onto the foot.
 */
const headlineRowClass = "mt-1 flex min-h-[18px] min-w-0 items-baseline gap-1.5";
const footClass = "mt-1.5 flex items-baseline justify-between gap-2 border-t pt-1 text-xs text-fg-2";

/** The id of a decision card's "+" dot: a line drawn from it is a new branch (round 2, item 12). A branch's own dot has the branch's line id. */
const ADD_BRANCH_HANDLE = "add-branch";

/**
 * A decision with branch rows: the question, then a row for each branch (its name and share), each with its own dot on the right edge
 * that its line leaves from (round 2, item 12). One dot for every line made it hard to see which line was which, and dragging it could
 * only add a line. In the Editor a click on a row selects that branch, a click on its % edits the share in place, dragging a row's dot
 * to a step sends that branch there, and dragging the "+" dot under the rows adds a branch to that step. On a read-only map the rows
 * and dots are a picture only.
 */
function DecisionCard({ data, selected }: NodeProps<StepFlowNode>) {
  const { step, branches, problems, editable } = data;
  const { selectBranch, editor } = useContext(CanvasContext);
  const flagged = data.bottleneck;
  const colours = tileColours(data.rating, flagged);
  const rows = branches!;
  // A single branch is always 100%, so its share is not offered for editing.
  const shareEditable = editable && !!editor && rows.length > 1;
  return (
    <div
      data-lit={data.lit ?? undefined}
      data-tile="decision"
      data-rating={data.rating ?? "none"}
      className={`${tileClass} w-48 border-[1.5px] border-l-[5px] px-2.5 pt-2 pb-2 ${flagged ? "ring-[1.5px] ring-crit" : ""} ${changeClass(data)} ${litClass(data.lit)} ${selected ? selectedRing : ""}`}
      style={{ background: colours.background, borderColor: colours.borderColor, borderLeftColor: "var(--accent)" }}
    >
      <TopPills change={data.change} bottleneck={flagged} />
      <FlagPills estimate={data.estimate} conflict={data.conflict} quote={data.quote} />
      <Handle type="target" position={Position.Left} className={handleClass(editable)} />
      {/* First, so a line given no dot of its own (one the draft removed) is drawn from here. Not for drawing lines from. */}
      <Handle type="source" position={Position.Right} isConnectable={false} className="!pointer-events-none !size-1 !border-0 !opacity-0" />
      <p className="flex items-center gap-1 text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">
        <Split aria-hidden className="size-3" /> Decision
      </p>
      {data.wasName !== null && <p className="text-[11px] leading-tight text-fg-3 line-through">{data.wasName}</p>}
      <p data-field="name" className="mt-0.5 text-sm leading-tight font-semibold text-fg">
        {step.name}
      </p>
      <ul aria-label={`Branches of ${step.name}`} className="mt-1.5 flex flex-col gap-0.5 border-t pt-1.5" style={{ borderTopColor: colours.divider }}>
        {rows.map((row) => (
          <li key={row.id} data-branch-li={row.id} className="relative flex items-baseline gap-1">
            {editable ? (
              <button
                type="button"
                data-branch-row={row.id}
                aria-pressed={data.branchSelected === row.id}
                aria-label={`${row.name}, ${row.percent}%${row.goBack ? ", goes back" : ""}. Edit this branch`}
                onClick={(e) => {
                  e.stopPropagation();
                  selectBranch(row.id);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={`nodrag nopan min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs hover:bg-panel-2 ${data.branchSelected === row.id ? "bg-panel-2 outline-1 outline-edit" : ""}`}
              >
                {row.name}
                {row.goBack && <span aria-hidden> ↩</span>}
              </button>
            ) : (
              <span data-branch-row={row.id} aria-label={`${row.name}, ${row.percent}%${row.goBack ? ", goes back" : ""}`} className="min-w-0 flex-1 truncate px-1 py-0.5 text-xs">
                {row.name}
                {row.goBack && <span aria-hidden> ↩</span>}
              </span>
            )}
            {shareEditable ? (
              <BranchShare decisionId={step.id} row={row} editor={editor!} />
            ) : (
              <span className="shrink-0 px-1 font-mono text-xs tabular-nums text-fg-2">{row.percent}%</span>
            )}
            {/* The branch's own dot, level with its row: its line leaves from here, and dragging it sends the branch elsewhere. */}
            <Handle
              id={row.id}
              type="source"
              position={Position.Right}
              isConnectable={editable}
              data-branch-handle={row.id}
              title={`${row.name}, ${row.percent}%`}
              aria-label={`${row.name}, ${row.percent}%`}
              className={handleClass(editable)}
              // Out to the card's right edge, past the card's padding and border.
              style={{ right: -11.5 }}
            />
          </li>
        ))}
      </ul>
      {editable && editor && (
        <div className="relative mt-0.5 flex h-4 items-center justify-end text-[11px] text-fg-3">
          <span aria-hidden className="pr-2">
            Drag + to add a branch
          </span>
          {/* Keyboard users add a branch with the side panel's "+ Add branch". */}
          <Handle
            id={ADD_BRANCH_HANDLE}
            type="source"
            position={Position.Right}
            data-add-branch-handle
            title="Drag to a step to add a branch to it"
            className="!flex !size-3.5 !items-center !justify-center !border !border-dashed !border-fg-3 !bg-panel !text-[10px] !leading-none !text-fg-2 hover:!border-accent hover:!text-accent"
            style={{ right: -11.5 }}
          >
            <span aria-hidden className="pointer-events-none">
              +
            </span>
          </Handle>
        </div>
      )}
      <ProblemMark problems={problems} />
      {/* Where a branch that goes back leaves from, to its "Go back to…" node below. Not for drawing lines from. */}
      <Handle id="back" type="source" position={Position.Bottom} isConnectable={false} className="!pointer-events-none !size-1 !border-0 !opacity-0" />
    </div>
  );
}

/**
 * A branch's share on a decision card: its % as a button that turns into a small number field. Enter or leaving the field saves (one
 * undo step, the other branches making room in proportion); Escape puts it back.
 */
function BranchShare({ decisionId, row, editor }: { decisionId: string; row: BranchRow; editor: ProcessEditor }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Enter saves and closes the field, and closing it can blur it too: save once.
  const settled = useRef(false);
  const close = (save: boolean) => {
    if (settled.current || draft === null) return;
    settled.current = true;
    const value = Number(draft);
    if (save && draft.trim() !== "" && Number.isFinite(value)) editor.run((b) => setBranchShare(b, decisionId, row.id, Math.min(100, Math.max(0, value))));
    setDraft(null);
  };
  if (draft === null) {
    return (
      <button
        type="button"
        data-branch-share={row.id}
        aria-label={`Share of ${row.name}, ${row.percent}%. Change it`}
        title="Change this share: the other branches make room in proportion"
        onClick={(e) => {
          e.stopPropagation();
          settled.current = false;
          setDraft(String(row.percent));
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="nodrag nopan shrink-0 rounded px-1 py-0.5 font-mono text-xs tabular-nums text-fg-2 hover:bg-panel-2 hover:text-fg"
      >
        {row.percent}%
      </button>
    );
  }
  return (
    <span className="nodrag nopan nokey flex shrink-0 items-center gap-0.5 font-mono text-xs">
      <input
        type="number"
        data-branch-share-input={row.id}
        aria-label={`Share of ${row.name}, percent`}
        min={0}
        max={100}
        step={1}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // The map's own keys (Delete, arrows, undo) are not for this field.
          e.stopPropagation();
          if (e.key === "Enter") close(true);
          else if (e.key === "Escape") close(false);
        }}
        onBlur={() => close(true)}
        className="w-11 rounded border border-edit bg-bg px-1 py-0 text-right tabular-nums"
      />
      %
    </span>
  );
}

/** The end of a decision's branch that goes back to an earlier step: "Go back to X". Clicking it selects the branch. */
function GoBackNode({ data, selected }: NodeProps<GoBackFlowNode>) {
  countRender("tile");
  return (
    <div
      data-tile="goback"
      className={`${tileClass} flex w-max max-w-[190px] items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-line-2 bg-panel-2 px-2.5 py-1.5 text-xs font-semibold text-fg ${selected ? selectedRing : ""}`}
    >
      <Handle id="in" type="target" position={Position.Top} isConnectable={false} className="!pointer-events-none !size-1 !border-0 !opacity-0" />
      <Undo2 aria-hidden className="size-3.5 shrink-0 text-fg-2" />
      <span className="min-w-0 truncate" title={`Go back to ${data.targetName}`}>
        Go back to {data.targetName}
      </span>
      <ProblemMark problems={data.problems} className="absolute -top-2 -right-2" />
      <Handle id="out" type="source" position={Position.Left} isConnectable={false} className="!pointer-events-none !size-1 !border-0 !opacity-0" />
    </div>
  );
}

function StepNode(props: NodeProps<StepFlowNode>) {
  countRender("tile");
  const { data, selected } = props;
  if (data.branches && !data.editing && !data.ghost) return <DecisionCard {...props} />;
  const { step, role, person, bottleneck, problems, editable, editing, pulse, ghost } = data;
  const who = person?.name ?? role?.name;
  const staffed = role !== null || person !== null;
  const flagged = bottleneck && !editing && !ghost;
  const colours = tileColours(data.rating, flagged);
  const headline = headlineOf(data);
  const wait = data.typed && step.kind === "wait";
  return (
    <div
      data-lit={data.lit ?? undefined}
      data-tile={wait ? "wait" : "step"}
      data-rating={data.rating ?? "none"}
      className={`${tileClass} ${editing ? "w-60 border-[1.5px] border-accent bg-panel" : ghost ? "w-48 border-[1.5px] bg-panel px-2.5 py-2" : "w-48 border-[1.5px] px-2.5 pt-2 pb-2"} ${wait && !editing && !ghost ? "border-dashed" : ""} ${flagged ? "ring-[1.5px] ring-crit" : ""} ${changeClass(data)} ${litClass(data.lit)} ${selected ? selectedRing : ""}`}
      style={editing || ghost ? undefined : { background: colours.background, borderColor: colours.borderColor }}
    >
      {pulse && !editing && (
        <span aria-hidden className="bottleneck-pulse pointer-events-none absolute -inset-1.5 rounded-lg border-2 border-crit" />
      )}
      <TopPills change={data.change} bottleneck={flagged} />
      <FlagPills estimate={data.estimate} conflict={data.conflict} quote={data.quote} />
      <Handle type="target" position={Position.Left} className={handleClass(editable && !ghost)} />
      {editing ? (
        <NodeInlineEditor step={step} focus={editing} />
      ) : ghost ? (
        <div className="flex items-start justify-between gap-1">
          <p className="font-semibold leading-tight text-fg-2 line-through">{step.name}</p>
          {data.restorable && <RestoreButton table="steps" id={step.id} what={step.name} />}
        </div>
      ) : (
        <>
          {wait && (
            <p className="flex items-center gap-1 text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">
              <Clock aria-hidden className="size-3" /> Wait
            </p>
          )}
          {data.rated && <RatingRow dot={colours.dot} label={data.rating ? RATING_LABELS[data.rating] : "Nothing to fix"} />}
          {data.wasName !== null && <p className="text-[11px] leading-tight text-fg-3 line-through">{data.wasName}</p>}
          <p data-field="name" className="mt-0.5 text-sm leading-tight font-semibold text-fg">
            {step.name}
          </p>
          <p className={headlineRowClass} title={headline.title}>
            <span data-field={staffed ? undefined : "wait_hours"} className="font-mono text-base leading-none font-medium text-fg tabular-nums">
              {headline.value}
            </span>
            <span className="min-w-0 truncate text-[11.5px] leading-4 text-fg-2">{headline.caption}</span>
          </p>
          {data.wasWait !== null && staffed && (
            <p data-field="wait_hours" className="mt-0.5 font-mono text-[11px] text-fg-2 tabular-nums">
              <Was was={data.wasWait}>{formatHours(step.wait_hours)} wait</Was>
            </p>
          )}
          {step.split && <SplitBar split={step.split} className="mt-1.5" />}
          <div className={footClass} style={{ borderTopColor: colours.divider }}>
            <p data-field={person ? "person_id" : "role_id"} className="min-w-0 truncate">
              {who && <i aria-hidden className="mr-1.5 inline-block size-2 rounded-full align-baseline" style={{ background: role?.color ?? "var(--line-2)" }} />}
              <Was was={data.wasWho}>{who ?? (step.kind === "decision" ? "Decision" : step.kind === "wait" ? "Wait" : "No role")}</Was>
              {person && <span className="text-fg-3"> · pinned</span>}
            </p>
            <span data-field="work_hours" className="shrink-0 font-mono tabular-nums">
              <Was was={data.wasWork}>{Number(step.work_hours) || data.wasWork ? `${formatHours(step.work_hours)} work` : "—"}</Was>
            </span>
          </div>
        </>
      )}
      <ProblemMark problems={problems} />
      <Handle type="source" position={Position.Right} className={handleClass(editable && !ghost)} />
    </div>
  );
}

/** "New version: <name>" on a process card in the Sandbox's company map. */
function VersionBadge({ text, className }: { text: string; className?: string }) {
  return (
    <span data-version-badge title={text} className={`inline-block max-w-[11rem] truncate rounded-full border border-accent bg-panel px-2 text-[10.5px] leading-4 font-semibold text-accent ${className ?? ""}`}>
      {text}
    </span>
  );
}

function GroupNode({ data, selected }: NodeProps<GroupFlowNode>) {
  countRender("tile");
  const { step, open, expandable, roll, problems, editable } = data;
  const { toggleGroup, handoffs, turnInto } = useContext(CanvasContext);
  const toggle = expandable && (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${step.name}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleGroup(step.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="nodrag nopan rounded-full border border-line bg-panel px-2 py-0 text-[11px] leading-4 font-semibold text-fg hover:bg-panel-2"
    >
      {open ? "Collapse" : "Expand"}
    </button>
  );
  if (open) {
    return (
      <div
        className={`relative h-full w-full rounded-token border-2 border-dashed bg-panel-2/40 ${changeClass(data)} ${data.lit || data.badge ? "!border-solid !border-accent" : ""} ${selected ? selectedRing : "border-line-2"}`}
        data-group="open"
        data-new-version={data.badge ? "true" : undefined}
        data-lit={data.lit ?? undefined}
      >
        <Handle type="target" position={Position.Left} className={handleClass(editable)} />
        <div className="flex items-start justify-between gap-2 px-3 py-2">
          <div className="min-w-0">
            <p data-field="name" className="truncate font-semibold leading-tight">
              {step.name}
            </p>
            <p className="text-[11px] text-fg-3">
              Group · {roll.steps} {roll.steps === 1 ? "step" : "steps"}
            </p>
            {data.tag && <TagPill tag={data.tag} className="mt-1" />}
            {data.badge && <VersionBadge text={data.badge} className="mt-1" />}
          </div>
          {toggle}
        </div>
        <ProblemMark problems={problems} />
        <Handle type="source" position={Position.Right} className={handleClass(editable)} />
      </div>
    );
  }
  const colours = tileColours(data.rating, false);
  // In a process's own Editor a step that holds another process is a "Linked process": it changes when that process does, and can be turned into steps.
  const linked = !expandable && editable && !handoffs && !!turnInto;
  return (
    <div
      className={`${tileClass} w-48 border-2 border-dashed px-2.5 pt-2 pb-2 ${changeClass(data)} ${litClass(data.lit)} ${data.badge ? "outline-2 outline-offset-1 outline-accent" : ""} ${selected ? selectedRing : ""}`}
      style={{ background: colours.background, borderColor: data.badge ? "var(--accent)" : colours.borderColor }}
      data-group="closed"
      data-new-version={data.badge ? "true" : undefined}
      data-rating={data.rating ?? "none"}
      data-lit={data.lit ?? undefined}
    >
      {roll.openIssues > 0 && (
        <span title="Confirmed issues on the steps inside" className={ISSUE_PILL_CLASS}>
          {roll.openIssues} {roll.openIssues === 1 ? "issue" : "issues"}
        </span>
      )}
      <Handle type="target" position={Position.Left} className={handleClass(editable)} />
      {data.rated && <RatingRow dot={colours.dot} label={data.rating ? `Worst inside: ${RATING_LABELS[data.rating]}` : "Nothing to fix"} />}
      <p data-field="name" title={step.name} className="mt-0.5 line-clamp-2 text-sm leading-tight font-semibold text-fg">
        {step.name}
      </p>
      {data.tag && <TagPill tag={data.tag} className="mt-1" />}
      <p className={headlineRowClass}>
        <span className="font-mono text-base leading-none font-medium text-fg tabular-nums">{roll.steps}</span>
        <span className="min-w-0 truncate text-[11.5px] leading-4 text-fg-2" title="Hands-on time of every step inside, added up">
          {roll.steps === 1 ? "step" : "steps"} · {roll.handsOnHours ? `${formatHours(roll.handsOnHours)} work` : "no work entered"}
        </span>
      </p>
      {linked && (
        <p data-linked-process className="mt-1 text-[11.5px] leading-snug text-fg-2">
          Linked process: changes when &lsquo;{step.name}&rsquo; changes
        </p>
      )}
      <div className={footClass} style={{ borderTopColor: colours.divider }}>
        <span>{expandable ? "Group" : handoffs ? "Process" : linked ? "Linked" : "Child process"}</span>
        {linked ? (
          <button
            type="button"
            data-turn-into-steps
            onClick={(e) => {
              e.stopPropagation();
              turnInto!(step.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="nodrag nopan rounded-full border border-line bg-panel px-2 py-0 text-[11px] leading-4 font-semibold text-fg hover:bg-panel-2"
          >
            Turn into steps
          </button>
        ) : (
          toggle
        )}
      </div>
      {data.badge && <VersionBadge text={data.badge} className="absolute -bottom-3 left-2 shadow-token" />}
      <ProblemMark problems={problems} />
      <Handle type="source" position={Position.Right} className={handleClass(editable)} />
    </div>
  );
}

function TerminalNode({ data, selected }: NodeProps<TerminalFlowNode>) {
  countRender("tile");
  const { step, problems, editing, ghost } = data;
  const editable = data.editable && !ghost;
  const tone =
    step.outcome === "won" ? "bg-good-soft text-fg" : step.outcome === "lost" ? "bg-panel-2 text-fg-2" : "bg-accent-soft text-fg";
  return (
    <div
      data-lit={data.lit ?? undefined}
      data-tile="terminal"
      className={`${tileClass} border-[1.5px] ${editing ? "w-44 border-accent bg-panel" : `w-max max-w-[150px] min-w-24 border-line-2 px-2.5 py-1.5 ${data.typed ? "rounded-full px-3.5" : ""} ${tone}`} ${changeClass(data)} ${litClass(data.lit)} ${selected ? selectedRing : ""}`}
    >
      <TopPills change={data.change} />
      <FlagPills estimate={data.estimate} conflict={data.conflict} quote={data.quote} />
      {step.kind !== "start" && <Handle type="target" position={Position.Left} className={handleClass(editable)} />}
      {editing ? (
        <NodeInlineEditor step={step} focus="name" />
      ) : ghost ? (
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <span className="line-through">{step.name}</span>
          {data.restorable && <RestoreButton table="steps" id={step.id} what={step.name} />}
        </span>
      ) : (
        <>
          <p className="flex items-center gap-1 text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">
            {data.typed && (step.kind === "start" ? <Play aria-hidden className="size-3" /> : <Flag aria-hidden className="size-3" />)}
            {step.kind === "start" ? "Start" : data.typed && step.outcome ? `End · ${OUTCOME_LABELS[step.outcome]}` : "End"}
          </p>
          <p data-field="name" className={`text-[13px] leading-tight font-semibold break-words ${step.outcome === "lost" ? "text-fg-2" : "text-fg"}`}>
            <Was was={data.wasName}>{step.name}</Was>
          </p>
        </>
      )}
      <ProblemMark problems={problems} />
      {step.kind === "start" && <Handle type="source" position={Position.Right} className={handleClass(editable)} />}
    </div>
  );
}

/** A branch: its probability (and condition tag) as a label, edited inline when selected. */
function BranchEdge(props: EdgeProps<BranchFlowEdge>) {
  const { id, data, selected, markerEnd, style } = props;
  countRender("edge");
  const { editor, handoffs } = useContext(CanvasContext);
  // While the grab handle is dragged, the offset under the pointer (saved once, on release).
  const [dragged, setDragged] = useState<{ x: number; y: number } | null>(null);
  const offset = dragged ?? data?.bend ?? null;
  const auto = getSmoothStepPath(props);
  const [path, labelX, labelY] = !offset || data?.rolled ? auto : getSmoothStepPath({ ...props, ...bentCenter(props, auto[1], auto[2], offset) });
  // The grab handle, on the line's middle, for a line of an editable map while it is selected.
  const grab =
    data?.bendable && editor && selected && !data.rolled ? (
      <EdgeLabelRenderer>
        <BendHandle
          editor={editor}
          edgeId={id}
          at={{ x: labelX, y: labelY }}
          offset={offset}
          // Where the centre sits automatically: the saved offset is measured from here.
          autoAt={{ x: auto[1], y: auto[2] }}
          onDrag={setDragged}
        />
      </EdgeLabelRenderer>
    ) : null;
  const p = data?.probability ?? 1;
  const tag = data?.tag ?? null;
  // A branch of a decision is edited from the decision's panel; any other line, on the line.
  const editing = selected && data?.alone && editor && !data?.branch;
  const problems = data?.problems ?? [];
  // A handoff line says what is handed over, not a share of the work.
  const text = handoffs && !data?.branch && !data?.decided ? (data?.label ?? "") : [data?.branch?.name, p < 1 || data?.branch ? percent(p) : null, tag].filter(Boolean).join(" · ");
  const ghost = data?.ghost ?? false;
  const was = data?.was ?? null;
  if (data?.rolled) return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={0} />;
  if (ghost || was !== null) {
    return (
      <>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={ghost ? 0 : 18} />
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex items-center gap-1 rounded-token bg-panel px-1 font-mono text-[11px] tabular-nums"
            style={{ transform: `translate(${labelX}px, ${labelY}px) translate(-50%, -50%)`, pointerEvents: "all" }}
          >
            {ghost ? (
              <>
                <s className="text-crit">{text || "removed"}</s>
                {data?.restorable && <RestoreButton table="edges" id={id.slice("ghost:".length)} what="this connection" />}
              </>
            ) : (
              <Was was={was}>{text || "100%"}</Was>
            )}
          </div>
        </EdgeLabelRenderer>
        {editing && (
          <EdgeLabelRenderer>
            <Unzoomed x={labelX} y={labelY + 14} shift="-50%, 0">
              {handoffs ? (
                <HandoffEditor key={id} editor={editor} edgeId={id} label={data?.label ?? null} bent={!!data?.bend} />
              ) : (
                <BranchEditor key={id} editor={editor} edgeId={id} probability={p} tag={tag} bent={!!data?.bend} />
              )}
            </Unzoomed>
          </EdgeLabelRenderer>
        )}
        {grab}
      </>
    );
  }
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={18} />
      {grab}
      {editing ? (
        <EdgeLabelRenderer>
          {/* The editor stays readable at any zoom and sits above the nodes; just below the grab handle on the line's middle while it shows, so both can be used. */}
          <Unzoomed x={labelX} y={labelY} shift={grab ? "-50%, 12px" : "-50%, -50%"}>
            {handoffs ? (
              <HandoffEditor key={id} editor={editor} edgeId={id} label={data?.label ?? null} bent={!!data?.bend} />
            ) : (
              <BranchEditor key={id} editor={editor} edgeId={id} probability={p} tag={tag} bent={!!data?.bend} />
            )}
          </Unzoomed>
        </EdgeLabelRenderer>
      ) : (
        (text || problems.length > 0) && (
          <EdgeLabelRenderer>
            <div
              className="nodrag nopan absolute"
              style={{
                // Read-only, the label sits just above the line at its start, in the gap beside the card, not on one at the middle of a short link.
                transform: data?.branch
                  ? // A branch of a decision: its name and share on the line itself, where the lines out of one decision have drawn apart
                    // (just above the grab handle while it shows).
                    `translate(${labelX}px, ${labelY}px) translate(-50%, ${grab ? "calc(-100% - 8px)" : "-50%"})`
                  : `translate(${props.sourceX + 4}px, ${props.sourceY - 2}px) translate(0, -100%)`,
                transformOrigin: "0 0",
                pointerEvents: "all",
              }}
            >
              <span className="flex items-center">
                {text && <span title={text} className={`block truncate rounded-token bg-panel px-1 text-[11px] text-fg-2 ${handoffs ? "max-w-[9rem] font-sans" : data?.branch ? "max-w-[8rem] font-sans" : "max-w-[5.5rem] font-mono tabular-nums"}`}>{text}</span>}
                <ProblemMark problems={problems} className="relative ml-0.5" />
              </span>
            </div>
          </EdgeLabelRenderer>
        )
      )}
    </>
  );
}

/**
 * A line's editor, scaled against the zoom so it stays readable at any zoom, above the nodes. Only this (and the grab handle) reads
 * the zoom, and only while a line is selected: the lines themselves don't, so zooming re-renders none of them (issue #249).
 */
function Unzoomed({ x, y, shift, children }: { x: number; y: number; shift: string; children: ReactNode }) {
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div
      className="nodrag nopan absolute"
      style={{ transform: `translate(${x}px, ${y}px) scale(${1 / zoom}) translate(${shift})`, transformOrigin: "0 0", zIndex: 1002, pointerEvents: "all" }}
    >
      {children}
    </div>
  );
}

/** How far one press of an arrow key moves a line's middle. */
const BEND_STEP = 10;

/**
 * Where a bent line's centre goes: the automatic centre plus the offset. A smooth step between a card's right side and another's left
 * only follows one axis of its centre (the middle segment's x for a line going forwards, its y for one going back), so the other axis
 * is kept on the middle segment: that is where the label and grab handle sit, and they stay on the line.
 */
function bentCenter(
  ends: Pick<EdgeProps, "sourceX" | "sourceY" | "targetX" | "targetY" | "sourcePosition" | "targetPosition">,
  autoX: number,
  autoY: number,
  offset: { x: number; y: number },
): { centerX: number; centerY: number } {
  const x = autoX + offset.x;
  const y = autoY + offset.y;
  if (ends.sourcePosition !== Position.Right || ends.targetPosition !== Position.Left) return { centerX: x, centerY: y };
  // The smooth step's own gap (React Flow's default offset) out of each card before the first turn.
  const from = ends.sourceX + 20;
  const to = ends.targetX - 20;
  const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
  return from < to ? { centerX: x, centerY: clamp(y, ends.sourceY, ends.targetY) } : { centerX: clamp(x, from, to), centerY: y };
}

/**
 * The round handle on a selected line's middle: drag it (or press the arrow keys on it) to move the middle segment, e.g. around
 * another card; double-click it to put the line back where it sits automatically. A drag redraws the line as it goes and is saved
 * once, on release, as one edit (one undo).
 */
function BendHandle({
  editor,
  edgeId,
  at,
  autoAt,
  offset,
  onDrag,
}: {
  editor: ProcessEditor;
  edgeId: string;
  at: { x: number; y: number };
  autoAt: { x: number; y: number };
  offset: { x: number; y: number } | null;
  onDrag: (offset: { x: number; y: number } | null) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  // Scaled against the zoom, like a line's editor (see Unzoomed).
  const zoom = useStore((s) => s.transform[2]);
  // Where the pointer went down (map units) and the offset then; null when not dragging.
  const start = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const save = (next: { x: number; y: number } | null) => editor.run((b) => bendEdge(b, edgeId, next));
  return (
    <button
      type="button"
      data-bend-handle={edgeId}
      aria-label="Drag to move this line"
      title="Drag to move this line (arrow keys nudge it). Double-click to put it back."
      className="nodrag nopan nowheel absolute size-3.5 cursor-move touch-none rounded-full border-2 border-edit bg-panel shadow-token hover:bg-edit-soft focus-visible:outline-2 focus-visible:outline-edit"
      style={{
        transform: `translate(${at.x}px, ${at.y}px) scale(${1 / zoom}) translate(-50%, -50%)`,
        transformOrigin: "0 0",
        zIndex: 1003,
        pointerEvents: "all",
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        start.current = { x: p.x, y: p.y, from: offset ?? { x: 0, y: 0 } };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        onDrag({ x: s.from.x + p.x - s.x, y: s.from.y + p.y - s.y });
      }}
      onPointerUp={(e) => {
        const s = start.current;
        if (!s) return;
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        // A click without a move saves nothing. What is saved is where the handle was last drawn: kept on the line's middle segment.
        if (p.x !== s.x || p.y !== s.y) save({ x: at.x - autoAt.x, y: at.y - autoAt.y });
        onDrag(null);
      }}
      onPointerCancel={() => {
        start.current = null;
        onDrag(null);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        save(null);
      }}
      onKeyDown={(e) => {
        const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!move) return;
        e.preventDefault();
        e.stopPropagation();
        const from = offset ?? { x: 0, y: 0 };
        save({ x: from.x + move[0]! * BEND_STEP, y: from.y + move[1]! * BEND_STEP });
      }}
    />
  );
}

/** A handoff line's label and removal, on the company map: no share or tag: a hand-off takes every won client. */
function HandoffEditor({ editor, edgeId, label, bent = false }: { editor: ProcessEditor; edgeId: string; label: string | null; bent?: boolean }) {
  const [text, setText] = useState(label ?? "");
  // Take the stored value when it changes (a save, an undo), without remounting under the cursor.
  const [seen, setSeen] = useState(label);
  if (seen !== label) {
    setSeen(label);
    setText(label ?? "");
  }
  const commit = () => {
    const next = text.trim() || null;
    if (next !== (label ?? null)) editor.run((b) => updateEdge(b, edgeId, { label: next }));
  };
  const dropping = useRef(false);
  return (
    <div
      data-edge-editor={edgeId}
      role="group"
      aria-label="Edit handoff"
      onKeyDown={(e) => e.stopPropagation()}
      className="flex flex-col gap-1 rounded-token border border-accent bg-panel p-1.5 text-xs shadow-token"
    >
      <label className="flex items-center gap-1">
        <span className="w-9 text-fg-2">Label</span>
        <input
          aria-label="Handoff label"
          value={text}
          maxLength={200}
          placeholder="What is handed over"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (!dropping.current) commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.preventDefault();
              setText(label ?? "");
              dropping.current = true;
              focusEdge(edgeId);
              dropping.current = false;
            }
          }}
          className={`${edgeInputClass} w-40`}
        />
      </label>
      <span className="flex items-center gap-3">
        <button type="button" onClick={() => editor.run((b) => deleteEdges(b, [edgeId]))} className="text-crit hover:underline">
          Remove handoff
        </button>
        {bent && <ResetLineButton editor={editor} edgeId={edgeId} />}
      </span>
    </div>
  );
}

const edgeInputClass = "rounded-token border border-line bg-panel px-1.5 py-0.5 tabular-nums";

/** Put focus back on an edge of the map. */
const focusEdge = (id: string) => document.querySelector<SVGGElement>(`.react-flow__edge[data-id="${id}"]`)?.focus();

/** Puts a line whose middle was dragged back where it sits automatically. */
function ResetLineButton({ editor, edgeId }: { editor: ProcessEditor; edgeId: string }) {
  return (
    <button type="button" title="Put this line back where it sits automatically" onClick={() => editor.run((b) => bendEdge(b, edgeId, null))} className="text-fg-2 hover:underline">
      Reset line
    </button>
  );
}

function BranchEditor({
  editor,
  edgeId,
  probability,
  tag,
  bent = false,
}: {
  editor: ProcessEditor;
  edgeId: string;
  probability: number;
  tag: string | null;
  bent?: boolean;
}) {
  const shown = String(Math.round(probability * 1000) / 10);
  const [pct, setPct] = useState(shown);
  const [tagText, setTagText] = useState(tag ?? "");
  // Take the stored values when they change (a save, an undo). Remounting
  // instead would steal focus from the other input mid-edit.
  const [seen, setSeen] = useState({ shown, tag });
  if (seen.shown !== shown || seen.tag !== tag) {
    setSeen({ shown, tag });
    setPct(shown);
    setTagText(tag ?? "");
  }
  const [error, setError] = useState<string | null>(null);
  const commitPct = () => {
    const v = Number(pct.trim());
    if (pct.trim() === "" || !Number.isFinite(v) || v < 0 || v > 100) {
      setError("Enter 0–100%.");
      return;
    }
    setError(null);
    editor.run((b) => updateEdge(b, edgeId, { probability: Math.round(v * 10) / 1000 }));
  };
  const commitTag = () => editor.run((b) => updateEdge(b, edgeId, { condition_tag: tagText.trim() || null }));
  // Set by Escape, so the blur that follows doesn't save the draft being dropped.
  const dropping = useRef(false);
  const onBlur = (commit: () => void) => () => {
    if (!dropping.current) commit();
  };
  const keys = (commit: () => void, revert: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      // Drop the draft and go back to the connection itself.
      e.preventDefault();
      revert();
      setError(null);
      // Moving focus blurs the input at once; the flag only covers that blur.
      dropping.current = true;
      focusEdge(edgeId);
      dropping.current = false;
    }
  };
  return (
    <div
      data-edge-editor={edgeId}
      role="group"
      aria-label="Edit connection"
      // React events bubble through the portal to the edge, whose own key handling (Escape blurs
      // and unselects it) is for the edge itself, not for typing here.
      onKeyDown={(e) => e.stopPropagation()}
      className="flex flex-col gap-1 rounded-token border border-accent bg-panel p-1.5 text-xs shadow-token"
    >
      <label className="flex items-center gap-1">
        <span className="w-9 text-fg-2">Share</span>
        <input
          aria-label="Branch probability, percent"
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          onBlur={onBlur(commitPct)}
          onKeyDown={keys(commitPct, () => setPct(shown))}
          className={`${edgeInputClass} w-16`}
        />
        <span className="text-fg-3">%</span>
      </label>
      <label className="flex items-center gap-1">
        <span className="w-9 text-fg-2">Tag</span>
        <input
          aria-label="Condition tag"
          value={tagText}
          maxLength={100}
          placeholder="none"
          onChange={(e) => setTagText(e.target.value)}
          onBlur={onBlur(commitTag)}
          onKeyDown={keys(commitTag, () => setTagText(tag ?? ""))}
          className={`${edgeInputClass} w-24`}
        />
      </label>
      {error && (
        <p role="alert" className="text-crit">
          {error}
        </p>
      )}
      <span className="flex items-center gap-3">
        <button type="button" onClick={() => editor.run((b) => deleteEdges(b, [edgeId]))} className="text-crit hover:underline">
          Remove connection
        </button>
        {bent && <ResetLineButton editor={editor} edgeId={edgeId} />}
      </span>
    </div>
  );
}

const nodeTypes = { step: StepNode, terminal: TerminalNode, group: GroupNode, goback: GoBackNode };
const edgeTypes = { branch: BranchEdge };
/** Hoisted, like the node and edge types: a new object on each render makes React Flow do needless work. */
const PRO_OPTIONS = { hideAttribution: true };

/**
 * Room around the steps when framing them: the toolbar sits top left, playback along the foot, lane names on the left, and the
 * buttons on the map (32 px wide and a 10 px margin) down the right, so a fitted map never ends under them.
 */
const fitPadding = (lanes: boolean, toolbar: boolean, playback: boolean, controls: boolean): Padding => ({
  top: toolbar ? 64 : 24,
  right: controls ? 60 : 24,
  bottom: playback ? 64 : 24,
  left: lanes ? 150 : 24,
});

// Full screen, for a read-only map: offered only where the browser has it for an element (an iPhone doesn't), and known only in
// the browser, so the server and hydration leave the button out.
const noSubscribe = () => () => undefined;
const fullscreenEnabled = () => !!document.fullscreenEnabled;
const serverFalse = () => false;
const onFullscreenChange = (notify: () => void) => {
  document.addEventListener("fullscreenchange", notify);
  return () => document.removeEventListener("fullscreenchange", notify);
};

const noop = () => undefined;

const READ_ARIA: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default": "Enter opens the step's detail: who does it, its times, rating, insights, issues and sources. Escape closes it.",
};

const EDIT_ARIA: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default":
    "Enter or F2 edits the step here; Shift+F10 opens its actions; Space selects it (Shift+Space adds it to the selection). When selected, arrow keys move it, Delete removes it and Escape clears the selection.",
  "edge.a11yDescription.default":
    "Enter edits its share and condition tag; Space selects it. Delete removes it and Escape clears the selection.",
};

/**
 * Tab order for the map: the order a lead flows through it (breadth first from
 * the start step, likelier branches first), then anything unreachable, top to
 * bottom. DOM order is focus order, so nodes and edges are listed this way.
 */
function flowOrder(bundle: ProcessBundle): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const e of [...bundle.edges].sort((a, b) => Number(b.probability) - Number(a.probability))) {
    next.set(e.from_step_id, [...(next.get(e.from_step_id) ?? []), e.to_step_id]);
  }
  const order = new Map<string, number>();
  const queue = bundle.steps.filter((s) => s.kind === "start").map((s) => s.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (order.has(id)) continue;
    order.set(id, order.size);
    queue.push(...(next.get(id) ?? []));
  }
  const rest = bundle.steps
    .filter((s) => !order.has(s.id))
    .sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x));
  for (const s of rest) order.set(s.id, order.size);
  return order;
}

interface CanvasProps {
  bundle: ProcessBundle;
  /** The run to play back and read queues from; a read-only map without one shows no queues. */
  result?: SimulationResult | null;
  /** Null (or left out) for a read-only canvas. */
  editor?: ProcessEditor | null;
  editorState?: EditorState | null;
  selection?: Selection;
  onSelectionChange?: Dispatch<SetStateAction<Selection>>;
  /** Duplicate, copy, delete and inspect, shared with the keyboard shortcuts. */
  commands?: CanvasCommands | null;
  /** The draft's changes against live, drawn on the map (issue #9); null outside a draft. */
  diff?: DraftDiff | null;
  /** Put a removed step or connection back as it is live; null when the map is read-only. */
  onRestore?: ((table: Table, id: string) => void) | null;
  /** What the toolbar says once edits are saved ("Saved", "Saved to draft"). */
  savedLabel?: string;
  /** Open issues per step, which a closed group adds up. */
  openIssues?: Record<string, number>;
  /** A step's rating (a rank, higher is worse, with its label), which a closed group takes the worst of. Absent until the workspace has ratings. */
  rating?: (stepId: string) => { rank: number; label: string } | null;
  /** The Editor has its own palette (issue #104): leave "Add step" out of the toolbar. */
  hideAdd?: boolean;
  /**
   * The Editor's red marks (editor brainstorm, item 4): what stops each step or line simulating, shown on it and explained on hover and focus.
   * Left out, a step with nothing leaving it or shares that don't add up shows the same kind of mark, from `stepWarnings`.
   */
  problems?: NodeProblems | null;
  /**
   * The simpler Editor's node types (editor brainstorm, items 2, 5 and 6): Step, Wait, Decision, Start and End each look their own way, a decision
   * lists its branches on the card, and a branch that goes back to an earlier step ends in a "Go back to X" node. A click on a branch's row or
   * on a go back node selects that branch's line. Needs `editor`; on a read-only map only the decision's card applies (its branch rows, each
   * with its own dot, round 2 item 12).
   */
  branchNodes?: boolean;
  /** "Turn into steps" on the card of a step that holds a linked process (the Editor, branchNodes only). */
  onTurnIntoSteps?: ((stepId: string) => void) | null;
  /**
   * Filled in with a function that says what the map is showing (its centre and edges in map coordinates, and the measured
   * size of each card; null before it is drawn), so the Editor's palette can put a new step where the person is looking.
   */
  viewRef?: ViewRef;
  /**
   * The company map (B11): the lines between process cards are handoffs, drawn and labelled but visual only. They show their label
   * (not a branch share), are edited with a label field, and the loose-end warnings of a process's steps don't apply.
   */
  handoffs?: boolean;
  /**
   * Which groups are open. Pass it with `onExpandedChange` to share open state between maps (the Solution page shows two);
   * left out, the map keeps its own (closed when read-only, open when editable).
   */
  expanded?: ReadonlySet<string>;
  onExpandedChange?: (next: ReadonlySet<string>) => void;
  /**
   * Steps to highlight (an insight's or issue's, on hover): they are outlined, the rest dimmed, their groups opened
   * and they are scrolled into view. Ids of steps; a closed group lights up for the steps it holds.
   */
  highlight?: readonly string[] | null;
  /** Show the colour legend in the bar above the map. Default true. */
  legend?: boolean;
  /** Show the small "new · removed · was → now" key over the map when it carries a diff. Default true; a page that explains it itself turns it off. */
  diffLegend?: boolean;
  /**
   * Frame these steps (with some room around them) instead of the whole map when it is fitted, so a big map opens on what matters.
   * Steps that aren't drawn (inside a closed group) are ignored; with none drawn the whole map is framed.
   */
  focus?: readonly string[] | null;
  /** Show the zoom in, zoom out and fit buttons (and, read-only, full screen) on the map's bottom-right corner. Default true. */
  zoomControls?: boolean;
  /**
   * Show the playback controls. Default true; embedded maps turn it off. A read-only map has them in its one toolbar row above
   * the map; the Editor's float over the foot of the map.
   */
  showPlayback?: boolean;
  /** Kept for the hosts that pass it: a read-only map's playback is always in the toolbar row above the map now, never over it. */
  playbackAbove?: boolean;
  /**
   * The start of a read-only map's one toolbar row (the Overview: "Company map", its (?), the horizon toggle and the Sandbox link),
   * before Expand all, the lanes toggle, Key and playback.
   */
  toolbarStart?: ReactNode;
  /**
   * Playback of the company map (issue #173): every item plays, pipeline and servicing, and what is inside a closed card
   * is counted on the card. Default false: a process's own items only, on the steps drawn.
   */
  playbackRollUp?: boolean;
  /** Offer the swimlane view (when the map has no groups). Default true. */
  showLanes?: boolean;
  /** Start in the swimlane view (a read-only process map shows its lanes at once). Default false: the toggle turns them on. */
  defaultLanes?: boolean;
  /**
   * The company map's department lanes (Q4): its top-level cards sit in labelled bands at their stored positions. `always`: the
   * Overview, where they are always on; otherwise a toggle (on to start with) switches them. Dragging a card never moves it to
   * another lane: the department is set on the process page.
   */
  departmentLanes?: { spec: BandSpec; always?: boolean };
  /** A small pill of text on a process card, by the card's step id: the process's category on the company map (Q4). */
  cardTags?: ReadonlyMap<string, string>;
  /** The Sandbox (Q16): "New version: <name>" on the cards of processes that run another map version, by the card's step id; they get an accent outline. */
  cardBadges?: ReadonlyMap<string, string>;
  /**
   * `fill`: as tall as the space it is given (the editor). `auto`: as tall as the map needs, from 16 to 40 rem,
   * so a small map doesn't sit in a tall empty panel. Default `auto` when read-only, `fill` when editable.
   */
  height?: "auto" | "fill";
  /** A step (or closed group) was clicked, or Enter was pressed on it. */
  onStepClick?: (stepId: string) => void;
  /** Open the step's detail on a click, on a read-only map. Default true. */
  stepDetail?: boolean;
  /** What a click on a step shows besides its numbers: the insights and confirmed issues on it. Read-only maps only. */
  stepExtras?: (stepId: string) => StepExtras | null;
  /** Titles of the workspace's sources by id, for the sources a step's detail lists. */
  sourceTitles?: Readonly<Record<string, string>>;
  /** A step whose detail is open when the map first shows (`?step=<id>` on the process page). Read-only maps only. */
  initialStepId?: string | null;
  /** The step's base values for capacity, shown in its detail (read only on the process page). */
  stepBaseValues?: (step: StepRow) => ReactNode;
  /** The first run is still computing: shows FirstRunStatus over the map. */
  computing?: boolean;
  /**
   * Frame the map again, animated, when this changes after it was first framed (the Overview passes its open cards: opening one changes
   * the map's size). Unlike a `key` on the canvas it keeps the map mounted, so playback goes on.
   */
  refitOn?: string;
  /** What to do about a read-only map with no steps (the process page offers the Editor); shown under the sentence. */
  emptyAction?: ReactNode;
  /** The wheel zooms the map. Default: on an editable map only (a read-only map usually sits in a page that scrolls). */
  wheelZoom?: boolean;
}

export function ProcessCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** The groups a step sits inside, nearest first. */
function ancestorGroups(steps: readonly StepRow[], id: string | null): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: string[] = [];
  for (let at = id ? byId.get(id)?.parent_step_id : null; at && !out.includes(at); at = byId.get(at)?.parent_step_id) out.push(at);
  return out;
}

function Canvas({
  bundle,
  result = null,
  editor = null,
  editorState = null,
  selection = NO_SELECTION,
  onSelectionChange = noop,
  commands = null,
  diff = null,
  onRestore = null,
  savedLabel = "Saved",
  openIssues,
  rating,
  hideAdd = false,
  problems: problemsProp = null,
  branchNodes = false,
  onTurnIntoSteps = null,
  viewRef,
  handoffs = false,
  expanded: expandedProp,
  onExpandedChange,
  highlight = null,
  legend = true,
  diffLegend = true,
  focus = null,
  zoomControls = true,
  showPlayback = true,
  playbackRollUp = false,
  showLanes = true,
  defaultLanes = false,
  departmentLanes,
  cardTags,
  cardBadges,
  height: heightProp,
  onStepClick,
  stepDetail = true,
  stepExtras,
  sourceTitles,
  initialStepId = null,
  stepBaseValues,
  computing = false,
  refitOn,
  emptyAction,
  wheelZoom,
  toolbarStart,
}: CanvasProps) {
  const editable = editor !== null;
  // A read-only map with nothing between start and end has nothing to draw. (The Editor keeps its empty canvas: a new block starts there.)
  const nothingToDraw = !editable && !bundle.steps.some((s) => s.kind !== "start" && s.kind !== "end");
  // Groups open in place (issue #102): to edit inside one, open it; to read the map, close it for the roll-up.
  // A linked step (`?step=`) inside closed groups opens them, so the map shows where it is.
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(() => (editor ? new Set(groupIds(bundle.steps)) : new Set(ancestorGroups(bundle.steps, initialStepId))));
  const expanded = expandedProp ?? ownExpanded;
  const expandedNow = useRef(expanded);
  useEffect(() => {
    expandedNow.current = expanded;
  });
  /** Set the open groups, with a set or an updater like a state setter; the owner is told from here, never while rendering. */
  const setExpanded = useCallback(
    (next: ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>)) => {
      const value = typeof next === "function" ? next(expandedNow.current) : next;
      expandedNow.current = value;
      setOwnExpanded(value);
      onExpandedChange?.(value);
    },
    [onExpandedChange],
  );
  // A highlight the map starts with (an issue's page) is opened into the open state once, so it can be closed by hand.
  const highlightKey = highlight?.join("|") ?? "";
  const [startKey] = useState(highlightKey);
  const seeded = useRef(false);
  useEffect(() => {
    // Only the highlight present at mount: this runs once, and later highlights are the transient kind.
    if (seeded.current) return;
    seeded.current = true;
    if (!highlight?.length) return;
    const missing = groupsToOpen(bundle.steps, highlight).filter((g) => !expandedNow.current.has(g));
    if (missing.length) setExpanded((prev) => new Set([...prev, ...missing]));
  }, [bundle.steps, highlight, setExpanded]);
  // One that changes later (a hovered insight) opens its groups only while it lasts, leaving the open state alone.
  const transient = highlightKey === startKey ? null : highlight;
  const drawn = useMemo(() => withHighlightOpen(bundle.steps, expanded, transient), [bundle.steps, expanded, transient]);
  const lit = useMemo(() => (highlight?.length ? litIds(bundle.steps, drawn, highlight) : null), [bundle.steps, drawn, highlight]);
  // In the Editor a group that appears (just added, grouped, or brought back by undo) opens, so its steps can be edited.
  const knownGroups = useRef<ReadonlySet<string>>(new Set(groupIds(bundle.steps)));
  useEffect(() => {
    if (!editor) return;
    const ids = groupIds(bundle.steps);
    const fresh = ids.filter((id) => !knownGroups.current.has(id));
    knownGroups.current = new Set(ids);
    if (fresh.length) setExpanded((prev) => new Set([...prev, ...fresh]));
  }, [bundle.steps, editor, setExpanded]);
  const hasGroups = useMemo(() => bundle.steps.some((st) => isGroup(st) || st.child_process_id), [bundle.steps]);
  const allGroups = useMemo(() => groupIds(bundle.steps), [bundle.steps]);
  const toggleGroup = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [setExpanded],
  );
  const typed = branchNodes && editable && !handoffs;
  // A decision's card lists its branches, each with its own dot, on a read-only map too (round 2, item 12); there they can't be dragged.
  // The company map's decisions have them too (round 2, item 7): its lines are handoffs, but a decision's are branches.
  const rowed = branchNodes || handoffs;
  // Where a decision's branches are picked and edited from its card and panel.
  const decides = rowed && editable;
  const selectBranch = useCallback((edgeId: string) => onSelectionChange({ steps: [], edges: [edgeId] }), [onSelectionChange]);
  const canvasContext = useMemo(
    () => ({ editor, restore: editor ? onRestore : null, toggleGroup, handoffs, selectBranch, turnInto: typed ? onTurnIntoSteps : null }),
    [editor, onRestore, toggleGroup, handoffs, selectBranch, typed, onTurnIntoSteps],
  );
  const flow = useReactFlow();
  // Expand all / Collapse all; the map re-frames itself unless it was zoomed by hand.
  const toggleAllGroups = () => {
    setExpanded(allGroups.every((id) => expanded.has(id)) ? new Set() : new Set(allGroups));
    requestFit();
  };
  const wrapper = useRef<HTMLDivElement>(null);
  // Positions of nodes mid-drag, and sizes React Flow measured; the rest comes from the bundle.
  const [dragging, setDragging] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(new Map());
  // What the map panel shows now, in map coordinates (not the bars above it), and how big each card was measured: where the
  // Editor's palette puts a new step.
  useEffect(() => {
    if (!viewRef) return;
    viewRef.current = () => {
      const rect = wrapper.current?.querySelector(".react-flow")?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      const from = flow.screenToFlowPosition({ x: rect.left, y: rect.top });
      const to = flow.screenToFlowPosition({ x: rect.right, y: rect.bottom });
      // Steps the draft removed are still drawn where they are live (as ghosts): a new card does not go on one of them.
      const occupied = [...(diff?.steps.values() ?? [])]
        .filter((c) => c.kind === "removed" && c.live && (c.live.parent_step_id ?? null) === null)
        .map((c) => {
          const size = measured.get(ghostId(c.live!.id)) ?? (c.live!.kind === "start" || c.live!.kind === "end" ? TERMINAL_SIZE : CARD_SIZE);
          return { x: Number(c.live!.x), y: Number(c.live!.y), width: size.width, height: size.height };
        });
      // Pan to a step that was just added if it is not wholly on screen (it is drawn a moment after the edit).
      const reveal = (id: string) =>
        setTimeout(() => {
          const node = flow.getNodes().find((n) => n.id === id);
          const panel = wrapper.current?.querySelector(".react-flow")?.getBoundingClientRect();
          if (!node || !panel) return;
          const b = flow.getNodesBounds([node]);
          const view = flow.getViewport();
          const inView = b.x * view.zoom + view.x >= 0 && (b.x + b.width) * view.zoom + view.x <= panel.width && b.y * view.zoom + view.y >= 0 && (b.y + b.height) * view.zoom + view.y <= panel.height;
          if (!inView) void flow.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: view.zoom, duration: 200 });
        }, 60);
      return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, visible: { left: from.x, top: from.y, right: to.x, bottom: to.y }, sizes: measured, occupied, reveal };
    };
    return () => {
      viewRef.current = null;
    };
  }, [viewRef, flow, measured, diff]);
  const [lanes, setLanes] = useState(defaultLanes && showLanes);
  const [editing, setEditing] = useState<{ id: string; field: InlineField } | null>(null);
  const [menu, setMenu] = useState<(MenuState & { bounds: { width: number; height: number } }) | null>(null);
  // Which step's menu is open, synchronously, so the context-menu event that follows Shift+F10 doesn't reopen it.
  const menuFor = useRef<string | null>(null);
  const playbackGroups = useMemo(() => (playbackRollUp ? { open: drawn } : null), [playbackRollUp, drawn]);
  const playback = usePlayback(bundle, result, playbackGroups);

  // What is wrong, by step and by line. The Editor says it all with `problems`; a map without them marks only the steps `stepWarnings` finds.
  const problemsOf = useMemo(() => {
    if (handoffs || !editable) return { steps: new Map<string, string[]>(), edges: new Map<string, string[]>() };
    if (problemsProp) return problemsProp;
    return { steps: new Map([...stepWarnings(bundle)].map(([id, text]) => [id, [text]] as const)), edges: new Map<string, string[]>() };
  }, [bundle, editable, handoffs, problemsProp]);
  const NONE: readonly string[] = useMemo(() => [], []);
  const goBacks = useMemo(() => {
    if (!typed) return [];
    const top = new Set(bundle.steps.filter((st) => !st.parent_step_id).map((st) => st.id));
    const seen = new Map(visibleEdges(bundle.steps, bundle.edges, drawn).map((me) => [me.id, me] as const));
    // Only a decision at the top of the map, and a line drawn as itself (not rolled up into a closed group), gets a node.
    return goBackNodes(bundle).filter((g) => top.has(g.decisionId) && seen.get(g.edgeId) && !seen.get(g.edgeId)!.rolled);
  }, [typed, bundle, drawn]);
  const order = useMemo(() => flowOrder(bundle), [bundle]);
  const editingId = editing && bundle.steps.some((s) => s.id === editing.id) ? editing.id : null;
  const [bandsOn, setBandsOn] = useState(true);
  const bandsActive = !!departmentLanes && (departmentLanes.always === true || bandsOn);
  const layout = useMemo((): (LaneLayout & { bands: boolean }) | null => {
    // Department bands (the company map): top-level cards in lanes, at their stored positions within each.
    if (departmentLanes && bandsActive) {
      const sizeOf = (st: StepRow) =>
        measured.get(st.id) ?? (isGroup(st) ? (drawn.has(st.id) ? openGroupSize(bundle.steps, st.id, drawn, measured) : GROUP_CARD) : st.child_process_id ? GROUP_CARD : CARD_SIZE);
      return { ...bandLayout(bundle.steps, departmentLanes.spec, sizeOf), bands: true };
    }
    // Lanes place every step by its role; a group's steps sit inside its box instead.
    if (!lanes || hasGroups) return null;
    // The card being edited grows; its lane keeps its size meanwhile.
    const sizes = new Map([...measured].filter(([id]) => id !== editingId));
    return { ...laneLayout(bundle, sizes), bands: false };
  }, [departmentLanes, bandsActive, lanes, hasGroups, bundle, measured, editingId, drawn]);
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  });

  // The last node object made for each step (see sameNode).
  const [nodeCache] = useState(() => new Map<string, StepFlowNode | TerminalFlowNode>());
  const nodes = useMemo(() => {
    const roles = new Map(bundle.roles.map((r) => [r.id, r]));
    const people = new Map(namedForViewer(viewerOf(bundle), bundle.people).map((p) => [p.id, p]));
    const names = new Map(bundle.steps.map((s) => [s.id, s.name]));
    const selected = new Set(selection.steps);
    const who = (s: StepRow) =>
      (s.person_id ? people.get(s.person_id)?.name : undefined) ?? (s.role_id ? roles.get(s.role_id)?.name : undefined) ?? "No role";
    /** What the card shows for a live value the draft changed, or null. */
    const was = (change: StepChange | undefined, fields: string[], show: (live: StepRow) => string): string | null =>
      change?.kind === "changed" && change.fields.some((f) => fields.includes(f.field)) ? show(change.live!) : null;
    const stepsById = new Map(bundle.steps.map((st) => [st.id, st]));
    const depth = (id: string) => ancestorsOf(id, stepsById).length;
    // The steps held by child processes (live), which a closed holder adds up like a group's own.
    const childLeaves = (processId: string) => (bundle.otherProcesses ?? []).find((pt) => pt.process.id === processId)?.steps.filter(isWorkingStep) ?? [];
    const sizes = measured as ReadonlyMap<string, { width: number; height: number }>;
    const drafted = [...visibleSteps(bundle.steps, drawn)]
      // A group comes before the steps inside it (React Flow needs a parent first), then the order a lead flows through.
      .sort((a, b) => depth(a.id) - depth(b.id) || order.get(a.id)! - order.get(b.id)!)
      .map((step): FlowNode => {
        const change = diff?.steps.get(step.id);
        if (isGroup(step) || step.child_process_id) {
          const open = isGroup(step) && drawn.has(step.id);
          // A group adds up the steps inside it; a holder of a child process, the child's live steps.
          const leaves = isGroup(step) ? leavesIn(bundle.steps, step.id, childLeaves) : childLeaves(step.child_process_id!);
          const roll = isGroup(step)
            ? rollUp(bundle.steps, step.id, { childLeaves, issues: (id) => openIssues?.[id] ?? 0 })
            : {
                steps: leaves.length,
                handsOnHours: leaves.reduce((sum, st) => sum + Number(st.work_hours), 0),
                openIssues: leaves.reduce((sum, st) => sum + (openIssues?.[st.id] ?? 0), 0),
                worstRating: null,
              };
          const worst = leaves.reduce<{ rank: number; label: string } | null>((w, st) => {
            const r = rating?.(st.id) ?? null;
            return r && (!w || r.rank > w.rank) ? r : w;
          }, null);
          const box = open ? openGroupSize(bundle.steps, step.id, drawn, sizes) : null;
          const gdata: GroupNodeData = {
            step,
            open,
            expandable: isGroup(step),
            roll,
            problems: problemsOf.steps.get(step.id) ?? NONE,
            editable,
            change: change && (change.kind !== "changed" || change.fields.length) ? change.kind : null,
            rating: worst ? ratingOfRank(worst.rank) : null,
            rated: rating !== undefined,
            // An open group is a box around its steps: it can be outlined but never fades.
            lit: lit ? (open ? lit.has(step.id) || null : lit.has(step.id)) : null,
            tag: cardTags?.get(step.id) ?? null,
            badge: cardBadges?.get(step.id) ?? null,
          };
          return {
            id: step.id,
            type: "group",
            position: dragging.get(step.id) ?? layout?.positions.get(step.id) ?? { x: Number(step.x), y: Number(step.y) },
            selected: selected.has(step.id),
            ariaLabel: `${step.name}, ${isGroup(step) ? "group" : handoffs ? "process" : "child process"} of ${roll.steps} ${roll.steps === 1 ? "step" : "steps"}${isGroup(step) ? (open ? ", open" : ", closed") : ""}${gdata.rated && gdata.rating ? `, worst inside: ${RATING_LABELS[gdata.rating]}` : ""}${roll.openIssues > 0 ? `, ${roll.openIssues} confirmed ${roll.openIssues === 1 ? "issue" : "issues"}` : ""}`,
            ...(step.parent_step_id ? { parentId: step.parent_step_id } : {}),
            // An open group is as big as its steps need: React Flow takes the size from here, and so shows it at once.
            ...(box ? { width: box.width, height: box.height, style: { width: box.width, height: box.height } } : {}),
            ...(measured.has(step.id) && !box ? { measured: measured.get(step.id) } : {}),
            data: gdata,
          };
        }
        const data: StepNodeData = {
          step,
          role: step.role_id ? (roles.get(step.role_id) ?? null) : null,
          person: step.person_id ? (people.get(step.person_id) ?? null) : null,
          avgQueue: result?.steps[step.id]?.avgQueue ?? null,
          avgWait: result?.steps[step.id]?.avgWait ?? null,
          bottleneck: result?.bnStep === step.id,
          problems: problemsOf.steps.get(step.id) ?? NONE,
          branches: rowed && step.kind === "decision" ? branchRows(bundle, step.id) : null,
          branchSelected: decides && step.kind === "decision" ? (selection.edges.find((id) => bundle.edges.some((e) => e.id === id && e.from_step_id === step.id)) ?? null) : null,
          typed,
          editable,
          reworkTo: step.rework_to_step_id ? (names.get(step.rework_to_step_id) ?? null) : null,
          editing: editing && editingId === step.id ? editing.field : null,
          pulse: playback.pulsing && result?.bnStep === step.id,
          // A move alone isn't worth a badge; the changes list has it.
          change: change && (change.kind !== "changed" || change.fields.length) ? change.kind : null,
          ghost: false,
          restorable: false,
          estimate: step.assumption === true || EVIDENCE_COLUMNS.some((c) => isOpenAssumption(step, c)),
          conflict: step.conflict === true || EVIDENCE_COLUMNS.some((c) => openConflict(step, c) !== null),
          quote: badgeQuote(step),
          wasName: was(change, ["name"], (l) => l.name),
          wasWho: was(change, ["role_id", "person_id"], who),
          wasWork: was(change, ["work_hours"], (l) => `${formatHours(l.work_hours)} work`),
          wasWait: was(change, ["wait_hours"], (l) => `${formatHours(l.wait_hours)} wait`),
          rating: ratingOfRank(rating?.(step.id)?.rank ?? -1),
          rated: rating !== undefined,
          lit: lit ? lit.has(step.id) : null,
        };
        const node: StepFlowNode | TerminalFlowNode = {
          id: step.id,
          type: step.kind === "start" || step.kind === "end" ? "terminal" : "step",
          position: dragging.get(step.id) ?? layout?.positions.get(step.id) ?? { x: Number(step.x), y: Number(step.y) },
          // A step in a group sits at a position relative to the group's box.
          ...(step.parent_step_id ? { parentId: step.parent_step_id } : {}),
          selected: selected.has(step.id),
          ariaLabel: stepLabel(data),
          // The card being edited sits above its neighbours.
          ...(data.editing ? { zIndex: 1000 } : {}),
          ...(measured.has(step.id) ? { measured: measured.get(step.id) } : {}),
          data,
        };
        // Hand React Flow the same object for a step that hasn't changed, so only changed cards re-render.
        const prev = nodeCache.get(step.id);
        if (prev && sameNode(prev, node)) return prev;
        nodeCache.set(step.id, node);
        return node;
      });
    // Removed steps, where they are live, under the draft's cards.
    const ghosts = [...(diff?.steps.values() ?? [])]
      .filter((c) => c.kind === "removed")
      .map((c): FlowNode => {
        const step = c.live!;
        const data: StepNodeData = {
          step,
          role: step.role_id ? (roles.get(step.role_id) ?? null) : null,
          person: step.person_id ? (people.get(step.person_id) ?? null) : null,
          avgQueue: null,
          avgWait: null,
          bottleneck: false,
          problems: NONE,
          branches: null,
          branchSelected: null,
          typed: false,
          editable: false,
          reworkTo: null,
          editing: null,
          pulse: false,
          change: "removed",
          ghost: true,
          restorable: editable && !discardProblem(bundle, c),
          estimate: false,
          conflict: false,
          quote: null,
          wasName: null,
          wasWho: null,
          wasWork: null,
          wasWait: null,
          rating: null,
          rated: false,
          lit: null,
        };
        const id = ghostId(step.id);
        return {
          id,
          type: step.kind === "start" || step.kind === "end" ? "terminal" : "step",
          position: { x: Number(step.x), y: Number(step.y) },
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
          deletable: false,
          ariaLabel: stepLabel(data),
          ...(measured.has(id) ? { measured: measured.get(id) } : {}),
          data,
        };
      });
    // The "Go back to X" node of each branch that loops to an earlier step, below its decision (nodes of the Editor only, never dragged).
    const placed = new Map<string, number>();
    const goNodes = goBacks.map((g): GoBackFlowNode => {
      const decision = bundle.steps.find((st) => st.id === g.decisionId)!;
      const at = dragging.get(decision.id) ?? layout?.positions.get(decision.id) ?? { x: Number(decision.x), y: Number(decision.y) };
      const k = placed.get(g.decisionId) ?? 0;
      placed.set(g.decisionId, k + 1);
      const edge = bundle.edges.find((e) => e.id === g.edgeId)!;
      const height = measured.get(decision.id)?.height ?? CARD_SIZE.height + 30;
      // Below the decision, moved down until it lands on no other card.
      const w = 190;
      const h = 34;
      const x = at.x + 8 + k * 24;
      let y = at.y + height + 36 + k * 44;
      const hits = (yy: number) =>
        bundle.steps.some((st) => {
          if (st.id === decision.id || st.parent_step_id || st.kind === "group") return false;
          const size = measured.get(st.id) ?? (st.kind === "start" || st.kind === "end" ? TERMINAL_SIZE : CARD_SIZE);
          const sx = Number(st.x);
          const sy = Number(st.y);
          return x < sx + size.width + 12 && x + w + 12 > sx && yy < sy + size.height + 12 && yy + h + 12 > sy;
        });
      for (let i = 0; i < 12 && hits(y); i++) y += 40;
      return {
        id: g.id,
        type: "goback",
        position: { x, y },
        selected: selection.edges.includes(g.edgeId),
        draggable: false,
        connectable: false,
        deletable: false,
        ariaLabel: `Go back to ${g.targetName}, ${Math.round(Number(edge.probability) * 100)}% of ${decision.name}`,
        ...(measured.has(g.id) ? { measured: measured.get(g.id) } : {}),
        data: { edgeId: g.edgeId, targetName: g.targetName, branchName: edge.label?.trim() ?? "", problems: problemsOf.edges.get(g.edgeId) ?? NONE, editable },
      };
    });
    return [...ghosts, ...drafted, ...goNodes];
  }, [bundle, result, selection.steps, selection.edges, typed, rowed, decides, goBacks, problemsOf, NONE, dragging, measured, editable, order, layout, editing, editingId, nodeCache, playback.pulsing, diff, drawn, lit, openIssues, rating, handoffs, cardTags, cardBadges]);

  const edges = useMemo(() => {
    const selected = new Set(selection.edges);
    const alone = selection.edges.length === 1 && !selection.steps.length;
    const names = new Map(bundle.steps.map((s) => [s.id, s.name]));
    const present = new Set(bundle.steps.map((s) => s.id));
    const rank = (e: { from_step_id: string; to_step_id: string }) => (order.get(e.from_step_id) ?? 0) * 1e4 + (order.get(e.to_step_id) ?? 0);
    const labelOf = (p: number, tag: string | null) => [p < 1 ? percent(p) : null, tag].filter(Boolean).join(" · ") || "100%";
    // Connections that cross a closed group's border are drawn to the group; those inside it are hidden.
    const edgeRows = new Map(bundle.edges.map((row) => [row.id, row]));
    const shown = visibleEdges(bundle.steps, bundle.edges, drawn).map((me) => ({
      ...edgeRows.get(me.id)!,
      from_step_id: me.from,
      to_step_id: me.to,
      rolled: me.rolled,
    }));
    const goBackOf = new Map(goBacks.map((g) => [g.edgeId, g] as const));
    const decisions = new Set(bundle.steps.filter((st) => st.kind === "decision").map((st) => st.id));
    const drafted = shown
      .sort((a, b) => rank(a) - rank(b))
      .map((e): BranchFlowEdge => {
        // A line whose middle was only dragged is not highlighted as changed (layout, like a moved step).
        const listed = e.rolled ? undefined : diff?.edges.get(e.id);
        const change = listed?.kind === "changed" && !listed.fields.length ? undefined : listed;
        const goBack = goBackOf.get(e.id);
        const problems = problemsOf.edges.get(e.id) ?? NONE;
        const handoff = handoffs && !decisions.has(e.from_step_id);
        const relabelled = change?.kind === "changed" && change.fields.some((f) => (handoff ? f.field === "label" : f.field === "probability" || f.field === "condition_tag"));
        const was = relabelled ? (handoff ? (change.live!.label ?? "no label") : labelOf(Number(change.live!.probability), change.live!.condition_tag)) : null;
        const tone = selected.has(e.id) || change ? "var(--edit)" : problems.length ? "var(--crit)" : "var(--line-2)";
        return {
          id: e.id,
          source: e.from_step_id,
          // A branch that goes back ends at its "Go back to X" node, below the decision.
          target: goBack ? goBack.id : e.to_step_id,
          ...(goBack
            ? { sourceHandle: "back", targetHandle: "in" }
            : // A branch leaves from its own dot on the decision's card (not while the card is being edited in place: it is a plain card then).
              rowed && decisions.has(e.from_step_id) && editingId !== e.from_step_id
              ? { sourceHandle: e.id }
              : {}),
          type: "branch",
          selected: selected.has(e.id),
          ...(e.rolled ? { selectable: false, focusable: false, deletable: false, reconnectable: false } : {}),
          data: {
            probability: Number(e.probability),
            tag: e.condition_tag,
            alone,
            change: change?.kind ?? null,
            was,
            ghost: false,
            restorable: false,
            rolled: e.rolled,
            label: e.label,
            decided: handoffs && decisions.has(e.from_step_id),
            problems,
            branch: decides && !e.rolled && decisions.has(e.from_step_id) ? { name: e.label?.trim() || names.get(e.to_step_id) || "Branch" } : null,
            // A go back's line ends at its own node below the decision, and a line drawn to a closed group is not the line itself: neither bends.
            bend: !e.rolled && !goBack && (e.center_dx != null || e.center_dy != null) ? { x: Number(e.center_dx ?? 0), y: Number(e.center_dy ?? 0) } : null,
            bendable: editable && !e.rolled && !goBack,
          },
          style: {
            stroke: tone,
            strokeWidth: selected.has(e.id) ? 2.5 : change ? 2 : 1.5,
            ...(change?.kind === "added" ? { strokeDasharray: "6 4" } : e.rolled ? { strokeDasharray: "2 4" } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: tone },
          ariaLabel: handoff
            ? `Handoff from ${names.get(e.from_step_id)} to ${names.get(e.to_step_id)}${e.label ? `: ${e.label}` : ""}${change?.kind === "added" ? ", new in this draft" : change ? `, changed in this draft${was ? `, was ${was}` : ""}` : ""}`
            : `Connection from ${names.get(e.from_step_id)} to ${names.get(e.to_step_id)}, ${percent(Number(e.probability))}${e.condition_tag ? `, tag ${e.condition_tag}` : ""}${
            change?.kind === "added" ? ", new in this draft" : change ? `, changed in this draft${was ? `, was ${was}` : ""}` : ""
          }`,
        };
      });
    // From each "Go back to X" node, a dotted line to the step it goes back to.
    const links = goBacks.map((g): BranchFlowEdge => ({
      id: `${GO_BACK_LINK_PREFIX}${g.edgeId}`,
      source: g.id,
      sourceHandle: "out",
      target: g.targetId,
      type: "branch",
      selectable: false,
      focusable: false,
      deletable: false,
      reconnectable: false,
      data: { probability: 1, tag: null, alone: false, change: null, was: null, ghost: false, restorable: false, rolled: true },
      style: { stroke: "var(--line-2)", strokeWidth: 1.5, strokeDasharray: "2 4" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--line-2)" },
    }));
    const ghosts = [...(diff?.edges.values() ?? [])]
      .filter((c) => c.kind === "removed")
      .map((c): BranchFlowEdge => {
        const e = c.live!;
        const end = (id: string) => (present.has(id) ? id : ghostId(id));
        return {
          id: ghostId(e.id),
          source: end(e.from_step_id),
          target: end(e.to_step_id),
          type: "branch",
          selectable: false,
          focusable: false,
          deletable: false,
          reconnectable: false,
          data: {
            probability: Number(e.probability),
            tag: e.condition_tag,
            alone: false,
            change: "removed",
            was: null,
            ghost: true,
            restorable: editable && !discardProblem(bundle, c),
            label: e.label,
          },
          style: { stroke: "var(--crit)", strokeWidth: 1.5, strokeDasharray: "4 4", opacity: 0.7 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--crit)" },
          ariaLabel: "Connection removed in this draft",
        };
      });
    return [...ghosts, ...drafted, ...links];
  }, [bundle, selection.edges, selection.steps.length, order, diff, editable, drawn, handoffs, rowed, decides, editingId, goBacks, problemsOf, NONE]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const moves: { id: string; x: number; y: number }[] = [];
    const drags = new Map(dragging);
    const sizes = new Map(measured);
    let moved = false;
    let sized = false;
    const picks: { id: string; selected: boolean }[] = [];
    // A "Go back to X" node stands for its branch's line: picking the node picks the line.
    const edgePicks: { id: string; selected: boolean }[] = [];
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) {
        sizes.set(c.id, c.dimensions);
        sized = true;
      } else if (c.type === "position" && c.position) {
        // Drag end and arrow keys arrive with dragging false: that is the move to save.
        if (c.dragging) drags.set(c.id, c.position);
        else {
          // Lanes place steps top to bottom by role, so in the lane view only left and right are saved.
          const stored = bundle.steps.find((s) => s.id === c.id);
          const shown = layout?.positions.get(c.id);
          // In a department band a card moves up and down within its lane (the band's offset is taken off again); in role lanes only sideways.
          const y = !layout || !stored ? c.position.y : layout.bands && shown ? c.position.y - (shown.y - Number(stored.y)) : Number(stored.y);
          moves.push({ id: c.id, x: c.position.x, y });
          drags.delete(c.id);
        }
        moved = true;
      } else if (c.type === "select") {
        if (isGoBackNodeId(c.id)) edgePicks.push({ id: edgeOfGoBackNode(c.id), selected: c.selected });
        else picks.push({ id: c.id, selected: c.selected });
      }
    }
    if (sized) setMeasured(sizes);
    // Everything dragged together arrives in one change list: one edit, one undo step.
    if (moves.length) editor?.run((b) => moveSteps(b, moves));
    if (moved) setDragging(drags);
    if (picks.length) onSelectionChange((s) => ({ ...s, steps: applyPicks(s.steps, picks) }));
    if (edgePicks.length) onSelectionChange((s) => ({ ...s, edges: applyPicks(s.edges, edgePicks) }));
  };

  const onEdgesChange = (changes: EdgeChange<BranchFlowEdge>[]) => {
    const picks = changes.flatMap((c) => (c.type === "select" ? [{ id: c.id, selected: c.selected }] : []));
    if (picks.length) onSelectionChange((s) => ({ ...s, edges: applyPicks(s.edges, picks) }));
  };

  const onConnect = (c: Connection) => {
    let id: string | null = null;
    const decision = rowed && bundle.steps.find((st) => st.id === c.source)?.kind === "decision";
    editor?.run((b) => {
      if (decision) {
        // From a decision's card: its "+" dot adds a branch to the step, a branch's own dot sends that branch there (round 2,
        // item 12), the same edits as the side panel's "+ Add branch" and "Goes to". A step that leads back to the decision makes
        // the branch a go back.
        const target: BranchTarget = goBackProblem(b, c.source, c.target) === null ? { goBackTo: c.target } : c.target;
        const branch = c.sourceHandle && c.sourceHandle !== ADD_BRANCH_HANDLE && b.edges.some((e) => e.id === c.sourceHandle && e.from_step_id === c.source);
        const made = branch ? setBranchTarget(b, c.sourceHandle!, target) : addBranch(b, c.source, target);
        if (!made || "problem" in made) return null;
        id = made.id;
        return made.edit;
      }
      const made = addEdge(b, c.source, c.target);
      id = made?.id ?? null;
      return made?.edit ?? null;
    });
    if (id) onSelectionChange({ steps: [], edges: [id] });
  };

  /** Add a step centred on a point on screen, nudged down off any step already there. */
  const addAt = (kind: NewStepKind, outcome: StepOutcome | null, screen: { x: number; y: number }) => {
    const p = flow.screenToFlowPosition(screen);
    const x = p.x - 88;
    let y = p.y - 30;
    // Roughly a step card's size, so a new step doesn't land on top of another.
    const taken = (x0: number, y0: number) =>
      bundle.steps.some((s) => Math.abs(Number(s.x) - x0) < 180 && Math.abs(Number(s.y) - y0) < 90);
    for (let i = 0; i < 12 && taken(x, y); i++) y += 45;
    let id: string | null = null;
    editor?.run((b) => {
      const made = addStep(b, { kind, outcome, x, y });
      id = made.id;
      return made.edit;
    });
    if (id) onSelectionChange({ steps: [id], edges: [] });
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (!editable || !(e.target instanceof Element) || !e.target.classList.contains("react-flow__pane")) return;
    addAt("task", null, { x: e.clientX, y: e.clientY });
  };

  const addFromToolbar = (kind: NewStepKind, outcome: StepOutcome | null) => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    addAt(kind, outcome, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  /** Focus a step's card, or the map itself if the step is gone. */
  const focusStep = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const el = wrapper.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      (el ?? wrapper.current)?.focus();
    });
  }, []);

  const startEditing = (id: string, field: InlineField) => {
    const step = bundle.steps.find((s) => s.id === id);
    if (!editable || !step) return;
    const terminal = step.kind === "start" || step.kind === "end";
    setMenu(null);
    menuFor.current = null;
    setEditing({ id, field: terminal ? "name" : field });
    onSelectionChange({ steps: [id], edges: [] });
  };

  const stopEditing = useCallback(
    (id: string, refocus: boolean) => {
      setEditing((e) => (e?.id === id ? null : e));
      if (refocus) focusStep(id);
    },
    [focusStep],
  );

  const inline = useMemo<InlineEditing | null>(
    () => (editor ? { editor, bundle, stop: stopEditing } : null),
    [editor, bundle, stopEditing],
  );

  /** Open a step's menu at a point relative to the canvas. */
  const openMenu = (id: string, x: number, y: number, ids?: string[]) => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!editable || !rect) return;
    const acting = ids ?? (selection.steps.includes(id) && selection.steps.length > 1 ? selection.steps : [id]);
    if (acting.length === 1) onSelectionChange({ steps: [id], edges: [] });
    setEditing(null);
    menuFor.current = id;
    setMenu({ id, ids: acting, x, y, bounds: { width: rect.width, height: rect.height } });
  };

  const closeMenu = useCallback(
    (refocus: boolean) => {
      const id = menuFor.current;
      menuFor.current = null;
      setMenu(null);
      if (refocus && id) focusStep(id);
    },
    [focusStep],
  );

  /** Open the menu under a step's card, for the keyboard. */
  const openMenuBelow = (el: Element, id: string) => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const r = el.getBoundingClientRect();
    openMenu(id, r.left - rect.left + 8, r.bottom - rect.top + 4);
  };

  // Keys on a focused step or connection, before React Flow's own handling.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Element)) return;
    const target = e.target;
    if (!editable) {
      // A read-only map: Enter or Space on a step opens its detail.
      const id = target.classList.contains("react-flow__node") ? target.getAttribute("data-id") : null;
      if (id && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        e.stopPropagation();
        openStep(id);
      }
      return;
    }
    if (target.closest("input, textarea, select, [role='menu']")) return;
    const isNode = target.classList.contains("react-flow__node");
    const isEdge = target.classList.contains("react-flow__edge");
    const id = isNode || isEdge ? target.getAttribute("data-id") : null;
    if (!id) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (isNode && (e.key === "Enter" || e.key === "F2")) {
      stop();
      startEditing(id, "name");
    } else if (isNode && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      stop();
      openMenuBelow(target, id);
    } else if (isEdge && e.key === "Enter") {
      stop();
      onSelectionChange({ steps: [], edges: [id] });
      // The editor appears once the edge is selected; then move into it.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          wrapper.current?.querySelector<HTMLInputElement>(`[data-edge-editor="${id}"] input`)?.focus(),
        ),
      );
    } else if (e.key === "Escape") {
      // React Flow would select an unselected node on Escape; clear the selection instead.
      stop();
      onSelectionChange(NO_SELECTION);
    }
  };

  const toggleLanes = () => {
    setLanes(!lanes);
    requestFit();
  };
  const toggleBands = () => {
    setBandsOn(!bandsOn);
    requestFit();
  };

  // Zoom (issue #99): the map is framed once when it first appears, never below 70%; a bigger map is dragged around
  // instead. After that it moves only when asked: Fit, Expand or Collapse all, the swimlane toggle, or (read-only
  // maps) the panel changing size. Adding a step, opening a group by hand or a highlight never moves the view.
  const width = useStore((st) => st.width);
  const height = useStore((st) => st.height);
  // The zoom itself is read only by the buttons on the map (MapViewControls) and a selected line's editor: a canvas that followed
  // it would re-render every tile and line on each frame of a zoom or fit (issue #249).
  // Full screen (read-only maps): the map fills the screen and is framed afresh, centred in it.
  const canFullscreen = useSyncExternalStore(noSubscribe, fullscreenEnabled, serverFalse);
  const fullscreen = useSyncExternalStore(onFullscreenChange, () => document.fullscreenElement !== null && document.fullscreenElement === wrapper.current, serverFalse);
  const heightMode = fullscreen ? "fill" : (heightProp ?? (editable ? "fill" : "auto"));
  const controls = zoomControls && !nothingToDraw;
  const handZoomed = useRef(false);
  const framed = useRef(false);
  const sizeRef = useRef({ width: 0, height: 0 });
  useEffect(() => {
    sizeRef.current = { width, height };
  }, [width, height]);
  const [autoHeight, setAutoHeight] = useState<number | null>(null);
  // Whether the map reaches past the panel on the left or right, which the bar above says in words.
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measureOverflow = useCallback(() => {
    const all = flow.getNodes();
    const panelWidth = sizeRef.current.width;
    if (!all.length || !panelWidth) return;
    const b = flow.getNodesBounds(all);
    const view = flow.getViewport();
    const left = b.x * view.zoom + view.x < -4;
    const right = (b.x + b.width) * view.zoom + view.x > panelWidth + 4;
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
  }, [flow]);
  const fit = useCallback(
    (animate: boolean, everything = false) => {
      const all = flow.getNodes();
      const panel = sizeRef.current;
      if (!all.length || !panel.width) return;
      // The Fit button frames every node, however small that makes them; the first framing keeps the focus and the 70% floor.
      const wanted = !everything && focus?.length ? all.filter((n) => focus.includes(n.id)) : [];
      const minZoom = everything ? MIN_ZOOM : undefined;
      let bounds = flow.getNodesBounds(wanted.length ? wanted : all);
      // Room around what is framed, so a step or two is seen in its surroundings and not blown up to fill the panel.
      if (wanted.length) bounds = { x: bounds.x - 260, y: bounds.y - 140, width: bounds.width + 520, height: bounds.height + 280 };
      // Department lanes are part of the picture: frame them too (their names sit inside them, so no extra room on the left).
      const bands = layoutRef.current?.bands ? layoutRef.current.lanes : [];
      if (bands.length && !wanted.length) {
        const left = Math.min(bounds.x, ...bands.map((l) => l.x));
        const top = Math.min(bounds.y, ...bands.map((l) => l.y));
        const right = Math.max(bounds.x + bounds.width, ...bands.map((l) => l.x + l.width));
        const bottom = Math.max(bounds.y + bounds.height, ...bands.map((l) => l.y + l.height));
        bounds = { x: left, y: top, width: right - left, height: bottom - top };
      }
      // A read-only map's playback sits in the toolbar row above it and takes no room off the map; the Editor's floats over its foot.
      const pad = fitPadding(lanes && !bands.length, editable, showPlayback && editable, controls);
      let panelHeight = panel.height;
      if (heightMode === "auto") {
        panelHeight = autoPanelHeight(bounds, panel.width, pad, minZoom);
        setAutoHeight(panelHeight);
      }
      if (!panelHeight) return;
      void flow.setViewport(fitViewport(bounds, { width: panel.width, height: panelHeight }, pad, minZoom, fullscreen), animate ? { duration: 200 } : undefined);
      setTimeout(measureOverflow, animate ? 260 : 20);
    },
    [flow, lanes, editable, showPlayback, controls, heightMode, fullscreen, measureOverflow, focus],
  );
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  });
  // Frame it once, when every card has been measured (a map that starts with its groups open included).
  const allMeasured = nodes.length > 0 && nodes.every((n) => n.measured || n.width);
  useEffect(() => {
    if (!allMeasured || framed.current) return;
    const timer = setTimeout(() => {
      framed.current = true;
      fitRef.current(false);
    }, 30);
    return () => clearTimeout(timer);
  }, [allMeasured]);
  // Fit again on request, once what changed has been laid out.
  const [fitTick, setFitTick] = useState(0);
  const requestFit = () => {
    handZoomed.current = false;
    setFitTick((t) => t + 1);
  };
  useEffect(() => {
    if (!fitTick) return;
    const timer = setTimeout(() => fitRef.current(true), 60);
    return () => clearTimeout(timer);
  }, [fitTick]);
  const refitSeen = useRef(refitOn);
  useEffect(() => {
    if (refitOn === refitSeen.current) return;
    refitSeen.current = refitOn;
    if (framed.current) requestFit();
  }, [refitOn]);
  // A read-only map follows its panel's width (and height, when that is fixed), unless it was moved by hand.
  const refitKey = editable ? "" : heightMode === "auto" ? `${width}` : `${width}x${height}`;
  useEffect(() => {
    if (!refitKey || !framed.current || handZoomed.current) return;
    const timer = setTimeout(() => fitRef.current(false), 60);
    return () => clearTimeout(timer);
  }, [refitKey]);
  const zoomBy = (direction: "in" | "out") => {
    handZoomed.current = true;
    void flow.zoomTo(stepZoom(flow.getViewport().zoom, direction), { duration: 150 });
  };
  const fitByHand = () => {
    handZoomed.current = false;
    fit(true, true);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void wrapper.current?.requestFullscreen().catch(() => undefined);
  };
  // Entering or leaving the full screen changes the panel completely: frame the map afresh, even if it was moved by hand.
  const wasFullscreen = useRef(fullscreen);
  useEffect(() => {
    if (wasFullscreen.current === fullscreen) return;
    wasFullscreen.current = fullscreen;
    requestFit();
  }, [fullscreen]);
  // The Editor's playback bar floats over the foot of the map: the buttons sit above it, however tall it wraps.
  const floatingPlayback = showPlayback && editable;
  const footRef = useRef<HTMLDivElement>(null);
  const [footHeight, setFootHeight] = useState(0);
  useEffect(() => {
    const el = footRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFootHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [floatingPlayback]);

  // Highlighted steps scroll into view when they are off screen.
  useEffect(() => {
    if (!lit?.size) return;
    const timer = setTimeout(() => {
      const found = flow.getNodes().filter((n) => lit.has(n.id));
      if (!found.length) return;
      const b = flow.getNodesBounds(found);
      const view = flow.getViewport();
      const panel = sizeRef.current;
      const inView =
        b.x * view.zoom + view.x >= 0 &&
        (b.x + b.width) * view.zoom + view.x <= panel.width &&
        b.y * view.zoom + view.y >= 0 &&
        (b.y + b.height) * view.zoom + view.y <= panel.height;
      if (!inView) void flow.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: view.zoom, duration: 200 });
    }, 60);
    return () => clearTimeout(timer);
  }, [lit, flow]);

  // A step's detail, on a read-only map.
  const [detailId, setDetailId] = useState<string | null>(initialStepId ?? null);
  const detailStep = useMemo(() => {
    const st = !editable && detailId ? bundle.steps.find((x) => x.id === detailId) : undefined;
    return st && !isGroup(st) && !st.child_process_id && st.kind !== "start" && st.kind !== "end" ? st : null;
  }, [editable, detailId, bundle.steps]);
  const openStep = (id: string) => {
    onStepClick?.(id);
    if (stepDetail) setDetailId(id);
  };
  const closeDetail = () => {
    const id = detailId;
    setDetailId(null);
    if (id) focusStep(id);
  };

  // What React Flow is handed keeps its identity across renders (issue #249): a new handler on each render made it wake every
  // handle and edge on each drag move. Each calls the latest closure.
  const flowHandlers = {
    onNodesChange: useStableHandler(onNodesChange),
    onEdgesChange: useStableHandler(onEdgesChange),
    onConnect: useStableHandler(onConnect),
    isValidConnection: useStableHandler((c: Edge | Connection) => !connectionProblem(bundle, c.source, c.target)),
    onReconnect: useStableHandler((old: Edge, c: Connection) => {
      editor?.run((b) => reconnectEdge(b, old.id, c.source, c.target));
    }),
    onNodeDoubleClick: useStableHandler((e: MouseEvent, node: FlowNode) => {
      if (!(e.target instanceof Element) || e.target.closest("input, select, .nokey")) return;
      const field = e.target.closest("[data-field]")?.getAttribute("data-field") as InlineField | null;
      startEditing(node.id, field ?? "name");
    }),
    onNodeContextMenu: useStableHandler((e: MouseEvent, node: FlowNode) => {
      if (!editable) return;
      e.preventDefault();
      if (isGoBackNodeId(node.id) || menuFor.current === node.id) return;
      const rect = wrapper.current!.getBoundingClientRect();
      // A context-menu key press arrives without a pointer position.
      if (e.clientX === 0 && e.clientY === 0 && e.currentTarget instanceof Element) openMenuBelow(e.currentTarget, node.id);
      else openMenu(node.id, e.clientX - rect.left, e.clientY - rect.top);
    }),
    onSelectionContextMenu: useStableHandler((e: MouseEvent, picked: FlowNode[]) => {
      if (!editable || !picked.length) return;
      e.preventDefault();
      const rect = wrapper.current!.getBoundingClientRect();
      openMenu(
        picked[0]!.id,
        e.clientX - rect.left,
        e.clientY - rect.top,
        picked.map((n) => n.id),
      );
    }),
    // The menu belongs where it was opened; moving the map closes it.
    onMoveStart: useStableHandler((event: globalThis.MouseEvent | globalThis.TouchEvent | null) => {
      // A drag, the wheel or a pinch moves the view by hand; the map stops following its panel.
      if (event) handZoomed.current = true;
      if (menuFor.current) closeMenu(false);
    }),
    onMoveEnd: useStableHandler(() => measureOverflow()),
    onNodeClick: useStableHandler((e: MouseEvent, node: FlowNode) => {
      // The group toggle and the issue badge are buttons of their own.
      if (e.target instanceof Element && e.target.closest("button")) return;
      if (!node.id.startsWith("ghost:")) onStepClick?.(node.id);
      if (!editable && stepDetail) setDetailId(node.id);
    }),
    onPaneClick: useStableHandler(() => setDetailId(null)),
  };

  // Expand all and the lane toggles, in the bar above the map.
  const laneControls = ((showLanes && !hasGroups) || allGroups.length > 0 || (departmentLanes && !departmentLanes.always)) && (
    <div className="flex flex-none items-center gap-1.5">
      {departmentLanes && !departmentLanes.always && (
        <LaneToggle
          lanes={bandsOn}
          onToggle={toggleBands}
          label="Department lanes"
          title="Lay the process cards in a lane for each department. Dragging a card does not change its department: set that on the process page."
        />
      )}
      {showLanes && !hasGroups && !departmentLanes && <LaneToggle lanes={lanes} onToggle={toggleLanes} />}
      {allGroups.length > 0 && <GroupControls allOpen={allGroups.every((id) => expanded.has(id))} onToggle={toggleAllGroups} />}
    </div>
  );
  const overflowNote = (className: string) =>
    (overflow.left || overflow.right) && (
      <p className={`${className} text-xs text-fg-2`} data-map-overflow>
        {overflow.right && !overflow.left ? "Drag the map to see the rest →" : overflow.left && !overflow.right ? "← Drag the map to see the rest" : "Drag the map to see the rest"}
      </p>
    );

  return (
    <CanvasContext.Provider value={canvasContext}>
      <InlineEditContext.Provider value={inline}>
        <div
          ref={wrapper}
          data-process-map
          tabIndex={-1}
          onDoubleClick={onDoubleClick}
          onKeyDownCapture={onKeyDownCapture}
          className={`relative isolate flex min-w-0 flex-col rounded-lg border bg-card ${heightMode === "fill" ? "min-h-[24rem] flex-1" : "h-fit"}`}
          data-fullscreen={fullscreen ? "" : undefined}
          role="region"
          aria-label={`${bundle.process.name} process map`}
        >
          {/* Above the map in the page, so Tab reaches these first. A read-only map has one slim toolbar row: the host's start,
              Expand all and the lanes toggle, Key (the colours), then playback taking the room left.
              It wraps to a second row only when the panel is too narrow. The Editor keeps its bar of lane controls and legend. */}
          {editable
            ? (legend || allGroups.length > 0 || (showLanes && !hasGroups) || (departmentLanes && !departmentLanes.always)) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2">
                  {laneControls}
                  {legend && <MapLegend badge={!!openIssues} />}
                  {overflowNote("ml-auto")}
                </div>
              )
            : (toolbarStart || legend || laneControls || showPlayback) && (
                <div className="flex min-h-11 flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-1.5 text-xs" data-map-toolbar>
                  {toolbarStart && (
                    <div className="flex min-w-0 flex-none flex-wrap items-center gap-x-3 gap-y-1.5" data-map-toolbar-start>
                      {toolbarStart}
                    </div>
                  )}
                  {laneControls}
                  {legend && <MapKey badge={!!openIssues} note={showPlayback && playback.index ? `Playback shows run 1 of ${result?.reps ?? 1}; the figures average all ${result?.reps ?? 1} runs.` : undefined} />}
                  {showPlayback ? (
                    <div className="flex max-w-full flex-auto" data-playback-strip>
                      <PlaybackBar
                        inline
                        clock={playback.clock}
                        H={playback.index?.H ?? null}
                        hoursPerWeek={playback.hoursPerWeek}
                        reps={result?.reps ?? null}
                        describe={playback.describe}
                      />
                    </div>
                  ) : (
                    <span className="flex-1" aria-hidden />
                  )}
                </div>
              )}
          <div className={`relative min-h-0 ${heightMode === "fill" ? "flex-1" : ""}`} style={heightMode === "auto" ? { height: autoHeight ?? 360 } : undefined}>
          {/* Before the map in the page, so Tab reaches the toolbar first. */}
          {editable && editorState && (
            <div className="absolute top-2.5 left-2.5 z-10 max-w-[calc(100%-1.25rem)]">
              <Toolbar bundle={bundle} state={editorState} onAdd={addFromToolbar} hideAdd={hideAdd} savedLabel={savedLabel} />
            </div>
          )}
          {/* A read-only map says in words that it runs past the panel, over its top edge (the toolbar row has no room for it). */}
          {!editable && overflowNote("pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-panel/95 px-2 py-0.5 shadow-token")}
          {/* Nothing to draw means nothing for a run to change on the map: the empty state says enough. */}
          {computing && !nothingToDraw && <FirstRunStatus />}
          {nothingToDraw && (
            <div className="absolute inset-0 z-[5] flex items-center justify-center p-4">
              <EmptyState className="bg-card" action={emptyAction}>
                Nothing to draw yet: this process has no steps.
              </EmptyState>
            </div>
          )}
          {diffLegend && diff && diff.list.length > 0 && (
            <p
              aria-hidden
              className="absolute top-12 right-2.5 z-10 hidden rounded-token border border-line bg-panel/95 px-2 py-1 text-[11px] text-fg-2 shadow-token md:block"
            >
              <span className="mr-1 inline-block h-2.5 w-4 border border-dashed border-edit align-middle" /> new ·{" "}
              <s>removed</s> · <s className="text-fg-3">was</s> → now
            </p>
          )}
          {/* Playback of the run (issue #14), over the foot of the map; before it in the page, for Tab. */}
          {floatingPlayback && (
            <div ref={footRef} className="absolute right-2.5 bottom-2.5 left-2.5 z-10">
              <PlaybackBar
                clock={playback.clock}
                H={playback.index?.H ?? null}
                hoursPerWeek={playback.hoursPerWeek}
                reps={result?.reps ?? null}
                describe={playback.describe}
              />
            </div>
          )}
          {/* Zoom in, zoom out, fit and full screen, in the map's bottom-right corner (above a floating playback bar); before the map in the page, for Tab. */}
          {controls && (
            <MapViewControls
              onOut={() => zoomBy("out")}
              onFit={fitByHand}
              onIn={() => zoomBy("in")}
              fullscreen={!editable && canFullscreen ? { on: fullscreen, toggle: toggleFullscreen } : null}
              style={floatingPlayback && footHeight ? { bottom: footHeight + 10 } : undefined}
            />
          )}
          <div className="absolute inset-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={flowHandlers.onNodesChange}
            onEdgesChange={flowHandlers.onEdgesChange}
            onConnect={editable ? flowHandlers.onConnect : undefined}
            isValidConnection={flowHandlers.isValidConnection}
            onReconnect={editable ? flowHandlers.onReconnect : undefined}
            onNodeDoubleClick={flowHandlers.onNodeDoubleClick}
            onNodeContextMenu={flowHandlers.onNodeContextMenu}
            onSelectionContextMenu={flowHandlers.onSelectionContextMenu}
            edgesReconnectable={editable}
            nodesDraggable={editable}
            nodesConnectable={editable}
            elementsSelectable={editable}
            edgesFocusable={editable}
            // Deleting goes through the editor (see ProcessView), never React Flow's own delete.
            deleteKeyCode={null}
            // Shift-drag draws a selection box; Shift-, Ctrl- or ⌘-click adds to the selection.
            selectionKeyCode="Shift"
            multiSelectionKeyCode={["Shift", "Meta", "Control"]}
            selectionMode={SelectionMode.Partial}
            zoomOnDoubleClick={false}
            onMoveStart={flowHandlers.onMoveStart}
            onMoveEnd={flowHandlers.onMoveEnd}
            ariaLabelConfig={editable ? EDIT_ARIA : READ_ARIA}
            onNodeClick={flowHandlers.onNodeClick}
            onPaneClick={flowHandlers.onPaneClick}
            // A read-only map sits in a page that scrolls: the wheel scrolls the page, and the map is dragged or zoomed with its buttons.
            zoomOnScroll={wheelZoom ?? editable}
            preventScrolling={wheelZoom ?? editable}
            minZoom={0.3}
            maxZoom={1.8}
            proOptions={PRO_OPTIONS}
          >
            <Background color="var(--line)" gap={24} />
            {layout && <LaneLayer lanes={layout.lanes} />}
            {playback.index && (
              <PlaybackLayer
                clock={playback.clock}
                index={playback.index}
                steps={playback.steps}
                bottleneck={result?.bnStep ?? null}
                reducedMotion={playback.reducedMotion}
              />
            )}
          </ReactFlow>
          </div>
          {detailStep && (
            <StepDetail
              step={detailStep}
              who={(detailStep.person_id ? namedForViewer(viewerOf(bundle), bundle.people).find((x) => x.id === detailStep.person_id)?.name : null) ?? bundle.roles.find((x) => x.id === detailStep.role_id)?.name ?? null}
              rating={ratingOfRank(rating?.(detailStep.id)?.rank ?? -1)}
              reworkTo={reworkToOf(bundle.steps, detailStep)}
              extras={stepExtras?.(detailStep.id) ?? NO_EXTRAS}
              sources={sourcesOf(detailStep, sourceTitles)}
              baseValues={stepBaseValues?.(detailStep)}
              onClose={closeDetail}
            />
          )}
          {menu && editor && commands && (
            <NodeMenu
              key={menu.id}
              menu={menu}
              bounds={menu.bounds}
              bundle={bundle}
              editor={editor}
              commands={commands}
              onRename={(id) => startEditing(id, "name")}
              onClose={closeMenu}
            />
          )}
          </div>
        </div>
      </InlineEditContext.Provider>
    </CanvasContext.Provider>
  );
}

/** Swimlanes, drawn under the map in its coordinates, so they pan and zoom with it. */
function LaneLayer({ lanes }: { lanes: Lane[] }) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  return (
    <div aria-hidden className="react-flow__container pointer-events-none overflow-hidden" style={{ zIndex: -1 }}>
      <div className="absolute top-0 left-0" style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})`, transformOrigin: "0 0" }}>
        {lanes.map((lane, i) => (
          <div
            key={lane.key}
            data-lane={lane.label}
            className={`absolute border-b border-line ${i % 2 ? "bg-panel" : "bg-panel-2/60"} ${i === 0 ? "border-t" : ""}`}
            style={{ left: lane.x, top: lane.y, width: lane.width, height: lane.height }}
          >
            <div className="absolute inset-y-0 left-0 w-1" style={{ background: lane.color ?? "var(--line-2)" }} />
          </div>
        ))}
      </div>
      {/* Names stay readable at any zoom and in view while the map pans sideways. */}
      {lanes.map((lane) => (
        <p
          key={lane.key}
          className="absolute line-clamp-2 max-w-32 text-xs leading-tight font-semibold text-fg-2"
          style={{ left: Math.max(8, tx + lane.x * zoom + 10), top: ty + lane.y * zoom + 6 }}
        >
          {lane.label}
        </p>
      ))}
    </div>
  );
}

function applyPicks(ids: string[], picks: { id: string; selected: boolean }[]): string[] {
  const set = new Set(ids);
  for (const p of picks) {
    if (p.selected) set.add(p.id);
    else set.delete(p.id);
  }
  return set.size === ids.length && ids.every((id) => set.has(id)) ? ids : [...set];
}

const toolButton =
  "rounded-token border border-line bg-panel px-2 py-1 text-fg hover:bg-panel-2 disabled:cursor-not-allowed disabled:text-fg-3 disabled:hover:bg-panel";

/** Open or close every group on the map at once (the numbers don't change; only what is drawn). */
function GroupControls({ allOpen, onToggle }: { allOpen: boolean; onToggle: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onToggle} title={allOpen ? "Close every group to see each as one step with a roll-up" : "Open every group to see the steps inside"}>
      {allOpen ? "Collapse all" : "Expand all"}
    </Button>
  );
}

function LaneToggle({
  lanes,
  onToggle,
  label = "Swimlanes",
  title = "Group steps in lanes by role. A step's lane follows its role; dragging moves steps left or right.",
}: {
  lanes: boolean;
  onToggle: () => void;
  label?: string;
  title?: string;
}) {
  return (
    <Button type="button" variant="outline" size="sm" aria-pressed={lanes} onClick={onToggle} title={title} className={lanes ? "border-accent bg-accent-soft hover:bg-accent-soft" : ""}>
      {label}
    </Button>
  );
}

/** Add a step, the swimlane view, and whether edits are saved (undo and redo are in the editor bar). */
function Toolbar({
  bundle,
  state,
  onAdd,
  hideAdd,
  savedLabel,
}: {
  bundle: ProcessBundle;
  state: EditorState;
  onAdd: (kind: NewStepKind, outcome: StepOutcome | null) => void;
  hideAdd: boolean;
  savedLabel: string;
}) {
  const [kind, setKind] = useState<NewStepKind>("task");
  const [outcome, setOutcome] = useState<StepOutcome | "">("");
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl+";
  return (
    <div
      role="toolbar"
      aria-label="Edit the process"
      className="flex flex-wrap items-center gap-1.5 rounded-token border border-line bg-panel/95 p-1.5 text-xs shadow-token"
    >
      {!hideAdd && (
<>
      <label className="sr-only" htmlFor="new-step-kind">
        Kind of step to add
      </label>
      <select
        id="new-step-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as NewStepKind)}
        className="rounded-token border border-line bg-panel px-1.5 py-1"
      >
        {STEP_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]}
          </option>
        ))}
      </select>
      {kind === "end" && (
        <>
          <label className="sr-only" htmlFor="new-step-outcome">
            Outcome of the end step
          </label>
          <select
            id="new-step-outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as StepOutcome | "")}
            className="rounded-token border border-line bg-panel px-1.5 py-1"
          >
            <option value="">{OUTCOME_LABELS[nextOutcome(bundle)]} (next free)</option>
            {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        type="button"
        onClick={() => onAdd(kind, kind === "end" ? outcome || null : null)}
        className="rounded-token bg-accent px-2 py-1 font-semibold text-accent-fg"
      >
        Add step
      </button>
      <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
</>
)}
      {/* Undo and redo are buttons in the editor bar (editor quick fixes); the keys still work here. */}
      <KeysHelp mod={mod} />
      <span className="px-1 text-fg-3" aria-live="polite">
        {state.saving ? "Saving…" : savedLabel}
      </span>
    </div>
  );
}

const KEYS: [string, string][] = [
  ["Tab", "move between steps and connections"],
  ["Enter / F2", "edit the focused step here (Enter saves a field, Esc cancels)"],
  ["Shift+F10", "the focused step's actions"],
  ["Space", "select (Shift+Space adds to the selection)"],
  ["Arrows", "move selected steps (Shift: further)"],
  ["Shift+drag", "select with a box; Shift+click adds"],
  ["mod+C / mod+V", "copy and paste steps"],
  ["mod+D", "duplicate selected steps"],
  ["mod+A", "select every step"],
  ["Delete", "delete what is selected"],
  ["mod+Z / mod+Y", "undo / redo"],
  ["mod+B", "show or hide the sidebar"],
  ["Esc", "clear the selection"],
  ["Space (playback bar)", "play or pause"],
  ["Arrows (scrubber)", "an hour (Shift: a day); Page Up/Down: a week"],
];

function KeysHelp({ mod }: { mod: string }) {
  return (
    <details className="relative">
      <summary className={`${toolButton} cursor-pointer list-none`} aria-label="Keyboard shortcuts">
        Keys
      </summary>
      <div className="absolute top-full left-0 z-20 mt-1 w-80 rounded-token border border-line bg-panel p-2 shadow-token">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {KEYS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt className="font-mono text-[11px] whitespace-nowrap text-fg">{keys.replaceAll("mod+", mod)}</dt>
              <dd className="text-fg-2">{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
