import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The block library (issue #116): a saved bundle of steps per workspace. Every member reads, owners and editors write,
// no one reaches another workspace's blocks, the checks refuse a malformed block, and `anon` has no access.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let otherWs: string;
let otherBlock: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });

const add = (c: { query: TestDb["client"]["query"] }, workspace: string, name = "Client sign-off", type = "manual") =>
  c.query("insert into blocks (workspace_id, name, type, steps) values ($1, $2, $3, $4::jsonb) returning id", [workspace, name, type, bundle]);

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@blocks.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@blocks.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-blocks') returning id")).rows[0].id;
  otherBlock = (await add(db.client, otherWs, "Theirs")).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("blocks: row-level security", () => {
  it("starts empty in a workspace: no blocks means an empty library", async () => {
    expect((await db.client.query("select 1 from blocks where workspace_id = $1", [ws])).rowCount).toBe(0);
  });

  it("lets owners and editors add, change and remove a block", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await add(c, ws)).rows[0].id;
        const r = await c.query("update blocks set name = 'Renamed', description = 'Two steps' where id = $1", [id]);
        expect(r.rowCount, role).toBe(1);
        expect((await c.query("delete from blocks where id = $1", [id])).rowCount, role).toBe(1);
      });
    }
  });

  it("lets every member read the workspace's blocks", async () => {
    const id = (await add(db.client, ws)).rows[0].id;
    try {
      for (const role of ["owner", "editor", "member", "viewer"]) {
        const rows = await db.as(users[role]!.claims, async (c) => (await c.query("select name, type from blocks")).rows);
        expect(rows, role).toEqual([{ name: "Client sign-off", type: "manual" }]);
      }
    } finally {
      await db.client.query("delete from blocks where id = $1", [id]);
    }
  });

  it("stops members and viewers writing", async () => {
    const id = (await add(db.client, ws)).rows[0].id;
    try {
      for (const role of ["member", "viewer"]) {
        await db.as(users[role]!.claims, async (c) => {
          expect((await c.query("update blocks set name = 'Mine' where id = $1", [id])).rowCount, role).toBe(0);
          expect((await c.query("delete from blocks where id = $1", [id])).rowCount, role).toBe(0);
        });
        await expect(db.as(users[role]!.claims, (c) => add(c, ws)), role).rejects.toThrow(/row-level security/);
      }
      expect((await db.client.query("select name from blocks where id = $1", [id])).rows[0].name).toBe("Client sign-off");
    } finally {
      await db.client.query("delete from blocks where id = $1", [id]);
    }
  });

  it("hides another workspace's blocks, and stops editors writing into it", async () => {
    expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select 1 from blocks")).rowCount)).toBe(0);
    const seen = await db.as(users.owner!.claims, async (c) => (await c.query("select workspace_id from blocks")).rows);
    expect(seen.every((r) => r.workspace_id === ws)).toBe(true);
    await expect(db.as(users.editor!.claims, (c) => add(c, otherWs))).rejects.toThrow(/row-level security/);
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("update blocks set name = 'Mine' where id = $1", [otherBlock])).rowCount).toBe(0);
      expect((await c.query("delete from blocks where id = $1", [otherBlock])).rowCount).toBe(0);
    });
  });

  it("can't move a block to another workspace", async () => {
    const id = (await add(db.client, ws)).rows[0].id;
    try {
      await db.as(users.editor!.claims, async (c) => {
        await expect(c.query("update blocks set workspace_id = $1 where id = $2", [otherWs, id])).rejects.toThrow();
      });
    } finally {
      await db.client.query("delete from blocks where id = $1", [id]);
    }
  });

  it("gives the anon role no access", async () => {
    const r = await db.client.query("select has_table_privilege('anon', 'public.blocks', 'select') as can");
    expect(r.rows[0].can).toBe(false);
  });
});

