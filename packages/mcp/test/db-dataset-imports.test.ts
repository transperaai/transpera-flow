import { randomUUID } from "node:crypto";
import type { Db } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrate, type CalibrationResult } from "@transpera-flow/engine";
import { rpc } from "@transpera-flow/db/client";
import { calibrationInput, loadProcessBundle, splitCsv, type ProcessRow } from "@transpera-flow/db";
import { applyNameMap, importDetails, readImport, suggestMapping, suggestNameMap } from "@transpera-flow/db/csv-import";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// Importing historical data (issue #40, migration 20261216000000) as the web app does it: through Kysely, signed in,
// under RLS. An editor reads a deals export from a CRM (its stage names are not the model's), matches
// the columns and the names, converts it into a step log, calibrates against the live model and records the import under its own
// kind with `record_calibration_import`. A member reads the record: the kind, the column map and counts only, never a deal,
// a person or an amount. A viewer's `record_dataset` leaves nothing. Runs in its own workspace.
// Runs on a throwaway database (test/helpers.ts).


let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", proc: "", rev: "", role: "", source: "", qualify: "", won: "", lost: "", start: "" };
let editor: Db;
let member: Db;
let viewer: Db;
let anon: Db;

const SETTINGS = { hours_per_week: 40, currency: "AUD", horizon_weeks: 13, leads_per_week: 5, active_clients: 0, churn_monthly: 0, retainer: 1000 };

