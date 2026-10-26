import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existingSourceIds, loadStepNames, NORTHBEAM_WORKSPACE_ID, type Db } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Reads of a long list of ids (the Sources page): one statement each however long the list, where the PostgREST port read
// 100 ids at a time, a statement (three round trips through the ClaimsDriver) per batch.

const ws = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let viewer: Db;
let statements = 0;

beforeAll(async () => {
  tdb = await createTestDb();
  const v = await createUser(tdb, "viewer@id-lists.example.com");
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, v.id]);
  viewer = tdb.dbAs(v.claims as never).withPlugin({ transformQuery: ({ node }) => (statements++, node), transformResult: async ({ result }) => result });
});
afterAll(async () => {
  await tdb?.close();
});

const noise = (n: number) => Array.from({ length: n }, () => randomUUID());

describe("existingSourceIds", () => {
  it("finds the sources that exist among 250 ids in one statement", async () => {
    const real = (await tdb.client.query("select id from sources where workspace_id = $1", [ws])).rows.map((r) => r.id as string);
    expect(real.length).toBeGreaterThan(0);
    statements = 0;
    const found = await existingSourceIds(viewer, [...noise(200), ...real, ...noise(50)]);
    expect(statements).toBe(1);
    expect([...found].sort()).toEqual([...real].sort());
    statements = 0;
    expect(await existingSourceIds(viewer, [])).toEqual(new Set());
    expect(statements).toBe(0);
  });
});

describe("loadStepNames", () => {
  it("names steps among 250 ids in one statement, the latest written name winning", async () => {
    const step = (await tdb.client.query("select id, name from steps where workspace_id = $1 order by updated_at desc limit 1", [ws])).rows[0] as { id: string; name: string };
    statements = 0;
    const names = await loadStepNames(viewer, [...noise(240), step.id, ...noise(9)]);
    expect(statements).toBe(1);
    expect(names).toEqual([{ id: step.id, name: step.name }]);
  });
});
