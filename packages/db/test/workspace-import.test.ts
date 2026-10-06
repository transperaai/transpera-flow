import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import { timeSplitOf, workingShare } from "../../../apps/web/src/lib/overview/time-split";
import type pg from "pg";
import {
  BUNDLE_TABLES,
  IMPORT_COLUMNS,
  IMPORT_REFS,
  IMPORT_STEP_REFS,
  LARKSPUR_WORKSPACE_ID,
  NORTHBEAM_WORKSPACE_ID,
  PLACEHOLDER_PREFIX,
  WORKSPACE_IMPORT_LIMITS,
  checkWorkspaceBundle,
  exportWorkspaceBundle,
  planWorkspaceImport,
  toEngineModel,
  type ImportPlan,
  type ProcessBundle,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// B10 (2b, issue #39, migration 20261207000000): `import_workspace_bundle` restores a workspace backup into a new, empty
// workspace as drafts, all or nothing, as the signed-in user. Made with Supabase's default privileges, as production.

let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
let admin: User;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  admin = await createUser(db, "admin@import-workspace.example.com", { agency_admin: true });
});
afterAll(async () => {
  await db?.close();
});

/** Run as a signed-in user and COMMIT (the harness's `db.as` rolls back): what one PostgREST request does. */
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

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
const count = async (table: string, ws: string, where = "true") => Number((await q(`select count(*) from public.${table} where workspace_id = $1 and ${where}`, [ws]))[0]!.count);

/** An agency admin creates a new, empty workspace. */
async function newWorkspace(name = "Restored Co"): Promise<string> {
  seq++;
  return as(admin.claims, async (c) => (await c.query("select public.create_workspace($1, $2) as id", [name, `restored-${seq}-${Date.now()}`])).rows[0].id as string);
}

async function member(ws: string, role: string): Promise<User> {
  const user = await createUser(db, `u${++seq}.${role}@import-workspace.example.com`);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  return user;
}

