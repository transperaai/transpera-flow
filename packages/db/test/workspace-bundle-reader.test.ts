import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_TABLES, BundleTooLargeError, supabaseReader, type Db } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The bundle reader pages through a table, orders stably and filters to the workspace, against Postgres as a real
// owner. (Supabase's API returned at most 1000 rows a request, so the reader never trusted a short page to mean the end;
// it still stops only on an empty page, and the tests below page in small steps to prove it.)

let tdb: TestDb;
let db: Db;
let ws: string;
let otherWs: string;

beforeAll(async () => {
  tdb = await createTestDb();
  ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Reader', 'reader-ws') returning id")).rows[0].id;
  otherWs = (await tdb.client.query("insert into workspaces (name, slug) values ('Elsewhere', 'reader-other') returning id")).rows[0].id;
  const owner = await createUser(tdb, "owner@bundle-reader.example.com");
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, owner.id]);
  db = tdb.dbAs(owner.claims as never);
  await tdb.client.query("insert into roles (workspace_id, name) select $1, 'Role ' || g from generate_series(1, 2005) g", [ws]);
  await tdb.client.query("insert into roles (workspace_id, name) values ($1, 'Not ours')", [otherWs]);
  await tdb.client.query(
    "insert into suggestion_proposals (workspace_id, kind, title, payload, created_via, import_source, proposer_email) select $1, 'issue', 'Idea ' || g, '{}', 'upload', 'x', 'visitor@example.com' from generate_series(1, 3) g",
    [ws],
  );
});
afterAll(async () => {
  await tdb?.close();
});

describe("supabaseReader", () => {
  it("reads every page, scoped to the workspace and in a stable order", async () => {
    const rows = await supabaseReader(db)("roles", ws);
    expect(rows).toHaveLength(2005);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2005);
    expect(rows.every((r) => r.workspace_id === ws)).toBe(true);
    const ids = rows.map((r) => r.id as string);
    expect(ids).toEqual([...ids].sort());
  });

  it("is not truncated whatever the page size", async () => {
    for (const pageSize of [1000, 100, 7, 1]) {
      const rows = await supabaseReader(db, { pageSize })("suggestion_proposals", ws);
      expect(rows, `page size ${pageSize}`).toHaveLength(3);
      expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    }
    const all = await supabaseReader(db, { pageSize: 250 })("roles", ws);
    expect(all).toHaveLength(2005);
    expect(new Set(all.map((r) => r.id)).size).toBe(2005);
  });

  it("says so, instead of running out of memory, when a table is too large", async () => {
    await expect(supabaseReader(db, { pageSize: 10, maxRows: 30 })("roles", ws)).rejects.toBeInstanceOf(BundleTooLargeError);
    await expect(supabaseReader(db, { pageSize: 10, maxRows: 30 })("roles", ws)).rejects.toThrow(/too large to export/);
  });

  it("reads an empty table as no rows, and never asks for a column the app can't read", async () => {
    expect(await supabaseReader(db)("roles", otherWs)).toEqual([]);
    const rows = await supabaseReader(db)("suggestion_proposals", ws);
    expect(rows).toHaveLength(3);
    const columns = BUNDLE_TABLES.suggestion_proposals.columns.split(",").map((c) => c.trim());
    expect(columns).not.toContain("proposer_email");
    expect(Object.keys(rows[0]!).sort()).toEqual([...columns].sort());
  });

  it("refuses a table that is not part of a bundle", async () => {
    await expect(supabaseReader(db)("api_tokens", ws)).rejects.toThrow(/Not a bundle table/);
    await expect(supabaseReader(db)("memberships", ws)).rejects.toThrow(/Not a bundle table/);
  });
});
