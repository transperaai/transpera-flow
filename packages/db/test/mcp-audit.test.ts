import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Audit of MCP writes (issue #24, migration 20261013000000_mcp_building.sql):
// requests made with an API token (claims carry `api_token_id`, as the
// PostgREST pre-request hook sets them) log every row they write with
// actor_kind 'mcp'; the canvas's own writes don't, nor do rows other triggers
// write or the copy open_draft makes.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const tokenId = randomUUID();

/** audit_log rows written so far in this transaction, read as the database owner. */
async function auditRows(c: pg.Client) {
  await c.query("reset role");
  const rows = (await c.query("select actor_id, actor_kind, action, target_table, target_id, diff from audit_log where created_at = now() order by action, target_table"))
    .rows as { actor_id: string; actor_kind: string; action: string; target_table: string; target_id: string; diff: Record<string, unknown> }[];
  await c.query("set local role authenticated");
  return rows;
}

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "mcp-audit-editor@example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, editor.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("audit of MCP writes", () => {
  it("logs each row an API-token request writes, with only the changed columns, and not the draft copy", async () => {
    await db.as({ ...editor.claims, api_token_id: tokenId }, async (c) => {
      const opened = (await c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
      // The copy of live is covered by the open_draft entry, not one row per step and edge.
      expect((await auditRows(c)).map((r) => `${r.actor_kind} ${r.action} ${r.target_table}`)).toEqual(["mcp open_draft processes"]);

      await c.query("update steps set work_hours = 7 where revision_id = $1 and id = $2", [opened.revision_id, northbeamStepIds.audit]);
      await c.query("update steps set notes = notes where revision_id = $1 and id = $2", [opened.revision_id, northbeamStepIds.audit]);
      await c.query("delete from edges where revision_id = $1 and to_step_id = $2", [opened.revision_id, northbeamStepIds.audit]);
      await c.query("insert into sources (workspace_id, title) values ($1, 'Interview')", [NORTHBEAM_WORKSPACE_ID]);
      const rows = await auditRows(c);
      expect(rows.every((r) => r.actor_kind === "mcp" && r.actor_id === editor.id)).toBe(true);
      const update = rows.find((r) => r.action === "update" && r.target_table === "steps")!;
      expect(update).toMatchObject({ target_id: northbeamStepIds.audit, diff: { old: { work_hours: 6 }, new: { work_hours: 7 }, revision_id: opened.revision_id, api_token_id: tokenId } });
      // A save that changes nothing isn't logged.
      expect(rows.filter((r) => r.action === "update")).toHaveLength(1);
      expect(rows.filter((r) => r.action === "delete" && r.target_table === "edges").length).toBeGreaterThan(0);
      expect(rows.some((r) => r.action === "insert" && r.target_table === "sources")).toBe(true);
    });
  });

  it("doesn't log rows other triggers write (a perception-gap issue follows from the logged step change)", async () => {
    await db.as({ ...editor.claims, api_token_id: tokenId }, async (c) => {
      const opened = (await c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
      const conflict = { source: "estimated", conflict: { values: [{ value: 6, source_id: null, speaker: "Maya" }, { value: 24, source_id: null, speaker: "Rosa" }] } };
      await c.query("update steps set provenance = jsonb_set(provenance, '{wait_hours}', $3) where revision_id = $1 and id = $2", [
        opened.revision_id,
        northbeamStepIds.kickoff,
        JSON.stringify(conflict),
      ]);
      await c.query("reset role");
      const issues = await c.query("select 1 from issues where detected_key = $1", [`perception_gap:step:${northbeamStepIds.kickoff}.wait_hours`]);
      await c.query("set local role authenticated");
      expect(issues.rowCount).toBe(1);
      expect((await auditRows(c)).map((r) => `${r.action} ${r.target_table}`)).toEqual(["open_draft processes", "update steps"]);
    });
  });

  it("leaves signed-in edits (no API token) to the existing audit", async () => {
    await db.as(editor.claims, async (c) => {
      const opened = (await c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
      await c.query("update steps set work_hours = 9 where revision_id = $1 and id = $2", [opened.revision_id, northbeamStepIds.audit]);
      await c.query("insert into sources (workspace_id, title) values ($1, 'Notes')", [NORTHBEAM_WORKSPACE_ID]);
      expect((await auditRows(c)).map((r) => `${r.actor_kind} ${r.action}`)).toEqual(["user open_draft"]);
    });
  });
});