/** A backup of a seeded workspace, as an editor exports it. */
async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
  const editor = await member(workspaceId, "editor");
  const bundle = await db.as(editor.claims, async (c) => {
    const read: TableReader = async (table, wsId) => {
      const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
      // As JSON, the way PostgREST answers (dates as text, numbers as numbers), not as pg's Date objects.
      return (await c.query(`select to_jsonb(t) as j from (select ${spec.columns ?? "*"} from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
    };
    const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
    return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
  });
  return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
}

const bundles = new Map<string, WorkspaceBundle>();
async function bundleOf(ws: string): Promise<WorkspaceBundle> {
  if (!bundles.has(ws)) bundles.set(ws, await exportOf(ws));
  return structuredClone(bundles.get(ws)!);
}

interface Restored {
  id_prefix: string;
  processes: { id: string; name: string; revision_id: string; archived: boolean }[];
  counts: Record<string, number>;
  skipped: Record<string, number>;
  settings: string;
}
const callRestore = (c: pg.Client, ws: string, plan: unknown, label: string | null = "backup.json") =>
  c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, $3) as r", [ws, JSON.stringify(plan), label]).then((r) => r.rows[0].r as Restored);

const restoreAs = (user: User, ws: string, plan: unknown, label: string | null = "backup.json") => as(user.claims, (c) => callRestore(c, ws, plan, label));

async function failure(fn: () => Promise<unknown>): Promise<{ code?: string; message: string; hint?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string; hint?: string };
  }
  throw new Error("expected the call to fail");
}

/** Counts of every table a restore writes to, for a workspace, so "nothing was written" can be compared. */
const TABLES = [
  "roles", "people", "person_roles", "person_leave", "person_skills", "lead_sources", "seasonality", "demand_settings", "churn_drivers", "market_conditions", "market_schedule",
  "lever_settings", "analysis_rules", "clients", "client_services", "client_assignments", "services", "service_servicing", "client_groups", "sources", "source_links", "processes",
  "process_revisions", "steps", "edges", "first_principles", "scenarios", "blocks", "issues", "issue_links", "issue_owners", "issue_sources", "issue_events", "suggestions",
  "suggestion_proposals", "solutions", "audit_log",
];
async function snapshot(ws: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await count(t, ws);
  out.settings = Number((await q("select count(*) from workspaces where id = $1 and settings = (select settings from workspaces where id = $1)", [ws]))[0]!.count);
  return out;
}

/** The owner of a new workspace and its restore, in one go. */
async function restoreInto(bundle: WorkspaceBundle, role = "owner", options: { canManage?: boolean; label?: string | null } = {}) {
  const ws = await newWorkspace();
  const user = await member(ws, role);
  const planned = planWorkspaceImport(bundle, { canManage: options.canManage ?? (role === "owner") });
  const result = await restoreAs(user, ws, planned.plan, options.label === undefined ? "backup.json" : options.label);
  return { ws, user, result, ...planned };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The loader of the round trip: database.test.ts's `loadSeeded`, for any workspace (and its market, churn drivers and client groups).

async function loadPipeline(claims: Record<string, unknown>, wsId: string): Promise<ProcessBundle> {
  return db.as(claims, async (c) => {
    const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0];
    const many = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows;
    const workspace = await one("select id, name, slug, settings from workspaces where id = $1", [wsId]);
    const process = await one("select * from processes where workspace_id = $1 and kind = 'pipeline' and not is_company and archived_at is null", [wsId]);
    const servicing = await many("select * from processes where workspace_id = $1 and kind = 'servicing' and archived_at is null order by id", [wsId]);
    const otherProcesses = [];
    for (const p of servicing) {
      otherProcesses.push({
        process: p,
        revision: await one("select * from process_revisions where id = $1", [p.live_revision_id]),
        steps: await many("select * from steps where revision_id = $1", [p.live_revision_id]),
        edges: await many("select * from edges where revision_id = $1", [p.live_revision_id]),
      });
    }
    return {
      workspace,
      process,
      revision: await one("select * from process_revisions where id = $1", [process.live_revision_id]),
      roles: await many("select * from roles where workspace_id = $1", [wsId]),
      steps: await many("select * from steps where revision_id = $1", [process.live_revision_id]),
      edges: await many("select * from edges where revision_id = $1", [process.live_revision_id]),
      people: await many("select * from people where workspace_id = $1", [wsId]),
      personRoles: await many("select * from person_roles where workspace_id = $1", [wsId]),
      personSkills: await many("select * from person_skills where workspace_id = $1", [wsId]),
      personLeave: await many("select id, person_id, workspace_id, start_date::text, end_date::text from person_leave where workspace_id = $1", [wsId]),
      services: await many("select * from services where workspace_id = $1", [wsId]),
      leadSources: await many("select * from lead_sources where workspace_id = $1", [wsId]),
      seasonality: await many("select * from seasonality where workspace_id = $1", [wsId]),
      demand: (await one("select * from demand_settings where workspace_id = $1", [wsId])) ?? null,
      clients: await many("select id, workspace_id, name, start_date::text, mrr, health, provenance, notes, active from clients where workspace_id = $1", [wsId]),
      clientServices: await many("select * from client_services where workspace_id = $1", [wsId]),
      clientAssignments: await many("select * from client_assignments where workspace_id = $1", [wsId]),
      clientGroups: await many("select id, workspace_id, service_id, client_count, fee, churn_monthly, stay_months, starting_health, provenance from client_groups where workspace_id = $1 order by created_at, id", [wsId]),
      servicingLinks: await many("select * from service_servicing where workspace_id = $1", [wsId]),
      churnDrivers: await many("select id, workspace_id, driver, name, description, example, weight, enabled, value, month, provenance from churn_drivers where workspace_id = $1 order by created_at, id", [wsId]),
      marketConditions: await many("select id, workspace_id, name, preset, leads, conv, cycle, price, churn, hire, pay from market_conditions where workspace_id = $1 order by created_at, id", [wsId]),
      marketSchedule: await many("select id, workspace_id, from_month, to_month, condition_id from market_schedule where workspace_id = $1 order by from_month, id", [wsId]),
      otherProcesses,
    } as ProcessBundle;
  });
}

/** Replace every restored id in `value` by the old one it stands for. */
function backToOld(value: unknown, restored: Restored, ws: string, placeholderOf: Map<string, string>, oldWorkspace: string): string {
  let text = JSON.stringify(value);
  for (const [old, ph] of placeholderOf) {
    const fresh = old === oldWorkspace ? ws : restored.id_prefix + ph.slice(PLACEHOLDER_PREFIX.length);
    text = text.split(fresh).join(old);
  }
  return text;
}

describe("a restore is a round trip", () => {
  beforeAll(async () => {
    // A custom market condition (older than any preset a new workspace is seeded with) and a schedule using it and a preset, in both
    // golden workspaces, so the market comes back too.
    for (const ws of [NORTHBEAM_WORKSPACE_ID, LARKSPUR_WORKSPACE_ID]) {
      const [c] = await q(
        "insert into market_conditions (workspace_id, name, leads, conv, cycle, price, churn, hire, pay, created_at) values ($1, 'Supplier squeeze', 90, 95, 110, 105, 120, 100, 100, '2026-01-02T00:00:00Z') returning id",
        [ws],
      );
      const [boom] = await q("select id from market_conditions where workspace_id = $1 and preset = 'boom'", [ws]);
      await q("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 2, 4, $2), ($1, 6, 9, $3)", [ws, c!.id, boom!.id]);
    }
  });

  describe.each([
    ["Northbeam", NORTHBEAM_WORKSPACE_ID],
    ["Larkspur", LARKSPUR_WORKSPACE_ID],
  ])("%s", (_name, source) => {
    it("is restored, published, and simulates to the same model and headline results within run-to-run variation", async () => {
      const bundle = await bundleOf(source);
      const check = checkWorkspaceBundle(bundle);
      expect(check.errors).toEqual([]);
      const ws = await newWorkspace(bundle.workspace.name);
      const owner = await member(ws, "owner");
      const planned = planWorkspaceImport(bundle, { canManage: true });
      const restored = await restoreAs(owner, ws, planned.plan);

      // Only drafts exist, numbered from 1, before anything is published.
      const revisions = await q("select r.status, r.number from process_revisions r join processes p on p.id = r.process_id where r.workspace_id = $1 and not p.is_company", [ws]);
      expect(revisions.length).toBe(restored.processes.length);
      expect(revisions.every((r) => r.status === "draft" && r.number === 1)).toBe(true);

      // Publish every restored process; the order that works is children before the processes that hold them.
      const pending = restored.processes.filter((p) => !p.archived).map((p) => p.id);
      const order: string[] = [];
      for (let pass = 0; pending.length > 0 && pass < 10; pass++) {
        for (const id of [...pending]) {
          const reply = await as(owner.claims, async (c) => (await c.query("select public.publish_process($1, true) as r", [id])).rows[0].r);
          if (reply.status === "published") {
            order.push(id);
            pending.splice(pending.indexOf(id), 1);
          }
        }
      }
      expect(pending).toEqual([]);

      // Same engine model, same run.
      const opts = { startDate: "2026-10-05" };
      const before = await loadPipeline(admin.claims, source);
      const after = await loadPipeline(admin.claims, ws);
      const modelBefore = toEngineModel(before, opts);
      const modelAfter = JSON.parse(backToOld(toEngineModel(after, opts), restored, ws, planned.placeholderOf, source));
      expect(modelAfter).toEqual(JSON.parse(JSON.stringify(modelBefore)));
      // (2) Headline results. The engine seeds its random streams by hashing step, service and client ids into their labels
      // (packages/engine/src/simulate.ts, `streams.get(labels.join("work", s.id))`), so a restore, whose ids are all new, draws
      // different random numbers at the same seed. What must hold is that the restored run is within ordinary run-to-run variation
      // (decision recorded on #39): |restored@42 - source@42| <= 3 x spread, per headline metric the Overview shows, where the
      // spread is how far the SOURCE moves when only the seed changes. One other seed (43) estimates that from a single pair and
      // was too noisy (3 x a lucky small gap failed a faithful restore), so the source is run at 43 to 46 and the spread is the
      // largest |source@seed - source@42|. A small absolute floor (1% of the source's value, or 0.01) stops a zero spread making
      // the check impossible.
      const modelAfterNew = toEngineModel(after, opts);
      const src42 = simulate(modelBefore, 30, 42);
      const others = [43, 44, 45, 46].map((seed) => simulate(modelBefore, 30, seed));
      const res42 = simulate(modelAfterNew, 30, 42);
      const headline = (m: typeof modelBefore, r: ReturnType<typeof simulate>) => ({
        flowEfficiency: workingShare(timeSplitOf(m, r) ?? { handsOn: 0, waitingForPerson: 0, waitingOnOthers: 0 }) ?? 0,
        throughputDone: r.kpi.done.mean,
        throughputWon: r.kpi.won.mean,
        leadTime: r.kpi.cycle.mean,
        costPerWin: r.kpi.costPerWin.mean,
        labour: r.kpi.labour.mean,
      });
      const a = headline(modelBefore, src42);
      const others_ = others.map((r) => headline(modelBefore, r));
      const c = headline(modelAfterNew, res42);
      for (const k of Object.keys(a) as (keyof typeof a)[]) {
        const spread = Math.max(...others_.map((o) => Math.abs(a[k] - o[k])));
        const floor = Math.max(0.01, Math.abs(a[k]) * 0.01);
        const tolerance = Math.max(3 * spread, floor);
        expect(Math.abs(c[k] - a[k]), `${k}: restored ${c[k]}, source ${a[k]}, tolerance ${tolerance}`).toBeLessThanOrEqual(tolerance);
      }
    });
  });
});
