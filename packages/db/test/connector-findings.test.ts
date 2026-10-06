import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Claude outside the app proposes findings (issue #197, B20; migration 20261212000000). A request made with an API token
// may only insert a PROPOSED AI finding with no analysis; the trigger stamps `proposed_via = 'connector'` and the key. A
// person accepts it in the app (a session). Nothing is accepted, dismissed or edited over a token.

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
let db: TestDb;
let otherWs: string;
let otherSource: string;
let secondProc: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

const token = (who: string) => ({ ...users[who]!.claims, api_token_id: randomUUID() });
const session = (who: string) => users[who]!.claims;

/** Commit as the given claims (db.as rolls back; some checks need the rows to stay). */
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

const insert = (c: pg.Client, extra: Record<string, unknown> = {}) => {
  const row = { workspace_id: ws, process_id: proc, origin: "ai", status: "proposed", rating: "bad", type: "delay", title: "Proposals wait for Team member A", why: "Clients wait.", ...extra };
  const cols = Object.keys(row);
  return c.query(`insert into findings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, Object.values(row));
};
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@connector.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-connector') returning id")).rows[0].id;
  otherSource = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'Their call') returning id", [otherWs])).rows[0].id;
  secondProc = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Second') returning id", [ws])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.client.query("delete from findings");
});

describe("a token proposes", () => {
  it("stores an AI proposal with no analysis, stamped as from the connector, keyed by place and title", async () => {
    const r = (await commitAs(token("editor"), (c) => insert(c, { proposed_via: null, ai_key: "ai:insight:forged", decided_by: users.owner!.id, edited: true }))).rows[0];
    expect(r).toMatchObject({ origin: "ai", status: "proposed", proposed_via: "connector", created_by: users.editor!.id, decided_by: null, decided_at: null, edited: false, analysis_id: null, run_id: null });
    expect(r.ai_key).toMatch(/^ai:connector:[0-9a-f]{64}$/);
  });

  it("derives the key from the place and the title, ignoring case and spacing", async () => {
    const a = (await commitAs(token("editor"), (c) => insert(c, { title: "Proposals  wait" }))).rows[0];
    const [b] = await q("select encode(sha256(convert_to($1 || '|proposals wait', 'UTF8')), 'hex') h", [proc]);
    expect(a.ai_key).toBe(`ai:connector:${b.h}`);
  });

  it("refuses what would skip review: accepted, by hand, or backed by an analysis (42501)", async () => {
    await expect(commitAs(token("editor"), (c) => insert(c, { status: "accepted" }))).rejects.toMatchObject({ code: "42501" });
    await expect(commitAs(token("editor"), (c) => insert(c, { origin: "manual", status: "accepted" }))).rejects.toMatchObject({ code: "42501" });
    await expect(commitAs(token("editor"), (c) => insert(c, { origin: "manual" }))).rejects.toMatchObject({ code: "42501" });
    // The editor's own fresh analysis and its run.
    await db.client.query("begin");
    await db.client.query("set local session_replication_role = replica");
    const run = (await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id) values ($1, $2, 'manual', $3) returning id", [ws, proc, users.editor!.id])).rows[0].id;
    const analysis = (
      await db.client.query("insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, run_id, created_by) values ($1, $2, $3, 'ok', 'manual', 'h', $4, $5) returning id", [
        ws, proc, NORTHBEAM_REVISION_ID, run, users.editor!.id,
      ])
    ).rows[0].id;
    await db.client.query("commit");
    await expect(commitAs(token("editor"), (c) => insert(c, { analysis_id: analysis, run_id: run }))).rejects.toMatchObject({ code: "42501" });
    // The same insert from the session (the app's path) still works: the in-app rule is unchanged.
    const ok = (await commitAs(session("editor"), (c) => insert(c, { analysis_id: analysis, run_id: run, ai_key: "ai:insight:abc" }))).rows[0];
    expect(ok.proposed_via).toBeNull();
    await db.client.query("delete from findings");
    await db.client.query("delete from ai_analyses");
    await db.client.query("delete from ai_runs");
  });

  it("refuses every update over a token: accept, dismiss and edit, of a connector proposal and of an app one (42501)", async () => {
    const mine = (await commitAs(token("editor"), (c) => insert(c))).rows[0].id as string;
    // An app AI proposal: inserted as the system (no caller), as the app's own analysis path would leave it.
    const app = (await db.client.query("insert into findings (workspace_id, process_id, origin, status, rating, type, title, ai_key) values ($1, $2, 'ai', 'proposed', 'bad', 'delay', 'App finding', 'ai:insight:app1') returning id", [ws, proc])).rows[0].id as string;
    for (const id of [mine, app]) {
      await expect(commitAs(token("editor"), (c) => c.query("update findings set status = 'accepted' where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
      await expect(commitAs(token("editor"), (c) => c.query("update findings set status = 'dismissed' where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
      await expect(commitAs(token("editor"), (c) => c.query("update findings set title = 'Changed' where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    }
    expect(await q("select status, title from findings where id = any($1) order by title", [[mine, app]])).toEqual([
      { status: "proposed", title: "App finding" },
      { status: "proposed", title: "Proposals wait for Team member A" },
    ]);
  });

  it("refuses a member's and a viewer's token (row-level security, 42501)", async () => {
    await expect(commitAs(token("member"), (c) => insert(c))).rejects.toMatchObject({ code: "42501" });
    await expect(commitAs(token("viewer"), (c) => insert(c))).rejects.toMatchObject({ code: "42501" });
    expect(await q("select count(*)::int n from findings")).toEqual([{ n: 0 }]);
  });

  it("refuses a source of another workspace (23514)", async () => {
    await expect(commitAs(token("editor"), (c) => insert(c, { source_ids: [otherSource] }))).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a process of another workspace (23514)", async () => {
    const theirs = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Theirs') returning id", [otherWs])).rows[0].id;
    await expect(commitAs(token("editor"), (c) => insert(c, { process_id: theirs }))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("a person reviews it in the app", () => {
  it("accepts it as the session editor: decided by them, still from the connector", async () => {
    const id = (await commitAs(token("editor"), (c) => insert(c))).rows[0].id as string;
    const r = (await commitAs(session("editor"), (c) => c.query("update findings set status = 'accepted' where id = $1 returning *", [id]))).rows[0];
    expect(r).toMatchObject({ status: "accepted", decided_by: users.editor!.id, proposed_via: "connector", edited: false });
  });

  it("marks it edited when a person changes its words; the stamp can't be cleared or forged", async () => {
    const id = (await commitAs(token("editor"), (c) => insert(c))).rows[0].id as string;
    const r = (await commitAs(session("editor"), (c) => c.query("update findings set title = 'Better words' where id = $1 returning *", [id]))).rows[0];
    expect(r).toMatchObject({ edited: true, proposed_via: "connector" });
    await expect(commitAs(session("editor"), (c) => c.query("update findings set proposed_via = null where id = $1", [id]))).rejects.toMatchObject({ code: "23514" });
  });

  it("dismisses it", async () => {
    const id = (await commitAs(token("editor"), (c) => insert(c))).rows[0].id as string;
    const r = (await commitAs(session("owner"), (c) => c.query("update findings set status = 'dismissed' where id = $1 returning *", [id]))).rows[0];
    expect(r).toMatchObject({ status: "dismissed", decided_by: users.owner!.id });
  });
});

describe("a session can't pass as the connector", () => {
  it("stamps null when a session sends proposed_via", async () => {
    const r = (await commitAs(session("editor"), (c) => insert(c, { origin: "manual", status: "accepted", proposed_via: "connector" }))).rows[0];
    expect(r.proposed_via).toBeNull();
  });

  it("refuses a key with the connector prefix (23514)", async () => {
    await expect(commitAs(session("editor"), (c) => insert(c, { ai_key: "ai:connector:" + "0".repeat(64) }))).rejects.toMatchObject({ code: "23514" });
  });

  it("still can't write an AI finding without an analysis (unchanged rule, 42501)", async () => {
    await expect(commitAs(session("editor"), (c) => insert(c, { ai_key: "ai:insight:zzz" }))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("duplicates", () => {
  it("refuses the same place and title again, case and spacing ignored (23505), even once dismissed", async () => {
    const id = (await commitAs(token("editor"), (c) => insert(c, { title: "Proposals wait" }))).rows[0].id as string;
    await expect(commitAs(token("editor"), (c) => insert(c, { title: "  PROPOSALS   wait " }))).rejects.toMatchObject({ code: "23505" });
    await commitAs(session("editor"), (c) => c.query("update findings set status = 'dismissed' where id = $1", [id]));
    await expect(commitAs(token("editor"), (c) => insert(c, { title: "Proposals wait" }))).rejects.toMatchObject({ code: "23505" });
  });

  it("allows the same title on another process and across the company", async () => {
    await commitAs(token("editor"), (c) => insert(c, { title: "Same words" }));
    await commitAs(token("editor"), (c) => insert(c, { title: "Same words", process_id: secondProc }));
    await commitAs(token("editor"), (c) => insert(c, { title: "Same words", process_id: null }));
    expect(await q("select count(*)::int n from findings where proposed_via = 'connector'")).toEqual([{ n: 3 }]);
  });
});

describe("caps", () => {
  /** n connector rows made `age` ago, as the administrator with triggers off. */
  async function seed(n: number, age: string, status = "proposed") {
    await db.client.query("begin");
    await db.client.query("set local session_replication_role = replica");
    await db.client.query(
      `insert into findings (workspace_id, process_id, origin, status, rating, type, title, ai_key, proposed_via, created_at)
       select $1, $2, 'ai', $3, 'bad', 'delay', 'Seed ' || g, 'ai:connector:seed' || g, 'connector', now() - $4::interval from generate_series(1, $5) g`,
      [ws, proc, status, age, n],
    );
    await db.client.query("commit");
  }

  it("refuses the 101st proposal in 24 hours (54000)", async () => {
    await seed(100, "1 hour", "dismissed");
    await expect(commitAs(token("editor"), (c) => insert(c, { title: "One too many" }))).rejects.toMatchObject({ code: "54000", message: /100 findings/ });
    // Older ones don't count.
    await db.client.query("alter table findings disable trigger findings_before_write");
    await db.client.query("update findings set created_at = now() - interval '25 hours'");
    await db.client.query("alter table findings enable trigger findings_before_write");
    await expect(commitAs(token("editor"), (c) => insert(c, { title: "Now fine" }))).resolves.toBeDefined();
  });

  it("refuses a proposal while 50 wait for review, and lets it through once one is dismissed in the app (54000)", async () => {
    await seed(50, "2 days");
    await expect(commitAs(token("editor"), (c) => insert(c, { title: "Fifty one" }))).rejects.toMatchObject({ code: "54000", message: /50 findings/ });
    await commitAs(session("editor"), (c) => c.query("update findings set status = 'dismissed' where ai_key = 'ai:connector:seed1'"));
    await expect(commitAs(token("editor"), (c) => insert(c, { title: "Fifty one" }))).resolves.toBeDefined();
  });

  it("counts per workspace", async () => {
    await seed(50, "2 days");
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Third', $1) returning id", [`third-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
    const otherProc = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'P') returning id", [other])).rows[0].id as string;
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [other, users.editor!.id]);
    await expect(commitAs(token("editor"), (c) => insert(c, { workspace_id: other, process_id: otherProc, title: "Elsewhere" }))).resolves.toBeDefined();
  });
});
