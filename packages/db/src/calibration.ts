// Calibration from historical data (issue #41; docs/PRD.md §6.6): reading a
// step log and turning stored rows into the engine's calibration input.
//
// Until C1's import wizard (#40), the input is one CSV per process, pasted or
// uploaded on the Calibration page: one row per item per step it went
// through. Columns, found by their header (case, spacing and punctuation
// ignored; common names accepted):
//
//   item      required  what went through: a deal, a job, a report (any id)
//   step      required  the step's name as on the map ("Proposal", "Lost")
//   started   required  when the visit started: 2026-03-02, 2026-03-02 09:30,
//                       2026-03-02T09:30:00Z, or 02/03/2026 09:30 (day and
//                       month order found from the whole file, or asked)
//   finished  optional  when it finished (needed for waits)
//   hours     optional  hands-on hours spent (needed for hands-on time)
//   source    optional  the lead source an item came from (for leads a week)
//
// Times without a zone are read as UTC: only differences and weeks matter.
// Pure: no I/O, so the browser parses and the tests run it directly.

import type { CalibrationEdge, CalibrationInput, CalibrationLeadSource, CalibrationStep, CalibrationValueSource, StepLogRow } from "@transpera-flow/engine";
import type { EdgeRow, LeadSourceRow, ProcessRow, SeasonalityRow, ServiceRow, StepRow } from "./types";

export type StepLogColumn = "item" | "step" | "started" | "finished" | "hours" | "source";

export const STEP_LOG_COLUMNS: readonly StepLogColumn[] = ["item", "step", "started", "finished", "hours", "source"];
export const REQUIRED_STEP_LOG_COLUMNS: readonly StepLogColumn[] = ["item", "step", "started"];

/** Header names each column is found by, after normalising (lower case, letters and digits only, single spaces). */
export const STEP_LOG_HEADERS: Record<StepLogColumn, readonly string[]> = {
  item: ["item", "item id", "id", "deal", "deal id", "job", "job id", "ticket", "ticket id", "case", "case id", "reference", "ref", "entity"],
  step: ["step", "step name", "stage", "activity", "task", "status"],
  started: ["started", "start", "start time", "start date", "started at", "began", "entered", "entered at", "from"],
  finished: ["finished", "finish", "end", "end time", "end date", "ended", "finished at", "completed", "completed at", "done", "left", "to"],
  hours: ["hours", "hands on hours", "hands on", "work hours", "hours spent", "time spent", "effort", "effort hours", "duration hours"],
  source: ["source", "lead source", "channel", "origin"],
};

/** The most rows one log may have. */
export const MAX_STEP_LOG_ROWS = 200_000;

export interface StepLogError {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  message: string;
}

export interface ParsedStepLog {
  rows: StepLogRow[];
  /** Which header each column was found under; a missing optional column is absent. */
  columns: Partial<Record<StepLogColumn, string>>;
  /** Required columns not found. When any is, `rows` is empty. */
  missing: StepLogColumn[];
  /** Rows that couldn't be read, with why. They are left out. */
  errors: StepLogError[];
  /** Data lines read (not counting the header or blank lines). */
  lines: number;
  /** How slashed dates (02/03/2026) were read: day first, month first, or null when the file has none. */
  dateOrder: DateOrder | null;
  /**
   * Why nothing was read from the dates, if so: `ambiguous` (every slashed date reads both ways: ask which), or `mixed`
   * (some dates can only be day first and others only month first). `rows` is empty then.
   */
  dateProblem: "ambiguous" | "mixed" | null;
}

/** Day first (02/03/2026 is 2 March) or month first (02/03/2026 is 3 February). */
export type DateOrder = "dmy" | "mdy";

export const normHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Splits CSV (or tab- or semicolon-separated) text into rows of cells. Quotes as RFC 4180. */
export function splitCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const first = body.slice(0, body.search(/\r?\n/) === -1 ? body.length : body.search(/\r?\n/));
  const count = (ch: string) => first.split(ch).length - 1;
  const sep = count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
const SLASHED = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Which way round a file's slashed dates are: any first part over 12 means day first, any second part over 12 means
 * month first; both is `mixed`; neither (every date reads both ways) is `ambiguous`; no slashed dates at all is null.
 */
