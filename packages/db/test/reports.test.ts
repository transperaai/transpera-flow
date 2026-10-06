import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// PDF reports and the robustness cache (issue #28; migration
// 20261019000000_reports.sql): who can read and write reports (they hold
// per-person utilisation: editors, owners and agency admins only), download
// links as hashed tokens with an expiry, and cached robustness jobs.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let otherWs: string;
let runId: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@reports.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@reports.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-reports') returning id")).rows[0].id;
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

const insertReport = (c: pg.Client, extra: { run?: string | null; workspace?: string } = {}) =>
  c.query(
    "insert into reports (workspace_id, process_id, run_id, title, options, content) values ($1, $2, $3, 'Lead to live: process report', '{}', $4) returning id",
    [extra.workspace ?? ws, (extra.workspace ?? ws) === ws ? NORTHBEAM_PROCESS_ID : null, extra.run === undefined ? runId : extra.run, JSON.stringify({ version: 1, kpis: [] })],
  );

/** A download token as the app makes it: 32 random bytes, base64url; the row keeps its SHA-256. */
const newToken = () => {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
};

/** Run `fn` as the anonymous role (someone opening a link without signing in). */
async function asAnon<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role anon");
    await db.client.query("select set_config('request.jwt.claims', '', true)");
    return await fn(db.client);
  } finally {
    await db.client.query("rollback");
  }
}

describe("reports", () => {
  it("editors and owners create and read reports; members, viewers and strangers can't see or make them", async () => {
    for (const role of ["editor", "owner"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await insertReport(c)).rowCount, role).toBe(1);
        expect(await count(c, "reports"), role).toBe(1);
      });
    }
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => insertReport(c)), role).rejects.toThrow(/row-level security/);
    }
    await insertReport(db.client);
    for (const role of ["member", "viewer", "stranger"]) {
      expect(await db.as(users[role]!.claims, (c) => count(c, "reports")), role).toBe(0);
    }
    expect(await db.as(users.editor!.claims, (c) => count(c, "reports"))).toBe(1);
    await asAnon(async (c) => {
      await expect(c.query("select count(*) from reports")).rejects.toThrow(/permission denied/);
    });
    await db.client.query("delete from reports");
  });

  it("a report can't point at another workspace's run, and outlives its run", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await expect(insertReport(c, { workspace: otherWs })).rejects.toThrow(/row-level security/);
    });
    const otherRun = (await db.client.query("insert into runs (workspace_id, name, reps, seed, params_snapshot) values ($1, 'x', 1, 1, '{}') returning id", [otherWs])).rows[0].id;
    await expect(insertReport(db.client, { run: otherRun })).rejects.toThrow(/foreign key/);
    await db.client.query("begin");
    try {
      const id = (await insertReport(db.client)).rows[0].id;
      await db.client.query("delete from runs where id = $1", [runId]);
      expect((await one(db.client, "select run_id from reports where id = $1", [id])).run_id).toBeNull();
    } finally {
      await db.client.query("rollback");
    }
  });

  it("stores the PDF bytes", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(2048), Buffer.from("\n%%EOF")]);
    await db.as(users.editor!.claims, async (c) => {
      const id = (await insertReport(c)).rows[0].id;
      await c.query("update reports set pdf = $2, pdf_generated_at = now() where id = $1", [id, pdf]);
      const row = await one(c, "select pdf from reports where id = $1", [id]);
      expect(Buffer.compare(row.pdf, pdf)).toBe(0);
    });
  });

  it("a download link returns its report to anyone holding the token until it expires", async () => {
    const live = newToken();
    const expired = newToken();
    const pdf = Buffer.from("%PDF-1.7 test");
    await db.client.query("begin");
    try {
      const a = (await insertReport(db.client)).rows[0].id;
      const b = (await insertReport(db.client)).rows[0].id;
      await db.client.query("update reports set pdf = $2, link_hash = $3, link_expires_at = now() + interval '1 hour' where id = $1", [a, pdf, live.hash]);
      await db.client.query("update reports set link_hash = $2, link_expires_at = now() - interval '1 second' where id = $1", [b, expired.hash]);
      await db.client.query("commit");
    } catch (err) {
      await db.client.query("rollback");
      throw err;
    }
    const download = (c: pg.Client, token: string) => c.query("select * from public.report_download($1)", [token]);
    await asAnon(async (c) => {
      const rows = (await download(c, live.token)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Lead to live: process report");
      expect(Buffer.compare(rows[0].pdf, pdf)).toBe(0);
      expect(rows[0].content).toEqual({ version: 1, kpis: [] });
      expect((await download(c, expired.token)).rows).toHaveLength(0);
      expect((await download(c, newToken().token)).rows).toHaveLength(0);
      // The hash itself, or anything not shaped like a token, finds nothing.
      expect((await download(c, live.hash)).rows).toHaveLength(0);
      expect((await download(c, "' or true --")).rows).toHaveLength(0);
    });
    // A stranger signed in gets the same as anyone with the link, and nothing without it.
    expect(await db.as(users.stranger!.claims, async (c) => (await download(c, live.token)).rowCount)).toBe(1);
    expect(await db.as(users.stranger!.claims, (c) => count(c, "reports"))).toBe(0);
    await db.client.query("delete from reports");
  });

  it("checks the link's shape and that it has an expiry", async () => {
    await expect(db.client.query("update reports set link_hash = 'abc'")).resolves.toBeDefined(); // no rows yet
    const id = (await insertReport(db.client)).rows[0].id;
    await expect(db.client.query("update reports set link_hash = 'abc', link_expires_at = now() where id = $1", [id])).rejects.toThrow(/reports_link_hash/);
    await expect(db.client.query("update reports set link_hash = $2 where id = $1", [id, newToken().hash])).rejects.toThrow(/reports_link/);
    await db.client.query("delete from reports");
  });
});

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
