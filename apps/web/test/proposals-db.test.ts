import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, PROPOSAL_ROW_COLUMNS, northbeamIssues, northbeamStepIds, type IssueRow, type ProposalRow } from "@transpera-flow/db";
import { MemoryIssueStore } from "@/lib/issues/store";
import { demoProposals } from "@/lib/suggestions/demo";
import { describeProposal, reviewProposalsInMemory, type ProposalReviewResult } from "@/lib/suggestions/proposals";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// The demo reviews proposals in memory and the database reviews them in `review_proposals`; they must agree (issue #117).
// The proposals are stored the way the MCP tools store them, read the way the page reads them, accepted through the RPC the
// Server Action calls, and the issue that comes out is compared with the one the in-memory store makes.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "editor@proposals-web.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("a proposed issue, in the database and in the demo", () => {
  it("is read, described and accepted to the same issue", async () => {
    const sample = demoProposals().find((p) => p.kind === "issue")!;
    await db.as(editor.claims, async (c) => {
      const { id } = (
        await c.query("insert into suggestion_proposals (workspace_id, kind, title, detail, payload) values ($1, 'issue', $2, $3, $4) returning id", [
          ws,
          sample.title,
          sample.detail,
          JSON.stringify(sample.payload),
        ])
      ).rows[0];
      const row = (await c.query(`select ${PROPOSAL_ROW_COLUMNS} from suggestion_proposals where id = $1`, [id])).rows[0] as ProposalRow;
      // Read as the page reads it: the same words as the demo's card.
      const lookups = { processes: {}, steps: { [northbeamStepIds.discovery]: "Discovery call" }, issues: {} };
      expect(describeProposal(row, lookups)).toMatchObject({ kind: "Issue", from: "Claude (MCP)", title: sample.title });
      expect(describeProposal(row, lookups).lines).toEqual(describeProposal(sample, lookups).lines);

      const [r] = ((await c.query("select public.review_proposals(array[$1::uuid], 'accept') as r", [id])).rows[0].r as ProposalReviewResult[]) ?? [];
      expect(r).toMatchObject({ status: "accepted" });
      const made = (await c.query("select * from issues where id = $1", [r!.applied!.issue_id])).rows[0];

      const memory = new MemoryIssueStore(ws, northbeamIssues());
      const mem = await reviewProposalsInMemory([sample], [sample.id], "accept", null, { at: "2026-10-02T09:00:00Z", by: null, issues: memory });
      const memIssue = mem.results[0]!.applied!;
      const demoIssue = (await new MemoryIssueStore(ws, northbeamIssues()).save({
        title: sample.title,
        severity: "warning",
        type: "delay",
        evidence: sample.detail,
        target_measure: "Wait before Discovery call",
        target_now: "24 h",
        target_goal: "under 8 h",
        links: [{ process_id: NORTHBEAM_PROCESS_ID, step_id: northbeamStepIds.discovery }],
        owner_ids: [],
        source_ids: [],
      })) as { status: "ok"; issue: IssueRow };
      const fields = ["title", "severity", "type", "evidence", "status", "source", "target_measure", "target_now", "target_goal"] as const;
      for (const f of fields) expect(made[f], f).toEqual(demoIssue.issue[f]);
      expect(made.number).toBe(northbeamIssues().length + 1);
      expect(memIssue.number).toBe(demoIssue.issue.number);
      expect((await c.query("select process_id, step_id from issue_links where issue_id = $1", [made.id])).rows).toEqual(demoIssue.issue.links);
    });
  });
});
