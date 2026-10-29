import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { BUNDLE_TABLES, NORTHBEAM_WORKSPACE_ID, exportWorkspaceBundle, parseChanges, planWorkspaceImport, type Row, type TableReader, type WorkspaceBundle } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// A note on a change (sandbox phase 5a, migration 20270115000000_sandbox_change_notes.sql): the migration runs on a database full of
// real-shaped rows. It is built as it was before it (every migration up to 20270114000000), given library rows, a build-on chain and
// timed changes, and then migrated: every row still passes, nothing is rewritten, a note is accepted and the bad shapes are refused
// through a direct update, and a restore round-trips a note.

const BASE = "20270114000000";
const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let admin: { id: string; claims: Record<string, unknown> };
let before: Row[];
const ids = { root: "", child: "", grandchild: "" };

const change = (n: number, extra: Record<string, unknown> = {}) => ({ id: `5c000000-0000-4000-8000-${String(n).padStart(12, "0")}`, lever: "A1", target: null, op: "multiply", value: 1.25, ...extra });
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
const sandboxRows = () => q("select to_jsonb(s) as j from public.sandbox_scenarios s order by id");
const rpc = (c: pg.Client, fn: string, ...args: unknown[]) => c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then((r) => r.rows[0].r);

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  admin = await createUser(db, "notes-admin@example.com", { agency_admin: true });
  const insert = async (name: string, changes: unknown[], parent: string | null = null) =>
    (await db.client.query("insert into public.sandbox_scenarios (workspace_id, name, parent_id, changes) values ($1, $2, $3, $4::jsonb) returning id", [ws, name, parent, JSON.stringify(changes)])).rows[0].id as string;
  // A library-shaped row (the four every workspace gets are already there), a build-on chain, and timed changes of several levers.
  ids.root = await insert("Notes root", [change(1), change(2, { lever: "D1", target: "b0000000-0000-4000-8000-000000000005", op: "set", value: 1, from: "2027-03", params: { name: "Jade" } })]);
  ids.child = await insert("Notes child", [change(3, { lever: "B5", op: "set", value: 0.08, from: "2027-04" })], ids.root);
  ids.grandchild = await insert("Notes grandchild", [], ids.child);
  before = await sandboxRows();
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270115000000_sandbox_change_notes.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration does to stored rows", () => {
  it("has the seeded library and the chain to test on", () => {
    expect(before.length).toBeGreaterThanOrEqual(7);
    expect(before.filter((r) => (r.j as Row).parent_id !== null).length).toBeGreaterThanOrEqual(2);
  });

  it("writes no row: every scenario is as it was, and every one still passes the change check", async () => {
    expect(await sandboxRows()).toEqual(before);
    expect((await q("select count(*) from public.sandbox_scenarios where not private.is_sandbox_changes(changes)"))[0]!.count).toBe("0");
  });
});

describe("notes", () => {
  const update = (changes: unknown) => db.client.query("update public.sandbox_scenarios set changes = $2::jsonb where id = $1", [ids.root, JSON.stringify(changes)]);
  const withNote = (note: unknown) => [change(1, { note })];

  it("accepts a note, a 280-character note and a 280-emoji note through a direct update", async () => {
    await update(withNote("Assumes the Q3 campaign doubles leads."));
    await update(withNote("x".repeat(280)));
    await update(withNote("\u{1F600}".repeat(280)));
    await update([change(1, { note: "Why" }), change(2, { lever: "D1", target: "b0000000-0000-4000-8000-000000000005", op: "set", value: 1, from: "2027-03", params: { name: "Jade" }, note: "Replaces Sam" })]);
  });

  it.each([
    ["281 characters", "x".repeat(281)],
    ["an empty note", ""],
    ["a leading space", " x"],
    ["a trailing line break", "x\n"],
    ["a number", 5],
    ["null", null],
    ["an object", { text: "x" }],
  ])("refuses %s through a direct update", async (_name, note) => {
    await expect(update(withNote(note))).rejects.toThrow(/sandbox_scenarios_changes|changes/);
  });

  it("still refuses an unknown key", async () => {
    await expect(update([change(1, { memo: "x" })])).rejects.toThrow();
  });

  it("agrees with parseChanges on the note rules", async () => {
    for (const note of ["ok", "x".repeat(280), "x".repeat(281), "", " x", "x ", "a\nb", "\tx"]) {
      const sql = (await q("select private.is_sandbox_changes($1::jsonb) as ok", [JSON.stringify(withNote(note))]))[0]!.ok;
      expect(parseChanges(withNote(note)).ok, JSON.stringify(note)).toBe(sql);
    }
  });

  it("a note stays on its change when the scenario is duplicated or built on (the changes are copied whole)", async () => {
    await update([change(1, { note: "Kept" })]);
    const copy = (await db.client.query("insert into public.sandbox_scenarios (workspace_id, name, changes) select workspace_id, 'Notes copy', changes from public.sandbox_scenarios where id = $1 returning changes", [ids.root])).rows[0].changes;
    expect(copy).toEqual([change(1, { note: "Kept" })]);
  });

  it("a restore round-trips a note, and the plan keeps it", async () => {
    await update([change(1, { note: "Round trip" })]);
    const bundle = JSON.parse(
      JSON.stringify(
        await db.as(admin.claims, async (c) => {
          const read: TableReader = async (table, wsId) => {
            const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
            return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
          };
          const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
          return exportWorkspaceBundle(ws, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
        }),
      ),
    ) as WorkspaceBundle;
    const plan = structuredClone(planWorkspaceImport(bundle, { canManage: true }).plan);
    const planned = plan.sandbox_scenarios.find((r) => r.name === "Notes root")!;
    expect((planned.changes as Row[])[0]!.note).toBe("Round trip");
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin.claims)]);
      const made = (await rpc(db.client, "create_workspace", "Restored notes", `notes-restore-${Date.now()}`)) as string;
      await rpc(db.client, "import_workspace_bundle", made, JSON.stringify(plan), "backup.json");
      const restored = (await db.client.query("select changes from public.sandbox_scenarios where workspace_id = $1 and name = 'Notes root'", [made])).rows[0]?.changes as Row[];
      expect(restored[0]!.note).toBe("Round trip");
    } finally {
      await db.client.query("rollback");
    }
  });
});
