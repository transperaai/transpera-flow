import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, linkColumns, northbeamIssues, northbeamStepIds, type SourceLinkTarget } from "@transpera-flow/db";
import { linkJson, parseNewSource } from "@/lib/sources/links";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// A source saved the way the app saves it (issue #118): the Server Action's own payload, checked by `parseNewSource` and
// sent through `add_source`, comes back as one source with its links; a plain link goes in as the table's own columns
// (`linkColumns`), and the unlinked count follows.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const issue = northbeamIssues()[1]!.id;

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "editor@sources-web.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, editor.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("saving a source with its links", () => {
  const input = { kind: "notes", title: "Notes: ops walkthrough with Leah", speakers: [], recorded_at: "2026-09-18", body: "Access requests go back and forth.", file_url: null };
  const targets: SourceLinkTarget[] = [
    { kind: "step", processId: NORTHBEAM_PROCESS_ID, stepId: northbeamStepIds.audit },
    { kind: "issue", issueId: issue },
    { kind: "insight", insightKey: `spof:step:${northbeamStepIds.audit}` },
  ];

  it("stores the source and every link through add_source, with the payload the action builds", async () => {
    const parsed = parseNewSource(input, targets);
    if (!parsed.ok) throw new Error(parsed.error);
    const id = await db.as(editor.claims, async (c) => {
      const r = await c.query("select public.add_source($1, $2::jsonb, $3::jsonb) as id", [NORTHBEAM_WORKSPACE_ID, JSON.stringify({ ...parsed.value.input }), JSON.stringify(parsed.value.links.map(linkJson))]);
      const made = r.rows[0].id as string;
      const source = (await c.query("select kind, title, recorded_at::text as day, body from sources where id = $1", [made])).rows[0];
      expect(source).toEqual({ kind: "notes", title: input.title, day: "2026-09-18", body: input.body });
      const links = (await c.query("select kind, step_id, issue_id, insight_key, process_id from source_links where source_id = $1 order by kind", [made])).rows;
      expect(links.map((l) => l.kind)).toEqual(["insight", "issue", "step"]);
      expect(links.find((l) => l.kind === "step")).toMatchObject({ step_id: northbeamStepIds.audit, process_id: NORTHBEAM_PROCESS_ID });
      return made;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an empty list, with a message the action shows as it is", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("savepoint s");
      await expect(c.query("select public.add_source($1, $2::jsonb, '[]'::jsonb)", [NORTHBEAM_WORKSPACE_ID, JSON.stringify(input)])).rejects.toMatchObject({
        code: "22023",
        message: "Link the source to at least one process, step, insight, issue or solution.",
      });
      await c.query("rollback to savepoint s");
    });
  });

  it("links a source that is already there, with the table's own columns, and drops the link again", async () => {
    await db.as(editor.claims, async (c) => {
      const source = (await c.query("insert into sources (workspace_id, title) values ($1, 'Loose notes') returning id", [NORTHBEAM_WORKSPACE_ID])).rows[0].id;
      const count = async () => Number((await c.query("select public.unlinked_source_count($1) as n", [NORTHBEAM_WORKSPACE_ID])).rows[0].n);
      expect(await count()).toBe(1);
      const k = linkColumns({ kind: "process", processId: NORTHBEAM_PROCESS_ID });
      const link = (
        await c.query("insert into source_links (workspace_id, source_id, kind, process_id, step_id, insight_key, issue_id, solution_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id", [
          NORTHBEAM_WORKSPACE_ID,
          source,
          k.kind,
          k.process_id,
          k.step_id,
          k.insight_key,
          k.issue_id,
          k.solution_id,
        ])
      ).rows[0].id;
      expect(await count()).toBe(0);
      expect((await c.query("delete from source_links where id = $1 returning id", [link])).rowCount).toBe(1);
      expect(await count()).toBe(1);
    });
  });
});
