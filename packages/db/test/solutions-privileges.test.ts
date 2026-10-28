import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// On Supabase every new public table starts with full privileges for anon, authenticated and service_role. This database is made
// that way before the migrations run, so the migration's own revoke is what is under test: the column grants only restrict
// anything once table-level UPDATE is gone (issue #114).

const ws = NORTHBEAM_WORKSPACE_ID;
const [openIssue, testingIssue] = northbeamIssues().map((i) => i.id) as [string, string];
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let solutionId: string;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@privileges.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  solutionId = (
    await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'S', '{\"steps\": [], \"edges\": []}') returning id", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID])
  ).rows[0].id;
  await db.client.query("insert into solution_issues (solution_id, issue_id, workspace_id, auto_verdict, holds_pct) values ($1, $2, $3, 'fail', 30)", [solutionId, openIssue, ws]);
});

afterAll(async () => {
  await db?.close();
});

const grants = async (table: string) =>
  (await db.client.query("select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 order by 1, 2", [table])).rows.filter((r) => ["anon", "authenticated", "service_role"].includes(r.grantee));

describe("with Supabase's default table privileges", () => {
  it("emulates them: another table made the same way gives authenticated full UPDATE", async () => {
    // Guard against the test passing for the wrong reason: the emulation is on.
    expect((await grants("workspaces")).filter((g) => g.grantee === "authenticated").map((g) => g.privilege_type)).toContain("UPDATE");
  });

  it("leaves authenticated with select, insert and delete only, and anon nothing", async () => {
    for (const table of ["solutions", "solution_issues"]) {
      const g = await grants(table);
      expect(g.filter((x) => x.grantee === "authenticated").map((x) => x.privilege_type), table).toEqual(["DELETE", "INSERT", "SELECT"]);
      expect(g.filter((x) => x.grantee === "anon"), table).toEqual([]);
    }
  });

  it("allows only the columns a person edits later", async () => {
    const cols = (await db.client.query("select table_name, column_name from information_schema.column_privileges where table_schema = 'public' and table_name in ('solutions', 'solution_issues') and privilege_type = 'UPDATE' and grantee = 'authenticated' order by 1, 2")).rows;
    expect(cols).toEqual([
      { table_name: "solution_issues", column_name: "user_notes" },
      { table_name: "solution_issues", column_name: "user_verdict" },
      { table_name: "solutions", column_name: "name" },
      { table_name: "solutions", column_name: "notes" },
    ]);
  });

  it("denies an editor changing the issue, the verdicts, the copy or the base, and allows name, notes and their own verdict", async () => {
    const denied = async (sql: string) => {
      await db.as(editor.claims, async (c) => {
        await c.query("savepoint s");
        await expect(c.query(sql)).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s");
      });
    };
    for (const set of [`issue_id = '${testingIssue}'`, "auto_verdict = 'pass'", "holds_pct = 99", "auto_note = 'x'", "workspace_id = workspace_id"]) {
      await denied(`update solution_issues set ${set} where solution_id = '${solutionId}'`);
    }
    for (const set of ["steps = '{\"steps\": [], \"edges\": []}'", `base_revision_id = '${NORTHBEAM_REVISION_ID}'`, `process_id = '${NORTHBEAM_PROCESS_ID}'`, "changed_step_ids = '[]'", "lever_changes = '[]'"]) {
      await denied(`update solutions set ${set} where id = '${solutionId}'`);
    }
    await db.as(editor.claims, async (c) => {
      expect((await c.query("update solution_issues set user_verdict = 'pass', user_notes = 'ok' where solution_id = $1", [solutionId])).rowCount).toBe(1);
      expect((await c.query("update solutions set name = 'Renamed', notes = 'n' where id = $1", [solutionId])).rowCount).toBe(1);
    });
  });
});
