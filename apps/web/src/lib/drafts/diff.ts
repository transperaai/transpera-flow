// A draft compared with the live revision it was copied from (issue #9, PRD
// §7.1b). Step and edge ids are stable across revisions, so rows are matched
// by id: in the draft only (added), in live only (removed), in both with
// different values (changed). Pure, so the canvas, the changes list, the
// inspector and the tests all read the same answer.

import type { EdgeRow, ProcessBundle, StepRow } from "@transpera-flow/db";
import { sameScalar } from "@/lib/editor/commands";
import { readField, type Table, type Value } from "@/lib/editor/ops";
import { isProvenanceField } from "@/lib/editor/provenance";
import { EDGE_FIELDS, STEP_FIELDS } from "@/lib/editor/validate";

export type ChangeKind = "added" | "removed" | "changed";

/** One field going from its live value to its draft value. */
export interface FieldChange {
  field: string;
  live: Value;
  draft: Value;
}

interface RowChange<Row> {
  kind: ChangeKind;
  id: string;
  /** The live row; null when added. */
  live: Row | null;
  /** The draft row; null when removed. */
  draft: Row | null;
  /** Changed fields (not position), for a changed row. */
  fields: FieldChange[];
}

export interface StepChange extends RowChange<StepRow> {
  table: "steps";
  /** Only its position changed, or its position changed too. */
  moved: boolean;
}

export interface EdgeChange extends RowChange<EdgeRow> {
  table: "edges";
}

export type Change = StepChange | EdgeChange;

export interface DraftDiff {
  steps: Map<string, StepChange>;
  edges: Map<string, EdgeChange>;
  /** Every change, steps first, in a stable order (added, changed, removed; then by name). */
  list: Change[];
}

/**
 * Fields compared on steps: what the editor edits, apart from position and
 * provenance (a value's provenance goes with the value, lib/editor/provenance.ts).
 */
export const STEP_DIFF_FIELDS = Object.keys(STEP_FIELDS).filter((f) => f !== "x" && f !== "y" && !isProvenanceField(f));
export const EDGE_DIFF_FIELDS = Object.keys(EDGE_FIELDS);

function changedFields(live: object, draft: object, fields: readonly string[]): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of fields) {
    const a = readField(live, field);
    const b = readField(draft, field);
    // Blank text and a missing value are the same thing to the user.
    if (sameScalar(a, b) || ((a === null || a === "") && (b === null || b === ""))) continue;
    out.push({ field, live: a, draft: b });
  }
  return out;
}

const ORDER: Record<ChangeKind, number> = { added: 0, changed: 1, removed: 2 };

export function diffBundles(live: Pick<ProcessBundle, "steps" | "edges">, draft: Pick<ProcessBundle, "steps" | "edges">): DraftDiff {
  const steps = new Map<string, StepChange>();
  const edges = new Map<string, EdgeChange>();
  const liveSteps = new Map(live.steps.map((s) => [s.id, s]));
  const draftSteps = new Map(draft.steps.map((s) => [s.id, s]));
  for (const d of draft.steps) {
    const l = liveSteps.get(d.id);
    if (!l) {
      steps.set(d.id, { table: "steps", kind: "added", id: d.id, live: null, draft: d, fields: [], moved: false });
      continue;
    }
    const fields = changedFields(l, d, STEP_DIFF_FIELDS);
    const moved = Number(l.x) !== Number(d.x) || Number(l.y) !== Number(d.y);
    if (fields.length || moved) steps.set(d.id, { table: "steps", kind: "changed", id: d.id, live: l, draft: d, fields, moved });
  }
  for (const l of live.steps) {
    if (!draftSteps.has(l.id)) steps.set(l.id, { table: "steps", kind: "removed", id: l.id, live: l, draft: null, fields: [], moved: false });
  }

  const liveEdges = new Map(live.edges.map((e) => [e.id, e]));
  const draftEdges = new Set(draft.edges.map((e) => e.id));
  for (const d of draft.edges) {
    const l = liveEdges.get(d.id);
    if (!l) {
      edges.set(d.id, { table: "edges", kind: "added", id: d.id, live: null, draft: d, fields: [] });
      continue;
    }
    const fields = changedFields(l, d, EDGE_DIFF_FIELDS);
    if (fields.length) edges.set(d.id, { table: "edges", kind: "changed", id: d.id, live: l, draft: d, fields });
  }
  for (const l of live.edges) {
    if (!draftEdges.has(l.id)) edges.set(l.id, { table: "edges", kind: "removed", id: l.id, live: l, draft: null, fields: [] });
  }

  const names = new Map([...live.steps, ...draft.steps].map((s) => [s.id, s.name]));
  const stepName = (c: StepChange) => (c.draft ?? c.live)!.name;
  const edgeName = (c: EdgeChange) => {
    const e = (c.draft ?? c.live)!;
    return `${names.get(e.from_step_id) ?? ""} ${names.get(e.to_step_id) ?? ""}`;
  };
  const byKind = <T extends Change>(name: (c: T) => string) => (a: T, b: T) =>
    ORDER[a.kind] - ORDER[b.kind] || name(a).localeCompare(name(b)) || a.id.localeCompare(b.id);
  const list: Change[] = [
    ...[...steps.values()].sort(byKind(stepName)),
    ...[...edges.values()].sort(byKind(edgeName)),
  ];
  return { steps, edges, list };
}

export const EMPTY_DIFF: DraftDiff = { steps: new Map(), edges: new Map(), list: [] };

/** The change to one row, if any. */
export function changeOf(diff: DraftDiff, table: Table, id: string): Change | undefined {
  return table === "steps" ? diff.steps.get(id) : diff.edges.get(id);
}

/** A field's live value, when the draft changed it. */
export function liveValue(diff: DraftDiff, table: Table, id: string, field: string): { value: Value } | null {
  const change = changeOf(diff, table, id);
  const f = change?.kind === "changed" ? change.fields.find((c) => c.field === field) : undefined;
  return f ? { value: f.live } : null;
}

/**
 * Steps publishing would refuse without "accept as estimates": unconfirmed
 * estimates and unresolved conflicts, as publish_process checks them.
 */
export function unresolvedSteps(bundle: Pick<ProcessBundle, "steps">): StepRow[] {
  return bundle.steps
    .filter((s) => s.assumption || (s as { conflict?: boolean }).conflict === true)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What Publish and Discard count: the steps and edges that differ from live.
 */
export const publishableChanges = (diff: Pick<DraftDiff, "list">): number => diff.list.length;
