import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_COLUMNS } from "@transpera-flow/db";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { readRun, substitute, type Run } from "./extraction-fixtures";
import { call, connect, signJwt } from "./helpers";

// The extraction skill's dry run end to end (issue #27): the recorded tool
// calls of .agents/skills/extract-process/SKILL.md on the invented Tidewater
// Digital interviews (docs/extraction/examples/tidewater), replayed as in
// production: MCP client → handleMcpRequest → supabase-js → PostgREST with the
// pre-request hook → Postgres with every migration and RLS. Runs in a
// workspace of its own beside the other PostgREST suites, and is skipped
// unless POSTGREST_URL is set (see postgrest.test.ts). Set
// EXTRACTION_RESPONSES_FILE to keep the observed responses (the summaries in
// the example folder are written from them).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const SUPABASE_URL = "https://project.supabase.test";

type Row = Record<string, unknown>;
type Result = { tool: string; ok: boolean; data: any; assumptions: string[]; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

let admin: pg.Client;
let options: McpHandlerOptions;
let workspaceId = "";
let editorToken = "";
const anonKey = () => signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
const toPostgrest: typeof fetch = (input, init) => fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);
const insertId = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
const observed: Record<string, Result[]> = {};

/** Replay a recorded run as the token's user, keeping saved source ids for later calls. */
async function replay(client: Client, name: string, run: Run): Promise<Result[]> {
  const saved: Record<string, string> = {};
  const results: Result[] = [];
  for (const c of run.calls) {
    const r = await call(client, c.tool, substitute(c.arguments, saved));
    results.push({ tool: c.tool, ...r } as Result);
    // A servicing process alone can't be simulated (it runs beside a pipeline): the skill notes that and moves on.
    const expected = c.tool === "run_scenario" && r.error?.code === "invalid_model";
    expect(r.ok || expected, `${name}: ${c.tool} ${JSON.stringify(r.error)}`).toBe(true);
    if (c.save) saved[c.save] = (r.data as { source: { id: string } }).source.id;
  }
  observed[name] = results;
  return results;
}

/** Every company-model row of the workspace, to show the tools changed none of them. */
async function companyRows() {
  const out: Record<string, unknown> = {};
  for (const t of ["people", "person_roles", "person_leave", "services", "clients", "client_services", "client_assignments", "lead_sources", "seasonality", "demand_settings"]) {
    out[t] = (await admin.query(`select to_jsonb(t) as r from ${t} t where workspace_id = $1 order by to_jsonb(t)::text`, [workspaceId])).rows.map((r) => r.r);
  }
  out.workspace = (await admin.query("select settings, provenance from workspaces where id = $1", [workspaceId])).rows[0];
  return out;
}

async function processes() {
  return (await admin.query("select * from processes where workspace_id = $1 and not is_company", [workspaceId])).rows as (Row & { id: string; live_revision_id: string | null; draft_revision_id: string | null })[];
}

async function stepsOf(revisionId: string) {
  return (await admin.query("select * from steps where revision_id = $1 order by name", [revisionId])).rows as (Row & { id: string; name: string; provenance: Record<string, Row> })[];
}

async function snapshot(revisionId: string) {
  const steps = (await admin.query("select * from steps where revision_id = $1 order by id", [revisionId])).rows;
  const edges = (await admin.query("select * from edges where revision_id = $1 order by id", [revisionId])).rows;
  return { steps, edges };
}

const pending = async () => Number((await admin.query("select count(*) as n from suggestions where workspace_id = $1 and status = 'pending'", [workspaceId])).rows[0].n);

