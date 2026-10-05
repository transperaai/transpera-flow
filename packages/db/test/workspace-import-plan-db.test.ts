import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_TABLES, LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, PLACEHOLDER_PREFIX, checkWorkspaceBundle, exportWorkspaceBundle, planWorkspaceImport, type Row, type TableReader, type WorkspaceBundle } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// A real export (the seeded Northbeam and Larkspur workspaces, as an editor) checks ok and plans (issue #39, B10 2a).

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

async function exportOf(workspaceId: string, email: string): Promise<WorkspaceBundle> {
  const user = await createUser(db, email);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [workspaceId, user.id]);
  const bundle = await db.as(user.claims, async (c) => {
    const read: TableReader = async (table, wsId) => {
      const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
      return (await c.query(`select ${spec.columns ?? "*"} from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}`, [wsId])).rows as Row[];
    };
    const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
    return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
  });
  return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
}

const count = async (table: string, ws: string, where = "true") => Number((await db.client.query(`select count(*) from public.${table} where workspace_id = $1 and ${where}`, [ws])).rows[0].count);

describe.each([
  ["Northbeam", NORTHBEAM_WORKSPACE_ID],
  ["Larkspur", LARKSPUR_WORKSPACE_ID],
])("a real %s export", (name, ws) => {
  it("checks ok, and the summary counts match the source tables minus what is left out", async () => {
    const bundle = await exportOf(ws, `plan.${name.toLowerCase()}@example.com`);
    const check = checkWorkspaceBundle(bundle);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);

    const line = (list: { key: string; count: number }[], key: string) => list.find((l) => l.key === key)?.count ?? 0;
    const { restored, leftOut } = check.summary;
    expect(line(restored, "processes")).toBe(await count("processes", ws, "not is_company and (live_revision_id is not null or draft_revision_id is not null)"));
    expect(line(restored, "roles")).toBe(await count("roles", ws));
    expect(line(restored, "people")).toBe(await count("people", ws));
    expect(line(restored, "services")).toBe(await count("services", ws));
    expect(line(restored, "clients")).toBe(await count("clients", ws));
    expect(line(restored, "sources")).toBe(await count("sources", ws));
    expect(line(restored, "blocks")).toBe(await count("blocks", ws));
    expect(line(restored, "scenarios")).toBe(await count("scenarios", ws));
    expect(line(restored, "issues")).toBe(await count("issues", ws, "source <> 'detected'"));
    expect(line(restored, "suggestions")).toBe(await count("suggestions", ws, "status = 'pending'"));
    expect(line(leftOut, "solutions") - (await count("solutions", ws))).toBeGreaterThanOrEqual(0);
    expect(line(leftOut, "detections")).toBe(await count("issues", ws, "source = 'detected'"));
  });

  it("plans with placeholders only, no account keys, and the same order as the source ids", async () => {
    const bundle = await exportOf(ws, `plan2.${name.toLowerCase()}@example.com`);
    const { plan, placeholderOf } = planWorkspaceImport(bundle, { canManage: true });
    const found = JSON.stringify(plan).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(found.filter((u) => !u.startsWith(PLACEHOLDER_PREFIX))).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/"(created_by|email|workspace_id|hidden)"/);
    const old = [...placeholderOf.keys()].sort();
    const mapped = old.map((k) => placeholderOf.get(k)!);
    expect(mapped).toEqual([...mapped].sort());
    expect(plan.processes.length).toBeGreaterThan(0);
    expect(plan.people.map((p) => p.id)).toEqual(expect.arrayContaining(bundle.company_model.people!.map((p) => placeholderOf.get(String(p.id)))));
  });
});
