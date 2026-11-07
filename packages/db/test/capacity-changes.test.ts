import { readFileSync } from "node:fs";
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
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { createTestDb, createUser, type TestDb } from "./harness";

// Capacity changes (P7, migration 20270123000000) became part of solutions (D53, migration 20270136000000). The old table is read-only for one release:
// this file checks that (members read, nobody inserts or updates, an admin can still delete), that its column checks still hold, the new
// `solutions.step_changes` checks and grant, the move itself (the migration's own SQL run on rows it has never seen), and the backup (it carries the
// legacy rows and the solutions' step changes, and a restore leaves both out and says so).

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
const effects = (n = 1) => Array.from({ length: n }, () => ({ step: STEP, part: "automatable", remove: 0.85, residualHours: 0.03 }));
const insert = (c: pg.Client, w: string, name: string, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = { workspace_id: w, name, kind: "automation", effects: effects(), adoption: 0.9, ramp_months: 1, ...over };
  const keys = Object.keys(row);
  return c.query(`insert into capacity_changes (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => (k === "effects" ? JSON.stringify(row[k]) : row[k])));
};


const insertLegacy = (w: string, name: string, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = { workspace_id: w, name, kind: "automation", effects: effects(), adoption: 0.9, ramp_months: 1, ...over };
  const keys = Object.keys(row);
  return db.client.query(`insert into capacity_changes (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => (k === "effects" ? JSON.stringify(row[k]) : row[k])));
};

describe("the old table is read-only for one release", () => {
  it("members read; nobody inserts or updates; an admin can still delete", async () => {
    await insertLegacy(ws, "Pacing alerts");
    expect(await as(users.viewer!, async (c) => (await c.query("select name from capacity_changes where workspace_id = $1", [ws])).rows)).toEqual([{ name: "Pacing alerts" }]);
    expect(await as(users.stranger!, async (c) => (await c.query("select name from capacity_changes where workspace_id = $1", [ws])).rows)).toEqual([]);
    for (const who of ["admin", "viewer", "stranger"]) {
      expect((await fails(() => as(users[who]!, (c) => insert(c, ws, `${who}'s`)))).message, who).toMatch(/row-level security/);
    }
    expect((await fails(() => as(users.owner!, (c) => insert(c, ws, "Owner's")))).message).toMatch(/row-level security/);
    expect(await as(users.admin!, async (c) => (await c.query("update capacity_changes set adoption = 0.8 where workspace_id = $1", [ws])).rowCount)).toBe(0);
    expect(await as(users.viewer!, async (c) => (await c.query("delete from capacity_changes where workspace_id = $1", [ws])).rowCount)).toBe(0);
    expect(await as(users.admin!, async (c) => (await c.query("delete from capacity_changes where workspace_id = $1", [ws])).rowCount)).toBe(1);
    expect((await q("select policyname from pg_policies where tablename = 'capacity_changes' order by 1")).map((r) => r.policyname)).toEqual(["delete capacity_changes", "read capacity_changes"]);
  });

  it("anon has no access, and the table says it is legacy", async () => {
    expect(await q("select privilege_type from information_schema.role_table_grants where table_name = 'capacity_changes' and grantee = 'anon'")).toEqual([]);
    expect((await q("select obj_description('public.capacity_changes'::regclass) as c"))[0]!.c).toMatch(/LEGACY, read-only/);
  });

  it("keeps its column checks, and deleting the issue a change fixes clears the link", async () => {
    const w = await newWorkspace("Checks Co");
    const bad = (over: Record<string, unknown>) => fails(() => insertLegacy(w, `x${Math.random()}`, over));
    expect((await bad({ kind: "robot" })).message).toMatch(/capacity_changes_kind/);
    expect((await bad({ adoption: 1.5 })).message).toMatch(/capacity_changes_adoption/);
    expect((await bad({ cost_monthly: -1 })).message).toMatch(/capacity_changes_cost/);
    expect((await bad({ effects: [{ step: "not-a-uuid", part: "automatable", remove: 0.5 }] })).message).toMatch(/capacity_changes_effects/);
    const issue = (await q("insert into issues (workspace_id, type, severity, title) values ($1, 'delay', 'info', 'Slow reporting') returning id", [w]))[0]!.id as string;
    await insertLegacy(w, "Report page", { issue_id: issue });
    await q("delete from issues where id = $1", [issue]);
    expect((await q("select issue_id from capacity_changes where workspace_id = $1", [w]))[0]!.issue_id).toBeNull();
  });
});