/** A HubSpot-like deals export: 24 deals over twelve weeks, "Qualified lead" and "Closed won"/"Closed lost" for the model's Qualify, Won and Lost. */
function dealsFile(): string {
  const lines = ["Record ID,Deal Name,Deal Stage,Date entered stage,Date left,Original Source,Amount,Deal owner"];
  for (let i = 0; i < 24; i++) {
    const day = new Date(Date.UTC(2026, 3, 1) + i * 3.5 * 86_400_000);
    const at = (d: number, h: number) => new Date(day.getTime() + d * 86_400_000 + h * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
    const tail = `Website,£${9000 + i},Jane Secretperson`;
    lines.push(`${i},ACME-SECRET-DEAL ${i},Qualified lead,${at(0, 9)},${at(0, 11)},${tail}`);
    lines.push(`${i},ACME-SECRET-DEAL ${i},${i % 2 ? "Closed won" : "Closed lost"},${at(1, 9)},,${tail}`);
  }
  return lines.join("\n");
}

async function bundle(revisionId: string) {
  const ws = await editor.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("id", "=", ids.ws).executeTakeFirstOrThrow();
  const proc = await editor.selectFrom("processes").selectAll().where("id", "=", ids.proc).executeTakeFirstOrThrow();
  return loadProcessBundle(editor, ws, proc as unknown as ProcessRow, revisionId);
}

describe("importing a deals file", () => {
  let result: CalibrationResult;
  let rowCount = 0;
  let columnMap: Record<string, string> = {};
  let details: unknown;

  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) values ('Import Co', $1, $2) returning id", [`import-${tag}`, SETTINGS])).id as string;
    ids.role = (await one("insert into roles (workspace_id, name) values ($1, 'Sales') returning id", [ids.ws])).id as string;
    await admin.query("insert into people (workspace_id, name, fte) values ($1, 'Sam Lee', 1)", [ids.ws]);
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) select id, $2, $1 from people where workspace_id = $1", [ids.ws, ids.role]);
    ids.source = (await one("insert into lead_sources (workspace_id, name, volume_week, conversion_to_qualified) values ($1, 'Website', 3, 0.5) returning id", [ids.ws])).id as string;
    ids.proc = (await one("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Enquiry to signed', 'pipeline', 'enquiry') returning id", [ids.ws])).id as string;
    ids.rev = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [ids.ws, ids.proc])).id as string;
    await admin.query("update processes set live_revision_id = $2 where id = $1", [ids.proc, ids.rev]);
    for (const k of ["start", "qualify", "won", "lost"] as const) ids[k] = randomUUID();
    const step = (id: string, name: string, kind: string, role: string | null, work: number, outcome: string | null) =>
      admin.query(
        "insert into steps (id, revision_id, workspace_id, process_id, name, kind, role_id, work_hours, wait_hours, outcome) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)",
        [id, ids.rev, ids.ws, ids.proc, name, kind, role, work, outcome],
      );
    await step(ids.start, "Enquiry arrives", "start", null, 0, null);
    await step(ids.qualify, "Qualify", "task", ids.role, 0.5, null);
    await step(ids.won, "Won", "end", null, 0, "won");
    await step(ids.lost, "Lost", "end", null, 0, "lost");
    const edge = (from: string, to: string, p: number) =>
      admin.query("insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, $6)", [ids.rev, ids.ws, ids.proc, from, to, p]);
    await edge(ids.start, ids.qualify, 1);
    await edge(ids.qualify, ids.won, 0.5);
    await edge(ids.qualify, ids.lost, 0.5);

    const [ed, mb, vw] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [ed, `imp-editor-${tag}@example.com`, mb, `imp-member-${tag}@example.com`, vw, `imp-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'member'), ($1, $4, 'viewer')", [ids.ws, ed, mb, vw]);
    editor = env.dbAs(userClaims(ed));
    member = env.dbAs(userClaims(mb));
    viewer = env.dbAs(userClaims(vw));
    anon = env.dbAs(null);
  });

  afterAll(async () => {
    await env?.close();
  });

  const datasets = async () => Number((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n);

  it("reads the deals file, matches its names to the live model's steps and calibrates", async () => {
    const live = await bundle(ids.rev);
    const table = splitCsv(dealsFile());
    const mapping = suggestMapping(table[0]!, "deals");
    expect(mapping.index).toMatchObject({ deal: 0, stage: 2, entered: 3, left: 4, source: 5, amount: 6, owner: 7 });
    columnMap = Object.fromEntries(Object.entries(mapping.index).filter(([, i]) => i !== null).map(([id, i]) => [id, table[0]![i!]!]));
    const read = readImport(table, "deals", mapping.index);
    expect(read.errors).toEqual([]);
    expect(read.rows).toHaveLength(48);
    expect(read.note).toBeNull();
    // The CRM's stage names aren't the model's: "Qualified lead" has to be matched by hand, "Closed won" and "Closed lost" too.
    const targets = live.steps.map((s) => s.name);
    const names = suggestNameMap(read.names, targets);
    expect(names).toEqual({ "Qualified lead": null, "Closed won": null, "Closed lost": null });
    const rows = applyNameMap(read, { ...names, "Qualified lead": "Qualify", "Closed won": "Won", "Closed lost": "Lost" });
    expect(rows).toHaveLength(48);
    rowCount = rows.length;
    details = importDetails(read, { delimiter: ",", encoding: "utf-8", headerRow: 1, nameMatches: { matched: 48, leftOut: 0 }, rows });
    result = calibrate(
      calibrationInput(
        { process: live.process, steps: live.steps, edges: live.edges, services: live.services, leadSources: live.leadSources ?? [], seasonality: live.seasonality ?? [], hoursPerWeek: 40 },
        rows as never,
      ),
    );
    expect(result.proposals.find((p) => p.key === `arrivals:${ids.source}`)).toMatchObject({ n: 24, enough: true, proposed: 4 });
  });

  const args = (keys: string[]) => ({
    p_workspace: ids.ws,
    p_process: ids.proc,
    p_kind: "deals",
    p_file_name: "hubspot-deals.csv",
    p_column_map: columnMap,
    p_row_count: rowCount,
    p_details: details as never,
    p_results: result as never,
    p_keys: keys,
  });

  it("records nothing for a member, a viewer or anon", async () => {
    const before = await datasets();
    for (const who of [member, viewer, anon]) expect(await errorOf(() => rpc(who, "record_calibration_import", args([`arrivals:${ids.source}`])))).not.toBeNull();
    expect(await datasets()).toBe(before);
  });

  it("records the import as an editor under its own kind and applies the ticked key", async () => {
    const out = await rpc(editor, "record_calibration_import", args([`arrivals:${ids.source}`]));
    const data = out as { status: string; dataset_id: string; calibration_id: string; results: { key: string; status: string }[] };
    expect(data).toMatchObject({ status: "ok", results: [{ key: `arrivals:${ids.source}`, status: "applied" }] });
    expect((await one("select kind, process_id from datasets where id = $1", [data.dataset_id]))).toEqual({ kind: "deals", process_id: ids.proc });
    const live = await bundle(ids.rev);
    const source = live.leadSources!.find((s) => s.id === ids.source)!;
    expect(Number(source.volume_week)).toBe(4);
    expect((source.provenance as Record<string, Record<string, unknown>>).volume_week).toMatchObject({ source: "measured", dataset_id: data.dataset_id, n: 24 });
  });

  it("lets a member read the record: the kind, the column map and counts only", async () => {
    const seen = await member.selectFrom("datasets").select(["id", "kind", "file_name", "row_count", "column_map", "details", "process_id"]).where("workspace_id", "=", ids.ws).where("kind", "=", "deals").execute();
    expect(seen).toHaveLength(1);
    const row = seen[0]!;
    expect(row).toMatchObject({ kind: "deals", file_name: "hubspot-deals.csv", row_count: 48, column_map: columnMap });
    expect(row.details).toMatchObject({ delimiter: ",", encoding: "utf-8", headerRow: 1, lines: 48, rows: 48, leftOut: 0, nameMatches: { matched: 48, leftOut: 0 } });
    expect(JSON.stringify(row)).not.toMatch(/ACME-SECRET|Jane Secretperson|£9\d{3}|Qualified lead/);
    // Nothing selects who imported it into the page's view, and nobody can change it.
    expect(await errorOf(() => member.updateTable("datasets").set({ details: {} }).where("id", "=", row.id).execute())).not.toBeNull();
    expect(await anon.selectFrom("datasets").select("id").execute().catch(() => [])).toEqual([]);
  });

  it("leaves nothing when a viewer, a member or anon records leads over record_dataset", async () => {
    const before = await datasets();
    const call = { p_workspace: ids.ws, p_kind: "leads", p_file_name: "leads.csv", p_column_map: { created: "Created", source: "Source" }, p_row_count: 10, p_details: {} };
    for (const who of [viewer, member, anon]) expect(await errorOf(() => rpc(who, "record_dataset", call))).not.toBeNull();
    expect(await datasets()).toBe(before);
    const ok = await rpc(editor, "record_dataset", call);
    expect(typeof ok).toBe("string");
    expect(await datasets()).toBe(before + 1);
    expect(await errorOf(() => rpc(editor, "record_dataset", { ...call, p_kind: "deals" }))).not.toBeNull();
  });
});
