import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrate, type CalibrationResult } from "@transpera-flow/engine";
import {
  calibrationInput,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamLeadSourceIds,
  northbeamStepIds,
  type EdgeRow,
  type LeadSourceRow,
  type StepRow,
} from "../src";
import { importDetails, readImport, storedLeadsSummary, leadsSummary, suggestMapping, type ImportKind, type LeadRow } from "../src/csv-import";
import { splitCsv } from "../src/calibration";
import { createTestDb, createUser, type TestDb } from "./harness";

// Importing historical data (issue #40, migration 20261216000000): an editor records an import under its own kind with its
// column map, row count and a counts-only `details`. Leads and invoices are recorded on their own (`record_dataset`); stage
// histories, deals and time logs with their calibration (`record_calibration_import`); a jobs file with a servicing
// calibration (`record_client_calibration`). Records are insert-only, so importing a kind again keeps the first. Viewers,
// members, strangers and API tokens record nothing. Made with Supabase's default privileges.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let member: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
let stranger: { id: string; claims: Record<string, unknown> };

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

const count = async () => (await q("select count(*)::int n from datasets"))[0].n as number;

const COLUMN_MAP = { deal: "Deal Name", stage: "Deal Stage", entered: "Date entered stage" };
const DETAILS = {
  delimiter: ",",
  encoding: "utf-8",
  headerRow: 1,
  dateOrder: null,
  lines: 120,
  rows: 118,
  leftOut: 2,
  nameMatches: { matched: 118, leftOut: 0 },
  window: { from: 1, to: 2 },
  summary: null,
};

const recordDataset = (c: pg.Client, kind: string, details: unknown = DETAILS, workspace = ws) =>
  c.query("select public.record_dataset($1, $2, 'leads-2026.csv', $3, 120, $4) as id", [workspace, kind, { created: "Created", source: "Source" }, details === null ? null : JSON.stringify(details)]).then((r) => r.rows[0].id as string);

const D = (day: number, hour = 9) => new Date(Date.UTC(2026, 2, 2 + day, hour)).toISOString().slice(0, 16).replace("T", " ");

/** Thirty deals through Northbeam's pipeline in a HubSpot-like export (stage history: one row per stage a deal entered). */
function dealsFile(): string {
  const lines = ["Record ID,Deal Name,Deal Stage,Date entered stage,Date left stage,Original Source,Amount,Deal owner"];
  const row = (i: number, stage: string, from: string, to: string, source = "") => lines.push(`${i},Deal ${i},${stage},${from},${to},${source},£${1000 + i},Rep ${i % 3}`);
  for (let i = 0; i < 30; i++) {
    const day = Math.floor(i * 2.8);
    row(i, "Qualify lead", D(day), D(day, 10), i % 2 ? "Client referrals" : "Website enquiries");
    if (i >= 20) {
      row(i, "Lost", D(day + 1), "");
      continue;
    }
    row(i, "Discovery call", D(day + 1), D(day + 1, 11));
    if (i >= 14) {
      row(i, "Lost", D(day + 2), "");
      continue;
    }
    row(i, "Audit & proposal", D(day + 2), D(day + 2, 15));
    row(i, "Client decision", D(day + 4), D(day + 7));
    row(i, i < 5 ? "Contract & onboarding" : "Lost", D(day + 8), "");
  }
  return lines.join("\n");
}

/** Thirty jobs, each with two consecutive entries on the audit (one visit) after a qualifying entry. */
function timeLogFile(): string {
  const lines = ["Job,Task,Date,Hours,Person,Client"];
  for (let i = 0; i < 30; i++) {
    const day = i * 3;
    lines.push(`J${i},Qualify lead,${D(day).slice(0, 10)},0.5,Person ${i % 3},Client ${i}`);
    lines.push(`J${i},Audit & proposal,${D(day + 1).slice(0, 10)},${3 + (i % 3)},Person ${i % 3},Client ${i}`);
    lines.push(`J${i},Audit & proposal,${D(day + 2).slice(0, 10)},${2 + (i % 2)},Person ${i % 3},Client ${i}`);
  }
  return lines.join("\n");
}

