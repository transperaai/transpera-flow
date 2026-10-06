import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payFreeIssueFields, reserveAiRun, saveAiAnalysis, setFindingStatus, storeProposedFindings, type ProposedFinding } from "@transpera-flow/db";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, signJwt } from "./helpers";

// Findings (issue #175, B17; migration 20261205000000) as the web app and the connector reach them: over PostgREST with
// Supabase's table privileges and RLS. Every member reads findings; owners and editors add them by hand and accept, edit or
// dismiss them; a viewer creates and changes none; anon reads nothing; nobody reaches another workspace's; nobody deletes
// one; an "AI" finding needs an analysis its writer ran. And the connector's coverage: every fact, finding and issue an
// analysis needs is readable over MCP (get_facts, list_findings, list_issues, get_analysis, list_sources, list_solutions).
// And B20 (#197): Claude proposes findings over the connector (propose_finding), which an editor accepts in the app.
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

  it("supersedes, run by run, the proposals a later run on the same version didn't make again, and proposes one again", async () => {
    const revision = (await one("select live_revision_id from processes where id = $1", [ids.process])).live_revision_id as string;
    const proposal = (aiKey: string, title: string): ProposedFinding => ({ aiKey, processId: ids.process, stepId: null, rating: "bad", type: "delay", title, evidence: "Work waits.", why: "Clients wait.", facts: [], personLabels: {} });
    const [maya, rosa] = [randomUUID(), randomUUID()];
    const A = { ...proposal("ai:insight:aaaaaaaaaaa1", "Proposals wait for one person"), personLabels: { "Team member A": maya } };
    const B = proposal("ai:insight:bbbbbbbbbbb2", "Only one strategist can price work");
    const run = async (findings: ProposedFinding[]) => {
      // One run a minute per process: age the earlier runs, as a minute passing would.
      await admin.query("update ai_runs set started_at = started_at - interval '2 minutes' where process_id = $1", [ids.process]);
      const reserved = await reserveAiRun(editor as never, ids.ws, ids.process, "manual");
      if (reserved.status !== "ok") throw new Error(`reserve: ${reserved.status}`);
      const analysisId = await saveAiAnalysis(editor as never, {
        run_id: reserved.runId,
        workspace_id: ids.ws,
        process_id: ids.process,
        revision_id: revision,
        status: "ok",
        reason: null,
        trigger: "manual",
        summary: ["Fine."],
        insights: [],
        review: [],
        checked: 0,
        dropped: 0,
        input_hash: "h",
        model: "fake",
        model_hash: null,
        usage: [],
        person_labels: {},
      });
      if (!analysisId) throw new Error("the analysis wasn't saved");
      const out = await storeProposedFindings(editor as never, { workspaceId: ids.ws, analysisId, runId: reserved.runId, scope: ids.process, findings });
      return { analysisId, runId: reserved.runId, out };
    };
    const status = async () =>
      Object.fromEntries((await admin.query("select ai_key, status, run_id from findings where workspace_id = $1 and ai_key = any($2)", [ids.ws, [A.aiKey, B.aiKey]])).rows.map((r) => [r.ai_key, r]));

    const first = await run([A, B]);
    expect(first.out).toEqual({ added: 2, renewed: 0, superseded: 0 });
    // What the run wrote is stored with the labels its text uses (B1 2b).
    const labelsOf = async (key: string) => (await one("select person_labels from findings where workspace_id = $1 and ai_key = $2", [ids.ws, key])).person_labels;
    expect(await labelsOf(A.aiKey)).toEqual({ "Team member A": maya });
    expect(await labelsOf(B.aiKey)).toEqual({});
    // The same version again: the analysis keeps its id, the run is new, and B (not proposed again) is superseded.
    // A finding proposed again gets the new run's map with its new text.
    const second = await run([{ ...A, personLabels: { "Team member B": rosa } }]);
    expect(second.analysisId).toBe(first.analysisId);
    expect(second.out).toEqual({ added: 0, renewed: 1, superseded: 1 });
    expect(await labelsOf(A.aiKey)).toEqual({ "Team member B": rosa });
    let now = await status();
    expect(now[A.aiKey]).toMatchObject({ status: "proposed", run_id: second.runId });
    expect(now[B.aiKey]).toMatchObject({ status: "superseded", run_id: first.runId });
    // A superseded proposal can't be accepted or dismissed.
    const bId = (await one("select id from findings where workspace_id = $1 and ai_key = $2", [ids.ws, B.aiKey])).id as string;
    for (const s of ["accepted", "dismissed"] as const) expect(await setFindingStatus(editor as never, bId, s)).toMatchObject({ status: "invalid", message: expect.stringContaining("later analysis replaced") });
    const aId = (await one("select id from findings where workspace_id = $1 and ai_key = $2", [ids.ws, A.aiKey])).id as string;
    expect(await setFindingStatus(editor as never, aId, "accepted")).toMatchObject({ status: "saved" });
    // A third run proposes B again (it is back for review) and leaves A, which a person accepted, as it is.
    const third = await run([A, B]);
    expect(third.out).toEqual({ added: 0, renewed: 1, superseded: 0 });
    now = await status();
    expect(now[A.aiKey]).toMatchObject({ status: "accepted", run_id: second.runId });
    expect(now[B.aiKey]).toMatchObject({ status: "proposed", run_id: third.runId });
  }, 60_000);

  it("keeps every connector list bounded: facts to a limit, findings and sources a page at a time, solutions without their maps", async () => {
    const mcp = await connect(tokens.viewer, options);
    const facts = await call<{ count: number; shown: number; facts: { evidence: string; cost: Record<string, unknown> }[] }>(mcp, "get_facts", { process: "Sales", limit: 1 });
    expect(facts.ok, JSON.stringify(facts)).toBe(true);
    expect(facts.data.facts).toHaveLength(1);
    expect(facts.data.shown).toBe(1);
    expect(facts.data.count).toBeGreaterThanOrEqual(1);
    expect(facts.data.facts[0]!.evidence.length).toBeLessThanOrEqual(600);
    expect(Object.keys(facts.data.facts[0]!.cost).sort()).toEqual(["currency", "estimate", "hours_per_month", "how", "per_month"]);

    const stored = Number((await one("select count(*) from findings where workspace_id = $1 and status in ('proposed', 'accepted')", [ids.ws])).count);
    expect(stored).toBeGreaterThanOrEqual(2);
    const page1 = await call<{ total: number; next_offset: number | null; findings: { id: string }[] }>(mcp, "list_findings", { limit: 1 });
    expect(page1.ok, JSON.stringify(page1)).toBe(true);
    expect(page1.data).toMatchObject({ total: stored, next_offset: 1 });
    expect(page1.data.findings).toHaveLength(1);
    const page2 = await call<{ findings: { id: string }[] }>(mcp, "list_findings", { limit: 1, offset: 1 });
    expect(page2.data.findings).toHaveLength(1);
    expect(page2.data.findings[0]!.id).not.toBe(page1.data.findings[0]!.id);
    const whole = await call<{ total: number; next_offset: number | null }>(mcp, "list_findings", { limit: 200 });
    expect(whole.data).toMatchObject({ total: stored, next_offset: null });

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
  }, 120_000);

  it("shows another workspace's owner none of it over the connector", async () => {
    const mcp = await connect(tokens.stranger, options);
    expect((await call(mcp, "list_findings", { workspace: ids.ws })).ok).toBe(false);
    const own = await call<{ findings: unknown[] }>(mcp, "list_findings", {});
    expect(own).toMatchObject({ ok: true, data: { findings: [] } });
  });

  it("names AI text per reader over the connector: names for an editor, a member's own name and 'A team member' for the rest, never another person's name (B1 2b)", async () => {
    const tag = randomUUID().slice(0, 8);
    const maya = (await one("select id from people where workspace_id = $1 and name = 'Maya Collins'", [ids.ws])).id as string;
    const rosa = (await one("insert into people (workspace_id, name, fte) values ($1, 'Rosa Diaz', 1) returning id", [ids.ws])).id as string;
    const [linked, unlinked] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [linked, `f-linked-${tag}@example.com`, unlinked, `f-unlinked-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'member', $3), ($1, $4, 'member', null)", [ids.ws, linked, maya, unlinked]);
    const [linkedToken, unlinkedToken] = [await apiToken(linked), await apiToken(unlinked)];

    // An analysis and an AI finding the app saved with labels: A is Maya, B is Rosa.
    const labels = JSON.stringify({ "Team member A": maya, "Team member B": rosa });
    const revision = (await one("select live_revision_id from processes where id = $1", [ids.process])).live_revision_id as string;
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    const run = (await admin.query("insert into ai_runs (workspace_id, process_id, trigger, user_id, user_name) values ($1, $2, 'manual', $3, 'Ed Itor') returning id", [ids.ws, ids.process, ids.editor])).rows[0].id as string;
    const analysis = (
      await admin.query(
        `insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, summary, review, input_hash, run_id, created_by, person_labels)
         values ($1, $2, $3, 'ok', 'manual', $4, $5, 'h', $6, $7, $8)
         on conflict (revision_id) do update set summary = excluded.summary, review = excluded.review, run_id = excluded.run_id, created_by = excluded.created_by,
           person_labels = excluded.person_labels, updated_at = now()
         returning id`,
        [
          ids.ws, ids.process, revision,
          JSON.stringify(["Team member A is overloaded. Team member B covers when Team member A is away."]),
          JSON.stringify([{ step: "job", level: "warn", text: "Team member B owns the job." }]),
          run, ids.editor, labels,
        ],
      )
    ).rows[0].id as string;
    const finding = (
      await admin.query(
        `insert into findings (workspace_id, process_id, origin, status, rating, type, title, evidence, why, facts, ai_key, analysis_id, run_id, person_labels)
         values ($1, $2, 'ai', 'proposed', 'bad', 'capacity', 'Team member A carries the line', 'Team member B reviews it.', 'Team member A is the only one who can price.', $3, 'ai:insight:222222222222', $4, $5, $6) returning id`,
        [ids.ws, ids.process, JSON.stringify([{ kind: "fact", key: "capacity:person:x", text: "Team member A works 4 h/wk overtime." }]), analysis, run, labels],
      )
    ).rows[0].id as string;
    await admin.query("commit");

    const read = async (token: string) => {
      const mcp = await connect(token, options);
      const found = await call<{ findings: { id: string; title: string; evidence: string; why: string; rests_on: { text: string }[] }[] }>(mcp, "list_findings", { status: ["proposed"] });
      const analysed = await call<{ analysis: { read: string[]; review: { text: string }[] } }>(mcp, "get_analysis", { process: "Sales" });
      expect(found.ok, JSON.stringify(found)).toBe(true);
      expect(analysed.ok, JSON.stringify(analysed)).toBe(true);
      return { finding: found.data.findings.find((f) => f.id === finding)!, analysis: analysed.data.analysis, text: JSON.stringify([found, analysed]) };
    };

    // An editor sees both people as they are.
    const asEditor = await read(tokens.editor);
    expect(asEditor.finding).toMatchObject({ title: "Maya Collins carries the line", evidence: "Rosa Diaz reviews it.", why: "Maya Collins is the only one who can price." });
    expect(asEditor.finding.rests_on[0]!.text).toBe("Maya Collins works 4 h/wk overtime.");
    expect(asEditor.analysis.read).toEqual(["Maya Collins is overloaded. Rosa Diaz covers when Maya Collins is away."]);
    expect(asEditor.analysis.review[0]!.text).toBe("Rosa Diaz owns the job.");

    // A member linked to Maya sees Maya, and "A team member" for Rosa: never Rosa's name, never a label's letters.
    const asMember = await read(linkedToken);
    expect(asMember.finding).toMatchObject({ title: "Maya Collins carries the line", evidence: "A team member reviews it.", why: "Maya Collins is the only one who can price." });
    expect(asMember.analysis.read).toEqual(["Maya Collins is overloaded. A team member covers when Maya Collins is away."]);
    expect(asMember.analysis.review[0]!.text).toBe("A team member owns the job.");
    expect(asMember.text).not.toContain("Rosa Diaz");
    expect(asMember.text).not.toMatch(/Team member [A-Z]/);

    // A member linked to no one sees "A team member" twice over, and neither name.
    const asStranger = await read(unlinkedToken);
    expect(asStranger.finding).toMatchObject({ title: "A team member carries the line", evidence: "A team member reviews it.", why: "A team member is the only one who can price." });
    expect(asStranger.analysis.read).toEqual(["A team member is overloaded. A team member covers when a team member is away."]);
    expect(asStranger.text).not.toContain("Rosa Diaz");
    expect(asStranger.text).not.toContain("Maya Collins");
    expect(asStranger.text).not.toMatch(/Team member [A-Z]/);
  }, 120_000);

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
    const saved = await editor.from("issues").insert(fields).select("id").single();
    expect(saved.error).toBeNull();

    const mcp = await connect(token, options);
    const listed = await call<{ issues: { id: string; evidence: string | null; evidence_metrics: Record<string, number> }[] }>(mcp, "list_issues", {});
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const row = listed.data.issues.find((i) => i.id === saved.data!.id)!;
    expect(row.evidence).toContain("overtime on average within the 10% cap. The cap is used up.");
    expect(row.evidence_metrics).toEqual({ overtime_hours_week: 4 });
    expect(JSON.stringify(listed)).not.toMatch(/overtime_cost|costing about/);
  }, 120_000);

  // Claude outside the app proposes findings (issue #197, B20; migration 20261212000000).
  describe("propose_finding over the connector", () => {
    type Fact = { key: string; title: string; evidence: string; cost: { per_month: number | null } };
    type Proposed = { finding: { id: string; status: string; origin: string; proposed_via: string; title: string; process: { name: string } | null; across_the_company: boolean; step: { name: string } | null; rests_on: { kind: string; key: string; text: string }[]; source_ids: string[] }; review: string };
    let mcpEditor: Awaited<ReturnType<typeof connect>>;
    let facts: Fact[];
    let sourceId: string;
    let memberToken: string;
    let strangerWsToken: string;
    const proposal = (extra: Record<string, unknown> = {}) => ({ process: "Sales", title: "Proposals wait for one strategist", rating: "bad", type: "delay", facts: [facts[0]!.key], ...extra });
    const raw = (method: string, path: string, token: string, body?: unknown) =>
      fetch(`${POSTGREST_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${options.supabaseKey}`, "x-api-token": token, "content-type": "application/json", prefer: "return=representation" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    beforeAll(async () => {
      mcpEditor = await connect(tokens.editor, options);
      // A step pinned to Maya that sends work back: its rework fact costs her hours at her cost rate, so the editor's figure
      // depends on her pay and a member's doesn't exist (the no-pay test below needs one).
      const maya = (await one("select id from people where workspace_id = $1 and name = 'Maya Collins'", [ids.ws])).id as string;
      await admin.query("update people set cost_rate = 913.37 where id = $1", [maya]);
      const review = await call(mcpEditor, "add_step", { process: "Sales", name: "Review proposal", role: "Strategist", person: "Maya Collins", work_hours: 1, rework_rate: 0.4, rework_to: "Write proposal", after: "Write proposal", before: "Won" });
      expect(review.ok, JSON.stringify(review)).toBe(true);
      const republished = await call(mcpEditor, "publish_process", { process: "Sales", accept_estimates: true });
      expect(republished.ok, JSON.stringify(republished)).toBe(true);
      const got = await call<{ facts: Fact[] }>(mcpEditor, "get_facts", { process: "Sales" });
      expect(got.ok, JSON.stringify(got)).toBe(true);
      facts = got.data.facts;
      expect(facts.length).toBeGreaterThan(0);
      sourceId = (await one("insert into sources (workspace_id, title, body) values ($1, 'Proposal interview', $2) returning id", [ids.ws, "Maya Collins: We write every proposal by hand, and it takes most of the week."])).id as string;
      const member = randomUUID();
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [member, `f-propose-member-${randomUUID().slice(0, 8)}@example.com`]);
      await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')", [ids.ws, member]);
      memberToken = await apiToken(member);
      strangerWsToken = tokens.stranger;
    }, 120_000);

    it("proposes a finding that waits for review, stored with labels and read with names; then a person accepts it in the app", async () => {
      const r = await call<Proposed>(
        mcpEditor,
        "propose_finding",
        proposal({
          title: "Maya Collins is the only one who writes proposals",
          evidence: "Maya Collins writes each one by hand.",
          why: "Proposals queue when Maya Collins is busy.",
          step: "Write proposal",
          type: "spof",
          rating: "risk",
          quotes: [{ source: "Proposal interview", text: "we write every proposal by hand" }],
        }),
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.data.finding).toMatchObject({ status: "proposed", origin: "ai", proposed_via: "connector", title: "Maya Collins is the only one who writes proposals", process: { name: "Sales" }, across_the_company: false, step: { name: "Write proposal" } });
      expect(r.data.finding.rests_on.map((c) => c.kind)).toEqual(["fact", "quote"]);
      expect(r.data.review).toContain("Sales");
      const id = r.data.finding.id;

      const row = await one("select * from findings where id = $1", [id]);
      const maya = (await one("select id from people where workspace_id = $1 and name = 'Maya Collins'", [ids.ws])).id;
      expect(row).toMatchObject({ status: "proposed", origin: "ai", proposed_via: "connector", analysis_id: null, run_id: null, created_by: ids.editor, edited: false, source_ids: [sourceId], person_labels: { "Team member A": maya } });
      expect(row.ai_key).toMatch(/^ai:connector:[0-9a-f]{64}$/);
      expect(row.title).toBe("Team member A is the only one who writes proposals");
      expect(JSON.stringify([row.title, row.evidence, row.why, row.facts])).not.toContain("Maya");

      // The editor reads names, marked as from the connector; a viewer reads "A team member".
      const listed = await call<{ findings: { id: string; title: string; evidence: string; proposed_via: string; status: string }[] }>(mcpEditor, "list_findings", { status: ["proposed", "accepted"] });
      expect(listed.data.findings.find((f) => f.id === id)).toMatchObject({ title: "Maya Collins is the only one who writes proposals", evidence: "Maya Collins writes each one by hand.", proposed_via: "connector", status: "proposed" });
      const asViewer = await call<{ findings: { id: string; title: string; why: string }[] }>(await connect(tokens.viewer, options), "list_findings", { status: ["proposed", "accepted"] });
      const seen = asViewer.data.findings.find((f) => f.id === id)!;
      expect(seen).toMatchObject({ title: "A team member is the only one who writes proposals", why: "Proposals queue when a team member is busy." });
      expect(JSON.stringify(asViewer)).not.toContain("Maya");

      // A person accepts it in the app (the editor's session); the connector then lists it as accepted.
      expect(await setFindingStatus(editor as never, id, "accepted")).toMatchObject({ status: "saved", finding: { status: "accepted", proposed_via: "connector", decided_by: ids.editor } });
      const after = await call<{ findings: { id: string; status: string; proposed_via: string }[] }>(mcpEditor, "list_findings", { status: ["accepted"] });
      expect(after.data.findings.find((f) => f.id === id)).toMatchObject({ status: "accepted", proposed_via: "connector" });
    }, 120_000);

    it("can't be used to skip review: a token straight against PostgREST can neither accept a proposal nor add an accepted finding", async () => {
      const made = await call<Proposed>(mcpEditor, "propose_finding", proposal({ title: "Review can't be skipped" }));
      expect(made.ok, JSON.stringify(made)).toBe(true);
      const id = made.data.finding.id;
      const patch = await raw("PATCH", `/findings?id=eq.${id}`, tokens.editor, { status: "accepted" });
      // PostgREST answers 42501 with 401 for a request whose JWT role is anon (the token's identity is set by the pre-request hook).
      expect([401, 403]).toContain(patch.status);
      expect(await patch.text()).toContain("not over the API");
      const hand = await raw("POST", "/findings", tokens.editor, manual("Added over the API"));
      expect([401, 403]).toContain(hand.status);
      const accepted = await raw("POST", "/findings", tokens.editor, manual("Born accepted", { origin: "ai", status: "accepted", ai_key: "ai:insight:zzzzzzzzzzzz" }));
      expect([401, 403]).toContain(accepted.status);
      expect((await one("select status from findings where id = $1", [id])).status).toBe("proposed");
      expect(Number((await one("select count(*) from findings where workspace_id = $1 and title in ('Added over the API', 'Born accepted')", [ids.ws])).count)).toBe(0);
    }, 60_000);

    it("refuses a viewer, a member and a stranger", async () => {
      const viewer = await call(await connect(tokens.viewer, options), "propose_finding", proposal({ title: "Viewer's idea" }));
      expect(viewer).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const member = await call(await connect(memberToken, options), "propose_finding", proposal({ title: "Member's idea" }));
      expect(member).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const stranger = await call(await connect(strangerWsToken, options), "propose_finding", proposal({ title: "Stranger's idea", workspace: ids.ws }));
      expect(stranger).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(Number((await one("select count(*) from findings where title in ('Viewer''s idea', 'Member''s idea', 'Stranger''s idea')")).count)).toBe(0);
    }, 60_000);

    it("gives clear errors for bad input", async () => {
      const refused = async (args: Record<string, unknown>, code: string) => {
        const r = await call(mcpEditor, "propose_finding", args);
        expect(r, JSON.stringify(args)).toMatchObject({ ok: false, error: { code } });
        return r;
      };
      await refused(proposal({ process: "Nowhere" }), "not_found");
      const unknown = await refused(proposal({ facts: ["capacity:role:no-such-fact"] }), "unknown_fact");
      expect(unknown.error!.message).toContain("capacity:role:no-such-fact");
      // A source of another workspace is no source of this one.
      const theirs = (await one("insert into sources (workspace_id, title) values ($1, 'Theirs') returning id", [ids.other])).id as string;
      await refused(proposal({ sources: [theirs] }), "not_found");
      await refused(proposal({ quotes: [{ source: "Proposal interview", text: "we never write proposals by hand" }] }), "quote_not_found");
      await refused(proposal({ company: true, step: "Write proposal" }), "invalid_input");
      await refused({ process: "Sales", title: "No evidence", rating: "bad", type: "delay" }, "invalid_input");
      await refused(proposal({ title: "Team member B is slow" }), "invalid_input");
      await refused(proposal({ facts_from: "Sales" }), "invalid_input");
      const money = await refused(proposal({ title: "Overtime costs £9,999 a month" }), "money_not_in_facts");
      expect(money.error!.message).toContain("£9,999");
      expect(Number((await one("select count(*) from findings where title in ('No evidence', 'Overtime costs £9,999 a month')")).count)).toBe(0);
    }, 120_000);

    it("refuses more than 30 facts and quotes together instead of dropping some", async () => {
      const keys = Array.from({ length: 30 }, (_, i) => `capacity:role:not-a-real-fact-${i}`);
      const r = await call(mcpEditor, "propose_finding", proposal({ title: "Too many citations", facts: keys, quotes: [{ source: "Proposal interview", text: "we write every proposal by hand" }] }));
      expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(r.error!.message).toContain("at most 30");
      expect(Number((await one("select count(*) from findings where title = 'Too many citations'")).count)).toBe(0);
    }, 60_000);

    it("refuses the same proposal twice, but allows the same words on another place", async () => {
      const first = await call(mcpEditor, "propose_finding", proposal({ title: "Everything waits on one desk" }));
      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(await call(mcpEditor, "propose_finding", proposal({ title: "  everything WAITS on one desk " }))).toMatchObject({ ok: false, error: { code: "duplicate" } });
      // A person dismissed it: Claude can't propose it again (the database's key remembers it).
      await admin.query("update findings set status = 'dismissed' where workspace_id = $1 and title = 'Everything waits on one desk'", [ids.ws]);
      expect(await call(mcpEditor, "propose_finding", proposal({ title: "Everything waits on one desk" }))).toMatchObject({ ok: false, error: { code: "duplicate" } });
      // Not even with a trailing full stop, a no-break space or a different case: the dismissal stands.
      for (const title of ["Everything waits on one desk.", "Everything waits\u00a0on one desk", "EVERYTHING WAITS ON ONE DESK!"]) {
        expect(await call(mcpEditor, "propose_finding", proposal({ title })), title).toMatchObject({ ok: false, error: { code: "duplicate" } });
      }
      const company = await call(mcpEditor, "propose_finding", { company: true, title: "Everything waits on one desk", rating: "bad", type: "delay", facts: [facts[0]!.key] });
      expect(company.ok, JSON.stringify(company)).toBe(true);
    }, 120_000);

    it("states no pay: a proposal citing a fact whose cost depends on a person's pay stores neither the rate nor the editor's figure", async () => {
      const maya = (await one("select id from people where workspace_id = $1 and name = 'Maya Collins'", [ids.ws])).id as string;
      const editorsView = await call<{ facts: Fact[] }>(mcpEditor, "get_facts", { process: "Sales" });
      // The editor sees a cost for a rework, overtime or person-level fact (hours at a person's rate); the fixture must make one.
      const pick = editorsView.data.facts.find((f) => f.cost.per_month !== null && /^(rework:step|overtime:person|capacity:person|spare)/.test(f.key));
      expect(pick, `no pay-dependent fact with a cost in ${JSON.stringify(editorsView.data.facts.map((f) => [f.key, f.cost.per_month]))}`).toBeDefined();
      expect(pick!.cost.per_month!).toBeGreaterThan(0);
      const r = await call<Proposed>(mcpEditor, "propose_finding", { process: "Sales", title: "Rework is costing us", rating: "bad", type: "failure", evidence: `See ${pick!.title}.`, facts: [pick!.key] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.data.finding.rests_on.map((c) => c.key)).toEqual([pick!.key]);
      const stored = (await one("select (title, evidence, why, facts, person_labels)::text as t from findings where id = $1", [r.data.finding.id])).t as string;
      const per = pick!.cost.per_month!;
      for (const figure of [String(per), String(Math.round(per)), Math.round(per).toLocaleString("en-GB"), "913"]) {
        expect(stored, `stored text holds ${figure}`).not.toContain(figure);
        expect(JSON.stringify(r), `response holds ${figure}`).not.toContain(figure);
      }
      expect(maya).toBeTruthy();
    }, 120_000);

    it("proposes a company-wide finding that sits on no process", async () => {
      const r = await call<Proposed>(mcpEditor, "propose_finding", { company: true, title: "The whole company leans on proposals", rating: "risk", type: "idea", facts: [facts[0]!.key] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.data.finding).toMatchObject({ process: null, across_the_company: true, step: null });
      expect(r.data.review).toContain("Overview");
      expect(await one("select process_id, step_id, proposed_via from findings where id = $1", [r.data.finding.id])).toEqual({ process_id: null, step_id: null, proposed_via: "connector" });
      // Cited only by a source, with no facts, on a process.
      const bySource = await call(mcpEditor, "propose_finding", { process: "Sales", title: "Proposals are written by hand", rating: "bad", type: "manual", sources: ["Proposal interview"] });
      expect(bySource.ok, JSON.stringify(bySource)).toBe(true);
    }, 120_000);
  });
});