describe.skipIf(!POSTGREST_URL)("extraction dry run (Tidewater Digital) over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();

    // The preconditions of docs/extraction/examples/tidewater/README.md.
    const slug = `tidewater-${randomUUID().slice(0, 8)}`;
    workspaceId = await insertId("insert into workspaces (name, slug, settings) values ('Tidewater Digital', $1, $2) returning id", [
      slug,
      { hours_per_week: 40, currency: "GBP", horizon_weeks: 13, leads_per_week: 0, active_clients: 0, churn_monthly: 0, retainer: 0 },
    ]);
    const role = (name: string) => insertId("insert into roles (workspace_id, name) values ($1, $2) returning id", [workspaceId, name]);
    const [am, seo, director] = [await role("Account manager"), await role("SEO specialist"), await role("Director")];
    const person = async (name: string, roleId: string, fte = 1) => {
      const id = await insertId("insert into people (workspace_id, name, fte) values ($1, $2, $3) returning id", [workspaceId, name, fte]);
      await admin.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [id, roleId, workspaceId]);
      return id;
    };
    await person("Hana Iqbal", am);
    await person("Owen Hart", seo);
    await person("Priti Rao", seo, 1);
    await person("Callum Reid", director);
    const retainer = await insertId("insert into services (workspace_id, name, price) values ($1, 'SEO retainer', 2500) returning id", [workspaceId]);
    await insertId("insert into services (workspace_id, name, price) values ($1, 'Content add-on', 400) returning id", [workspaceId]);
    const marlow = await insertId("insert into clients (workspace_id, name, mrr) values ($1, 'Marlow Physio', 2500) returning id", [workspaceId]);
    await admin.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [marlow, retainer, workspaceId]);
    await insertId("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Referrals', 2) returning id", [workspaceId]);

    // An editor with an API token, and no email address: the test needs none.
    const editorId = randomUUID();
    await admin.query("insert into auth.users (id) values ($1)", [editorId]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [workspaceId, editorId]);
    const { token, hash } = generateApiToken();
    await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e')", [editorId, hash]);
    editorToken = token;
    options = { supabaseUrl: SUPABASE_URL, supabaseKey: anonKey(), fetch: toPostgrest };

    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await fetch(`${POSTGREST_URL}/workspaces?select=id`, { headers: { authorization: `Bearer ${anonKey()}`, "x-api-token": editorToken } }).catch(() => null);
      if (res?.status === 200 && ((await res.json()) as unknown[]).length === 1) break;
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (process.env.EXTRACTION_RESPONSES_FILE) writeFileSync(process.env.EXTRACTION_RESPONSES_FILE, JSON.stringify(observed, null, 2));
    await admin?.end();
  });

  let liveBefore: Awaited<ReturnType<typeof snapshot>>;

  it("interview 1 becomes a new draft with every number cited or reasoned, and suggestions only for the company facts", async () => {
    const company = await companyRows();
    const client = await connect(editorToken, options);
    const results = await replay(client, "run-1", readRun("run-1.json"));

    const imported = results.find((r) => r.tool === "import_process")!;
    expect(imported.data).toMatchObject({ created: true, warnings: [], conflicts: [], not_overwritten: [] });
    expect(imported.data.diff.text).toMatch(/^New process: 7 steps added/);
    // Server defaults are what the skill exists to avoid: none of them, and every assumption reasoned.
    expect(imported.assumptions.filter((a) => /defaulted to .* \(estimated; confirm it on the canvas\)/.test(a))).toEqual([]);
    const items = imported.data.checklist as { kind: string; step: { name: string }; field: string; evidence: unknown[]; reasoning: string | null }[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      if (i.evidence.length) continue;
      expect(i.reasoning, `${i.step.name} ${i.field}`).toBeTruthy();
      expect(i.reasoning).not.toMatch(/^(Server default|Given without a cited source)/);
    }

    const [proc] = await processes();
    expect(proc).toMatchObject({ name: "Monthly client report", kind: "servicing", entity_name: "report", live_revision_id: null });
    const steps = await stepsOf(proc!.draft_revision_id!);
    expect(steps.map((s) => s.name)).toEqual(["Director review", "Follow-up call", "Month end", "Pull ranking data", "Report sent", "Send report", "Write commentary"]);
    const step = (name: string) => steps.find((s) => s.name === name)!;
    // The symmetric hedge kept its range (the citation states the midpoint, so the value did not turn plain).
    expect(step("Write commentary")).toMatchObject({ work_dist: "triangular", work_hours: "2.5", current_wip: 4, conflict: false });
    expect(step("Write commentary").work_params).toEqual({ min: 2, mode: 2.5, max: 3 });
    expect(step("Director review")).toMatchObject({ work_hours: "0.5", rework_rate: "0.2", rework_to_step_id: step("Write commentary").id });
    expect(step("Send report").notes).toMatch(/one in ten has questions/);
    for (const s of steps) {
      for (const column of EVIDENCE_COLUMNS) {
        const entry = s.provenance[column] as { evidence?: unknown[]; note?: string } | undefined;
        if (entry) expect(Boolean(entry.evidence?.length) || Boolean(entry.note), `${s.name} ${column}`).toBe(true);
      }
    }

    // First principles went into the draft from the transcript, cited or assumed, with every name placed. Nothing is nested:
    // the report's steps are lists of small actions with one stated time each, so none is split into a group.
    const principles = results.find((r) => r.tool === "update_first_principles")!;
    expect(principles.data.warnings).toEqual([]);
    expect(principles.data.filled).toMatchObject({ job: true, truths: true, reqs: true, saa: true, del: false, why: false, measures: true });
    expect(principles.data.first_principles.measures).toEqual([expect.objectContaining({ kpi: "cycleHours", comparator: "atMost", target: 40 })]);
    expect(principles.data.first_principles.requirements[0]).toMatchObject({ owner_person_id: expect.any(String), step_id: step("Director review").id });
    expect(principles.data.first_principles.statements.map((s: { kind: string }) => s.kind)).toEqual(["truth", "assumption", "assumption"]);
    expect(steps.filter((s) => s.parent_step_id !== null || s.kind === "group" || s.kind === "subprocess")).toEqual([]);

    // Suggestions: person, person, client, client and lead source; nothing in the company model changed.
    expect(await pending()).toBe(5);
    expect(await companyRows()).toEqual(company);
    const gaps = await admin.query("select 1 from issues where workspace_id = $1 and type = 'perception_gap'", [workspaceId]);
    expect(gaps.rowCount).toBe(0);
    await client.close();
  });

  it("the canvas's work and Publish sit between the interviews", async () => {
    const [proc] = await processes();
    // Someone confirmed Send report's hands-on time on the canvas (entered).
    await admin.query(
      `update steps set provenance = jsonb_set(provenance, '{work_hours}', provenance->'work_hours' || '{"source":"entered","at":"2026-10-06T09:00:00Z"}')
       where revision_id = $1 and name = 'Send report'`,
      [proc!.draft_revision_id],
    );
    const client = await connect(editorToken, options);
    const published = await call<{ revision: { number: number } }>(client, "publish_process", { process: "Monthly client report", accept_estimates: true });
    expect(published).toMatchObject({ ok: true, data: { revision: { number: 1 } } });
    await client.close();
  });

  it("interview 2 writes into a draft of the same process: a diff, two conflicts and their perception gaps", async () => {
    const [proc] = await processes();
    liveBefore = await snapshot(proc!.live_revision_id!);
    const client = await connect(editorToken, options);
    const results = await replay(client, "run-2", readRun("run-2.json"));

    const imported = results.find((r) => r.tool === "import_process")!;
    expect(imported.data.created).toBe(false);
    expect(imported.data.matched).toEqual([
      { name: "Pull ranking data", id: expect.any(String), by: "name" },
      { name: "Technical check", id: expect.any(String), by: "new" },
      { name: "Director review", id: expect.any(String), by: "name" },
    ]);
    expect(imported.data.diff.steps.added.map((s: { name: string }) => s.name)).toEqual(["Technical check"]);
    expect(imported.data.diff.steps.removed).toEqual([]);
    expect(imported.data.not_overwritten).toEqual([]);
    expect(imported.data.conflicts).toEqual([
      expect.objectContaining({ step: "Pull ranking data", field: "work_hours", values: [expect.objectContaining({ value: 1, speaker: "Hana Iqbal" }), expect.objectContaining({ value: 3, speaker: "Owen Hart" })] }),
      expect.objectContaining({ step: "Director review", field: "rework_rate", values: [expect.objectContaining({ value: 0.2, speaker: "Hana Iqbal" }), expect.objectContaining({ value: 0.5, speaker: "Owen Hart" })] }),
    ]);
    expect(imported.data.warnings).toEqual([]);
    // The new step's unstated numbers are reasoned too (the fixture lint checks new processes only).
    expect(imported.assumptions.filter((a: string) => /defaulted to/.test(a))).toEqual([]);
    const technical = (imported.data.checklist as { step: { name: string }; field: string; evidence: unknown[]; reasoning: string | null }[]).filter(
      (i) => i.step.name === "Technical check",
    );
    expect(technical.map((i) => i.field).sort()).toEqual(["rework_rate", "wait_hours", "work_hours"]);
    for (const i of technical.filter((i) => !i.evidence.length)) expect(i.reasoning).not.toMatch(/^(Server default|Given without a cited source)/);

    // One process, and its draft holds the range the two speakers span.
    const all = await processes();
    expect(all).toHaveLength(1);
    const steps = await stepsOf(all[0]!.draft_revision_id!);
    const pull = steps.find((s) => s.name === "Pull ranking data")!;
    expect(pull).toMatchObject({ work_dist: "triangular", conflict: true });
    expect(pull.work_params).toEqual({ min: 1, mode: 2, max: 3 });
    expect(steps.find((s) => s.name === "Director review")).toMatchObject({ rework_rate: "0.35", conflict: true });
    // What someone confirmed on the canvas carried into the new draft untouched.
    expect(steps.find((s) => s.name === "Send report")!.provenance.work_hours).toMatchObject({ source: "entered" });
    const gaps = await admin.query("select title from issues where workspace_id = $1 and type = 'perception_gap' order by title", [workspaceId]);
    expect(gaps.rows).toEqual([{ title: "Sources disagree on Director review: rework rate" }, { title: "Sources disagree on Pull ranking data: hands-on time" }]);

    // Live is what Publish made it; the leave is one more pending suggestion.
    expect(await snapshot(proc!.live_revision_id!)).toEqual(liveBefore);
    expect(await pending()).toBe(6);
    const leave = results.find((r) => r.tool === "upsert_person")!;
    expect(leave.data.suggestions).toHaveLength(1);
    expect(leave.data.suggestions[0]).toMatchObject({ status: "pending", target_table: "people" });
    await client.close();
  });

  it("the QA workspace scripts set up, reset and rerun cleanly (no extraction is run on the QA transcripts)", async () => {
    const sql = (name: string) => readFileSync(new URL(`../../../docs/extraction/qa/${name}`, import.meta.url), "utf8");
    const qa = async () => (await admin.query("select id from workspaces where slug = 'copperleaf-qa'")).rows as { id: string }[];
    await admin.query(sql("reset-workspace.sql"));

    // An agency admin, with a token and no email address, gets the membership.
    const adminId = randomUUID();
    await admin.query("insert into auth.users (id, raw_app_meta_data) values ($1, '{\"agency_admin\": true}')", [adminId]);
    const { token, hash } = generateApiToken();
    await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e-qa')", [adminId, hash]);

    await admin.query(sql("setup-workspace.sql"));
    const [ws] = await qa();
    expect((await admin.query("select role from memberships where workspace_id = $1 and user_id = $2", [ws!.id, adminId])).rows).toEqual([{ role: "agency_admin" }]);
    // The slug guard: a second run fails and changes nothing.
    await expect(admin.query(sql("setup-workspace.sql"))).rejects.toThrow(/already exists/);
    await admin.query("rollback"); // the script's own begin is still open on this connection, as in an editor tab
    expect(await qa()).toHaveLength(1);

    const client = await connect(token, options);
    const summary = await call<{ workspace: { settings: { hours_per_week: number } }; roles: { name: string }[]; people: { name: string }[]; processes: unknown[] }>(
      client,
      "get_workspace_summary",
      { workspace: "copperleaf-qa" },
    );
    expect(summary.ok, JSON.stringify(summary.error)).toBe(true);
    expect(summary.data.workspace.settings.hours_per_week).toBe(37.5);
    expect(summary.data.roles.map((r) => r.name)).toEqual(["Account director", "Finance", "Managing director", "Paid media specialist"]);
    expect(summary.data.people.map((p) => p.name)).toEqual(["Ellie Marsh", "Grace Adeyemi", "Kofi Mensah", "Nadia Sharp", "Tom Whitfield"]);
    // Content of its own, so the reset has a process and a suggestion to clear.
    expect(await call(client, "create_process", { workspace: "copperleaf-qa", name: "Reset check", kind: "pipeline" })).toMatchObject({ ok: true });
    expect(await call(client, "upsert_person", { workspace: "copperleaf-qa", name: "Ellie Marsh", fte: 0.8, note: "Reset check" })).toMatchObject({ ok: true });
    await client.close();

    // Other test files run in parallel on the same database and add and delete workspaces of their own meanwhile, so the
    // reset is checked against workspaces nobody else touches: a sentinel made here, and the seeded samples if loaded. The
    // reset must leave them in place (and remove only copperleaf-qa).
    const sentinel = randomUUID();
    await admin.query("insert into workspaces (id, name, slug) values ($1, 'Reset sentinel', $2)", [sentinel, `reset-sentinel-${sentinel.slice(0, 8)}`]);
    const kept = async () =>
      new Set(
        ((await admin.query("select id from workspaces where id = $1 or slug in ('northbeam', 'larkspur')", [sentinel])).rows as { id: string }[]).map(
          (r) => r.id,
        ),
      );
    const before = await kept();
    expect(before.has(sentinel)).toBe(true);
    await admin.query(sql("reset-workspace.sql"));
    expect(await qa()).toHaveLength(0);
    const after = await kept();
    expect([...before].filter((id) => !after.has(id))).toEqual([]);
    await admin.query("delete from workspaces where id = $1", [sentinel]);
    // ...and it creates none: anything new since `before` came from another test file, never from the QA scripts.
    expect((await admin.query("select count(*)::int as n from workspaces where slug like 'copperleaf%'")).rows[0].n).toBe(0);
    expect((await admin.query("select 1 from people where name = 'Grace Adeyemi'")).rowCount).toBe(0);

    // It can be rerun, and reset again; resetting when there is nothing to remove is harmless.
    await admin.query(sql("setup-workspace.sql"));
    expect(await qa()).toHaveLength(1);
    await admin.query(sql("reset-workspace.sql"));
    await admin.query(sql("reset-workspace.sql"));
    expect(await qa()).toHaveLength(0);
    await admin.query("delete from api_tokens where user_id = $1", [adminId]);
    await admin.query("delete from auth.users where id = $1", [adminId]);
  });
});
