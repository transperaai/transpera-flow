import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PURPOSES, type Db } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { importNewProcess } from "@transpera-flow/db/process-import";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, userClaims, type McpTestDb } from "./helpers";

// What a step achieves (sandbox phase 4) over the connector: get_process gives each step its raw purpose (null is Automatic), what it
// resolves to and why, and the workspace's categories; get_workspace_summary gives the categories. Read-only.

let env: McpTestDb;
let admin: pg.Client;
const ids = { ws: "", editor: "", process: "", revision: "" };
let token = "";
let options: McpHandlerOptions;
let editor: Db;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Record<string, unknown>;

beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
  const tag = randomUUID().slice(0, 8);
  ids.ws = (await one("insert into workspaces (name, slug, settings) select 'Purposes Co', $1, settings from workspaces where settings ? 'horizon_weeks' order by created_at limit 1 returning id", [`purposes-${tag}`])).id as string;
  ids.editor = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [ids.editor, `p-editor-${tag}@example.com`]);
  await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ids.ws, ids.editor]);
  const role = (await one("insert into roles (workspace_id, name, headcount) values ($1, 'Strategist', 1) returning id", [ids.ws])).id as string;
  const person = (await one("insert into people (workspace_id, name, fte) values ($1, 'Maya Collins', 1) returning id", [ids.ws])).id as string;
  await admin.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [person, role, ids.ws]);
  editor = env.dbAs(userClaims(ids.editor));
  options = env.options;
  const { token: t, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label, active_workspace_id) values ($1, $2, 'purposes', $3)", [ids.editor, hash, ids.ws]);
  token = t;
  const made = await importNewProcess(
    { db: editor, userId: ids.editor },
    ids.ws,
    {
      name: "Sales",
      steps: [
        { name: "Start", kind: "start" },
        { name: "Qualify", kind: "task", role: "Strategist", work_hours: 1 },
        { name: "Decision", kind: "decision", wait_hours: 8 },
        { name: "Onboard", kind: "task", role: "Strategist", work_hours: 2 },
        { name: "Chase", kind: "task", role: "Strategist", work_hours: 1 },
        { name: "Won", kind: "end", outcome: "won" },
        { name: "Lost", kind: "end", outcome: "lost" },
      ],
      edges: [
        { from: "Start", to: "Qualify" },
        { from: "Qualify", to: "Decision" },
        { from: "Decision", to: "Onboard", probability: 0.4 },
        { from: "Decision", to: "Lost", probability: 0.6 },
        { from: "Onboard", to: "Chase" },
        { from: "Chase", to: "Won" },
      ],
    },
  );
  ids.process = made.process.id;
  const published = (await rpc(editor, "publish_process", { target_process: ids.process, accept_estimates: true })) as { status?: string };
  expect(published.status, JSON.stringify(published)).toBe("published");
  ids.revision = (await one("select live_revision_id from processes where id = $1", [ids.process])).live_revision_id as string;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

interface Step {
  name: string;
  purpose: string | null;
  purpose_resolved: { key: string; name: string; source: string } | null;
}
const getProcess = async () => {
  const mcp = await connect(token, options);
  try {
    return await call<{ purpose_categories: { key: string; name: string }[]; steps: Step[] }>(mcp, "get_process", { process: "Sales" });
  } finally {
    await mcp.close();
  }
};
const byName = (steps: Step[], name: string) => steps.find((s) => s.name === name)!;

describe("purposes over the connector", () => {
  it("get_process gives the categories, each step's raw purpose and what Automatic comes to", async () => {
    const r = await getProcess();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.purpose_categories).toEqual(DEFAULT_PURPOSES);
    expect(byName(r.data.steps, "Qualify")).toMatchObject({ purpose: null, purpose_resolved: { key: "winning", name: "Winning work", source: "process_kind" } });
    // After the sale decision, the pipeline moves the client's job forward (Austin, 29 Oct; the deciding step is Winning work, 30 Oct).
    expect(byName(r.data.steps, "Onboard")).toMatchObject({ purpose: null, purpose_resolved: { key: "client_job", name: "Moves the client's job forward" } });
    expect(byName(r.data.steps, "Start").purpose_resolved).toBeNull();
    expect(byName(r.data.steps, "Won").purpose_resolved).toBeNull();
  });

  it("a chosen purpose wins over Automatic", async () => {
    // Published steps are fixed for the app's users; the migration-style owner write sets a chosen purpose.
    await admin.query("update steps set purpose = 'coordination' where revision_id = $1 and name = 'Chase'", [ids.revision]);
    const r = await getProcess();
    expect(byName(r.data.steps, "Chase")).toMatchObject({ purpose: "coordination", purpose_resolved: { key: "coordination", source: "chosen" } });
  });

  it("get_workspace_summary gives the defaults, then a list the workspace saved", async () => {
    const mcp = await connect(token, options);
    try {
      const first = await call<{ purpose_categories: { key: string }[]; workspace: { settings: Record<string, unknown> } }>(mcp, "get_workspace_summary", {});
      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(first.data.purpose_categories).toEqual(DEFAULT_PURPOSES);
      const renamed = DEFAULT_PURPOSES.map((c) => (c.key === "winning" ? { ...c, name: "Selling" } : c));
      await admin.query("update workspaces set settings = jsonb_set(settings, '{purposes}', $2::jsonb) where id = $1", [ids.ws, JSON.stringify(renamed)]);
      const next = await call<{ purpose_categories: { key: string; name: string }[]; workspace: { settings: { purposes?: unknown } } }>(mcp, "get_workspace_summary", {});
      expect(next.data.purpose_categories).toEqual(renamed);
      expect(next.data.workspace.settings.purposes).toEqual(renamed);
      const proc = await call<{ steps: Step[] }>(mcp, "get_process", { process: "Sales" });
      expect(byName(proc.data.steps, "Chase").purpose_resolved).toMatchObject({ key: "coordination" });
    } finally {
      await mcp.close();
    }
  });
});
