// Process edits as data (issue #8). Every canvas and inspector edit is a list
// of operations, each with an exact inverse, so undo is just "apply the
// inverse" and is saved like any other edit. Framework-free and pure: the
// editor applies these to its local copy of the bundle, and a ProcessStore
// saves them.

import { partitionSteps, type EdgeRow, type ProcessBundle, type StepRow, type StepSplit, type StepSplitNotes, type TierMultiplier } from "@transpera-flow/db";
import type { Provenance } from "./provenance";

/** A value one field can hold. */
export type Scalar = string | number | boolean | null;

/** The step columns that hold a whole JSON object as one value (capacity P4): saved and undone as one, so a split never sums to anything but 100%. */
export type BaseValue = StepSplit | StepSplitNotes | TierMultiplier;

/** A field's value: a scalar, a provenance entry (`provenance.<column>`, see ./provenance.ts), or a whole base-value object. */
export type Value = Scalar | Provenance | BaseValue;

/**
 * Field values by name. A name is a column, or `column.key` for one key of a
 * jsonb column (e.g. `work_params.cv`), the same convention `save_fields` uses.
 */
export type Patch = Record<string, Value>;

export type Table = "steps" | "edges";

/** One row's fields going from `before` (what the editor showed) to `after`. */
export interface RowChange {
  table: Table;
  id: string;
  before: Patch;
  after: Patch;
}

export type Op =
  | { kind: "insert"; steps: StepRow[]; edges: EdgeRow[] }
  | { kind: "remove"; steps: StepRow[]; edges: EdgeRow[] }
  | { kind: "update"; changes: RowChange[] };

/** One user action: what undo and redo step over. */
export interface Edit {
  /** Past tense, for the undo button's title ("Moved Qualify lead"). */
  label: string;
  ops: Op[];
}

/** One unit of saving: an insert, a remove, or one row's fields. */
export type SaveUnit = Exclude<Op, { kind: "update" }> | { kind: "update"; change: RowChange };

export function saveUnits(edit: Edit): SaveUnit[] {
  return edit.ops.flatMap((op): SaveUnit[] => (op.kind === "update" ? op.changes.map((change) => ({ kind: "update", change })) : [op]));
}

export const unitOp = (u: SaveUnit): Op => (u.kind === "update" ? { kind: "update", changes: [u.change] } : u);

export function invertOp(op: Op): Op {
  switch (op.kind) {
    case "insert":
      return { kind: "remove", steps: op.steps, edges: op.edges };
    case "remove":
      return { kind: "insert", steps: op.steps, edges: op.edges };
    case "update":
      return {
        kind: "update",
        changes: [...op.changes].reverse().map((c) => ({ ...c, before: c.after, after: c.before })),
      };
  }
}

export function invertEdit(edit: Edit): Edit {
  return { label: edit.label, ops: [...edit.ops].reverse().map(invertOp) };
}

/** Read a field (`column` or `column.key`) from a row. */
export function readField(row: object, field: string): Value {
  const [col, sub] = splitField(field);
  const value = (row as Record<string, unknown>)[col];
  if (sub === undefined) return (value ?? null) as Value;
  return value && typeof value === "object" ? (((value as Record<string, unknown>)[sub] ?? null) as Value) : null;
}

/** A copy of `row` with the patch applied. */
export function writeFields<T extends object>(row: T, patch: Patch): T {
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [field, value] of Object.entries(patch)) {
    const [col, sub] = splitField(field);
    if (sub === undefined) next[col] = value;
    else {
      const current = next[col];
      next[col] = { ...(current && typeof current === "object" ? current : {}), [sub]: value };
    }
  }
  return next as T;
}

function splitField(field: string): [string, string | undefined] {
  const dot = field.indexOf(".");
  return dot < 0 ? [field, undefined] : [field.slice(0, dot), field.slice(dot + 1)];
}

/** The current values of `fields` on a row, as a patch. */
export function pick(row: object, fields: Iterable<string>): Patch {
  const out: Patch = {};
  for (const f of fields) out[f] = readField(row, f);
  return out;
}

/**
 * Apply one operation. Tolerant by design: inserting a row that exists,
 * removing or updating one that is gone, leaves things as they are. That only
 * happens when a failed save is rolled back after later edits touched the same
 * rows, and then doing nothing is right.
 */
export function applyOp(bundle: ProcessBundle, op: Op): ProcessBundle {
  switch (op.kind) {
    case "insert": {
      const stepIds = new Set([...bundle.steps, ...(bundle.retired ?? [])].map((s) => s.id));
      const edgeIds = new Set(bundle.edges.map((e) => e.id));
      // A split or replaced step's row (with replaced_by) is kept apart: never drawn or simulated (issue #16).
      const added = partitionSteps(op.steps.filter((s) => !stepIds.has(s.id)));
      return {
        ...bundle,
        steps: [...bundle.steps, ...added.steps],
        ...(added.retired.length ? { retired: [...(bundle.retired ?? []), ...added.retired] } : {}),
        edges: [...bundle.edges, ...op.edges.filter((e) => !edgeIds.has(e.id))],
      };
    }
    case "remove": {
      const stepIds = new Set(op.steps.map((s) => s.id));
      const edgeIds = new Set(op.edges.map((e) => e.id));
      return {
        ...bundle,
        steps: bundle.steps.filter((s) => !stepIds.has(s.id)),
        ...(bundle.retired?.some((s) => stepIds.has(s.id)) ? { retired: bundle.retired.filter((s) => !stepIds.has(s.id)) } : {}),
        // Edges of removed steps go too, as the database's cascade does.
        edges: bundle.edges.filter((e) => !edgeIds.has(e.id) && !stepIds.has(e.from_step_id) && !stepIds.has(e.to_step_id)),
      };
    }
    case "update": {
      let { steps, edges } = bundle;
      for (const c of op.changes) {
        if (c.table === "steps") steps = steps.map((s) => (s.id === c.id ? writeFields(s, c.after) : s));
        else edges = edges.map((e) => (e.id === c.id ? writeFields(e, c.after) : e));
      }
      return { ...bundle, steps, edges };
    }
  }
}

export function applyEdit(bundle: ProcessBundle, edit: Edit): ProcessBundle {
  return edit.ops.reduce(applyOp, bundle);
}
