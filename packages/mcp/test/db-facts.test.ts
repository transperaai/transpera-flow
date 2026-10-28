import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payFreeIssueFields, type Db } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { importNewProcess } from "@transpera-flow/db/process-import";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, userClaims, type McpTestDb } from "./helpers";

// What an analysis outside the app needs, over the connector, read-only (issue #175, B17; docs/plans/cut-list.md item 5): the
// facts the engine measures (get_facts), the issues (list_issues), the sources and the solutions, bounded, scoped to the token
// owner's workspaces, and with a member's reading of issues free of pay. (Findings, AI analyses and proposing a finding over the
// connector are gone; this was db-findings.test.ts.)

let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", other: "", editor: "", viewer: "", stranger: "", process: "", role: "" };
const tokens = { editor: "", viewer: "", stranger: "" };
let editor: Db;
let options: McpHandlerOptions;

async function apiToken(userId: string, workspace = ids.ws) {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label, active_workspace_id) values ($1, $2, 'e2e', $3)", [userId, hash, workspace]);
  return token;
}

describe("the facts, issues, sources and solutions over the connector", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) select 'Facts Co', $1, settings from workspaces where settings ? 'horizon_weeks' order by created_at limit 1 returning id", [`facts-${tag}`])).id as string;
    ids.other = (await one("insert into workspaces (name, slug) values ('Elsewhere', $1) returning id", [`facts-other-${tag}`])).id as string;
    [ids.editor, ids.viewer, ids.stranger] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [ids.editor, `f-editor-${tag}@example.com`, ids.viewer, `f-viewer-${tag}@example.com`, ids.stranger, `f-stranger-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer'), ($4, $5, 'owner')", [ids.ws, ids.editor, ids.viewer, ids.other, ids.stranger]);
    ids.role = (await one("insert into roles (workspace_id, name, headcount) values ($1, 'Strategist', 1) returning id", [ids.ws])).id as string;
    // More work than one strategist can do, so the run has facts to show: ten leads a week at six hours each.
    const person = (await one("insert into people (workspace_id, name, fte) values ($1, 'Maya Collins', 1) returning id", [ids.ws])).id as string;
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [person, ids.role, ids.ws]);
    await admin.query("insert into lead_sources (workspace_id, name, volume_week, conversion_to_qualified) values ($1, 'Referrals', 10, 1)", [ids.ws]);
    editor = env.dbAs(userClaims(ids.editor));
    options = env.options;
    tokens.editor = await apiToken(ids.editor);
    tokens.viewer = await apiToken(ids.viewer);
    tokens.stranger = await apiToken(ids.stranger, ids.other);
    // A small published process, so the engine has something to measure: made as the editor, the way the web app's upload makes one.
    const made = await importNewProcess(
      { db: editor, userId: ids.editor },
      ids.ws,
      {
        name: "Sales",
        steps: [
          { name: "Start", kind: "start" },
          { name: "Write proposal", kind: "task", role: "Strategist", work_hours: 6 },
          { name: "Won", kind: "end", outcome: "won" },
        ],
        edges: [
          { from: "Start", to: "Write proposal" },
          { from: "Write proposal", to: "Won" },
        ],
      },
    );
    ids.process = made.process.id;
    const published = (await rpc(editor, "publish_process", { target_process: ids.process, accept_estimates: true })) as { status?: string };
    expect(published.status, JSON.stringify(published)).toBe("published");
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  it("reads every fact, issue, source and solution an analysis needs, as a viewer", async () => {
    const mcpViewer = await connect(tokens.viewer, options);
    const facts = await call<{ facts: { key: string; title: string; evidence: string; rating: string }[] }>(mcpViewer, "get_facts", { process: "Sales" });
    expect(facts.ok, JSON.stringify(facts)).toBe(true);
    expect(facts.data.facts.length, JSON.stringify(facts)).toBeGreaterThan(0);
    expect(facts.data.facts[0]).toMatchObject({ key: expect.any(String), title: expect.any(String), evidence: expect.any(String) });

    const byHand = await editor.insertInto("issues").values({ workspace_id: ids.ws, process_id: ids.process, title: "Invoices go out late", type: "delay", severity: "warning", source: "manual" }).returning("id").executeTakeFirstOrThrow();
    expect(byHand).toBeTruthy();
    const issues = await call<{ issues: { id: string }[] }>(mcpViewer, "list_issues", {});
    expect(issues.ok).toBe(true);
    const storedIssues = (await admin.query("select id from issues where workspace_id = $1 and status <> 'dismissed'", [ids.ws])).rows.map((r) => r.id as string);
    expect(issues.data.issues.map((i) => i.id).sort()).toEqual(storedIssues.sort());

    for (const [tool, args] of [
      ["list_sources", {}],
      ["list_solutions", {}],
      ["get_first_principles", { process: "Sales" }],
      ["get_process", { process: "Sales" }],
    ] as const) {
      const r = await call(mcpViewer, tool, args);
      expect(r.ok, `${tool} ${JSON.stringify(r)}`).toBe(true);
    }
    await mcpViewer.close();
  }, 120_000);

  it("keeps every connector list bounded: facts to a limit, sources a page at a time, solutions without their maps", async () => {
    const mcp = await connect(tokens.viewer, options);
    const facts = await call<{ count: number; shown: number; facts: { evidence: string; cost: Record<string, unknown> }[] }>(mcp, "get_facts", { process: "Sales", limit: 1 });
    expect(facts.ok, JSON.stringify(facts)).toBe(true);
    expect(facts.data.facts).toHaveLength(1);
    expect(facts.data.shown).toBe(1);
    expect(facts.data.count).toBeGreaterThanOrEqual(1);
    expect(facts.data.facts[0]!.evidence.length).toBeLessThanOrEqual(600);
    expect(Object.keys(facts.data.facts[0]!.cost).sort()).toEqual(["currency", "estimate", "hours_per_month", "how", "per_month"]);

    for (const title of ["Kickoff call", "Ops notes", "SOP"]) await admin.query("insert into sources (workspace_id, title, body) values ($1, $2, $3)", [ids.ws, title, "x".repeat(5000)]);
    const s1 = await call<{ total: number; next_offset: number | null; sources: { title: string; text: string; text_truncated: boolean }[] }>(mcp, "list_sources", { limit: 2 });
    expect(s1.ok, JSON.stringify(s1)).toBe(true);
    expect(s1.data).toMatchObject({ total: 3, next_offset: 2 });
    expect(s1.data.sources.map((s) => s.title)).toEqual(["Kickoff call", "Ops notes"]);
    expect(s1.data.sources[0]).toMatchObject({ text_truncated: true });
    expect(s1.data.sources[0]!.text).toHaveLength(4000);
    const s2 = await call<{ next_offset: number | null; sources: { title: string }[] }>(mcp, "list_sources", { limit: 2, offset: 2 });
    expect(s2.data).toMatchObject({ next_offset: null, sources: [{ title: "SOP" }] });

    const revision = (await one("select live_revision_id from processes where id = $1", [ids.process])).live_revision_id as string;
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await admin.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Hire a second strategist', $4)", [
      ids.ws,
      ids.process,
      revision,
      JSON.stringify({ steps: [{ id: "s", name: "A big copied map" }], edges: [] }),
    ]);
    await admin.query("commit");
    const sol = await call<{ solutions: Record<string, unknown>[] }>(mcp, "list_solutions", {});
    expect(sol.ok, JSON.stringify(sol)).toBe(true);
    expect(sol.data.solutions).toHaveLength(1);
    expect(sol.data.solutions[0]).toMatchObject({ name: "Hire a second strategist", changed_step_ids: [], issues: [] });
    expect(sol.data.solutions[0]).not.toHaveProperty("steps");
    expect(sol.data.solutions[0]).not.toHaveProperty("workspace_id");
    await mcp.close();
  }, 120_000);

  it("shows another workspace's owner none of it over the connector", async () => {
    const mcp = await connect(tokens.stranger, options);
    expect((await call(mcp, "get_facts", { workspace: ids.ws, process: "Sales" })).ok).toBe(false);
    expect((await call(mcp, "list_issues", { workspace: ids.ws })).ok).toBe(false);
    const own = await call<{ issues: unknown[] }>(mcp, "list_issues", {});
    expect(own).toMatchObject({ ok: true, data: { issues: [] } });
    await mcp.close();
  });

  it("gives a member no overtime money in a saved issue: the app strips it before saving, and nothing a member reads holds it (B1 2b)", async () => {
    const tag = randomUUID().slice(0, 8);
    const member = randomUUID();
    await admin.query("insert into auth.users (id, email) values ($1, $2)", [member, `f-pay-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')", [ids.ws, member]);
    const token = await apiToken(member);
    const old =
      "Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap, costing about £1,040 at cost rates over the 26-week run. The cap is used up.";
    // What an old browser tab sends, through the same strip the server actions use.
    const fields = payFreeIssueFields({
      workspace_id: ids.ws,
      process_id: ids.process,
      title: "Maya Collins works 4 h/wk overtime",
      type: "capacity",
      severity: "serious",
      source: "promoted",
      detected_key: `overtime:person:${tag}`,
      evidence: old,
      evidence_metrics: { overtime_hours_week: 4, overtime_cost: 1040 },
    });
    const saved = await editor.insertInto("issues").values(fields as never).returning("id").executeTakeFirstOrThrow();

    const mcp = await connect(token, options);
    const listed = await call<{ issues: { id: string; evidence: string | null; evidence_metrics: Record<string, number> }[] }>(mcp, "list_issues", {});
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const row = listed.data.issues.find((i) => i.id === saved.id)!;
    expect(row.evidence).toContain("overtime on average within the 10% cap. The cap is used up.");
    expect(row.evidence_metrics).toEqual({ overtime_hours_week: 4 });
    expect(JSON.stringify(listed)).not.toMatch(/overtime_cost|costing about/);
    await mcp.close();
  }, 120_000);
});
