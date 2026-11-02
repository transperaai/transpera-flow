import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_TABLES,
  IMPORT_COLUMNS,
  NORTHBEAM_WORKSPACE_ID,
  exportWorkspaceBundle,
  planWorkspaceImport,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { applyMigrations } from "../src/migrations";
import { createTestDb, createUser, type TestDb } from "./harness";
import { headerRollback } from "./header-rollback";

// A process's department (capacity Q4, migration 20270127000000_process_department.sql): the column starts null on every process, only a
// department of the same workspace fits, deleting a department clears it, a signed-in owner sets it through save_fields, and a backup
// carries it through a restore (the departments are written first, so the new ids resolve).

const BASE = "20270125000100";
const OLD_WS = "00000000-0000-4000-8000-0000000000b1";

let db: TestDb;
let old: { id: string; department_id?: string }[];

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE, seed: false });
  await db.client.query("insert into public.workspaces (id, name, slug) values ($1, 'Before Q4', 'before-q4')", [OLD_WS]);
  await db.client.query("insert into public.processes (workspace_id, name, kind, entity_name) values ($1, 'Old pipeline', 'pipeline', 'lead')", [OLD_WS]);
  old = (await q("select id from public.processes where workspace_id = $1 and name = 'Old pipeline'", [OLD_WS])) as typeof old;
  const applied = await applyMigrations(db.client, {});
  expect(applied.files).toContain("20270127000000_process_department.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the department column", () => {
  it("leaves every existing process unset, which means worked out", async () => {
    const rows = await q("select department_id, whole_business from public.processes where workspace_id = $1", [OLD_WS]);
    // The pipeline, and the company map the workspace made for itself.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.department_id === null && r.whole_business === false)).toBe(true);
  });

  it("takes a department of the same workspace, and refuses another workspace's", async () => {
    const [mine] = await q("select id from public.departments where workspace_id = $1 order by sort limit 1", [OLD_WS]);
    await db.client.query("update public.processes set department_id = $1 where id = $2", [mine!.id, old[0]!.id]);
    expect((await q("select department_id from public.processes where id = $1", [old[0]!.id]))[0]!.department_id).toBe(mine!.id);

    await db.client.query("insert into public.workspaces (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other', 'other-q4')");
    const [theirs] = await q("select id from public.departments where workspace_id = '00000000-0000-4000-8000-0000000000b2' limit 1");
    await expect(db.client.query("update public.processes set department_id = $1 where id = $2", [theirs!.id, old[0]!.id])).rejects.toThrow(/processes_department_fkey/);
  });

  it("keeps whole business apart from a department, so both can never be set", async () => {
    const [mine] = await q("select id from public.departments where workspace_id = $1 order by sort limit 1", [OLD_WS]);
    await db.client.query("update public.processes set whole_business = true, department_id = null where id = $1", [old[0]!.id]);
    await expect(db.client.query("update public.processes set department_id = $1 where id = $2", [mine!.id, old[0]!.id])).rejects.toThrow(/processes_department_or_whole/);
    await db.client.query("update public.processes set whole_business = false, department_id = $1 where id = $2", [mine!.id, old[0]!.id]);
  });

  it("is cleared, not the process, when its department is deleted", async () => {
    const [d] = await q("select department_id from public.processes where id = $1", [old[0]!.id]);
    await db.client.query("delete from public.departments where id = $1", [d!.department_id]);
    const rows = await q("select name, department_id from public.processes where id = $1", [old[0]!.id]);
    expect(rows).toEqual([{ name: "Old pipeline", department_id: null }]);
  });

  it("is a column a restore accepts", () => {
    expect(IMPORT_COLUMNS.processes).toContain("department_id");
    expect(IMPORT_COLUMNS.processes).toContain("whole_business");
  });
});

describe("the rollback in the migration's header", () => {
  it("runs, and removes the column", async () => {
    const own = await createTestDb();
    try {
      await own.client.query(headerRollback("20270127000000_process_department.sql"));
      const left = await own.client.query("select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'processes' and column_name = 'department_id'");
      expect(left.rows[0].n).toBe(0);
      expect((await own.client.query("select count(*)::int as n from public.processes")).rows[0].n).toBeGreaterThan(0);
    } finally {
      await own.close();
    }
  }, 60_000);
});

