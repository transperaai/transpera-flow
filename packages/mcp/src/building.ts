// Process building (issue #24; docs/PRD.md §7.1, §7.1b, D17, D18): the pure
// rules behind the MCP tools that write steps and edges into a draft. No I/O
// and no clock: the tool layer (building-tools.ts) loads the draft, resolves
// names to ids, calls these, and writes the result as ordinary row inserts,
// deletes and per-field saves (`save_fields`), so the canvas's rules hold:
//
// - Step ids are stable: a matched step keeps its id, a new one gets a fresh
//   id once, and nothing is ever re-keyed.
// - A parameter a caller leaves out gets the editor's default, marked
//   `estimated` with `assumption: true` and listed in `assumptions` (§7.1).
// - A value given without a citation is an assumption too, with the caller's
//   reasoning as its note (§7.2). Citations follow packages/db/src/evidence.ts:
//   disagreeing sources become a triangular range and a conflict.
// - A value someone `entered` or `measured` is never overwritten: a different
//   value is recorded as a conflict on it instead (§7.1b).
// - Graph checks mirror the process editor (apps/web/src/lib/editor/commands.ts
//   and validate.ts): no edges out of an end step or into the start step, no
//   self-loops or duplicate edges, one start step, branches that add up to 100%.

import {
  applyStepPatch,
  citeEvidence,
  columnProvenance,
  EVIDENCE_COLUMNS,
  EVIDENCE_LABELS,
  formatParameter,
  groupHasExit,
  groupsLetOut,
  isOpenAssumption,
  isRetiredStep,
  openConflict,
  SERVER_DEFAULT_NOTE_PREFIX,
  stepValue,
  triangularRange,
  type ConflictValue,
  type DistParams,
  type Distribution,
  type EdgeRow,
  type EvidenceColumn,
  type Provenance,
  type StepKind,
  type StepOutcome,
  type StepPatch,
  type StepRow,
} from "@transpera-flow/db";
import { ToolError } from "./result";

/** Step kinds the step tools create (the editor's palette). */
export const BUILD_STEP_KINDS = ["task", "wait", "decision", "start", "end"] as const satisfies readonly StepKind[];
/** Steps that hold others (issue #102): a group of steps, or a step holding a child process. Only `import_process` writes them. */
export const NESTING_KINDS = ["group", "subprocess"] as const satisfies readonly StepKind[];
export const IMPORT_STEP_KINDS = [...BUILD_STEP_KINDS, ...NESTING_KINDS] as const;
export type BuildStepKind = (typeof IMPORT_STEP_KINDS)[number];
export const OUTCOMES = ["won", "lost", "done"] as const satisfies readonly StepOutcome[];
export const DISTRIBUTIONS = ["constant", "triangular", "lognormal"] as const satisfies readonly Distribution[];

/** Who and when, for provenance entries. */
export interface Stamp {
  at: string;
  by?: string | null;
}

/** One citation, with the source already resolved to its id. */
export interface Citation {
  field: EvidenceColumn;
  source_id: string;
  speaker?: string | null;
  quote: string;
  timestamp?: string | null;
  value?: number | null;
}

/** What a step tool may set, with names already resolved to ids. Undefined means "not given". */
export interface StepFields {
  name?: string;
  kind?: BuildStepKind;
  outcome?: StepOutcome | null;
  role_id?: string | null;
  person_id?: string | null;
  work_hours?: number;
  work_dist?: Distribution;
  work_params?: DistParams;
  wait_hours?: number;
  wait_dist?: Distribution;
  wait_params?: DistParams;
  rework_rate?: number;
  rework_to_step_id?: string | null;
  tool?: string | null;
  notes?: string | null;
  sla_hours?: number | null;
  current_wip?: number | null;
  /** The group the step sits in (a step id), null for the top level. Only import_process sets it. */
  parent_step_id?: string | null;
  /** A group's first step (one of its own steps). */
  entry_step_id?: string | null;
  /** The child process a `subprocess` step holds. */
  child_process_id?: string | null;
  x?: number;
  y?: number;
  evidence?: Citation[];
  /** Why a value is what it is, when no source states it (kept as `provenance.<column>.note`). */
  reasoning?: Partial<Record<EvidenceColumn, string>>;
}

/** A value kept because someone entered or measured it; the proposed value is flagged instead. */
export interface KeptValue {
  step_id: string;
  step: string;
  field: string;
  kept: unknown;
  proposed: unknown;
  reason: string;
}

/** A value whose sources (or a proposal) disagree, left for a person to settle. */
export interface FlaggedConflict {
  step_id: string;
  step: string;
  field: EvidenceColumn;
  values: ConflictValue[];
  text: string;
}

/** Who proposed a value that has no citation, in a conflict's values. */
export const PROPOSED_BY = "Proposed via MCP";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round = (v: number) => Math.round(v * 1000) / 1000;
const PHASES = ["work", "wait"] as const;
type Phase = (typeof PHASES)[number];
const PARAM_KEYS = ["cv", "min", "mode", "max"] as const;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Lower case, `&` as "and", punctuation as spaces: "Audit & Proposal!" → "audit and proposal". */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Find one item by id or name: the id, then the exact name (ignoring case),
 * then the name ignoring punctuation, then a unique part of the name, then
 * every word of `ref` in the name in any order. The first tier with any match
 * decides: one match is the answer, several are returned as candidates
 * (`ambiguous`) rather than guessed. With `strict`, only the first three tiers.
 */
