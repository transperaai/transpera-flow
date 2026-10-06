// Checks on what the Historical data page sends to the server for a clients file and a servicing log (issue #41, part 2)
// before anything is written. Row-level security and `record_client_calibration` decide who may write and what; this only
// refuses malformed input early, skips ticked keys that aren't proposals (with a reason), and rebuilds what is stored from
// known fields only, so nothing from the files (a client id, a name that matched nothing) is stored by accident (D27).
// Framework-free for tests.

import { CLIENTS_COLUMNS, SERVICING_LOG_COLUMNS } from "@transpera-flow/db/calibration";

export interface FileRecord {
  fileName: string;
  columnMap: Record<string, string>;
  rowCount: number;
}

export interface ClientApplyRequest {
  workspaceId: string;
  clients: FileRecord | null;
  log: FileRecord | null;
  results: StoredClientResults;
  /** Ticked keys that are proposals. None is allowed: the checks are recorded without applying anything. */
  keys: string[];
  /** Ticked keys left out, with why. */
  skipped: { key: string; status: "not_proposed" }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^churn:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The most the page sends as the calibration's results (the database allows 2 MB). */
export const MAX_RESULTS_BYTES = 900_000;

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
/** A list of names or a count of them, as a count: the names themselves are never stored. */
const count = (v: unknown): number => (Array.isArray(v) ? v.length : (finite(v) ?? 0));

export interface StoredChurnProposal {
  key: string;
  kind: "churn";
  target: { table: "client_groups"; id: string };
  subject: string;
  n: number;
  leavers: number;
  enough: boolean;
  currentSource: "estimated" | "entered" | "measured";
  current: number | null;
  measured: number | null;
  multiplier: number | null;
  proposed: number | null;
  changed: boolean;
  blocked: string | null;
  note: string;
  set: { churn_monthly: number } | null;
  before: { churn_monthly: number | null } | null;
}

export interface StoredCheck {
  id: "late" | "resp" | "onb";
  n: number;
  value: number | null;
  simulated: number | null;
  enough: boolean;
  blocked: string | null;
  note: string;
}

export interface StoredClientResults {
  kind: "clients";
  asOf: number | null;
  window: { from: number; to: number; weeks: number } | null;
  rows: number;
  clients: number;
  tasks: number;
  startsAfterAsOf: number;
  unmatchedServices: number;
  unmatchedTasks: number;
  noGroup: string[];
  proposals: StoredChurnProposal[];
  checks: StoredCheck[];
  run: { engineVersion: string; seed: number; reps: number; horizonWeeks: number; runs: number; converged: boolean; processIds: string[] } | null;
}

function storedProposal(p: unknown): StoredChurnProposal | null {
  if (!isObject(p) || typeof p.key !== "string" || !KEY.test(p.key) || p.kind !== "churn") return null;
  const target = isObject(p.target) ? p.target : null;
  if (!target || target.table !== "client_groups" || !isId(target.id)) return null;
  const set = isObject(p.set) && finite(p.set.churn_monthly) !== null ? { churn_monthly: finite(p.set.churn_monthly)! } : null;
  const before = isObject(p.before) ? { churn_monthly: finite(p.before.churn_monthly) } : null;
  const source = p.currentSource === "entered" || p.currentSource === "measured" ? p.currentSource : "estimated";
  return {
    key: p.key,
    kind: "churn",
    target: { table: "client_groups", id: target.id },
    subject: text(p.subject, 200) ?? "",
    n: finite(p.n) ?? 0,
    leavers: finite(p.leavers) ?? 0,
    enough: p.enough === true,
    currentSource: source,
    current: finite(p.current),
    measured: finite(p.measured),
    multiplier: finite(p.multiplier),
    proposed: finite(p.proposed),
    changed: p.changed === true,
    blocked: text(p.blocked, 600),
    note: text(p.note, 1000) ?? "",
    set,
    before: set ? before : null,
  };
}

function storedCheck(c: unknown): StoredCheck | null {
  if (!isObject(c) || (c.id !== "late" && c.id !== "resp" && c.id !== "onb")) return null;
  return {
    id: c.id,
    n: finite(c.n) ?? 0,
    value: finite(c.value),
    simulated: finite(c.simulated),
    enough: c.enough === true,
    blocked: text(c.blocked, 600),
    note: text(c.note, 1000) ?? "",
  };
}

/**
 * The calibration's results as stored: rebuilt from known fields only, never spread, so a field holding a client id (or
 * anything else the model doesn't have) is dropped. Names in the files that matched nothing are kept as counts. The notes
 * are built from numbers and the model's own names.
 */
export function storedClientResults(results: Record<string, unknown>): StoredClientResults {
  const w = isObject(results.window) ? results.window : null;
  const window = w && finite(w.from) !== null && finite(w.to) !== null && finite(w.weeks) !== null ? { from: finite(w.from)!, to: finite(w.to)!, weeks: finite(w.weeks)! } : null;
  const run = isObject(results.run) ? results.run : null;
  return {
    kind: "clients",
    asOf: finite(results.asOf),
    window,
    rows: finite(results.rows) ?? 0,
    clients: finite(results.clients) ?? 0,
    tasks: finite(results.tasks) ?? 0,
    startsAfterAsOf: finite(results.startsAfterAsOf) ?? 0,
    unmatchedServices: count(results.unmatchedServices),
    unmatchedTasks: count(results.unmatchedTasks),
    noGroup: (Array.isArray(results.noGroup) ? results.noGroup : []).map((n) => text(n, 200)).filter((n): n is string => n !== null).slice(0, 100),
    proposals: (Array.isArray(results.proposals) ? results.proposals : []).slice(0, 2000).map(storedProposal).filter((p): p is StoredChurnProposal => p !== null),
    checks: (Array.isArray(results.checks) ? results.checks : []).slice(0, 3).map(storedCheck).filter((c): c is StoredCheck => c !== null),
    run: run
      ? {
          engineVersion: text(run.engineVersion, 40) ?? "",
          seed: finite(run.seed) ?? 0,
          reps: finite(run.reps) ?? 0,
          horizonWeeks: finite(run.horizonWeeks) ?? 0,
          runs: finite(run.runs) ?? 0,
          converged: run.converged === true,
          processIds: (Array.isArray(run.processIds) ? run.processIds : []).filter(isId).slice(0, 50),
        }
      : null,
  };
}

function fileRecord(input: unknown, columns: readonly string[]): FileRecord | null | "bad" {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) return "bad";
  const { fileName, columnMap, rowCount } = input;
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 300) return "bad";
  if (!isObject(columnMap) || !Object.entries(columnMap).every(([k, v]) => columns.includes(k) && typeof v === "string" && v.length <= 200)) return "bad";
  if (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0 || rowCount > 1_000_000) return "bad";
  return { fileName: fileName.trim(), columnMap: columnMap as Record<string, string>, rowCount };
}

