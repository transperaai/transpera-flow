import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Narration (issue #29; migration 20261020000000_narration.sql): the cache
// and record of every narration outcome. Summaries are for editors (they can
// name people with their utilisation); explanations of a run for anyone in
// the workspace; editors write; `edited_by` is always the writer.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let runId: string;
const HASH = "a".repeat(64);

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@narrations.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@narrations.example.com");
  runId = (
    await db.client.query("insert into runs (workspace_id, process_id, name, reps, seed, params_snapshot) values ($1, $2, 'Run', 200, 1, '{}') returning id", [
      ws,
      NORTHBEAM_PROCESS_ID,
    ])
  ).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const insert = (c: pg.Client, fields: Record<string, unknown> = {}) => {
  const row = {
    workspace_id: ws,
    target: "run",
    target_id: runId,
    purpose: "summary",
    input_hash: HASH,
    model: "claude-opus-5-5",
    text: "Wins avg 8.6 (range 6–12).",
    validated: true,
    fallback: false,
    checked: 3,
    ...fields,
  };
  const keys = Object.keys(row);
  return c.query(`insert into narrations (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row));
};
const count = async (c: pg.Client) => (await c.query("select count(*)::int as n from narrations")).rows[0].n as number;

describe("narrations", () => {
  it("editors and owners write; members, viewers and strangers can't", async () => {
    for (const role of ["editor", "owner"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await insert(c)).rowCount, role).toBe(1);
      });
    }
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => insert(c)), role).rejects.toThrow(/row-level security/);
    }
  });

  it("summaries are read by editors only; explanations by the whole workspace", async () => {
    await db.client.query("begin");
    try {
      await insert(db.client);
      await insert(db.client, { purpose: "explain" });
      await db.client.query("commit");
    } catch (err) {
      await db.client.query("rollback");
      throw err;
    }
    expect(await db.as(users.editor!.claims, count)).toBe(2);
    for (const role of ["member", "viewer"]) {
      const purposes = await db.as(users[role]!.claims, async (c) => (await c.query("select purpose from narrations")).rows.map((r) => r.purpose));
      expect(purposes, role).toEqual(["explain"]);
    }
    expect(await db.as(users.stranger!.claims, count)).toBe(0);
    await db.client.query("delete from narrations");
  });

  it("is one row per run, purpose and input; the outcome is either a checked narration or a recorded fallback", async () => {
    const as = (fn: (c: pg.Client) => Promise<unknown>) => db.as(users.editor!.claims, fn);
    await expect(as(async (c) => [await insert(c), await insert(c)])).rejects.toThrow(/unique/);
    await as((c) => insert(c, { input_hash: "b".repeat(64), validated: false, fallback: true, fallback_kind: "invalid", fallback_reason: "both drafts cited £9k" }));
    await expect(as((c) => insert(c, { validated: true, fallback: true }))).rejects.toThrow(/narrations_outcome/);
    await expect(as((c) => insert(c, { validated: false, fallback: true }))).rejects.toThrow(/narrations_outcome/);
    await expect(as((c) => insert(c, { input_hash: "not a hash" }))).rejects.toThrow(/narrations_input_hash/);
  });

  it("records who edited, and only as themselves", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = (await insert(c)).rows[0].id;
      await c.query("update narrations set text = 'Edited.', edited_by = $2, edited_by_name = 'editor', edited_at = now() where id = $1", [id, users.editor!.id]);
      expect((await c.query("select edited_by from narrations where id = $1", [id])).rows[0].edited_by).toBe(users.editor!.id);
      await expect(c.query("update narrations set edited_by = $2 where id = $1", [id, users.owner!.id])).rejects.toThrow(/row-level security/);
    });
  });

  it("anon can't touch narrations", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select count(*) from narrations")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});
