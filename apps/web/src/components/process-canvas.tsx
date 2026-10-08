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
import { laneLayout, type Lane } from "@/lib/editor/lanes";
import { CARD_SIZE, TERMINAL_SIZE, groupIds, openGroupSize } from "@/lib/map/groups";
import { groupsToOpen, litIds, withHighlightOpen } from "@/lib/map/highlight";
import { ratingOfRank } from "@/lib/map/rating";
import { ISSUE_PILL_CLASS, tileColours, tileHeadline } from "@/lib/map/tile";
import { MAX_ZOOM, MIN_ZOOM, TALL_PANEL_CLASS, autoPanelHeight, fitViewport, stepZoom, type Padding } from "@/lib/map/zoom";
import { MapLegend, MapViewControls } from "./map/map-controls";
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
  warning: string | null;
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
  warning: string | null;
  editable: boolean;
  change: ChangeKind | null;
  /** The worst rating inside, which colours a closed card. */
  rating: Rating | null;
  /** The map has ratings, so a closed card says what its worst rating is (even "Nothing to fix"). */
  rated: boolean;
  /** Highlighting: true outlined, false dimmed (closed cards only), null when nothing is highlighted. */
  lit: boolean | null;
};

type StepFlowNode = Node<StepNodeData, "step">;
type TerminalFlowNode = Node<StepNodeData, "terminal">;
type GroupFlowNode = Node<GroupNodeData, "group">;
type FlowNode = StepFlowNode | TerminalFlowNode | GroupFlowNode;

/** Whether two node objects for a step would draw the same. */
function sameNode(a: StepFlowNode | TerminalFlowNode, b: StepFlowNode | TerminalFlowNode): boolean {
  if (a.type !== b.type || a.selected !== b.selected || a.ariaLabel !== b.ariaLabel || a.zIndex !== b.zIndex) return false;
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
  if (a.measured?.width !== b.measured?.width || a.measured?.height !== b.measured?.height) return false;
  return (Object.keys(a.data) as (keyof StepNodeData)[]).every((k) => a.data[k] === b.data[k]);
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
};
type BranchFlowEdge = Edge<BranchData, "branch">;