export function resolveName<T extends { id: string; name: string }>(
  items: readonly T[],
  ref: string,
  kind: string,
  where = "",
  { strict = false }: { strict?: boolean } = {},
): T {
  const raw = ref.trim();
  const lower = raw.toLowerCase();
  const norm = normalizeName(raw);
  const words = norm.split(" ").filter(Boolean);
  const tiers: (() => T[])[] = [
    () => items.filter((x) => x.id.toLowerCase() === lower),
    () => items.filter((x) => x.name.trim().toLowerCase() === lower),
    () => (norm ? items.filter((x) => normalizeName(x.name) === norm) : []),
  ];
  if (!strict && !isUuid(raw) && norm) {
    tiers.push(
      () => items.filter((x) => normalizeName(x.name).includes(norm)),
      () => items.filter((x) => {
        const have = normalizeName(x.name).split(" ");
        return words.every((w) => have.some((h) => h.startsWith(w)));
      }),
    );
  }
  const list = (xs: readonly T[]) => xs.map((x) => ({ id: x.id, name: x.name }));
  for (const tier of tiers) {
    const found = tier();
    if (found.length === 1) return found[0]!;
    if (found.length > 1) throw new ToolError("ambiguous", `'${ref}' matches more than one ${kind}${where}; pass its id or full name`, list(found));
  }
  throw new ToolError("not_found", `No ${kind}${where} matches '${ref}'`, list(items).slice(0, 50));
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** A field's current value in the editor's convention (`work_params.min`, `provenance.work_hours`), or null. */
export function readField(row: StepRow | EdgeRow, field: string): unknown {
  const [col, sub] = field.split(".", 2) as [string, string | undefined];
  const value = (row as unknown as Record<string, unknown>)[col];
  if (sub === undefined) return value === undefined ? null : value;
  return isObject(value) && value[sub] !== undefined ? value[sub] : null;
}

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" || typeof b === "number") {
    return a !== null && b !== null && a !== undefined && b !== undefined && Number(a) === Number(b);
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

/** Defaults for a new step of each kind: the editor's (commands.ts `newStepRow`), and which of them are assumptions. */
export const STEP_DEFAULTS: Record<BuildStepKind, { work_hours: number; wait_hours: number; rework_rate: number; assumed: EvidenceColumn[] }> = {
  task: { work_hours: 1, wait_hours: 0, rework_rate: 0, assumed: ["work_hours", "wait_hours", "rework_rate"] },
  wait: { work_hours: 0, wait_hours: 8, rework_rate: 0, assumed: ["wait_hours"] },
  decision: { work_hours: 0, wait_hours: 0, rework_rate: 0, assumed: [] },
  start: { work_hours: 0, wait_hours: 0, rework_rate: 0, assumed: [] },
  end: { work_hours: 0, wait_hours: 0, rework_rate: 0, assumed: [] },
  // A holder of other steps does no work itself: its steps' numbers are the numbers.
  group: { work_hours: 0, wait_hours: 0, rework_rate: 0, assumed: [] },
  subprocess: { work_hours: 0, wait_hours: 0, rework_rate: 0, assumed: [] },
};

/** The step fields a group (or a step holding a child process) can't have: the engine would ignore them. */
const HOLDER_FIELDS = ["role_id", "person_id", "work_hours", "wait_hours", "rework_rate", "sla_hours", "current_wip", "work_params", "wait_params", "evidence", "reasoning"] as const;

/** The outcome a new end step gets: won, then lost, then done, whichever the process lacks (as in the editor). */
export function nextOutcome(steps: readonly Pick<StepRow, "kind" | "outcome">[]): StepOutcome {
  const taken = new Set(steps.filter((s) => s.kind === "end").map((s) => s.outcome));
  return taken.has("won") ? (taken.has("lost") ? "done" : "lost") : "won";
}

/** Reject values the editor's validation or the table's checks would. */
export function checkStepFields(f: StepFields, label: string): void {
  const bad = (msg: string) => {
    throw new ToolError("invalid_input", `${label}: ${msg}`);
  };
  if (f.name !== undefined && (!f.name.trim() || f.name.length > 200)) bad("name must be 1–200 characters.");
  if (f.tool && f.tool.length > 200) bad("tool must be at most 200 characters.");
  if (f.notes && f.notes.length > 4000) bad("notes must be at most 4000 characters.");
  if (f.outcome && f.kind && f.kind !== "end") bad("only end steps have an outcome.");
  if (f.kind === "group" || f.child_process_id) {
    const given = HOLDER_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null && !(Array.isArray(f[k]) && (f[k] as unknown[]).length === 0));
    if (given.length) {
      bad(`${f.kind === "group" ? "a group" : "a step holding a child process"} does no work itself, so it takes no ${given.join(", ")}: give the numbers to the steps inside it.`);
    }
  }
  if (f.parent_step_id !== undefined && f.parent_step_id !== null && (f.kind === "start" || f.kind === "end")) bad("start and end steps stay at the top level, not inside a group.");
  if (f.child_process_id && f.kind !== undefined && f.kind !== "subprocess") bad("only a sub-process step can hold a child process.");
  if (f.entry_step_id && f.kind !== undefined && f.kind !== "group") bad("only a group has a first step (entry).");
  for (const phase of PHASES) {
    const params = f[`${phase}_params`];
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (!(PARAM_KEYS as readonly string[]).includes(k)) bad(`${phase}_params only takes cv, min, mode and max.`);
        if (v !== null && v !== undefined && !(v >= 0)) bad(`${phase}_params.${k} must be 0 or more.`);
      }
      const { min, mode, max } = params;
      if (min != null && mode != null && max != null && !(min <= mode && mode <= max)) bad(`${phase}_params needs min ≤ mode ≤ max.`);
    }
  }
  for (const c of f.evidence ?? []) {
    if (!c.quote.trim()) bad("every citation needs the words quoted.");
    if (c.value != null && c.field === "rework_rate" && !(c.value >= 0 && c.value <= 1)) bad("a rework_rate citation's value is a share from 0 to 1.");
    if (c.value != null && !(c.value >= 0)) bad(`a ${c.field} citation's value must be 0 or more.`);
  }
}

/** The mean of a triangular range the caller gave, when the hours themselves weren't given. */
function givenHours(f: StepFields, phase: Phase): number | undefined {
  const hours = f[`${phase}_hours`];
  if (hours !== undefined) return hours;
  const p = f[`${phase}_params`];
  if (f[`${phase}_dist`] === "triangular" && p?.min != null && p.mode != null && p.max != null) return round((p.min + p.mode + p.max) / 3);
  return undefined;
}

