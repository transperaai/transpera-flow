// Input checks for the process editor's Server Actions. Pure, so they can be
// unit tested. They only reject malformed input early: every write still runs
// as the signed-in user through RLS and the tables' check constraints.

import { STEP_PURPOSE_KEY, STEP_SOURCE_LABELS, type EdgeRow, type StepRow } from "@transpera-flow/db";
import type { Patch, Scalar, Table, Value } from "./ops";
import { PROVENANCE_COLUMNS, isProvenanceField } from "./provenance";

type Check = (v: unknown) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const optionalId: Check = (v) => v === null || isId(v);
const text = (max: number): Check => (v) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optionalText = (max: number): Check => (v) => v === null || (typeof v === "string" && v.length <= max);
const number: Check = (v) => typeof v === "number" && Number.isFinite(v);
const atLeast0: Check = (v) => number(v) && (v as number) >= 0;
const optionalAtLeast0: Check = (v) => v === null || atLeast0(v);
const optionalShare: Check = (v) => v === null || share(v);
// Bounds match the database's checks (migration 20261110000000).
const optionalUpTo = (max: number): Check => (v) => v === null || (atLeast0(v) && (v as number) <= max);
const optionalPositiveUpTo = (max: number): Check => (v) => v === null || (number(v) && (v as number) > 0 && (v as number) <= max);
const share: Check = (v) => number(v) && (v as number) >= 0 && (v as number) <= 1;
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v);
const optionalCount: Check = (v) => v === null || (Number.isInteger(v) && (v as number) >= 0);
const coordinate: Check = (v) => number(v) && Math.abs(v as number) <= 1e6;

const DIST = oneOf("constant", "triangular", "lognormal");

/**
 * One value's provenance entry (docs/PRD.md §5), or null: undo can restore
 * whatever entry the value had, so any source is accepted, with a valid date
 * and user if given.
 */
const optionalProvenance: Check = (v) =>
  v === null ||
  (isObject(v) &&
    oneOf("estimated", "entered", "measured", ...STEP_SOURCE_LABELS)(v.source) &&
    (v.at === undefined || (typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)))) &&
    (v.by === undefined || isId(v.by)) &&
    JSON.stringify(v).length <= 20_000);

/** The tolerance the database's `steps_split` check uses. */
const SPLIT_TOLERANCE = 0.001;
const SPLIT_PARTS = ["automatable", "augmentable", "manual"] as const;

/** A work split: the three shares from 0 to 1 and no other key, adding up to 1 (as `steps_split` checks). */
const optionalSplit: Check = (v) =>
  v === null ||
  (isObject(v) &&
    Object.keys(v).length === 3 &&
    SPLIT_PARTS.every((p) => share(v[p])) &&
    Math.abs(SPLIT_PARTS.reduce((n, p) => n + (v[p] as number), 0) - 1) <= SPLIT_TOLERANCE);

/** One line of words for each part of the split, up to 300 characters (as `steps_split_notes` checks). */
const optionalSplitNotes: Check = (v) =>
  v === null ||
  (isObject(v) && Object.entries(v).every(([k, line]) => (SPLIT_PARTS as readonly string[]).includes(k) && typeof line === "string" && line.length <= 300 && !/[\r\n]/.test(line)));

/** A number of 0 to 100 for each tier key (as `steps_tier_multiplier` checks). */
const optionalTierMultiplier: Check = (v) =>
  v === null ||
  (isObject(v) &&
    Object.keys(v).length <= 50 &&
    Object.entries(v).every(([tier, m]) => tier.trim().length >= 1 && tier.length <= 40 && number(m) && (m as number) >= 0 && (m as number) <= 100));

/** Step values that carry a source label (capacity P4): the editor saves it as `provenance.<value>`. */
export const SOURCE_LABEL_COLUMNS = ["work", "split", "tier_multiplier"] as const;