export function detectDateOrder(texts: Iterable<string>): DateOrder | "ambiguous" | "mixed" | null {
  let any = false;
  let dayFirst = false;
  let monthFirst = false;
  for (const t of texts) {
    const m = SLASHED.exec(t.trim());
    if (!m) continue;
    any = true;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return "mixed";
  if (dayFirst) return "dmy";
  if (monthFirst) return "mdy";
  return any ? "ambiguous" : null;
}

/** Whether a date cell carries a time of day (2026-03-02 09:30), as opposed to a date alone (2026-03-02). */
export function hasTimeOfDay(text: string): boolean {
  const s = text.trim();
  const m = ISO.exec(s) ?? SLASHED.exec(s);
  return m !== null && m[4] !== undefined;
}

/** A date or date-time as epoch milliseconds, or null. Slashed dates are read in `order` (day first unless told). */
export function parseLogTime(text: string, order: DateOrder = "dmy"): number | null {
  const s = text.trim();
  let y: number, mo: number, d: number, h = 0, mi = 0, se = 0;
  let zone: string | undefined;
  const iso = ISO.exec(s);
  const df = iso ? null : SLASHED.exec(s);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    h = Number(iso[4] ?? 0);
    mi = Number(iso[5] ?? 0);
    se = Number(iso[6] ?? 0);
    zone = iso[7];
  } else if (df) {
    [d, mo, y] = order === "dmy" ? [Number(df[1]), Number(df[2]), Number(df[3])] : [Number(df[2]), Number(df[1]), Number(df[3])];
    h = Number(df[4] ?? 0);
    mi = Number(df[5] ?? 0);
    se = Number(df[6] ?? 0);
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  let t = Date.UTC(y, mo - 1, d, h, mi, se);
  if (new Date(t).getUTCDate() !== d) return null; // 31 February
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.replace(/[^0-9]/g, "");
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  return t;
}

/**
 * Reads a step log. Bad rows are reported and left out; the rest are kept. Slashed dates are read the way the whole
 * file shows (`detectDateOrder`), or as `dateOrder` says when the file can't tell; they are never read both ways.
 */
export function parseStepLog(text: string, options: { dateOrder?: DateOrder } = {}): ParsedStepLog {
  const table = splitCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const header = table[0] ?? [];
  const columns: Partial<Record<StepLogColumn, string>> = {};
  const index: Partial<Record<StepLogColumn, number>> = {};
  const normalised = header.map(normHeader);
  for (const col of STEP_LOG_COLUMNS) {
    for (const name of STEP_LOG_HEADERS[col]) {
      const i = normalised.findIndex((h, j) => h === name && !Object.values(index).includes(j));
      if (i >= 0) {
        index[col] = i;
        columns[col] = header[i]!.trim();
        break;
      }
    }
  }
  const missing = REQUIRED_STEP_LOG_COLUMNS.filter((c) => index[c] === undefined);
  const lines = Math.max(0, table.length - 1);
  if (missing.length) return { rows: [], columns, missing, errors: [], lines, dateOrder: null, dateProblem: null };

  const dateCells = (function* () {
    for (const r of table.slice(1)) for (const c of ["started", "finished"] as const) if (index[c] !== undefined) yield r[index[c]!] ?? "";
  })();
  const detected = detectDateOrder(dateCells);
  if (detected === "mixed" || (detected === "ambiguous" && !options.dateOrder)) {
    return { rows: [], columns, missing, errors: [], lines, dateOrder: null, dateProblem: detected };
  }
  const dateOrder: DateOrder | null = detected === "dmy" || detected === "mdy" ? detected : detected === "ambiguous" ? options.dateOrder! : null;

  const rows: StepLogRow[] = [];
  const errors: StepLogError[] = [];
  const cell = (r: string[], c: StepLogColumn) => (index[c] === undefined ? "" : (r[index[c]!] ?? "").trim());
  // Line numbers count blank lines too, so they match the file.
  const all = splitCsv(text);
  let line = 0;
  let headerSeen = false;
  for (const r of all) {
    line++;
    if (!r.some((c) => c.trim() !== "")) continue;
    if (!headerSeen) {
      headerSeen = true;
      continue;
    }
    if (rows.length >= MAX_STEP_LOG_ROWS) {
      errors.push({ line, message: `Only the first ${MAX_STEP_LOG_ROWS.toLocaleString("en-GB")} rows are read.` });
      break;
    }
    const item = cell(r, "item");
    const step = cell(r, "step");
    const startedText = cell(r, "started");
    if (!item || !step || !startedText) {
      errors.push({ line, message: `Missing ${[!item && "item", !step && "step", !startedText && "started"].filter(Boolean).join(", ")}.` });
      continue;
    }
    if (item.length > 200 || step.length > 200) {
      errors.push({ line, message: "An item or step name is over 200 characters." });
      continue;
    }
    const started = parseLogTime(startedText, dateOrder ?? "dmy");
    if (started === null) {
      errors.push({ line, message: `Can't read the start "${startedText.slice(0, 40)}". Use 2026-03-02 09:30, or one order of day and month for every date.` });
      continue;
    }
    const finishedText = cell(r, "finished");
    const finished = finishedText ? parseLogTime(finishedText, dateOrder ?? "dmy") : null;
    if (finishedText && finished === null) {
      errors.push({ line, message: `Can't read the finish "${finishedText.slice(0, 40)}".` });
      continue;
    }
    if (finished !== null && finished < started) {
      errors.push({ line, message: "It finished before it started." });
      continue;
    }
    const hoursText = cell(r, "hours").replace(",", ".");
    const hours = hoursText ? Number(hoursText) : null;
    if (hours !== null && !(Number.isFinite(hours) && hours >= 0 && hours <= 10_000)) {
      errors.push({ line, message: `Hours "${cell(r, "hours").slice(0, 20)}" isn't a number of hours.` });
      continue;
    }
    const source = cell(r, "source");
    rows.push({ item, step, started, finished, hours, source: source ? source.slice(0, 200) : null });
  }
  return { rows, columns, missing, errors, lines, dateOrder, dateProblem: null };
}

/**
 * A file's bytes as text: UTF-8 (with or without a byte-order mark), UTF-16 with a byte-order mark (Excel's "Unicode
 * text"), or, when the bytes aren't valid UTF-8, Windows-1252 (Excel's plain "CSV" on Windows), saying so.
 */
export function decodeLogFile(bytes: Uint8Array): { text: string; note: string | null } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), note: null };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), note: null };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""), note: null };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      note: "The file isn't UTF-8, so it was read as Windows text. If names look wrong, save it as \"CSV UTF-8\" and choose it again.",
    };
  }
}