async function calibrateRows(rows: ReturnType<typeof readImport>["rows"], leadSources: "model" | "none"): Promise<CalibrationResult> {
  const steps = (await q("select * from steps where revision_id = $1", [NORTHBEAM_REVISION_ID])) as StepRow[];
  const edges = (await q("select * from edges where revision_id = $1", [NORTHBEAM_REVISION_ID])) as EdgeRow[];
  const sources = (await q("select * from lead_sources where workspace_id = $1", [ws])) as LeadSourceRow[];
  const services = await q("select active, entry_process_id from services where workspace_id = $1", [ws]);
  const [process] = await q("select id, kind, parent_process_id, is_company from processes where id = $1", [proc]);
  const input = calibrationInput({ process, steps, edges, services: services as never, leadSources: sources, seasonality: [], hoursPerWeek: 40 }, rows as never);
  return calibrate(leadSources === "none" ? { ...input, leadSources: null } : input);
}

const importFile = (text: string, kind: ImportKind) => {
  const table = splitCsv(text);
  const mapping = suggestMapping(table[0]!, kind);
  return { read: readImport(table, kind, mapping.index), columnMap: Object.fromEntries(Object.entries(mapping.index).filter(([, i]) => i !== null).map(([id, i]) => [id, table[0]![i!]!])) };
};

