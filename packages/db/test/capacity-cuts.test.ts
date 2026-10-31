import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import {
  BUNDLE_TABLES,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  exportWorkspaceBundle,
  planWorkspaceImport,
  type ImportPlan,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The capacity cuts (P0, 20270118000000_capacity_cuts.sql): first principles and every share link go. The migration runs on a
// database built as it was before it (every migration up to 20270117000000) and holding a first-principles row, share links of
// every kind and a guest's sign-in; then the dropped objects are gone, the rest is untouched, and a workspace bundle still exports
// and restores, with an older bundle's first-principles rows skipped rather than refused.

const BASE = "20270117000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
let editor: User;
let admin: User;
let draftRevision: string;
let beforeCounts: Record<string, number>;

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
const count = async (table: string, where = "true") => Number((await q(`select count(*) n from public.${table} where ${where}`))[0]!.n);
const rpc = (c: pg.Client, fn: string, ...args: unknown[]) => c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then((r) => r.rows[0].r);

/** Run as a signed-in user and COMMIT (the harness's `db.as` rolls back): what one request does. */
async function as<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await fn(db.client);
    await db.client.query("commit");
    return r;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}

const TABLES_THAT_STAY = ["analysis_rules", "processes", "process_revisions", "steps", "edges", "solutions", "sources", "issues", "sandbox_scenarios", "blocks", "people", "roles", "clients"];

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  editor = await createUser(db, "cuts-editor@example.com");
  admin = await createUser(db, "cuts-admin@example.com", { agency_admin: true });
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  // A draft of the pipeline, with first principles on it, and the lever list a workspace hid.
  draftRevision = await as(editor.claims, async (c) => {
    const opened = await rpc(c, "open_draft", proc);
    return opened.revision_id as string;
  });
  await as(editor.claims, (c) => c.query("insert into public.first_principles (workspace_id, process_id, revision_id, job_who) values ($1, $2, $3, 'A founder')", [ws, proc, draftRevision]));
  await db.client.query("insert into public.lever_settings (workspace_id, hidden) values ($1, '{people.starters}')", [ws]);
  // Share links of every kind: the snapshot check is the sharing code's, so insert around it.
  await db.client.query("alter table public.share_links disable trigger user");
  for (const [i, kind] of (["overview", "process", "issue", "solution", "scenario"] as const).entries()) {
    await db.client.query(
      "insert into public.share_links (workspace_id, token_hash, kind, target_id, snapshot, engine_version, created_by) values ($1, $2, $3, $4, '{}', 'test', $5)",
      [ws, String(i).repeat(64), kind, kind === "overview" ? null : proc, editor.id],
    );
  }
  await db.client.query("insert into public.share_links (workspace_id, token_hash, kind, snapshot, engine_version, show_people, allowed_emails, expires_at) values ($1, $2, 'overview', '{}', 'test', true, '{guest@outside.org}', now() + interval '7 days')", [ws, "a".repeat(64)]);
  await db.client.query("alter table public.share_links enable trigger user");
  expect((await q("select private.may_sign_in('guest@outside.org', true) r"))[0]!.r).toBe("guest");
  beforeCounts = Object.fromEntries(await Promise.all(TABLES_THAT_STAY.map(async (t) => [t, await count(t)] as const)));
  const applied = await applyMigrations(db.client, {});
  // P0's migration first; later ones (Set up, 20270119000000) follow.
  expect(applied.files[0]).toBe("20270118000000_capacity_cuts.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration drops", () => {
  it("drops the two tables, with real rows in them", async () => {
    expect((await q("select to_regclass('public.share_links') a, to_regclass('public.first_principles') b"))[0]).toEqual({ a: null, b: null });
  });

  it("drops the share functions and the helpers only they used", async () => {
    const names = ["open_share_link", "share_team_capacity", "share_snapshot_problem", "share_links_before_write", "share_links_no_speeds", "share_emails_ok", "share_unpct", "share_norm", "share_strings", "share_name_tokens", "lever_kind_ids"];
    const left = await q("select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname = any ($1)", [names]);
    expect(left).toEqual([]);
  });

  it("leaves no other table, view or policy pointing at them", async () => {
    expect(await q("select conname from pg_constraint where pg_get_constraintdef(oid) ilike '%share_links%' or pg_get_constraintdef(oid) ilike '%first_principles%'")).toEqual([]);
    expect(await q("select policyname from pg_policies where qual ilike '%share_links%' or qual ilike '%first_principles%' or with_check ilike '%share_links%'")).toEqual([]);
    expect(await q("select viewname from pg_views where schemaname in ('public', 'private') and (definition ilike '%share_links%' or definition ilike '%first_principles%')")).toEqual([]);
  });

  it("keeps the unique index solutions depend on, and every table a user keeps, row for row", async () => {
    expect(await q("select conname from pg_constraint where conname = 'solutions_base_revision_id_process_id_workspace_id_fkey'")).toHaveLength(1);
    for (const t of TABLES_THAT_STAY) expect(await count(t), t).toBe(beforeCounts[t]);
    // This migration leaves the lever list's table alone; P9 (20270125000100_drop_lever_settings.sql, applied after it here) drops it.
    expect((await q("select to_regclass('public.lever_settings') t"))[0]!.t).toBeNull();
  });

  it("lets nobody sign in as a share link's guest any more, and still lets a deployment role in", async () => {
    expect((await q("select private.may_sign_in('guest@outside.org', true) r"))[0]!.r).toBeNull();
    await db.client.query("insert into public.deployment_access (kind, value, role) values ('email', 'viewer@client.com', 'viewer')");
    expect((await q("select private.may_sign_in('viewer@client.com', true) r"))[0]!.r).toBe("viewer");
  });
});