/** A template to download: the columns, and two items through three steps. */
export const STEP_LOG_TEMPLATE = [
  "item,step,started,finished,hours,source",
  "D-101,Qualify,2026-03-02 09:00,2026-03-02 10:30,1.5,Website",
  "D-101,Proposal,2026-03-03 13:00,2026-03-03 17:00,4,",
  "D-101,Client decides,2026-03-03 17:00,2026-03-10 11:00,,",
  "D-101,Won,2026-03-10 11:00,2026-03-10 11:00,,",
  "D-102,Qualify,2026-03-04 14:00,2026-03-04 15:00,1,Referral",
  "D-102,Lost,2026-03-05 09:00,2026-03-05 09:00,,",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Stored rows to the engine's input
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A value's provenance source from a per-column map; no entry is an estimate. */
export function columnSource(provenance: unknown, column: string): CalibrationValueSource {
  const entry = isObject(provenance) ? provenance[column] : null;
  const source = isObject(entry) ? entry.source : null;
  return source === "entered" || source === "measured" ? source : "estimated";
}

const cvOf = (params: unknown): number | null => {
  const cv = isObject(params) ? params.cv : null;
  const n = num(cv, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Where a step's branch odds came from. Edges carry no provenance: calibration records on the step what it measured
 * (`provenance.routing.probabilities`), and the odds count as measured while they still match it. Odds an upload left
 * out (`branch_odds`) or any branch without odds are estimates. Otherwise someone set them: entered.
 */
export function routingSource(step: Pick<StepRow, "id" | "provenance">, edges: readonly Pick<EdgeRow, "id" | "from_step_id" | "probability">[]): CalibrationValueSource {
  const out = edges.filter((e) => e.from_step_id === step.id);
  const prov = isObject(step.provenance) ? (step.provenance as Record<string, unknown>) : {};
  if (prov.branch_odds !== undefined || out.some((e) => e.probability === null || e.probability === undefined)) return "estimated";
  const routing = prov.routing;
  if (isObject(routing) && routing.source === "measured" && isObject(routing.probabilities)) {
    const measured = routing.probabilities;
    if (out.length === Object.keys(measured).length && out.every((e) => num(measured[e.id], NaN) === num(e.probability, NaN))) return "measured";
  }
  return "entered";
}

export function calibrationSteps(steps: readonly StepRow[], edges: readonly EdgeRow[]): CalibrationStep[] {
  return steps
    .filter((s) => !(s.replaced_by && s.replaced_by.length))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      parent: s.parent_step_id,
      entry: s.entry_step_id,
      holder: s.child_process_id !== null && s.child_process_id !== undefined,
      worked: Boolean(s.role_id || s.person_id),
      workHours: num(s.work_hours),
      workDist: s.work_dist,
      workCv: cvOf(s.work_params),
      waitHours: num(s.wait_hours),
      waitDist: s.wait_dist,
      waitCv: cvOf(s.wait_params),
      rework: num(s.rework_rate),
      sources: {
        work: columnSource(s.provenance, "work_hours"),
        wait: columnSource(s.provenance, "wait_hours"),
        rework: columnSource(s.provenance, "rework_rate"),
        routing: routingSource(s, edges),
      },
    }));
}