const callImport = (c: pg.Client, kind: string, res: CalibrationResult, keys: string[] | null, details: unknown = DETAILS) =>
  c
    .query("select public.record_calibration_import($1, $2, $3, 'file.csv', $4, 100, $5, $6, $7) as r", [ws, proc, kind, COLUMN_MAP, details, res, keys])
    .then((r) => r.rows[0].r as { status: string; results: { key: string; status: string }[]; calibration_id: string; dataset_id: string });

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "di-editor@example.com");
  member = await createUser(db, "di-member@example.com");
  viewer = await createUser(db, "di-viewer@example.com");
  stranger = await createUser(db, "di-stranger@example.com");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'member'), ($1, $4, 'viewer')", [ws, editor.id, member.id, viewer.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("datasets.details", () => {
  it("is a jsonb object of at most 20,000 bytes, defaulting to {}", async () => {
    const [col] = await q("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'datasets' and column_name = 'details'");
    expect(col).toEqual({ data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" });
    const [row] = await q("insert into datasets (workspace_id, kind, file_name, row_count) values ($1, 'step_log', 'plain.csv', 1) returning details", [ws]);
    expect(row.details).toEqual({});
    await expect(q("insert into datasets (workspace_id, kind, file_name, row_count, details) values ($1, 'step_log', 'x.csv', 1, '[]')", [ws])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("record_dataset", () => {
  it("records leads and invoices for an editor, with details, and no process", async () => {
    const leads = await commitAs(editor.claims, (c) => recordDataset(c, "leads"));
    const invoices = await commitAs(editor.claims, (c) => recordDataset(c, "invoices", { ...DETAILS, summary: { kind: "invoices", invoices: 4 } }));
    const rows = await q("select id, kind, process_id, file_name, row_count, column_map, details, created_by from datasets where id = any($1) order by kind", [[leads, invoices]]);
    expect(rows.map((r) => r.kind)).toEqual(["invoices", "leads"]);
    expect(rows.find((r) => r.id === leads)).toMatchObject({ process_id: null, file_name: "leads-2026.csv", row_count: 120, column_map: { created: "Created", source: "Source" }, details: DETAILS, created_by: editor.id });
    expect(rows.find((r) => r.id === invoices)!.details.summary).toEqual({ kind: "invoices", invoices: 4 });
  });

  it("refuses the kinds that are recorded with their calibration", async () => {
    const start = await count();
    for (const kind of ["deals", "step_log", "time_logs", "clients", "servicing_log", "jobs", "nonsense"]) {
      await expect(commitAs(editor.claims, (c) => recordDataset(c, kind)), kind).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/recorded with their calibration/) });
    }
    expect(await count()).toBe(start);
  });

  it("refuses a viewer, a member, a stranger and an API token, and leaves no row", async () => {
    const start = await count();
    for (const who of [viewer, member, stranger]) {
      await expect(commitAs(who.claims, (c) => recordDataset(c, "leads"))).rejects.toThrow(/row-level security/);
    }
    await expect(commitAs({ ...editor.claims, api_token_id: "t1" }, (c) => recordDataset(c, "leads"))).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/by a person in the app/),
    });
    expect(await count()).toBe(start);
  });

  it("stores {} for details that aren't an object, and refuses details over 20,000 bytes", async () => {
    for (const bad of [null, "text", 5, [1, 2]]) {
      const id = await commitAs(editor.claims, (c) => recordDataset(c, "leads", bad));
      expect((await q("select details from datasets where id = $1", [id]))[0].details, JSON.stringify(bad)).toEqual({});
    }
    const start = await count();
    await expect(commitAs(editor.claims, (c) => recordDataset(c, "leads", { pad: "x".repeat(20_000) }))).rejects.toMatchObject({ code: "23514" });
    expect(await count()).toBe(start);
  });

  it("keeps the earlier import when a kind is imported again", async () => {
    const before = await q("select id from datasets where kind = 'leads' order by imported_at, id");
    const again = await commitAs(editor.claims, (c) => recordDataset(c, "leads", { ...DETAILS, rows: 5 }));
    const after = await q("select id, details from datasets where kind = 'leads' order by imported_at, id");
    expect(after.map((r) => r.id)).toEqual([...before.map((r) => r.id), again]);
    expect(after[0].details).toEqual(DETAILS);
  });

  it("is readable by members and viewers, never updatable", async () => {
    for (const who of [member, viewer]) {
      const seen = await db.as(who.claims, async (c) => (await c.query("select kind, details from datasets where kind = 'leads' limit 1")).rows);
      expect(seen[0].details).toEqual(DETAILS);
    }
    expect(await db.as(stranger.claims, async (c) => (await c.query("select id from datasets")).rows)).toEqual([]);
    for (const claims of [editor.claims, member.claims]) {
      await expect(db.as(claims, (c) => c.query("update datasets set details = '{}'"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("record_calibration_import", () => {
  it("records a deals import under its own kind, with details, and applies a key as record_calibration does", async () => {
    const { read, columnMap } = importFile(dealsFile(), "deals");
    expect(read.errors).toEqual([]);
    expect(read.rows).toHaveLength(108);
    const res = await calibrateRows(read.rows, "model");
    const key = `arrivals:${northbeamLeadSourceIds.website}`;
    const proposal = res.proposals.find((p) => p.key === key)!;
    expect(proposal).toMatchObject({ enough: true, n: 15 });
    const details = importDetails(read, { delimiter: ",", encoding: "utf-8", headerRow: 1, nameMatches: { matched: read.rows.length, leftOut: 0 } });
    const out = await commitAs(editor.claims, (c) =>
      c.query("select public.record_calibration_import($1, $2, 'deals', 'hubspot-deals.csv', $3, $4, $5, $6, $7) as r", [ws, proc, columnMap, read.rows.length, details, res, [key]]).then((r) => r.rows[0].r),
    );
    expect(out.results).toEqual([{ key, status: "applied" }]);
    const [ds] = await q("select kind, process_id, file_name, row_count, column_map, details from datasets where id = $1", [out.dataset_id]);
    expect(ds).toMatchObject({ kind: "deals", process_id: proc, file_name: "hubspot-deals.csv", row_count: 108, column_map: columnMap });
    expect(ds.details).toEqual(JSON.parse(JSON.stringify(details)));
    expect(JSON.stringify(ds)).not.toMatch(/Rep \d|£\d|Deal \d/);
    const [web] = await q("select volume_week::float8 v, provenance from lead_sources where id = $1", [northbeamLeadSourceIds.website]);
    expect(web.v).toBe(proposal.proposed);
    expect(web.provenance.volume_week).toMatchObject({ source: "measured", dataset_id: out.dataset_id, calibration_id: out.calibration_id, by: editor.id, n: 15 });
    const [cal] = await q("select dataset_id, process_id, applied_keys from calibrations where id = $1", [out.calibration_id]);
    expect(cal).toEqual({ dataset_id: out.dataset_id, process_id: proc, applied_keys: [key] });
  });

  it("records a time-log import and applies hands-on time into the draft, citing the dataset", async () => {
    const { read, columnMap } = importFile(timeLogFile(), "time_logs");
    expect(read.errors).toEqual([]);
    // Two audit entries a job are one visit.
    expect(read.rows).toHaveLength(60);
    const res = await calibrateRows(read.rows, "none");
    const key = `work:${northbeamStepIds.audit}`;
    const proposal = res.proposals.find((p) => p.key === key)!;
    expect(proposal).toMatchObject({ enough: true, n: 30 });
    expect(res.proposals.every((p) => p.kind === "work" || p.kind === "rework" || p.kind === "wait" || p.kind === "routing")).toBe(true);
    const out = await commitAs(editor.claims, (c) =>
      c.query("select public.record_calibration_import($1, $2, 'time_logs', 'timesheets.csv', $3, $4, '{}', $5, $6) as r", [ws, proc, columnMap, read.rows.length, res, [key]]).then((r) => r.rows[0].r),
    );
    expect(out.results).toEqual([{ key, status: "applied" }]);
    expect((await q("select kind, details from datasets where id = $1", [out.dataset_id]))[0]).toEqual({ kind: "time_logs", details: {} });
    const [audit] = await q("select work_hours::float8 w, provenance from steps where revision_id = $1 and id = $2", [out.draft.revision_id, northbeamStepIds.audit]);
    expect(audit.w).toBe(proposal.proposed);
    expect(audit.provenance.work_hours).toMatchObject({ source: "measured", dataset_id: out.dataset_id, calibration_id: out.calibration_id, n: 30 });
  });

  it("records a plain step log as step_log", async () => {
    const res = await calibrateRows([], "model");
    const out = await commitAs(editor.claims, (c) => callImport(c, "step_log", res, [`arrivals:${northbeamLeadSourceIds.referrals}`]));
    expect((await q("select kind from datasets where id = $1", [out.dataset_id]))[0].kind).toBe("step_log");
  });

  it("refuses the kinds that aren't calibrated against a process", async () => {
    const res = await calibrateRows([], "model");
    const start = await count();
    for (const kind of ["leads", "invoices", "clients", "servicing_log", "jobs", "nonsense"]) {
      await expect(commitAs(editor.claims, (c) => callImport(c, kind, res, [`arrivals:${northbeamLeadSourceIds.website}`])), kind).rejects.toMatchObject({
        code: "22023",
        message: expect.stringMatching(/isn't calibrated against a process/),
      });
    }
    expect(await count()).toBe(start);
  });

  it("records nothing for a viewer, a stranger or an API token", async () => {
    const res = await calibrateRows([], "model");
    const start = await count();
    const key = `arrivals:${northbeamLeadSourceIds.website}`;
    await expect(commitAs(viewer.claims, (c) => callImport(c, "deals", res, [key]))).rejects.toThrow(/row-level security/);
    await expect(commitAs(stranger.claims, (c) => callImport(c, "deals", res, [key]))).rejects.toThrow(/row-level security/);
    await expect(commitAs({ ...editor.claims, api_token_id: "t1" }, (c) => callImport(c, "deals", res, [key]))).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/by a person in the app/),
    });
    expect(await count()).toBe(start);
    expect((await q("select count(*)::int n from calibrations where dataset_id not in (select id from datasets)"))[0].n).toBe(0);
  });
});

describe("record_client_calibration with a kind and details", () => {
  const results = { kind: "clients", asOf: 1, proposals: [], checks: [] };
  const LOG = { file_name: "tickets.csv", column_map: { type: "Type", client: "Company", due: "Due date" }, row_count: 90, details: { ...DETAILS, rows: 90 } };
  const call = (c: pg.Client, clients: unknown, log: unknown) =>
    c.query("select public.record_client_calibration($1, $2, $3, $4, null) as r", [ws, clients, log, results]).then((r) => r.rows[0].r as { datasets: { clients: string | null; servicing_log: string | null }; calibration_id: string });

  it("records a jobs file as jobs, with details, and keeps the key servicing_log", async () => {
    const out = await commitAs(editor.claims, (c) => call(c, null, { ...LOG, kind: "jobs" }));
    expect(out.datasets).toEqual({ clients: null, servicing_log: expect.any(String) });
    const [ds] = await q("select kind, process_id, column_map, row_count, details from datasets where id = $1", [out.datasets.servicing_log]);
    expect(ds).toEqual({ kind: "jobs", process_id: null, column_map: LOG.column_map, row_count: 90, details: LOG.details });
    const [cal] = await q("select dataset_id, results from calibrations where id = $1", [out.calibration_id]);
    expect(cal.dataset_id).toBe(out.datasets.servicing_log);
    expect(cal.results.datasets).toEqual({ clients: null, servicing_log: out.datasets.servicing_log });
  });

  it("still records a log with no kind as servicing_log, and stores details for the clients file", async () => {
    const clients = { file_name: "clients.csv", column_map: { client: "Customer" }, row_count: 40, details: { ...DETAILS, rows: 40 } };
    const { kind: _kind, ...plain } = { ...LOG, kind: "x" };
    void _kind;
    const out = await commitAs(editor.claims, (c) => call(c, clients, plain));
    const rows = await q("select id, kind, details from datasets where id = any($1) order by kind", [[out.datasets.clients, out.datasets.servicing_log]]);
    expect(rows.map((r) => r.kind)).toEqual(["clients", "servicing_log"]);
    expect(rows.find((r) => r.kind === "clients")!.details).toEqual({ ...DETAILS, rows: 40 });
    // Details that aren't an object are {}.
    const odd = await commitAs(editor.claims, (c) => call(c, { ...clients, details: "text" }, null));
    expect((await q("select details from datasets where id = $1", [odd.datasets.clients]))[0].details).toEqual({});
  });

  it("refuses any other kind for the log", async () => {
    const start = await count();
    for (const kind of ["deals", "clients", "step_log", "leads", "x"]) {
      await expect(commitAs(editor.claims, (c) => call(c, null, { ...LOG, kind })), kind).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/isn't a servicing log/) });
    }
    expect(await count()).toBe(start);
  });
});

describe("importing a kind again", () => {
  it("adds a record and the first stays, newest first by date", async () => {
    const leads = await q("select id, imported_at from datasets where kind = 'leads' order by imported_at desc, id");
    expect(leads.length).toBeGreaterThanOrEqual(2);
    // A viewer sees every record of the kind.
    const seen = await db.as(viewer.claims, async (c) => (await c.query("select id from datasets where kind = 'leads'")).rows);
    expect(seen.map((r) => r.id).sort()).toEqual(leads.map((r) => r.id).sort());
  });

  it("keeps no name or amount from the leads and invoices summaries a page would send", async () => {
    const rows: LeadRow[] = [{ lead: null, created: Date.UTC(2026, 0, 1), source: "ACME-SECRET-SOURCE" }];
    const summary = storedLeadsSummary(leadsSummary(rows, [{ id: northbeamLeadSourceIds.website, name: "Website enquiries", volumeWeek: 8 }], Date.UTC(2026, 5, 1)));
    const id = await commitAs(editor.claims, (c) => recordDataset(c, "leads", { ...DETAILS, summary }));
    const [row] = await q("select details from datasets where id = $1", [id]);
    expect(JSON.stringify(row.details)).not.toContain("ACME");
    expect(row.details.summary.sources[0]).toMatchObject({ leadSourceId: northbeamLeadSourceIds.website, leads: 0 });
  });
});
