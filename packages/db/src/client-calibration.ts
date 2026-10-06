// Calibration from a clients file and a servicing log (issue #41, part 2; docs/PRD.md §6.6): reading the two files
// and turning stored rows into the engine's input.
//
// Both are CSV, pasted or uploaded on the Historical data page. Columns are found by their header, as for the step
// log (calibration.ts: case, spacing and punctuation ignored; common names accepted).
//
// Clients file, one row per client per service:
//
//   client    required  any id or name, used for counting only and never stored (D27)
//   service   required  the service's name as in Settings → Services
//   started   required  the date they became a client of that service
//   ended     optional  the date they left; blank means still a client
//
// Servicing log, one row per servicing task:
//
//   task       required  the servicing process's name ("Monthly report")
//   client     required  the same ids as the clients file, if both are given
//   due        required  when it was due. A date with no time, or exactly midnight (00:00) with no zone, is due at the end of that day.
//   done       optional  when it was done; blank means not done
//   requested  optional  when an ad-hoc request came in (for response times)
//
// Dates as in the step log: 2026-03-02, 2026-03-02 09:30, or 02/03/2026 (day and month order found from the whole
// file, or asked). Times without a zone are read as UTC: only differences matter. Pure: no I/O.

import type { ChurnServiceInput, ClientRow, ServicingLinkInput, ServicingRow } from "@transpera-flow/engine";
import {
  MAX_STEP_LOG_ROWS,
  columnSource,
  detectDateOrder,
  hasTimeOfDay,
  normHeader,
  parseLogTime,
  splitCsv,
  type DateOrder,
  type StepLogError,
} from "./calibration";
import { engineRecurrence } from "./servicing";
import type { ClientGroupRow, ProcessRow, ServiceRow, ServiceServicingRow } from "./types";

type Headers<C extends string> = Record<C, readonly string[]>;

interface Parsed<C extends string, R> {
  rows: R[];
  /** Which header each column was found under; a missing optional column is absent. */
  columns: Partial<Record<C, string>>;
  /** Required columns not found. When any is, `rows` is empty. */
  missing: C[];
  /** Rows that couldn't be read, with why. They are left out. */
  errors: StepLogError[];
  /** Data lines read (not counting the header or blank lines). */
  lines: number;
  /** How slashed dates were read: day first, month first, or null when the file has none. */
  dateOrder: DateOrder | null;
  /** Why nothing was read from the dates: `ambiguous` (ask which order) or `mixed`. `rows` is empty then. */
  dateProblem: "ambiguous" | "mixed" | null;
}

/** Finds each column's header by name (after normalising), each header used at most once. */
export function matchHeaders<C extends string>(
  header: readonly string[],
  columns: readonly C[],
  headers: Headers<C>,
): { index: Partial<Record<C, number>>; columns: Partial<Record<C, string>> } {
  const found: Partial<Record<C, string>> = {};
  const index: Partial<Record<C, number>> = {};
  const normalised = header.map(normHeader);
  for (const col of columns) {
    for (const name of headers[col]) {
      const i = normalised.findIndex((h, j) => h === name && !Object.values(index).includes(j));
      if (i >= 0) {
        index[col] = i;
        found[col] = header[i]!.trim();
        break;
      }
    }
  }
  return { index, columns: found };
}

export interface MappedSpec<C extends string, R> {
  columns: readonly C[];
  required: readonly C[];
  dateColumns: readonly C[];
  readRow: (cell: (c: C) => string, order: DateOrder) => R | string;
}

export interface MappedOptions {
  dateOrder?: DateOrder;
  /** Which non-blank record holds the column names (1-based, default 1). Records before it are skipped. */
  headerRow?: number;
  /** Called every 5,000 data rows with the rows done and the total. */
  onProgress?: (done: number, total: number) => void;
}

export const PROGRESS_EVERY = 5000;

export type MappedResult<C extends string, R> = Omit<Parsed<C, R>, "columns">;

/**
 * Reads the data rows of a table (`splitCsv`'s records, blank ones included) from the columns in `index`: settles the date
 * order, then hands each data row to `spec.readRow`. Line numbers count every record from the file's first, as in the file.
 */
