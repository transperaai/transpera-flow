// Builds edits (./ops.ts) from what the user did, against the process as the
// editor shows it now. Each builder returns null when there is nothing to do.
// Step and edge ids are made here, once, and never change afterwards.

import {
  ancestorsOf,
  groupHasExit,
  groupsLetOut,
  triangularRange,
  type EdgeRow,
  type ProcessBundle,
  type StepKind,
  type StepOutcome,
  type StepRow,
} from "@transpera-flow/db";
import { pick, readField, type Edit, type Op, type Patch, type RowChange, type Value } from "./ops";

/** Kinds the palette offers. `subprocess` arrives with sub-processes. */
export const STEP_KINDS = ["task", "wait", "decision", "start", "end"] as const satisfies readonly StepKind[];
export type NewStepKind = (typeof STEP_KINDS)[number];

export const KIND_LABELS: Record<StepKind, string> = {
  task: "Task",
  wait: "Wait",
  decision: "Decision",
  subprocess: "Sub-process",
  group: "Group",
  start: "Start",
  end: "End",
};

export const OUTCOME_LABELS: Record<StepOutcome, string> = { won: "Won", lost: "Lost", done: "Done" };

/** Probabilities within this of 100% count as 100%. */
const TOLERANCE = 1e-6;

export const newId = (): string => crypto.randomUUID();

const round = (v: number) => Math.round(v * 1000) / 1000;

const stepName = (bundle: ProcessBundle, id: string) => bundle.steps.find((s) => s.id === id)?.name ?? "step";

/** Defaults for a new step of each kind. */
export function newStepRow(bundle: ProcessBundle, kind: NewStepKind, outcome: StepOutcome | null, x: number, y: number): StepRow {
  const { revision } = bundle;
  const names: Record<NewStepKind, string> = {
    task: "New task",
    wait: "Waiting",
    decision: "Decision",
    start: "Start",
    end: outcome ? OUTCOME_LABELS[outcome] : "End",
  };
  return {
    id: newId(),
    revision_id: revision.id,
    workspace_id: revision.workspace_id,
    process_id: revision.process_id,
    name: names[kind],
    kind,
    outcome: kind === "end" ? (outcome ?? "done") : null,
    role_id: null,
    person_id: null,
    work_hours: kind === "task" ? 1 : 0,
    work_dist: "lognormal",
    work_params: {},
    wait_hours: kind === "wait" ? 8 : 0,
    wait_dist: "lognormal",
    wait_params: {},
    rework_rate: 0,
    rework_to_step_id: null,
    tool: null,
    notes: null,
    sla_hours: null,
    expected_wait_hours: null,
    lost_per_day_waiting: null,
    dropoff_benchmark: null,
    target_cycle_hours: null,
    current_wip: null,
    parent_step_id: null,
    entry_step_id: null,
    child_process_id: null,
    x: Math.round(x),
    y: Math.round(y),
    assumption: false,
    conflict: false,
    provenance: {},
  };
}

/** The outcome a new end step gets: won, then lost, then done, whichever the process lacks. */
export function nextOutcome(bundle: ProcessBundle): StepOutcome {
  const taken = new Set(bundle.steps.filter((s) => s.kind === "end").map((s) => s.outcome));
  return taken.has("won") ? (taken.has("lost") ? "done" : "lost") : "won";
}

export function addStep(
  bundle: ProcessBundle,
  { kind, outcome = null, x, y }: { kind: NewStepKind; outcome?: StepOutcome | null; x: number; y: number },
): { edit: Edit; id: string } {
  const step = newStepRow(bundle, kind, kind === "end" ? (outcome ?? nextOutcome(bundle)) : null, x, y);
  return { edit: { label: `Added ${step.name}`, ops: [{ kind: "insert", steps: [step], edges: [] }] }, id: step.id };
}

/**
 * A process placed on the company map (B11): a card that is a link to the process. Cards are moved, joined by handoff lines and
 * put in groups, but not copied, split or removed here: adding and removing processes comes with the process library (B12).
 */