describe("blocks: checks", () => {
  it("refuses a blank name, an unknown type and a malformed bundle", async () => {
    await expect(add(db.client, ws, "   ")).rejects.toThrow(/check/);
    await expect(add(db.client, ws, "x".repeat(201))).rejects.toThrow(/check/);
    await expect(add(db.client, ws, "Odd", "robot")).rejects.toThrow(/check/);
    for (const steps of ["[]", '"text"', '{"steps": [], "edges": {}}', '{"edges": []}', '{"steps": {}, "edges": []}']) {
      await expect(db.client.query("insert into blocks (workspace_id, name, steps) values ($1, 'Bad', $2::jsonb)", [ws, steps]), steps).rejects.toThrow(/check/);
    }
  });

  it("accepts both types, and defaults a block to manual with no description", async () => {
    const ai = await add(db.client, ws, "AI report check", "ai");
    const plain = await db.client.query("insert into blocks (workspace_id, name, steps) values ($1, 'Plain', $2::jsonb) returning type, description", [ws, bundle]);
    expect(plain.rows[0]).toEqual({ type: "manual", description: "" });
    await db.client.query("delete from blocks where workspace_id = $1", [ws]);
    expect(ai.rowCount).toBe(1);
  });

  it("stores the bundle as written and stamps the update time", async () => {
    const doc = { steps: [{ id: "a", name: "Check", kind: "task", parent_step_id: null }], edges: [], entry_step_id: "a" };
    const id = (await db.client.query("insert into blocks (workspace_id, name, steps) values ($1, 'Keep', $2::jsonb) returning id", [ws, JSON.stringify(doc)])).rows[0].id;
    await new Promise((r) => setTimeout(r, 5));
    await db.client.query("update blocks set description = 'Changed' where id = $1", [id]);
    const row = (await db.client.query("select steps, updated_at > created_at as touched from blocks where id = $1", [id])).rows[0];
    expect(row.steps).toEqual(doc);
    expect(row.touched).toBe(true);
    await db.client.query("delete from blocks where id = $1", [id]);
  });

  it("goes with its workspace", async () => {
    const id = (await db.client.query("insert into workspaces (name, slug) values ('Gone', 'gone-blocks') returning id")).rows[0].id;
    await add(db.client, id);
    await db.client.query("delete from workspaces where id = $1", [id]);
    expect((await db.client.query("select 1 from blocks where workspace_id = $1", [id])).rowCount).toBe(0);
  });
});

describe("blocks: a block a solution holds a copy of can't be deleted (20270203000100)", () => {
  const copyOf = (block: string) => JSON.stringify({ steps: [{ id: "s1", name: "From the block", provenance: { block } }, { id: "s2", name: "Own", provenance: {} }], edges: [], entry_step_id: null });
  const solution = (c: { query: TestDb["client"]["query"] }, block: string, name = "Uses it") =>
    c.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, $4, $5::jsonb) returning id", [
      ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, name, copyOf(block),
    ]);

  it("refuses the delete while a solution holds a copy, naming it, and allows it once none does", async () => {
    const block = (await add(db.client, ws, "Held")).rows[0].id as string;
    const sol = (await solution(db.client, block)).rows[0].id as string;
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("delete from blocks where id = $1", [block])).rejects.toMatchObject({ code: "23503", message: "block is used by a solution: Uses it" });
    });
    await db.client.query("delete from solutions where id = $1", [sol]);
    await db.as(users.editor!.claims, async (c) => expect((await c.query("delete from blocks where id = $1", [block])).rowCount).toBe(1));
    await db.client.query("delete from blocks where id = $1", [block]);
  });

  it("orders a solution saved during the delete: the delete waits for it, then refuses", async () => {
    const block = (await add(db.client, ws, "Raced")).rows[0].id as string;
    const a = new pg.Client({ connectionString: db.url });
    const b = new pg.Client({ connectionString: db.url });
    await Promise.all([a.connect(), b.connect()]);
    try {
      // A saves a solution with a copy of the block and hasn't committed; B's delete runs meanwhile.
      await a.query("begin");
      await solution(a, block, "Saved meanwhile");
      const deleting = b.query("delete from blocks where id = $1", [block]).then(() => "deleted", (e: { code?: string }) => e.code);
      await new Promise((r) => setTimeout(r, 150));
      await a.query("commit");
      expect(await deleting).toBe("23503");
      expect((await db.client.query("select 1 from blocks where id = $1", [block])).rowCount).toBe(1);
    } finally {
      await Promise.all([a.end(), b.end()]);
      await db.client.query("delete from solutions where name = 'Saved meanwhile'");
      await db.client.query("delete from blocks where id = $1", [block]);
    }
  });

  it("doesn't stop a workspace being deleted with its blocks and solutions", async () => {
    const id = (await db.client.query("insert into workspaces (name, slug) values ('Gone 2', 'gone-blocks-2') returning id")).rows[0].id;
    const block = (await add(db.client, id)).rows[0].id as string;
    const proc = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'P') returning id", [id])).rows[0].id;
    const rev = (await db.client.query("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [id, proc])).rows[0].id;
    await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'S', $4::jsonb)", [id, proc, rev, copyOf(block)]);
    await db.client.query("delete from workspaces where id = $1", [id]);
    expect((await db.client.query("select 1 from blocks where id = $1", [block])).rowCount).toBe(0);
  });
});
