// Checks on what the Calibration page sends to the server (issue #41) before anything is written. Row-level security and
// `record_calibration` decide who may write and what; this only refuses malformed input early, skips ticked keys that
// aren't proposals (with a reason), and keeps free text from the log out of what is stored. Framework-free for tests.

import { STEP_LOG_COLUMNS, type StepLogColumn } from "@transpera-flow/db";

export interface ApplyRequest {
  workspaceId: string;
  processId: string;
  fileName: string;
  columnMap: Partial<Record<StepLogColumn, string>>;
  rowCount: number;
  results: { proposals: unknown[] } & Record<string, unknown>;
  keys: string[];
  /** Ticked keys left out, with why. */
  skipped: { key: string; status: "not_proposed" }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^(work|wait|rework|routing|arrivals):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The most the page sends as the calibration's results (the database allows 2 MB). */
export const MAX_RESULTS_BYTES = 900_000;

/**
 * The results as stored: the log's own names that matched nothing (step and lead source names typed in the file) are
 * kept as counts only, so no free text from the file is stored beyond names the model already has.
 */
export function storedResults(results: Record<string, unknown>): Record<string, unknown> {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const { unmatchedSteps, unmatchedSources, ...rest } = results;
  return { ...rest, unmatchedSteps: count(unmatchedSteps), unmatchedSources: count(unmatchedSources) };
}

export function parseApplyRequest(input: unknown): { ok: true; request: ApplyRequest } | { ok: false; message: string } {
  if (!isObject(input)) return { ok: false, message: "Nothing to apply." };
  const { workspaceId, processId, fileName, columnMap, rowCount, results, keys } = input;
  if (!isId(workspaceId) || !isId(processId)) return { ok: false, message: "That process isn't valid." };
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 300) return { ok: false, message: "Give the log a name of up to 300 characters." };
  if (!isObject(columnMap) || !Object.entries(columnMap).every(([k, v]) => (STEP_LOG_COLUMNS as readonly string[]).includes(k) && typeof v === "string" && v.length <= 200)) {
    return { ok: false, message: "The log's columns aren't valid." };
  }
  if (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0 || rowCount > 1_000_000) return { ok: false, message: "The log's row count isn't valid." };
  if (!isObject(results) || !Array.isArray(results.proposals) || results.proposals.length > 2000) return { ok: false, message: "The proposals aren't valid." };
  const stored = storedResults(results) as ApplyRequest["results"];
  if (JSON.stringify(stored).length > MAX_RESULTS_BYTES) return { ok: false, message: "Too many proposals to save at once. Calibrate fewer steps." };
  if (!Array.isArray(keys) || keys.length > 2000) return { ok: false, message: "Tick at least one change to apply." };
  const known = new Set(results.proposals.map((p) => (isObject(p) ? p.key : null)));
  const good: string[] = [];
  const skipped: ApplyRequest["skipped"] = [];
  for (const k of new Set(keys)) {
    if (typeof k === "string" && k.length <= 100 && KEY.test(k) && known.has(k)) good.push(k);
    else skipped.push({ key: typeof k === "string" ? k.slice(0, 100) : String(k), status: "not_proposed" });
  }
  if (!good.length) return { ok: false, message: "Tick at least one change to apply." };
  return {
    ok: true,
    request: { workspaceId, processId, fileName: fileName.trim(), columnMap: columnMap as ApplyRequest["columnMap"], rowCount, results: stored, keys: good, skipped },
  };
}