export const isPlacedStep = (bundle: Pick<ProcessBundle, "process">, step: Pick<StepRow, "child_process_id">): boolean =>
  bundle.process.is_company === true && step.child_process_id !== null;

/** What the Editor says where a card can't be removed. */
export const PLACED_REMOVE_NOTE = "Removing processes from the map comes with the process library.";

/** Delete steps with every edge into or out of them; rework targets pointing at them are cleared. */
export function deleteSteps(bundle: ProcessBundle, ids: readonly string[]): Edit | null {
  const gone = new Set(ids);
  // A group takes the steps inside it with it (as the database does), at any depth.
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  for (const s of bundle.steps) if (ancestorsOf(s.id, byId).some((g) => gone.has(g))) gone.add(s.id);
  // A process card stays on the map, and so does a group with one inside.
  if (bundle.steps.some((s) => gone.has(s.id) && isPlacedStep(bundle, s))) return null;
  const steps = bundle.steps.filter((s) => gone.has(s.id));
  if (!steps.length) return null;
  const edges = bundle.edges.filter((e) => gone.has(e.from_step_id) || gone.has(e.to_step_id));
  const refs: RowChange[] = bundle.steps
    .filter((s) => !gone.has(s.id) && s.rework_to_step_id && gone.has(s.rework_to_step_id))
    .map((s) => ({
      table: "steps",
      id: s.id,
      before: { rework_to_step_id: s.rework_to_step_id },
      after: { rework_to_step_id: null },
    }));
  return {
    label: steps.length === 1 ? `Deleted ${steps[0]!.name}` : `Deleted ${steps.length} steps`,
    ops: [...(refs.length ? [{ kind: "update" as const, changes: refs }] : []), { kind: "remove", steps, edges }],
  };
}

export function moveSteps(bundle: ProcessBundle, positions: readonly { id: string; x: number; y: number }[]): Edit | null {
  const changes: RowChange[] = [];
  for (const p of positions) {
    const step = bundle.steps.find((s) => s.id === p.id);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (!step || (Number(step.x) === x && Number(step.y) === y)) continue;
    changes.push({ table: "steps", id: step.id, before: { x: step.x, y: step.y }, after: { x, y } });
  }
  if (!changes.length) return null;
  const label = changes.length === 1 ? `Moved ${stepName(bundle, changes[0]!.id)}` : `Moved ${changes.length} steps`;
  return { label, ops: [{ kind: "update", changes }] };
}

function updateRow(bundle: ProcessBundle, table: "steps" | "edges", id: string, patch: Patch, label: string): Edit | null {
  const row = table === "steps" ? bundle.steps.find((s) => s.id === id) : bundle.edges.find((e) => e.id === id);
  if (!row) return null;
  const after: Patch = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!sameScalar(readField(row, field), value)) after[field] = value;
  }
  if (!Object.keys(after).length) return null;
  return { label, ops: [{ kind: "update", changes: [{ table, id, before: pick(row, Object.keys(after)), after }] }] };
}

/**
 * Numbers compare by value, so "1.5" loaded from Postgres matches 1.5.
 * Objects (provenance entries) compare by content, whatever their key order.
 */
export function sameScalar(a: Value, b: Value): boolean {
  if (typeof a === "object" && a !== null) return typeof b === "object" && b !== null && canonical(a) === canonical(b);
  if (typeof b === "object" && b !== null) return false;
  if (typeof a === "number" || typeof b === "number") {
    return a !== null && b !== null && a !== "" && b !== "" && Number(a) === Number(b);
  }
  return a === b;
}

/** JSON with object keys sorted, so equal objects give equal text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function updateStep(bundle: ProcessBundle, id: string, patch: Patch): Edit | null {
  return updateRow(bundle, "steps", id, patch, `Changed ${stepName(bundle, id)}`);
}

/** Why a step can't become `kind`, or null if it can. */
export function kindProblem(bundle: ProcessBundle, id: string, kind: StepKind): string | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (step?.kind === "group" && kind !== "group" && bundle.steps.some((s) => s.parent_step_id === id)) return "A group holds steps; move or delete them first.";
  if (step?.child_process_id && kind !== "subprocess") return "This step holds a child process.";
  if (kind === "start" && bundle.steps.some((s) => s.kind === "start" && s.id !== id)) {
    return "The process already has a start step.";
  }
  return null;
}

