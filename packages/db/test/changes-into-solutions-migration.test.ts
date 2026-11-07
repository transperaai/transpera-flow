import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamStepIds } from "../src";
import { applyMigrations } from "../src/migrations";
import { createTestDb, type TestDb } from "./harness";

// D53 (migration 20270136000000_changes_into_solutions.sql) on a database as it was before it: Northbeam (the seed) with changes entered the way the
// Sandbox saved them, one linked to an open issue and one to a resolved issue, one on a step that is gone. After the migration each is a testing solution
// of the process its steps are live in, linked to its issue (no issue changes status), and the old table can still be read but not written.

const BASE = "20270134000000";
let db: TestDb;
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;
const notices: string[] = [];

let openIssue: string;
let doneIssue: string;
let before: unknown;

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE, supabaseDefaultPrivileges: true });
  const process = (await q("select id from processes where workspace_id = $1 and is_company is not true and live_revision_id is not null order by created_at limit 1", [NORTHBEAM_WORKSPACE_ID]))[0]!.id as string;
  const issue = async (title: string, status: string) =>
    (await q("insert into issues (workspace_id, type, severity, title, status, process_id) values ($1, 'delay', 'info', $2, $3, $4) returning id", [NORTHBEAM_WORKSPACE_ID, title, status, process]))[0]!.id as string;
  openIssue = await issue("Setup is slow", "open");
  doneIssue = await issue("Reports are late", "done");
  const add = (name: string, effects: unknown[], issueId: string | null) =>
    q("insert into capacity_changes (workspace_id, name, kind, effects, adoption, ramp_months, tiers, cost_monthly, issue_id, created_at) values ($1, $2, 'automation', $3::jsonb, 0.8, 2, $4, 250, $5, '2026-10-01T00:00:00Z')", [
      NORTHBEAM_WORKSPACE_ID,
      name,
      JSON.stringify(effects),
      ["T1"],
      issueId,
    ]);
  await add("Template the setup", [{ step: northbeamStepIds.ppc, part: "automatable", remove: 0.5, residualHours: 0.25 }, { step: northbeamStepIds.ppc, part: "augmentable", factor: 1.5 }], openIssue);
  await add("Auto report", [{ step: northbeamStepIds.ppc, part: "augmentable", factor: 2 }], doneIssue);
  await add("Gone", [{ step: "00000000-0000-4000-8000-0000000000c9", part: "automatable", remove: 1 }], null);
  before = JSON.stringify(await q("select title, status from issues where workspace_id = $1 order by title", [NORTHBEAM_WORKSPACE_ID]));
  db.client.on("notice", (n) => notices.push(String(n.message)));
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270136000000_changes_into_solutions.sql");
}, 300_000);
afterAll(async () => {
  await db?.close();
});

describe("20270136000000 on a database as it was", () => {
  it("makes a testing solution of the live process for each change that has a step left, and none for the one that has not", async () => {
    const rows = await q("select name, status, process_id, step_changes, changed_step_ids from solutions where workspace_id = $1 and step_changes <> '[]'::jsonb order by name", [NORTHBEAM_WORKSPACE_ID]);
    expect(rows.map((r) => r.name)).toEqual(["Auto report", "Template the setup"]);
    expect(rows.every((r) => r.status === "testing")).toBe(true);
    const template = rows[1]!;
    expect(template.step_changes).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: "Template the setup",
        kind: "automation",
        effects: [{ step: northbeamStepIds.ppc, part: "automatable", remove: 0.5, residualHours: 0.25 }, { step: northbeamStepIds.ppc, part: "augmentable", factor: 1.5 }],
        adoption: 0.8,
        ramp_months: 2,
        tiers: ["T1"],
        cost_monthly: 250,
      },
    ]);
    expect(template.changed_step_ids).toEqual([northbeamStepIds.ppc]);
    // The id is the old change's, so the model it makes is the one a switched-on change made.
    const ids = await q("select id from capacity_changes where workspace_id = $1 and name = 'Template the setup'", [NORTHBEAM_WORKSPACE_ID]);
    expect((template.step_changes as { id: string }[])[0]!.id).toBe(ids[0]!.id);
    expect(notices.join("\n")).toMatch(/3 changes read; 2 solutions made; 2 issue links; 0 links skipped .*; 0 solutions with no issue; 1 effects dropped .*; 1 changes with no solution/);
  });

  it("links each solution to its change's issue and leaves every issue as it was, with nothing logged", async () => {
    const links = await q("select s.name, i.title from solution_issues l join solutions s on s.id = l.solution_id join issues i on i.id = l.issue_id where l.workspace_id = $1 order by s.name", [NORTHBEAM_WORKSPACE_ID]);
    expect(links).toEqual([{ name: "Auto report", title: "Reports are late" }, { name: "Template the setup", title: "Setup is slow" }]);
    expect(JSON.stringify(await q("select title, status from issues where workspace_id = $1 order by title", [NORTHBEAM_WORKSPACE_ID]))).toBe(before);
    expect(await q("select 1 from issue_events where workspace_id = $1 and kind = 'solution_tested'", [NORTHBEAM_WORKSPACE_ID])).toEqual([]);
  });

  it("keeps the old rows (read-only) and the triggers it switched off are back on", async () => {
    expect(Number((await q("select count(*)::int as n from capacity_changes"))[0]!.n)).toBe(3);
    expect((await q("select policyname from pg_policies where tablename = 'capacity_changes' order by 1")).map((r) => r.policyname)).toEqual(["delete capacity_changes", "read capacity_changes"]);
    const t = await q("select tgname, tgenabled from pg_trigger where tgrelid = 'public.solution_issues'::regclass and tgname in ('solution_issues_before_insert', 'solution_issue_tested') order by 1");
    expect(t).toEqual([{ tgname: "solution_issue_tested", tgenabled: "O" }, { tgname: "solution_issues_before_insert", tgenabled: "O" }]);
  });
});
