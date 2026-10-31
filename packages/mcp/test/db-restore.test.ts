import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@transpera-flow/db/client";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// Restore a workspace backup (issue #39, B10 part 2b): an owner's session calls `import_workspace_bundle`, as the app's restore
// route does, and an API token is refused. Runs on a throwaway database (test/helpers.ts).

let env: McpTestDb;
let admin: pg.Client;
let workspaceId: string;
let ownerId: string;

const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

/** The owner's session, or (with `api_token_id`) the same user as an API token reaches the database. */
const clientFor = (userId: string, extra: Record<string, unknown> = {}) => env.dbAs(userClaims(userId, extra));

const P = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** A small plan: one role, one person, one process with a start, a task and an end. */
function smallPlan() {
  const step = (n: number, name: string, kind: string, extra: Record<string, unknown> = {}) => ({ id: P(n), name, kind, work_hours: kind === "task" ? 2 : 0, wait_hours: 0, rework_rate: 0, x: n * 10, y: 0, ...extra });
  const empty = {
    format: "transpera-workspace-import/1", settings: { hours_per_week: 36 }, roles: [{ id: P(1), name: "Analyst", color: "#336699" }], people: [{ id: P(2), name: "Ada" }],
    person_roles: [{ person_id: P(2), role_id: P(1) }], person_leave: [], lead_sources: [], seasonality: [], demand_settings: null, churn_drivers: [], market_conditions: [],
    market_schedule: [], analysis_rules: null, clients: [], sources: [], sandbox_scenarios: [], blocks: [], issues: [], services: [], service_servicing: [],
    client_groups: [], client_services: [], client_assignments: [], person_skills: [], source_links: [],
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

describe("restoring a backup", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    workspaceId = (await q("insert into workspaces (name, slug) values ('Restore Co', 'restore-co-' || substr(gen_random_uuid()::text, 1, 8)) returning id"))[0].id;
    ownerId = randomUUID();
    await q("insert into auth.users (id, email) values ($1, $2)", [ownerId, `restore-owner-${ownerId}@example.com`]);
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, ownerId]);
  });

  afterAll(async () => {
    await env?.close();
  });

  it("refuses an API token, and writes nothing", async () => {
    const token = clientFor(ownerId, { api_token_id: randomUUID() });
    const r = await errorOf(() => rpc(token, "import_workspace_bundle", { p_workspace: workspaceId, p_plan: smallPlan() as never, p_label: "small.json" }));
    expect(r).not.toBeNull();
    expect(r?.code).toBe("42501");
    expect((await q("select count(*)::int n from roles where workspace_id = $1", [workspaceId]))[0].n).toBe(0);
  });

  it("restores a small plan for an owner's session, as drafts", async () => {
    const owner = clientFor(ownerId);
    const r = await rpc(owner, "import_workspace_bundle", { p_workspace: workspaceId, p_plan: smallPlan() as never, p_label: "small.json" });
    const body = r as unknown as { id_prefix: string; processes: { name: string; id: string }[]; settings: string; counts: Record<string, number> };
    expect(body.processes.map((p) => p.name)).toEqual(["Intake"]);
    expect(body.settings).toBe("applied");
    expect(body.id_prefix).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-$/);
    expect((await q("select count(*)::int n from steps where workspace_id = $1 and process_id = $2", [workspaceId, body.processes[0]!.id]))[0].n).toBe(3);
    expect((await q("select status from process_revisions where process_id = $1", [body.processes[0]!.id])).map((x) => x.status)).toEqual(["draft"]);
    expect((await q("select settings from workspaces where id = $1", [workspaceId]))[0].settings.hours_per_week).toBe(36);
  });

  it("then refuses a second restore into the same workspace (not empty)", async () => {
    const owner = clientFor(ownerId);
    const r = await errorOf(() => rpc(owner, "import_workspace_bundle", { p_workspace: workspaceId, p_plan: smallPlan() as never, p_label: "small.json" }));
    expect(r?.code).toBe("23514");
    expect((r as unknown as { hint?: string }).hint).toBe("not_empty");
  });
});
