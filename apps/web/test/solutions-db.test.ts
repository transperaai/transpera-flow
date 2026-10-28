import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues, northbeamStepIds as ids, toEngineModel, type SolutionRow } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { diffBundles } from "@/lib/drafts/diff";
import { bundleFromSolution, changedStepIds, solutionCopy } from "@/lib/solutions/bundle";
import { demoBundle } from "@/lib/sources/demo";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// A solution saved the way the app saves it (issue #114): the edited map goes in through save_solution, comes back as the
// same map, and the process's live version and its draft are exactly as they were.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const [openIssue] = northbeamIssues().map((i) => i.id) as [string];

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "editor@solutions-web.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, editor.id]);
});

afterAll(async () => {
  await db?.close();
});

/** The process's rows as they are, to compare before and after. */
const snapshot = async () => ({
  steps: (await db.client.query("select md5(string_agg(to_jsonb(s)::text, '' order by revision_id, id)) as m from steps s where process_id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].m,
  edges: (await db.client.query("select md5(string_agg(to_jsonb(e)::text, '' order by revision_id, id)) as m from edges e where process_id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].m,
  revisions: (await db.client.query("select id, number, status from process_revisions where process_id = $1 order by id", [NORTHBEAM_PROCESS_ID])).rows,
  live: (await db.client.query("select live_revision_id from processes where id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].live_revision_id,
});

describe("saving a solution", () => {
  const live = demoBundle();
  const edited = { ...live, steps: live.steps.map((s) => (s.id === ids.audit ? { ...s, work_hours: 3, work_dist: "constant" as const } : s)) };

  it("stores the edited map, gives it back whole, and leaves live and the draft untouched", async () => {
    const before = await snapshot();
    const saved = await db.as(editor.claims, async (c) => {
      const r = await c.query("select public.save_solution($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) as r", [
        NORTHBEAM_WORKSPACE_ID,
        NORTHBEAM_PROCESS_ID,
        NORTHBEAM_REVISION_ID,
        "Faster audit",
        JSON.stringify(solutionCopy(edited)),
        JSON.stringify(changedStepIds(diffBundles(live, edited))),
        "[]",
        JSON.stringify([{ issue_id: openIssue, auto_verdict: "pass", holds_pct: 97, auto_note: "Wait at Audit & proposal: 2.0 h on average." }]),
      ]);
      return r.rows[0].r as SolutionRow;
    });
    expect(saved).toMatchObject({ name: "Faster audit", process_id: NORTHBEAM_PROCESS_ID, base_revision_id: NORTHBEAM_REVISION_ID, changed_step_ids: [ids.audit], lever_changes: [] });
    // The row was rolled back with the test transaction; check what was sent, read as the app reads it.
    const back = bundleFromSolution(live, saved);
    expect(back.steps).toEqual(edited.steps);
    expect(back.edges).toEqual(edited.edges);
    expect(simulate(toEngineModel(back), 5, 1).won).toBe(simulate(toEngineModel(edited), 5, 1).won);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the saved copy apart from live: editing live afterwards doesn't change the solution, and a draft stays single", async () => {
    await db.as(editor.claims, async (c) => {
      const s = (await c.query("select public.save_solution($1, $2, $3, 'Copy', $4::jsonb) as r", [NORTHBEAM_WORKSPACE_ID, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, JSON.stringify(solutionCopy(edited))])).rows[0].r as SolutionRow;
      // A draft is opened and edited after the solution was saved: the solution's copy is not it.
      await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
      await c.query("update steps set work_hours = 1 where process_id = $1 and name = 'Audit & proposal' and revision_id <> $2", [NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID]);
      const stored = (await c.query("select steps from solutions where id = $1", [s.id])).rows[0].steps as SolutionRow["steps"];
      expect(stored.steps.find((x) => x.id === ids.audit)!.work_hours).toBe(3);
      expect((await c.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].n).toBe(1);
      // And the other way: a second solution doesn't open a second draft.
      await c.query("select public.save_solution($1, $2, $3, 'Another', $4::jsonb)", [NORTHBEAM_WORKSPACE_ID, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, JSON.stringify(solutionCopy(edited))]);
      expect((await c.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].n).toBe(1);
      expect((await c.query("select count(*)::int as n from solutions where process_id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].n).toBe(2);
    });
  });
});
