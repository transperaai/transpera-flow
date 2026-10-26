import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { rpc } from "@transpera-flow/db/client";
import { call, connect, errorOf, startTestDb, tokenDbFor, userClaims, type McpTestDb } from "./helpers";

// The proposal tools end to end (issue #117, A52), as in production: MCP client → handleMcpRequest → token lookup in
// app code → Kysely under the token owner's claims → Postgres with every migration. They write proposals only: no issue and no solution
// appears until a person accepts or builds it. Runs on a throwaway database (test/helpers.ts),
// in its own workspace.


let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;

const ids = { ws: "", proc: "", rev: "", step: "", issue: "", closed: "", source: "", editor: "", viewer: "" };
let editorToken = "";
let viewerToken = "";

async function createUser(email: string) {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

async function issueToken(userId: string) {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label, active_workspace_id) values ($1, $2, 'e2e', $3)", [userId, hash, ids.ws]);
  return token;
}

const insertId = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
const count = async (table: string) => (await admin.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [ids.ws])).rows[0].n as number;

describe("proposal tools", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;

    const slug = `propose-co-${randomUUID().slice(0, 8)}`;
    ids.ws = await insertId("insert into workspaces (name, slug) values ('Propose Co', $1) returning id", [slug]);
    ids.proc = await insertId("insert into processes (workspace_id, name) values ($1, 'Lead to cash') returning id", [ids.ws]);
    ids.rev = await insertId("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'draft') returning id", [ids.ws, ids.proc]);
    ids.step = await insertId(
      "insert into steps (revision_id, workspace_id, process_id, name, kind, work_hours, x, y) values ($1, $2, $3, 'Check fit', 'task', 1, 0, 0) returning id",
      [ids.rev, ids.ws, ids.proc],
    );
    await admin.query("update process_revisions set status = 'published' where id = $1", [ids.rev]);
    await admin.query("update processes set live_revision_id = $1 where id = $2", [ids.rev, ids.proc]);
    ids.issue = await insertId("insert into issues (workspace_id, type, title, process_id) values ($1, 'delay', 'Leads wait for a reply', $2) returning id", [ids.ws, ids.proc]);
    ids.closed = await insertId("insert into issues (workspace_id, type, title, status) values ($1, 'manual', 'Old problem', 'done') returning id", [ids.ws]);
    ids.source = await insertId("insert into sources (workspace_id, title) values ($1, 'Founder interview') returning id", [ids.ws]);

    ids.editor = await createUser(`propose-editor-${slug}@example.com`);
    ids.viewer = await createUser(`propose-viewer-${slug}@example.com`);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.ws, ids.editor, ids.viewer]);
    editorToken = await issueToken(ids.editor);
    viewerToken = await issueToken(ids.viewer);
    options = env.options;

  });

  afterAll(async () => {
    await env?.close();
  });

  it("proposes an issue and a solution idea, and writes no issue and no solution", async () => {
    const issuesBefore = await count("issues");
    const solutionsBefore = await count("solutions");
    const client = await connect(editorToken, options);
    const evidence = [{ source_id: ids.source, speaker: "Ana Lopez", quote: "we answer enquiries when we get to them" }];

    const issue = await call<{ proposal: { id: string; kind: string; status: string } }>(client, "propose_issue", {
      title: "Enquiries wait two days for a reply",
      detail: "Ana: 'we answer enquiries when we get to them'",
      rating: "bad",
      type: "delay",
      process: "Lead to cash",
      steps: ["Check fit"],
      target_measure: "Wait for a first reply",
      target_now: "2 d",
      target_goal: "under 4 h",
      evidence,
    });
    expect(issue, JSON.stringify(issue.error)).toMatchObject({ ok: true, data: { proposal: { kind: "issue", status: "pending" } } });

    const idea = await call<{ proposal: { id: string; kind: string; issue_id: string } }>(client, "propose_solution_idea", {
      issue: "Leads wait for a reply",
      title: "Reply automatically, then follow up",
      detail: "An AI step sends a first reply in minutes.",
      steps: [{ name: "Send first reply", ai: true }, { name: "Follow up", role: "Sales" }],
      replaces: ["Check fit"],
      expect: "First reply under 1 h",
    });
    expect(idea, JSON.stringify(idea.error)).toMatchObject({ ok: true, data: { proposal: { kind: "solution_idea", issue_id: ids.issue } } });

    // Nothing was created: only proposals, pending, by the editor, as the MCP server.
    expect(await count("issues")).toBe(issuesBefore);
    expect(await count("solutions")).toBe(solutionsBefore);
    const stored = (await admin.query("select kind, status, created_by, created_via, issue_id, payload from suggestion_proposals where workspace_id = $1 order by kind", [ids.ws])).rows;
    expect(stored).toHaveLength(2);
    expect(stored.every((s) => s.status === "pending" && s.created_by === ids.editor && s.created_via === "mcp")).toBe(true);
    expect(stored[0].payload).toMatchObject({ severity: "serious", type: "delay", links: [{ process_id: ids.proc, step_id: ids.step }], target_goal: "under 4 h" });
    expect(stored[1].payload).toMatchObject({ steps: [{ key: "s1", ai: true }, { key: "s2", role: "Sales" }], replaces_step_ids: [ids.step], expect: "First reply under 1 h" });

    const listed = await call<{ proposals: { id: string }[] }>(client, "list_proposals", { status: "pending" });
    expect(listed.data.proposals.map((p) => p.id).sort()).toEqual([issue.data.proposal.id, idea.data.proposal.id].sort());
    await client.close();
  });

  it("checks what it is given: a closed issue, an unknown step, a source that isn't there", async () => {
    const client = await connect(editorToken, options);
    expect(await call(client, "propose_solution_idea", { issue: "Old problem", title: "X", steps: [{ name: "A" }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await call(client, "propose_solution_idea", { issue: "No such issue", title: "X", steps: [{ name: "A" }] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call(client, "propose_issue", { title: "X", process: "Lead to cash", steps: ["Nope"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await call(client, "propose_issue", { title: "X", evidence: [{ source_id: randomUUID(), quote: "q" }] }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await client.close();
  });

  it("obeys the AI switches: off means a clear error and nothing stored; on again, it works", async () => {
    const client = await connect(editorToken, options);
    const stored = async () => (await admin.query("select count(*)::int as n from suggestion_proposals where workspace_id = $1", [ids.ws])).rows[0].n as number;
    const before = await stored();
    await admin.query("insert into ai_settings (workspace_id, suggest_issues, suggest_solutions) values ($1, false, false) on conflict (workspace_id) do update set suggest_issues = false, suggest_solutions = false", [ids.ws]);
    try {
      expect(await call(client, "propose_issue", { title: "Off" })).toMatchObject({ ok: false, error: { code: "switched_off", message: expect.stringMatching(/turned off in AI settings/) } });
      expect(await call(client, "propose_solution_idea", { issue: "Leads wait for a reply", title: "Off", steps: [{ name: "A" }] })).toMatchObject({ ok: false, error: { code: "switched_off" } });
      expect(await stored()).toBe(before);
      // One switch at a time.
      await admin.query("update ai_settings set suggest_issues = true where workspace_id = $1", [ids.ws]);
      expect(await call(client, "propose_issue", { title: "On again" })).toMatchObject({ ok: true });
      expect(await call(client, "propose_solution_idea", { issue: "Leads wait for a reply", title: "Still off", steps: [{ name: "A" }] })).toMatchObject({ ok: false, error: { code: "switched_off" } });
    } finally {
      await admin.query("delete from ai_settings where workspace_id = $1", [ids.ws]);
    }
    await client.close();
  });

  it("a viewer can't propose", async () => {
    const viewer = await connect(viewerToken, options);
    expect(await call(viewer, "propose_issue", { title: "Sneaky" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await viewer.close();
  });

  it("a token can't review: a person accepts in the app, and that creates the issue", async () => {
    const pending = (await admin.query("select id from suggestion_proposals where workspace_id = $1 and kind = 'issue' and status = 'pending' and title = 'Enquiries wait two days for a reply'", [ids.ws])).rows[0].id;
    // With the token: refused.
    const viaToken = await errorOf(async () => rpc((await tokenDbFor(env, ids.editor)).db, "review_proposals", { ids: [pending], decision: "accept" }));
    expect(viaToken).not.toBeNull();
    expect((await admin.query("select status from suggestion_proposals where id = $1", [pending])).rows[0].status).toBe("pending");

    // As the signed-in person: accepted, through the Acknowledge path.
    const issuesBefore = await count("issues");
    const res = await rpc(env.dbAs(userClaims(ids.editor)), "review_proposals", { ids: [pending], decision: "accept" });
    expect(res).toMatchObject([{ id: pending, status: "accepted" }]);
    expect(await count("issues")).toBe(issuesBefore + 1);
    const made = (await admin.query("select title, severity, type, source from issues where workspace_id = $1 and title = 'Enquiries wait two days for a reply'", [ids.ws])).rows[0];
    expect(made).toEqual({ title: "Enquiries wait two days for a reply", severity: "serious", type: "delay", source: "manual" });
  });
});