function givenValue(f: StepFields, column: EvidenceColumn): number | null | undefined {
  if (column === "work_hours") return givenHours(f, "work");
  if (column === "wait_hours") return givenHours(f, "wait");
  return f[column];
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function estimatedEntry(stamp: Stamp, extra: Partial<Provenance>): Provenance {
  return clean({ source: "estimated" as const, at: stamp.at, ...(stamp.by ? { by: stamp.by } : {}), ...extra });
}

const citationsFor = (f: StepFields, column: EvidenceColumn) => (f.evidence ?? []).filter((c) => c.field === column);

const toEvidence = (c: Citation) =>
  clean({ source_id: c.source_id, speaker: c.speaker ?? null, quote: c.quote.trim(), timestamp: c.timestamp ?? null, value: c.value ?? undefined });

/** Apply a patch to a working copy and record it, dropping no-ops against the original row. */
class PatchBuilder {
  cur: StepRow;
  readonly patch: StepPatch = {};
  constructor(readonly original: StepRow) {
    this.cur = original;
  }
  set(field: string, value: unknown): void {
    this.merge({ [field]: value } as StepPatch);
  }
  merge(p: StepPatch): void {
    for (const [field, value] of Object.entries(p)) this.patch[field] = value;
    this.cur = applyStepPatch(this.cur, p);
  }
  /** Only fields that differ from the original row. */
  result(): StepPatch {
    return Object.fromEntries(Object.entries(this.patch).filter(([field, value]) => !same(readField(this.original, field), value))) as StepPatch;
  }
}

/** Set a duration's triangular range from params (or around the hours), keeping the mean in step. */
function setDuration(b: PatchBuilder, phase: Phase, f: StepFields, hours: number | undefined): void {
  const dist = f[`${phase}_dist`];
  const params = f[`${phase}_params`];
  if (dist !== undefined) b.set(`${phase}_dist`, dist);
  const finalDist = dist ?? b.cur[`${phase}_dist`];
  if (finalDist === "triangular") {
    const base = triangularRange({ ...b.cur[`${phase}_params`], ...params }, hours ?? Number(b.cur[`${phase}_hours`]));
    const given = params?.min != null && params.mode != null && params.max != null;
    // Hours without a range: a range with the same shape around the new mean (as the node's inline edit does).
    const range =
      given || hours === undefined
        ? base
        : (() => {
            const old = triangularRange(b.cur[`${phase}_params`], Number(b.cur[`${phase}_hours`]));
            const mean = (old.min + old.mode + old.max) / 3;
            const scale = (v: number) => (mean > 0 ? (v * hours) / mean : hours);
            return { min: scale(old.min), mode: scale(old.mode), max: scale(old.max) };
          })();
    b.set(`${phase}_params.min`, round(range.min));
    b.set(`${phase}_params.mode`, round(range.mode));
    b.set(`${phase}_params.max`, round(range.max));
    b.set(`${phase}_hours`, round((range.min + range.mode + range.max) / 3));
  } else {
    if (params?.cv !== undefined) b.set(`${phase}_params.cv`, params.cv);
    if (hours !== undefined) b.set(`${phase}_hours`, hours);
  }
}

/** The step's flags after the changes: set when any value needs them (never cleared here; confirming is a person's call). */
function settleFlags(b: PatchBuilder): void {
  const anyAssumption = EVIDENCE_COLUMNS.some((c) => isOpenAssumption(b.cur, c));
  const anyConflict = EVIDENCE_COLUMNS.some((c) => openConflict(b.cur, c));
  if (anyAssumption && !b.cur.assumption) b.set("assumption", true);
  if (anyConflict && !b.cur.conflict) b.set("conflict", true);
  if (!anyConflict && b.cur.conflict && !b.original.conflict) b.set("conflict", false);
}

function conflictText(step: string, column: EvidenceColumn, values: readonly ConflictValue[]): string {
  const said = values
    .map((v) => `${v.speaker ?? (v.source_id ? "Unnamed speaker" : "Entered value")}: ${formatParameter(column, Number(v.value))}`)
    .join("; ");
  return `${step}: ${EVIDENCE_LABELS[column]} is in conflict (${said}).`;
}

// ---------------------------------------------------------------------------
// New steps
// ---------------------------------------------------------------------------

export interface StepOwner {
  revision_id: string;
  workspace_id: string;
  process_id: string;
}

export interface BuiltStep {
  row: StepRow;
  assumptions: string[];
  conflicts: FlaggedConflict[];
}

/**
 * A new step row from the fields given. Parameters left out get the editor's
 * defaults for the kind, recorded as assumptions; values given without a
 * citation are assumptions (with the caller's reasoning); citations are applied
 * in order by the evidence rules.
 */
export function buildNewStep(
  id: string,
  f: StepFields,
  owner: StepOwner,
  stamp: Stamp,
  opts: { outcome: StepOutcome; origin?: string },
): BuiltStep {
  const name = f.name?.trim();
  if (!name) throw new ToolError("invalid_input", "A new step needs a name.");
  checkStepFields(f, `Step '${name}'`);
  const kind: BuildStepKind = f.kind ?? (f.outcome ? "end" : "task");
  if (f.outcome && kind !== "end") throw new ToolError("invalid_input", `Step '${name}': only end steps have an outcome.`);
  const assumptions: string[] = [];
  const outcome = kind === "end" ? (f.outcome ?? opts.outcome) : null;
  if (kind === "end" && !f.outcome) assumptions.push(`Step '${name}': outcome defaulted to ${outcome}.`);
  const defaults = STEP_DEFAULTS[kind];
  const base: StepRow = {
    id,
    ...owner,
    name,
    kind,
    outcome,
    role_id: f.role_id ?? null,
    person_id: f.person_id ?? null,
    work_hours: defaults.work_hours,
    work_dist: "lognormal",
    work_params: {},
    wait_hours: defaults.wait_hours,
    wait_dist: "lognormal",
    wait_params: {},
    rework_rate: defaults.rework_rate,
    rework_to_step_id: f.rework_to_step_id ?? null,
    tool: f.tool?.trim() || null,
    notes: f.notes?.trim() || null,
    sla_hours: f.sla_hours ?? null,
    // The analysis rules' step settings are set in the editor, not by the building tools.
    expected_wait_hours: null,
    lost_per_day_waiting: null,
    dropoff_benchmark: null,
    target_cycle_hours: null,
    current_wip: f.current_wip ?? null,
    parent_step_id: f.parent_step_id ?? null,
    entry_step_id: f.entry_step_id ?? null,
    child_process_id: f.child_process_id ?? null,
    x: Math.round(f.x ?? 0),
    y: Math.round(f.y ?? 0),
    assumption: false,
    conflict: false,
    provenance: {},
    replaced_by: [],
  };
  const b = new PatchBuilder(base);
  for (const phase of PHASES) setDuration(b, phase, f, givenHours(f, phase));
  if (f.rework_rate !== undefined) b.set("rework_rate", f.rework_rate);

  const from = opts.origin ? ` (${opts.origin})` : "";
  for (const column of EVIDENCE_COLUMNS) {
    const given = givenValue(f, column);
    const cites = citationsFor(f, column);
    const reasoning = f.reasoning?.[column]?.trim() || undefined;
    if (cites.length) {
      b.set(`provenance.${column}`, estimatedEntry(stamp, { note: reasoning }));
      for (const c of cites) b.merge(citeEvidence(b.cur, column, toEvidence(c), stamp));
    } else if (given !== undefined && given !== null) {
      b.set(`provenance.${column}`, estimatedEntry(stamp, { assumption: true, note: reasoning ?? `Given without a cited source${from}.` }));
      assumptions.push(`Step '${name}': ${column} ${formatParameter(column, given)} has no cited source; marked as an assumption${reasoning ? ` (${reasoning.replace(/[.\s]+$/, "")})` : ""}.`);
    } else if (defaults.assumed.includes(column)) {
      const value = stepValue(b.cur, column) ?? 0;
      b.set(`provenance.${column}`, estimatedEntry(stamp, { assumption: true, note: reasoning ?? `${SERVER_DEFAULT_NOTE_PREFIX} ${kind} step${from}.` }));
      assumptions.push(`Step '${name}': ${column} defaulted to ${formatParameter(column, value)} (estimated; confirm it on the canvas).`);
    }
  }
  settleFlags(b);
  const row = b.cur;
  const conflicts = EVIDENCE_COLUMNS.flatMap((column) => {
    const c = openConflict(row, column);
    return c ? [{ step_id: row.id, step: row.name, field: column, values: c.values, text: conflictText(row.name, column, c.values) }] : [];
  });
  return { row, assumptions, conflicts };
}

// ---------------------------------------------------------------------------
// Changing a step
// ---------------------------------------------------------------------------

export interface StepChange {
  /** Fields to save, in the editor's convention; empty when nothing changes. */
  changes: StepPatch;
  /** The same fields' values as read, for the per-field compare-and-set. */
  base: Record<string, unknown>;
  kept: KeptValue[];
  conflicts: FlaggedConflict[];
  assumptions: string[];
  /** The row with the changes applied. */
  row: StepRow;
}

const isKnown = (entry: Provenance | null) => entry?.source === "entered" || entry?.source === "measured";

/**
 * The changes that bring an existing step in line with `f`. Values someone
 * entered or measured are kept: a different value is added to the column's
 * conflict (with its citation's source, or as a proposal) and the step is
 * flagged. Estimates take the new value; without a citation it is an
 * assumption. Citations are applied in order by the evidence rules.
 */
export function buildStepChange(row: StepRow, f: StepFields, stamp: Stamp, opts: { outcome: StepOutcome }): StepChange {
  const label = `Step '${f.name?.trim() || row.name}'`;
  checkStepFields(f, label);
  const b = new PatchBuilder(row);
  const kept: KeptValue[] = [];
  const assumptions: string[] = [];
  const keep = (field: string, proposed: unknown, reason: string) =>
    kept.push({ step_id: row.id, step: row.name, field, kept: readField(row, field), proposed, reason });

  if (f.name !== undefined) b.set("name", f.name.trim());
  for (const field of ["role_id", "person_id", "rework_to_step_id", "parent_step_id", "entry_step_id", "child_process_id"] as const) {
    if (f[field] !== undefined) b.set(field, f[field]);
  }
  for (const field of ["tool", "notes"] as const) if (f[field] !== undefined) b.set(field, f[field]?.trim() || null);
  for (const field of ["x", "y"] as const) if (f[field] !== undefined) b.set(field, Math.round(f[field]!));

  const kind = f.kind ?? row.kind;
  if (f.kind !== undefined && f.kind !== row.kind) {
    b.set("kind", f.kind);
    if (f.kind === "end") {
      const outcome = f.outcome ?? row.outcome ?? opts.outcome;
      if (!f.outcome) assumptions.push(`${label}: outcome defaulted to ${outcome}.`);
      b.set("outcome", outcome);
    } else b.set("outcome", null);
  }
  if (f.outcome !== undefined && f.outcome !== null) {
    if (kind !== "end") throw new ToolError("invalid_input", `${label}: only end steps have an outcome.`);
    b.set("outcome", f.outcome);
  }

  for (const phase of PHASES) {
    const column = `${phase}_hours` as const;
    const entry = columnProvenance(row, column);
    const shape = f[`${phase}_dist`] !== undefined || f[`${phase}_params`] !== undefined;
    if (shape && isKnown(entry)) {
      const changed =
        (f[`${phase}_dist`] !== undefined && f[`${phase}_dist`] !== row[`${phase}_dist`]) ||
        Object.entries(f[`${phase}_params`] ?? {}).some(([k, v]) => !same(readField(row, `${phase}_params.${k}`), v));
      if (changed) keep(`${phase}_dist`, { dist: f[`${phase}_dist`], params: f[`${phase}_params`] }, `${column} was ${entry!.source}; its distribution is kept`);
      continue;
    }
    const hours = givenHours(f, phase);
    const proposed = hours !== undefined && !same(hours, row[column]) && !isKnown(entry) ? hours : undefined;
    if (shape || proposed !== undefined) setDuration(b, phase, { ...f, [`${phase}_hours`]: proposed }, proposed);
  }

  for (const column of EVIDENCE_COLUMNS) {
    const entry = columnProvenance(row, column);
    const given = givenValue(f, column);
    const cites = citationsFor(f, column);
    const reasoning = f.reasoning?.[column]?.trim() || undefined;
    const current = stepValue(row, column);
    if (given !== undefined && !same(given, current)) {
      if (isKnown(entry)) {
        keep(column, given, `${column} was ${entry!.source}; the new value is flagged as a conflict instead`);
        // A citation stating the same value flags it with its source below.
        if (given !== null && !cites.some((c) => c.value != null && same(c.value, given))) {
          const now = columnProvenance(b.cur, column) ?? entry!;
          const values: ConflictValue[] = openConflict(b.cur, column)?.values ?? (current === null ? [] : [{ value: current, source_id: null, speaker: null }]);
          if (!values.some((v) => same(v.value, given))) {
            b.set(`provenance.${column}`, clean({ ...now, conflict: { values: [...values, { value: given, source_id: null, speaker: PROPOSED_BY }] } }));
          }
        }
      } else {
        // Durations were set with their shape above.
        if (column !== "work_hours" && column !== "wait_hours") b.set(column, column === "current_wip" && given !== null ? Math.round(given) : given);
        if (!cites.length) {
          b.set(
            `provenance.${column}`,
            clean({ ...(entry ?? {}), ...estimatedEntry(stamp, { assumption: given === null ? undefined : true, note: reasoning ?? entry?.note }) }),
          );
          if (given !== null) {
            assumptions.push(`${label}: ${column} ${formatParameter(column, given)} has no cited source; marked as an assumption${reasoning ? ` (${reasoning.replace(/[.\s]+$/, "")})` : ""}.`);
          }
        }
      }
    } else if (reasoning && !isKnown(entry) && entry?.note !== reasoning && !cites.length) {
      b.set(`provenance.${column}`, clean({ ...(entry ?? estimatedEntry(stamp, {})), note: reasoning }));
    }
    if (cites.length && reasoning && !isKnown(entry)) {
      b.set(`provenance.${column}`, clean({ ...(columnProvenance(b.cur, column) ?? estimatedEntry(stamp, {})), note: reasoning }));
    }
    for (const c of cites) b.merge(citeEvidence(b.cur, column, toEvidence(c), stamp));
  }
  settleFlags(b);
  const changes = b.result();
  const base = Object.fromEntries(Object.keys(changes).map((field) => [field, readField(row, field)]));
  const conflicts = EVIDENCE_COLUMNS.flatMap((column) => {
    const c = openConflict(b.cur, column);
    const before = openConflict(row, column);
    return c && !same(c, before) ? [{ step_id: row.id, step: b.cur.name, field: column, values: c.values, text: conflictText(b.cur.name, column, c.values) }] : [];
  });
  return { changes, base, kept, conflicts, assumptions, row: b.cur };
}

// ---------------------------------------------------------------------------
// The graph: the editor's rules
// ---------------------------------------------------------------------------

export interface Graph {
  steps: StepRow[];
  edges: EdgeRow[];
}

/** Why an edge from `from` to `to` isn't allowed, or null (commands.ts `connectionProblem`). */
export function connectionProblem(g: Graph, from: string, to: string, except?: string): string | null {
  const source = g.steps.find((s) => s.id === from);
  const target = g.steps.find((s) => s.id === to);
  if (!source || !target) return "Connect two steps.";
  if (from === to) return "A step can't lead to itself; use its rework rate instead.";
  if (source.kind === "end") return `End steps can't lead anywhere ('${source.name}' is an end step).`;
  if (target.kind === "start") return "Nothing can lead into the start step.";
  if (g.edges.some((e) => e.id !== except && e.from_step_id === from && e.to_step_id === to)) {
    return `'${source.name}' already leads to '${target.name}'.`;
  }
  return null;
}

/** Sum of a step's outgoing branch probabilities. */
export function outgoingTotal(g: Graph, stepId: string): number {
  return g.edges.filter((e) => e.from_step_id === stepId).reduce((sum, e) => sum + Number(e.probability), 0);
}

/** A process with more than one start step can't be simulated; the editor refuses a second one. */
export function startProblem(g: Graph): string | null {
  const starts = g.steps.filter((s) => s.kind === "start");
  return starts.length > 1 ? `A process has one start step; this would have ${starts.length} (${starts.map((s) => s.name).join(", ")}).` : null;
}

/**
 * Why the steps can't nest as they are, or null (the database enforces the same,
 * as migration 20261108000000 says, but refuses a whole write with one message):
 * a step sits only in a group of the same draft, never in itself or below itself;
 * a group's first step is one of its own; start and end steps stay at the top
 * level; a group, or a step holding a child process, has no numbers of its own.
 */
export function nestingProblem(g: Graph): string | null {
  const byId = new Map(g.steps.map((s) => [s.id, s]));
  for (const s of g.steps) {
    if (s.parent_step_id) {
      const parent = byId.get(s.parent_step_id);
      if (!parent) return `Step '${s.name}' sits inside a step that isn't in the process.`;
      if (parent.kind !== "group") return `Step '${s.name}' sits inside '${parent.name}', which isn't a group (kind group).`;
      if (s.kind === "start" || s.kind === "end") return `'${s.name}' is a ${s.kind} step: those stay at the top level of the process, not inside the group '${parent.name}'.`;
      const seen = new Set([s.id]);
      for (let at: StepRow | undefined = parent; at; at = at.parent_step_id ? byId.get(at.parent_step_id) : undefined) {
        if (seen.has(at.id)) return `Step '${s.name}' would sit inside itself.`;
        seen.add(at.id);
      }
    }
    if (s.kind === "group" && s.entry_step_id && byId.get(s.entry_step_id)?.parent_step_id !== s.id) {
      return `Group '${s.name}': its first step (entry) must be one of the steps inside it.`;
    }
    if (s.entry_step_id && s.kind !== "group") return `Step '${s.name}' has a first step but isn't a group.`;
    if (s.child_process_id && s.kind !== "subprocess") return `Step '${s.name}' holds a child process but isn't a sub-process step.`;
    if (s.kind === "group" || s.child_process_id) {
      const own = [s.role_id, s.person_id, s.sla_hours, s.current_wip].some((v) => v !== null && v !== undefined) || Number(s.work_hours) !== 0 || Number(s.wait_hours) !== 0 || Number(s.rework_rate) !== 0;
      if (own) return `'${s.name}' ${s.kind === "group" ? "is a group" : "holds a child process"}, so it has no role, hours, rework, SLA or WIP of its own: those belong to the steps inside it.`;
    }
  }
  return null;
}

/** Steps to flag (commands.ts `stepWarnings`), plus a missing start step. */
export function graphWarnings(g: Graph): { step_id: string | null; step: string | null; warning: string }[] {
  const out: { step_id: string | null; step: string | null; warning: string }[] = [];
  if (!g.steps.some((s) => s.kind === "start")) out.push({ step_id: null, step: null, warning: "The process has no start step yet." });
  for (const step of g.steps) {
    if (step.kind === "end") continue;
    if (step.kind === "group" && !g.steps.some((s) => s.parent_step_id === step.id)) {
      out.push({ step_id: step.id, step: step.name, warning: "This group has no steps yet." });
    }
    const outgoing = g.edges.filter((e) => e.from_step_id === step.id);
    if (!outgoing.length) {
      // Inside a group, a step with nothing leaving it is where the group ends: it leaves through the group's own edges.
      if (step.parent_step_id) {
        if (step.kind !== "group" && !groupsLetOut(g.steps, g.edges, step.id)) {
          out.push({ step_id: step.id, step: step.name, warning: "Nothing leaves this step, and no group it is in has a connection out." });
        }
        continue;
      }
      if (step.kind === "group" && groupHasExit(g.steps, g.edges, step.id)) continue;
      out.push({ step_id: step.id, step: step.name, warning: step.kind === "group" ? "Nothing leaves this group yet." : "Nothing leaves this step yet." });
      continue;
    }
    if (step.kind === "start") {
      if (outgoing.length > 1) out.push({ step_id: step.id, step: step.name, warning: "The start step should lead to exactly one step." });
      continue;
    }
    const total = outgoingTotal(g, step.id);
    if (Math.abs(total - 1) > 1e-6) out.push({ step_id: step.id, step: step.name, warning: `Branches add up to ${Math.round(total * 1000) / 10}%, not 100%.` });
  }
  return out;
}

/** Steps a step's rework can go back to: any other working step. */
export function reworkProblem(g: Graph, stepId: string, target: string | null): string | null {
  if (target === null) return null;
  const t = g.steps.find((s) => s.id === target);
  if (!t) return "The rework target isn't a step of this process.";
  if (target === stepId) return "Rework that repeats the step itself needs no target (pass null).";
  if (t.kind === "start" || t.kind === "end") return "Rework goes back to a working step, not a start or end step.";
  return null;
}

/** Where a new step goes on the canvas: right of `after`, left of `before`, between both, or right of everything. */
export function placeStep(g: Graph, after: StepRow | null, before: StepRow | null): { x: number; y: number } {
  if (after && before) return { x: Math.round((Number(after.x) + Number(before.x)) / 2), y: Math.round((Number(after.y) + Number(before.y)) / 2) + 80 };
  if (after) return { x: Number(after.x) + 240, y: Number(after.y) };
  if (before) return { x: Number(before.x) - 240, y: Number(before.y) };
  if (!g.steps.length) return { x: 0, y: 0 };
  return { x: Math.max(...g.steps.map((s) => Number(s.x))) + 240, y: Math.min(...g.steps.map((s) => Number(s.y))) };
}

/** Where a group's steps start inside its box (relative to the group): room for its name above them. */
export const GROUP_PADDING = { x: 24, y: 56 };

/**
 * Positions for steps that have none, left to right by distance from the
 * start step, stacked within each column; below any steps already placed.
 * Each level of nesting is laid out on its own: a group's steps are placed
 * relative to the group, from its first step on.
 */
export function layoutSteps(g: Graph, unplaced: ReadonlySet<string>): Map<string, { x: number; y: number }> {
  const byId = new Map(g.steps.map((s) => [s.id, s]));
  const levels = new Map<string | null, StepRow[]>();
  for (const s of g.steps) {
    const key = s.parent_step_id ?? null;
    levels.set(key, [...(levels.get(key) ?? []), s]);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [parent, members] of levels) {
    if (!members.some((m) => unplaced.has(m.id))) continue;
    const inLevel = new Set(members.map((m) => m.id));
    /** The step of this level that holds `id`: itself, or the group of this level it sits in. */
    const here = (id: string): string | null => {
      for (let cur: string | null = id, hops = 0; cur && hops < 100; hops++) {
        if (inLevel.has(cur)) return cur;
        cur = byId.get(cur)?.parent_step_id ?? null;
      }
      return null;
    };
    const links = g.edges
      .map((e) => [here(e.from_step_id), here(e.to_step_id)] as const)
      .filter((l): l is readonly [string, string] => l[0] !== null && l[1] !== null && l[0] !== l[1]);
    const depth = new Map<string, number>();
    const entry = parent ? byId.get(parent)?.entry_step_id : null;
    const first =
      (entry && inLevel.has(entry) ? entry : undefined) ??
      members.find((s) => s.kind === "start")?.id ??
      members.find((s) => !links.some((l) => l[1] === s.id))?.id;
    const queue: string[] = [];
    if (first) {
      depth.set(first, 0);
      queue.push(first);
    }
    while (queue.length) {
      const id = queue.shift()!;
      for (const [from, to] of links) {
        if (from === id && !depth.has(to)) {
          depth.set(to, depth.get(id)! + 1);
          queue.push(to);
        }
      }
    }
    const maxDepth = Math.max(0, ...depth.values());
    const placed = members.filter((s) => !unplaced.has(s.id));
    const origin = parent === null ? { x: 0, y: 0 } : GROUP_PADDING;
    const top = placed.length ? Math.max(...placed.map((s) => Number(s.y))) + 160 : origin.y;
    const perColumn = new Map<number, number>();
    for (const s of members) {
      if (!unplaced.has(s.id)) continue;
      const d = depth.get(s.id) ?? maxDepth + 1;
      const slot = perColumn.get(d) ?? 0;
      perColumn.set(d, slot + 1);
      out.set(s.id, { x: origin.x + d * 240, y: top + slot * 140 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A step of the import JSON, with role, person and sources resolved; `rework_to` still a reference. */
export interface ImportStep extends Omit<StepFields, "rework_to_step_id" | "parent_step_id" | "entry_step_id"> {
  id?: string;
  name: string;
  rework_to?: string | null;
  /** The group the step sits in: a step in this JSON or in the draft (id or name); null for the top level. */
  parent?: string | null;
  /** A group's first step (id or name). Default: its first step in the JSON. */
  entry?: string | null;
}

/** A step of process_json as the caller wrote it: possibly holding steps (a group) or a child process. */
export interface NestedStep {
  name: string;
  kind?: string;
  parent?: string | null;
  steps?: NestedStep[];
  child_process?: string;
  process?: unknown;
}

/** A step that holds a child process: which one it names, or the process to create (or write into) for it. */
export interface Holder<P = unknown> {
  step: string;
  child_process?: string;
  process?: P;
}

export const MAX_NESTING_DEPTH = 8;

/**
 * process_json's steps with the groups unfolded: every step in one list, those
 * written inside a group's `steps` given that group as their `parent` (by
 * name), and the steps that hold child processes listed apart. A step with
 * `steps` is a group, one with `child_process` or `process` a sub-process
 * step, so `kind` can be left out; a `kind` that says otherwise is refused.
 */
export function flattenNesting<T extends NestedStep>(
  steps: readonly T[],
): { steps: Omit<T, "steps" | "child_process" | "process">[]; holders: Holder<T["process"]>[] } {
  const out: Omit<T, "steps" | "child_process" | "process">[] = [];
  const holders: Holder<T["process"]>[] = [];
  const walk = (list: readonly NestedStep[], parent: string | null, depth: number) => {
    if (depth > MAX_NESTING_DEPTH) throw new ToolError("invalid_input", `Groups are nested more than ${MAX_NESTING_DEPTH} deep (inside '${parent}'); flatten the structure.`);
    for (const step of list) {
      const { steps: inside, child_process, process, ...rest } = step as NestedStep & Record<string, unknown>;
      let kind = rest.kind as string | undefined;
      if (inside !== undefined) {
        if (kind !== undefined && kind !== "group") throw new ToolError("invalid_input", `Step '${step.name}' has steps inside it, so it is a group, not '${kind}'.`);
        kind = "group";
      }
      if (child_process !== undefined || process !== undefined) {
        if (child_process !== undefined && process !== undefined) throw new ToolError("invalid_input", `Step '${step.name}' gives both child_process and process; give one.`);
        if (inside !== undefined) throw new ToolError("invalid_input", `Step '${step.name}' can't hold both steps and a child process.`);
        if (kind !== undefined && kind !== "subprocess") throw new ToolError("invalid_input", `Step '${step.name}' holds a child process, so it is a subprocess step, not '${kind}'.`);
        kind = "subprocess";
        holders.push({ step: step.name, ...(child_process !== undefined ? { child_process } : {}), ...(process !== undefined ? { process: process as T["process"] } : {}) });
      }
      if (parent !== null) {
        const said = rest.parent as string | null | undefined;
        if (said !== undefined && said !== null && normalizeName(said) !== normalizeName(parent)) {
          throw new ToolError("invalid_input", `Step '${step.name}' is listed inside '${parent}' but says its parent is '${said}'.`);
        }
        rest.parent = parent;
      }
      out.push({ ...rest, ...(kind !== undefined ? { kind } : {}) } as Omit<T, "steps" | "child_process" | "process">);
      if (inside !== undefined) walk(inside, step.name, depth + 1);
    }
  };
  walk(steps, null, 1);
  return { steps: out, holders };
}

export interface ImportEdge {
  from: string;
  to: string;
  probability?: number;
  condition_tag?: string | null;
  label?: string | null;
}

export interface ImportInput {
  steps: ImportStep[];
  edges: ImportEdge[];
  /** With a target: remove the draft's steps the JSON doesn't list (default false). */
  remove_missing?: boolean;
}

export interface EdgeChange {
  id: string;
  base: Record<string, unknown>;
  changes: Record<string, unknown>;
}

export interface ImportPlan {
  insertSteps: StepRow[];
  updateSteps: { id: string; name: string; base: Record<string, unknown>; changes: StepPatch }[];
  removeSteps: StepRow[];
  insertEdges: EdgeRow[];
  updateEdges: EdgeChange[];
  removeEdges: EdgeRow[];
  /** How each JSON step was matched: by stable id, by name, or new. */
  matched: { name: string; id: string; by: "id" | "name" | "new" }[];
  kept: KeptValue[];
  conflicts: FlaggedConflict[];
  assumptions: string[];
  /** The graph once the plan is written. */
  after: Graph;
}

/**
 * Plan writing `input` into `draft` (empty for a new process): match each JSON
 * step to a draft step by stable id, then by name (ignoring case and
 * punctuation; never by part of a name); update matched steps by the evidence
 * rules, insert the rest with fresh ids; for every step the JSON lists edges
 * from, make its outgoing edges exactly those (keeping the ids of edges that
 * stay). Nothing is written if any of it is invalid or ambiguous.
 */
export function planImport(
  input: ImportInput,
  draft: Graph & { retired: StepRow[] },
  owner: StepOwner,
  stamp: Stamp,
  opts: { newId: () => string; origin?: string },
): ImportPlan {
  const assumptions: string[] = [];
  const kept: KeptValue[] = [];
  const conflicts: FlaggedConflict[] = [];
  const matched: ImportPlan["matched"] = [];
  const usedDraft = new Set<string>();

  const names = new Map<string, string>();
  for (const s of input.steps) {
    const n = normalizeName(s.name);
    if (!n) throw new ToolError("invalid_input", "Every step in process_json needs a name.");
    if (names.has(n)) throw new ToolError("invalid_input", `process_json lists two steps called '${s.name}'; step names must be unique.`);
    names.set(n, s.name);
  }

  // 1. Match.
  const idOf: string[] = [];
  for (const s of input.steps) {
    let match: StepRow | undefined;
    let by: "id" | "name" | "new" = "new";
    if (s.id !== undefined) {
      if (!isUuid(s.id)) throw new ToolError("invalid_input", `Step '${s.name}': id must be a step's UUID (leave it out for a new step).`);
      match = draft.steps.find((d) => d.id === s.id);
      if (match) by = "id";
      else if (draft.retired.some((d) => d.id === s.id)) {
        throw new ToolError("invalid_input", `Step '${s.name}' (${s.id}) was split or replaced in this draft; use the steps that replaced it.`);
      }
    }
    if (!match) {
      const n = normalizeName(s.name);
      const found = draft.steps.filter((d) => !usedDraft.has(d.id) && normalizeName(d.name) === n);
      if (found.length > 1) {
        throw new ToolError(
          "ambiguous",
          `Step '${s.name}' matches more than one step in the draft; give its id`,
          found.map((d) => ({ id: d.id, name: d.name })),
        );
      }
      if (found.length === 1) {
        match = found[0];
        by = "name";
      }
    }
    if (match && usedDraft.has(match.id)) throw new ToolError("invalid_input", `Two steps in process_json match '${match.name}' (${match.id}).`);
    const id = match?.id ?? (s.id && ![...draft.steps, ...draft.retired].some((d) => d.id === s.id) ? s.id : opts.newId());
    if (match) usedDraft.add(match.id);
    idOf.push(id);
    matched.push({ name: s.name, id, by });
  }

  // References to steps: the JSON's own (id or name), then the draft's.
  const ref = (r: string, what: string): string => {
    const i = input.steps.findIndex((s) => s.id === r.trim() || normalizeName(s.name) === normalizeName(r));
    if (i >= 0) return idOf[i]!;
    const idx = matched.findIndex((m) => m.id === r.trim());
    if (idx >= 0) return idOf[idx]!;
    return resolveName(draft.steps, r, "step", ` for ${what}`, { strict: true }).id;
  };

  // 2. Steps.
  const insertSteps: StepRow[] = [];
  const updateSteps: ImportPlan["updateSteps"] = [];
  const rows = new Map(draft.steps.map((s) => [s.id, s]));
  const outcomes: Pick<StepRow, "kind" | "outcome">[] = [...draft.steps];
  input.steps.forEach((s, i) => {
    const id = idOf[i]!;
    const rework = s.rework_to === undefined ? undefined : s.rework_to === null ? null : ref(s.rework_to, `'${s.name}' rework_to`);
    const parent = s.parent === undefined ? undefined : s.parent === null ? null : ref(s.parent, `'${s.name}' parent`);
    const entry = s.entry === undefined ? undefined : s.entry === null ? null : ref(s.entry, `'${s.name}' entry`);
    const fields: StepFields = { ...s, rework_to_step_id: rework, parent_step_id: parent, entry_step_id: entry };
    // Matched by name: the draft's spelling stays (matched by id, a different name is a rename).
    if (matched[i]!.by === "name") delete fields.name;
    const existing = rows.get(id);
    if (existing && matched[i]!.by !== "new") {
      const change = buildStepChange(existing, fields, stamp, { outcome: nextOutcome(outcomes) });
      kept.push(...change.kept);
      conflicts.push(...change.conflicts);
      assumptions.push(...change.assumptions);
      if (Object.keys(change.changes).length) updateSteps.push({ id, name: change.row.name, base: change.base, changes: change.changes });
      rows.set(id, change.row);
    } else {
      const built = buildNewStep(id, fields, owner, stamp, { outcome: nextOutcome(outcomes), origin: opts.origin });
      outcomes.push(built.row);
      assumptions.push(...built.assumptions);
      conflicts.push(...built.conflicts);
      insertSteps.push(built.row);
      rows.set(id, built.row);
    }
  });

  // Steps the JSON leaves out.
  const listed = new Set(idOf);
  const removeSteps = input.remove_missing ? draft.steps.filter((s) => !listed.has(s.id)) : [];
  // Deleting a group deletes the steps inside it, so they must go too or be moved out first.
  const removing = new Set(removeSteps.map((s) => s.id));
  for (const g of removeSteps.filter((s) => s.kind === "group")) {
    const stays = [...rows.values()].filter((r) => r.parent_step_id === g.id && !removing.has(r.id));
    if (stays.length) {
      throw new ToolError("invalid_input", `Group '${g.name}' isn't in process_json, so remove_missing would remove it and the steps inside it; '${stays[0]!.name}' is listed, so list the group too or give the step a different parent.`);
    }
  }
  for (const s of removeSteps) rows.delete(s.id);

  // A group with steps but no first step starts at the first of its steps in the JSON.
  const setField = (id: string, field: "entry_step_id", value: string) => {
    const inserted = insertSteps.find((r) => r.id === id);
    if (inserted) inserted[field] = value;
    else {
      const pending = updateSteps.find((u) => u.id === id);
      const original = draft.steps.find((d) => d.id === id);
      if (pending) {
        pending.base[field] ??= original?.[field] ?? null;
        pending.changes[field] = value;
      } else updateSteps.push({ id, name: rows.get(id)!.name, base: { [field]: original?.[field] ?? null }, changes: { [field]: value } });
    }
    rows.set(id, { ...rows.get(id)!, [field]: value });
  };
  for (const g of [...rows.values()].filter((r) => r.kind === "group" && !r.entry_step_id)) {
    const inside = [...rows.values()].filter((r) => r.parent_step_id === g.id);
    if (!inside.length) continue;
    const order = (r: StepRow) => {
      const i = idOf.indexOf(r.id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    setField(g.id, "entry_step_id", [...inside].sort((a, b) => order(a) - order(b))[0]!.id);
  }
  let steps = [...rows.values()];

  // 3. Edges.
  const gone = new Set(removeSteps.map((s) => s.id));
  let edges = draft.edges.filter((e) => !gone.has(e.from_step_id) && !gone.has(e.to_step_id));
  const removeEdges = draft.edges.filter((e) => gone.has(e.from_step_id) || gone.has(e.to_step_id));
  const insertEdges: EdgeRow[] = [];
  const updateEdges: EdgeChange[] = [];
  /** Steps whose branches took the share the others leave: new ones are marked so "Missing for simulation" can list them (issue #167). */
  const oddsMissing = new Set<string>();
  const byFrom = new Map<string, { edge: ImportEdge; to: string }[]>();
  for (const e of input.edges) {
    const from = ref(e.from, "an edge's from");
    const to = ref(e.to, "an edge's to");
    const list = byFrom.get(from) ?? [];
    if (list.some((x) => x.to === to)) throw new ToolError("invalid_input", `process_json connects '${e.from}' to '${e.to}' twice.`);
    list.push({ edge: e, to });
    byFrom.set(from, list);
  }
  const graphNow = (): Graph => ({ steps, edges });
  for (const [from, list] of byFrom) {
    // A branch that stays keeps its probability unless a new one is given.
    const stays = (to: string) => edges.find((e) => e.from_step_id === from && e.to_step_id === to);
    const known = (x: { edge: ImportEdge; to: string }) => x.edge.probability ?? (stays(x.to) ? Number(stays(x.to)!.probability) : undefined);
    const given = list.reduce((sum, x) => sum + (known(x) ?? 0), 0);
    const missing = list.filter((x) => known(x) === undefined);
    const share = missing.length ? Math.max(0, round((1 - given) / missing.length)) : 0;
    const fromName = rows.get(from)?.name ?? from;
    if (missing.length && list.length > 1) {
      oddsMissing.add(from);
      assumptions.push(`'${fromName}': ${missing.length === 1 ? "one branch's" : `${missing.length} branches'`} probability defaulted to ${Math.round(share * 1000) / 10}% (the share the others leave).`);
    }
    const existing = edges.filter((e) => e.from_step_id === from);
    for (const old of existing.filter((e) => !list.some((x) => x.to === e.to_step_id))) {
      removeEdges.push(old);
      edges = edges.filter((e) => e.id !== old.id);
    }
    for (const { edge, to } of list) {
      const probability = edge.probability ?? (list.length === 1 ? 1 : share);
      const old = edges.find((e) => e.from_step_id === from && e.to_step_id === to);
      if (old) {
        const changes: Record<string, unknown> = {};
        if (edge.probability !== undefined && !same(old.probability, probability)) changes.probability = probability;
        if (edge.condition_tag !== undefined && !same(old.condition_tag, edge.condition_tag?.trim() || null)) changes.condition_tag = edge.condition_tag?.trim() || null;
        if (edge.label !== undefined && !same(old.label, edge.label?.trim() || null)) changes.label = edge.label?.trim() || null;
        if (Object.keys(changes).length) {
          updateEdges.push({ id: old.id, base: Object.fromEntries(Object.keys(changes).map((k) => [k, readField(old, k)])), changes });
          edges = edges.map((e) => (e.id === old.id ? ({ ...e, ...changes } as EdgeRow) : e));
        }
        continue;
      }
      const problem = connectionProblem(graphNow(), from, to);
      if (problem) throw new ToolError("invalid_input", problem);
      const row: EdgeRow = {
        id: opts.newId(),
        ...owner,
        from_step_id: from,
        to_step_id: to,
        probability,
        condition_tag: edge.condition_tag?.trim() || null,
        label: edge.label?.trim() || null,
      };
      insertEdges.push(row);
      edges = [...edges, row];
    }
  }

  for (const id of oddsMissing) {
    const inserted = insertSteps.find((r) => r.id === id);
    if (inserted) {
      const was = Object.fromEntries(insertEdges.filter((e) => e.from_step_id === id).map((e) => [e.to_step_id, Number(e.probability)]));
      inserted.provenance = { ...inserted.provenance, branch_odds: estimatedEntry(stamp, { defaulted: true, was, note: "No odds were given for its branches; they share what is left equally. Enter the odds to confirm them." }) };
    }
  }

  // Rework pointing at a removed step goes back to repeating the step (as deleting in the editor does).
  for (const s of steps) {
    if (s.rework_to_step_id && gone.has(s.rework_to_step_id)) {
      const pending = updateSteps.find((u) => u.id === s.id);
      const inserted = insertSteps.find((r) => r.id === s.id);
      if (inserted) inserted.rework_to_step_id = null;
      else if (pending) {
        pending.base.rework_to_step_id ??= draft.steps.find((d) => d.id === s.id)?.rework_to_step_id ?? null;
        pending.changes.rework_to_step_id = null;
      } else updateSteps.push({ id: s.id, name: s.name, base: { rework_to_step_id: s.rework_to_step_id }, changes: { rework_to_step_id: null } });
    }
  }
  steps = steps.map((s) => (s.rework_to_step_id && gone.has(s.rework_to_step_id) ? { ...s, rework_to_step_id: null } : s));

  const after: Graph = { steps, edges };
  const start = startProblem(after);
  if (start) throw new ToolError("invalid_input", start);
  const nesting = nestingProblem(after);
  if (nesting) throw new ToolError("invalid_input", nesting);
  for (const s of steps) {
    const problem = reworkProblem(after, s.id, s.rework_to_step_id);
    if (problem) throw new ToolError("invalid_input", `Step '${s.name}': ${problem}`);
  }

  // New steps without a position are laid out by distance from the start.
  const unplaced = new Set(
    insertSteps
      .filter((s) => {
        const src = input.steps[idOf.indexOf(s.id)];
        return src?.x === undefined && src?.y === undefined;
      })
      .map((s) => s.id),
  );
  if (unplaced.size) {
    const spots = layoutSteps(after, unplaced);
    for (const s of insertSteps) {
      const spot = spots.get(s.id);
      if (spot) Object.assign(s, spot);
    }
    after.steps = after.steps.map((s) => (spots.has(s.id) ? { ...s, ...spots.get(s.id)! } : s));
  }

  return { insertSteps, updateSteps, removeSteps, insertEdges, updateEdges, removeEdges, matched, kept, conflicts, assumptions, after };
}

// ---------------------------------------------------------------------------
// Draft vs live
// ---------------------------------------------------------------------------

const BOOKKEEPING = new Set(["revision_id", "created_at", "updated_at", "created_by"]);

export interface FieldChange {
  live: unknown;
  draft: unknown;
}

export interface RevisionDiff {
  steps: {
    added: { id: string; name: string }[];
    removed: { id: string; name: string }[];
    changed: { id: string; name: string; fields: Record<string, FieldChange> }[];
  };
  edges: {
    added: { id: string; from: string; to: string; probability: number }[];
    removed: { id: string; from: string; to: string; probability: number }[];
    changed: { id: string; from: string; to: string; fields: Record<string, FieldChange> }[];
  };
  text: string;
}

/** A provenance entry as the diff shows it: where it came from, and how much evidence. */
function provenanceSummary(v: unknown): unknown {
  if (!isObject(v)) return null;
  const conflict = isObject(v.conflict) ? v.conflict : null;
  return clean({
    source: v.source,
    assumption: v.assumption === true ? true : undefined,
    evidence: Array.isArray(v.evidence) ? v.evidence.length : undefined,
    conflict: conflict ? (conflict.resolved ? "resolved" : "open") : undefined,
  });
}

function rowFields(a: Record<string, unknown> | null, b: Record<string, unknown>): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b)]);
  for (const key of keys) {
    if (BOOKKEEPING.has(key) || key === "id") continue;
    const x = a?.[key];
    const y = b[key];
    if (isObject(x) || isObject(y)) {
      const subs = new Set([...Object.keys(isObject(x) ? x : {}), ...Object.keys(isObject(y) ? y : {})]);
      for (const sub of subs) {
        const xs = isObject(x) ? x[sub] : undefined;
        const ys = isObject(y) ? y[sub] : undefined;
        if (same(xs, ys)) continue;
        out[`${key}.${sub}`] = key === "provenance" ? { live: provenanceSummary(xs), draft: provenanceSummary(ys) } : { live: xs ?? null, draft: ys ?? null };
      }
    } else if (!same(x, y)) out[key] = { live: x ?? null, draft: y ?? null };
  }
  return out;
}

const fmt = (v: unknown) => (typeof v === "number" ? String(round(v)) : v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v));

/**
 * What the draft changes against live, by stable id (retired steps left out,
 * as the canvas leaves them out). With no live revision, everything is added.
 */
export function revisionDiff(live: Graph | null, draft: Graph): RevisionDiff {
  const liveSteps = (live?.steps ?? []).filter((s) => !isRetiredStep(s));
  const draftSteps = draft.steps.filter((s) => !isRetiredStep(s));
  const name = (id: string) => draftSteps.find((s) => s.id === id)?.name ?? liveSteps.find((s) => s.id === id)?.name ?? id;
  const steps: RevisionDiff["steps"] = { added: [], removed: [], changed: [] };
  for (const s of draftSteps) {
    const old = liveSteps.find((l) => l.id === s.id);
    if (!old) steps.added.push({ id: s.id, name: s.name });
    else {
      const fields = rowFields(old as unknown as Record<string, unknown>, s as unknown as Record<string, unknown>);
      if (Object.keys(fields).length) steps.changed.push({ id: s.id, name: s.name, fields });
    }
  }
  for (const s of liveSteps) if (!draftSteps.some((d) => d.id === s.id)) steps.removed.push({ id: s.id, name: s.name });

  const edges: RevisionDiff["edges"] = { added: [], removed: [], changed: [] };
  const liveEdges = live?.edges ?? [];
  const edgeOut = (e: EdgeRow) => ({ id: e.id, from: name(e.from_step_id), to: name(e.to_step_id), probability: Number(e.probability) });
  for (const e of draft.edges) {
    const old = liveEdges.find((l) => l.id === e.id);
    if (!old) edges.added.push(edgeOut(e));
    else {
      const fields = rowFields(old as unknown as Record<string, unknown>, e as unknown as Record<string, unknown>);
      if (Object.keys(fields).length) edges.changed.push({ id: e.id, from: name(e.from_step_id), to: name(e.to_step_id), fields });
    }
  }
  for (const e of liveEdges) if (!draft.edges.some((d) => d.id === e.id)) edges.removed.push(edgeOut(e));

  const parts: string[] = [];
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(", ");
  if (steps.added.length) parts.push(`${steps.added.length} step${steps.added.length === 1 ? "" : "s"} added (${names(steps.added)})`);
  if (steps.removed.length) parts.push(`${steps.removed.length} removed (${names(steps.removed)})`);
  if (steps.changed.length) {
    const detail = steps.changed.map((c) => {
      const shown = Object.entries(c.fields).filter(([k]) => !k.startsWith("provenance.") && k !== "x" && k !== "y");
      if (!shown.length) return `${c.name} (${Object.keys(c.fields).some((k) => k.startsWith("provenance.")) ? "evidence" : "position"})`;
      return `${c.name}: ${shown.map(([k, v]) => `${k} ${fmt(v.live)} → ${fmt(v.draft)}`).join(", ")}`;
    });
    parts.push(`${steps.changed.length} changed (${detail.join("; ")})`);
  }
  const edgeCount = edges.added.length + edges.removed.length + edges.changed.length;
  if (edgeCount) parts.push(`connections: ${edges.added.length} added, ${edges.removed.length} removed, ${edges.changed.length} changed`);
  const text = !live ? `New process: ${parts.join("; ") || "no steps yet"}.` : parts.length ? `Draft vs live: ${parts.join("; ")}.` : "The draft is the same as live.";
  return { steps, edges, text };
}
