// Importing historical data (issue #40; docs/PRD.md §4.1 Company model, §5 datasets): the import wizard's pure core. A file is
// read into rows with columns the person has matched (suggested from the header names, correctable), checked row by row, and
// converted into the shapes calibration already reads (calibration.ts, client-calibration.ts).
//
// Eight kinds of file, each with its own columns:
//
//   step_log       a stage history: one row per item per step (the C2 step log). Feeds a process calibration as it is.
//   deals          deals from a CRM: one row per deal per stage it entered. Converted into a step log.
//   time_logs      time entries: several per job and step. Merged into visits (consecutive entries on the same task) and
//                  converted into a step log that carries hands-on hours only.
//   leads          one row per lead. A check only: leads a week per lead source, shown beside Settings.
//   clients        one row per client per service (the C2 clients file). Feeds churn as it is.
//   servicing_log  one row per servicing task (the C2 servicing log). Feeds the servicing checks as it is.
//   jobs           jobs or tickets with a due date. Converted into a servicing log.
//   invoices       invoices. A summary only (counts, late share): there is no cash model yet (D44).
//
// Names from the file (clients, people, deals, amounts) are used only on screen and to count, and never leave the browser
// (D27, #30). What may be stored is `ImportDetails`: numbers, enums and model ids, plus the header names the person matched.
// Pure: no I/O and no clock (`asOf` is passed in), so the browser's worker parses and the tests run it directly.

import { CALIBRATION_MIN_SAMPLE, CALIBRATION_MIN_WEEKS, type ClientRow, type ServicingRow, type StepLogRow } from "@transpera-flow/engine";
import {
  CLIENTS_HEADERS,
  CLIENTS_TEMPLATE,
  SERVICING_LOG_HEADERS,
  SERVICING_LOG_TEMPLATE,
  dueDeadline,
  readClientRow,
  readMappedRows,
  readServicingRow,
  type MappedOptions,
} from "./client-calibration";
import {
  STEP_LOG_HEADERS,
  STEP_LOG_TEMPLATE,
  decodeLogFile,
  detectDelimiter,
  normHeader,
  parseLogTime,
  readStepLogRow,
  splitCsv,
  type DateOrder,
} from "./calibration";

export type ImportKind = "step_log" | "deals" | "time_logs" | "leads" | "clients" | "servicing_log" | "jobs" | "invoices";
export type ImportShape = "step_log" | "clients" | "servicing_log" | "leads" | "invoices";
export type ColumnType = "id" | "name" | "client" | "person" | "date" | "number" | "duration" | "amount";

export interface ImportColumn {
  /** The column id stored in `column_map`. */
  id: string;
  /** Shown in the mapper. */
  label: string;
  required: boolean;
  type: ColumnType;
  /** Header names it is found by, normalised with `normHeader`. */
  aliases: readonly string[];
  /** For the (i). */
  help: { description: string; example: string };
}

