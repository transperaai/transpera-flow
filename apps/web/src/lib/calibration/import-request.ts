// Checks on what the Historical data page sends to the server about an import (issue #40) before anything is written.
// Row-level security and the recording functions (`record_dataset`, `record_calibration_import`, `record_client_calibration`)
// decide who may write and what; this refuses malformed input early and REBUILDS what is stored from known fields only
// (never spread), so no client, person, deal or amount from a file is stored by accident (D27, #30). Framework-free for tests.

import { IMPORT_KINDS, type ImportDetails, type ImportKind, type InvoicesSummaryStored, type LeadsSummaryStored } from "@transpera-flow/db/csv-import";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The most a stored `details` may hold. The database allows 20,000 bytes of jsonb text, which adds spaces to what JSON.stringify
 * writes, so this stays well under it and the two can't disagree near the cap.
 */
export const MAX_DETAILS_BYTES = 12_000;

export const isImportKind = (v: unknown): v is ImportKind => typeof v === "string" && Object.hasOwn(IMPORT_KINDS, v);

/**
 * A column map: column id of the kind to the header name the person matched (or a position, `Column 4`, for client, person, id and
 * amount columns). Keys must be the kind's columns, values text of up to 60 characters, and there are at most 20. Rebuilt, so nothing else gets through. Null when it isn't valid.
 */
export function parseColumnMap(kind: ImportKind, input: unknown): Record<string, string> | null {
  if (!isObject(input) || !isImportKind(kind)) return null;
  const ids = new Set(IMPORT_KINDS[kind].columns.map((c) => c.id));
  const entries = Object.entries(input);
  if (entries.length > 20) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!ids.has(k) || typeof v !== "string" || v.length > 60) return null;
    out[k] = v;
  }
  return out;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A count: a finite number clamped to 0..1,000,000 and rounded. */
const whole = (v: unknown, max = 1_000_000): number => Math.min(max, Math.max(0, Math.round(finite(v) ?? 0)));
const clamp = (v: unknown, min: number, max: number): number => Math.min(max, Math.max(min, finite(v) ?? 0));

function storedLeads(s: Record<string, unknown>): LeadsSummaryStored {
  return {
    kind: "leads",
    weeks: clamp(s.weeks, 0, 10_000),
    leads: whole(s.leads),
    unmatched: whole(s.unmatched),
    blocked: s.blocked === true,
    sources: (Array.isArray(s.sources) ? s.sources : [])
      .slice(0, 200)
      .filter((x): x is Record<string, unknown> => isObject(x) && isId(x.leadSourceId))
      .map((x) => ({ leadSourceId: x.leadSourceId as string, leads: whole(x.leads), perWeek: clamp(x.perWeek, 0, 1_000_000), current: clamp(x.current, 0, 1_000_000) })),
  };
}

function storedInvoices(s: Record<string, unknown>): InvoicesSummaryStored {
  const late = finite(s.paidLate);
  return {
    kind: "invoices",
    invoices: whole(s.invoices),
    clients: whole(s.clients),
    withDue: whole(s.withDue),
    paidLate: late === null ? null : clamp(late, 0, 1),
    unpaidPastDue: whole(s.unpaidPastDue),
    withAmount: whole(s.withAmount),
  };
}

/**
 * What is stored about an import, rebuilt from known fields only: numbers clamped and finite, enums checked, lead source ids
 * checked as ids, the summary by its kind. Null when the input isn't an object, an enum is wrong, or the result is over 20,000
 * bytes. A field of the input that isn't known (a client's name, a person's, an amount) never reaches the result.
 */
export function storedImportDetails(input: unknown): ImportDetails | null {
  if (!isObject(input)) return null;
  const { delimiter, encoding, dateOrder } = input;
  if (delimiter !== "," && delimiter !== ";" && delimiter !== "\t" && delimiter !== "|") return null;
  if (encoding !== "utf-8" && encoding !== "utf-16" && encoding !== "windows-1252") return null;
  if (dateOrder !== null && dateOrder !== undefined && dateOrder !== "dmy" && dateOrder !== "mdy") return null;
  const names = isObject(input.nameMatches) ? input.nameMatches : {};
  const w = isObject(input.window) ? input.window : null;
  const window = w && finite(w.from) !== null && finite(w.to) !== null ? { from: finite(w.from)!, to: finite(w.to)! } : null;
  const s = isObject(input.summary) ? input.summary : null;
  const details: ImportDetails = {
    delimiter,
    encoding,
    headerRow: Math.min(20, Math.max(1, whole(input.headerRow, 20))),
    dateOrder: dateOrder ?? null,
    lines: whole(input.lines),
    rows: whole(input.rows),
    leftOut: whole(input.leftOut),
    nameMatches: { matched: whole(names.matched), leftOut: whole(names.leftOut) },
    window,
    summary: s?.kind === "leads" ? storedLeads(s) : s?.kind === "invoices" ? storedInvoices(s) : null,
  };
  return JSON.stringify(details).length > MAX_DETAILS_BYTES ? null : details;
}

/** `details` of a request: absent is fine (nothing is stored beyond the database default `{}`), present must be valid. */
export function parseDetails(input: unknown): { ok: true; details: ImportDetails | null } | { ok: false } {
  if (input === undefined || input === null) return { ok: true, details: null };
  const details = storedImportDetails(input);
  return details ? { ok: true, details } : { ok: false };
}

export interface RecordDatasetRequest {
  workspaceId: string;
  kind: "leads" | "invoices";
  fileName: string;
  columnMap: Record<string, string>;
  rowCount: number;
  details: ImportDetails | null;
}

/** An import that has no calibration: a leads or an invoices file. */
export function parseRecordDatasetRequest(input: unknown): { ok: true; request: RecordDatasetRequest } | { ok: false; message: string } {
  if (!isObject(input)) return { ok: false, message: "Nothing to save." };
  const { workspaceId, kind, fileName, columnMap, rowCount } = input;
  if (!isId(workspaceId)) return { ok: false, message: "That workspace isn't valid." };
  if (kind !== "leads" && kind !== "invoices") return { ok: false, message: "That kind of file isn't saved here." };
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 300) return { ok: false, message: "Give the file a name of up to 300 characters." };
  const map = parseColumnMap(kind, columnMap);
  if (!map) return { ok: false, message: "The file's columns aren't valid." };
  if (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0 || rowCount > 1_000_000) return { ok: false, message: "The file's row count isn't valid." };
  const details = parseDetails(input.details);
  if (!details.ok) return { ok: false, message: "The import's details aren't valid." };
  return { ok: true, request: { workspaceId, kind, fileName: fileName.trim(), columnMap: map, rowCount, details: details.details } };
}