/** Lets custom nodes and edges reach the editor without threading it through React Flow's data. */
const CanvasContext = createContext<{ editor: ProcessEditor | null; restore: ((table: Table, id: string) => void) | null; toggleGroup: (id: string) => void; handoffs: boolean }>({
  editor: null,
  restore: null,
  toggleGroup: () => undefined,
  handoffs: false,
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

function Warning({ text }: { text: string }) {
  return (
    <span
      role="img"
      aria-label={`Warning: ${text}`}
      title={text}
      className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border-2 border-panel bg-warn text-[11px] font-bold text-fg"
    >
      !
    </span>
  );
}

const selectedRing = "outline-2 outline-offset-2 outline-edit";

/** Highlighted cards get a heavy outline; the rest fade (issue #99). */
const litClass = (lit: boolean | null) => (lit === true ? "!border-accent outline-2 outline-offset-1 outline-accent" : lit === false ? "opacity-40" : "");

/** The name of the step a step's rework goes back to, or null when it is redone at the step itself. */
const reworkToOf = (steps: readonly StepRow[], step: StepRow): string | null =>
  step.rework_to_step_id && step.rework_to_step_id !== step.id ? (steps.find((s) => s.id === step.rework_to_step_id)?.name ?? null) : null;

const percent = (p: number) => `${Math.round(p * 1000) / 10}%`;

/** What a screen reader hears for a step. */
function stepLabel(data: StepNodeData): string {
  const { step, role, person, warning, reworkTo, change, estimate, conflict, wasName, wasWho, wasWork, wasWait, rating, bottleneck } = data;
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
  const flags = [rating && `rated ${RATING_LABELS[rating]}`, bottleneck && "bottleneck", draft, conflict && "sources disagree", estimate && "unconfirmed assumption", warning && `warning: ${warning}`];
  if (step.kind === "start" || step.kind === "end") {
    return [step.name, step.kind === "start" ? "start" : `end, ${step.outcome}`, ...flags].filter(Boolean).join(", ");
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

function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { step, role, person, bottleneck, warning, editable, editing, pulse, ghost } = data;
  const who = person?.name ?? role?.name;
  const staffed = role !== null || person !== null;
  const flagged = bottleneck && !editing && !ghost;
  const colours = tileColours(data.rating, flagged);
  const headline = headlineOf(data);
  return (
    <div
      data-lit={data.lit ?? undefined}
      data-tile="step"
      data-rating={data.rating ?? "none"}
      className={`${tileClass} ${editing ? "w-60 border-[1.5px] border-accent bg-panel" : ghost ? "w-48 border-[1.5px] bg-panel px-2.5 py-2" : "w-48 border-[1.5px] px-2.5 pt-2 pb-2"} ${flagged ? "ring-[1.5px] ring-crit" : ""} ${changeClass(data)} ${litClass(data.lit)} ${selected ? selectedRing : ""}`}
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
      {warning && <Warning text={warning} />}
      <Handle type="source" position={Position.Right} className={handleClass(editable && !ghost)} />
    </div>
  );
}

function GroupNode({ data, selected }: NodeProps<GroupFlowNode>) {
  const { step, open, expandable, roll, warning, editable } = data;
  const { toggleGroup, handoffs } = useContext(CanvasContext);
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
        className={`relative h-full w-full rounded-token border-2 border-dashed bg-panel-2/40 ${changeClass(data)} ${data.lit ? "!border-solid !border-accent" : ""} ${selected ? selectedRing : "border-line-2"}`}
        data-group="open"
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
          </div>
          {toggle}
        </div>
        {warning && <Warning text={warning} />}
        <Handle type="source" position={Position.Right} className={handleClass(editable)} />
      </div>
    );
  }
  const colours = tileColours(data.rating, false);
  return (
    <div
      className={`${tileClass} w-48 border-2 border-dashed px-2.5 pt-2 pb-2 ${changeClass(data)} ${litClass(data.lit)} ${selected ? selectedRing : ""}`}
      style={{ background: colours.background, borderColor: colours.borderColor }}
      data-group="closed"
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
      <p className={headlineRowClass}>
        <span className="font-mono text-base leading-none font-medium text-fg tabular-nums">{roll.steps}</span>
        <span className="min-w-0 truncate text-[11.5px] leading-4 text-fg-2" title="Hands-on time of every step inside, added up">
          {roll.steps === 1 ? "step" : "steps"} · {roll.handsOnHours ? `${formatHours(roll.handsOnHours)} work` : "no work entered"}
        </span>
      </p>
      <div className={footClass} style={{ borderTopColor: colours.divider }}>
        <span>{expandable ? "Group" : handoffs ? "Process" : "Child process"}</span>
        {toggle}
      </div>
      {warning && <Warning text={warning} />}
      <Handle type="source" position={Position.Right} className={handleClass(editable)} />
    </div>
  );
}

function TerminalNode({ data, selected }: NodeProps<TerminalFlowNode>) {
  const { step, warning, editing, ghost } = data;
  const editable = data.editable && !ghost;
  const tone =
    step.outcome === "won" ? "bg-good-soft text-fg" : step.outcome === "lost" ? "bg-panel-2 text-fg-2" : "bg-accent-soft text-fg";
  return (
    <div
      data-lit={data.lit ?? undefined}
      data-tile="terminal"
      className={`${tileClass} border-[1.5px] ${editing ? "w-44 border-accent bg-panel" : `w-max max-w-[150px] min-w-24 border-line-2 px-2.5 py-1.5 ${tone}`} ${changeClass(data)} ${litClass(data.lit)} ${selected ? selectedRing : ""}`}
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
          <p className="text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">{step.kind === "start" ? "Start" : "End"}</p>
          <p data-field="name" className={`text-[13px] leading-tight font-semibold break-words ${step.outcome === "lost" ? "text-fg-2" : "text-fg"}`}>
            <Was was={data.wasName}>{step.name}</Was>
          </p>
        </>
      )}
      {warning && <Warning text={warning} />}
      {step.kind === "start" && <Handle type="source" position={Position.Right} className={handleClass(editable)} />}
    </div>
  );
}