export interface ImportKindSpec {
  kind: ImportKind;
  label: string;
  shape: ImportShape;
  /** The column whose values are matched to names in the model (steps, services, servicing processes, lead sources), if any. */
  nameColumn: string | null;
  columns: readonly ImportColumn[];
  /** A CSV to download, 4-6 lines. */
  template: string;
  help: { description: string; example: string };
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

const CLIENT_ALIASES = ["client", "client id", "client name", "customer", "customer id", "account", "account id", "company"] as const;

const col = (
  id: string,
  label: string,
  required: boolean,
  type: ColumnType,
  aliases: readonly string[],
  description: string,
  example: string,
): ImportColumn => ({ id, label, required, type, aliases, help: { description, example } });

const STEP_LOG_COLS: readonly ImportColumn[] = [
  col("item", "Item", true, "id", STEP_LOG_HEADERS.item, "What went through the process: a deal, a job, a report. Any id works; it is used to follow one item from step to step.", "D-101"),
  col("step", "Step", true, "name", STEP_LOG_HEADERS.step, "The step's name, as on your map.", "Discovery call"),
  col("started", "Started", true, "date", STEP_LOG_HEADERS.started, "When the item started the step.", "2026-03-02 09:30"),
  col("finished", "Finished", false, "date", STEP_LOG_HEADERS.finished, "When it finished the step. Needed to measure waits.", "2026-03-02 10:30"),
  col("hours", "Hands-on hours", false, "duration", STEP_LOG_HEADERS.hours, "Hours of hands-on work in the step. Needed to measure hands-on time.", "1.5"),
  col("source", "Lead source", false, "name", STEP_LOG_HEADERS.source, "Where the item came from. Needed to measure leads a week for each source.", "Website enquiries"),
];

const DEALS_COLS: readonly ImportColumn[] = [
  col("deal", "Deal", true, "id", ["deal", "deal id", "record id", "deal name", "opportunity", "opportunity id", "id"], "The deal. Any id or name works; it is used to follow one deal from stage to stage, and is never shown.", "D-101"),
  col("stage", "Stage", true, "name", ["stage", "deal stage", "pipeline stage", "stage name", "status"], "The pipeline stage the deal entered. Names are matched to your steps in the next step.", "Qualified lead"),
  col("entered", "Date entered", true, "date", ["entered", "date entered", "entered stage", "stage entered", "entered at", "changed at", "date changed", "moved at", "date"], "When the deal entered the stage.", "2026-03-02 09:30"),
  col("left", "Date left", false, "date", ["left", "date left", "exited", "exited at", "left stage", "stage left"], "When the deal left the stage. Needed to measure waits.", "2026-03-03 11:00"),
  col("source", "Lead source", false, "name", ["source", "lead source", "original source", "deal source", "channel"], "Where the deal came from. Needed to measure leads a week for each source.", "Website enquiries"),
  col("amount", "Amount", false, "amount", ["amount", "value", "deal value", "deal amount"], "The deal's value. Shown to owners and editors only, and never kept.", "4500"),
  col("owner", "Owner", false, "person", ["owner", "deal owner", "sales rep", "rep", "assigned to", "user"], "Who owns the deal. Never shown, kept or matched to people.", "A sales rep"),
];

const TIME_LOG_COLS: readonly ImportColumn[] = [
  col("job", "Job", true, "id", ["job", "job id", "project", "ticket", "task id", "item", "reference", "matter"], "The job the time was spent on. Entries on the same job are put in order of date.", "J-101"),
  col("task", "Task", true, "name", ["task", "task name", "activity", "step", "service item", "description"], "What the time was spent on. Names are matched to your steps in the next step.", "Audit & proposal"),
  col("date", "Date", true, "date", ["date", "start date", "started", "day", "spent on", "logged on"], "The day the time was logged.", "2026-03-03"),
  col("hours", "Hours", true, "duration", ["hours", "duration", "time", "time spent", "logged hours", "quantity"], "How long the entry was. 1.5, 1:30 and 1h 30m all work.", "1.5"),
  col("person", "Person", false, "person", ["person", "user", "member", "team member", "employee", "staff", "name"], "Who logged the time. Never shown, kept or matched to people.", "A team member"),
  col("client", "Client", false, "client", ["client", "customer", "account", "company"], "The job's client. Never shown or kept; used only to count.", "C-001"),
];

const LEADS_COLS: readonly ImportColumn[] = [
  col("lead", "Lead", false, "id", ["lead", "lead id", "contact", "contact id", "id"], "The lead. Any id works; it is only counted.", "L-1001"),
  col("created", "Date created", true, "date", ["created", "created at", "create date", "date created", "date added", "received", "submitted", "date"], "When the lead came in.", "2026-03-02"),
  col("source", "Lead source", true, "name", ["source", "lead source", "original source", "channel", "origin", "utm source"], "Where the lead came from. Names are matched to your lead sources in the next step.", "Google Ads"),
];

const CLIENTS_COLS: readonly ImportColumn[] = [
  col("client", "Client", true, "client", CLIENTS_HEADERS.client, "The client. Any id or name works; it is used for counting only and never kept.", "C-001"),
  col("service", "Service", true, "name", CLIENTS_HEADERS.service, "The service's name, as in Settings → Services.", "SEO retainer"),
  col("started", "Started", true, "date", CLIENTS_HEADERS.started, "The date they became a client of that service.", "2025-01-13"),
  col("ended", "Ended", false, "date", CLIENTS_HEADERS.ended, "The date they left. Blank means still a client.", "2025-11-28"),
];

const SERVICING_COLS: readonly ImportColumn[] = [
  col("task", "Task", true, "name", SERVICING_LOG_HEADERS.task, "The servicing process's name.", "Monthly report"),
  col("client", "Client", true, "client", SERVICING_LOG_HEADERS.client, "The client. Use the same ids as the clients file. Counted only, never kept.", "C-001"),
  col("due", "Due", true, "date", SERVICING_LOG_HEADERS.due, "When it was due. A date with no time is due at the end of that day.", "2026-03-06"),
  col("done", "Done", false, "date", SERVICING_LOG_HEADERS.done, "When it was done. Blank means not done.", "2026-03-05 16:00"),
  col("requested", "Requested", false, "date", SERVICING_LOG_HEADERS.requested, "When an ad-hoc request came in. Needed for response times.", "2026-03-04 09:00"),
];

const JOBS_COLS: readonly ImportColumn[] = [
  col("job", "Job", false, "id", ["job", "job id", "ticket", "ticket id", "id", "number", "reference"], "The job or ticket. Any id works; it is only counted.", "T-2041"),
  col("type", "Type", true, "name", ["type", "job type", "ticket type", "request type", "issue type", "category", "task", "servicing"], "What kind of job it is. Names are matched to your servicing processes in the next step.", "Monthly report"),
  col("client", "Client", true, "client", [...CLIENT_ALIASES, "organization", "organisation", "company name", "account name", "requester company"], "The client. Counted only, never shown or kept.", "C-001"),
  col("due", "Due", true, "date", ["due", "due date", "due on", "due by", "deadline", "sla due", "resolution due"], "When it was due. A date with no time is due at the end of that day.", "2026-03-06"),
  col("closed", "Closed", false, "date", ["closed", "closed at", "resolved", "resolved at", "solved", "solved at", "completed", "completed at", "done"], "When it was closed. Blank means still open.", "2026-03-05 16:00"),
  col("opened", "Opened", false, "date", ["opened", "opened at", "created", "created at", "raised", "submitted", "requested", "received"], "When it was opened. Needed for response times.", "2026-03-04 09:00"),
  col("assignee", "Assignee", false, "person", ["assignee", "assigned to", "agent", "owner", "handled by"], "Who handled it. Never shown, kept or matched to people.", "An agent"),
];

const INVOICES_COLS: readonly ImportColumn[] = [
  col("invoice", "Invoice", false, "id", ["invoice", "invoice number", "invoice no", "number", "id", "reference"], "The invoice number. Only counted.", "INV-0042"),
  col("client", "Client", true, "client", CLIENT_ALIASES, "The client. Counted only, never shown or kept.", "C-001"),
  col("issued", "Date issued", true, "date", ["issued", "issue date", "invoice date", "date", "created"], "When the invoice was issued.", "2026-03-02"),
  col("due", "Date due", false, "date", ["due", "due date", "payment due"], "When payment was due.", "2026-03-30"),
  col("paid", "Date paid", false, "date", ["paid", "paid on", "paid date", "date paid", "payment date"], "When it was paid. Blank means unpaid.", "2026-04-02"),
  col("amount", "Amount", false, "amount", ["amount", "total", "total amount", "amount due", "gross", "net", "value"], "The invoice total. Shown to owners and editors only, and never kept.", "1200.00"),
];

const DEALS_TEMPLATE = [
  "deal,stage,entered,left,source,amount,owner",
  "D-101,Qualified lead,2026-03-02 09:00,2026-03-03 13:00,Website enquiries,4500,Sales rep 1",
  "D-101,Discovery call,2026-03-03 13:00,2026-03-10 11:00,Website enquiries,4500,Sales rep 1",
  "D-101,Closed won,2026-03-10 11:00,,Website enquiries,4500,Sales rep 1",
  "D-102,Qualified lead,2026-03-04 14:00,2026-03-05 09:00,Client referrals,2800,Sales rep 2",
  "D-102,Closed lost,2026-03-05 09:00,,Client referrals,2800,Sales rep 2",
  "",
].join("\n");

const TIME_LOGS_TEMPLATE = [
  "job,task,date,hours,person,client",
  "J-101,Qualify lead,2026-03-02,0.75,Team member 1,C-001",
  "J-101,Discovery call,2026-03-03,1.5,Team member 1,C-001",
  "J-101,Audit & proposal,2026-03-04,4,Team member 2,C-001",
  "J-101,Audit & proposal,2026-03-05,3:00,Team member 2,C-001",
  "J-102,Qualify lead,2026-03-04,1h 15m,Team member 1,C-002",
  "",
].join("\n");

const LEADS_TEMPLATE = [
  "lead,created,source",
  "L-1001,2026-03-02,Website enquiries",
  "L-1002,2026-03-02,Google Ads",
  "L-1003,2026-03-03,Client referrals",
  "L-1004,2026-03-04,Website enquiries",
  "L-1005,2026-03-05,Google Ads",
  "",
].join("\n");

const JOBS_TEMPLATE = [
  "job,type,client,due,closed,opened,assignee",
  "T-2041,Monthly report,C-001,2026-03-06,2026-03-05 16:00,,Agent 1",
  "T-2042,Monthly report,C-003,2026-03-06,2026-03-09 11:30,,Agent 2",
  "T-2043,Client check-in,C-001,2026-03-13 17:00,2026-03-13 15:00,,Agent 1",
  "T-2044,Client check-in,C-005,2026-03-13 17:00,,,Agent 2",
  "",
].join("\n");

const INVOICES_TEMPLATE = [
  "invoice,client,issued,due,paid,amount",
  "INV-0042,C-001,2026-03-02,2026-03-30,2026-03-28,1200.00",
  "INV-0043,C-003,2026-03-02,2026-03-30,2026-04-06,950.00",
  "INV-0044,C-002,2026-03-09,2026-04-06,,1200.00",
  "INV-0045,C-005,2026-03-16,2026-04-13,2026-04-10,640.00",
  "",
].join("\n");

export const IMPORT_KINDS: Record<ImportKind, ImportKindSpec> = {
  step_log: {
    kind: "step_log",
    label: "Stage history (step log)",
    shape: "step_log",
    nameColumn: "step",
    columns: STEP_LOG_COLS,
    template: STEP_LOG_TEMPLATE,
    help: {
      description: "One row for each time an item (a deal, a job) went through a step. Measures how long steps take, waits, redo rates, branch odds and leads a week.",
      example: "Item D-101 started Discovery call on 2 March and finished on 3 March.",
    },
  },
  deals: {
    kind: "deals",
    label: "Deals from your CRM",
    shape: "step_log",
    nameColumn: "stage",
    columns: DEALS_COLS,
    template: DEALS_TEMPLATE,
    help: {
      description: "A CRM export with one row for each stage a deal went through. It is read as a stage history. A list with one row for each deal is not enough.",
      example: "Deal D-101 entered Qualified lead on 2 March and left on 3 March.",
    },
  },
  time_logs: {
    kind: "time_logs",
    label: "Time logs",
    shape: "step_log",
    nameColumn: "task",
    columns: TIME_LOG_COLS,
    template: TIME_LOGS_TEMPLATE,
    help: {
      description: "Time entries on jobs. Entries in a row on the same task are one visit. Only hands-on time is measured from them, not waits or branch odds.",
      example: "Job J-101: Audit & proposal, 4 hours on 4 March and 3 hours on 5 March.",
    },
  },
  leads: {
    kind: "leads",
    label: "Leads",
    shape: "leads",
    nameColumn: "source",
    columns: LEADS_COLS,
    template: LEADS_TEMPLATE,
    help: {
      description: "One row for each lead. Shows leads a week for each lead source beside what Settings has now. It is a check only and changes nothing.",
      example: "Lead L-1001 came in from Google Ads on 2 March.",
    },
  },
  clients: {
    kind: "clients",
    label: "Clients",
    shape: "clients",
    nameColumn: "service",
    columns: CLIENTS_COLS,
    template: CLIENTS_TEMPLATE,
    help: {
      description: "One row for each client for each service they bought. Measures how many leave each month.",
      example: "Client C-002 bought SEO retainer on 3 February 2025 and left on 28 November 2025.",
    },
  },
  servicing_log: {
    kind: "servicing_log",
    label: "Servicing log",
    shape: "servicing_log",
    nameColumn: "task",
    columns: SERVICING_COLS,
    template: SERVICING_LOG_TEMPLATE,
    help: {
      description: "One row for each servicing task. Measures how often it is late and how long requests take.",
      example: "The Monthly report for client C-001 was due on 6 March and done on 5 March.",
    },
  },
  jobs: {
    kind: "jobs",
    label: "Jobs or tickets",
    shape: "servicing_log",
    nameColumn: "type",
    columns: JOBS_COLS,
    template: JOBS_TEMPLATE,
    help: {
      description: "Jobs or tickets with a due date, from a helpdesk or job tracker. They are read as a servicing log.",
      example: "Ticket T-2041, a Monthly report for client C-001, was due on 6 March and closed on 5 March.",
    },
  },
  invoices: {
    kind: "invoices",
    label: "Invoices",
    shape: "invoices",
    nameColumn: null,
    columns: INVOICES_COLS,
    template: INVOICES_TEMPLATE,
    help: {
      description: "One row for each invoice. Shows counts and how many were paid late. Late payments aren't simulated yet, so it changes nothing.",
      example: "Invoice INV-0043 was due on 30 March and paid on 6 April.",
    },
  },
};

export const IMPORT_KIND_LIST = Object.keys(IMPORT_KINDS) as ImportKind[];

/** The field of a shape's rows that holds the name matched to the model. */
export const SHAPE_NAME_FIELD: Record<ImportShape, string | null> = {
  step_log: "step",
  clients: "service",
  servicing_log: "task",
  leads: "source",
  invoices: null,
};

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
export const PREVIEW_ROWS = 20;
export const MAX_IMPORT_ERRORS = 200;
export const MAX_IMPORT_NAMES = 500;

// ---------------------------------------------------------------------------
// Headers and suggested mappings
// ---------------------------------------------------------------------------

/** Headers as shown: an empty one is `Column N` (1-based), and a repeat gets ` (2)`, ` (3)`. */
export function displayHeaders(raw: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() === "" ? `Column ${i + 1}` : h.trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export type MatchHow = "previous" | "name" | "partial";

/**
 * What `column_map` holds for a column matched to a header. A client, person, id or amount column is stored by position (`Column 4`),
 * never by the header text: a file with no header row makes its first data row the "headers", and a name or an amount must not
 * reach the database that way. Other columns keep the header name (at most 60 characters).
 */
export function columnMapValue(column: ImportColumn, header: string, index: number): string {
  return column.type === "client" || column.type === "person" || column.type === "id" || column.type === "amount" ? `Column ${index + 1}` : header.trim().slice(0, 60);
}

const POSITIONAL = /^Column (\d+)$/;

const words = (h: string) => normHeader(h).split(" ").filter(Boolean);

/** Whether `run` appears in `hay` as consecutive whole words. */
function containsRun(hay: readonly string[], run: readonly string[]): boolean {
  if (!run.length || run.length > hay.length) return false;
  for (let i = 0; i + run.length <= hay.length; i++) if (run.every((w, j) => hay[i + j] === w)) return true;
  return false;
}

/**
 * Suggests which header holds each column: from the earlier import's choice (`previous`: column id to header name), then a
 * header named like the column or one of its aliases, then (required columns only) a header that contains an alias as whole
 * words ("Deal Stage Name" contains "stage"; "Stagecoach" doesn't). Required columns are taken first and a header is used
 * at most once. Deterministic: nothing is read from the values.
 */
export function suggestMapping(
  headers: readonly string[],
  kind: ImportKind,
  previous?: Record<string, string> | null,
): { index: Record<string, number | null>; how: Record<string, MatchHow | null> } {
  const spec = IMPORT_KINDS[kind];
  const shown = displayHeaders(headers).map(normHeader);
  const used = new Set<number>();
  const index: Record<string, number | null> = {};
  const how: Record<string, MatchHow | null> = {};
  for (const c of spec.columns) {
    index[c.id] = null;
    how[c.id] = null;
  }
  const free = (j: number) => !used.has(j);
  const take = (c: ImportColumn, i: number, h: MatchHow) => {
    index[c.id] = i;
    how[c.id] = h;
    used.add(i);
  };
  const ordered = [...spec.columns.filter((c) => c.required), ...spec.columns.filter((c) => !c.required)];
  for (const c of ordered) {
    const prev = previous?.[c.id];
    const spot = typeof prev === "string" ? POSITIONAL.exec(prev) : null;
    if (spot && (c.type === "client" || c.type === "person" || c.type === "id" || c.type === "amount")) {
      // Stored by position: the same position, if the file still has it.
      const i = Number(spot[1]) - 1;
      if (i >= 0 && i < shown.length && free(i)) {
        take(c, i, "previous");
        continue;
      }
    } else if (typeof prev === "string" && prev.trim() !== "") {
      const want = normHeader(prev);
      const i = shown.findIndex((h, j) => free(j) && h === want);
      if (i >= 0) {
        take(c, i, "previous");
        continue;
      }
    }
    let found = -1;
    for (const name of [normHeader(c.label), ...c.aliases.map(normHeader)]) {
      found = shown.findIndex((h, j) => free(j) && h === name && h !== "");
      if (found >= 0) break;
    }
    if (found >= 0) {
      take(c, found, "name");
      continue;
    }
    if (!c.required) continue;
    const runs = c.aliases.map(words);
    found = headers.findIndex((_, j) => free(j) && runs.some((run) => containsRun(shown[j]!.split(" "), run)));
    if (found >= 0) take(c, found, "partial");
  }
  return { index, how };
}

// ---------------------------------------------------------------------------
// Durations and amounts
// ---------------------------------------------------------------------------

/** What a plain number in a duration column counts: hours (the default), minutes or seconds (Jira exports seconds). */
export type DurationUnit = "hours" | "minutes" | "seconds";

const UNIT_HOURS: Record<DurationUnit, number> = { hours: 1, minutes: 60, seconds: 3600 };

/**
 * A length of time as hours: decimal hours with a dot or a comma (1.5, 1,5), h:mm or hh:mm:ss (1:30, 01:30:00), and 1h 30m,
 * 1h30, 1h, 90m, 90 min, 90 mins. A plain number (no unit) is in `bare` (hours unless the person says otherwise), so a column
 * of seconds is never read as hours. Not negative, and at most 10,000 hours; anything else is null.
 */
export function parseDuration(text: string, bare: DurationUnit = "hours"): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  let hours: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:[.,]\d+)?|[.,]\d+)$/.exec(s))) hours = Number(m[1]!.replace(",", ".")) / UNIT_HOURS[bare];
  else if ((m = /^(\d+)\s*h\s*([0-5]?\d)$/.exec(s))) hours = Number(m[1]) + Number(m[2]) / 60;
  else if ((m = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(s))) hours = Number(m[1]) + Number(m[2]) / 60 + Number(m[3] ?? 0) / 3600;
  else if ((m = /^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:[.,]\d+)?)\s*m(?:ins?|inutes?)?)?$/.exec(s)) && (m[1] !== undefined || m[2] !== undefined)) {
    hours = Number((m[1] ?? "0").replace(",", ".")) + Number((m[2] ?? "0").replace(",", ".")) / 60;
  }
  if (hours === null || !Number.isFinite(hours) || hours < 0 || hours > 10_000) return null;
  return hours;
}