describe("a backup and restore", () => {
  let owner: { id: string; claims: Record<string, unknown> };
  let admin: { id: string; claims: Record<string, unknown> };

  it("carries a process's department to the new workspace's department of the same name", async () => {
    // A fresh database with the seeded Northbeam workspace: put one process under its second department.
    const fresh = await createTestDb();
    try {
      owner = await createUser(fresh, "owner@q4-department.example.com");
      admin = await createUser(fresh, "admin@q4-department.example.com", { agency_admin: true });
      await fresh.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, owner.id]);
      const depts = (await fresh.client.query("select id, name from public.departments where workspace_id = $1 order by sort", [NORTHBEAM_WORKSPACE_ID])).rows;
      expect(depts.length).toBeGreaterThanOrEqual(2);
      const target = depts[1]!;
      const [proc] = (await fresh.client.query("select id, name from public.processes where workspace_id = $1 and not is_company and archived_at is null and live_revision_id is not null order by created_at, id limit 1", [NORTHBEAM_WORKSPACE_ID])).rows;
      // As the owner, through the same function the page uses.
      const saved = await fresh.as(owner.claims, async (c) =>
        (await c.query("select public.save_fields('processes', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id: proc.id }), JSON.stringify({ department_id: null }), JSON.stringify({ department_id: target.id })])).rows[0].r,
      );
      expect(saved.status).toBe("saved");
      await fresh.client.query("update public.processes set department_id = $1 where id = $2", [target.id, proc.id]);

      const bundle = JSON.parse(
        JSON.stringify(
          await fresh.as(owner.claims, async (c) => {
            const read: TableReader = async (table, wsId) => {
              const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
              return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
            };
            const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
            return exportWorkspaceBundle(NORTHBEAM_WORKSPACE_ID, readWorkspace, read, { canEdit: true, now: new Date("2026-11-02T12:00:00Z") });
          }),
        ),
      ) as WorkspaceBundle;
      expect(bundle.processes.find((p) => p.id === proc.id)?.department_id).toBe(target.id);
      // Another process put under Sales and whole business on purpose.
      const [other] = (await fresh.client.query("select id, name from public.processes where workspace_id = $1 and not is_company and archived_at is null and live_revision_id is not null and id <> $2 order by created_at, id limit 1", [NORTHBEAM_WORKSPACE_ID, proc.id])).rows;
      await fresh.client.query("update public.processes set whole_business = true where id = $1", [other.id]);
      bundle.processes.find((p) => p.id === other.id)!.whole_business = true;

      const { plan } = planWorkspaceImport(bundle, { canManage: true });
      const planned = plan.processes.find((p) => p.name === proc.name)!;
      expect(planned.department_id).toMatch(/^00000000-0000-4000-8000-/);
      expect(plan.processes.filter((p) => p.department_id !== null)).toHaveLength(1);

      await fresh.client.query("begin");
      await fresh.client.query("set local role authenticated");
      await fresh.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin.claims)]);
      const ws = (await fresh.client.query("select public.create_workspace($1, $2) as id", ["Restored Q4", `restored-q4-${Date.now()}`])).rows[0].id as string;
      await fresh.client.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, 'backup.json')", [ws, JSON.stringify(plan)]);
      await fresh.client.query("commit");

      const restored = (await fresh.client.query("select p.name, d.name as department from public.processes p left join public.departments d on d.id = p.department_id and d.workspace_id = p.workspace_id where p.workspace_id = $1 and p.department_id is not null", [ws])).rows;
      expect(restored).toEqual([{ name: proc.name, department: target.name }]);
      const whole = (await fresh.client.query("select name from public.processes where workspace_id = $1 and whole_business", [ws])).rows;
      expect(whole).toEqual([{ name: other.name }]);
    } finally {
      await fresh.close();
    }
  }, 120_000);
});
