import { describe, expect, it } from "vitest";
import { IMPORT_KIND_LIST, IMPORT_KINDS } from "@transpera-flow/db/csv-import";
import { isImportKind, parseColumnMap, parseDetails, parseRecordDatasetRequest, storedImportDetails } from "@/lib/calibration/import-request";
import { parseClientApplyRequest } from "@/lib/calibration/client-request";
import { parseApplyRequest } from "@/lib/calibration/request";

// What the Historical data page sends about an import (issue #40) is checked, and what is stored is rebuilt from known fields.

const ws = "11111111-1111-4111-8111-111111111111";
const proc = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";

const DETAILS = {
  delimiter: ",",
  encoding: "utf-8",
  headerRow: 1,
  dateOrder: "dmy",
  lines: 120,
  rows: 118,
  leftOut: 2,
  nameMatches: { matched: 118, leftOut: 0 },
  window: { from: 1, to: 2 },
  summary: null,
};

describe("parseColumnMap", () => {
  it("accepts the kind's columns with header names, and rebuilds it", () => {
    const map = parseColumnMap("deals", { deal: "Record ID", stage: "Deal Stage", entered: "Date entered" });
    expect(map).toEqual({ deal: "Record ID", stage: "Deal Stage", entered: "Date entered" });
    expect(parseColumnMap("deals", {})).toEqual({});
  });

  it("refuses another kind's column, a non-text name, a name over 200 characters, over 20 keys and a non-object", () => {
    expect(parseColumnMap("deals", { client: "Client" })).toBeNull();
    expect(parseColumnMap("leads", { created: 5 })).toBeNull();
    expect(parseColumnMap("leads", { created: "x".repeat(61) })).toBeNull();
    expect(parseColumnMap("leads", { created: "x".repeat(60) })).not.toBeNull();
    expect(parseColumnMap("leads", [])).toBeNull();
    expect(parseColumnMap("leads", null)).toBeNull();
    expect(parseColumnMap("nonsense" as never, {})).toBeNull();
    // Every real kind accepts all its own columns.
    for (const kind of IMPORT_KIND_LIST) {
      expect(parseColumnMap(kind, Object.fromEntries(IMPORT_KINDS[kind].columns.map((c) => [c.id, c.label])))).not.toBeNull();
    }
  });

  it("knows the kinds", () => {
    expect(IMPORT_KIND_LIST.every(isImportKind)).toBe(true);
    expect(isImportKind("payroll")).toBe(false);
    expect(isImportKind("toString")).toBe(false);
    expect(isImportKind(5)).toBe(false);
  });
});

