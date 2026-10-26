import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamIssues } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// A48: resolving an issue records how it was resolved and a note; the history keeps them; reopening clears the issue's
// own copy and logs.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const target = northbeamIssues()[2]!.id;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["editor", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@northbeam.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
});
afterAll(async () => {
  await db?.close();
});

type Client = pg.Client;
const resolve = async (c: Client, id: string, how: string, note: string | null = null, status = "resolved") =>
  (await c.query("select public.resolve_issue($1, $2, $3, $4, $5) as r", [ws, id, how, note, status])).rows[0].r as Record<string, unknown>;
const reopen = async (c: Client, id: string) =>
  (await c.query("select public.save_issue($1, $2, $3) as r", [ws, JSON.stringify({ status: "open" }), id])).rows[0].r as Record<string, unknown>;
const events = async (c: Client, id: string) => (await c.query("select kind, actor, detail from issue_events where issue_id = $1 order by seq", [id])).rows;

describe("resolve_issue", () => {
  it("resolves with how and a note, and logs one resolved entry carrying both", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await resolve(c, target, "process_change", "  We removed the call.  ");
      expect(r).toMatchObject({ status: "done", resolution: null, resolved_how: "process_change", resolution_note: "We removed the call." });
      expect(r.resolved_at).not.toBeNull();
      const log = await events(c, target);
      expect(log.at(-1)).toMatchObject({ kind: "resolved", actor: users.editor!.id, detail: { from: "open", to: "resolved", how: "process_change", note: "We removed the call." } });
      expect(log.filter((e) => e.kind === "resolved")).toHaveLength(1);
    });
  });

  it("leaves out an empty note, and can mark won't fix", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await resolve(c, target, "not_a_problem", "   ", "wont_fix");
      const log = await events(c, target);
      expect(log.at(-1)!.detail).toEqual({ from: "open", to: "wont_fix", how: "not_a_problem" });
    });
  });

  it("reopening clears the issue's how and note, logs reopened, and keeps the resolved entry", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await resolve(c, target, "solution", "Lead scoring fixed it");
      const r = await reopen(c, target);
      expect(r).toMatchObject({ status: "open", resolved_how: null, resolution_note: null, resolved_at: null });
      const log = await events(c, target);
      expect(log.map((e) => e.kind)).toEqual(["created", "resolved", "reopened"]);
      expect(log[1]!.detail).toMatchObject({ how: "solution", note: "Lead scoring fixed it" });
      expect(log[2]!.detail).toEqual({ from: "resolved", to: "open" });
    });
  });

  it("refuses a viewer, a bad how or status, an unknown issue, and a note over 2000 characters", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      await expect(resolve(c, target, "solution")).rejects.toThrow(/cannot change issues/);
    });
    await db.as(users.editor!.claims, async (c) => {
      for (const run of [
        () => resolve(c, target, "magic"),
        () => resolve(c, target, "solution", null, "open"),
        () => resolve(c, "00000000-0000-0000-0000-000000000000", "solution"),
        () => resolve(c, target, "solution", "x".repeat(2001)),
        // A missing way or status is refused, not slipped past the check by a null.
        () => resolve(c, target, null as never),
        () => resolve(c, target, "solution", null, null as never),
      ]) {
        await c.query("savepoint s");
        await expect(run()).rejects.toThrow();
        await c.query("rollback to savepoint s");
      }
    });
  });

  it("refuses an issue that is already resolved or won't fix, with a clear error, and keeps what was recorded", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await resolve(c, target, "solution", "First");
      await c.query("savepoint s");
      await expect(resolve(c, target, "not_a_problem", "Second")).rejects.toThrow(/already resolved/);
      await c.query("rollback to savepoint s");
      expect((await c.query("select resolved_how, resolution_note from issues where id = $1", [target])).rows[0]).toEqual({ resolved_how: "solution", resolution_note: "First" });
      await reopen(c, target);
      await resolve(c, target, "process_change", null, "wont_fix");
      await c.query("savepoint s");
      await expect(resolve(c, target, "solution")).rejects.toThrow(/already resolved/);
      await c.query("rollback to savepoint s");
    });
  });

  it("the header's rollback works as written: with the columns gone, status changes still log", async () => {
    const sql = readFileSync(new URL("../migrations/20261121500000_issue_resolution.sql", import.meta.url), "utf8");
    const header = sql.slice(sql.indexOf("-- Rollback"), sql.indexOf("\nalter table public.issues\n  add column"));
    const steps = header
      .split("\n")
      .filter((l) => l.startsWith("--   ") || l === "--")
      .map((l) => l.slice(5))
      .join("\n");
    // Between the `begin;` and `commit;` the header gives; the schema_migrations row doesn't exist in the test database.
    const body = steps.slice(steps.indexOf("begin;") + 6, steps.indexOf("commit;")).replace(/delete from supabase_migrations\.schema_migrations[^;]*;/, "");
    expect(body).toContain("create or replace function private.log_issue_change()");
    // The function must come back before the columns go.
    expect(body.indexOf("create or replace function private.log_issue_change()")).toBeLessThan(body.indexOf("drop column resolved_how"));
    // Rollbacks run newest first: A50's migration (20261125000000) sits on top of this one, and its trigger reads `resolved_how`.
    const newer = readFileSync(new URL("../migrations/20261125000000_resolution_solution.sql", import.meta.url), "utf8");
    const newerSteps = newer
      .slice(newer.indexOf("-- Rollback"), newer.indexOf("\nalter table public.issues add column"))
      .split("\n")
      .filter((l) => l.startsWith("--   ") || l === "--")
      .map((l) => l.slice(5))
      .join("\n");
    const newerBody = newerSteps.slice(newerSteps.indexOf("begin;") + 6, newerSteps.indexOf("commit;")).replace(/delete from supabase_migrations\.schema_migrations[^;]*;/, "");
    await db.client.query("begin");
    try {
      await db.client.query(newerBody);
      await db.client.query(body);
      const cols = (await db.client.query("select count(*)::int as n from information_schema.columns where table_name = 'issues' and column_name in ('resolved_how', 'resolution_note')")).rows[0].n;
      expect(cols).toBe(0);
      await db.client.query("update issues set status = 'done' where id = $1", [target]);
      await db.client.query("update issues set status = 'open' where id = $1", [target]);
      const kinds = (await db.client.query("select kind from issue_events where issue_id = $1 order by seq", [target])).rows.map((r) => r.kind);
      expect(kinds).toEqual(["created", "resolved", "reopened"]);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("locks the issue row while it checks it, so two people resolving at once take turns", async () => {
    const def = (await db.client.query("select pg_get_functiondef('public.resolve_issue(uuid, uuid, text, text, text)'::regprocedure) as d")).rows[0].d as string;
    expect(def).toMatch(/for update/i);
    // A second connection that resolves while the first holds the row waits, then sees it resolved.
    const second = new (await import("pg")).default.Client({ connectionString: db.url });
    await second.connect();
    try {
      await db.client.query("begin");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.editor!.claims)]);
      await db.client.query("set local role authenticated");
      await resolve(db.client, target, "solution", "First");
      await second.query("begin");
      await second.query("set local role authenticated");
      await second.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.editor!.claims)]);
      const racing = second.query("select public.resolve_issue($1, $2, 'not_a_problem', 'Second', 'resolved')", [ws, target]).then(
        () => "passed",
        (e: Error) => e.message,
      );
      // It is blocked on the row lock until the first transaction ends.
      const early = await Promise.race([racing, new Promise((r) => setTimeout(() => r("waiting"), 400))]);
      expect(early).toBe("waiting");
      await db.client.query("commit");
      expect(await racing).toMatch(/already resolved/);
      await second.query("rollback");
      // Put the issue back for later tests.
      await db.client.query("update issues set status = 'open' where id = $1", [target]);
    } finally {
      await second.end();
    }
  });

  it("the table check rejects a how that is not one of the three", async () => {
    await expect(db.client.query("update issues set status = 'done', resolved_how = 'because' where id = $1", [target])).rejects.toThrow(/issues_resolved_how_check/);
  });
});
