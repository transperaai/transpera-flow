import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues, type Row } from "../src";
import { applyMigrations } from "../src/migrations";
import { createTestDb, createUser, type TestDb } from "./harness";
import { headerRollback } from "./header-rollback";

// A solution's status (capacity Q10, migration 20270128000000_solution_status.sql): existing solutions are backfilled from the user's
// verdicts, a new one starts at Testing, only the five values fit, an editor sets it (through save_fields too, with compare-and-set),
// and a change is written to the history of each issue the solution is linked to.

const BASE = "20270127000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const [issueA, issueB] = northbeamIssues().map((i) => i.id) as [string, string];
const EMPTY_MAP = '{"steps": [], "edges": []}';

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const made: Record<string, string> = {};

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];

async function solution(name: string, verdicts: ("pass" | "fail" | null)[]): Promise<string> {
  const id = (await q("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, $4, $5) returning id", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, name, EMPTY_MAP]))[0]!.id as string;
  const issues = [issueA, issueB];
  for (const [i, v] of verdicts.entries()) {
    await q("insert into solution_issues (solution_id, issue_id, workspace_id, user_verdict) values ($1, $2, $3, $4)", [id, issues[i], ws, v]);
  }
  return id;
}

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE, supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@solution-status.example.com");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  made.allPass = await solution("All pass", ["pass", "pass"]);
  made.oneFail = await solution("One fail", ["pass", "fail"]);
  made.mixed = await solution("Not yet judged", ["pass", null]);
  made.none = await solution("No links", []);
  const applied = await applyMigrations(db.client, {});
  expect(applied.files).toContain("20270128000000_solution_status.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const statusOf = async (id: string) => (await q("select status from solutions where id = $1", [id]))[0]!.status;

describe("the status column", () => {
  it("backfills works where every verdict is a pass, doesnt_work where any is a fail, else testing", async () => {
    expect(await statusOf(made.allPass!)).toBe("works");
    expect(await statusOf(made.oneFail!)).toBe("doesnt_work");
    expect(await statusOf(made.mixed!)).toBe("testing");
    expect(await statusOf(made.none!)).toBe("testing");
  });

  it("starts a new solution at testing and accepts only the five values", async () => {
    const id = (await q("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'New', $4) returning id", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, EMPTY_MAP]))[0]!.id as string;
    expect(await statusOf(id)).toBe("testing");
    for (const ok of ["idea", "testing", "works", "doesnt_work", "adopted"]) await q("update solutions set status = $1 where id = $2", [ok, id]);
    await expect(q("update solutions set status = 'done' where id = $1", [id])).rejects.toThrow(/solutions_status/);
  });

  it("lets an editor set it, and nobody set the other columns", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("update solutions set status = 'adopted' where id = $1", [made.mixed]);
      expect((await c.query("select status from solutions where id = $1", [made.mixed])).rows[0].status).toBe("adopted");
      await c.query("savepoint s");
      await expect(c.query("update solutions set process_id = process_id where id = $1", [made.mixed])).rejects.toThrow(/permission denied/);
      await c.query("rollback to savepoint s");
    });
  });

  it("saves through save_fields with compare-and-set", async () => {
    await db.as(editor.claims, async (c) => {
      const ok = (await c.query("select public.save_fields('solutions', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id: made.none }), '{"status": "testing"}', '{"status": "idea"}'])).rows[0].r;
      expect(ok.status).toBe("saved");
      const stale = (await c.query("select public.save_fields('solutions', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id: made.none }), '{"status": "testing"}', '{"status": "works"}'])).rows[0].r;
      expect(stale.status).toBe("conflict");
      expect(stale.conflicts).toEqual({ status: "idea" });
    });
  });
});

describe("the history", () => {
  it("writes one solution_status event on each issue the solution is linked to, and none when the status is unchanged", async () => {
    await q("delete from issue_events where kind = 'solution_status'");
    await q("update solutions set status = 'adopted' where id = $1", [made.oneFail]);
    await q("update solutions set status = 'adopted' where id = $1", [made.oneFail]);
    const rows = await q("select issue_id, detail from issue_events where kind = 'solution_status' order by issue_id");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.issue_id).sort()).toEqual([issueA, issueB].sort());
    expect(rows[0]!.detail).toEqual({ solution_id: made.oneFail, solution: "One fail", from: "doesnt_work", to: "adopted" });
  });
});

describe("the rollback in the migration's header", () => {
  it("runs, and removes the column and the event kind", async () => {
    const own = await createTestDb();
    try {
      await own.client.query(headerRollback("20270128000000_solution_status.sql"));
      const left = await own.client.query("select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'solutions' and column_name = 'status'");
      expect(left.rows[0].n).toBe(0);
      await expect(own.client.query("insert into issue_events (issue_id, workspace_id, kind) values ($1, $2, 'solution_status')", [issueA, ws])).rejects.toThrow(/issue_events_kind/);
    } finally {
      await own.close();
    }
  }, 60_000);
});