/**
 * An amount of money as a number: one leading or trailing currency symbol or code (£ $ € A$ AUD GBP USD EUR) and spaces are
 * dropped; (123.45) and -123.45 are negative; 1,234.50 (comma thousands), 1.234,50 (dot thousands; whichever separator
 * comes last is the decimal point) and 1 234,50 (space thousands) are read. Anything else is null.
 */
export function parseAmount(text: string): number | null {
  let s = text.trim();
  if (!s) return null;
  let negative = false;
  const bracket = /^\((.*)\)$/.exec(s);
  if (bracket) {
    negative = true;
    s = bracket[1]!.trim();
  }
  s = s.replace(/^(?:A\$|AUD|GBP|USD|EUR|[£$€])\s*/i, "").replace(/\s*(?:A\$|AUD|GBP|USD|EUR|[£$€])$/i, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }
  s = s.replace(/^(?:A\$|AUD|GBP|USD|EUR|[£$€])\s*/i, ""); // -£5
  if (!s || !/^[\d.,\s]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let digits: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const [dec, thou] = lastDot > lastComma ? [".", ","] : [",", "."];
    const whole = s.slice(0, s.lastIndexOf(dec));
    const frac = s.slice(s.lastIndexOf(dec) + 1);
    if (whole.includes(dec) || frac.includes(thou) || /\s/.test(frac) || !/^\d+$/.test(frac)) return null;
    if (!groupsOk(whole.split(thou))) return null;
    digits = `${whole.split(thou).join("")}.${frac}`;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    if (parts.length > 2) {
      if (!groupsOk(parts.map((p) => p.trim()))) return null; // 1,234,567 or 1.234.567: thousands
      digits = parts.map((p) => p.replace(/\s/g, "")).join("");
    } else {
      const [a, b] = parts as [string, string];
      // 1,234 is ambiguous; with exactly three digits after a comma it is thousands, after a dot a decimal.
      if (sep === "," && /^\d{3}$/.test(b) && /^[1-9]\d{0,2}$/.test(a.trim())) digits = a.replace(/\s/g, "") + b;
      else if (!/^\d*$/.test(b) || /\s/.test(b)) return null;
      else digits = `${a.replace(/\s/g, "")}.${b}`;
    }
  } else {
    if (/\s/.test(s) && !groupsOk(s.split(/\s+/))) return null;
    digits = s.replace(/\s/g, "");
  }
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Thousands groups: the first has 1-3 digits and the rest exactly 3 (spaces inside a group are not allowed). */
function groupsOk(parts: readonly string[]): boolean {
  if (parts.length < 2) return true;
  return /^\d{1,3}$/.test(parts[0]!.trim()) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

// ---------------------------------------------------------------------------
// Rows of the new kinds
// ---------------------------------------------------------------------------

export interface DealRow {
  deal: string;
  stage: string;
  entered: number;
  left: number | null;
  source: string | null;
  /** On screen only (owners and editors); never stored. */
  amount: number | null;
  owner: string | null;
}

export interface TimeLogRow {
  job: string;
  task: string;
  date: number;
  hours: number;
  person: string | null;
  client: string | null;
}

export interface LeadRow {
  lead: string | null;
  created: number;
  source: string;
}

export interface JobRow {
  job: string | null;
  type: string;
  client: string;
  /** The deadline: a date alone is the end of that day, exactly as in a servicing log. */
  due: number;
  closed: number | null;
  opened: number | null;
  assignee: string | null;
}

export interface InvoiceRow {
  invoice: string | null;
  client: string;
  issued: number;
  due: number | null;
  paid: number | null;
  amount: number | null;
}

export type ShapeRow = StepLogRow | ClientRow | ServicingRow | LeadRow | InvoiceRow;
type KindRow = StepLogRow | DealRow | TimeLogRow | ClientRow | ServicingRow | LeadRow | JobRow | InvoiceRow;

const EXCEL_SERIAL = /^\d{5}(?:\.\d+)?$/;

/** Reads a row of one of the new kinds from its columns: the row, or why it can't be read. */
/** What a read counts as it goes, beside the rows. */
interface ReadCtx {
  /** Amounts that couldn't be read: the row is kept with the amount left blank. */
  badAmounts: number;
  /** What a plain number in a duration column counts. */
  durationUnit: DurationUnit;
}

function readNewRow(spec: ImportKindSpec, cell: (c: string) => string, order: DateOrder, ctx: ReadCtx): KindRow | string {
  const missing = spec.columns.filter((c) => c.required && !cell(c.id)).map((c) => c.id);
  if (missing.length) return `Missing ${missing.join(", ")}.`;
  const out: Record<string, string | number | null> = {};
  for (const c of spec.columns) {
    const text = cell(c.id);
    if (!text) {
      out[c.id] = null;
      continue;
    }
    switch (c.type) {
      case "id":
      case "name":
      case "client":
      case "person":
        if (text.length > 200) return `The ${c.label.toLowerCase()} is over 200 characters.`;
        out[c.id] = text;
        break;
      case "date": {
        const t = parseLogTime(text, order);
        if (t === null) {
          return EXCEL_SERIAL.test(text)
            ? `Can't read the date "${text}". Format the column as a date in Excel before saving.`
            : `Can't read the ${c.label.toLowerCase()} "${text.slice(0, 40)}". Use 2026-03-02 09:30, or one order of day and month for every date.`;
        }
        out[c.id] = t;
        break;
      }
      case "duration": {
        const h = parseDuration(text, ctx.durationUnit);
        if (h === null) return `${c.label} "${text.slice(0, 20)}" isn't a number of hours.`;
        out[c.id] = h;
        break;
      }
      case "amount": {
        // Nothing is calibrated from an amount, so a row with one that can't be read (TBD, 4.5k) is kept and the amount left blank,
        // and the read says how many. The value is never put in a message: amounts are shown to owners and editors only.
        const a = parseAmount(text);
        if (a === null) ctx.badAmounts++;
        out[c.id] = a;
        break;
      }
      case "number": {
        const n = Number(text.replace(",", "."));
        if (!Number.isFinite(n)) return `The ${c.label.toLowerCase()} isn't a number.`;
        out[c.id] = n;
        break;
      }
    }
  }
  if (spec.kind === "jobs") {
    out.due = dueDeadline(cell("due"), out.due as number);
    if (out.closed !== null && out.opened !== null && (out.closed as number) < (out.opened as number)) return "It was closed before it was opened.";
  }
  if (spec.kind === "deals" && out.left !== null && (out.left as number) < (out.entered as number)) return "It left the stage before it entered it.";
  return out as unknown as KindRow;
}

function readerFor(kind: ImportKind, ctx: ReadCtx): (cell: (c: string) => string, order: DateOrder) => KindRow | string {
  switch (kind) {
    case "step_log":
      return (cell, order) => readStepLogRow(cell as Parameters<typeof readStepLogRow>[0], order);
    case "clients":
      return (cell, order) => readClientRow(cell as Parameters<typeof readClientRow>[0], order);
    case "servicing_log":
      return (cell, order) => readServicingRow(cell as Parameters<typeof readServicingRow>[0], order);
    default: {
      const spec = IMPORT_KINDS[kind];
      return (cell, order) => readNewRow(spec, cell, order, ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** Deals into a step log: each row a visit to a stage. */
export function dealsToStepLog(rows: readonly DealRow[]): StepLogRow[] {
  return rows.map((r) => ({ item: r.deal, step: r.stage, started: r.entered, finished: r.left ?? null, hours: null, source: r.source || null }));
}

/** A note when the deals look like a list of deals (under 10% appear on two rows or more) rather than their stage history. */
export function dealsNote(rows: readonly DealRow[]): string | null {
  if (!rows.length) return null;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.deal, (counts.get(r.deal) ?? 0) + 1);
  let several = 0;
  for (const n of counts.values()) if (n >= 2) several++;
  return several / counts.size < 0.1
    ? "Each deal appears about once, so this looks like a list of deals rather than their stage history. Waits and branch odds need a row for every stage a deal went through."
    : null;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Time entries into a step log of hands-on visits: entries of a job in date order (ties keep their file order), and
 * consecutive entries on the same task are one visit: it starts at the first entry's date and its hours are the sum. A
 * visit has no finish, so no waits come from it.
 */
export function timeLogToStepLog(rows: readonly TimeLogRow[]): StepLogRow[] {
  const byJob = new Map<string, TimeLogRow[]>();
  for (const r of rows) {
    const list = byJob.get(r.job);
    if (list) list.push(r);
    else byJob.set(r.job, [r]);
  }
  const out: StepLogRow[] = [];
  for (const [job, list] of byJob) {
    const sorted = [...list].sort((a, b) => a.date - b.date); // stable: ties keep their line order
    let visit: StepLogRow | null = null;
    for (const r of sorted) {
      if (visit && visit.step === r.task) visit.hours = round4((visit.hours ?? 0) + r.hours);
      else {
        visit = { item: job, step: r.task, started: r.date, finished: null, hours: round4(r.hours), source: null };
        out.push(visit);
      }
    }
  }
  return out;
}

/** Jobs or tickets into a servicing log. */
export function jobsToServicing(rows: readonly JobRow[]): ServicingRow[] {
  return rows.map((r) => ({ task: r.type, client: r.client, due: r.due, done: r.closed ?? null, requested: r.opened ?? null }));
}

const WEEK_MS = 7 * 86_400_000;

export interface LeadsSummary {
  /** The window the weeks are counted over, epoch ms: the earliest lead to the latest (no later than `asOf`). */
  from: number;
  to: number;
  weeks: number;
  leads: number;
  /** Leads whose source isn't one of the model's lead sources. */
  unmatched: number;
  sources: { leadSourceId: string; name: string; leads: number; perWeek: number; current: number; enough: boolean }[];
  /** Why no leads a week are shown, or null. */
  blocked: string | null;
}

/** Leads a week for each of the model's lead sources, from a leads file, as a check beside Settings. */
export function leadsSummary(
  rows: readonly LeadRow[],
  leadSources: readonly { id: string; name: string; volumeWeek: number }[],
  asOf: number,
): LeadsSummary {
  let from = Infinity;
  let latest = -Infinity;
  for (const r of rows) {
    if (r.created < from) from = r.created;
    if (r.created > latest) latest = r.created;
  }
  if (!rows.length) from = asOf;
  // The window ends at the last lead (not today): a January to March export imported in October is 13 weeks, not 40. `asOf` only caps a date in the future.
  const to = rows.length ? Math.min(latest, Math.max(asOf, from)) : asOf;
  const weeks = (to - from) / WEEK_MS;
  const byName = new Map<string, string>();
  const dupes = new Set<string>();
  for (const s of leadSources) {
    const k = normHeader(s.name);
    if (byName.has(k)) dupes.add(k);
    else byName.set(k, s.id);
  }
  const counts = new Map<string, number>();
  let unmatched = 0;
  for (const r of rows) {
    const k = normHeader(r.source);
    const id = dupes.has(k) ? undefined : byName.get(k);
    if (id === undefined) unmatched++;
    else counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const longEnough = weeks >= CALIBRATION_MIN_WEEKS;
  const fmtWeeks = (Math.round(weeks * 10) / 10).toString();
  return {
    from,
    to,
    weeks,
    leads: rows.length,
    unmatched,
    sources: leadSources.map((s) => {
      const n = counts.get(s.id) ?? 0;
      return {
        leadSourceId: s.id,
        name: s.name,
        leads: n,
        perWeek: longEnough ? Math.round((n / weeks) * 100) / 100 : 0,
        current: s.volumeWeek,
        enough: longEnough && n >= CALIBRATION_MIN_SAMPLE,
      };
    }),
    blocked: longEnough ? null : `The file covers ${fmtWeeks} weeks; at least ${CALIBRATION_MIN_WEEKS} are needed.`,
  };
}

export interface InvoicesSummary {
  invoices: number;
  /** Distinct clients (counted, never kept). */
  clients: number;
  from: number | null;
  to: number | null;
  withDue: number;
  /** Of the invoices with a due and a paid date, the share paid after the due date (0-1); null when there are none. */
  paidLate: number | null;
  /** Invoices due on or before `asOf` with no paid date. */
  unpaidPastDue: number;
  withAmount: number;
}

/** Counts from an invoices file. No amounts are summed or kept: there is no cash model yet (D44). */
export function invoicesSummary(rows: readonly InvoiceRow[], asOf: number): InvoicesSummary {
  const clients = new Set<string>();
  let from: number | null = null;
  let to: number | null = null;
  let withDue = 0;
  let both = 0;
  let late = 0;
  let unpaid = 0;
  let withAmount = 0;
  for (const r of rows) {
    clients.add(r.client);
    if (from === null || r.issued < from) from = r.issued;
    if (to === null || r.issued > to) to = r.issued;
    if (r.due !== null) {
      withDue++;
      if (r.paid !== null) {
        both++;
        if (r.paid > r.due) late++;
      } else if (r.due <= asOf) unpaid++;
    }
    if (r.amount !== null) withAmount++;
  }
  return { invoices: rows.length, clients: clients.size, from, to, withDue, paidLate: both ? late / both : null, unpaidPastDue: unpaid, withAmount };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ImportRead {
  kind: ImportKind;
  /** Rows by the kind's shape, after conversion. For time logs these are visits with the task names as the file has them. */
  rows: ShapeRow[];
  /**
   * Time logs only: the entries as read. Names are matched to the model's before entries are merged into visits (`applyNameMap`), so
   * spellings of one step ("Audit", "audit ", "AUDIT") are one visit. Null for the other kinds.
   */
  entries: TimeLogRow[] | null;
  /** The first 20 parsed rows by the kind's column ids, values as text for display. Client and person values are the file's own: the screen labels them. */
  preview: Record<string, string>[];
  /** The first 200 rows left out, with why. */
  errors: { line: number; message: string }[];
  errorCount: number;
  /** Data lines (not counting the header, blank lines or the lines above the header). */
  lines: number;
  dateOrder: DateOrder | null;
  dateProblem: "ambiguous" | "mixed" | null;
  /** Required columns with no header chosen: `rows` is empty then. */
  missing: string[];
  /** Distinct values of the name column, by rows (most first) then value; at most 500. */
  names: { value: string; rows: number }[];
  /** A warning for this kind of file. */
  note: string | null;
  /** Amounts that couldn't be read. Their rows are kept, with the amount blank. */
  amountsUnreadable: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as `2 Mar 2026 09:30` (UTC, as read); the time is left off at exactly midnight. */
export function formatImportTime(t: number): string {
  const d = new Date(t);
  const date = `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? date : `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function previewRow(spec: ImportKindSpec, row: KindRow): Record<string, string> {
  const out: Record<string, string> = {};
  const r = row as unknown as Record<string, string | number | null | undefined>;
  for (const c of spec.columns) {
    const v = r[c.id];
    out[c.id] = v === null || v === undefined ? "" : c.type === "date" ? formatImportTime(v as number) : String(v);
  }
  return out;
}

/**
 * Reads a table (`splitCsv`'s records) as a kind of file, from the headers the person matched (`index`: column id to header
 * position, or null). Bad rows are left out with their line and reason; the rest are kept. Only a missing required column or
 * a date problem stops the whole read. Slashed dates are read as for `parseStepLog`.
 */
export function readImport(
  table: readonly string[][],
  kind: ImportKind,
  index: Record<string, number | null>,
  options: { dateOrder?: DateOrder; headerRow?: number; durationUnit?: DurationUnit; onProgress?: MappedOptions["onProgress"] } = {},
): ImportRead {
  const spec = IMPORT_KINDS[kind];
  const ids = spec.columns.map((c) => c.id);
  const at: Partial<Record<string, number>> = {};
  for (const id of ids) {
    const i = index[id];
    if (i !== null && i !== undefined) at[id] = i;
  }
  const ctx: ReadCtx = { badAmounts: 0, durationUnit: options.durationUnit ?? "hours" };
  const res = readMappedRows<string, KindRow>(
    table,
    at,
    {
      columns: ids,
      required: spec.columns.filter((c) => c.required).map((c) => c.id),
      dateColumns: spec.columns.filter((c) => c.type === "date").map((c) => c.id),
      readRow: readerFor(kind, ctx),
    },
    options,
  );
  const kindRows = res.rows;
  let rows: ShapeRow[];
  let note: string | null = null;
  switch (kind) {
    case "deals":
      rows = dealsToStepLog(kindRows as DealRow[]);
      note = dealsNote(kindRows as DealRow[]);
      break;
    case "time_logs": {
      rows = timeLogToStepLog(kindRows as TimeLogRow[]);
      // A column of minutes or seconds read as hours gives entries of days: say so, so it isn't silently wrong.
      const sorted = (kindRows as TimeLogRow[]).map((r) => r.hours).sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
      if (median > 24) {
        note = `The middle entry is ${Math.round(median).toLocaleString("en-GB")} hours long. If the hours column is in minutes or seconds, choose that under "Plain numbers are in" and continue again.`;
      }
      break;
    }
    case "jobs":
      rows = jobsToServicing(kindRows as JobRow[]);
      break;
    default:
      rows = kindRows as ShapeRow[];
  }
  const counts = new Map<string, number>();
  if (spec.nameColumn) {
    for (const r of kindRows) {
      const v = (r as unknown as Record<string, string | null>)[spec.nameColumn];
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const names = [...counts]
    .map(([value, n]) => ({ value, rows: n }))
    .sort((a, b) => b.rows - a.rows || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, MAX_IMPORT_NAMES);
  return {
    kind,
    rows,
    entries: kind === "time_logs" ? (kindRows as TimeLogRow[]) : null,
    preview: kindRows.slice(0, PREVIEW_ROWS).map((r) => previewRow(spec, r)),
    errors: res.errors.slice(0, MAX_IMPORT_ERRORS),
    errorCount: res.errors.length,
    lines: res.lines,
    dateOrder: res.dateOrder,
    dateProblem: res.dateProblem,
    missing: res.missing,
    names,
    note,
    amountsUnreadable: ctx.badAmounts,
  };
}

// ---------------------------------------------------------------------------
// Matching names to the model
// ---------------------------------------------------------------------------

/**
 * Which of the model's names (`targets`) each value of the file means: the target with the same name once normalised
 * (case, spacing and punctuation ignored), else null ("Leave out"). A value shared by two targets after normalising matches
 * neither.
 */
export function suggestNameMap(names: readonly { value: string }[], targets: readonly string[]): Record<string, string | null> {
  const byNorm = new Map<string, string | null>();
  for (const t of targets) {
    const k = normHeader(t);
    byNorm.set(k, byNorm.has(k) ? null : t);
  }
  const out: Record<string, string | null> = {};
  for (const n of names) out[n.value] = byNorm.get(normHeader(n.value)) ?? null;
  return out;
}

/**
 * The read's rows with their name field (`step`, `service`, `task` or a lead's `source`) rewritten to the target each value
 * is matched to. Rows whose value is matched to null, or isn't in the map, are dropped; the caller reports how many. Time log
 * entries are matched first and merged into visits after, so entries that name one step in different spellings, or two names
 * matched to one step, are one visit; an entry matched to nothing is dropped before merging.
 */
export function applyNameMap(read: ImportRead, map: Record<string, string | null>): ShapeRow[] {
  return applyNameMapCounted(read, map).rows;
}

/** `applyNameMap` with how many of the file's rows (time log entries, for time logs) were kept and left out. */
export function applyNameMapCounted(read: ImportRead, map: Record<string, string | null>): { rows: ShapeRow[]; kept: number; leftOut: number } {
  const target = (value: string) => (Object.hasOwn(map, value) ? (map[value] ?? null) : null);
  if (read.entries) {
    const entries: TimeLogRow[] = [];
    for (const e of read.entries) {
      const t = target(e.task);
      if (t !== null) entries.push({ ...e, task: t });
    }
    return { rows: timeLogToStepLog(entries), kept: entries.length, leftOut: read.entries.length - entries.length };
  }
  const shape = IMPORT_KINDS[read.kind].shape;
  const field = SHAPE_NAME_FIELD[shape];
  if (!field) return { rows: read.rows, kept: read.rows.length, leftOut: 0 };
  const out: ShapeRow[] = [];
  for (const row of read.rows) {
    const r = row as unknown as Record<string, unknown>;
    const t = target(r[field] as string);
    if (t === null) continue;
    out.push({ ...row, [field]: t } as ShapeRow);
  }
  return { rows: out, kept: out.length, leftOut: read.rows.length - out.length };
}

// ---------------------------------------------------------------------------
// What may be stored
// ---------------------------------------------------------------------------

export type ImportDelimiter = "," | ";" | "\t" | "|";
export type ImportEncoding = "utf-8" | "utf-16" | "windows-1252";

/** A leads summary as stored: model ids and numbers, no names. */
export interface LeadsSummaryStored {
  kind: "leads";
  weeks: number;
  leads: number;
  unmatched: number;
  blocked: boolean;
  sources: { leadSourceId: string; leads: number; perWeek: number; current: number }[];
}

/** An invoices summary as stored: counts only. */
export interface InvoicesSummaryStored {
  kind: "invoices";
  invoices: number;
  clients: number;
  withDue: number;
  paidLate: number | null;
  unpaidPastDue: number;
  withAmount: number;
}

export interface ImportDetails {
  delimiter: ImportDelimiter;
  encoding: ImportEncoding;
  headerRow: number;
  dateOrder: DateOrder | null;
  /** Data lines in the file. */
  lines: number;
  /** Rows kept, after conversion and name matching. */
  rows: number;
  /** Rows left out because they couldn't be read. */
  leftOut: number;
  /** Rows matched to a name in the model, and rows left out for having none. */
  nameMatches: { matched: number; leftOut: number };
  /** The earliest and latest dates in the rows, epoch ms; null when there are none. */
  window: { from: number; to: number } | null;
  summary: LeadsSummaryStored | InvoicesSummaryStored | null;
}

export function storedLeadsSummary(s: LeadsSummary): LeadsSummaryStored {
  return {
    kind: "leads",
    weeks: Math.round(s.weeks * 100) / 100,
    leads: s.leads,
    unmatched: s.unmatched,
    blocked: s.blocked !== null,
    sources: s.sources.map((x) => ({ leadSourceId: x.leadSourceId, leads: x.leads, perWeek: x.perWeek, current: x.current })),
  };
}

export function storedInvoicesSummary(s: InvoicesSummary): InvoicesSummaryStored {
  return { kind: "invoices", invoices: s.invoices, clients: s.clients, withDue: s.withDue, paidLate: s.paidLate, unpaidPastDue: s.unpaidPastDue, withAmount: s.withAmount };
}

/** The time a row sits at, for the window: when it started, was due, was created or was issued. */
function rowTime(shape: ImportShape, row: ShapeRow): number {
  const r = row as unknown as Record<string, number>;
  switch (shape) {
    case "step_log":
    case "clients":
      return r.started!;
    case "servicing_log":
      return r.due!;
    case "leads":
      return r.created!;
    case "invoices":
      return r.issued!;
  }
}

/**
 * What may be stored about an import: numbers, enums and model ids. No string from the file is in it (the header names are
 * in `column_map`, which the person chose), so no client, person, deal or amount can reach the database.
 */
export function importDetails(
  read: ImportRead,
  extra: {
    delimiter: string;
    encoding: ImportEncoding;
    headerRow: number;
    nameMatches: { matched: number; leftOut: number };
    summary?: LeadsSummaryStored | InvoicesSummaryStored;
    /** The rows after name matching, for the window; defaults to the read's rows. */
    rows?: readonly ShapeRow[];
  },
): ImportDetails {
  const shape = IMPORT_KINDS[read.kind].shape;
  const rows = extra.rows ?? read.rows;
  let from = Infinity;
  let to = -Infinity;
  for (const r of rows) {
    const t = rowTime(shape, r);
    if (t < from) from = t;
    if (t > to) to = t;
  }
  const delimiter: ImportDelimiter = extra.delimiter === ";" || extra.delimiter === "\t" || extra.delimiter === "|" ? extra.delimiter : ",";
  return {
    delimiter,
    encoding: extra.encoding,
    headerRow: Math.min(20, Math.max(1, Math.floor(extra.headerRow))),
    dateOrder: read.dateOrder,
    lines: read.lines,
    rows: extra.nameMatches.matched,
    leftOut: read.errorCount,
    nameMatches: { matched: extra.nameMatches.matched, leftOut: extra.nameMatches.leftOut },
    window: rows.length ? { from, to } : null,
    summary: extra.summary ?? null,
  };
}

// ---------------------------------------------------------------------------
// Loading a file
// ---------------------------------------------------------------------------

/** A file's bytes as text, with the encoding found. Unicode text without its marker (many NULs) is refused with a plain message. */
export function decodeImportFile(bytes: Uint8Array): { text: string; note: string | null; encoding: ImportEncoding } | { error: string } {
  const bom16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (!bom16) {
    const head = bytes.subarray(0, 1000);
    let nuls = 0;
    for (const b of head) if (b === 0) nuls++;
    if (head.length && nuls / head.length > 0.1) {
      return { error: "This looks like a Unicode file without its marker. In Excel, save it as CSV UTF-8 and choose it again." };
    }
  }
  const { text, note } = decodeLogFile(bytes);
  return { text, note, encoding: bom16 ? "utf-16" : note ? "windows-1252" : "utf-8" };
}

export type ImportDelimiterChoice = "auto" | ImportDelimiter;

export interface LoadedTable {
  /** Every record of the file, blank ones included (line numbers count them). */
  table: string[][];
  /** The header names as shown (`displayHeaders`). */
  headers: string[];
  /** The first 5 data rows, by header position. */
  samples: string[][];
  /** Data lines below the header. */
  lines: number;
  delimiter: ImportDelimiter;
}

/** Splits text into a table and finds the header row (1-based among the non-blank records). */
export function loadTable(text: string, delimiter: ImportDelimiterChoice, headerRow: number): LoadedTable | { error: string } {
  const sep = delimiter === "auto" ? detectDelimiter(text) : delimiter;
  const table = splitCsv(text, sep);
  const nonBlank = table.filter((r) => r.some((c) => c.trim() !== ""));
  const at = Math.max(1, Math.floor(headerRow));
  if (nonBlank.length < at) return { error: nonBlank.length === 0 ? "No rows to read." : `The file has no row ${at} to take the column names from.` };
  const header = nonBlank[at - 1]!;
  const data = nonBlank.slice(at);
  if (!data.length) return { error: "No rows to read." };
  return { table, headers: displayHeaders(header), samples: data.slice(0, 5), lines: data.length, delimiter: sep };
}