/**
 * Change a step's kind. End steps get an outcome and lose it when they stop
 * being ends (the table's `(kind = 'end') = (outcome is not null)`). A new end
 * step loses its outgoing connections and a new start step its incoming ones,
 * in the same edit, so one undo brings them back.
 */
export function setStepKind(bundle: ProcessBundle, id: string, kind: StepKind): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step || kindProblem(bundle, id, kind)) return null;
  const outcome = kind === "end" ? (step.outcome ?? nextOutcome(bundle)) : null;
  const update = updateStep(bundle, id, { kind, outcome });
  if (!update) return null;
  const dropped = bundle.edges.filter((e) => (kind === "end" && e.from_step_id === id) || (kind === "start" && e.to_step_id === id));
  // Rework only goes back to working steps.
  const refs: RowChange[] =
    kind === "start" || kind === "end"
      ? bundle.steps
          .filter((s) => s.rework_to_step_id === id)
          .map((s) => ({ table: "steps", id: s.id, before: { rework_to_step_id: id }, after: { rework_to_step_id: null } }))
      : [];
  return {
    label: `Made ${step.name} ${kind === "start" ? "the start step" : `${kind === "end" ? "an" : "a"} ${KIND_LABELS[kind].toLowerCase()} step`}`,
    ops: [
      { kind: "update", changes: [...(update.ops[0] as Extract<Op, { kind: "update" }>).changes, ...refs] },
      ...(dropped.length ? [{ kind: "remove" as const, steps: [], edges: dropped }] : []),
    ],
  };
}

/** Send a step's rework back to another working step, or (null) repeat the step itself. */
export function setReworkTarget(bundle: ProcessBundle, id: string, target: string | null): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step) return null;
  if (target !== null && !reworkTargets(bundle, id).some((s) => s.id === target)) return null;
  const edit = updateStep(bundle, id, { rework_to_step_id: target });
  const label = target ? `Sent ${step.name}'s rework back to ${stepName(bundle, target)}` : `Made ${step.name}'s rework repeat the step`;
  return edit && { ...edit, label };
}

/** Steps a step's rework can go back to: any other working step, by name. */
export function reworkTargets(bundle: ProcessBundle, id: string): StepRow[] {
  return bundle.steps
    .filter((s) => s.id !== id && s.kind !== "start" && s.kind !== "end")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Pin a step to one person, or (null) let anyone in its role work it. */
export function pinPerson(bundle: ProcessBundle, id: string, personId: string | null): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  const person = personId === null ? null : bundle.people.find((p) => p.id === personId);
  if (!step || person === undefined) return null;
  const edit = updateStep(bundle, id, { person_id: personId });
  return edit && { ...edit, label: person ? `Pinned ${step.name} to ${person.name}` : `Unpinned ${step.name}` };
}

export type Phase = "work" | "wait";

/** Switch a duration's distribution; a new triangular range is centred on the current mean. */
export function setDistribution(bundle: ProcessBundle, id: string, phase: Phase, dist: StepRow["work_dist"]): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step) return null;
  const patch: Patch = { [`${phase}_dist`]: dist };
  if (dist === "triangular") {
    const range = triangularRange(step[`${phase}_params`], Number(step[`${phase}_hours`]));
    patch[`${phase}_params.min`] = round(range.min);
    patch[`${phase}_params.mode`] = round(range.mode);
    patch[`${phase}_params.max`] = round(range.max);
    patch[`${phase}_hours`] = round((range.min + range.mode + range.max) / 3);
  }
  return updateStep(bundle, id, patch);
}

/**
 * Set one point of a triangular range, moving the others as needed to keep
 * min ≤ most likely ≤ max. The mean (`*_hours`) follows, since the engine
 * samples the range and the canvas shows the mean.
 */
