// Sources, evidence and conflicts (docs/PRD.md §4.1 "Sources and evidence",
// §7.1b, §7.2, decision D17; issue #21).
//
// Every inferred number can be traced to what someone said. A step keeps, per
// value column, a provenance entry (the §5 shape, see types.ts `Provenance`):
//
//   provenance.work_hours = {
//     source: "estimated" | "entered", at, by,
//     note?,                          // the reasoning behind an assumption
//     assumption?: true,              // filled in without a source: confirm it
//     evidence?: [{source_id, speaker, quote, timestamp, value?}],
//     conflict?: {values: [{value, source_id, speaker}], resolved?: {at, by, choice}},
//   }
//
// When citations state different values, the value is a conflict: an estimate
// becomes a triangular range (min, most likely, max) over what was said, and
// the step is flagged `conflict: true`, which publishing counts. A value a
// person entered is never overwritten: it keeps its value and is
// flagged. Confirming a value (or settling a conflict) makes it `entered`.
// Sources that differ by 2× or more are a perception gap, logged as an issue
// (the database does it in `private.log_perception_gaps`, this file mirrors
// it for the demo and the process page).
//
// Everything here is a pure function of step rows: no I/O and no clock (the
// caller passes who and when). Edits come back as field patches in the
// editor's convention (`work_params.min`, `provenance.work_hours`), so the
// process editor saves and undoes them like any other edit.

import { isRetiredStep } from "./retired";
import type { ConflictValue, EvidenceCitation, Provenance, ProvenanceConflict, StepRow } from "./types";

/** Step columns that can cite evidence (the simulation parameters a person can state). */
export const EVIDENCE_COLUMNS = ["work_hours", "wait_hours", "rework_rate", "current_wip", "sla_hours"] as const;
export type EvidenceColumn = (typeof EVIDENCE_COLUMNS)[number];

export const EVIDENCE_LABELS: Record<EvidenceColumn, string> = {
  work_hours: "hands-on time",
  wait_hours: "wait",
  rework_rate: "rework rate",
  current_wip: "current WIP",
  sla_hours: "SLA",
};

/** Sources this far apart (largest ÷ smallest) are a perception gap (docs/PRD.md §4.1). */
export const PERCEPTION_GAP_RATIO = 2;

export const isEvidenceColumn = (v: unknown): v is EvidenceColumn => (EVIDENCE_COLUMNS as readonly unknown[]).includes(v);

/** A field patch in the editor's convention: a column, `column.key` in a jsonb column, or `provenance.<column>`. */
export type StepPatch = Record<string, string | number | boolean | null | Provenance>;

/** Who and when, for a confirmation or a citation. */
export interface EvidenceStamp {
  at: string;
  by?: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round = (v: number, digits = 6) => Number(v.toFixed(digits));
const DURATIONS: Partial<Record<EvidenceColumn, "work" | "wait">> = { work_hours: "work", wait_hours: "wait" };

/** A value as a person reads it: "5 h", "15%", "3 items". The database's perception-gap text uses the same format. */
export function formatParameter(column: EvidenceColumn, value: number): string {
  if (column === "rework_rate") return `${round(value * 100, 1)}%`;
  if (column === "current_wip") return `${round(value, 2)} items`;
  return `${round(value, 2)} h`;
}

/** The provenance entry of one of a step's columns, if it has one. */
export function columnProvenance(step: Pick<StepRow, "provenance">, column: string): Provenance | null {
  const entry = isObject(step.provenance) ? step.provenance[column] : undefined;
  return isObject(entry) && typeof entry.source === "string" ? entry : null;
}

/** The step's current value for a column, or null (an SLA or WIP nobody entered). */
export function stepValue(step: StepRow, column: EvidenceColumn): number | null {
  const v = step[column];
  return v === null || v === undefined ? null : Number(v);
}

/** Citations of a column, in the order they were added. */
export function evidenceOf(step: Pick<StepRow, "provenance">, column: string): EvidenceCitation[] {
  const list = columnProvenance(step, column)?.evidence;
  return Array.isArray(list) ? list.filter((c) => isObject(c) && typeof c.source_id === "string") : [];
}

const sameValue = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** The different numbers among `values`, in first-seen order. */
function distinctValues(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (!out.some((o) => sameValue(o, v))) out.push(v);
  return out;
}

/**
 * The triangular range over what sources said: the smallest and largest
 * values, and the median as the most likely (the middle one, or halfway
 * between the middle two).
 */
export function conflictRange(values: readonly number[]): { min: number; mode: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { min: 0, mode: 0, max: 0 };
  const mid = sorted.length >> 1;
  const mode = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: sorted[0]!, mode, max: sorted[sorted.length - 1]! };
}

