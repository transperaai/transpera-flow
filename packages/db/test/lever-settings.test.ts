import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Settings -> Levers (issue #123): one row per workspace listing the lever
// kinds it has hidden. Owners and editors write it, every member reads it, no
// one reaches another workspace's, and the anon role has no access.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let otherWs: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const doc = ["process.time", "finances.prices"];

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@levers.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@levers.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-levers') returning id")).rows[0].id;
  await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [otherWs, ["demand.enquiries"]]);
});

afterAll(async () => {
  await db?.close();
});

describe("lever_settings: row-level security", () => {
  it("starts empty: no row means the defaults", async () => {
    expect((await db.client.query("select 1 from lever_settings where workspace_id = $1", [ws])).rowCount).toBe(0);
  });

  it("lets owners and editors insert, change and remove the workspace's rules", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, doc])).rowCount, role).toBe(1);
        const r = await c.query("update lever_settings set hidden = '{}' where workspace_id = $1", [ws]);
        expect(r.rowCount, role).toBe(1);
        expect((await c.query("delete from lever_settings where workspace_id = $1", [ws])).rowCount, role).toBe(1);
      });
    }
  });

  it("lets every member read it", async () => {
    await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, doc]);
    try {
      for (const role of ["owner", "editor", "member", "viewer"]) {
        const rows = await db.as(users[role]!.claims, async (c) => (await c.query("select hidden from lever_settings")).rows);
        expect(rows, role).toEqual([{ hidden: doc }]);
      }
    } finally {
      await db.client.query("delete from lever_settings where workspace_id = $1", [ws]);
    }
  });

  it("stops members and viewers writing", async () => {
    await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, doc]);
    try {
      for (const role of ["member", "viewer"]) {
        await db.as(users[role]!.claims, async (c) => {
          expect((await c.query("update lever_settings set hidden = '{}' where workspace_id = $1", [ws])).rowCount, role).toBe(0);
          expect((await c.query("delete from lever_settings where workspace_id = $1", [ws])).rowCount, role).toBe(0);
        });
        await db.client.query("delete from lever_settings where workspace_id = $1", [ws]);
        await expect(
          db.as(users[role]!.claims, (c) => c.query("insert into lever_settings (workspace_id, hidden) values ($1, '{}')", [ws])),
          role,
        ).rejects.toThrow(/row-level security/);
        await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, doc]);
      }
      expect((await db.client.query("select hidden from lever_settings where workspace_id = $1", [ws])).rows[0].hidden).toEqual(doc);
    } finally {
      await db.client.query("delete from lever_settings where workspace_id = $1", [ws]);
    }
  });

  it("hides another workspace's rules, and stops editors writing into it", async () => {
    expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select 1 from lever_settings")).rowCount)).toBe(0);
    const seen = await db.as(users.owner!.claims, async (c) => (await c.query("select workspace_id from lever_settings")).rows);
    expect(seen.every((r) => r.workspace_id === ws)).toBe(true);
    await expect(
      db.as(users.editor!.claims, (c) => c.query("insert into lever_settings (workspace_id, hidden) values ($1, '{}')", [otherWs])),
    ).rejects.toThrow(/row-level security/);
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("update lever_settings set hidden = '{}' where workspace_id = $1", [otherWs])).rowCount).toBe(0);
      expect((await c.query("delete from lever_settings where workspace_id = $1", [otherWs])).rowCount).toBe(0);
    });
  });

  it("can't move a row to another workspace", async () => {
    await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, doc]);
    try {
      await db.as(users.editor!.claims, async (c) => {
        await expect(c.query("update lever_settings set workspace_id = $1 where workspace_id = $2", [otherWs, ws])).rejects.toThrow();
      });
    } finally {
      await db.client.query("delete from lever_settings where workspace_id = $1", [ws]);
    }
  });

  it("gives the anon role no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from lever_settings")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("lever_settings: constraints", () => {
  it("keeps the list short", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `lever.${i}`);
    await expect(db.as(users.editor!.claims, (c) => c.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, many]))).rejects.toThrow(/check constraint/);
    await expect(db.as(users.editor!.claims, (c) => c.query("insert into lever_settings (workspace_id, hidden) values ($1, null)", [ws]))).rejects.toThrow(/null value/);
  });

  it("allows one row per workspace", async () => {
    await expect(
      db.as(users.editor!.claims, async (c) => {
        await c.query("insert into lever_settings (workspace_id, hidden) values ($1, '{}')", [ws]);
        await c.query("insert into lever_settings (workspace_id, hidden) values ($1, '{}')", [ws]);
      }),
    ).rejects.toThrow(/duplicate key/);
  });

  it("stamps updated_at on a change, which is what a save compares against", async () => {
    try {
      const first = (await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, '{}') returning updated_at", [ws])).rows[0].updated_at as Date;
      await db.client.query("select pg_sleep(0.02)");
      const next = (await db.client.query("update lever_settings set hidden = $2 where workspace_id = $1 returning updated_at", [ws, doc])).rows[0].updated_at as Date;
      expect(next.getTime()).toBeGreaterThan(first.getTime());
    } finally {
      await db.client.query("delete from lever_settings where workspace_id = $1", [ws]);
    }
  });

  it("goes with its workspace", async () => {
    const w = (await db.client.query("insert into workspaces (name, slug) values ('Gone', 'gone-levers') returning id")).rows[0].id;
    await db.client.query("insert into lever_settings (workspace_id, hidden) values ($1, '{}')", [w]);
    await db.client.query("delete from workspaces where id = $1", [w]);
    expect((await db.client.query("select 1 from lever_settings where workspace_id = $1", [w])).rowCount).toBe(0);
  });
});