export function setRangePoint(
  bundle: ProcessBundle,
  id: string,
  phase: Phase,
  point: "min" | "mode" | "max",
  value: number,
): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step || !(value >= 0)) return null;
  const range = { ...triangularRange(step[`${phase}_params`], Number(step[`${phase}_hours`])), [point]: value };
  if (point === "min") {
    range.mode = Math.max(range.mode, value);
    range.max = Math.max(range.max, range.mode);
  } else if (point === "max") {
    range.mode = Math.min(range.mode, value);
    range.min = Math.min(range.min, range.mode);
  } else {
    range.min = Math.min(range.min, value);
    range.max = Math.max(range.max, value);
  }
  return updateStep(bundle, id, {
    [`${phase}_params.min`]: round(range.min),
    [`${phase}_params.mode`]: round(range.mode),
    [`${phase}_params.max`]: round(range.max),
    [`${phase}_hours`]: round((range.min + range.mode + range.max) / 3),
  });
}

/**
 * Set a duration's mean, as the node's inline editor does. A triangular range
 * is scaled to the new mean (keeping its shape), since the engine samples the
 * range rather than the mean.
 */
export function setMeanHours(bundle: ProcessBundle, id: string, phase: Phase, hours: number): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step || !(hours >= 0) || !Number.isFinite(hours)) return null;
  if (step[`${phase}_dist`] !== "triangular") return updateStep(bundle, id, { [`${phase}_hours`]: round(hours) });
  const range = triangularRange(step[`${phase}_params`], Number(step[`${phase}_hours`]));
  const mean = (range.min + range.mode + range.max) / 3;
  const scale = (v: number) => round(mean > 0 ? (v * hours) / mean : hours);
  const [min, mode, max] = [scale(range.min), scale(range.mode), scale(range.max)];
  return updateStep(bundle, id, {
    [`${phase}_params.min`]: min,
    [`${phase}_params.mode`]: mode,
    [`${phase}_params.max`]: max,
    [`${phase}_hours`]: round((min + mode + max) / 3),
  });
}

/**
 * Steps as copied, with the connections among them: what paste and duplicate
 * work from. A snapshot, so pasting still works after the originals change.
 */
export interface StepClipboard {
  steps: StepRow[];
  edges: EdgeRow[];
}

/** How far each paste or duplicate lands from what it copies. */
export const PASTE_OFFSET = 40;

/**
 * Copy steps and the connections between them. The start step is left out: a
 * process has exactly one.
 */
export function copySteps(bundle: ProcessBundle, ids: readonly string[]): StepClipboard | null {
  const wanted = new Set(ids);
  // Copying a group copies the steps inside it.
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  for (const s of bundle.steps) if (ancestorsOf(s.id, byId).some((g) => wanted.has(g))) wanted.add(s.id);
  // A process is on the company map once.
  if (bundle.steps.some((s) => wanted.has(s.id) && isPlacedStep(bundle, s))) return null;
  const steps = bundle.steps.filter((s) => wanted.has(s.id) && s.kind !== "start");
  if (!steps.length) return null;
  const kept = new Set(steps.map((s) => s.id));
  const edges = bundle.edges.filter((e) => kept.has(e.from_step_id) && kept.has(e.to_step_id));
  return structuredClone({ steps, edges });
}

const COPY_SUFFIX = " (copy)";

/**
 * Paste copied steps as new steps, `offset` away. Every pasted step and edge
 * gets a new id; existing rows are untouched. Connections among the copied
 * steps are copied and point at the new steps; connections to steps that
 * weren't copied are not. A rework target among the copied steps points at its
 * copy; one outside them is kept if that step still exists.
 */