/** Largest ÷ smallest; Infinity when one says zero and another doesn't; 1 with fewer than two values. */
export function gapRatio(values: readonly number[]): number {
  if (values.length < 2) return 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= 0) return 1;
  return min <= 0 ? Infinity : max / min;
}

/** An unsettled disagreement on a column (at least two different values, not resolved), or null. */
export function openConflict(step: Pick<StepRow, "provenance">, column: string): ProvenanceConflict | null {
  const conflict = columnProvenance(step, column)?.conflict;
  if (!isObject(conflict) || conflict.resolved || !Array.isArray(conflict.values)) return null;
  const values = conflict.values.filter((v) => isObject(v) && Number.isFinite(Number(v.value)));
  return distinctValues(values.map((v) => Number(v.value))).length >= 2 ? { values } : null;
}

/** Whether a column is an unconfirmed assumption (and not a conflict, which is listed as one). */
export function isOpenAssumption(step: Pick<StepRow, "provenance">, column: string): boolean {
  const entry = columnProvenance(step, column);
  return entry?.assumption === true && entry.source === "estimated" && !openConflict(step, column);
}

/** The engine's `*_params` keys for a triangular range, and the mean that goes with it. */
function rangePatch(phase: "work" | "wait", range: { min: number; mode: number; max: number }): StepPatch {
  return {
    [`${phase}_dist`]: "triangular",
    [`${phase}_params.min`]: round(range.min),
    [`${phase}_params.mode`]: round(range.mode),
    [`${phase}_params.max`]: round(range.max),
    [`${phase}_hours`]: round((range.min + range.mode + range.max) / 3),
  };
}

/** A plain value for a column (a duration stops being a range). */
function valuePatch(step: StepRow, column: EvidenceColumn, value: number): StepPatch {
  const phase = DURATIONS[column];
  const v = column === "current_wip" ? Math.round(value) : round(value);
  const patch: StepPatch = { [column]: v };
  if (phase && step[`${phase}_dist`] === "triangular") patch[`${phase}_dist`] = "lognormal";
  return patch;
}

/** Without undefined keys, so the entry stays plain JSON. */
function clean<T extends object>(entry: T): T {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as T;
}

/** Other columns of the step with an open conflict or assumption. */
function others(step: StepRow, column: string) {
  const rest = EVIDENCE_COLUMNS.filter((c) => c !== column);
  return { conflict: rest.some((c) => openConflict(step, c)), assumption: rest.some((c) => isOpenAssumption(step, c)) };
}

/**
 * Cite a source for one of a step's values. The citation joins the column's
 * evidence; then, from every value the evidence states:
 *
 * - they agree (or none is stated): an estimate takes the stated value and
 *   stays an assumption to confirm; an entered value that agrees
 *   is just corroborated;
 * - they disagree: the column becomes a conflict over the stated values (and
 *   an entered value, which is never overwritten). An estimated
 *   duration becomes the triangular range over them, and another estimate
 *   the most likely value. The step is flagged `conflict`.
 */
