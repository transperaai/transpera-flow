import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, signJwt } from "./helpers";

// Findings (issue #175, B17; migration 20261205000000) as the web app and the connector reach them: over PostgREST with
// Supabase's table privileges and RLS. Every member reads findings; owners and editors add them by hand and accept, edit or
// dismiss them; a viewer creates and changes none; anon reads nothing; nobody reaches another workspace's; nobody deletes
// one; an "AI" finding needs an analysis its writer ran. And the connector's coverage: every fact, finding and issue an
// analysis needs is readable over MCP (get_facts, list_findings, list_issues, get_analysis, list_sources, list_solutions).
// Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const SUPABASE_URL = "https://project.supabase.test";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", other: "", editor: "", viewer: "", stranger: "", process: "", role: "" };
const tokens = { editor: "", viewer: "", stranger: "" };
let editor: SupabaseClient;
let viewer: SupabaseClient;
let stranger: SupabaseClient;
let anon: SupabaseClient;
let options: McpHandlerOptions;

function client(token: string): SupabaseClient {
  return createClient("http://postgrest.invalid", token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { authorization: `Bearer ${token}` },
      fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
    },
  });
}

const toPostgrest: typeof fetch = (input, init) => {
  if (input instanceof Request) throw new Error("expected supabase-js to pass a URL string");
  return fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);
};

async function apiToken(userId: string) {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label, active_workspace_id) values ($1, $2, 'e2e', $3)", [userId, hash, ids.ws]);
  return token;
}

const manual = (title: string, extra: Record<string, unknown> = {}) => ({ workspace_id: ids.ws, process_id: ids.process, origin: "manual", status: "accepted", rating: "bad", type: "delay", title, ...extra });