export function readMappedRows<C extends string, R>(
  table: readonly string[][],
  index: Partial<Record<C, number>>,
  spec: MappedSpec<C, R>,
  options: MappedOptions = {},
): MappedResult<C, R> {
  const blank = (r: readonly string[]) => !r.some((c) => c.trim() !== "");
  const headerRow = Math.max(1, options.headerRow ?? 1);
  // Which record holds the names: the headerRow-th non-blank one.
  let headerAt = -1;
  for (let i = 0, seen = 0; i < table.length; i++) {
    if (blank(table[i]!)) continue;
    if (++seen === headerRow) {
      headerAt = i;
      break;
    }
  }
  const data: { r: readonly string[]; line: number }[] = [];
  if (headerAt >= 0) for (let i = headerAt + 1; i < table.length; i++) if (!blank(table[i]!)) data.push({ r: table[i]!, line: i + 1 });
  const lines = data.length;
  const missing = spec.required.filter((c) => index[c] === undefined);
  if (missing.length) return { rows: [], missing, errors: [], lines, dateOrder: null, dateProblem: null };

  const dateCells = (function* () {
    for (const { r } of data) for (const c of spec.dateColumns) if (index[c] !== undefined) yield r[index[c]!] ?? "";
  })();
  const detected = detectDateOrder(dateCells);
  if (detected === "mixed" || (detected === "ambiguous" && !options.dateOrder)) {
    return { rows: [], missing, errors: [], lines, dateOrder: null, dateProblem: detected };
  }
  const dateOrder: DateOrder | null = detected === "dmy" || detected === "mdy" ? detected : detected === "ambiguous" ? options.dateOrder! : null;

  const rows: R[] = [];
  const errors: StepLogError[] = [];
  let done = 0;
  for (const { r, line } of data) {
    if (rows.length >= MAX_STEP_LOG_ROWS) {
      errors.push({ line, message: `Only the first ${MAX_STEP_LOG_ROWS.toLocaleString("en-GB")} rows are read.` });
      break;
    }
    const cell = (c: C) => (index[c] === undefined ? "" : (r[index[c]!] ?? "").trim());
    const out = spec.readRow(cell, dateOrder ?? "dmy");
    if (typeof out === "string") errors.push({ line, message: out });
    else rows.push(out);
    if (options.onProgress && ++done % PROGRESS_EVERY === 0) options.onProgress(done, lines);
  }
  return { rows, missing, errors, lines, dateOrder, dateProblem: null };
}

/** Shared reader: finds the columns by their header names, then reads the rows (`readMappedRows`). */
function readTable<C extends string, R>(
  text: string,
  options: { dateOrder?: DateOrder },
  spec: MappedSpec<C, R> & { headers: Headers<C> },
): Parsed<C, R> {
  const table = splitCsv(text);
  const header = table.find((r) => r.some((c) => c.trim() !== "")) ?? [];
  const { index, columns } = matchHeaders(header, spec.columns, spec.headers);
  return { ...readMappedRows(table, index, spec, options), columns };
}

const CLIENT_HEADERS = ["client", "client id", "client name", "customer", "customer id", "account", "account id", "company"] as const;

// ---------------------------------------------------------------------------
// Clients file
// ---------------------------------------------------------------------------

export type ClientsColumn = "client" | "service" | "started" | "ended";

export const CLIENTS_COLUMNS: readonly ClientsColumn[] = ["client", "service", "started", "ended"];
export const REQUIRED_CLIENTS_COLUMNS: readonly ClientsColumn[] = ["client", "service", "started"];

/** Header names each column is found by, after normalising. */
export const CLIENTS_HEADERS: Record<ClientsColumn, readonly string[]> = {
  client: CLIENT_HEADERS,
  service: ["service", "service name", "product", "plan", "package", "engagement"],
  started: ["started", "start", "start date", "signed", "signed on", "won", "won on", "since", "joined"],
  ended: ["ended", "end", "end date", "left", "left on", "cancelled", "canceled", "churned", "churned on", "lost on"],
};

export type ParsedClients = Parsed<ClientsColumn, ClientRow>;