export function citeEvidence(step: StepRow, column: EvidenceColumn, citation: EvidenceCitation, stamp: EvidenceStamp): StepPatch {
  const entry: Provenance = columnProvenance(step, column) ?? { source: "estimated", at: stamp.at, ...(stamp.by ? { by: stamp.by } : {}) };
  const evidence = [...evidenceOf(step, column), clean(citation)];
  const known = entry.source === "entered";
  const current = stepValue(step, column);

  // Once someone settled a conflict, only what is said after that can reopen it.
  const considered = entry.conflict?.resolved ? evidence.slice(-1) : evidence;
  const stated: ConflictValue[] = considered
    .filter((c) => typeof c.value === "number" && Number.isFinite(c.value))
    .map((c) => ({ value: c.value as number, source_id: c.source_id, speaker: c.speaker ?? null }));
  // One value per speaker in a source: the latest thing they said.
  const latest = stated.filter((c, i) => !stated.slice(i + 1).some((d) => d.source_id === c.source_id && d.speaker === c.speaker));
  const values: ConflictValue[] =
    known && current !== null && !latest.some((s) => sameValue(s.value, current))
      ? [{ value: current, source_id: null, speaker: null }, ...latest]
      : latest;
  const distinct = distinctValues(values.map((c) => c.value));
  const patch: StepPatch = {};

  if (distinct.length >= 2) {
    const next = clean({ ...entry, evidence, conflict: { values }, assumption: undefined });
    patch[`provenance.${column}`] = next;
    if (!known) {
      const range = conflictRange(values.map((v) => v.value));
      const phase = DURATIONS[column];
      Object.assign(patch, phase ? rangePatch(phase, range) : valuePatch(step, column, range.mode));
    }
    patch.conflict = true;
    return patch;
  }

  const conflict = entry.conflict?.resolved ? entry.conflict : undefined;
  const next = clean({ ...entry, evidence, conflict, ...(known ? {} : { assumption: true }) });
  patch[`provenance.${column}`] = next;
  if (!known && distinct.length === 1 && (current === null || !sameValue(current, distinct[0]!))) {
    Object.assign(patch, valuePatch(step, column, distinct[0]!));
  }
  if (!known) patch.assumption = true;
  // A conflict this column had is gone (its only other value was withdrawn): the step flag follows.
  if (openConflict(step, column) && !others(step, column).conflict) patch.conflict = false;
  return patch;
}

/**
 * Confirm a value: its provenance becomes `entered` (by whom, when), keeping
 * its evidence. With `value`, that value is used instead (for a conflict,
 * one side's number or a new one; for a duration, a plain mean instead of the
 * range); without, the value stays as it is (for a conflict, the range). A
 * conflict is kept as history, marked resolved. The step's `assumption` and
 * `conflict` flags clear once none of its values need them.
 */
export function confirmParameter(step: StepRow, column: EvidenceColumn, stamp: EvidenceStamp, value?: number): StepPatch {
  const entry: Provenance = columnProvenance(step, column) ?? { source: "estimated" };
  const conflict = openConflict(step, column);
  const resolved: NonNullable<ProvenanceConflict["resolved"]> = {
    at: stamp.at,
    ...(stamp.by ? { by: stamp.by } : {}),
    choice: value === undefined ? "range" : "value",
  };
  const next = clean({
    ...entry,
    source: "entered" as const,
    at: stamp.at,
    by: stamp.by ?? undefined,
    assumption: undefined,
    conflict: conflict ? { values: conflict.values, resolved } : entry.conflict,
  });
  const patch: StepPatch = { [`provenance.${column}`]: next };
  if (value !== undefined) Object.assign(patch, valuePatch(step, column, value));
  const rest = others(step, column);
  if (entry.assumption === true && step.assumption && !rest.assumption) patch.assumption = false;
  if (conflict && step.conflict && !rest.conflict) patch.conflict = false;
  return patch;
}

