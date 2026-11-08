import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { IMPORT_COLUMNS } from "../src";
import { createTestDb, type TestDb } from "./harness";

// Leadership flag on roles (capacity P9, migration 20270125000000_role_leadership.sql): existing roles are flagged by the name guess P5
// used, so no workspace's figures move; nothing else about a role changes, and a restore accepts the column.

const BASE = "20270120000000";
const WS = "00000000-0000-4000-8000-0000000000a1";
let db: TestDb;
let before: Record<string, unknown>[];

const roles = async () => (await db.client.query("select name, updated_at, active from public.roles where workspace_id = $1 order by name", [WS])).rows;

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  await db.client.query("insert into public.workspaces (id, name, slug) values ($1, 'Leadership', 'leadership-p9')", [WS]);
  for (const n of ["Founder", "Head of Client Services", "Growth Strategy Lead", "SEO Director", "SEO Manager / Analyst", "Content team"]) {
    await db.client.query("insert into public.roles (workspace_id, name) values ($1, $2)", [WS, n]);
  }
  before = await roles();
  const applied = await applyMigrations(db.client, {});
  expect(applied.files).toContain("20270125000000_role_leadership.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the leadership column", () => {
  it("flags the directors and heads that the name guess did, and nobody else", async () => {
    const r = await db.client.query("select name from public.roles where workspace_id = $1 and leadership order by name", [WS]);
    expect(r.rows.map((x) => x.name)).toEqual(["Founder", "Growth Strategy Lead", "Head of Client Services", "SEO Director"]);
  });

  it("changes no other part of a role, and not updated_at", async () => {
    expect(await roles()).toEqual(before);
  });

  it("is a column a restore accepts", () => {
    expect(IMPORT_COLUMNS.roles).toContain("leadership");
  });
});
