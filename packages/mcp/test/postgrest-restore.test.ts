import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@transpera-flow/db";
import { signJwt } from "./helpers";

// Restore a workspace backup over PostgREST (issue #39, B10 part 2b): an owner's session calls `import_workspace_bundle` through
// /rest/v1/rpc, as the app's restore route does, and an API token is refused. Skipped unless POSTGREST_URL is set (see
// postgrest-import-v2.test.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const SUPABASE_URL = "https://project.supabase.test";

let admin: pg.Client;
let workspaceId: string;
let ownerId: string;

const toPostgrest: typeof fetch = (input, init) => fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

function clientFor(userId: string, extra: Record<string, unknown> = {}) {
  const anon = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
  const user = signJwt({ sub: userId, role: "authenticated", iss: "test", aud: "authenticated", ...extra }, JWT_SECRET);
  return createClient<Database>(SUPABASE_URL, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${user}` }, fetch: toPostgrest },
  });
}

const P = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** A small plan: one role, one person, one process with a start, a task and an end. */
function smallPlan() {
  const step = (n: number, name: string, kind: string, extra: Record<string, unknown> = {}) => ({ id: P(n), name, kind, work_hours: kind === "task" ? 2 : 0, wait_hours: 0, rework_rate: 0, x: n * 10, y: 0, ...extra });
  const empty = {
    format: "transpera-workspace-import/1", settings: { hours_per_week: 36 }, roles: [{ id: P(1), name: "Analyst", color: "#336699" }], people: [{ id: P(2), name: "Ada" }],
    person_roles: [{ person_id: P(2), role_id: P(1) }], person_leave: [], lead_sources: [], seasonality: [], demand_settings: null, churn_drivers: [], market_conditions: [],
    market_schedule: [], lever_settings: null, analysis_rules: null, clients: [], sources: [], scenarios: [], blocks: [], issues: [], services: [], service_servicing: [],
    client_groups: [], client_services: [], client_assignments: [], person_skills: [], source_links: [], suggestions: [], proposals: [],
  };
  return {
    ...empty,
    processes: [
      {
        id: P(10), parent_process_id: null, name: "Intake", kind: "pipeline", entity_name: "item", description: null, archived: false, layout: {}, first_principles: null,
        steps: [step(11, "Start", "start"), step(12, "Review", "task", { role_id: P(1) }), step(13, "Done", "end", { outcome: "done" })],
        edges: [{ id: P(14), from_step_id: P(11), to_step_id: P(12), probability: 1 }, { id: P(15), from_step_id: P(12), to_step_id: P(13), probability: 1 }],
      },
    ],
  };
}

describe.skipIf(!POSTGREST_URL)("restoring a backup over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    workspaceId = (await q("insert into workspaces (name, slug) values ('Restore Co', 'restore-co-' || substr(gen_random_uuid()::text, 1, 8)) returning id"))[0].id;
    ownerId = randomUUID();
    await q("insert into auth.users (id, email) values ($1, $2)", [ownerId, `restore-owner-${ownerId}@example.com`]);
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, ownerId]);
    const owner = clientFor(ownerId);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await owner.from("workspaces").select("id");
      if (!r.error && (r.data ?? []).length >= 1) break;
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("refuses an API token, and writes nothing", async () => {
    const token = clientFor(ownerId, { api_token_id: randomUUID() });
    const r = await token.rpc("import_workspace_bundle", { p_workspace: workspaceId, p_plan: smallPlan() as never, p_label: "small.json" });
    expect(r.error).not.toBeNull();
    // PostgREST may answer a refusal by a role it rejects as 401 rather than the function's own 42501 (docs/supabase-notes.md).
    expect(["42501", "PGRST301", "PGRST303"].includes(r.error!.code) || r.status === 401).toBe(true);
    expect((await q("select count(*)::int n from roles where workspace_id = $1", [workspaceId]))[0].n).toBe(0);
  });

  it("restores a small plan for an owner's session, as drafts", async () => {
    const owner = clientFor(ownerId);
    const r = await owner.rpc("import_workspace_bundle", { p_workspace: workspaceId, p_plan: smallPlan() as never, p_label: "small.json" });
    expect(r.error).toBeNull();
    const body = r.data as unknown as { id_prefix: string; processes: { name: string; id: string }[]; settings: string; counts: Record<string, number> };
    expect(body.processes.map((p) => p.name)).toEqual(["Intake"]);
    expect(body.settings).toBe("applied");
    expect(body.id_prefix).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-$/);
    expect((await q("select count(*)::int n from steps where workspace_id = $1 and process_id = $2", [workspaceId, body.processes[0]!.id]))[0].n).toBe(3);
    expect((await q("select status from process_revisions where process_id = $1", [body.processes[0]!.id])).map((x) => x.status)).toEqual(["draft"]);
    expect((await q("select settings from workspaces where id = $1", [workspaceId]))[0].settings.hours_per_week).toBe(36);
  });

  it("then refuses a second restore into the same workspace (not empty)", async () => {
    const owner = clientFor(ownerId);
    const r = await owner.rpc("import_workspace_bundle", { p_workspace: workspaceId, p_plan: smallPlan() as never, p_label: "small.json" });
    expect(r.error?.code).toBe("23514");
    expect(r.error?.hint).toBe("not_empty");
  });
});
