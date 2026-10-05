// Checks on what the Calibration page sends to the server (issue #41) before anything is written. Row-level security and
// `apply_calibration` decide who may write and what; this only refuses malformed input early. Framework-free for tests.

import { STEP_LOG_COLUMNS, type StepLogColumn } from "@transpera-flow/db";

export interface ApplyRequest {
  workspaceId: string;
  processId: string;
  fileName: string;
  columnMap: Partial<Record<StepLogColumn, string>>;
  rowCount: number;
  results: { proposals: unknown[] } & Record<string, unknown>;
  keys: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The most the page sends as the calibration's results (the database allows 2 MB). */
export const MAX_RESULTS_BYTES = 900_000;

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
  if (JSON.stringify(results).length > MAX_RESULTS_BYTES) return { ok: false, message: "Too many proposals to save at once. Calibrate fewer steps." };
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 2000 || !keys.every((k) => typeof k === "string" && k.length <= 100)) {
    return { ok: false, message: "Tick at least one change to apply." };
  }
  const known = new Set(results.proposals.map((p) => (isObject(p) ? p.key : null)));
  if (!keys.every((k) => known.has(k))) return { ok: false, message: "A ticked change isn't one of the proposals." };
  return {
    ok: true,
    request: {
      workspaceId,
      processId,
      fileName: fileName.trim(),
      columnMap: columnMap as ApplyRequest["columnMap"],
      rowCount,
      results: results as ApplyRequest["results"],
      keys: [...new Set(keys as string[])],
    },
  };
}
