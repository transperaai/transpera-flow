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
import { changesFromPatch } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { generateApiToken, hashApiToken, TOOL_NAMES, type McpHandlerOptions } from "../src";
import { call, connect, createUser, issueToken as issue, post, startTestDb, userClaims, type McpTestDb } from "./helpers";

// End to end, as in production: MCP client → handleMcpRequest → token lookup in app code → Kysely with the token owner's claims →
// Postgres with every migration, RLS and the seed. Each run builds a throwaway database (test/helpers.ts); no PostgREST.

let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;

const issueToken = (userId: string) => issue(admin, userId);

let memberToken: string;
let strangerToken: string;
let memberId: string;
let strangerId: string;
let otherWorkspaceId: string;

/** What a viewer's token never gets, whatever the browser would show an Agency admin: every figure that depends on individual pay. */
const HIDDEN_COSTS = { overtimeCost: null, labourCost: null, profit: null };

describe("MCP over the database (acts as the user under RLS)", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    options = env.options;

    memberId = await createUser(admin, "member@example.com");
    strangerId = await createUser(admin, "stranger@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [NORTHBEAM_WORKSPACE_ID, memberId]);
    otherWorkspaceId = (await admin.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherWorkspaceId, strangerId]);
    memberToken = await issueToken(memberId);
    strangerToken = await issueToken(strangerId);
  });

  afterAll(async () => {
    await env?.close();
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

    // Straight at the database as the same user: RLS still hides every row.
    const asStranger = env.dbAs(userClaims(strangerId));
    expect(await asStranger.selectFrom("workspaces").select("id").where("id", "=", NORTHBEAM_WORKSPACE_ID).execute()).toEqual([]);
    for (const table of ["processes", "steps", "edges", "people"] as const) {
      expect(await asStranger.selectFrom(table).select("workspace_id").where("workspace_id", "=", NORTHBEAM_WORKSPACE_ID).execute(), table).toEqual([]);
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
    // This token is a viewer's: the same numbers as the browser, except the costs that depend on pay (overtime cost, labour cost and profit), which are unavailable (null, not 0).
    expect(run.data.kpi).toEqual({ ...JSON.parse(JSON.stringify(browser.kpi)), ...HIDDEN_COSTS });
    expect(run.data).toMatchObject({ reps: 30, seed: 1, engine_version: ENGINE_VERSION });
    // Profit first (engine 1.11.0): revenue and overheads come through, the costs and profit are null for a viewer's token.
    const kpi = run.data.kpi as { revenue: { mean: number }; overheads: number; overtimeCost: null; labourCost: null; profit: null };
    expect(kpi.revenue.mean).toBeGreaterThan(0);
    expect(kpi.overheads).toBe(0);
    expect([kpi.overtimeCost, kpi.labourCost, kpi.profit]).toEqual([null, null, null]);
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
    // This token is a viewer's: the same numbers as the browser, except the costs that depend on pay (overtime cost, labour cost and profit), which are unavailable (null, not 0).
    expect(run.data.kpi).toEqual({ ...JSON.parse(JSON.stringify(browser.kpi)), ...HIDDEN_COSTS });
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
      expect(live.data.kpi).toEqual({ ...JSON.parse(JSON.stringify(browser.kpi)), ...HIDDEN_COSTS });
      expect(draft.data.revision.status).toBe("draft");
      expect(draft.data.kpi).not.toEqual(live.data.kpi);
      expect(process.data.steps.some((s) => Number(s.work_hours) === 30)).toBe(false);
    } finally {
      await admin.query("select public.discard_draft($1)", [NORTHBEAM_PROCESS_ID]);
    }
  });

  it("serves the draft RPCs to a signed-in editor, as the web app calls them (issue #9)", async () => {
    const editorId = await createUser(admin, "draft-editor@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, editorId]);
    const editorDb = env.dbAs(userClaims(editorId));
    // As the web app calls them: named arguments, the function's own JSON back.
    const call_ = async (fn: "open_draft" | "publish_process" | "discard_draft", body: Record<string, unknown>) =>
      (await rpc(editorDb, fn, body as never)) as Record<string, unknown>;
    const opened = await call_("open_draft", { target_process: NORTHBEAM_PROCESS_ID });
    expect(opened).toMatchObject({ status: "ok", created: true });
    expect(await call_("publish_process", { target_process: NORTHBEAM_PROCESS_ID, accept_estimates: false })).toMatchObject({
      status: "published",
      number: opened.number,
    });
    const audit = await admin.query("select actor_id, diff from audit_log where action = 'publish' and target_id = $1", [NORTHBEAM_PROCESS_ID]);
    expect(audit.rows).toEqual([expect.objectContaining({ actor_id: editorId })]);
    expect(await call_("discard_draft", { target_process: NORTHBEAM_PROCESS_ID })).toEqual({ status: "no_draft" });
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

  it("is read-only: no tool saves a scenario or logs an issue, and what the app saved is read back (compared by name, listed with names hidden from a viewer)", async () => {
    const editorId = await createUser(admin, "analysis-editor@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, editorId]);
    const editor = await connect(await issueToken(editorId), options);
    const viewer = await connect(memberToken, options);
    const patch = [{ path: `roles.${northbeamRoleIds.strat}.headcount`, op: "add" as const, value: 2 }];

    // No write tool exists for anyone: not even an editor's token can save a scenario or log an issue.
    for (const client of [editor, viewer]) {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const gone of ["save_scenario", "log_issue", "propose_issue", "propose_finding", "set_company", "upsert_person", "add_source", "import_process", "publish_process"]) expect(names).not.toContain(gone);
      expect(await client.callTool({ name: "save_scenario", arguments: { name: "Nope", overrides: patch } }).then((r) => r.isError, () => true)).toBe(true);
    }

    // A scenario and issues the app saved (made here as the database's owner).
    const scenario = (await admin.query("insert into sandbox_scenarios (workspace_id, name, description, changes, created_by) values ($1, 'Two more strategists', 'From the app', $2, $3) returning id", [NORTHBEAM_WORKSPACE_ID, JSON.stringify(changesFromPatch(patch)), editorId])).rows[0].id as string;
    // The saved scenario can be compared straight away, by name.
    const compared = await call<{ headline: string }>(viewer, "compare_scenarios", { b: "Two more strategists", reps: 5, start_date: "2026-10-05" });
    expect(compared.data.headline).toMatch(/^“Two more strategists” /);

    const logged = (
      await admin.query(
        `insert into issues (workspace_id, title, type, severity, source, status, process_id, step_id, person_id, owner_person_id, scenario_id, evidence, created_by)
         values ($1, 'Proposals wait for the strategist', 'bottleneck', 'serious', 'manual', 'open', $2, $3, $4, $5, $6, 'Interview 12 Sep: proposals wait up to a week.', $7) returning id`,
        [NORTHBEAM_WORKSPACE_ID, NORTHBEAM_PROCESS_ID, northbeamStepIds.audit, northbeamPersonIds["Maya Collins"], northbeamPersonIds["Arjun Mehta"], scenario, editorId],
      )
    ).rows[0].id as string;
    // A client on the roster, by id (issue #18).
    const churn = (
      await admin.query(
        "insert into issues (workspace_id, title, type, severity, source, status, client_id, evidence) values ($1, 'Swift Courier may not renew', 'churn_risk', 'serious', 'manual', 'open', $2, 'Renewal call due; unhappy with lead volume.') returning id",
        [NORTHBEAM_WORKSPACE_ID, northbeamClientIds.c12],
      )
    ).rows[0].id as string;
    const aboutSwift = await call<{ issues: { id: string; client: { name: string } }[]; filters: { client: { name: string } } }>(viewer, "list_issues", {
      client: northbeamClientIds.c12,
    });
    expect(aboutSwift.data.issues.map((i) => i.id)).toEqual([churn]);
    expect(aboutSwift.data.issues[0]!.client.name).toBe("Swift Courier Co");
    expect(aboutSwift.data.filters.client.name).toBe("Swift Courier Co");
    await admin.query("delete from issues where id = $1", [churn]);

    // list_issues shows it to the viewer, with the step and ids; the viewer is linked to no person, so (B1 2a, Q2) the names of
    // the person and owner are hidden, and the editor sees them.
    const list = await call<{ issues: { id: string; step: { name: string }; person: { id: string; name: string | null }; owner: { name: string | null } }[] }>(viewer, "list_issues", {
      type: "bottleneck",
      status: "open",
    });
    expect(list.ok).toBe(true);
    expect(list.data.issues.find((i) => i.id === logged)).toMatchObject({
      step: { name: "Audit & proposal" },
      person: { id: northbeamPersonIds["Maya Collins"], name: null },
      client: null,
      owner: { name: null },
    });
    const asEditor = await call<{ issues: { id: string; person: { name: string }; owner: { name: string } }[] }>(editor, "list_issues", { type: "bottleneck", status: "open" });
    expect(asEditor.data.issues.find((i) => i.id === logged)).toMatchObject({ person: { name: "Maya Collins" }, owner: { name: "Arjun Mehta" } });
    const ideas = await call<{ issues: { type: string }[] }>(viewer, "list_issues", { type: "idea" });
    expect(ideas.data.issues.every((i) => i.type === "idea")).toBe(true);
    const withDetected = await call<{ detected: { key: string }[] }>(viewer, "list_issues", { include_detected: true });
    expect(withDetected.ok).toBe(true);
    // The seeded register tracks the audit SPOF, so the run doesn't list it again.
    expect(withDetected.data.detected.map((d) => d.key)).not.toContain(`spof:step:${northbeamStepIds.audit}`);

    await editor.close();
    await viewer.close();
    await admin.query("delete from issues where id = $1", [logged]);
    await admin.query("delete from sandbox_scenarios where id = $1", [scenario]);
  });

  it("hides another workspace from the analysis tools", async () => {
    const client = await connect(strangerToken, options);
    for (const [tool, args] of [
      ["get_bottlenecks", { workspace: NORTHBEAM_WORKSPACE_ID }],
      ["compare_scenarios", { workspace: "northbeam", b: "Hire a strategist" }],
      ["check_robustness", { workspace: "northbeam", scenario: "Hire a strategist" }],
      ["list_issues", { workspace: "northbeam" }],
      ["get_facts", { workspace: "northbeam" }],
      ["list_solutions", { workspace: "northbeam" }],
    ] as const) {
      expect(await call(client, tool, args), tool).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    await client.close();
  });

  it("rejects revoked and unknown tokens with 401", async () => {
    const token = await issueToken(memberId);
    await admin.query("update api_tokens set revoked_at = now() where token_hash = $1", [hashApiToken(token)]);
    expect((await post(options, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await post(options, { authorization: `Bearer ${generateApiToken().token}` })).status).toBe(401);
    // The lookup itself, as `anon`: nothing for a revoked token.
    await admin.query("begin");
    try {
      await admin.query("set local role anon");
      expect((await admin.query("select * from public.mcp_token_lookup($1)", [hashApiToken(token)])).rows).toEqual([]);
    } finally {
      await admin.query("rollback");
    }
  });

  it("rate-limits per token", async () => {
    const limited = await issueToken(memberId);
    const other = await issueToken(memberId);
    await admin.query(
      "update api_tokens set rate_window_start = now(), rate_window_count = 120 where token_hash = $1",
      [hashApiToken(limited)],
    );
    const res = await post(options, { authorization: `Bearer ${limited}` });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(options, { authorization: `Bearer ${other}` })).status).toBe(200);
  });

  it("leaves signed-in and anonymous callers as they were", async () => {
    const signedIn = await env.dbAs(userClaims(memberId)).selectFrom("workspaces").select("id").execute();
    expect(signedIn).toEqual([{ id: NORTHBEAM_WORKSPACE_ID }]);

    // Signed out (role anon): no workspaces, whether the database refuses the table or RLS hides the rows.
    const anon = await env.dbAs(null).selectFrom("workspaces").select("id").execute().catch(() => [] as unknown[]);
    expect(anon).toEqual([]);
    // There is no "session and token together" request any more (it was refused with 400 at the Data API): a token only
    // ever reaches the database through the endpoint, which takes it from the Authorization header alone.
  });
});