describe("storedImportDetails", () => {
  it("keeps the known fields", () => {
    expect(storedImportDetails(DETAILS)).toEqual(DETAILS);
    expect(storedImportDetails({ ...DETAILS, dateOrder: null })?.dateOrder).toBeNull();
    expect(storedImportDetails({ ...DETAILS, dateOrder: undefined })?.dateOrder).toBeNull();
    expect(storedImportDetails({ ...DETAILS, delimiter: "\t" })?.delimiter).toBe("\t");
  });

  it("drops an extra field holding a client name and a person name, at every level", () => {
    const out = storedImportDetails({
      ...DETAILS,
      client: "ACME-SECRET-CLIENT",
      person: "Jane Secretperson",
      nameMatches: { matched: 1, leftOut: 0, clients: ["ACME-SECRET-CLIENT"] },
      window: { from: 1, to: 2, who: "Jane Secretperson" },
      summary: { kind: "leads", weeks: 5, leads: 30, unmatched: 2, blocked: false, names: ["ACME-SECRET-CLIENT"], sources: [{ leadSourceId: source, leads: 3, perWeek: 1, current: 2, name: "Jane Secretperson" }] },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("ACME");
    expect(json).not.toContain("Jane");
    expect(out?.summary).toEqual({ kind: "leads", weeks: 5, leads: 30, unmatched: 2, blocked: false, sources: [{ leadSourceId: source, leads: 3, perWeek: 1, current: 2 }] });
  });

  it("checks enums and refuses what isn't valid", () => {
    expect(storedImportDetails({ ...DETAILS, delimiter: "x" })).toBeNull();
    expect(storedImportDetails({ ...DETAILS, encoding: "ebcdic" })).toBeNull();
    expect(storedImportDetails({ ...DETAILS, dateOrder: "ymd" })).toBeNull();
    expect(storedImportDetails(null)).toBeNull();
    expect(storedImportDetails([])).toBeNull();
    expect(storedImportDetails("text")).toBeNull();
  });

  it("clamps numbers and drops lead sources that aren't ids", () => {
    const out = storedImportDetails({
      ...DETAILS,
      headerRow: 99,
      lines: -5,
      rows: Infinity,
      leftOut: "12",
      nameMatches: { matched: 5_000_000, leftOut: NaN },
      window: { from: "x", to: 2 },
      summary: { kind: "leads", weeks: -1, leads: 3.6, sources: [{ leadSourceId: "not-an-id", leads: 1 }, { leadSourceId: source, leads: 1e12, perWeek: -4, current: 7 }] },
    });
    expect(out).toMatchObject({ headerRow: 20, lines: 0, rows: 0, leftOut: 0, nameMatches: { matched: 1_000_000, leftOut: 0 }, window: null });
    expect(out?.summary).toEqual({ kind: "leads", weeks: 0, leads: 4, unmatched: 0, blocked: false, sources: [{ leadSourceId: source, leads: 1_000_000, perWeek: 0, current: 7 }] });
  });

  it("keeps an invoices summary as counts, and drops an unknown one", () => {
    const out = storedImportDetails({ ...DETAILS, summary: { kind: "invoices", invoices: 4, clients: 3, withDue: 4, paidLate: 1.5, unpaidPastDue: 1, withAmount: 3, total: 9999, topClient: "ACME-SECRET-CLIENT" } });
    expect(out?.summary).toEqual({ kind: "invoices", invoices: 4, clients: 3, withDue: 4, paidLate: 1, unpaidPastDue: 1, withAmount: 3 });
    expect(storedImportDetails({ ...DETAILS, summary: { kind: "payroll", total: 1 } })?.summary).toBeNull();
  });

  it("refuses details over 20,000 bytes", () => {
    const many = { kind: "leads", weeks: 5, leads: 1, sources: Array.from({ length: 200 }, (_, i) => ({ leadSourceId: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, leads: 1234567, perWeek: 1234.5678, current: 1234.5678 })) };
    const out = storedImportDetails({ ...DETAILS, summary: many });
    expect(out === null || JSON.stringify(out).length <= 20_000).toBe(true);
  });

  it("treats absent details as fine and bad details as an error", () => {
    expect(parseDetails(undefined)).toEqual({ ok: true, details: null });
    expect(parseDetails(null)).toEqual({ ok: true, details: null });
    expect(parseDetails(DETAILS)).toEqual({ ok: true, details: DETAILS });
    expect(parseDetails({ delimiter: "?" })).toEqual({ ok: false });
  });
});

describe("parseRecordDatasetRequest", () => {
  const good = { workspaceId: ws, kind: "leads", fileName: " leads.csv ", columnMap: { created: "Created", source: "Source" }, rowCount: 120, details: DETAILS };

  it("accepts a leads or an invoices import", () => {
    const r = parseRecordDatasetRequest(good);
    expect(r).toEqual({ ok: true, request: { workspaceId: ws, kind: "leads", fileName: "leads.csv", columnMap: { created: "Created", source: "Source" }, rowCount: 120, details: DETAILS } });
    expect(parseRecordDatasetRequest({ ...good, kind: "invoices", columnMap: { client: "Customer", issued: "Date" }, details: undefined })).toMatchObject({ ok: true, request: { kind: "invoices", details: null } });
  });

  it("refuses every other kind, a bad workspace, name, columns, row count and details", () => {
    for (const kind of ["deals", "step_log", "time_logs", "clients", "servicing_log", "jobs", "x", 5, null]) expect(parseRecordDatasetRequest({ ...good, kind }), String(kind)).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, workspaceId: "nope" })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, fileName: "  " })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, fileName: "x".repeat(301) })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, columnMap: { deal: "x" } })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, rowCount: -1 })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, rowCount: 1.5 })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, rowCount: 1_000_001 })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest({ ...good, details: { delimiter: "?" } })).toMatchObject({ ok: false });
    expect(parseRecordDatasetRequest(null)).toMatchObject({ ok: false });
  });
});

