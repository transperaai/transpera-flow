import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamSourceIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// On Supabase every new public table starts with full privileges for anon, authenticated and service_role. This database is made
// that way before the migrations run, so the migration's own `revoke all` is what is under test: authenticated is left with
// select and delete, insert on the target columns only, and no update; anon with nothing (issue #118, A53).

const ws = NORTHBEAM_WORKSPACE_ID;
const interview = northbeamSourceIds.strategyInterview;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let linkId: string;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@link-privileges.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  linkId = (await db.client.query("insert into source_links (workspace_id, source_id, kind, process_id) values ($1, $2, 'process', $3) returning id", [ws, interview, NORTHBEAM_PROCESS_ID])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const grants = async (table: string) =>
  (await db.client.query("select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 order by 1, 2", [table])).rows.filter((r) => ["anon", "authenticated", "service_role"].includes(r.grantee));

describe("source_links with Supabase's default table privileges", () => {
  it("emulates them: another table made the same way gives authenticated full UPDATE", async () => {
    // Guard against the test passing for the wrong reason: the emulation is on.
    expect((await grants("workspaces")).filter((g) => g.grantee === "authenticated").map((g) => g.privilege_type)).toContain("UPDATE");
  });

  it("leaves authenticated with select and delete only at table level, and anon nothing", async () => {
    const g = await grants("source_links");
    expect(g.filter((x) => x.grantee === "authenticated").map((x) => x.privilege_type)).toEqual(["DELETE", "SELECT"]);
    expect(g.filter((x) => x.grantee === "anon")).toEqual([]);
  });

  it("allows inserting only the target columns, and updating none", async () => {
    const cols = (privilege: string) =>
      db.client
        .query("select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'source_links' and privilege_type = $1 and grantee = 'authenticated' order by 1", [privilege])
        .then((r) => r.rows.map((x) => x.column_name));
    expect(await cols("INSERT")).toEqual(["insight_key", "issue_id", "kind", "process_id", "solution_id", "source_id", "step_id", "workspace_id"]);
    expect(await cols("UPDATE")).toEqual([]);
  });

  it("denies an editor updating a link, or claiming another author or time, and still lets them add and remove one", async () => {
    const denied = async (sql: string, params: unknown[] = []) => {
      await db.as(editor.claims, async (c) => {
        await c.query("savepoint s");
        await expect(c.query(sql, params)).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s");
      });
    };
    await denied("update source_links set process_id = process_id where id = $1", [linkId]);
    await denied("update source_links set kind = 'process' where id = $1", [linkId]);
    await denied("insert into source_links (workspace_id, source_id, kind, process_id, created_by) values ($1, $2, 'process', $3, $4)", [ws, interview, NORTHBEAM_PROCESS_ID, editor.id]);
    await denied("insert into source_links (workspace_id, source_id, kind, process_id, created_at) values ($1, $2, 'process', $3, now())", [ws, interview, NORTHBEAM_PROCESS_ID]);
    await denied("insert into source_links (id, workspace_id, source_id, kind, process_id) values (gen_random_uuid(), $1, $2, 'process', $3)", [ws, interview, NORTHBEAM_PROCESS_ID]);
    await db.as(editor.claims, async (c) => {
      const source = (await c.query("insert into sources (workspace_id, title) values ($1, 'Fresh') returning id", [ws])).rows[0].id;
      const made = (await c.query("insert into source_links (workspace_id, source_id, kind, process_id) values ($1, $2, 'process', $3) returning id, created_by", [ws, source, NORTHBEAM_PROCESS_ID])).rows[0];
      expect(made.created_by).toBe(editor.id);
      expect((await c.query("delete from source_links where id = $1", [made.id])).rowCount).toBe(1);
    });
  });

  it("gives anon no access, and no way to call the functions", async () => {
    for (const sql of ["select 1 from source_links", "select public.unlinked_source_count(gen_random_uuid())", "select public.add_source(gen_random_uuid(), '{}'::jsonb, '[]'::jsonb)"]) {
      await db.client.query("begin");
      try {
        await db.client.query("set local role anon");
        await expect(db.client.query(sql), sql).rejects.toThrow(/permission denied/);
      } finally {
        await db.client.query("rollback");
      }
    }
  });
});
