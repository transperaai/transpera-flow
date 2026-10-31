import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_TABLES,
  NORTHBEAM_WORKSPACE_ID,
  checkWorkspaceBundle,
  exportWorkspaceBundle,
  planWorkspaceImport,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Capacity changes (P7, migration 20270123000000): an automation or augmentation as a stored object. Row-level security (members read, the Owner
// and Agency admins write), the checks on every column, the issue link, and the backup that carries the changes and re-points their step ids.

let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
const users: Record<string, User> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  users.owner = await createUser(db, "owner@capacity-changes.example.com", { agency_admin: true });
  for (const [name, role] of [["admin", "owner"], ["viewer", "viewer"]] as const) {
    users[name] = await createUser(db, `${name}@capacity-changes.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3::membership_role)", [ws, users[name]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@capacity-changes.example.com");
});
afterAll(async () => {
  await db?.close();
});

async function as<T>(user: User, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user.claims)]);
    const r = await fn(db.client);
    await db.client.query("commit");
    return r;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
async function fails(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected the call to fail");
}
async function newWorkspace(name = "Changes Co"): Promise<string> {
  seq++;
  return as(users.owner!, async (c) => (await c.query("select public.create_workspace($1, $2) as id", [name, `chg-${seq}-${Date.now()}`])).rows[0].id as string);
}

const STEP = "00000000-0000-4000-8000-0000000000a1";
const effects = (n = 1) => JSON.stringify(Array.from({ length: n }, () => ({ step: STEP, part: "automatable", remove: 0.85, residualHours: 0.03 })));
const insert = (c: pg.Client, w: string, name: string, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = { workspace_id: w, name, kind: "automation", effects: effects(), adoption: 0.9, ramp_months: 1, ...over };
  const keys = Object.keys(row);
  return c.query(`insert into capacity_changes (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => row[k]));
};

describe("row-level security", () => {
  it("members read; the Owner and Agency admins write; a Viewer and a stranger can't", async () => {
    await as(users.admin!, (c) => insert(c, ws, "Pacing alerts"));
    expect(await as(users.viewer!, async (c) => (await c.query("select name from capacity_changes where workspace_id = $1", [ws])).rows)).toEqual([{ name: "Pacing alerts" }]);
    expect(await as(users.stranger!, async (c) => (await c.query("select name from capacity_changes where workspace_id = $1", [ws])).rows)).toEqual([]);
    expect((await fails(() => as(users.viewer!, (c) => insert(c, ws, "Viewer's")))).message).toMatch(/row-level security/);
    expect((await fails(() => as(users.stranger!, (c) => insert(c, ws, "Stranger's")))).message).toMatch(/row-level security/);
    // A viewer's update and delete touch nothing.
    expect(await as(users.viewer!, async (c) => (await c.query("update capacity_changes set adoption = 0.1 where workspace_id = $1", [ws])).rowCount)).toBe(0);
    expect(await as(users.viewer!, async (c) => (await c.query("delete from capacity_changes where workspace_id = $1", [ws])).rowCount)).toBe(0);
    expect(await as(users.admin!, async (c) => (await c.query("update capacity_changes set adoption = 0.8 where workspace_id = $1", [ws])).rowCount)).toBe(1);
    expect(await as(users.admin!, async (c) => (await c.query("delete from capacity_changes where workspace_id = $1", [ws])).rowCount)).toBe(1);
  });

  it("anon has no access", async () => {
    const grants = await q("select privilege_type from information_schema.role_table_grants where table_name = 'capacity_changes' and grantee = 'anon'");
    expect(grants).toEqual([]);
  });

  it("a write is audited", async () => {
    const w = await newWorkspace("Audit Co");
    await as(users.owner!, (c) => insert(c, w, "Audited"));
    expect((await q("select action from audit_log where workspace_id = $1 and target_table = 'capacity_changes'", [w])).map((r) => r.action)).toEqual(["insert"]);
  });
});

describe("checks", () => {
  it("refuses a bad kind, adoption, ramp, tier list, cost, source and name", async () => {
    const w = await newWorkspace("Checks Co");
    const bad = (over: Record<string, unknown>) => fails(() => as(users.owner!, (c) => insert(c, w, `x${Math.random()}`, over)));
    expect((await bad({ kind: "robot" })).message).toMatch(/capacity_changes_kind/);
    expect((await bad({ adoption: 1.5 })).message).toMatch(/capacity_changes_adoption/);
    expect((await bad({ ramp_months: 25 })).message).toMatch(/capacity_changes_ramp/);
    expect((await bad({ tiers: [] })).message).toMatch(/capacity_changes_tiers/);
    expect((await bad({ cost_monthly: -1 })).message).toMatch(/capacity_changes_cost/);
    expect((await bad({ source: "guess" })).message).toMatch(/capacity_changes_source/);
    expect((await fails(() => as(users.owner!, (c) => insert(c, w, "   ")))).message).toMatch(/capacity_changes_name/);
  });

  it("refuses effects that are not the engine's shape", async () => {
    const w = await newWorkspace("Effects Co");
    const put = (e: unknown) => fails(() => as(users.owner!, (c) => c.query("insert into capacity_changes (workspace_id, name, kind, effects) values ($1, $2, 'augmentation', $3::jsonb)", [w, `e${Math.random()}`, JSON.stringify(e)])));
    for (const e of [
      {},
      [{ step: "not-a-uuid", part: "automatable", remove: 0.5 }],
      [{ step: STEP, part: "automatable", remove: 1.5 }],
      [{ step: STEP, part: "automatable", remove: 0.5, residualHours: -1 }],
      [{ step: STEP, part: "augmentable", factor: 0.5 }],
      [{ step: STEP, part: "augmentable", factor: 2, remove: 0.1 }],
      [{ step: STEP, part: "manual", remove: 0.5 }],
      Array.from({ length: 41 }, () => ({ step: STEP, part: "augmentable", factor: 2 })),
    ]) expect((await put(e)).message, JSON.stringify(e).slice(0, 60)).toMatch(/capacity_changes_effects/);
    await as(users.owner!, (c) =>
      c.query("insert into capacity_changes (workspace_id, name, kind, effects) values ($1, 'ok', 'augmentation', $2::jsonb)", [w, JSON.stringify([{ step: STEP, part: "automatable", remove: 0.8 }, { step: STEP, part: "augmentable", factor: 1.5 }])]),
    );
  });

  it("names are unique in a workspace, ignoring case, and the same name is fine in another", async () => {
    const a = await newWorkspace("A");
    const b = await newWorkspace("B");
    await as(users.owner!, (c) => insert(c, a, "Pacing"));
    expect((await fails(() => as(users.owner!, (c) => insert(c, a, " pacing ")))).message).toMatch(/capacity_changes_workspace_name_key/);
    await as(users.owner!, (c) => insert(c, b, "Pacing"));
  });

  it("deleting the issue a change fixes clears the link and keeps the change", async () => {
    const w = await newWorkspace("Issue Co");
    const issue = (await q("insert into issues (workspace_id, type, severity, title) values ($1, 'delay', 'info', 'Slow reporting') returning id", [w]))[0]!.id as string;
    await as(users.owner!, (c) => insert(c, w, "Report page", { issue_id: issue }));
    expect((await q("select issue_id from capacity_changes where workspace_id = $1", [w]))[0]!.issue_id).toBe(issue);
    await q("delete from issues where id = $1", [issue]);
    expect((await q("select issue_id from capacity_changes where workspace_id = $1", [w]))[0]!.issue_id).toBeNull();
  });
});

describe("a backup round-trips the changes", () => {
  async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
    const bundle = await db.as(users.owner!.claims, async (c) => {
      const read: TableReader = async (table, wsId) => {
        const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
        return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
      };
      const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
      return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
    });
    return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
  }

  it("exports the changes, and the restore brings them back with their step and issue ids re-pointed", async () => {
    const src = await newWorkspace("Changes Source");
    // A process with steps and an issue in the source workspace: restore a Northbeam-shaped bundle's company map is heavy, so build the rows directly.
    const bundle0 = await exportOf(ws);
    const live = bundle0.processes.find((p) => p.is_company !== true)!;
    const version = (live.versions as Row[]).find((v) => v.live === true) ?? (live.versions as Row[])[0]!;
    const stepIds = (version.steps as Row[]).slice(0, 2).map((s) => String(s.id));
    expect(stepIds).toHaveLength(2);

    // The changes are written into the source bundle (their step ids are the source workspace's) and the bundle is restored into a new workspace.
    const issueRow = bundle0.issues.find((i) => i.source !== "detected");
    const rows = [
      { id: "11111111-aaaa-4aaa-8aaa-111111111111", workspace_id: ws, name: "Pacing alerts", kind: "automation", effects: [{ step: stepIds[0], part: "automatable", remove: 0.85, residualHours: 0.03 }, { step: stepIds[0], part: "augmentable", factor: 1.5 }], adoption: 0.9, ramp_months: 2, tiers: ["T1", "T2"], cost_monthly: 300, issue_id: issueRow ? issueRow.id : null, source: "interview", provenance: {}, created_at: "2026-10-05T00:00:00Z" },
      { id: "22222222-aaaa-4aaa-8aaa-222222222222", workspace_id: ws, name: "Briefs", kind: "augmentation", effects: [{ step: stepIds[1], part: "automatable", remove: 0.6 }], adoption: 0.8, ramp_months: 0, tiers: null, cost_monthly: null, issue_id: null, source: "estimate", provenance: {}, created_at: "2026-10-05T00:00:01Z" },
    ];
    const bundle: WorkspaceBundle = JSON.parse(JSON.stringify(bundle0));
    bundle.company_model.capacity_changes = rows;
    bundle.counts["company_model.capacity_changes"] = rows.length;
    const check = checkWorkspaceBundle(bundle, { canManage: true });
    expect(check.errors).toEqual([]);
    const { plan } = planWorkspaceImport(bundle, { canManage: true });
    expect(plan.capacity_changes).toHaveLength(2);
    // Every uuid in the effects is a placeholder now.
    for (const r of plan.capacity_changes) for (const e of r.effects as Row[]) expect(String(e.step)).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);

    const dst = await newWorkspace("Changes Restored");
    const result = await as(users.owner!, async (c) => (await c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, 'backup.json') as r", [dst, JSON.stringify(plan)])).rows[0].r as { counts: Record<string, number> });
    expect(result.counts.capacity_changes).toBe(2);
    const back = await q("select name, kind, effects, adoption::float8 as adoption, ramp_months, tiers, cost_monthly::float8 as cost, issue_id, source from capacity_changes where workspace_id = $1 order by name", [dst]);
    expect(back.map((r) => r.name)).toEqual(["Briefs", "Pacing alerts"]);
    const pacing = back[1]!;
    expect(pacing).toMatchObject({ kind: "automation", adoption: 0.9, ramp_months: 2, tiers: ["T1", "T2"], cost: 300, source: "interview" });
    // The effects point at steps that exist in the restored workspace, and not at the source workspace's.
    const dstSteps = new Set((await q("select id from steps where workspace_id = $1", [dst])).map((r) => String(r.id)));
    for (const r of back) for (const e of r.effects as Row[]) {
      expect(dstSteps.has(String(e.step)), "step re-pointed").toBe(true);
      expect(stepIds).not.toContain(String(e.step));
    }
    expect((pacing.effects as Row[])[0]).toMatchObject({ part: "automatable", remove: 0.85, residualHours: 0.03 });
    if (issueRow) expect(pacing.issue_id).not.toBe(issueRow.id);
    expect(src).toBeDefined();

    // A second export holds the same changes as the first, apart from ids.
    const again = await exportOf(dst);
    const strip = (rs: Row[]) => rs.map(({ id: _i, workspace_id: _w, created_at: _c, updated_at: _u, issue_id: _is, effects: _e, provenance: _p, ...rest }) => rest).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(strip(again.company_model.capacity_changes!)).toEqual(strip(rows));
  }, 120_000);

  it("a backup made before changes existed restores into a workspace with none", async () => {
    const src = await newWorkspace("Old source");
    const bundle = await exportOf(src);
    delete bundle.company_model.capacity_changes;
    const { plan } = planWorkspaceImport(bundle, { canManage: true });
    const older = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    delete older.capacity_changes;
    const dst = await newWorkspace("Old target");
    await as(users.owner!, (c) => c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, null)", [dst, JSON.stringify(older)]));
    expect((await q("select count(*)::int as n from capacity_changes where workspace_id = $1", [dst]))[0]!.n).toBe(0);
  });

  it("a workspace that already has changes is not empty to a restore", async () => {
    const w = await newWorkspace("Not empty");
    await as(users.owner!, (c) => insert(c, w, "Already here"));
    const bundle = await exportOf(await newWorkspace("Empty source"));
    const { plan } = planWorkspaceImport(bundle, { canManage: true });
    const e = await fails(() => as(users.owner!, (c) => c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, null)", [w, JSON.stringify(plan)])));
    expect(e.message).toMatch(/isn't empty: it already has capacity changes/);
  });
});