export function pasteSteps(
  bundle: ProcessBundle,
  clip: StepClipboard,
  offset: { x: number; y: number },
  verb: "Pasted" | "Duplicated" = "Pasted",
): { edit: Edit; ids: string[] } | null {
  if (!clip.steps.length) return null;
  const { revision } = bundle;
  const owner = { revision_id: revision.id, workspace_id: revision.workspace_id, process_id: revision.process_id };
  const newIds = new Map(clip.steps.map((s) => [s.id, newId()]));
  const existing = new Set(bundle.steps.map((s) => s.id));
  const steps = clip.steps.map((s): StepRow => {
    // A copy replaces nothing (PRD §4.1, stable ids); the rest of the row is copied as is.
    const row: StepRow & { replaced_by?: unknown } = { ...s };
    delete row.replaced_by;
    const rework = s.rework_to_step_id;
    // Steps copied with their group sit in the copy of it, where they were; one copied alone stays in its group, if that is still there.
    const parent = s.parent_step_id;
    const inCopy = parent !== null && newIds.has(parent);
    return {
      ...row,
      ...owner,
      parent_step_id: parent === null ? null : (newIds.get(parent) ?? (existing.has(parent) ? parent : null)),
      entry_step_id: s.entry_step_id === null ? null : (newIds.get(s.entry_step_id) ?? null),
      // A child process sits in one step only: a copy of the holder is a plain sub-process step.
      child_process_id: null,
      id: newIds.get(s.id)!,
      name: s.name.endsWith(COPY_SUFFIX) ? s.name : `${s.name.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`,
      work_params: { ...s.work_params },
      wait_params: { ...s.wait_params },
      rework_to_step_id: rework === null ? null : (newIds.get(rework) ?? (existing.has(rework) ? rework : null)),
      // Nothing is sitting at a step that didn't exist a moment ago.
      current_wip: null,
      x: Math.round(Number(s.x) + (inCopy ? 0 : offset.x)),
      y: Math.round(Number(s.y) + (inCopy ? 0 : offset.y)),
    };
  });
  const edges = clip.edges
    .filter((e) => newIds.has(e.from_step_id) && newIds.has(e.to_step_id))
    .map((e): EdgeRow => ({
      ...e,
      ...owner,
      id: newId(),
      from_step_id: newIds.get(e.from_step_id)!,
      to_step_id: newIds.get(e.to_step_id)!,
    }));
  const label = steps.length === 1 ? `${verb} ${clip.steps[0]!.name}` : `${verb} ${steps.length} steps`;
  return { edit: { label, ops: [{ kind: "insert", steps, edges }] }, ids: steps.map((s) => s.id) };
}

/** Duplicate steps (and the connections among them) next to the originals. */
export function duplicateSteps(bundle: ProcessBundle, ids: readonly string[]): { edit: Edit; ids: string[] } | null {
  const clip = copySteps(bundle, ids);
  return clip && pasteSteps(bundle, clip, { x: PASTE_OFFSET, y: PASTE_OFFSET }, "Duplicated");
}

/** Why an edge from `from` to `to` isn't allowed, or null if it is. `except` is an edge being rerouted. */
export function connectionProblem(bundle: ProcessBundle, from: string, to: string, except?: string): string | null {
  const source = bundle.steps.find((s) => s.id === from);
  const target = bundle.steps.find((s) => s.id === to);
  if (!source || !target) return "Connect two steps.";
  if (from === to) return "A step can't lead to itself; use its rework rate instead.";
  if (source.kind === "end") return "End steps can't lead anywhere.";
  if (target.kind === "start") return "Nothing can lead into the start step.";
  if (bundle.edges.some((e) => e.id !== except && e.from_step_id === from && e.to_step_id === to)) {
    return "Those steps are already connected.";
  }
  return null;
}

/** Sum of a step's outgoing branch probabilities. */
export function outgoingTotal(bundle: ProcessBundle, stepId: string): number {
  return bundle.edges.filter((e) => e.from_step_id === stepId).reduce((sum, e) => sum + Number(e.probability), 0);
}