describe("a workspace bundle", () => {
  async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
    const bundle = await db.as(admin.claims, async (c) => {
      const read: TableReader = async (table, wsId) => {
        const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
        return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
      };
      const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
      return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
    });
    return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
  }
  let seq = 0;
  const newWorkspace = () => as(admin.claims, async (c) => (await rpc(c, "create_workspace", "Restored", `cuts-restore-${++seq}-${Date.now()}`)) as string);
  const restore = (workspace: string, plan: ImportPlan) => as(admin.claims, (c) => rpc(c, "import_workspace_bundle", workspace, JSON.stringify(plan), "backup.json"));

  const tally = async (w: string) => ({
    processes: await count("processes", `workspace_id = '${w}' and not is_company`),
    // The company map's own cards (one per process) are made by the restore, not carried by the plan.
    steps: Number((await q("select count(*) n from public.steps s join public.processes p on p.id = s.process_id where s.workspace_id = $1 and not p.is_company", [w]))[0]!.n),
    edges: Number((await q("select count(*) n from public.edges e join public.processes p on p.id = e.process_id where e.workspace_id = $1 and not p.is_company", [w]))[0]!.n),
  });
  /** Restores `plan` into a new workspace and checks that what the plan holds is what was added to it. */
  async function restoreAndCheck(plan: ImportPlan, sent: ImportPlan = plan) {
    const into = await newWorkspace();
    const before = await tally(into);
    await restore(into, structuredClone(sent));
    const after = await tally(into);
    expect(after.processes - before.processes).toBe(plan.processes.length);
    expect(after.steps - before.steps).toBe(plan.processes.reduce((n, p) => n + p.steps.length, 0));
    expect(after.edges - before.edges).toBe(plan.processes.reduce((n, p) => n + p.edges.length, 0));
  }

  it("exports without first principles and restores", async () => {
    const bundle = await exportOf(ws);
    expect(Object.keys(bundle)).not.toContain("first_principles");
    for (const p of bundle.processes) for (const v of p.versions as Row[]) expect(v).not.toHaveProperty("first_principles");
    const { plan } = planWorkspaceImport(bundle, { canManage: true });
    for (const p of plan.processes) expect(p).not.toHaveProperty("first_principles");
    await restoreAndCheck(plan);
  });

  it("restores an older bundle that still has first-principles rows, skipping them", async () => {
    const bundle = await exportOf(ws);
    const older = structuredClone(bundle);
    for (const p of older.processes) {
      for (const v of p.versions as Row[]) v.first_principles = { id: "00000000-0000-4000-8000-0000000000f1", process_id: p.id, revision_id: v.id, workspace_id: ws, job_who: "A founder", job_done: "Signed", statements: [] };
    }
    const { plan } = planWorkspaceImport(older, { canManage: true });
    for (const p of plan.processes) expect(p).not.toHaveProperty("first_principles");
    await restoreAndCheck(plan);
  });

  it("restores a plan whose process still carries first_principles: the SQL skips it", async () => {
    const { plan } = planWorkspaceImport(await exportOf(ws), { canManage: true });
    const withFp = structuredClone(plan) as ImportPlan;
    for (const p of withFp.processes) (p as unknown as Row).first_principles = { job_who: "A founder", job_done: "Signed" };
    await restoreAndCheck(plan, withFp);
  });
});
