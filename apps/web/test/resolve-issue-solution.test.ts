import { createQueryId, type KyselyPlugin, type RootOperationNode } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, resolveIssue, type Db } from "@transpera-flow/db";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// Resolving with a solution (issue #115, A50): the app calls the six-argument resolve_issue only when a solution was picked, and
// the five-argument one otherwise, so resolving works before and after the migration that adds the sixth argument. Runs against
// a throwaway database; each call's named arguments are read from the SQL it sent, since they alone pick the overload.

const ws = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let editor: Db;
let solution: string;
let linked: string;

/** A new open issue in the workspace. */
const newIssue = async (): Promise<string> =>
  (await tdb.client.query("insert into issues (workspace_id, process_id, type, title) values ($1, $2, 'delay', 'Proposals wait') returning id", [ws, NORTHBEAM_PROCESS_ID])).rows[0].id;

/** The functions called, with their named arguments and values, in the order sent. */
function recorded(db: Db) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const spy: KyselyPlugin = {
    transformQuery({ node }) {
      const { sql, parameters } = db.getExecutor().compileQuery(node as RootOperationNode, createQueryId());
      const fn = /"public"\."(\w+)"\(/.exec(sql);
      if (fn) calls.push({ fn: fn[1]!, args: Object.fromEntries([...sql.matchAll(/"(\w+)" => \$(\d+)/g)].map(([, k, n]) => [k, parameters[Number(n) - 1]])) });
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return { db: db.withPlugin(spy), calls };
}

const stored = async (id: string) =>
  (await tdb.client.query("select status, resolved_how, resolved_solution_id, resolution_note from issues where id = $1", [id])).rows[0];

beforeAll(async () => {
  tdb = await createTestDb();
  const u = await createUser(tdb, "editor@northbeam.example");
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, u.id]);
  editor = tdb.dbAs(u.claims as never);
  const steps = JSON.stringify({ steps: [], edges: [] });
  solution = (await tdb.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Sales v8', $4::jsonb) returning id", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, steps])).rows[0].id;
});
afterAll(async () => {
  await tdb?.close();
});
beforeEach(async () => {
  linked = await newIssue();
  await tdb.client.query("insert into solution_issues (solution_id, issue_id, workspace_id) values ($1, $2, $3)", [solution, linked, ws]);
});

describe("resolveIssue", () => {
  it("names the solution with the six-argument function", async () => {
    const { db, calls } = recorded(editor);
    expect(await resolveIssue(db, { workspaceId: ws, id: linked, how: "solution", note: "Built into Sales v8", solutionId: solution })).toEqual({ id: linked });
    expect(calls).toEqual([
      { fn: "resolve_issue", args: { p_workspace: ws, p_id: linked, p_how: "solution", p_status: "resolved", p_note: "Built into Sales v8", p_solution: solution } },
    ]);
    expect(await stored(linked)).toEqual({ status: "done", resolved_how: "solution", resolved_solution_id: solution, resolution_note: "Built into Sales v8" });
  });

  it("sends an empty note, not a missing one, so the six-argument function is the only match", async () => {
    const { db, calls } = recorded(editor);
    expect(await resolveIssue(db, { workspaceId: ws, id: linked, how: "solution", solutionId: solution })).toEqual({ id: linked });
    expect(calls[0]!.args).toMatchObject({ p_note: "", p_solution: solution });
    expect(await stored(linked)).toMatchObject({ resolved_solution_id: solution, resolution_note: null });
  });

  it("uses the five-argument function when no solution is named, exactly as before", async () => {
    const other = await newIssue();
    const { db, calls } = recorded(editor);
    expect(await resolveIssue(db, { workspaceId: ws, id: linked, how: "process_change", note: "We removed the call" })).toEqual({ id: linked });
    expect(await resolveIssue(db, { workspaceId: ws, id: other, how: "solution", solutionId: null })).toEqual({ id: other });
    // A missing note isn't sent at all (as PostgREST dropped it), so p_note takes its default.
    expect(calls.map((c) => Object.keys(c.args).sort())).toEqual([
      ["p_how", "p_id", "p_note", "p_status", "p_workspace"],
      ["p_how", "p_id", "p_status", "p_workspace"],
    ]);
    expect(calls.some((c) => "p_solution" in c.args)).toBe(false);
    expect(await stored(linked)).toEqual({ status: "done", resolved_how: "process_change", resolved_solution_id: null, resolution_note: "We removed the call" });
    expect(await stored(other)).toMatchObject({ status: "done", resolved_how: "solution", resolved_solution_id: null });
  });

  it("hands back the database's error", async () => {
    const unlinked = await newIssue();
    expect(await resolveIssue(editor, { workspaceId: ws, id: unlinked, how: "solution", solutionId: solution })).toEqual({
      error: { code: "22023", message: expect.stringMatching(/not linked/) },
    });
    expect(await stored(unlinked)).toMatchObject({ resolved_solution_id: null });
  });
});