/** Connect two steps. The new branch takes whatever share the step's other branches leave. */
export function addEdge(bundle: ProcessBundle, from: string, to: string): { edit: Edit; id: string } | null {
  if (connectionProblem(bundle, from, to)) return null;
  const { revision } = bundle;
  // A handoff line on the company map is a picture, not a branch: it has no share to divide.
  const handoff = bundle.process.is_company === true;
  const edge: EdgeRow = {
    id: newId(),
    revision_id: revision.id,
    workspace_id: revision.workspace_id,
    process_id: revision.process_id,
    from_step_id: from,
    to_step_id: to,
    probability: handoff ? 1 : Math.max(0, round(1 - outgoingTotal(bundle, from))),
    condition_tag: null,
    label: null,
  };
  const label = `Connected ${stepName(bundle, from)} to ${stepName(bundle, to)}`;
  return { edit: { label, ops: [{ kind: "insert", steps: [], edges: [edge] }] }, id: edge.id };
}

export function updateEdge(bundle: ProcessBundle, id: string, patch: Patch): Edit | null {
  const edge = bundle.edges.find((e) => e.id === id);
  if (!edge) return null;
  return updateRow(bundle, "edges", id, patch, `Changed ${stepName(bundle, edge.from_step_id)} → ${stepName(bundle, edge.to_step_id)}`);
}

/** Move an edge's ends. Its id, probability and tag stay. */
export function reconnectEdge(bundle: ProcessBundle, id: string, from: string, to: string): Edit | null {
  if (connectionProblem(bundle, from, to, id)) return null;
  const edit = updateEdge(bundle, id, { from_step_id: from, to_step_id: to });
  return edit && { ...edit, label: `Rerouted to ${stepName(bundle, to)}` };
}

export function deleteEdges(bundle: ProcessBundle, ids: readonly string[]): Edit | null {
  const gone = new Set(ids);
  const edges = bundle.edges.filter((e) => gone.has(e.id));
  if (!edges.length) return null;
  const [first] = edges;
  const label =
    edges.length === 1
      ? `Removed ${stepName(bundle, first!.from_step_id)} → ${stepName(bundle, first!.to_step_id)}`
      : `Removed ${edges.length} connections`;
  return { label, ops: [{ kind: "remove", steps: [], edges }] };
}

/** Delete what is selected: steps (with their edges) and edges, as one edit. */
export function deleteSelection(bundle: ProcessBundle, stepIds: readonly string[], edgeIds: readonly string[]): Edit | null {
  const steps = deleteSteps(bundle, stepIds);
  const covered = new Set(steps?.ops.flatMap((op) => (op.kind === "remove" ? op.edges.map((e) => e.id) : [])) ?? []);
  const edges = deleteEdges(bundle, edgeIds.filter((id) => !covered.has(id)));
  if (!steps || !edges) return steps ?? edges;
  return { label: steps.label, ops: [...steps.ops, ...edges.ops] };
}

/**
 * Problems to flag on each step, by step id: no way out, or branches not
 * adding up to 100% (the start step's one edge is followed whatever its share).
 */
export function stepWarnings(bundle: ProcessBundle): Map<string, string> {
  const out = new Map<string, string>();
  for (const step of bundle.steps) {
    if (step.kind === "end") continue;
    const outgoing = bundle.edges.filter((e) => e.from_step_id === step.id);
    if (!outgoing.length) {
      // Inside a group, the step the group ends at leaves through the group's own connections: flag it if no group it is in has one.
      if (step.parent_step_id) {
        if (!groupsLetOut(bundle.steps, bundle.edges, step.id) && step.kind !== "group") {
          out.set(step.id, "Nothing leaves this step, and no group it is in has a connection out. Connect the step, or connect its group.");
        }
        continue;
      }
      // A group can be left from a step inside it, so it needs no connection of its own then.
      if (step.kind === "group" && groupHasExit(bundle.steps, bundle.edges, step.id)) continue;
      out.set(step.id, step.kind === "group" ? "Nothing leaves this group yet. Drag from its right edge to connect it." : "Nothing leaves this step yet. Drag from its right edge to connect it.");
      continue;
    }
    if (step.kind === "start") continue;
    const total = outgoingTotal(bundle, step.id);
    if (Math.abs(total - 1) > TOLERANCE) {
      out.set(step.id, `Branches add up to ${Math.round(total * 1000) / 10}%, not 100%.`);
    }
  }
  return out;
}