/** Reads one row of a clients file from a cell reader and the date order: the row, or why it can't be read. */
export function readClientRow(cell: (c: ClientsColumn) => string, order: DateOrder): ClientRow | string {
  const client = cell("client");
  const service = cell("service");
  const startedText = cell("started");
  if (!client || !service || !startedText) {
    return `Missing ${[!client && "client", !service && "service", !startedText && "started"].filter(Boolean).join(", ")}.`;
  }
  if (client.length > 200 || service.length > 200) return "A client or service name is over 200 characters.";
  const started = parseLogTime(startedText, order);
  if (started === null) return `Can't read the start "${startedText.slice(0, 40)}". Use 2026-03-02, or one order of day and month for every date.`;
  const endedText = cell("ended");
  const ended = endedText ? parseLogTime(endedText, order) : null;
  if (endedText && ended === null) return `Can't read the end "${endedText.slice(0, 40)}".`;
  if (ended !== null && ended < started) return "They left before they started.";
  return { client, service, started, ended };
}

/** Reads a clients file. Bad rows are reported and left out; slashed dates as for `parseStepLog`. */
export function parseClientsFile(text: string, options: { dateOrder?: DateOrder } = {}): ParsedClients {
  return readTable<ClientsColumn, ClientRow>(text, options, {
    columns: CLIENTS_COLUMNS,
    required: REQUIRED_CLIENTS_COLUMNS,
    headers: CLIENTS_HEADERS,
    dateColumns: ["started", "ended"],
    readRow: readClientRow,
  });
}