/** Step fields the editor saves, and what each accepts. `*_params.key` are keys of the jsonb params. */
export const STEP_FIELDS = {
  name: text(200),
  kind: oneOf("task", "wait", "decision", "subprocess", "group", "start", "end"),
  outcome: (v) => v === null || oneOf("won", "lost", "done")(v),
  role_id: optionalId,
  person_id: optionalId,
  work_hours: atLeast0,
  work_dist: DIST,
  "work_params.cv": optionalAtLeast0,
  "work_params.min": optionalAtLeast0,
  "work_params.mode": optionalAtLeast0,
  "work_params.max": optionalAtLeast0,
  wait_hours: atLeast0,
  wait_dist: DIST,
  "wait_params.cv": optionalAtLeast0,
  "wait_params.min": optionalAtLeast0,
  "wait_params.mode": optionalAtLeast0,
  "wait_params.max": optionalAtLeast0,
  rework_rate: share,
  rework_to_step_id: optionalId,
  // Nesting (issue #102): the group a step sits in, a group's first step, the child process a step holds.
  parent_step_id: optionalId,
  entry_step_id: optionalId,
  child_process_id: optionalId,
  tool: optionalText(200),
  // What the step achieves (sandbox phase 4): null (Automatic) or a category key, as the database's steps_purpose_key allows.
  purpose: (v) => v === null || (typeof v === "string" && STEP_PURPOSE_KEY.test(v)),
  // Base values for capacity (P4): whole objects, saved as one so the split always adds up to 100%.
  split: optionalSplit,
  split_notes: optionalSplitNotes,
  tier_multiplier: optionalTierMultiplier,
  to_client_manager: (v) => typeof v === "boolean",
  notes: optionalText(4000),
  sla_hours: optionalAtLeast0,
  // The analysis rules' per-step settings (docs/analysis-rules.md rules 5, 12, 13).
  expected_wait_hours: optionalUpTo(10_000),
  lost_per_day_waiting: optionalShare,
  dropoff_benchmark: optionalShare,
  target_cycle_hours: optionalPositiveUpTo(100_000),
  current_wip: optionalCount,
  x: coordinate,
  y: coordinate,
  // Confirming an estimate clears it (issue #9).
  assumption: (v) => typeof v === "boolean",
  // Citing sources that disagree flags a conflict; settling it clears it (issue #21).
  conflict: (v) => typeof v === "boolean",
  ...Object.fromEntries([...PROVENANCE_COLUMNS, ...SOURCE_LABEL_COLUMNS].map((col) => [`provenance.${col}`, optionalProvenance])),
} as const satisfies Record<string, Check>;

export const EDGE_FIELDS = {
  from_step_id: isId,
  to_step_id: isId,
  probability: share,
  condition_tag: optionalText(100),
  label: optionalText(200),
} as const satisfies Record<string, Check>;

const FIELDS: Record<Table, Record<string, Check>> = { steps: STEP_FIELDS, edges: EDGE_FIELDS };