describe("parseApplyRequest with a kind", () => {
  const proposalKey = `arrivals:${source}`;
  const base = { workspaceId: ws, processId: proc, fileName: "deals.csv", columnMap: { deal: "Record ID", stage: "Deal Stage", entered: "Entered" }, rowCount: 10, results: { proposals: [{ key: proposalKey }] }, keys: [proposalKey] };

  it("takes deals and time logs, and a missing kind is a step log", () => {
    const deals = parseApplyRequest({ ...base, kind: "deals", details: DETAILS });
    expect(deals).toMatchObject({ ok: true, request: { kind: "deals", columnMap: base.columnMap, details: DETAILS } });
    const logs = parseApplyRequest({ ...base, kind: "time_logs", columnMap: { job: "Job", task: "Task", date: "Date", hours: "Hours" } });
    expect(logs).toMatchObject({ ok: true, request: { kind: "time_logs", details: null } });
    const plain = parseApplyRequest({ ...base, columnMap: { item: "Item", step: "Step", started: "Started" } });
    expect(plain).toMatchObject({ ok: true, request: { kind: "step_log" } });
  });

  it("checks the column map against the kind, and refuses other kinds", () => {
    expect(parseApplyRequest({ ...base, kind: "step_log" })).toMatchObject({ ok: false, message: "The log's columns aren't valid." });
    expect(parseApplyRequest({ ...base, kind: "leads" })).toMatchObject({ ok: false });
    expect(parseApplyRequest({ ...base, kind: "jobs" })).toMatchObject({ ok: false });
    expect(parseApplyRequest({ ...base, kind: "deals", details: { delimiter: "?" } })).toMatchObject({ ok: false, message: "The import's details aren't valid." });
  });
});

describe("parseClientApplyRequest with a kind", () => {
  const clients = { fileName: "clients.csv", columnMap: { client: "Customer", service: "Plan", started: "Signed" }, rowCount: 40, details: DETAILS };
  const log = { fileName: "tickets.csv", columnMap: { type: "Type", client: "Company", due: "Due date" }, rowCount: 90, kind: "jobs", details: DETAILS };
  const body = { workspaceId: ws, results: { proposals: [] }, keys: [] };

  it("takes a jobs file as the log, with details on both files", () => {
    const r = parseClientApplyRequest({ ...body, clients, log }, []);
    expect(r).toMatchObject({ ok: true, request: { clients: { fileName: "clients.csv", details: DETAILS }, log: { kind: "jobs", columnMap: log.columnMap, details: DETAILS } } });
    expect(r.ok && "kind" in r.request.clients!).toBe(false);
  });

  it("checks each file's columns against its kind and refuses other log kinds", () => {
    expect(parseClientApplyRequest({ ...body, log: { ...log, kind: "servicing_log" } }, [])).toMatchObject({ ok: false });
    expect(parseClientApplyRequest({ ...body, log: { ...log, kind: "deals" } }, [])).toMatchObject({ ok: false });
    expect(parseClientApplyRequest({ ...body, clients: { ...clients, columnMap: { task: "Task" } } }, [])).toMatchObject({ ok: false });
    expect(parseClientApplyRequest({ ...body, log: { ...log, details: { delimiter: "?" } } }, [])).toMatchObject({ ok: false });
    const plain = parseClientApplyRequest({ ...body, log: { fileName: "log.csv", columnMap: { task: "Task", client: "Client", due: "Due" }, rowCount: 5 } }, []);
    expect(plain).toMatchObject({ ok: true, request: { log: { kind: "servicing_log", details: null } } });
  });
});