/** A template to download: the columns, and a few clients of Northbeam's two services. */
export const CLIENTS_TEMPLATE = [
  "client,service,started,ended",
  "C-001,SEO retainer,2025-01-13,",
  "C-002,SEO retainer,2025-02-03,2025-11-28",
  "C-003,PPC management,2025-03-10,",
  "C-004,PPC management,2025-04-07,2026-02-20",
  "C-005,SEO retainer,2025-06-02,",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Servicing log
// ---------------------------------------------------------------------------

export type ServicingLogColumn = "task" | "client" | "due" | "done" | "requested";

export const SERVICING_LOG_COLUMNS: readonly ServicingLogColumn[] = ["task", "client", "due", "done", "requested"];
export const REQUIRED_SERVICING_LOG_COLUMNS: readonly ServicingLogColumn[] = ["task", "client", "due"];

export const SERVICING_LOG_HEADERS: Record<ServicingLogColumn, readonly string[]> = {
  task: ["task", "task name", "deliverable", "activity", "type", "job", "servicing"],
  client: CLIENT_HEADERS,
  due: ["due", "due date", "due on", "deadline", "due by"],
  done: ["done", "done on", "completed", "completed on", "completed at", "finished", "delivered", "delivered on", "closed", "closed on"],
  requested: ["requested", "requested on", "requested at", "created", "created at", "created on", "opened", "raised", "received"],
};

export type ParsedServicingLog = Parsed<ServicingLogColumn, ServicingRow>;

/**
 * A due date as a deadline: a date alone, or exactly midnight with no zone (what spreadsheets write for a date), is due at
 * the end of that day. `dueAt` is the date as read (`parseLogTime`).
 */
export function dueDeadline(dueText: string, dueAt: number): number {
  const dateOnly = !hasTimeOfDay(dueText) || /[T ]0{1,2}:00(:00(\.0+)?)?$/i.test(dueText.trim());
  return dateOnly ? dueAt + 86_400_000 - 1 : dueAt;
}

/** Reads one row of a servicing log from a cell reader and the date order: the row, or why it can't be read. */
export function readServicingRow(cell: (c: ServicingLogColumn) => string, order: DateOrder): ServicingRow | string {
  const task = cell("task");
  const client = cell("client");
  const dueText = cell("due");
  if (!task || !client || !dueText) {
    return `Missing ${[!task && "task", !client && "client", !dueText && "due"].filter(Boolean).join(", ")}.`;
  }
  if (task.length > 200 || client.length > 200) return "A task or client name is over 200 characters.";
  const dueAt = parseLogTime(dueText, order);
  if (dueAt === null) return `Can't read the due date "${dueText.slice(0, 40)}". Use 2026-03-02 09:30, or one order of day and month for every date.`;
  const due = dueDeadline(dueText, dueAt);
  const doneText = cell("done");
  const done = doneText ? parseLogTime(doneText, order) : null;
  if (doneText && done === null) return `Can't read the done date "${doneText.slice(0, 40)}".`;
  const requestedText = cell("requested");
  const requested = requestedText ? parseLogTime(requestedText, order) : null;
  if (requestedText && requested === null) return `Can't read the requested date "${requestedText.slice(0, 40)}".`;
  if (done !== null && requested !== null && done < requested) return "It was done before it was requested.";
  return { task, client, due, done, requested };
}

/**
 * Reads a servicing log. A `due` with no time of day, or exactly midnight with no zone (spreadsheets write a date that way),
 * is the end of that day, so work done any time on its due day is
 * on time. Done before due is fine (early); done before requested is a row error.
 */
export function parseServicingLog(text: string, options: { dateOrder?: DateOrder } = {}): ParsedServicingLog {
  return readTable<ServicingLogColumn, ServicingRow>(text, options, {
    columns: SERVICING_LOG_COLUMNS,
    required: REQUIRED_SERVICING_LOG_COLUMNS,
    headers: SERVICING_LOG_HEADERS,
    dateColumns: ["due", "done", "requested"],
    readRow: readServicingRow,
  });
}

/** A template to download: the columns, and a few of Northbeam's servicing tasks. */
export const SERVICING_LOG_TEMPLATE = [
  "task,client,due,done,requested",
  "Monthly report,C-001,2026-03-06,2026-03-05 16:00,",
  "Monthly report,C-003,2026-03-06,2026-03-09 11:30,",
  "Client check-in,C-001,2026-03-13 17:00,2026-03-13 15:00,",
  "Client check-in,C-005,2026-03-13 17:00,,",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Stored rows to the engine's input
// ---------------------------------------------------------------------------

export interface ClientCalibrationRows {
  /** The workspace's services. */
  services: readonly Pick<ServiceRow, "id" | "name" | "pricing_model" | "active" | "entry_process_id">[];
  clientGroups: readonly Pick<ClientGroupRow, "id" | "service_id" | "client_count" | "churn_monthly" | "provenance">[];
  /** Servicing links, with SLA and recurrence. */
  servicing: readonly Pick<ServiceServicingRow, "service_id" | "process_id" | "sla_hours" | "recurrence">[];
  /** To name the servicing processes. */
  processes: readonly Pick<ProcessRow, "id" | "name" | "kind">[];
  hoursPerWeek: number;
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** The workspace's active services, each with its client group (if it has one) for the churn estimators. */
export function clientCalibrationServices(stored: Pick<ClientCalibrationRows, "services" | "clientGroups">): ChurnServiceInput[] {
  return stored.services
    .filter((s) => s.active)
    .map((s) => {
      const g = stored.clientGroups.find((x) => x.service_id === s.id);
      return {
        serviceId: s.id,
        name: s.name,
        pricingModel: s.pricing_model,
        group: g ? { id: g.id, churnMonthly: num(g.churn_monthly), count: num(g.client_count), source: columnSource(g.provenance, "churn_monthly") } : null,
      };
    });
}

/** The servicing processes each active service runs, with their SLA and whether they come in as ad-hoc requests. */
export function servicingLinks(stored: Pick<ClientCalibrationRows, "services" | "servicing" | "processes">): ServicingLinkInput[] {
  const active = new Set(stored.services.filter((s) => s.active).map((s) => s.id));
  const names = new Map(stored.processes.filter((p) => p.kind === "servicing").map((p) => [p.id, p.name]));
  const out: ServicingLinkInput[] = [];
  for (const l of stored.servicing) {
    const processName = names.get(l.process_id);
    if (!active.has(l.service_id) || processName === undefined) continue;
    const recurrence = engineRecurrence(l.recurrence);
    out.push({
      serviceId: l.service_id,
      processId: l.process_id,
      processName,
      slaHours: num(l.sla_hours),
      adhoc: recurrence !== null && "poissonPerMonth" in recurrence,
    });
  }
  return out;
}
