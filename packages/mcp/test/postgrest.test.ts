import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  northbeamServicingProcessIds,
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamClientIds,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamScenarios,
  northbeamStepIds,
  toEngineModel,
} from "@transpera-flow/db";
import {
  applyPatches,
  compareHeadline,
  ENGINE_VERSION,
  compareRuns,
  compareTable,
  headlineSubject,
  rankBottlenecks,
  shadowPrice,
  simulate,
} from "@transpera-flow/engine";
import { generateApiToken, TOOL_NAMES, type McpHandlerOptions } from "../src";
import { call, connect, post, signJwt } from "./helpers";

// End to end, as in production: MCP client → handleMcpRequest → supabase-js →
// PostgREST (with the pre-request hook) → Postgres with every migration, RLS
// and the seed. CI prepares the database with test/postgrest-db.ts, then
// starts PostgREST against it (.github/workflows/ci.yml); locally this suite
// is skipped unless POSTGREST_URL is set.

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const SUPABASE_URL = "https://project.supabase.test";

if (process.env.CI && !POSTGREST_URL) throw new Error("CI must run the PostgREST end-to-end suite: set POSTGREST_URL");

let admin: pg.Client;
let options: McpHandlerOptions;
const anonKey = () => signJwt({ role: "anon", iss: "test" }, JWT_SECRET);

/** Route supabase-js's `<url>/rest/v1/...` requests to PostgREST, which serves at its root. */
const toPostgrest: typeof fetch = (input, init) => {
  if (input instanceof Request) throw new Error("expected supabase-js to pass a URL string");
  return fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);
};

async function rest(path: string, headers: Record<string, string>) {
  return fetch(`${POSTGREST_URL}${path}`, { headers: { authorization: `Bearer ${anonKey()}`, ...headers } });
}

async function createUser(email: string, appMetadata: Record<string, unknown> = {}) {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [id, email, appMetadata]);
  return id;
}

async function issueToken(userId: string) {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e')", [userId, hash]);
  return token;
}

let memberToken: string;
let strangerToken: string;
let memberId: string;
let otherWorkspaceId: string;

