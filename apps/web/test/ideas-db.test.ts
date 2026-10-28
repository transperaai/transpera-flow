import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamStepIds, type SolutionRow } from "@transpera-flow/db";
import { applyEdit } from "@/lib/editor/ops";
import { diffBundles } from "@/lib/drafts/diff";
import { bundleFromSolution, changedStepIds, solutionCopy } from "@/lib/solutions/bundle";
import { demoProposals } from "@/lib/suggestions/demo";
import { ideaSeed, placeIdea } from "@/lib/suggestions/idea";
import { demoBundle } from "@/lib/sources/demo";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// Build it end to end (issue #117, A52 slice 2), as the Editor does it: the idea's steps are placed in a copy of live, the copy is
// saved through `build_proposal`, the solution comes back with the AI's steps in it, the idea is marked built with that
// solution, and live is untouched.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const sample = demoProposals().find((p) => p.kind === "solution_idea")!;

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "editor@ideas-web.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("building an idea", () => {
  it("saves the placed steps as a solution of the issue and marks the idea built, leaving live alone", async () => {
    const live = demoBundle();
    const placed = placeIdea(live, ideaSeed(sample, live.roles))!;
    const edited = applyEdit(live, placed.edit!);
    const changes = diffBundles(live, edited);
    const liveSteps = async () => (await db.client.query("select md5(string_agg(to_jsonb(s)::text, '' order by id)) as m from steps s where process_id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].m;
    const before = await liveSteps();
    const id = (
      await db.client.query("insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id) values ($1, 'solution_idea', $2, $3, $4) returning id", [
        ws,
        sample.title,
        JSON.stringify(sample.payload),
        sample.issue_id,
      ])
    ).rows[0].id;

    await db.as(editor.claims, async (c) => {
      const saved = (
        await c.query("select public.build_proposal($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, '[]', $8::jsonb) as r", [
          id,
          ws,
          NORTHBEAM_PROCESS_ID,
          NORTHBEAM_REVISION_ID,
          sample.title,
          JSON.stringify(solutionCopy(edited)),
          JSON.stringify(changedStepIds(changes)),
          JSON.stringify([{ issue_id: sample.issue_id, auto_verdict: null, holds_pct: null, auto_note: "" }]),
        ])
      ).rows[0].r as SolutionRow;
      // The solution has the AI's steps, in place of the one they replaced.
      const back = bundleFromSolution(live, saved);
      expect(back.steps.map((s) => s.name)).toEqual(expect.arrayContaining(["Partner lead arrives", "Book discovery call", "Quick check by AI"]));
      expect(back.steps.some((s) => s.id === northbeamStepIds.qualify)).toBe(false);
      expect(saved.name).toBe(sample.title);
      expect((await c.query("select applied, status from suggestion_proposals where id = $1", [id])).rows[0]).toEqual({ status: "built", applied: { solution_id: saved.id } });
      expect((await c.query("select solution_id from solution_issues where issue_id = $1", [sample.issue_id])).rows.map((r) => r.solution_id)).toContain(saved.id);
    });
    // db.as rolled back; nothing about live changed in any case.
    expect(await liveSteps()).toBe(before);
  });
});
