import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// On Supabase every new public table starts with full privileges for anon, authenticated and service_role. This
// database is made that way before the migrations run, so the migration's own revoke is what is under test: the
// column grant on the decision columns only restricts anything once table-level UPDATE is gone (issue #117).

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let proposalId: string;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@proposal-privileges.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, editor.id]);
  proposalId = (await db.client.query("insert into suggestion_proposals (workspace_id, kind, title) values ($1, 'issue', 'P') returning id", [ws])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const grants = async () =>
  (
    await db.client.query(
      "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'suggestion_proposals' order by 1, 2",
    )
  ).rows.filter((r) => ["anon", "authenticated", "service_role"].includes(r.grantee));

describe("with Supabase's default table privileges", () => {
  it("emulates them: another table made the same way gives authenticated full UPDATE", async () => {
    const other = (
      await db.client.query("select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'workspaces' and grantee = 'authenticated'")
    ).rows.map((r) => r.privilege_type);
    expect(other).toContain("UPDATE");
  });

  it("leaves authenticated with table-level insert only (select is by column), and anon nothing", async () => {
    const g = await grants();
    expect(g.filter((x) => x.grantee === "authenticated").map((x) => x.privilege_type)).toEqual(["INSERT"]);
    expect(g.filter((x) => x.grantee === "anon")).toEqual([]);
  });

  it("lets authenticated read every column but the visitor's email and what was held from members (B4)", async () => {
    const readable = (
      await db.client.query(
        "select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'suggestion_proposals' and privilege_type = 'SELECT' and grantee = 'authenticated'",
      )
    ).rows.map((r) => r.column_name as string);
    const all = (await db.client.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'suggestion_proposals'")).rows.map((r) => r.column_name as string);
    expect(all).toContain("proposer_email");
    expect(all).toContain("visitor_text");
    expect(readable).toContain("share_link_id");
    expect(readable.sort()).toEqual(all.filter((c) => c !== "proposer_email" && c !== "visitor_text").sort());
    await db.as(editor.claims, async (c) => {
      await c.query("savepoint s");
      await expect(c.query("select proposer_email from suggestion_proposals")).rejects.toThrow(/permission denied/);
      await c.query("rollback to savepoint s");
      await expect(c.query("select * from suggestion_proposals")).rejects.toThrow(/permission denied/);
      await c.query("rollback to savepoint s");
      expect((await c.query("select id, proposer_name from suggestion_proposals")).rows.length).toBeGreaterThan(0);
    });
  });

  it("allows updating only the five decision columns", async () => {
    const cols = (
      await db.client.query(
        "select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'suggestion_proposals' and privilege_type = 'UPDATE' and grantee = 'authenticated' order by 1",
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toEqual(["applied", "review_note", "reviewed_at", "reviewed_by", "status"]);
  });

  it("denies an editor changing what was proposed, or deleting, and lets review_proposals decide", async () => {
    for (const sql of [
      `update suggestion_proposals set title = 'Other' where id = '${proposalId}'`,
      `update suggestion_proposals set payload = '{}' where id = '${proposalId}'`,
      `update suggestion_proposals set created_via = 'play_link' where id = '${proposalId}'`,
      `delete from suggestion_proposals where id = '${proposalId}'`,
    ]) {
      await db.as(editor.claims, async (c) => {
        await c.query("savepoint s");
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s");
      });
    }
    await db.as(editor.claims, async (c) => {
      const r = (await c.query("select public.review_proposals(array[$1::uuid], 'reject') as r", [proposalId])).rows[0].r;
      expect(r).toEqual([{ id: proposalId, status: "rejected" }]);
    });
  });

  it("gives anon no way in", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select 1 from suggestion_proposals")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});
