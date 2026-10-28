import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import type { Db } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { call, connect, errorOf, startTestDb, tokenDbFor, userClaims, type McpTestDb } from "./helpers";

// The company-model suggestion tools end to end (issue #25), as in production:
// MCP client → handleMcpRequest → token lookup in app code → Kysely under the
// token owner's claims → Postgres with every migration. Runs on a throwaway database (test/helpers.ts), in its own workspace.


let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;

const ids = { ws: "", role: "", other: "", person: "", service: "", client: "", lead: "", source: "", editor: "", viewer: "" };
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

/** Every company-model row of the workspace, to show the tools changed none of them. */
async function companyRows() {
  const out: Record<string, unknown> = {};
  for (const t of ["people", "person_roles", "person_leave", "services", "roles", "clients", "client_services", "client_assignments", "lead_sources", "seasonality", "demand_settings"]) {
    out[t] = (await admin.query(`select to_jsonb(t) as r from ${t} t where workspace_id = $1 order by to_jsonb(t)::text`, [ids.ws])).rows.map((r) => r.r);
  }
  out.workspace = (await admin.query("select settings, provenance from workspaces where id = $1", [ids.ws])).rows[0];
  return out;
}

describe("company-model suggestion tools", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;

    const slug = `suggest-co-${randomUUID().slice(0, 8)}`;
    ids.ws = await insertId("insert into workspaces (name, slug, settings) values ('Suggest Co', $1, $2) returning id", [
      slug,
      { hours_per_week: 40, currency: "GBP", horizon_weeks: 13, leads_per_week: 5, active_clients: 0, churn_monthly: 0, retainer: 0 },
    ]);
    ids.role = await insertId("insert into roles (workspace_id, name) values ($1, 'Designer') returning id", [ids.ws]);
    ids.other = await insertId("insert into roles (workspace_id, name) values ($1, 'Account manager') returning id", [ids.ws]);
    ids.person = await insertId("insert into people (workspace_id, name, fte) values ($1, 'Ana Lopez', 1) returning id", [ids.ws]);
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [ids.person, ids.role, ids.ws]);
    ids.service = await insertId("insert into services (workspace_id, name, price) values ($1, 'Branding', 2000) returning id", [ids.ws]);
    ids.client = await insertId("insert into clients (workspace_id, name, mrr) values ($1, 'Acme Ltd', 2000) returning id", [ids.ws]);
    await admin.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [ids.client, ids.service, ids.ws]);
    ids.lead = await insertId("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Website', 5) returning id", [ids.ws]);
    ids.source = await insertId("insert into sources (workspace_id, title, speakers) values ($1, 'Founder interview', '{Ana Lopez}') returning id", [ids.ws]);

    ids.editor = await createUser(`suggest-editor-${slug}@example.com`);
    ids.viewer = await createUser(`suggest-viewer-${slug}@example.com`);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ids.ws, ids.editor, ids.viewer]);
    editorToken = await issueToken(ids.editor);
    viewerToken = await issueToken(ids.viewer);
    options = env.options;

  });

  afterAll(async () => {
    await env?.close();
  });

  it("each company tool creates suggestions and changes no live data", async () => {
    const before = await companyRows();
    const client = await connect(editorToken, options);
    const evidence = [{ source_id: ids.source, speaker: "Ana Lopez", quote: "the website brings in nine a week now", timestamp: "00:04:12", value: 9 }];
    type Made = { suggestions: { id: string; target_table: string; headline: string; status: string }[]; unchanged: string[] };

    const calls: [string, Record<string, unknown>, number][] = [
      ["set_company", { hours_per_week: 37.5, overtime_cap: 0.1, note: "Stated in the interview" }, 1],
      ["upsert_service", { name: "Branding", price: 2400 }, 1],
      ["upsert_service", { name: "Web design", price: 5000, pricing_model: "one_off" }, 1],
      ["upsert_role", { name: "Copywriter", evidence, note: "Ana describes a copywriter" }, 1],
      ["upsert_person", { name: "Ana Lopez", fte: 0.8, roles: ["Designer", "Account manager"], leave: [{ start_date: "2026-12-21", end_date: "2026-12-31" }] }, 1],
      ["upsert_person", { name: "Ben Carter", roles: ["Designer"], cost_rate: 35 }, 1],
      ["upsert_client", { name: "Acme Ltd", mrr: 2500, assignments: { Designer: "Ana Lopez" }, evidence }, 1],
      ["upsert_client", { name: "Bolt Cafe", services: ["Branding"], mrr: 1800 }, 1],
      ["set_demand", { lead_sources: [{ name: "Website", volume_week: 9 }, { name: "Referrals", volume_week: 2 }], seasonality: [{ month: 8, multiplier: 0.7 }], growth_monthly: 0.01, evidence }, 4],
    ];
    const made: Made["suggestions"] = [];
    for (const [tool, args, n] of calls) {
      const r = await call<Made>(client, tool, args);
      expect(r, `${tool} ${JSON.stringify(r.error)}`).toMatchObject({ ok: true });
      expect(r.data.suggestions, tool).toHaveLength(n);
      expect(r.data.suggestions.every((s) => s.status === "pending"), tool).toBe(true);
      made.push(...r.data.suggestions);
    }
    expect(made.find((s) => s.target_table === "lead_sources")!.headline).toBe(
      "Claude suggests lead volume 9/wk for Website, was 5/wk, citing “the website brings in nine a week now” (Ana Lopez)",
    );

    // Nothing live changed; the suggestions are stored, by the editor, as pending.
    expect(await companyRows()).toEqual(before);
    const stored = (await admin.query("select status, created_by, created_via from suggestions where workspace_id = $1", [ids.ws])).rows;
    expect(stored).toHaveLength(made.length);
    expect(stored.every((s) => s.status === "pending" && s.created_by === ids.editor && s.created_via === "mcp")).toBe(true);
    const audit = (await admin.query("select actor_kind, action from audit_log where workspace_id = $1 and target_table = 'suggestions'", [ids.ws])).rows;
    expect(audit).toHaveLength(made.length);
    expect(audit.every((a) => a.actor_kind === "mcp" && a.action === "insert")).toBe(true);

    // A value the model already has is not suggested again.
    const same = await call<Made>(client, "upsert_service", { name: "Branding", price: 2000 });
    expect(same.data).toMatchObject({ suggestions: [], unchanged: ["Service Branding: price is already 2000"] });

    const listed = await call<{ suggestions: { id: string; headline: string; status: string }[] }>(client, "list_suggestions", { status: "pending" });
    expect(listed.ok).toBe(true);
    expect(listed.data.suggestions.map((s) => s.id).sort()).toEqual(made.map((s) => s.id).sort());
    await client.close();
  });

  it("a suggested role is created only when accepted, and then a process can use it", async () => {
    const editor = await connect(editorToken, options);
    // "Design" partly matches "Designer": the tool asks rather than guessing.
    expect(await call(editor, "upsert_role", { name: "Design" })).toMatchObject({ ok: false, error: { code: "ambiguous" } });
    const viewer = await connect(viewerToken, options);
    expect(await call(viewer, "upsert_role", { name: "Illustrator" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await viewer.close();

    // The token can't write roles directly either.
    const asToken = (await tokenDbFor(env, ids.editor)).db;
    const direct = await errorOf(() => asToken.insertInto("roles").values({ workspace_id: ids.ws, name: "Sneaky" }).execute());
    expect(direct?.code).toBe("42501");
    expect(direct?.message).toMatch(/only by review/);

    // A step naming a role that isn't there yet can't be imported.
    const process_json = {
      name: "Copywriting",
      kind: "servicing",
      entity_name: "job",
      steps: [
        { name: "Start", kind: "start" },
        { name: "Write copy", role: "Copywriter" },
        { name: "Done", kind: "end", outcome: "done" },
      ],
      edges: [
        { from: "Start", to: "Write copy" },
        { from: "Write copy", to: "Done" },
      ],
    };
    const before = await call(editor, "import_process", { process_json });
    expect(before.ok, JSON.stringify(before)).toBe(false);
    expect(before.error).toMatchObject({ code: "not_found", message: expect.stringMatching(/No role .* matches .Copywriter./) });
    // It checks before it writes: no process (or draft) is left behind.
    expect((await admin.query("select count(*)::int as n from processes where workspace_id = $1 and not is_company", [ids.ws])).rows[0].n).toBe(0);

    const rows = (await admin.query("select id from suggestions where workspace_id = $1 and target_table = 'roles' and status = 'pending'", [ids.ws])).rows;
    expect(rows).toHaveLength(1);
    const res = await rpc(env.dbAs(userClaims(ids.editor)), "review_suggestions", { ids: [rows[0].id], decision: "accept" });
    expect(res).toMatchObject([{ id: rows[0].id, status: "accepted" }]);
    const role = (await admin.query("select id, active from roles where workspace_id = $1 and name = 'Copywriter'", [ids.ws])).rows[0];
    expect(role.active).toBe(true);

    const summary = await call<{ roles: { id: string; name: string; active: boolean }[] }>(editor, "get_workspace_summary", {});
    expect(summary.data.roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: role.id, name: "Copywriter", active: true })]));
    const after = await call(editor, "import_process", { process_json });
    expect(after.ok, JSON.stringify(after)).toBe(true);
    const step = (await admin.query("select role_id from steps where workspace_id = $1 and name = 'Write copy'", [ids.ws])).rows[0];
    expect(step.role_id).toBe(role.id);
    await editor.close();
  });

  it("refuses a viewer's token, an unknown source and an ambiguous name", async () => {
    const viewer = await connect(viewerToken, options);
    expect(await call(viewer, "upsert_service", { name: "Branding", price: 2600 })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await viewer.close();
    const editor = await connect(editorToken, options);
    const bad = [{ source_id: randomUUID(), quote: "made up" }];
    expect(await call(editor, "set_demand", { growth_monthly: 0.03, evidence: bad })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call(editor, "upsert_person", { name: "Ana", fte: 0.5 })).toMatchObject({ ok: false, error: { code: "ambiguous" } });
    await editor.close();
  });

  it("an API token can't write the company model or review suggestions directly", async () => {
    const asToken = (await tokenDbFor(env, ids.editor)).db;
    const patch = await errorOf(() => asToken.updateTable("people").set({ fte: 0.5 }).where("id", "=", ids.person).execute());
    expect(patch?.code).toBe("42501");
    expect(patch?.message).toMatch(/only by review/);
    const [pending] = (await admin.query("select id from suggestions where workspace_id = $1 and status = 'pending' limit 1", [ids.ws])).rows;
    const review = await errorOf(() => rpc(asToken, "review_suggestions", { ids: [pending.id], decision: "accept" }));
    expect(review?.code).toBe("42501");
    expect(review?.message).toMatch(/reviewed by a person/);
    expect((await admin.query("select fte::float8 from people where id = $1", [ids.person])).rows[0].fte).toBe(1);
  });

  it("a signed-in editor accepts and rejects through the database, as the app does", async () => {
    const editorDb: Db = env.dbAs(userClaims(ids.editor));
    const review = async (body: { ids: string[]; decision: string; note?: string }) => rpc(editorDb, "review_suggestions", body);
    const lead = (await admin.query("select id from suggestions where workspace_id = $1 and target_id = $2", [ids.ws, ids.lead])).rows[0].id;
    const company = (await admin.query("select id from suggestions where workspace_id = $1 and target_table = 'workspaces'", [ids.ws])).rows[0].id;
    expect(await review({ ids: [lead], decision: "accept" })).toMatchObject([{ id: lead, status: "accepted" }]);
    const row = (await admin.query("select volume_week::float8 as v, provenance from lead_sources where id = $1", [ids.lead])).rows[0];
    expect(row.v).toBe(9);
    expect(row.provenance.volume_week).toMatchObject({ source: "estimated", by: ids.editor, suggestion_id: lead, evidence: [{ quote: "the website brings in nine a week now" }] });
    // Company settings need an Agency admin (editors and owners are one role since migration 20270103000000): this accept works.
    expect(await review({ ids: [company], decision: "accept" })).toMatchObject([{ id: company, status: "accepted" }]);
    const audit = (
      await admin.query("select actor_kind, action, diff -> 'suggestion_id' as sid from audit_log where workspace_id = $1 and target_table = 'lead_sources'", [ids.ws])
    ).rows;
    expect(audit).toEqual([{ actor_kind: "user", action: "update", sid: lead }]);
  });
});