describe.skipIf(!POSTGREST_URL)("MCP over PostgREST (acts as the user under RLS)", () => {
  beforeAll(async () => {
    // postgrest-db.ts prepared this database before PostgREST started.
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();

    memberId = await createUser("member@example.com");
    const strangerId = await createUser("stranger@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [NORTHBEAM_WORKSPACE_ID, memberId]);
    otherWorkspaceId = (await admin.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherWorkspaceId, strangerId]);
    memberToken = await issueToken(memberId);
    strangerToken = await issueToken(strangerId);

    options = { supabaseUrl: SUPABASE_URL, supabaseKey: anonKey(), fetch: toPostgrest };

    // Wait for PostgREST to connect, load the schema and the hook.
    const deadline = Date.now() + 60_000;
    let last = "";
    for (;;) {
      try {
        const res = await rest("/workspaces?select=id", { "x-api-token": memberToken });
        last = `${res.status} ${await res.text()}`;
        if (res.status === 200 && JSON.parse(last.slice(4)).length === 1) break;
      } catch (err) {
        last = String(err);
      }
      if (Date.now() > deadline) throw new Error(`PostgREST never became ready: ${last}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("lists every tool to an MCP client", async () => {
    const client = await connect(memberToken, options);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });

  it("shows a member their workspace and its process", async () => {
    const client = await connect(memberToken, options);
    const list = await call<{ id: string; slug: string }[]>(client, "list_workspaces");
    expect(list).toMatchObject({ ok: true, assumptions: [] });
    expect(list.data.map((w) => w.id)).toEqual([NORTHBEAM_WORKSPACE_ID]);

    const summary = await call<{ processes: { id: string; live_revision: number }[] }>(client, "get_workspace_summary");
    expect(summary.ok).toBe(true);
    // The pipeline, then its servicing processes (issue #19).
    expect(summary.data.processes.map((p) => p.id)).toEqual([NORTHBEAM_PROCESS_ID, ...Object.values(northbeamServicingProcessIds)]);
    expect(summary.assumptions.join(" ")).toMatch(/only workspace/);

    const process = await call<{ steps: unknown[]; edges: unknown[] }>(client, "get_process", { process: NORTHBEAM_PROCESS_ID });
    expect(process.ok).toBe(true);
    expect(process.data.steps).toHaveLength(12);
    expect(process.data.edges).toHaveLength(14);
    await client.close();
  });

  it("hides the workspace from a token whose user has no membership", async () => {
    const client = await connect(strangerToken, options);
    const list = await call<{ id: string }[]>(client, "list_workspaces");
    expect(list.data.map((w) => w.id)).toEqual([otherWorkspaceId]);

    for (const [tool, args] of [
      ["set_active_workspace", { workspace: NORTHBEAM_WORKSPACE_ID }],
      ["get_workspace_summary", { workspace: "northbeam" }],
      ["get_process", { workspace: NORTHBEAM_WORKSPACE_ID, process: NORTHBEAM_PROCESS_ID }],
      ["run_scenario", { workspace: "Northbeam" }],
    ] as const) {
      const r = await call(client, tool, args);
      expect(r, tool).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    await client.close();

    // Straight at the Data API with the same token: RLS still hides every row.
    for (const table of ["workspaces", "processes", "steps", "edges", "people"]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      const res = await rest(`/${table}?select=${column}&${column}=eq.${NORTHBEAM_WORKSPACE_ID}`, { "x-api-token": strangerToken });
      expect(res.status, table).toBe(200);
      expect(await res.json(), table).toEqual([]);
    }
  });

  it("remembers the active workspace per token", async () => {
    const client = await connect(memberToken, options);
    expect(await call(client, "set_active_workspace", { workspace: "northbeam" })).toMatchObject({ ok: true });
    await client.close();
    const again = await connect(memberToken, options);
    const list = await call<{ id: string; active: boolean }[]>(again, "list_workspaces");
    expect(list.data).toEqual([expect.objectContaining({ id: NORTHBEAM_WORKSPACE_ID, active: true })]);
    const summary = await call(again, "get_workspace_summary");
    expect(summary.assumptions.join(" ")).not.toMatch(/only workspace/);
    await again.close();
  });

  it("shows the company map in the summary and get_process, and refuses to simulate it (B11)", async () => {
    const client = await connect(memberToken, options);
    const summary = await call<{
      processes: { id: string }[];
      company_map: { id: string; name: string; processes: { process_id: string; x: number; y: number }[]; handoffs: { from_process_id: string; to_process_id: string }[] };
    }>(client, "get_workspace_summary");
    expect(summary.ok).toBe(true);
    // The map is not listed as an ordinary process; it holds each of them, and a handoff from the pipeline to each servicing process.
    expect(summary.data.company_map.name).toBe("Company map");
    expect(summary.data.processes.map((p) => p.id)).not.toContain(summary.data.company_map.id);
    expect(summary.data.company_map.processes.map((p) => p.process_id).sort()).toEqual([NORTHBEAM_PROCESS_ID, ...Object.values(northbeamServicingProcessIds)].sort());
    expect(summary.data.company_map.handoffs).toHaveLength(Object.values(northbeamServicingProcessIds).length);

    const map = await call<{ steps: { child_process_id: string | null }[] }>(client, "get_process", { process: summary.data.company_map.id });
    expect(map.ok).toBe(true);
    expect(map.data.steps.map((s) => s.child_process_id).sort()).toEqual([NORTHBEAM_PROCESS_ID, ...Object.values(northbeamServicingProcessIds)].sort());

    const run = await call(client, "run_scenario", { process: summary.data.company_map.id });
    expect(run).toMatchObject({ ok: false, error: { code: "company_map" } });
    expect(run.error!.message).toMatch(/company map/);
    await client.close();
  });

  it("lets an ordinary process be called 'Company map': the name reaches it, the company map only by id (B11)", async () => {
    await admin.query("insert into processes (workspace_id, name) values ($1, 'Company map')", [otherWorkspaceId]);
    const client = await connect(strangerToken, options);
    // The ordinary process has no live revision: that is the answer, not the company map's own (which would be ok).
    const byName = await call(client, "get_process", { process: "Company map", workspace: "other-co" });
    expect(byName).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(byName.error!.message).toMatch(/no live revision/);
    const run = await call(client, "run_scenario", { process: "Company map", workspace: "other-co" });
    expect(run.error?.code).not.toBe("company_map");
    // The company map answers to its id.
    const company = (await admin.query("select id from processes where workspace_id = $1 and is_company", [otherWorkspaceId])).rows[0].id;
    expect(await call(client, "run_scenario", { process: company, workspace: "other-co" })).toMatchObject({ ok: false, error: { code: "company_map" } });
    await client.close();
    await admin.query("delete from processes where workspace_id = $1 and name = 'Company map' and not is_company", [otherWorkspaceId]);
  });

  it("run_scenario returns the browser's numbers for the same model and seed", async () => {
    const startDate = "2026-10-05";
    const client = await connect(memberToken, options);
    const run = await call<{ kpi: unknown; reps: number; seed: number; trace?: unknown }>(client, "run_scenario", {
      start_date: startDate,
    });
    await client.close();
    expect(run.ok).toBe(true);
    expect(run.assumptions).toEqual(expect.arrayContaining(["reps defaulted to 30.", "seed defaulted to 1."]));
    expect(run.data).not.toHaveProperty("trace");
    // The browser: toEngineModel(bundle) in ProcessView, then simulate(model, 30, 1) in the worker.
    const browser = simulate(toEngineModel(northbeamBundle(), { startDate }), 30, 1);
    // This token is a viewer's: the same numbers as the browser, except the overtime cost, which depends on pay and is unavailable (null, not 0).
    expect(run.data.kpi).toEqual({ ...JSON.parse(JSON.stringify(browser.kpi)), overtimeCost: null });
    expect(run.data).toMatchObject({ reps: 30, seed: 1, engine_version: ENGINE_VERSION });
  });

  it("run_scenario applies overrides as the browser applies a scenario, and refuses ones it can't apply", async () => {
    const startDate = "2026-10-05";
    const overrides = northbeamScenarios().find((s) => s.name === "Automate proposals")!.patch;
    const client = await connect(memberToken, options);
    const run = await call<{ kpi: unknown; overrides: unknown }>(client, "run_scenario", { start_date: startDate, overrides });
    const bad = await call(client, "run_scenario", {
      start_date: startDate,
      overrides: [{ path: "steps.gone.work_hours", op: "set", value: 1 }],
    });
    await client.close();
    const browser = simulate(applyPatches(toEngineModel(northbeamBundle(), { startDate }), overrides).model, 30, 1);
    expect(run.ok).toBe(true);
    // This token is a viewer's: the same numbers as the browser, except the overtime cost, which depends on pay and is unavailable (null, not 0).
    expect(run.data.kpi).toEqual({ ...JSON.parse(JSON.stringify(browser.kpi)), overtimeCost: null });
    expect(run.data.overrides).toEqual(overrides);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_overrides" } });
  });

  it("runs of the live model ignore an open draft (issue #9)", async () => {
    const startDate = "2026-10-05";
    const opened = (await admin.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
    try {
      await admin.query("update steps set work_hours = 30 where revision_id = $1", [opened.revision_id]);
      const client = await connect(memberToken, options);
      const live = await call<{ kpi: unknown; revision: { status: string } }>(client, "run_scenario", { start_date: startDate, reps: 5 });
      const draft = await call<{ kpi: unknown; revision: { status: string } }>(client, "run_scenario", {
        start_date: startDate,
        reps: 5,
        revision: "draft",
      });
      const process = await call<{ steps: { work_hours: number }[] }>(client, "get_process", { process: NORTHBEAM_PROCESS_ID });
      await client.close();
      const browser = simulate(toEngineModel(northbeamBundle(), { startDate }), 5, 1);
      expect(live.data.revision.status).toBe("published");
      expect(live.data.kpi).toEqual({ ...JSON.parse(JSON.stringify(browser.kpi)), overtimeCost: null });
      expect(draft.data.revision.status).toBe("draft");
      expect(draft.data.kpi).not.toEqual(live.data.kpi);
      expect(process.data.steps.some((s) => Number(s.work_hours) === 30)).toBe(false);
    } finally {
      await admin.query("select public.discard_draft($1)", [NORTHBEAM_PROCESS_ID]);
    }
  });

  it("serves the draft RPCs to a signed-in editor, as the web app calls them (issue #9)", async () => {
    const editorId = await createUser("draft-editor@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [NORTHBEAM_WORKSPACE_ID, editorId]);
    const session = signJwt({ sub: editorId, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    const rpc = async (fn: string, body: object) => {
      const res = await fetch(`${POSTGREST_URL}/rpc/${fn}`, {
        method: "POST",
        headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, fn).toBe(200);
      return res.json();
    };
    const opened = await rpc("open_draft", { target_process: NORTHBEAM_PROCESS_ID });
    expect(opened).toMatchObject({ status: "ok", created: true });
    expect(await rpc("publish_process", { target_process: NORTHBEAM_PROCESS_ID, accept_estimates: false })).toMatchObject({
      status: "published",
      number: opened.number,
    });
    const audit = await admin.query("select actor_id, diff from audit_log where action = 'publish' and target_id = $1", [NORTHBEAM_PROCESS_ID]);
    expect(audit.rows).toEqual([expect.objectContaining({ actor_id: editorId })]);
    expect(await rpc("discard_draft", { target_process: NORTHBEAM_PROCESS_ID })).toEqual({ status: "no_draft" });
  });

  // --- Analysis tools (issue #26) ---

  it("get_bottlenecks ranks Northbeam's constraints and prices one more strategist", async () => {
    const startDate = "2026-10-05";
    const client = await connect(memberToken, options);
    const r = await call<{
      top: { id: string; name: string; evidence: string };
      roles: { id: string }[];
      steps: { id: string }[];
      shadow_price: { role: { id: string; name: string }; per_quarter: { mean: number; p10: number; p90: number }; complete: boolean; text: string };
      revision: { status: string };
      text: string;
    }>(client, "get_bottlenecks", { start_date: startDate });
    await client.close();
    expect(r.ok).toBe(true);
    const m = toEngineModel(northbeamBundle(), { startDate });
    const run = simulate(m, 30, 1);
    const strat = northbeamRoleIds.strat;
    expect(r.data.revision.status).toBe("published");
    expect(r.data.top).toMatchObject({ id: strat, name: "Strategist" });
    expect(r.data.roles.map((x) => x.id)).toEqual(rankBottlenecks(m, run, { limit: 5 }).roles.map((x) => x.id));
    const sp = shadowPrice(m, strat, { reps: 30, seed: 1 })!;
    expect(r.data.shadow_price).toMatchObject({ role: { id: strat, name: "Strategist" }, per_quarter: sp.perQuarter, complete: true });
    expect(r.data.shadow_price.per_quarter.mean).toBeGreaterThan(0);
    expect(r.data.shadow_price.text).toMatch(/^One more full-time Strategist adds avg [\d.]+ completions a quarter/);
    expect(r.data.text).toContain(r.data.top.evidence);
  });

  it("compare_scenarios returns the app's delta table and headline", async () => {
    const startDate = "2026-10-05";
    const client = await connect(memberToken, options);
    const r = await call<{ headline: string; details: string[]; table: { label: string; baseline: string; change: string; changeRange: string }[] }>(
      client,
      "compare_scenarios",
      { b: "automate proposals", start_date: startDate },
    );
    const missing = await call(client, "compare_scenarios", { b: "Hire a unicorn", start_date: startDate });
    await client.close();
    expect(r.ok).toBe(true);
    expect(r.assumptions).toEqual(expect.arrayContaining(["a defaulted to the baseline (the live model with no scenario applied)."]));
    // The app: the baseline's run and the scenario's run (30 replications, seed
    // 1), compareRuns, compareHeadline with the scenario's name, compareTable.
    const m = toEngineModel(northbeamBundle(), { startDate });
    const s = northbeamScenarios().find((x) => x.name === "Automate proposals")!;
    const comparison = compareRuns(simulate(m, 30, 1), simulate(applyPatches(m, s.patch).model, 30, 1));
    const roleNames = Object.fromEntries(Object.entries(m.roles).map(([id, x]) => [id, x.name]));
    const app = compareHeadline({ comparison, ...headlineSubject([s.name], false), horizonWeeks: m.horizonWeeks, hoursPerWeek: m.hoursPerWeek, currency: "GBP", roleNames });
    const rows = compareTable(comparison, { horizonWeeks: m.horizonWeeks, hoursPerWeek: m.hoursPerWeek, currency: "GBP" });
    expect(r.data.headline).toBe(app.headline);
    expect(r.data.details).toEqual(app.details);
    expect(r.data.table.map((x) => [x.label, x.baseline, x.change, x.changeRange])).toEqual(
      rows.map((x) => [x.label, x.text.baseline, x.text.change, x.text.changeRange]),
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("check_robustness returns a verdict within its time cap, or a partial result flagged as such", async () => {
    const client = await connect(memberToken, options);
    const started = Date.now();
    const r = await call<{ verdict: string; complete: boolean; partial: boolean; screened: number; parameters: number; details: string[] }>(
      client,
      "check_robustness",
      { scenario: "Hire a strategist", time_budget_seconds: 1, start_date: "2026-10-05" },
    );
    const elapsed = Date.now() - started;
    await client.close();
    expect(r.ok).toBe(true);
    expect(r.data.verdict).toMatch(/^Strategist is the bottleneck .*; “Hire a strategist” (adds|costs|makes no difference to) wins in \d+% of cases\.$/);
    expect(r.data.partial).toBe(!r.data.complete);
    if (r.data.partial) expect(r.data.details.join(" ")).toMatch(/Stopped early/);
    // 1 s of perturbations plus the unperturbed runs and the round trips.
    expect(elapsed).toBeLessThan(15_000);
  });

  it("save_scenario and log_issue write as the user: an editor can, a viewer can't", async () => {
    const editorId = await createUser("analysis-editor@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [NORTHBEAM_WORKSPACE_ID, editorId]);
    const editor = await connect(await issueToken(editorId), options);
    const viewer = await connect(memberToken, options);
    const patch = [{ path: `roles.${northbeamRoleIds.strat}.headcount`, op: "add", value: 2 }];

    expect(await call(viewer, "save_scenario", { name: "Two more strategists", overrides: patch })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const saved = await call<{ scenario: { id: string; name: string; patch: unknown } }>(editor, "save_scenario", {
      name: "Two more strategists",
      description: "From Claude",
      overrides: patch,
    });
    expect(saved).toMatchObject({ ok: true, data: { scenario: { name: "Two more strategists", patch } } });
    expect(await call(editor, "save_scenario", { name: "two MORE strategists", overrides: patch })).toMatchObject({
      ok: false,
      error: { code: "name_taken" },
    });
    expect(
      await call(editor, "save_scenario", { name: "Broken", overrides: [{ path: "steps.gone.work_hours", op: "set", value: 1 }] }),
    ).toMatchObject({ ok: false, error: { code: "invalid_overrides" } });
    const stored = await admin.query("select created_by, patch from scenarios where id = $1", [saved.data.scenario.id]);
    expect(stored.rows).toEqual([{ created_by: editorId, patch }]);
    // The saved scenario can be compared straight away, by name.
    const compared = await call<{ headline: string }>(viewer, "compare_scenarios", { b: "Two more strategists", reps: 5, start_date: "2026-10-05" });
    expect(compared.data.headline).toMatch(/^“Two more strategists” /);

    const issue = {
      title: "Proposals wait for the strategist",
      type: "bottleneck",
      rating: "bad",
      step: "audit & proposal",
      person: "Maya Collins",
      owner: "Arjun",
      scenario: "Two more strategists",
      evidence: "Interview 12 Sep: proposals wait up to a week.",
    };
    expect(await call(viewer, "log_issue", issue)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await call(editor, "log_issue", { ...issue, client: "Acme" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call(editor, "log_issue", { ...issue, step: "nowhere" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const logged = await call<{ issue: { id: string; source: string; step: { name: string }; scenario: { id: string } } }>(editor, "log_issue", issue);
    expect(logged.ok).toBe(true);
    expect(logged.data.issue).toMatchObject({ source: "manual", status: "open", step: { name: "Audit & proposal" }, scenario: { id: saved.data.scenario.id } });
    // A client on the roster, by name (issue #18).
    const churn = await call<{ issue: { id: string; client: { id: string; name: string } } }>(editor, "log_issue", {
      title: "Swift Courier may not renew",
      type: "churn_risk",
      client: "swift courier co",
      evidence: "Renewal call due; unhappy with lead volume.",
    });
    expect(churn.ok).toBe(true);
    expect(churn.data.issue.client).toEqual({ id: northbeamClientIds.c12, name: "Swift Courier Co" });
    expect((await admin.query("select client_id from issues where id = $1", [churn.data.issue.id])).rows[0].client_id).toBe(northbeamClientIds.c12);
    const aboutSwift = await call<{ issues: { id: string; client: { name: string } }[]; filters: { client: { name: string } } }>(viewer, "list_issues", {
      client: northbeamClientIds.c12,
    });
    expect(aboutSwift.data.issues.map((i) => i.id)).toEqual([churn.data.issue.id]);
    expect(aboutSwift.data.issues[0]!.client.name).toBe("Swift Courier Co");
    expect(aboutSwift.data.filters.client.name).toBe("Swift Courier Co");
    await admin.query("delete from issues where id = $1", [churn.data.issue.id]);

    const row = (await admin.query("select * from issues where id = $1", [logged.data.issue.id])).rows[0];
    expect(row).toMatchObject({
      process_id: NORTHBEAM_PROCESS_ID,
      step_id: northbeamStepIds.audit,
      person_id: northbeamPersonIds["Maya Collins"],
      scenario_id: saved.data.scenario.id,
      created_by: editorId,
      source: "manual",
    });

    // list_issues shows it to the viewer, with the step and ids; the viewer is linked to no person, so (B1 2a, Q2) the names of
    // the person and owner are hidden, and the editor sees them.
    const list = await call<{ issues: { id: string; step: { name: string }; person: { id: string; name: string | null }; owner: { name: string | null } }[] }>(viewer, "list_issues", {
      type: "bottleneck",
      status: "open",
    });
    expect(list.ok).toBe(true);
    expect(list.data.issues.find((i) => i.id === logged.data.issue.id)).toMatchObject({
      step: { name: "Audit & proposal" },
      person: { id: northbeamPersonIds["Maya Collins"], name: null },
      client: null,
      owner: { name: null },
    });
    const asEditor = await call<{ issues: { id: string; person: { name: string }; owner: { name: string } }[] }>(editor, "list_issues", { type: "bottleneck", status: "open" });
    expect(asEditor.data.issues.find((i) => i.id === logged.data.issue.id)).toMatchObject({ person: { name: "Maya Collins" }, owner: { name: "Arjun Mehta" } });
    const ideas = await call<{ issues: { type: string }[] }>(viewer, "list_issues", { type: "idea" });
    expect(ideas.data.issues.every((i) => i.type === "idea")).toBe(true);
    const withDetected = await call<{ detected: { key: string }[] }>(viewer, "list_issues", { include_detected: true });
    expect(withDetected.ok).toBe(true);
    // The seeded register tracks the audit SPOF, so the run doesn't list it again.
    expect(withDetected.data.detected.map((d) => d.key)).not.toContain(`spof:step:${northbeamStepIds.audit}`);

    await editor.close();
    await viewer.close();
    await admin.query("delete from issues where id = $1", [logged.data.issue.id]);
    await admin.query("delete from scenarios where id = $1", [saved.data.scenario.id]);
  });

  it("hides another workspace from the analysis tools", async () => {
    const client = await connect(strangerToken, options);
    for (const [tool, args] of [
      ["get_bottlenecks", { workspace: NORTHBEAM_WORKSPACE_ID }],
      ["compare_scenarios", { workspace: "northbeam", b: "Hire a strategist" }],
      ["check_robustness", { workspace: "northbeam", scenario: "Hire a strategist" }],
      ["list_issues", { workspace: "northbeam" }],
      ["log_issue", { workspace: "northbeam", title: "x", type: "idea" }],
      ["save_scenario", { workspace: "northbeam", name: "x", overrides: [{ path: "demand.leads_per_week", op: "add", value: 1 }] }],
    ] as const) {
      expect(await call(client, tool, args), tool).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    await client.close();
  });

  it("rejects revoked and unknown tokens with 401", async () => {
    const token = await issueToken(memberId);
    await admin.query("update api_tokens set revoked_at = now() where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [token]);
    expect((await post(options, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await post(options, { authorization: `Bearer ${generateApiToken().token}` })).status).toBe(401);
    // use_api_token's own check, without the header (so without the hook).
    const direct = await fetch(`${POSTGREST_URL}/rpc/use_api_token`, {
      method: "POST",
      headers: { authorization: `Bearer ${anonKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(direct.status).toBe(401);
  });

  it("rate-limits per token", async () => {
    const limited = await issueToken(memberId);
    const other = await issueToken(memberId);
    await admin.query(
      "update api_tokens set rate_window_start = now(), rate_window_count = 120 where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')",
      [limited],
    );
    const res = await post(options, { authorization: `Bearer ${limited}` });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(options, { authorization: `Bearer ${other}` })).status).toBe(200);
  });

  it("leaves signed-in and anonymous Data API requests as they were", async () => {
    const session = signJwt({ sub: memberId, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    const signedIn = await fetch(`${POSTGREST_URL}/workspaces?select=id`, { headers: { authorization: `Bearer ${session}` } });
    expect(await signedIn.json()).toEqual([{ id: NORTHBEAM_WORKSPACE_ID }]);

    const anon = await rest("/workspaces?select=id", {});
    expect(anon.status).not.toBe(200);

    const both = await fetch(`${POSTGREST_URL}/workspaces?select=id`, {
      headers: { authorization: `Bearer ${session}`, "x-api-token": strangerToken },
    });
    expect(both.status).toBe(400);
  });
});
