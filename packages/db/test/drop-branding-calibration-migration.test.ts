import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_TABLES,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  exportWorkspaceBundle,
  northbeamPersonIds,
  northbeamStepIds,
  planWorkspaceImport,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { applyMigrations } from "../src/migrations";
import { createTestDb, createUser, type TestDb } from "./harness";

// Branding, Historical data and the Change log are cut (Q19, D70-D72; migration 20270200000000_drop_branding_and_calibration.sql).
// The migration runs on a database as it was before it, holding a logo, a dataset with a calibration and its per-person proposal,
// and provenance entries that calibration stamped next to ones a person picked. Then: the tables and functions are gone, a measured
// entry is an entered one, a person's own "measured" source label is kept, a backup still restores, and the version history still
// names who published and why.

const BASE = "20270134000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const ids = northbeamStepIds;
const MIGRATION = "20270200000000_drop_branding_and_calibration.sql";

let db: TestDb;
let owner: { id: string; claims: Record<string, unknown> };
let admin: { id: string; claims: Record<string, unknown> };
const dataset = randomUUID();
const calibration = randomUUID();

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}
const stamp = (extra: Record<string, unknown> = {}) => ({ source: "measured", at: "2026-10-01T00:00:00Z", dataset_id: dataset, calibration_id: calibration, ...extra });

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE, supabaseDefaultPrivileges: true });
  owner = await createUser(db, "owner@drop-branding.example.com");
  admin = await createUser(db, "admin@drop-branding.example.com", { agency_admin: true });
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, owner.id]);

  // What the old release held. Triggers are off for the set-up so the rows are exactly as written here.
  await db.client.query("set session_replication_role = replica");
  await db.client.query(
    "insert into workspace_logos (workspace_id, mime, bytes, sha256) values ($1, 'image/png', '\\x89504e47'::bytea, encode(sha256('\\x89504e47'::bytea), 'hex'))",
    [ws],
  );
  await db.client.query("update workspaces set branding = '{\"accent\": \"#112233\"}'::jsonb where id = $1", [ws]);
  await db.client.query("insert into datasets (id, workspace_id, kind, file_name, row_count) values ($1, $2, 'step_log', 'log.csv', 3)", [dataset, ws]);
  await db.client.query("insert into calibrations (id, workspace_id, dataset_id, process_id, results) values ($1, $2, $3, $4, '{\"proposals\": []}'::jsonb)", [calibration, ws, dataset, proc]);
  await db.client.query(
    "insert into capacity_factor_proposals (calibration_id, workspace_id, person_id, step_id, proposal) values ($1, $2, $3, $4, '{}'::jsonb)",
    [calibration, ws, northbeamPersonIds["Sam Patel"], ids.audit],
  );
  // Steps: stamped entries become entered; the person's source label "measured" under `work` has neither key and stays.
  await db.client.query("update steps set provenance = $2::jsonb where id = $1", [
    ids.audit,
    JSON.stringify({
      work_hours: stamp({ n: 40 }),
      wait_hours: stamp({ dataset_id: null, evidence: [{ source_id: dataset, quote: "q" }] }),
      rework_rate: { source: "entered", at: "2026-10-01T00:00:00Z" },
      work: { source: "measured", at: "2026-10-01T00:00:00Z", by: owner.id },
      sla_hours: { source: "estimated", assumption: true },
    }),
  ]);
  await db.client.query("update lead_sources set provenance = jsonb_build_object('volume_week', $2::jsonb) where id = (select id from lead_sources where workspace_id = $1 order by id limit 1)", [ws, JSON.stringify(stamp({ n: 90 }))]);
  await db.client.query("update client_groups set provenance = jsonb_build_object('churn_monthly', $2::jsonb) where id = (select id from client_groups where workspace_id = $1 order by id limit 1)", [ws, JSON.stringify(stamp({ leavers: 6 }))]);
  await db.client.query("update services set provenance = jsonb_build_object('price', jsonb_build_object('source', 'measured', 'at', '2026-10-01T00:00:00Z')) where id = (select id from services where workspace_id = $1 order by id limit 1)", [ws]);
  await db.client.query("update workspaces set provenance = jsonb_build_object('settings.health_recover', $2::jsonb) where id = $1", [ws, JSON.stringify(stamp())]);
  // A per-person time: one with the keys, one without (only calibration ever wrote a person's time as measured).
  await db.client.query("delete from person_capacity_factors where workspace_id = $1", [ws]);
  await db.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor, provenance) values ($1, $2, $3, 0.8, $4::jsonb), ($1, $2, null, 1.1, $5::jsonb)", [
    northbeamPersonIds["Sam Patel"],
    ws,
    ids.audit,
    JSON.stringify({ factor: stamp({ n: 12 }) }),
    JSON.stringify({ factor: { source: "measured", n: 11 } }),
  ]);
  await db.client.query("set session_replication_role = origin");
  await db.client.query("update workspaces set settings = settings || '{\"capacity_factor_enabled\": true}'::jsonb where id = $1", [ws]);

  const applied = await applyMigrations(db.client, {});
  expect(applied.files).toContain(MIGRATION);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the tables and functions are gone", () => {
  it("drops the logo, calibration, dataset and proposal tables and the branding column", async () => {
    for (const t of ["workspace_logos", "calibrations", "datasets", "capacity_factor_proposals"]) {
      expect((await q("select to_regclass($1) as r", [`public.${t}`]))[0]!.r, t).toBeNull();
    }
    expect(await q("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding'")).toEqual([]);
    expect(await q("select 1 from pg_constraint where conname = 'workspaces_branding_shape'")).toEqual([]);
  });

  it("drops every function that wrote or read them, in every overload, and their helpers", async () => {
    const names = [
      "apply_calibration", "record_calibration", "record_calibration_import", "record_client_calibration", "record_dataset", "workspace_logo",
      "calibrations_before_write", "calibration_payload_problem", "audit_workspace_logo_write", "q19_unmeasured", "q19_unmeasured_bundle",
    ];
    expect(await q("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname = any($1)", [names])).toEqual([]);
    expect(await q("select 1 from pg_trigger where tgname = 'audit_logo'")).toEqual([]);
  });

  it("keeps the audit log and what writes and reads it", async () => {
    expect((await q("select to_regclass('public.audit_log') as r"))[0]!.r).toBe("audit_log");
    // map_cards_removed is an audit action written by a trigger on processes; the trigger stays.
    expect((await q("select count(*)::int n from pg_trigger where not tgisinternal and tgrelid = 'public.processes'::regclass and pg_get_functiondef(tgfoid) like '%map_cards_removed%'"))[0]!.n).toBeGreaterThan(0);
    for (const f of ["revision_history", "restore_version", "log_process_import", "agency_workspace_list", "import_workspace_bundle"]) {
      expect((await q("select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [f]))[0]!.n, f).toBeGreaterThan(0);
    }
  });
});

describe("a measured provenance entry becomes entered", () => {
  it("rewrites the entries calibration stamped on a step, dropping the dataset and calibration keys", async () => {
    const p = (await q("select provenance from steps where id = $1", [ids.audit]))[0]!.provenance as Record<string, Record<string, unknown>>;
    expect(p.work_hours).toEqual({ source: "entered", at: "2026-10-01T00:00:00Z", n: 40 });
    expect(p.wait_hours).toMatchObject({ source: "entered", evidence: [{ source_id: dataset, quote: "q" }] });
    expect(p.wait_hours).not.toHaveProperty("dataset_id");
    expect(p.wait_hours).not.toHaveProperty("calibration_id");
    // Left alone: an entered entry, an estimate, and the label a person picked.
    expect(p.rework_rate).toEqual({ source: "entered", at: "2026-10-01T00:00:00Z" });
    expect(p.sla_hours).toEqual({ source: "estimated", assumption: true });
    expect(p.work).toEqual({ source: "measured", at: "2026-10-01T00:00:00Z", by: owner.id });
  });

  it("does the same for lead sources, client groups, the workspace and per-person times, and keeps a person's own label", async () => {
    expect((await q("select provenance -> 'volume_week' as e from lead_sources where workspace_id = $1 and provenance ? 'volume_week'", [ws]))[0]!.e).toEqual({ source: "entered", at: "2026-10-01T00:00:00Z", n: 90 });
    expect((await q("select provenance -> 'churn_monthly' as e from client_groups where workspace_id = $1 and provenance ? 'churn_monthly'", [ws]))[0]!.e).toEqual({ source: "entered", at: "2026-10-01T00:00:00Z", leavers: 6 });
    expect((await q("select provenance -> 'settings.health_recover' as e from workspaces where id = $1", [ws]))[0]!.e).toEqual({ source: "entered", at: "2026-10-01T00:00:00Z" });
    expect((await q("select provenance -> 'price' as e from services where workspace_id = $1 and provenance ? 'price'", [ws]))[0]!.e).toEqual({ source: "measured", at: "2026-10-01T00:00:00Z" });
    const factors = await q("select step_id, provenance -> 'factor' as e from person_capacity_factors where workspace_id = $1 order by step_id nulls first", [ws]);
    expect(factors.map((f) => (f.e as { source: string }).source)).toEqual(["entered", "entered"]);
    expect(factors.map((f) => Object.keys(f.e as object).sort())).toEqual([["n", "source"], ["at", "n", "source"]]);
  });

  it("leaves nothing a calibration stamped, anywhere in the database", async () => {
    const tables = await q("select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid and c.relkind = 'r' join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where a.attname = 'provenance' and a.atttypid = 'jsonb'::regtype");
    expect(tables.length).toBeGreaterThan(10);
    for (const { relname } of tables) {
      const left = await q(`select count(*)::int n from public.${relname} where provenance::text ~ '"(dataset_id|calibration_id)"'`);
      expect(left[0]!.n, String(relname)).toBe(0);
    }
  });

  it("returns a person's time without a source or a visit count", async () => {
    const t = await commitAs(owner.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t as { person_capacity_factors?: Record<string, unknown>[] });
    // The owner is not linked to a person, so they see everyone's only when they see everyone; Agency admins do.
    const all = await commitAs(admin.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t as { person_capacity_factors: Record<string, unknown>[] });
    expect(all.person_capacity_factors).toHaveLength(2);
    for (const f of all.person_capacity_factors) expect(Object.keys(f).sort()).toEqual(["factor", "person_id", "step_id", "workspace_id"]);
    expect(t).toBeDefined();
  });
});

describe("backup and restore still work", () => {
  it("exports a workspace and restores it into a new one", async () => {
    const bundle = await commitAs(admin.claims, async (c) => {
      const read: TableReader = async (table, wsId) => {
        const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
        return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
      };
      const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
      return JSON.parse(JSON.stringify(await exportWorkspaceBundle(ws, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") }))) as WorkspaceBundle;
    });
    const planned = planWorkspaceImport(bundle, { canManage: true });
    const target = await commitAs(admin.claims, async (c) => (await c.query("select public.create_workspace('Restored', $1) as id", [`restored-${Date.now()}`])).rows[0].id as string);
    const restored = await commitAs(admin.claims, async (c) => (await c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, 'backup.json') as r", [target, JSON.stringify(planned.plan)])).rows[0].r as { processes: unknown[]; counts: Record<string, number> });
    expect(restored.processes.length).toBeGreaterThan(0);
    const n = async (table: string, id: string) => (await q(`select count(*)::int n from public.${table} where workspace_id = $1`, [id]))[0]!.n as number;
    expect(await n("people", target)).toBe(await n("people", ws));
    expect(await n("lead_sources", target)).toBe(await n("lead_sources", ws));
    // The restored provenance carries no calibration stamp either.
    expect((await q("select count(*)::int n from steps where workspace_id = $1 and provenance::text ~ '\"(dataset_id|calibration_id)\"'", [target]))[0]!.n).toBe(0);
  });
});

describe("the version history still names who published and why", () => {
  it("returns the author and the publish note", async () => {
    await commitAs(owner.claims, async (c) => (await c.query("select public.open_draft($1)", [proc])).rows);
    const published = await commitAs(owner.claims, async (c) => (await c.query("select public.publish_process($1, true) as r", [proc])).rows[0].r as { status: string; revision_id: string });
    expect(published.status).toBe("published");
    // The publish note is read from the audit log, which the migration keeps.
    await db.client.query(
      "insert into audit_log (workspace_id, actor_kind, action, target_table, target_id, diff) values ($1, 'user', 'publish', 'processes', $2, $3::jsonb)",
      [ws, proc, JSON.stringify({ revision_id: published.revision_id, note: "Tightened the audit step" })],
    );
    const rows = await commitAs(owner.claims, async (c) => (await c.query("select number, status, author_kind, author_name, note from revision_history($1)", [proc])).rows);
    expect(rows[0]).toMatchObject({ status: "published", author_kind: "user", author_name: "owner@drop-branding.example.com", note: "Tightened the audit step" });
    expect(rows.length).toBeGreaterThan(1);
  });
});