describe.skipIf(!POSTGREST_URL)("findings over PostgREST and the connector", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) select 'Findings Co', $1, settings from workspaces where settings ? 'horizon_weeks' order by created_at limit 1 returning id", [`findings-${tag}`])).id as string;
    ids.other = (await one("insert into workspaces (name, slug) values ('Elsewhere', $1) returning id", [`findings-other-${tag}`])).id as string;
    [ids.editor, ids.viewer, ids.stranger] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [ids.editor, `f-editor-${tag}@example.com`, ids.viewer, `f-viewer-${tag}@example.com`, ids.stranger, `f-stranger-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer'), ($4, $5, 'owner')", [ids.ws, ids.editor, ids.viewer, ids.other, ids.stranger]);
    ids.role = (await one("insert into roles (workspace_id, name, headcount) values ($1, 'Strategist', 1) returning id", [ids.ws])).id as string;
    // More work than one strategist can do, so the run has facts to show: ten leads a week at six hours each.
    const person = (await one("insert into people (workspace_id, name, fte) values ($1, 'Maya Collins', 1) returning id", [ids.ws])).id as string;
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [person, ids.role, ids.ws]);
    await admin.query("insert into lead_sources (workspace_id, name, volume_week, conversion_to_qualified) values ($1, 'Referrals', 10, 1)", [ids.ws]);
    const jwt = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editor = client(jwt(ids.editor));
    viewer = client(jwt(ids.viewer));
    stranger = client(jwt(ids.stranger));
    anon = client(signJwt({ role: "anon" }, JWT_SECRET));
    options = { supabaseUrl: SUPABASE_URL, supabaseKey: signJwt({ role: "anon", iss: "test" }, JWT_SECRET), fetch: toPostgrest };
    tokens.editor = await apiToken(ids.editor);
    tokens.viewer = await apiToken(ids.viewer);
    const { token, hash } = generateApiToken();
    await admin.query("insert into api_tokens (user_id, token_hash, label, active_workspace_id) values ($1, $2, 'e2e', $3)", [ids.stranger, hash, ids.other]);
    tokens.stranger = token;
    const deadline = Date.now() + 60_000;
    while ((await editor.from("workspaces").select("id").eq("id", ids.ws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
    // A small published process the editor builds over the connector, so the engine has something to measure.
    const mcp = await connect(tokens.editor, options);
    expect(await call(mcp, "create_process", { name: "Sales" })).toMatchObject({ ok: true });
    expect(await call(mcp, "add_step", { process: "Sales", name: "Write proposal", role: "Strategist", work_hours: 6, after: "Start", before: "Won" })).toMatchObject({ ok: true });
    const pub = await call(mcp, "publish_process", { process: "Sales", accept_estimates: true });
    expect(pub.ok, JSON.stringify(pub)).toBe(true);
    ids.process = (await one("select id from processes where workspace_id = $1 and name = 'Sales'", [ids.ws])).id as string;
  }, 120_000);

  afterAll(async () => {
    // Only this suite's own workspaces (the database is shared): their rows go with them.
    for (const ws of [ids.ws, ids.other]) {
      if (!ws) continue;
      // Its processes first (their steps hold its roles), never the company map, which goes with the workspace.
      await admin.query("delete from processes where workspace_id = $1 and not is_company", [ws]);
      await admin.query("delete from workspaces where id = $1", [ws]);
      await admin.query("delete from audit_log where workspace_id = $1", [ws]);
    }
    await admin?.end();
  });

  it("lets an editor add a finding by hand (accepted at once, stamped as them), edit it and dismiss it; nobody deletes it", async () => {
    const added = await editor.from("findings").insert(manual("Proposals wait for one person", { created_by: ids.viewer, why: "Founders go elsewhere." })).select("*").single();
    expect(added.error).toBeNull();
    expect(added.data).toMatchObject({ origin: "manual", status: "accepted", created_by: ids.editor, decided_by: ids.editor });
    const id = added.data!.id as string;
    expect((await editor.from("findings").update({ title: "Proposals wait a week for one person" }).eq("id", id).select("title")).data).toEqual([{ title: "Proposals wait a week for one person" }]);
    expect((await editor.from("findings").update({ status: "dismissed" }).eq("id", id).select("status, decided_by")).data).toEqual([{ status: "dismissed", decided_by: ids.editor }]);
    const del = await editor.from("findings").delete().eq("id", id).select("id");
    expect(del.error?.message ?? "").toMatch(/permission denied/);
    expect((await one("select status from findings where id = $1", [id])).status).toBe("dismissed");
  });

  it("lets a viewer read findings but not add, accept, edit or dismiss one", async () => {
    const id = (await one("insert into findings (workspace_id, process_id, origin, status, rating, type, title) values ($1, $2, 'manual', 'accepted', 'bad', 'delay', 'Slow replies') returning id", [ids.ws, ids.process])).id as string;
    expect((await viewer.from("findings").select("title").eq("id", id)).data).toEqual([{ title: "Slow replies" }]);
    expect((await viewer.from("findings").insert(manual("Viewer's own"))).error?.message).toMatch(/row-level security/);
    expect((await viewer.from("findings").update({ status: "dismissed" }).eq("id", id).select("id")).data).toEqual([]);
    expect((await viewer.from("findings").update({ title: "Theirs" }).eq("id", id).select("id")).data).toEqual([]);
    expect((await one("select title, status from findings where id = $1", [id]))).toEqual({ title: "Slow replies", status: "accepted" });
  });

  it("gives anon nothing and another workspace's owner nothing", async () => {
    await one("insert into findings (workspace_id, process_id, origin, status, rating, type, title) values ($1, $2, 'manual', 'accepted', 'bad', 'delay', 'Private') returning id", [ids.ws, ids.process]);
    const a = await anon.from("findings").select("id");
    expect(a.error?.message ?? "").toMatch(/permission denied/);
    expect((await anon.from("findings").insert(manual("Anon"))).error).not.toBeNull();
    expect((await stranger.from("findings").select("id").eq("workspace_id", ids.ws)).data).toEqual([]);
    expect((await stranger.from("findings").insert(manual("Theirs"))).error).not.toBeNull();
    expect((await stranger.from("findings").update({ title: "x" }).eq("workspace_id", ids.ws).select("id")).data).toEqual([]);
  });

  it("refuses an AI finding no analysis of the writer's made", async () => {
    const r = await editor.from("findings").insert(manual("AI says", { origin: "ai", status: "proposed", ai_key: "ai:insight:abcdefabcdef" }));
    expect(r.error?.message).toMatch(/must come from an analysis you ran/);
  });

  it("reads every fact, finding and issue an analysis needs over the connector, as a viewer", async () => {
    // A proposed AI finding (written as the database's owner, as a restore would) that cites a fact, an accepted one
    // acknowledged as an issue, and an issue logged by hand.
    const mcpViewer = await connect(tokens.viewer, options);
    const facts = await call<{ facts: { key: string; title: string; evidence: string; rating: string }[] }>(mcpViewer, "get_facts", { process: "Sales" });
    expect(facts.ok, JSON.stringify(facts)).toBe(true);
    expect(facts.data.facts.length, JSON.stringify(facts)).toBeGreaterThan(0);
    const fact = facts.data.facts[0]!;
    expect(fact).toMatchObject({ key: expect.any(String), title: expect.any(String), evidence: expect.any(String) });

    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    const proposed = (
      await admin.query(
        "insert into findings (workspace_id, process_id, origin, status, rating, type, title, facts, ai_key) values ($1, $2, 'ai', 'proposed', 'risk', 'capacity', 'One strategist carries the line', $3, 'ai:insight:111111111111') returning id",
        [ids.ws, ids.process, JSON.stringify([{ kind: "fact", key: fact.key, text: fact.title }])],
      )
    ).rows[0].id as string;
    await admin.query("commit");
    const accepted = (await editor.from("findings").insert(manual("Proposals are written twice")).select("id").single()).data!.id as string;
    const acknowledged = await editor
      .from("issues")
      .insert({ workspace_id: ids.ws, process_id: ids.process, title: "Proposals are written twice", type: "delay", severity: "warning", source: "promoted", detected_key: `finding:by_hand:${accepted}` })
      .select("id, number")
      .single();
    expect(acknowledged.error).toBeNull();
    const byHand = await editor.from("issues").insert({ workspace_id: ids.ws, process_id: ids.process, title: "Invoices go out late", type: "delay", severity: "warning", source: "manual" }).select("id").single();
    expect(byHand.error).toBeNull();

    const all = await call<{ findings: { id: string; status: string; origin: string; rests_on: { key: string }[]; issue: { id: string } | null }[] }>(mcpViewer, "list_findings", { status: ["proposed", "accepted", "dismissed", "superseded"] });
    expect(all.ok, JSON.stringify(all)).toBe(true);
    const stored = (await admin.query("select id from findings where workspace_id = $1", [ids.ws])).rows.map((r) => r.id as string);
    expect(all.data.findings.map((f) => f.id).sort()).toEqual(stored.sort());
    const p = all.data.findings.find((f) => f.id === proposed)!;
    expect(p).toMatchObject({ status: "proposed", origin: "ai", issue: null });
    // Every fact a finding rests on is one get_facts reads.
    expect(p.rests_on.map((c) => c.key)).toEqual([fact.key]);
    expect(facts.data.facts.map((f) => f.key)).toContain(p.rests_on[0]!.key);
    expect(all.data.findings.find((f) => f.id === accepted)).toMatchObject({ origin: "by_hand", issue: { id: acknowledged.data!.id } });

    const issues = await call<{ issues: { id: string }[] }>(mcpViewer, "list_issues", {});
    expect(issues.ok).toBe(true);
    const storedIssues = (await admin.query("select id from issues where workspace_id = $1 and status <> 'dismissed'", [ids.ws])).rows.map((r) => r.id as string);
    expect(issues.data.issues.map((i) => i.id).sort()).toEqual(storedIssues.sort());

    for (const [tool, args] of [
      ["get_analysis", { process: "Sales" }],
      ["get_analysis", { company: true }],
      ["list_sources", {}],
      ["list_solutions", {}],
      ["get_first_principles", { process: "Sales" }],
      ["get_process", { process: "Sales" }],
    ] as const) {
      const r = await call(mcpViewer, tool, args);
      expect(r.ok, `${tool} ${JSON.stringify(r)}`).toBe(true);
    }
  }, 120_000);

  it("shows another workspace's owner none of it over the connector", async () => {
    const mcp = await connect(tokens.stranger, options);
    expect((await call(mcp, "list_findings", { workspace: ids.ws })).ok).toBe(false);
    const own = await call<{ findings: unknown[] }>(mcp, "list_findings", {});
    expect(own).toMatchObject({ ok: true, data: { findings: [] } });
  });
});