const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);
/** Columns whose value is a whole object: a base for them is an object (or null). */
const OBJECT_COLUMNS = new Set(["split", "split_notes", "tier_multiplier"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A field update's base and changes, if well formed: known fields only, a base
 * for each change, valid new values. Text is trimmed, blank optional text is null.
 */
export function parseFieldUpdate(table: unknown, base: unknown, changes: unknown): { table: Table; base: Patch; changes: Patch } | null {
  if (table !== "steps" && table !== "edges") return null;
  if (!isObject(base) || !isObject(changes)) return null;
  const fields = Object.keys(changes);
  if (!fields.length || fields.length > 20) return null;
  const outBase: Patch = {};
  const outChanges: Patch = {};
  for (const field of fields) {
    const check = Object.hasOwn(FIELDS[table], field) ? FIELDS[table][field] : undefined;
    const raw = changes[field];
    const value = typeof raw === "string" ? raw.trim() || (field === "name" ? "" : null) : raw;
    const baseOk = isProvenanceField(field) ? optionalProvenance(base[field]) : OBJECT_COLUMNS.has(field) ? base[field] === null || isObject(base[field]) : isScalar(base[field]);
    if (!check || !Object.hasOwn(base, field) || !baseOk || !check(value)) return null;
    outBase[field] = base[field] as Value;
    outChanges[field] = value as Value;
  }
  // End steps, and only end steps, have an outcome (the table's check constraint).
  if ("kind" in outChanges && "outcome" in outChanges && (outChanges.kind === "end") !== (outChanges.outcome !== null)) return null;
  return { table, base: outBase, changes: outChanges };
}

/** Columns a new step is inserted with; the server adds revision, workspace and process. */
export type NewStep = Omit<StepRow, "revision_id" | "workspace_id" | "process_id">;
export type NewEdge = Omit<EdgeRow, "revision_id" | "workspace_id" | "process_id">;

const DIST_PARAM_KEYS = ["cv", "min", "mode", "max"];

function params(v: unknown): StepRow["work_params"] | null {
  if (!isObject(v)) return null;
  const out: StepRow["work_params"] = {};
  for (const [k, value] of Object.entries(v)) {
    if (!DIST_PARAM_KEYS.includes(k) || !optionalAtLeast0(value)) return null;
    out[k as keyof StepRow["work_params"]] = value as number | null;
  }
  return out;
}

/** A step to insert (new, or restored by undo), if every column is valid. */
export function parseNewStep(v: unknown): NewStep | null {
  if (!isObject(v) || !isId(v.id)) return null;
  const out: Record<string, unknown> = { id: v.id };
  for (const [field, check] of Object.entries(STEP_FIELDS)) {
    // Params keys come with their column; the flags with the restored columns below.
    if (field.includes(".") || field === "assumption" || field === "conflict" || field === "to_client_manager") continue;
    const value = v[field] === undefined ? null : v[field];
    if (!check(value)) return null;
    out[field] = typeof value === "string" && field !== "name" ? value.trim() || null : value;
  }
  const work = params(v.work_params ?? {});
  const wait = params(v.wait_params ?? {});
  if (!work || !wait) return null;
  if ((out.kind === "end") !== (out.outcome !== null)) return null;
  const kept = restoredColumns(v);
  if (!kept) return null;
  return { ...out, ...kept, work_params: work, wait_params: wait } as NewStep;
}

/**
 * Columns the editor doesn't edit but a step restored by undo must keep
 * (they come from the loaded row). Absent on new steps, which get the defaults.
 */
function restoredColumns(v: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (v.cost_override !== undefined) {
    if (!(v.cost_override === null || number(v.cost_override))) return null;
    out.cost_override = v.cost_override;
  }
  for (const flag of ["assumption", "conflict"] as const) {
    if (v[flag] === undefined) continue;
    if (typeof v[flag] !== "boolean") return null;
    out[flag] = v[flag];
  }
  if (v.to_client_manager !== undefined) {
    if (typeof v.to_client_manager !== "boolean") return null;
    out.to_client_manager = v.to_client_manager;
  }
  if (v.replaced_by !== undefined) {
    if (!Array.isArray(v.replaced_by) || v.replaced_by.length > 100 || !v.replaced_by.every(isId)) return null;
    out.replaced_by = v.replaced_by;
  }
  if (v.provenance !== undefined) {
    if (!isObject(v.provenance) || JSON.stringify(v.provenance).length > 20_000) return null;
    out.provenance = v.provenance;
  }
  return out;
}

export function parseNewEdge(v: unknown): NewEdge | null {
  if (!isObject(v) || !isId(v.id)) return null;
  const out: Record<string, unknown> = { id: v.id };
  for (const [field, check] of Object.entries(EDGE_FIELDS)) {
    const value = v[field] === undefined ? null : v[field];
    if (!check(value)) return null;
    out[field] = typeof value === "string" && !field.endsWith("_id") ? value.trim() || null : value;
  }
  if (out.from_step_id === out.to_step_id) return null;
  return out as NewEdge;
}

/** Ids to delete, if they are all ids and not too many. */
export function parseIds(v: unknown, max = 500): string[] | null {
  return Array.isArray(v) && v.length <= max && v.every(isId) ? [...new Set(v)] : null;
}