describe("solutions.step_changes", () => {
  const change = (over: Record<string, unknown> = {}) => ({ id: "11111111-aaaa-4aaa-8aaa-111111111111", name: "Pacing alerts", kind: "automation", effects: [{ step: STEP, part: "automatable", remove: 0.85, residualHours: 0.03 }], adoption: 0.9, ramp_months: 2, tiers: ["T1"], cost_monthly: 300, ...over });
  let solution: string;
  beforeAll(async () => {
    const p = (await q("select p.id, p.live_revision_id from processes p where p.workspace_id = $1 and p.is_company is not true and p.live_revision_id is not null limit 1", [ws]))[0]!;
    solution = (await q("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'S', '{\"steps\": [], \"edges\": []}') returning id", [ws, p.id, p.live_revision_id]))[0]!.id as string;
  });
  const put = (value: unknown) => db.client.query("update solutions set step_changes = $2::jsonb where id = $1", [solution, JSON.stringify(value)]);

  it("takes the shape capacity_changes took, with an optional id", async () => {
    await put([change()]);
    await put([change({ id: undefined, tiers: null, cost_monthly: null })]);
    await put([change({ tiers: undefined, cost_monthly: undefined }), change({ id: "22222222-aaaa-4aaa-8aaa-222222222222", name: "Briefs", kind: "augmentation", effects: [{ step: STEP, part: "augmentable", factor: 1.5 }], ramp_months: 0 })]);
    await put([]);
  });

  it("refuses anything else", async () => {
    const e = [{ step: STEP, part: "automatable", remove: 0.5 }];
    for (const bad of [
      {},
      [5],
      [change({ kind: "robot" })],
      [change({ name: "   " })],
      [change({ name: undefined })],
      [change({ effects: [] })],
      [change({ effects: [{ step: "nope", part: "automatable", remove: 0.5 }] })],
      [change({ effects: [{ step: STEP, part: "augmentable", factor: 0.5 }] })],
      [change({ adoption: 1.5 })],
      [change({ adoption: "0.5" })],
      [change({ ramp_months: 25 })],
      [change({ ramp_months: 1.5 })],
      [change({ tiers: [] })],
      [change({ tiers: [1] })],
      [change({ cost_monthly: -1 })],
      [change({ id: "not-a-uuid" })],
      [change({ source: "estimate" })],
      Array.from({ length: 41 }, () => change({ effects: e })),
    ]) expect((await fails(() => put(bad))).message, JSON.stringify(bad).slice(0, 70)).toMatch(/solutions_step_changes/);
  });

  it("an editor writes it; a viewer and a stranger can't", async () => {
    expect(await as(users.admin!, async (c) => (await c.query("update solutions set step_changes = $2::jsonb where id = $1", [solution, JSON.stringify([change()])])).rowCount)).toBe(1);
    expect(await as(users.viewer!, async (c) => (await c.query("update solutions set step_changes = '[]' where id = $1", [solution])).rowCount)).toBe(0);
    expect(await as(users.stranger!, async (c) => (await c.query("update solutions set step_changes = '[]' where id = $1", [solution])).rowCount)).toBe(0);
    expect(await q("select jsonb_array_length(step_changes) as n from solutions where id = $1", [solution])).toEqual([{ n: 1 }]);
  });
});