/** Remove one citation (by its position in the column's evidence); the conflict is worked out again. */
export function removeEvidence(step: StepRow, column: EvidenceColumn, index: number, stamp: EvidenceStamp): StepPatch {
  const evidence = evidenceOf(step, column);
  if (index < 0 || index >= evidence.length) return {};
  const [last, ...rest] = [...evidence.slice(0, index), ...evidence.slice(index + 1)].reverse();
  const entry = columnProvenance(step, column) ?? { source: "estimated" };
  if (!last) {
    const next = clean({ ...entry, evidence: undefined, conflict: undefined });
    const patch: StepPatch = { [`provenance.${column}`]: next };
    if (openConflict(step, column) && !others(step, column).conflict) patch.conflict = false;
    return patch;
  }
  // Re-cite the rest in order on a copy without evidence: the same rules decide the conflict.
  const base: StepRow = { ...step, provenance: { ...step.provenance, [column]: clean({ ...entry, evidence: rest.reverse(), conflict: undefined }) } };
  const patch = citeEvidence(base, column, last, stamp);
  if (!("conflict" in patch) && openConflict(step, column) && !others(step, column).conflict) patch.conflict = false;
  return patch;
}

/** A step with a patch applied (`column.key` sets one key of a jsonb column), for fixtures and tests. */
export function applyStepPatch(step: StepRow, patch: StepPatch): StepRow {
  const out: Record<string, unknown> = { ...step };
  for (const [field, value] of Object.entries(patch)) {
    const [col, sub] = field.split(".", 2) as [string, string | undefined];
    if (sub === undefined) out[col] = value;
    else out[col] = { ...(isObject(out[col]) ? out[col] : {}), [sub]: value };
  }
  return out as unknown as StepRow;
}

// ---------------------------------------------------------------------------
// The draft's checklist rail
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  kind: "conflict" | "assumption";
  stepId: string;
  stepName: string;
  /** Null for a step marked as an estimate as a whole, with no value singled out. */
  column: EvidenceColumn | null;
  value: number | null;
  /** The reasoning recorded with the value (`provenance.<column>.note`). */
  reasoning: string | null;
  evidence: EvidenceCitation[];
  /** The disagreeing values, for a conflict. */
  values: ConflictValue[] | null;
}

/**
 * What the draft review lists (docs/PRD.md §7.1b): every open conflict first,
 * then every assumption, each by step name then column order. A step flagged
 * as an estimate with no value singled out is one item for the whole step.
 * Retired steps (split or replaced, issue #16) are left out: they are no
 * longer part of the process.
 */
export function checklistItems(steps: readonly StepRow[]): ChecklistItem[] {
  const sorted = steps.filter((s) => !isRetiredStep(s)).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const conflicts: ChecklistItem[] = [];
  const assumptions: ChecklistItem[] = [];
  for (const step of sorted) {
    const item = (kind: ChecklistItem["kind"], column: EvidenceColumn | null): ChecklistItem => ({
      kind,
      stepId: step.id,
      stepName: step.name,
      column,
      value: column ? stepValue(step, column) : null,
      reasoning: (column && columnProvenance(step, column)?.note) || null,
      evidence: column ? evidenceOf(step, column) : [],
      values: column ? (openConflict(step, column)?.values ?? null) : null,
    });
    let any = false;
    for (const column of EVIDENCE_COLUMNS) {
      if (openConflict(step, column)) {
        conflicts.push(item("conflict", column));
        any = true;
      } else if (isOpenAssumption(step, column)) {
        assumptions.push(item("assumption", column));
        any = true;
      }
    }
    if (!any && step.assumption) assumptions.push(item("assumption", null));
  }
  return [...conflicts, ...assumptions];
}

