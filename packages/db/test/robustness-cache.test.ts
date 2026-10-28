import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The robustness cache (issue #28; migration 20261019000000_reports.sql): cached
// robustness jobs. The `reports` table and `report_download` were dropped with the
// PDF reports (20270101000000_drop_in_app_ai.sql).

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let runId: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    // The old role names map as migration 20270103000000 maps them: editor -> owner (Agency admin), member -> viewer.
    users[role] = await createUser(db, `${role}@reports.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@reports.example.com");
  runId = (
    await db.client.query(
      "insert into runs (workspace_id, process_id, name, reps, seed, params_snapshot) values ($1, $2, 'Report run', 200, 1, '{}') returning id",
      [ws, NORTHBEAM_PROCESS_ID],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const one = async (c: pg.Client, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
const count = async (c: pg.Client, table: string) => (await one(c, `select count(*)::int as n from ${table}`)).n as number;

describe("robustness cache", () => {
  const insertJob = (c: pg.Client, key = "v1|model|scenario|steps.a.work_hours|0.75|1|0+10", check = "v1|model|scenario") =>
    c.query("insert into robustness_results (workspace_id, run_id, check_key, cache_key, results) values ($1, $2, $3, $4, $5)", [
      ws,
      runId,
      check,
      key,
      JSON.stringify({ baseline: { won: [1], mrrAdded: [0], util: {} }, scenario: { won: [2], mrrAdded: [0], util: {} } }),
    ]);

  it("editors write cached jobs; owners and editors read them (B1 2/3: results hold per-person utilisation); others can't", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await insertJob(c)).rowCount).toBe(1);
      // One row per job and workspace.
      await expect(insertJob(c)).rejects.toThrow(/duplicate key/);
    });
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => insertJob(c)), role).rejects.toThrow(/row-level security/);
    }
    await insertJob(db.client);
    expect(await db.as(users.editor!.claims, (c) => count(c, "robustness_results"))).toBe(1);
    expect(await db.as(users.viewer!.claims, (c) => count(c, "robustness_results"))).toBe(0);
    expect(await db.as(users.stranger!.claims, (c) => count(c, "robustness_results"))).toBe(0);
    await db.client.query("delete from robustness_results");
  });

  it("a job's key must extend its check's key", async () => {
    await expect(insertJob(db.client, "v1|other|scenario|-|1|1|0+10")).rejects.toThrow(/robustness_results_cache_key/);
  });
});