describe("the move (the migration's own SQL, run on rows it has not seen)", () => {
  const SQL = readFileSync(new URL("../migrations/20270136000000_changes_into_solutions.sql", import.meta.url), "utf8");
  const MOVE = SQL.slice(SQL.indexOf("do $$"), SQL.indexOf("$$;", SQL.indexOf("do $$")) + 3);
  let w: string;
  const notices: string[] = [];
  const original = new Map<string, Row>();
  const issues: Record<string, string> = {};

  beforeAll(async () => {
    w = (await q("insert into workspaces (name, slug) values ('Move Co', 'move-co') returning id"))[0]!.id as string;
    await db.client.query("begin");
    await loadCapacityExample(db.client, w, "2026-10-05");
    await db.client.query("commit");
    // The loader makes the changes as solutions already: turn them back into stored changes (what a database before the migration holds).
    for (const r of await q("select id, process_id, step_changes -> 0 as c from solutions where workspace_id = $1 and step_changes <> '[]'::jsonb order by created_at, id", [w])) {
      original.set(String((r.c as Row).id), { ...(r.c as Row), process_id: r.process_id });
    }
    expect(original.size).toBe(13);
    await q("delete from solutions where workspace_id = $1", [w]);
    // The move reads every row of the table: start from this workspace's alone.
    await q("delete from capacity_changes");
    const counts = new Map<string, number>();
    for (const c of original.values()) counts.set(String(c.process_id), (counts.get(String(c.process_id)) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    expect(ranked.length).toBeGreaterThanOrEqual(3);
    const procs = await q("select id, name from processes where id = any($1::uuid[]) order by name", [ranked.slice(0, 3).map(([id]) => id)]);
    const pa = procs.find((r) => r.id === ranked[0]![0])!;
    const pb = procs.find((r) => r.id === ranked[1]![0])!;
    const pc = procs.find((r) => r.id === ranked[2]![0])!;
    const mk = async (key: string, over: Record<string, unknown>) =>
      (issues[key] = (await q("insert into issues (workspace_id, type, severity, title, status, process_id, source, detected_key) values ($1, 'delay', 'info', $2, $3, $4, $5, $6) returning id", [w, key, over.status ?? "open", over.process ?? pa.id, over.source ?? "manual", over.source === "detected" ? "wait:step:abc" : null]))[0]!.id as string);
    await mk("open one", {});
    await mk("resolved one", { status: "done" });
    await mk("other process", { process: pc.id });
    await mk("a detection", { source: "detected" });
    const issueFor: Record<string, string> = {};
    // The busiest process's two changes take the open issue and the resolved one (both about it); a change of the second process takes the one about the third
    // process and a change of the third takes the detection: those two links are refused by the app's rules, so the move skips them.
    const inProcess = (p: Row) => [...original.values()].filter((c) => c.process_id === p.id);
    inProcess(pa).slice(0, 2).forEach((c, i) => (issueFor[String(c.id)] = [issues["open one"]!, issues["resolved one"]!][i]!));
    issueFor[String(inProcess(pb)[0]!.id)] = issues["other process"]!;
    issueFor[String(inProcess(pc)[0]!.id)] = issues["a detection"]!;
    for (const c of original.values()) {
      await insertLegacy(w, String(c.name), { id: c.id, kind: c.kind, effects: c.effects, adoption: c.adoption, ramp_months: c.ramp_months, tiers: c.tiers, cost_monthly: c.cost_monthly, issue_id: issueFor[String(c.id)] ?? null });
    }
    // Rows the loader never makes: effects on steps in no live version, a partly gone change, one acting on two processes.
    const stepOf = async (process: string) => String((await q("select s.id from steps s join processes p on p.live_revision_id = s.revision_id where p.id = $1 and s.kind = 'task' order by s.id limit 1", [process]))[0]!.id);
    await insertLegacy(w, "Edge: gone", { effects: [{ step: "00000000-0000-4000-8000-0000000000c1", part: "automatable", remove: 0.5 }] });
    await insertLegacy(w, "Edge: partly gone", { effects: [{ step: await stepOf(String(pa.id)), part: "automatable", remove: 0.5 }, { step: "00000000-0000-4000-8000-0000000000c2", part: "automatable", remove: 0.5 }] });
    await insertLegacy(w, "Edge: two processes", { effects: [{ step: await stepOf(String(pa.id)), part: "augmentable", factor: 2 }, { step: await stepOf(String(pb.id)), part: "augmentable", factor: 2 }], issue_id: issues["open one"] });

    const statuses = async () => q("select title, status from issues where workspace_id = $1 order by title", [w]);
    (issues as Record<string, string>)["_before"] = JSON.stringify(await statuses());
    db.client.on("notice", (n) => notices.push(String(n.message)));
    await db.client.query("begin");
    await db.client.query(MOVE);
    await db.client.query("commit");
  }, 300_000);

  it("makes one testing solution for each change and process, with the change's own numbers", async () => {
    for (const [id, c] of original) {
      const made = await q("select s.* from solutions s where s.workspace_id = $1 and s.step_changes -> 0 ->> 'id' = $2", [w, id]);
      expect(made, String(c.name)).toHaveLength(1);
      const s = made[0]!;
      const { process_id, ...change } = c;
      expect(s.step_changes).toEqual([change]);
      expect(s).toMatchObject({ name: c.name, status: "testing", process_id });
      expect(s.base_revision_id).toBe((await q("select live_revision_id from processes where id = $1", [process_id]))[0]!.live_revision_id);
      expect([...(s.changed_step_ids as string[])].sort()).toEqual([...new Set((c.effects as { step: string }[]).map((e) => e.step))].sort());
      // A copy of the live version: every step and edge, ready to simulate.
      const steps = s.steps as { steps: Row[]; edges: Row[] };
      expect(steps.steps).toHaveLength(Number((await q("select count(*)::int as n from steps where revision_id = $1", [s.base_revision_id]))[0]!.n));
      expect(steps.edges).toHaveLength(Number((await q("select count(*)::int as n from edges where revision_id = $1", [s.base_revision_id]))[0]!.n));
      expect(steps.steps[0]).not.toHaveProperty("revision_id");
    }
  });

  it("drops effects on steps that are gone, makes no solution for a change with none left, and splits a change over its processes", async () => {
    expect(await q("select 1 from solutions where workspace_id = $1 and name = 'Edge: gone'", [w])).toEqual([]);
    const partly = await q("select step_changes -> 0 -> 'effects' as e from solutions where workspace_id = $1 and name = 'Edge: partly gone'", [w]);
    expect(partly).toHaveLength(1);
    expect(partly[0]!.e).toHaveLength(1);
    const two = await q("select process_id, step_changes -> 0 -> 'effects' as e from solutions where workspace_id = $1 and name = 'Edge: two processes'", [w]);
    expect(two).toHaveLength(2);
    expect(new Set(two.map((t) => t.process_id)).size).toBe(2);
    for (const t of two) expect(t.e).toHaveLength(1);
    expect(notices.join("\n")).toMatch(/16 solutions made/);
    expect(notices.join("\n")).toMatch(/2 effects dropped/);
    expect(notices.join("\n")).toMatch(/1 changes with no solution/);
  });

  it("links the issue when the app's rules allow it, as a record: no issue changes status and nothing is logged", async () => {
    const linked = await q("select i.title, count(*)::int as n from solution_issues l join issues i on i.id = l.issue_id where l.workspace_id = $1 group by 1 order by 1", [w]);
    // The open and the resolved issue are linked; the one about another process and the detection are not; the edge change's open issue is linked to its solution of that process only.
    expect(linked.map((r) => r.title)).toEqual(["open one", "resolved one"]);
    expect(linked.find((r) => r.title === "open one")!.n).toBe(2);
    expect(JSON.stringify(await q("select title, status from issues where workspace_id = $1 order by title", [w]))).toBe(issues["_before"]);
    expect(await q("select 1 from issue_events where workspace_id = $1 and kind = 'solution_tested'", [w])).toEqual([]);
    expect(notices.join("\n")).toMatch(/3 links skipped/);
  });
});

describe("a backup", () => {
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

  it("carries the solutions' step changes and the legacy rows, and a restore leaves both out and says so", async () => {
    const w = (await q("select id from workspaces where slug = 'move-co'"))[0]!.id as string;
    const bundle = await exportOf(w);
    const held = bundle.solutions.filter((s) => (s.step_changes as unknown[]).length);
    expect(held).toHaveLength(16);
    expect(bundle.company_model.capacity_changes!).toHaveLength(16);
    const check = checkWorkspaceBundle(bundle, { canManage: true });
    expect(check.errors).toEqual([]);
    const { plan, summary } = planWorkspaceImport(bundle, { canManage: true });
    expect(plan.capacity_changes).toEqual([]);
    expect(summary.restored.some((l) => l.key === "capacity_changes")).toBe(false);
    expect(summary.leftOut.find((l) => l.key === "capacity_changes")).toMatchObject({ count: 16, label: "automations and augmentations (they are part of solutions now)" });
    // A restore with that plan works, brings no changes back, and a workspace with legacy changes is still not empty to it.
    const dst = await newWorkspace("Restored");
    const result = await as(users.owner!, async (c) => (await c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, 'backup.json') as r", [dst, JSON.stringify(plan)])).rows[0].r as { counts: Record<string, number> });
    expect(result.counts.capacity_changes).toBe(0);
    expect((await q("select count(*)::int as n from capacity_changes where workspace_id = $1", [dst]))[0]!.n).toBe(0);
    const e = await fails(() => as(users.owner!, (c) => c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, null)", [w, JSON.stringify(plan)])));
    expect(e.message).toMatch(/isn't empty/);
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
});