/** The first quote cited for a step's open conflicts, then its assumptions, for a badge's tooltip. */
export function badgeQuote(step: StepRow): string | null {
  if (isRetiredStep(step)) return null;
  const columns = [...EVIDENCE_COLUMNS.filter((c) => openConflict(step, c)), ...EVIDENCE_COLUMNS.filter((c) => isOpenAssumption(step, c))];
  for (const column of columns) {
    const quoted = evidenceOf(step, column).filter((c) => c.quote?.trim());
    if (quoted.length) {
      return quoted.map((c) => `“${c.quote.trim()}”${c.speaker ? ` (${c.speaker})` : ""}`).join(" vs ");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Perception gaps
// ---------------------------------------------------------------------------

export interface PerceptionGap {
  /** The issue's `detected_key`: `perception_gap:step:<step id>.<column>`. */
  key: string;
  stepId: string;
  processId: string;
  column: EvidenceColumn;
  values: ConflictValue[];
  ratio: number;
  title: string;
  evidence: string;
  citations: EvidenceCitation[];
}

/**
 * Open conflicts whose values differ by `PERCEPTION_GAP_RATIO` or more, as
 * issues to log. Title and evidence match what the database's trigger writes.
 * Retired steps are skipped, as the trigger skips them.
 */
export function perceptionGaps(steps: readonly StepRow[]): PerceptionGap[] {
  const out: PerceptionGap[] = [];
  for (const step of steps) {
    if (isRetiredStep(step)) continue;
    for (const column of EVIDENCE_COLUMNS) {
      const conflict = openConflict(step, column);
      if (!conflict) continue;
      const nums = conflict.values.map((v) => Number(v.value));
      const ratio = gapRatio(nums);
      if (ratio < PERCEPTION_GAP_RATIO) continue;
      const said = conflict.values
        .map((v) => `${v.speaker ?? (v.source_id ? "Unnamed speaker" : "Entered value")}: ${formatParameter(column, Number(v.value))}`)
        .join("; ");
      const apart = Number.isFinite(ratio) ? `${round(ratio, 1)}× apart` : "one says none";
      out.push({
        key: `perception_gap:step:${step.id}.${column}`,
        stepId: step.id,
        processId: step.process_id,
        column,
        values: conflict.values,
        ratio,
        title: `Sources disagree on ${step.name}: ${EVIDENCE_LABELS[column]}`.slice(0, 200),
        evidence: `${said} (${apart}). Measure it before relying on it.`.slice(0, 5000),
        citations: evidenceOf(step, column),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Sources page: what cites each source
// ---------------------------------------------------------------------------

/** A row that carries per-column provenance: a step, a lead source, a seasonality month. */
export interface CitingRow {
  table: string;
  id: string;
  /** What to call the row ("Audit & proposal", "Referrals"). */
  name: string;
  processId?: string | null;
  /** Which revision the row is in, for steps. */
  revision?: "live" | "draft";
  provenance: unknown;
}

export interface SourceCitation extends EvidenceCitation {
  table: string;
  rowId: string;
  rowName: string;
  processId: string | null;
  column: string;
  /** "live" when the live revision cites it, "draft" when only the draft does. */
  revision: "live" | "draft" | null;
}

/**
 * Every citation, grouped by the source it cites. A step that cites the same
 * words in live and in its draft is listed once, as live.
 */
export function citationsBySource(rows: readonly CitingRow[]): Map<string, SourceCitation[]> {
  const out = new Map<string, SourceCitation[]>();
  const seen = new Map<string, SourceCitation>();
  const ordered = [...rows].sort((a, b) => (a.revision === "draft" ? 1 : 0) - (b.revision === "draft" ? 1 : 0));
  for (const row of ordered) {
    if (!isObject(row.provenance)) continue;
    for (const [column, entry] of Object.entries(row.provenance)) {
      if (!isObject(entry) || !Array.isArray(entry.evidence)) continue;
      for (const c of entry.evidence as unknown[]) {
        if (!isObject(c) || typeof c.source_id !== "string") continue;
        const citation = c as EvidenceCitation;
        const key = [row.table, row.id, column, citation.source_id, citation.speaker ?? "", citation.quote, citation.value ?? ""].join("|");
        if (seen.has(key)) continue;
        const item: SourceCitation = {
          ...citation,
          table: row.table,
          rowId: row.id,
          rowName: row.name,
          processId: row.processId ?? null,
          column,
          revision: row.revision ?? null,
        };
        seen.set(key, item);
        const list = out.get(citation.source_id) ?? [];
        list.push(item);
        out.set(citation.source_id, list);
      }
    }
  }
  return out;
}