export function calibrationEdges(edges: readonly EdgeRow[]): CalibrationEdge[] {
  return edges.map((e) => ({
    id: e.id,
    from: e.from_step_id,
    to: e.to_step_id,
    probability: e.probability === null || e.probability === undefined ? null : num(e.probability),
    tagged: Boolean(e.condition_tag),
  }));
}

export function calibrationLeadSources(sources: readonly LeadSourceRow[]): CalibrationLeadSource[] {
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    volumeWeek: num(s.volume_week),
    conversion: num(s.conversion_to_qualified, 1),
    source: columnSource(s.provenance, "volume_week"),
  }));
}

/**
 * Whether new leads arrive at this process, so its log measures leads a week: a top-level pipeline that an active
 * service enters, or that every active service leaves to "the workspace's pipeline" (no entry set), as the model
 * builder decides which services arrive where.
 */
export function leadsArriveAt(
  process: Pick<ProcessRow, "id" | "kind" | "parent_process_id" | "is_company">,
  services: readonly Pick<ServiceRow, "active" | "entry_process_id">[],
): boolean {
  if (process.kind !== "pipeline" || process.parent_process_id || process.is_company) return false;
  const active = services.filter((s) => s.active);
  if (!active.length) return true;
  return active.some((s) => s.entry_process_id === process.id) || active.every((s) => s.entry_process_id === null);
}

export interface CalibrationRows {
  process: Pick<ProcessRow, "id" | "kind" | "parent_process_id" | "is_company">;
  steps: readonly StepRow[];
  edges: readonly EdgeRow[];
  services: readonly Pick<ServiceRow, "active" | "entry_process_id">[];
  leadSources: readonly LeadSourceRow[];
  seasonality: readonly Pick<SeasonalityRow, "month" | "multiplier">[];
  hoursPerWeek: number;
}

/** The engine's calibration input for a process's stored rows and a parsed log. */
export function calibrationInput(stored: CalibrationRows, rows: readonly StepLogRow[]): CalibrationInput {
  const seasonality = Array.from({ length: 12 }, (_, i) => num(stored.seasonality.find((r) => Number(r.month) === i + 1)?.multiplier, 1));
  return {
    steps: calibrationSteps(stored.steps, stored.edges),
    edges: calibrationEdges(stored.edges),
    rows,
    hoursPerWeek: stored.hoursPerWeek > 0 ? stored.hoursPerWeek : 40,
    leadSources: leadsArriveAt(stored.process, stored.services) ? calibrationLeadSources(stored.leadSources) : null,
    seasonality,
  };
}

export * from "./client-calibration";
