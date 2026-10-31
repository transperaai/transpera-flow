// Where a step's parameters came from (docs/PRD.md §3 "Parameter provenance",
// §5 `provenance jsonb`). A step's `provenance` holds one entry per value
// column: `{current_wip: {source: "entered", at, by}, ...}`. When a person
// changes a parameter in the editor, the same edit (and so the same per-field
// save and the same undo step) records it as `entered` through the
// `provenance.<column>` key. A value with no entry is an estimate.

import { EVIDENCE_COLUMNS, isOpenAssumption, openConflict, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { readField, type Edit, type Patch, type RowChange } from "./ops";

export type ProvenanceSource = "estimated" | "entered" | "measured";

/** One value's provenance (the §5 shape). A type alias so it stays a plain JSON object. */
export type Provenance = {
  source: ProvenanceSource | "interview" | "calculator" | "estimate";
  /** When it was set (ISO timestamp). */
  at?: string;
  /** User who set it. */
  by?: string;
  [key: string]: unknown;
};

/** Step columns that are simulation parameters, and so carry provenance. */
export const PROVENANCE_COLUMNS = [
  "work_hours",
  "work_dist",
  "work_params",
  "wait_hours",
  "wait_dist",
  "wait_params",
  "rework_rate",
  "sla_hours",
  "current_wip",
] as const;

const TRACKED = new Set<string>(PROVENANCE_COLUMNS);
const PREFIX = "provenance.";

/** The column part of a field (`work_params.cv` → `work_params`). */
const columnOf = (field: string) => field.split(".", 1)[0]!;

export const isProvenanceField = (field: string): boolean => field.startsWith(PREFIX);

/** The provenance field recording where `field`'s value came from, if it has one. */
export function provenanceFieldFor(field: string): string | null {
  const col = columnOf(field);
  return TRACKED.has(col) && !isProvenanceField(field) ? `${PREFIX}${col}` : null;
}

/** A step's provenance entry for `column`, if one is recorded. */
export function stepProvenance(step: StepRow, column: string): Provenance | null {
  const map = (step as StepRow & { provenance?: unknown }).provenance;
  const entry = map && typeof map === "object" ? (map as Record<string, unknown>)[column] : null;
  return entry && typeof entry === "object" && typeof (entry as Provenance).source === "string" ? (entry as Provenance) : null;
}

/** Where a step's value came from; a value with none recorded is an estimate. */
export function provenanceSource(step: StepRow, column: string): ProvenanceSource {
  const source = stepProvenance(step, column)?.source;
  return source === "entered" || source === "measured" ? source : "estimated";
}

/**
 * A person's entry over what the value had: `entered` by them, keeping the
 * evidence cited for it, and any conflict kept as history, marked settled by
 * choosing a value.
 */
function enteredOver(previous: Provenance | null, entry: Provenance): Provenance {
  if (!previous) return entry;
  const out: Provenance = { ...entry };
  if (Array.isArray(previous.evidence) && previous.evidence.length) out.evidence = previous.evidence;
  const conflict = previous.conflict as { values?: unknown; resolved?: unknown } | undefined;
  if (conflict && typeof conflict === "object" && Array.isArray(conflict.values)) {
    out.conflict = conflict.resolved ? conflict : { ...conflict, resolved: { at: entry.at, ...(entry.by ? { by: entry.by } : {}), choice: "value" } };
  }
  return out;
}

/** Who and when to record for a person's edit. */
export interface Stamp {
  at: string;
  by?: string | null;
}

/**
 * The edit with each step parameter it changes recorded as `entered`: its
 * `provenance.<column>` goes from what the step had to `{source: "entered", at, by}`
 * in the same row change, so it saves (compare-and-set) and undoes with the value.
 */
export function stampProvenance(bundle: ProcessBundle, edit: Edit, stamp: Stamp): Edit {
  const entry: Provenance = { source: "entered", at: stamp.at, ...(stamp.by ? { by: stamp.by } : {}) };
  let changed = false;
  const ops = edit.ops.map((op) => {
    if (op.kind !== "update") return op;
    const changes = op.changes.map((c): RowChange => {
      if (c.table !== "steps") return c;
      const row = bundle.steps.find((s) => s.id === c.id);
      if (!row) return c;
      const before: Patch = { ...c.before };
      const after: Patch = { ...c.after };
      const settled: string[] = [];
      for (const field of Object.keys(c.after)) {
        const key = provenanceFieldFor(field);
        if (!key || key in after) continue;
        before[key] = readField(row, key);
        after[key] = enteredOver(stepProvenance(row, key.slice(PREFIX.length)), entry);
        settled.push(key.slice(PREFIX.length));
        changed = true;
      }
      // Typing a value settles its conflict or assumption (issue #21): the step's flags follow.
      if (settled.length) {
        const left = (test: (s: StepRow, column: string) => boolean) =>
          EVIDENCE_COLUMNS.some((col) => !settled.includes(col) && test(row, col));
        const had = (test: (s: StepRow, column: string) => boolean) => settled.some((col) => test(row, col));
        if (row.conflict && !("conflict" in after) && had((s, col) => openConflict(s, col) !== null) && !left((s, col) => openConflict(s, col) !== null)) {
          before.conflict = true;
          after.conflict = false;
        }
        if (row.assumption && !("assumption" in after) && had(isOpenAssumption) && !left(isOpenAssumption)) {
          before.assumption = true;
          after.assumption = false;
        }
      }
      return { ...c, before, after };
    });
    return { ...op, changes };
  });
  return changed ? { ...edit, ops } : edit;
}