/** A branch: its probability (and condition tag) as a label, edited inline when selected. */
function BranchEdge(props: EdgeProps<BranchFlowEdge>) {
  const { id, data, selected, markerEnd, style } = props;
  const { editor, handoffs } = useContext(CanvasContext);
  const zoom = useStore((s) => s.transform[2]);
  const [path, labelX, labelY] = getSmoothStepPath(props);
  const p = data?.probability ?? 1;
  const tag = data?.tag ?? null;
  const editing = selected && data?.alone && editor;
  // A handoff line says what is handed over, not a share of the work.
  const text = handoffs ? (data?.label ?? "") : [p < 1 ? percent(p) : null, tag].filter(Boolean).join(" · ");
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
            <div
              className="nodrag nopan absolute"
              style={{
                transform: `translate(${labelX}px, ${labelY + 14}px) scale(${1 / zoom}) translate(-50%, 0)`,
                transformOrigin: "0 0",
                zIndex: 1002,
                pointerEvents: "all",
              }}
            >
              {handoffs ? <HandoffEditor key={id} editor={editor} edgeId={id} label={data?.label ?? null} /> : <BranchEditor key={id} editor={editor} edgeId={id} probability={p} tag={tag} />}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={18} />
      {(editing || text) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute"
            style={{
              // The editor stays readable at any zoom and sits above the nodes.
              // Read-only, the label sits just above the line at its start, in the gap beside the card, not on one at the middle of a short link.
              transform: editing
                ? `translate(${labelX}px, ${labelY}px) scale(${1 / zoom}) translate(-50%, -50%)`
                : `translate(${props.sourceX + 4}px, ${props.sourceY - 2}px) translate(0, -100%)`,
              transformOrigin: "0 0",
              zIndex: editing ? 1002 : undefined,
              pointerEvents: "all",
            }}
          >
            {editing ? (
              handoffs ? <HandoffEditor key={id} editor={editor} edgeId={id} label={data?.label ?? null} /> : <BranchEditor key={id} editor={editor} edgeId={id} probability={p} tag={tag} />
            ) : (
              <span title={text} className={`block truncate rounded-token bg-panel px-1 text-[11px] text-fg-2 ${handoffs ? "max-w-[9rem] font-sans" : "max-w-[5.5rem] font-mono tabular-nums"}`}>{text}</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A handoff line's label and removal, on the company map: no share or tag, the lines are pictures. */
function HandoffEditor({ editor, edgeId, label }: { editor: ProcessEditor; edgeId: string; label: string | null }) {
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
      <button type="button" onClick={() => editor.run((b) => deleteEdges(b, [edgeId]))} className="self-start text-crit hover:underline">
        Remove handoff
      </button>
    </div>
  );
}

const edgeInputClass = "rounded-token border border-line bg-panel px-1.5 py-0.5 tabular-nums";

/** Put focus back on an edge of the map. */
const focusEdge = (id: string) => document.querySelector<SVGGElement>(`.react-flow__edge[data-id="${id}"]`)?.focus();

function BranchEditor({ editor, edgeId, probability, tag }: { editor: ProcessEditor; edgeId: string; probability: number; tag: string | null }) {
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
      <button
        type="button"
        onClick={() => editor.run((b) => deleteEdges(b, [edgeId]))}
        className="self-start text-crit hover:underline"
      >
        Remove connection
      </button>
    </div>
  );
}

const nodeTypes = { step: StepNode, terminal: TerminalNode, group: GroupNode };
const edgeTypes = { branch: BranchEdge };

/**
 * Room around the steps when framing them: the toolbar sits top left, playback along the foot, lane names on the left, and
 * the zoom buttons (32 px and a 10 px margin) down the right, so a fitted map never ends under them.
 */
const fitPadding = (lanes: boolean, toolbar: boolean, playback: boolean, controls: boolean): Padding => ({
  top: toolbar ? 64 : 24,
  right: controls ? 60 : 24,
  bottom: playback ? 64 : 24,
  left: lanes ? 150 : 24,
});

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
  /** Show the zoom in, zoom out, fit (and, read-only, full screen) buttons on the map. Default true. */
  zoomControls?: boolean;
  /** Show the playback bar over the foot of the map. Default true; embedded maps turn it off. */
  showPlayback?: boolean;
  /**
   * Put the playback bar in its own strip above the map rather than floating over its foot, so it never covers a card
   * (the Overview's company map, where on a phone the bar wraps to two lines). Default false.
   */
  playbackAbove?: boolean;
  /**
   * Playback of the company map (issue #173): every item plays, pipeline and servicing, and what is inside a closed card
   * is counted on the card. Default false: a process's own items only, on the steps drawn.
   */
  playbackRollUp?: boolean;
  /** Offer the swimlane view (when the map has no groups). Default true. */
  showLanes?: boolean;
  /**
   * `fill`: as tall as the space it is given (the editor). `auto`: as tall as the map needs, from 16 to 40 rem,
   * so a small map doesn't sit in a tall empty panel. `tall`: a fixed share of the screen's height (`TALL_PANEL_CLASS`),
   * with the map centred in it (the Overview's company map). Default `auto` when read-only, `fill` when editable.
   */
  height?: "auto" | "fill" | "tall";
  /** A step (or closed group) was clicked, or Enter was pressed on it. */
  onStepClick?: (stepId: string) => void;
  /** Open the step's detail on a click, on a read-only map. Default true. */
  stepDetail?: boolean;
  /** What a click on a step shows besides its numbers: the insights and confirmed issues on it. Read-only maps only. */
  stepExtras?: (stepId: string) => StepExtras | null;
  /** Titles of the workspace's sources by id, for the sources a step's detail lists. */
  sourceTitles?: Readonly<Record<string, string>>;
  /** The first run is still computing: shows FirstRunStatus over the map. */
  computing?: boolean;
  /** What to do about a read-only map with no steps (the process page offers the Editor); shown under the sentence. */
  emptyAction?: ReactNode;
}

const noSubscribe = () => () => undefined;
const fullscreenEnabled = () => !!document.fullscreenEnabled;
const serverFalse = () => false;
const onFullscreenChange = (notify: () => void) => {
  document.addEventListener("fullscreenchange", notify);
  return () => document.removeEventListener("fullscreenchange", notify);
};

export function ProcessCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
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
  playbackAbove = false,
  playbackRollUp = false,
  showLanes = true,
  height: heightProp,
  onStepClick,
  stepDetail = true,
  stepExtras,
  sourceTitles,
  computing = false,
  emptyAction,
}: CanvasProps) {
  const editable = editor !== null;
  // A read-only map with nothing between start and end has nothing to draw. (The Editor keeps its empty canvas: a new block starts there.)
  const nothingToDraw = !editable && !bundle.steps.some((s) => s.kind !== "start" && s.kind !== "end");
  // Groups open in place (issue #102): to edit inside one, open it; to read the map, close it for the roll-up.
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(() => (editor ? new Set(groupIds(bundle.steps)) : new Set()));
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
  const canvasContext = useMemo(() => ({ editor, restore: editor ? onRestore : null, toggleGroup, handoffs }), [editor, onRestore, toggleGroup, handoffs]);
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
      return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, visible: { left: from.x, top: from.y, right: to.x, bottom: to.y }, sizes: measured, occupied };
    };
    return () => {
      viewRef.current = null;
    };
  }, [viewRef, flow, measured, diff]);
  const [lanes, setLanes] = useState(false);
  const [editing, setEditing] = useState<{ id: string; field: InlineField } | null>(null);
  const [menu, setMenu] = useState<(MenuState & { bounds: { width: number; height: number } }) | null>(null);
  // Which step's menu is open, synchronously, so the context-menu event that follows Shift+F10 doesn't reopen it.
  const menuFor = useRef<string | null>(null);
  const playbackGroups = useMemo(() => (playbackRollUp ? { open: drawn } : null), [playbackRollUp, drawn]);
  const playback = usePlayback(bundle, result, playbackGroups);

  const warnings = useMemo(() => (editable && !handoffs ? stepWarnings(bundle) : new Map<string, string>()), [bundle, editable, handoffs]);
  const order = useMemo(() => flowOrder(bundle), [bundle]);
  const editingId = editing && bundle.steps.some((s) => s.id === editing.id) ? editing.id : null;
  const layout = useMemo(() => {
    // Lanes place every step by its role; a group's steps sit inside its box instead.
    if (!lanes || hasGroups) return null;
    // The card being edited grows; its lane keeps its size meanwhile.
    const sizes = new Map([...measured].filter(([id]) => id !== editingId));
    return laneLayout(bundle, sizes);
  }, [lanes, hasGroups, bundle, measured, editingId]);

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
            warning: warnings.get(step.id) ?? null,
            editable,
            change: change && (change.kind !== "changed" || change.fields.length) ? change.kind : null,
            rating: worst ? ratingOfRank(worst.rank) : null,
            rated: rating !== undefined,
            // An open group is a box around its steps: it can be outlined but never fades.
            lit: lit ? (open ? lit.has(step.id) || null : lit.has(step.id)) : null,
          };
          return {
            id: step.id,
            type: "group",
            position: dragging.get(step.id) ?? { x: Number(step.x), y: Number(step.y) },
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
          warning: warnings.get(step.id) ?? null,
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
          warning: null,
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
    return [...ghosts, ...drafted];
  }, [bundle, result, selection.steps, dragging, measured, warnings, editable, order, layout, editing, editingId, nodeCache, playback.pulsing, diff, drawn, lit, openIssues, rating, handoffs]);

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
    const drafted = shown
      .sort((a, b) => rank(a) - rank(b))
      .map((e): BranchFlowEdge => {
        const change = e.rolled ? undefined : diff?.edges.get(e.id);
        const relabelled = change?.kind === "changed" && change.fields.some((f) => (handoffs ? f.field === "label" : f.field === "probability" || f.field === "condition_tag"));
        const was = relabelled ? (handoffs ? (change.live!.label ?? "no label") : labelOf(Number(change.live!.probability), change.live!.condition_tag)) : null;
        const tone = selected.has(e.id) || change ? "var(--edit)" : "var(--line-2)";
        return {
          id: e.id,
          source: e.from_step_id,
          target: e.to_step_id,
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
          },
          style: {
            stroke: tone,
            strokeWidth: selected.has(e.id) ? 2.5 : change ? 2 : 1.5,
            ...(change?.kind === "added" ? { strokeDasharray: "6 4" } : e.rolled ? { strokeDasharray: "2 4" } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: tone },
          ariaLabel: handoffs
            ? `Handoff from ${names.get(e.from_step_id)} to ${names.get(e.to_step_id)}${e.label ? `: ${e.label}` : ""}${change?.kind === "added" ? ", new in this draft" : change ? `, changed in this draft${was ? `, was ${was}` : ""}` : ""}`
            : `Connection from ${names.get(e.from_step_id)} to ${names.get(e.to_step_id)}, ${percent(Number(e.probability))}${e.condition_tag ? `, tag ${e.condition_tag}` : ""}${
            change?.kind === "added" ? ", new in this draft" : change ? `, changed in this draft${was ? `, was ${was}` : ""}` : ""
          }`,
        };
      });
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
    return [...ghosts, ...drafted];
  }, [bundle, selection.edges, selection.steps.length, order, diff, editable, drawn, handoffs]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const moves: { id: string; x: number; y: number }[] = [];
    const drags = new Map(dragging);
    const sizes = new Map(measured);
    let moved = false;
    let sized = false;
    const picks: { id: string; selected: boolean }[] = [];
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
          moves.push({ id: c.id, x: c.position.x, y: layout && stored ? Number(stored.y) : c.position.y });
          drags.delete(c.id);
        }
        moved = true;
      } else if (c.type === "select") picks.push({ id: c.id, selected: c.selected });
    }
    if (sized) setMeasured(sizes);
    // Everything dragged together arrives in one change list: one edit, one undo step.
    if (moves.length) editor?.run((b) => moveSteps(b, moves));
    if (moved) setDragging(drags);
    if (picks.length) onSelectionChange((s) => ({ ...s, steps: applyPicks(s.steps, picks) }));
  };

  const onEdgesChange = (changes: EdgeChange<BranchFlowEdge>[]) => {
    const picks = changes.flatMap((c) => (c.type === "select" ? [{ id: c.id, selected: c.selected }] : []));
    if (picks.length) onSelectionChange((s) => ({ ...s, edges: applyPicks(s.edges, picks) }));
  };

  const onConnect = (c: Connection) => {
    let id: string | null = null;
    editor?.run((b) => {
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

  // Zoom (issue #99): the map is framed once when it first appears, never below 70%; a bigger map is dragged around
  // instead. After that it moves only when asked: Fit, Expand or Collapse all, the swimlane toggle, or (read-only
  // maps) the panel changing size. Adding a step, opening a group by hand or a highlight never moves the view.
  const width = useStore((st) => st.width);
  const height = useStore((st) => st.height);
  const zoom = useStore((st) => st.transform[2]);
  // Full screen (read-only maps): the map fills the screen, as the Editor's fills its space, and is centred in it.
  // Known only in the browser (an iPhone has no full screen for an element), so the server and hydration leave it out.
  const canFullscreen = useSyncExternalStore(noSubscribe, fullscreenEnabled, serverFalse);
  const fullscreen = useSyncExternalStore(onFullscreenChange, () => document.fullscreenElement !== null && document.fullscreenElement === wrapper.current, serverFalse);
  const heightMode = fullscreen ? "fill" : (heightProp ?? (editable ? "fill" : "auto"));
  const middle = fullscreen || heightMode === "tall";
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
    (animate: boolean) => {
      const all = flow.getNodes();
      const panel = sizeRef.current;
      if (!all.length || !panel.width) return;
      const wanted = focus?.length ? all.filter((n) => focus.includes(n.id)) : [];
      let bounds = flow.getNodesBounds(wanted.length ? wanted : all);
      // Room around what is framed, so a step or two is seen in its surroundings and not blown up to fill the panel.
      if (wanted.length) bounds = { x: bounds.x - 260, y: bounds.y - 140, width: bounds.width + 520, height: bounds.height + 280 };
      // A bar in its own strip above takes no room off the map.
      const pad = fitPadding(lanes, editable, showPlayback && !playbackAbove, zoomControls);
      let panelHeight = panel.height;
      if (heightMode === "auto") {
        panelHeight = autoPanelHeight(bounds, panel.width, pad);
        setAutoHeight(panelHeight);
      }
      if (!panelHeight) return;
      void flow.setViewport(fitViewport(bounds, { width: panel.width, height: panelHeight }, pad, { middle }), animate ? { duration: 200 } : undefined);
      setTimeout(measureOverflow, animate ? 260 : 20);
    },
    [flow, lanes, editable, showPlayback, playbackAbove, zoomControls, heightMode, middle, measureOverflow, focus],
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
  // A read-only map follows its panel's width (and height, when that is fixed), unless it was moved by hand.
  const refitKey = editable && !fullscreen ? "" : heightMode === "auto" ? `${width}` : `${width}x${height}`;
  useEffect(() => {
    if (!refitKey || !framed.current || handZoomed.current) return;
    const timer = setTimeout(() => fitRef.current(false), 60);
    return () => clearTimeout(timer);
  }, [refitKey]);
  const zoomBy = (direction: "in" | "out") => {
    handZoomed.current = true;
    void flow.zoomTo(stepZoom(zoom, direction), { duration: 150 });
  };
  const fitByHand = () => {
    handZoomed.current = false;
    fit(true);
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
    handZoomed.current = false;
    setFitTick((t) => t + 1);
  }, [fullscreen]);
  // The playback bar floats over the foot of the map: the buttons sit above it, however tall it wraps.
  const footRef = useRef<HTMLDivElement>(null);
  const [footHeight, setFootHeight] = useState(0);
  useEffect(() => {
    const el = footRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFootHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [showPlayback, playbackAbove]);

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
  const [detailId, setDetailId] = useState<string | null>(null);
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
          data-map-height={heightMode}
          data-fullscreen={fullscreen ? "" : undefined}
          role="region"
          aria-label={`${bundle.process.name} process map`}
        >
          {/* Above the map in the page, so Tab reaches these first: open or close every group, and what the colours mean. */}
          {(legend || allGroups.length > 0 || (showLanes && !hasGroups)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2">
              {((showLanes && !hasGroups) || allGroups.length > 0) && (
                <div className="flex items-center gap-1.5">
                  {showLanes && !hasGroups && <LaneToggle lanes={lanes} onToggle={toggleLanes} />}
                  {allGroups.length > 0 && <GroupControls allOpen={allGroups.every((id) => expanded.has(id))} onToggle={toggleAllGroups} />}
                </div>
              )}
              {legend && <MapLegend badge={!!openIssues} />}
              {(overflow.left || overflow.right) && (
                <p className="ml-auto text-[11.5px] text-fg-2" data-map-overflow>
                  {overflow.right && !overflow.left ? "Drag the map to see the rest →" : overflow.left && !overflow.right ? "← Drag the map to see the rest" : "Drag the map to see the rest"}
                </p>
              )}
            </div>
          )}
          {showPlayback && playbackAbove && (
            <div className="border-b border-line px-2.5 py-2" data-playback-strip>
              <PlaybackBar
                clock={playback.clock}
                H={playback.index?.H ?? null}
                hoursPerWeek={playback.hoursPerWeek}
                reps={result?.reps ?? null}
                describe={playback.describe}
              />
            </div>
          )}
          <div
            className={`relative min-h-0 ${heightMode === "fill" ? "flex-1" : heightMode === "tall" ? TALL_PANEL_CLASS : ""}`}
            style={heightMode === "auto" ? { height: autoHeight ?? 360 } : undefined}
            data-map-area
          >
          {/* Before the map in the page, so Tab reaches the toolbar first. */}
          {editable && editorState && (
            <div className="absolute top-2.5 left-2.5 z-10 max-w-[calc(100%-1.25rem)]">
              <Toolbar bundle={bundle} editor={editor} state={editorState} onAdd={addFromToolbar} hideAdd={hideAdd} savedLabel={savedLabel} />
            </div>
          )}
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
          {showPlayback && !playbackAbove && (
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
          {/* Zoom in, zoom out, fit and full screen, in the map's foot corner; before the map in the page, for Tab. */}
          {zoomControls && !nothingToDraw && (
            <MapViewControls
              zoom={zoom}
              onOut={() => zoomBy("out")}
              onFit={fitByHand}
              onIn={() => zoomBy("in")}
              canOut={zoom > MIN_ZOOM + 0.001}
              canIn={zoom < MAX_ZOOM - 0.001}
              fullscreen={!editable && canFullscreen ? { on: fullscreen, toggle: toggleFullscreen } : null}
              style={showPlayback && !playbackAbove && footHeight ? { bottom: footHeight + 10 } : undefined}
            />
          )}
          <div className="absolute inset-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={editable ? onConnect : undefined}
            isValidConnection={(c) => !connectionProblem(bundle, c.source, c.target)}
            onReconnect={editable ? (old, c) => editor.run((b) => reconnectEdge(b, old.id, c.source, c.target)) : undefined}
            onNodeDoubleClick={(e, node) => {
              if (!(e.target instanceof Element) || e.target.closest("input, select, .nokey")) return;
              const field = e.target.closest("[data-field]")?.getAttribute("data-field") as InlineField | null;
              startEditing(node.id, field ?? "name");
            }}
            onNodeContextMenu={(e, node) => {
              if (!editable) return;
              e.preventDefault();
              if (menuFor.current === node.id) return;
              const rect = wrapper.current!.getBoundingClientRect();
              // A context-menu key press arrives without a pointer position.
              if (e.clientX === 0 && e.clientY === 0 && e.currentTarget instanceof Element) openMenuBelow(e.currentTarget, node.id);
              else openMenu(node.id, e.clientX - rect.left, e.clientY - rect.top);
            }}
            onSelectionContextMenu={(e, picked) => {
              if (!editable || !picked.length) return;
              e.preventDefault();
              const rect = wrapper.current!.getBoundingClientRect();
              openMenu(
                picked[0]!.id,
                e.clientX - rect.left,
                e.clientY - rect.top,
                picked.map((n) => n.id),
              );
            }}
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
            // The menu belongs where it was opened; moving the map closes it.
            onMoveStart={(event) => {
              // A drag, the wheel or a pinch moves the view by hand; the map stops following its panel.
              if (event) handZoomed.current = true;
              if (menuFor.current) closeMenu(false);
            }}
            onMoveEnd={measureOverflow}
            ariaLabelConfig={editable ? EDIT_ARIA : READ_ARIA}
            onNodeClick={(e, node) => {
              // The group toggle and the issue badge are buttons of their own.
              if (e.target instanceof Element && e.target.closest("button")) return;
              if (!node.id.startsWith("ghost:")) onStepClick?.(node.id);
              if (!editable && stepDetail) setDetailId(node.id);
            }}
            onPaneClick={() => setDetailId(null)}
            // A read-only map sits in a page that scrolls: the wheel scrolls the page, and the map is dragged or zoomed with its buttons.
            zoomOnScroll={editable}
            preventScrolling={editable}
            minZoom={0.3}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
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
          className="absolute max-w-32 truncate text-xs font-semibold text-fg-2"
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
    <button
      type="button"
      onClick={onToggle}
      title={allOpen ? "Close every group to see each as one step with a roll-up" : "Open every group to see the steps inside"}
      className={`${toolButton} text-xs`}
    >
      {allOpen ? "Collapse all" : "Expand all"}
    </button>
  );
}

function LaneToggle({ lanes, onToggle }: { lanes: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={lanes}
      onClick={onToggle}
      title="Group steps in lanes by role. A step's lane follows its role; dragging moves steps left or right."
      className={`${toolButton} text-xs ${lanes ? "!border-accent !bg-accent-soft" : ""}`}
    >
      Swimlanes
    </button>
  );
}

/** Add a step, undo, redo, the swimlane view, and whether edits are saved. */
function Toolbar({
  bundle,
  editor,
  state,
  onAdd,
  hideAdd,
  savedLabel,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
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
      <button
        type="button"
        onClick={() => editor.undo()}
        disabled={!state.undoLabel}
        title={state.undoLabel ? `Undo: ${state.undoLabel} (${mod}Z)` : "Nothing to undo"}
        className={toolButton}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={() => editor.redo()}
        disabled={!state.redoLabel}
        title={state.redoLabel ? `Redo: ${state.redoLabel} (${mac ? "⇧⌘Z" : "Ctrl+Y"})` : "Nothing to redo"}
        className={toolButton}
      >
        Redo
      </button>
      <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
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
