// Checks on what the Calibration page sends to the server (issue #41) before anything is written. Row-level security and
// `record_calibration` decide who may write and what; this only refuses malformed input early, skips ticked keys that
// aren't proposals (with a reason), and keeps free text from the log out of what is stored. Framework-free for tests.

import type { ImportDetails } from "@transpera-flow/db/csv-import";
import { parseColumnMap, parseDetails } from "./import-request";

/** The kinds of file a process is calibrated from: a step log, deals or time logs (both converted into a step log). */
export type ProcessImportKind = "step_log" | "deals" | "time_logs";
const PROCESS_KINDS: readonly string[] = ["step_log", "deals", "time_logs"];

export interface ApplyRequest {
  workspaceId: string;
  processId: string;
  /** What was imported; a missing kind is a step log. */
  kind: ProcessImportKind;
  fileName: string;
  columnMap: Record<string, string>;
  rowCount: number;
  /** Counts only, rebuilt from known fields; null when the page sent none. */
  details: ImportDetails | null;
  results: { proposals: unknown[] } & Record<string, unknown>;
  keys: string[];
  /** Per-person times proposed from a log that names people (#227), rebuilt from known fields; empty when none. They are kept apart from `results`. */
  capacityFactors: StoredFactorProposal[];
  /** Ticked keys left out, with why. */
  skipped: { key: string; status: "not_proposed" }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^(work|wait|rework|routing|arrivals):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACTOR_KEY = /^factor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The most the page sends as the calibration's results (the database allows 2 MB). */
export const MAX_RESULTS_BYTES = 900_000;

/**
 * The results as stored: the log's own names that matched nothing (step and lead source names typed in the file, and the names
 * the person left out in the wizard) are kept as counts only, so no free text from the file is stored beyond names the model already has.
 */
export function storedResults(results: Record<string, unknown>): Record<string, unknown> {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  // Per-person data never goes into `results`, which every member of the workspace reads (#227): it travels apart, rebuilt.
  const { unmatchedSteps, unmatchedSources, ...rest } = results;
  for (const key of ["capacity_factors", "capacityFactors", "personTimes"]) delete rest[key];
  return { ...rest, unmatchedSteps: count(unmatchedSteps), unmatchedSources: count(unmatchedSources) };
}

/** A per-person time as stored in `capacity_factor_proposals.proposal` (#227): what `proposePersonTimes` returns, nothing else. */
export interface StoredFactorProposal {
  key: string;
  kind: "capacity_factor";
  target: { table: "person_capacity_factors"; id: string; step_id: string };
  personId: string;
  stepId: string;
  subject: string;
  n: number;
  stepN: number;
  enough: boolean;
  limited: boolean;
  within: boolean;
  changed: boolean;
  current: number | null;
  every: number | null;
  measured: number | null;
  proposed: number | null;
  currentSource: "entered" | "measured" | null;
  blocked: string | null;
  note: string | null;
  set: { factor: number } | null;
  before: { factor: number | null } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nat = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null);
const inRange = (v: number | null) => v !== null && v >= 0.5 && v <= 2;

/** Rebuilds one per-person proposal from known fields only (never a spread); null when it isn't valid. */
export function storedFactorProposal(input: unknown): StoredFactorProposal | null {
  if (!isObject(input)) return null;
  const t = input.target;
  if (!isObject(t) || t.table !== "person_capacity_factors" || !isId(t.id) || !isId(t.step_id)) return null;
  if (typeof input.key !== "string" || !FACTOR_KEY.test(input.key) || input.key !== `factor:${t.id}:${t.step_id}`) return null;
  if (input.kind !== "capacity_factor" || input.personId !== t.id || input.stepId !== t.step_id) return null;
  if (typeof input.subject !== "string" || input.subject.length > 200) return null;
  const n = nat(input.n);
  const stepN = nat(input.stepN);
  if (n === null || stepN === null) return null;
  for (const b of [input.enough, input.limited, input.within, input.changed]) if (typeof b !== "boolean") return null;
  const nullable = (v: unknown) => (v === null ? null : num(v));
  const current = nullable(input.current);
  const every = nullable(input.every);
  const measured = nullable(input.measured);
  const proposed = nullable(input.proposed);
  if ((input.current !== null && current === null) || (input.every !== null && every === null) || (input.measured !== null && measured === null) || (input.proposed !== null && proposed === null)) return null;
  if (proposed !== null && !inRange(proposed)) return null;
  const source = input.currentSource;
  if (source !== null && source !== "entered" && source !== "measured") return null;
  const str = (v: unknown) => (v === null ? null : typeof v === "string" && v.length <= 500 ? v : undefined);
  const blocked = str(input.blocked);
  const note = str(input.note);
  if (blocked === undefined || note === undefined) return null;
  let set: { factor: number } | null = null;
  if (input.set !== null) {
    if (!isObject(input.set) || !inRange(num(input.set.factor))) return null;
    set = { factor: input.set.factor as number };
  }
  let before: { factor: number | null } | null = null;
  if (input.before !== null) {
    if (!isObject(input.before)) return null;
    const f = input.before.factor === null ? null : num(input.before.factor);
    if (input.before.factor !== null && f === null) return null;
    before = { factor: f };
  }
  if ((set === null) !== (before === null)) return null;
  return {
    key: input.key,
    kind: "capacity_factor",
    target: { table: "person_capacity_factors", id: t.id, step_id: t.step_id },
    personId: t.id,
    stepId: t.step_id,
    subject: input.subject,
    n,
    stepN,
    enough: input.enough as boolean,
    limited: input.limited as boolean,
    within: input.within as boolean,
    changed: input.changed as boolean,
    current,
    every,
    measured,
    proposed,
    currentSource: source,
    blocked,
    note,
    set,
    before,
  };
}

export function parseApplyRequest(input: unknown): { ok: true; request: ApplyRequest } | { ok: false; message: string } {
  if (!isObject(input)) return { ok: false, message: "Nothing to apply." };
  const { workspaceId, processId, fileName, columnMap, rowCount, results, keys } = input;
  if (!isId(workspaceId) || !isId(processId)) return { ok: false, message: "That process isn't valid." };
  const kind = input.kind === undefined || input.kind === null ? "step_log" : input.kind;
  if (typeof kind !== "string" || !PROCESS_KINDS.includes(kind)) return { ok: false, message: "That kind of file isn't calibrated against a process." };
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 300) return { ok: false, message: "Give the log a name of up to 300 characters." };
  const map = parseColumnMap(kind as ProcessImportKind, columnMap);
  if (!map) return { ok: false, message: "The log's columns aren't valid." };
  const details = parseDetails(input.details);
  if (!details.ok) return { ok: false, message: "The import's details aren't valid." };
  if (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0 || rowCount > 1_000_000) return { ok: false, message: "The log's row count isn't valid." };
  if (!isObject(results) || !Array.isArray(results.proposals) || results.proposals.length > 2000) return { ok: false, message: "The proposals aren't valid." };
  const stored = storedResults(results) as ApplyRequest["results"];
  if (JSON.stringify(stored).length > MAX_RESULTS_BYTES) return { ok: false, message: "Too many proposals to save at once. Calibrate fewer steps." };
  if (!Array.isArray(keys) || keys.length > 2000) return { ok: false, message: "Tick at least one change to apply." };
  // Per-person times (#227): each rebuilt from known fields; one bad item refuses the request.
  const rawFactors = input.capacityFactors === undefined || input.capacityFactors === null ? [] : input.capacityFactors;
  if (!Array.isArray(rawFactors) || rawFactors.length > 2000) return { ok: false, message: "The per-person times aren't valid." };
  const capacityFactors: StoredFactorProposal[] = [];
  for (const raw of rawFactors) {
    const f = storedFactorProposal(raw);
    if (!f) return { ok: false, message: "The per-person times aren't valid." };
    capacityFactors.push(f);
  }
  if (new Set(capacityFactors.map((f) => f.key)).size !== capacityFactors.length) return { ok: false, message: "The per-person times aren't valid." };
  const known = new Set(results.proposals.map((p) => (isObject(p) ? p.key : null)));
  const knownFactors = new Set(capacityFactors.filter((f) => f.set).map((f) => f.key));
  const good: string[] = [];
  const skipped: ApplyRequest["skipped"] = [];
  for (const k of new Set(keys)) {
    if (typeof k === "string" && k.length <= 100 && KEY.test(k) && known.has(k)) good.push(k);
    else if (typeof k === "string" && FACTOR_KEY.test(k) && knownFactors.has(k)) good.push(k);
    else skipped.push({ key: typeof k === "string" ? k.slice(0, 100) : String(k), status: "not_proposed" });
  }
  if (!good.length) return { ok: false, message: "Tick at least one change to apply." };
  return {
    ok: true,
    request: { workspaceId, processId, kind: kind as ProcessImportKind, fileName: fileName.trim(), columnMap: map, rowCount, details: details.details, results: stored, keys: good, capacityFactors, skipped },
  };
}