export function parseClientApplyRequest(input: unknown): { ok: true; request: ClientApplyRequest } | { ok: false; message: string } {
  if (!isObject(input)) return { ok: false, message: "Nothing to save." };
  const { workspaceId, results, keys } = input;
  if (!isId(workspaceId)) return { ok: false, message: "That workspace isn't valid." };
  const clients = fileRecord(input.clients, CLIENTS_COLUMNS);
  const log = fileRecord(input.log, SERVICING_LOG_COLUMNS);
  if (clients === "bad") return { ok: false, message: "The clients file's name or columns aren't valid." };
  if (log === "bad") return { ok: false, message: "The servicing log's name or columns aren't valid." };
  if (!clients && !log) return { ok: false, message: "Add a clients file or a servicing log first." };
  if (!isObject(results) || !Array.isArray(results.proposals) || results.proposals.length > 2000) return { ok: false, message: "The proposals aren't valid." };
  const stored = storedClientResults(results);
  if (JSON.stringify(stored).length > MAX_RESULTS_BYTES) return { ok: false, message: "Too much to save at once." };
  if (keys !== undefined && keys !== null && (!Array.isArray(keys) || keys.length > 2000)) return { ok: false, message: "The ticked changes aren't valid." };
  const known = new Set(stored.proposals.map((p) => p.key));
  const good: string[] = [];
  const skipped: ClientApplyRequest["skipped"] = [];
  for (const k of new Set((keys ?? []) as unknown[])) {
    if (typeof k === "string" && k.length <= 100 && KEY.test(k) && known.has(k)) good.push(k);
    else skipped.push({ key: typeof k === "string" ? k.slice(0, 100) : String(k), status: "not_proposed" });
  }
  return { ok: true, request: { workspaceId, clients, log, results: stored, keys: good, skipped } };
}
