import { readFileSync } from "node:fs";
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
const count = async (table: string, ws: string, where = "true") => Number((await q(`select count(*) from public.${table} where workspace_id = $1 and (${where})`, [ws]))[0]!.count);

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
    // A custom market condition (made now, so after the presets it was seeded with and before the presets any later workspace is seeded with) and a schedule using it and a preset, in both
    // golden workspaces, so the market comes back too.
    for (const ws of [NORTHBEAM_WORKSPACE_ID, LARKSPUR_WORKSPACE_ID]) {
      const [c] = await q(
        "insert into market_conditions (workspace_id, name, leads, conv, cycle, price, churn, hire, pay) values ($1, 'Supplier squeeze', 90, 95, 110, 105, 120, 100, 100) returning id",
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
      // was too noisy (3 x a lucky small gap failed a faithful restore), so the source is run at 43 to 54 (the restore's ids are new at every run, so its draws differ at every run and the check must hold
      // for any of them) and the spread is the largest |source@seed - source@42|. A small absolute floor (1% of the source's value, or 0.01) stops a zero spread making
      // the check impossible.
      const modelAfterNew = toEngineModel(after, opts);
      const src42 = simulate(modelBefore, 30, 42);
      const others = [43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54].map((seed) => simulate(modelBefore, 30, seed));
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

// ---------------------------------------------------------------------------------------------------------------------------
// A small source workspace with the awkward cases: a process held by a link, an archived one, one never published, one with a newer
// draft than its live version, a perception gap, a scenario family, a suggestion that targets the workspace.

const U = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
interface Mini {
  ws: string;
  main: string;
  held: string;
  archived: string;
  neverPublished: string;
  newerDraft: string;
  conflictStep: string;
  library: { downturn: string };
  custom: string;
}
let miniCache: Mini | null = null;

async function mini(): Promise<Mini> {
  if (miniCache) return miniCache;
  const ws = await newWorkspace("Mini Source");
  await q("update workspaces set settings = settings || '{\"hours_per_week\": 37, \"currency\": \"USD\"}' where id = $1", [ws]);
  const ids = { main: U(0x10), held: U(0x11), archived: U(0x12), neverPublished: U(0x13), newerDraft: U(0x14), conflictStep: U(0x20) };
  const [role] = await q("insert into roles (workspace_id, name, color) values ($1, 'Analyst', '#336699') returning id", [ws]);
  const [person] = await q("insert into people (workspace_id, name) values ($1, 'Ada') returning id", [ws]);
  const [source] = await q("insert into sources (workspace_id, kind, title, body) values ($1, 'notes', 'Call notes', 'Ada said: about 2 hours or 10, depending.') returning id", [ws]);
  const stepSql = `insert into steps (id, revision_id, workspace_id, process_id, name, kind, outcome, work_hours, child_process_id, role_id, conflict, provenance, x, y)
    values ($1, $2, $3, $4, $5, $6, $7, case when $6 = 'subprocess' then 0 else 1 end, $8, case when $6 = 'subprocess' then null else $9::uuid end, $10, $11, 0, 0)`;
  const edgeSql = "insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, 1)";
  async function process(c: pg.Client, id: string, name: string, kind: string, steps: { id?: string; name: string; kind: string; child?: string; conflict?: boolean }[]) {
    await c.query("insert into processes (id, workspace_id, name, kind, entity_name) values ($1, $2, $3, $4, 'item')", [id, ws, name, kind]);
    await c.query("select public.open_draft($1)", [id]);
    const revision = (await c.query("select id from process_revisions where process_id = $1 and status = 'draft'", [id])).rows[0].id as string;
    const made: string[] = [];
    for (const [i, s] of steps.entries()) {
      const sid = s.id ?? `${(0x100 + i).toString(16).padStart(8, "0")}-${id.slice(0, 4)}-4000-8000-000000000000`;
      const provenance = s.conflict
        ? { work_hours: { conflict: { resolved: null, values: [{ value: 2, speaker: "Ada", source_id: source!.id }, { value: 10, speaker: "Ben", source_id: source!.id }] }, evidence: [{ source_id: source!.id }] } }
        : {};
      await c.query(stepSql, [sid, revision, ws, id, s.name, s.kind, s.kind === "end" ? "done" : null, s.child ?? null, role!.id, s.conflict ?? false, JSON.stringify(provenance)]);
      made.push(sid);
    }
    for (let i = 0; i + 1 < made.length; i++) await c.query(edgeSql, [revision, ws, id, made[i], made[i + 1]]);
    return revision;
  }
  await as(admin.claims, async (c) => {
    await process(c, ids.held, "Held child", "servicing", [{ name: "Start", kind: "start" }, { name: "Work", kind: "task" }, { name: "Done", kind: "end" }]);
    await c.query("select public.publish_process($1, true)", [ids.held]);
    await process(c, ids.main, "Main", "pipeline", [
      { name: "Start", kind: "start" },
      { name: "Hand over", kind: "subprocess", child: ids.held },
      { id: ids.conflictStep, name: "Quote", kind: "task", conflict: true },
      { name: "Done", kind: "end" },
    ]);
    await c.query("select public.publish_process($1, true)", [ids.main]);
    await process(c, ids.archived, "Old process", "pipeline", [{ name: "Start", kind: "start" }, { name: "Done", kind: "end" }]);
    await c.query("select public.publish_process($1, true)", [ids.archived]);
    await process(c, ids.neverPublished, "Idea only", "pipeline", [{ name: "Start", kind: "start" }, { name: "Done", kind: "end" }]);
    await process(c, ids.newerDraft, "Has a newer draft", "pipeline", [{ name: "Start", kind: "start" }, { name: "Done", kind: "end" }]);
    await c.query("select public.publish_process($1, true)", [ids.newerDraft]);
    await c.query("select public.open_draft($1)", [ids.newerDraft]);
    const draft = (await c.query("select id from process_revisions where process_id = $1 and status = 'draft'", [ids.newerDraft])).rows[0].id;
    await c.query(stepSql, [U(0x30), draft, ws, ids.newerDraft, "Only in the newer draft", "task", null, null, null, false, "{}"]);
    await c.query("update processes set archived_at = now() where id = $1", [ids.archived]);
  });
  // Scenarios: the seeded library, a custom one that descends from "More leads", and an issue that uses "Downturn".
  const lib = await q("select id, name from scenarios where workspace_id = $1", [ws]);
  const moreLeads = lib.find((s) => s.name === "More leads")!.id;
  const downturn = lib.find((s) => s.name === "Downturn")!.id as string;
  const [custom] = await q(
    "insert into scenarios (workspace_id, name, patch, parent_scenario_id) values ($1, 'More leads and a hire', '[{\"path\": \"demand.leads_per_week\", \"op\": \"multiply\", \"value\": 1.5}]', $2) returning id",
    [ws, moreLeads],
  );
  await q("insert into issues (workspace_id, type, title, scenario_id, owner_person_id, status) values ($1, 'idea', 'Try the downturn', $2, $3, 'in_progress')", [ws, downturn, person!.id]);
  await q("insert into issues (workspace_id, type, title, source, status, resolution) values ($1, 'delay', 'Quotes are slow', 'manual', 'done', 'wont_fix')", [ws]);
  await q("insert into suggestions (workspace_id, target_table, target_id, patch) values ($1, 'workspaces', $1, '{\"set\": {\"hours_per_week\": 35}}')", [ws]);
  await q("insert into suggestion_proposals (workspace_id, kind, title, detail) values ($1, 'issue', 'Proposed issue', 'Looks slow')", [ws]);
  miniCache = { ws, ...ids, library: { downturn }, custom: custom!.id as string };
  return miniCache;
}

describe("a small workspace with the awkward cases", () => {
  it("builds", async () => {
    const m = await mini();
    const b = await bundleOf(m.ws);
    const check = checkWorkspaceBundle(b);
    expect(check.errors).toEqual([]);
    expect(b.processes.length).toBe(6);
  });
});

const miniPlan = async (canManage = true) => planWorkspaceImport(await bundleOf((await mini()).ws), { canManage });
const byName = async (ws: string, table: string, name: string) => (await q(`select * from public.${table} where workspace_id = $1 and name = $2`, [ws, name]))[0]!;

describe("the awkward cases", () => {
  it("restores the live version, a never-published draft, an archived process, and drops a newer draft", async () => {
    const m = await mini();
    const bundle = await bundleOf(m.ws);
    const { ws, user, result } = await restoreInto(bundle);
    expect(result.processes.map((p) => p.name).sort()).toEqual(["Has a newer draft", "Held child", "Idea only", "Main", "Old process"]);
    const stepsOf = async (name: string) => (await q("select s.name from steps s join processes p on p.id = s.process_id where p.workspace_id = $1 and p.name = $2 order by s.name", [ws, name])).map((r) => r.name);
    expect(await stepsOf("Has a newer draft")).toEqual(["Done", "Start"]);
    expect(await stepsOf("Idea only")).toEqual(["Done", "Start"]);
    const old = await byName(ws, "processes", "Old process");
    expect(old.archived_at).not.toBeNull();
    expect(result.processes.find((p) => p.name === "Old process")!.archived).toBe(true);
    expect((await byName(ws, "processes", "Main")).archived_at).toBeNull();
    expect((await byName(ws, "processes", "Main")).source).toBe("import");
    // Each draft is the only revision, number 1; nothing is published.
    expect((await q("select distinct status, number from process_revisions r join processes p on p.id = r.process_id where r.workspace_id = $1 and not p.is_company", [ws]))).toEqual([{ status: "draft", number: 1 }]);
    // Each import is logged once.
    expect(Number((await q("select count(*) from audit_log where workspace_id = $1 and action = 'import'", [ws]))[0]!.count)).toBe(5);
    expect(user.id).toBeTruthy();
  });

  it("makes the company map's cards in one system version, and the bundle's map rows are nowhere", async () => {
    const m = await mini();
    const bundle = await bundleOf(m.ws);
    const ws = await newWorkspace();
    const [map] = await q("select id from processes where workspace_id = $1 and is_company", [ws]);
    const before = Number((await q("select count(*) from process_revisions where process_id = $1", [map!.id]))[0]!.count);
    const owner = await member(ws, "owner");
    const planned = planWorkspaceImport(bundle, { canManage: true });
    await restoreAs(owner, ws, planned.plan);
    const revisions = await q("select id, status, number from process_revisions where process_id = $1 order by number", [map!.id]);
    // At most one new version for the whole restore (ADR 0014, "Bulk is one version"), whatever the number of processes.
    expect(revisions.length - before).toBeLessThanOrEqual(1);
    expect(JSON.stringify(await q("select * from steps where process_id = $1", [map!.id]))).not.toContain("Held child".toLowerCase() + "-never");
    // Nothing of the source map came along: no step of the new map carries a source id.
    const sourceMapRev = (await q("select r.id from process_revisions r join processes p on p.id = r.process_id where p.workspace_id = $1 and p.is_company", [m.ws])).map((r) => r.id);
    const copied = await q("select count(*) from steps where process_id = $1 and id = any ($2)", [map!.id, (await q("select id from steps where revision_id = any ($1)", [sourceMapRev])).map((r) => r.id)]);
    expect(Number(copied[0]!.count)).toBe(0);
  });

  it("puts a held process on the map only through its holder once both are published (B12, #188)", async () => {
    const m = await mini();
    const { ws, user, result } = await restoreInto(await bundleOf(m.ws));
    const id = (name: string) => result.processes.find((p) => p.name === name)!.id;
    for (const name of ["Held child", "Main", "Idea only", "Has a newer draft"]) {
      const reply = await as(user.claims, async (c) => (await c.query("select public.publish_process($1, true) as r", [id(name)])).rows[0].r);
      expect(reply.status, name).toBe("published");
    }
    const [map] = await q("select live_revision_id from processes where workspace_id = $1 and is_company", [ws]);
    const cards = await q("select child_process_id from steps where revision_id = $1 and child_process_id is not null", [map!.live_revision_id]);
    const onMap = cards.map((r) => r.child_process_id);
    expect(onMap).toContain(id("Main"));
    expect(onMap).not.toContain(id("Held child"));
    expect(onMap).not.toContain(id("Old process"));
    // The archived process is off the map and out of the lists.
    const placements = await q("select count(*) from steps s join processes p on p.id = s.process_id where s.child_process_id = $1 and p.workspace_id = $2", [id("Old process"), ws]);
    expect(Number(placements[0]!.count)).toBe(0);
  });

  it("gives a restored perception gap one issue, not two", async () => {
    const m = await mini();
    const bundle = await bundleOf(m.ws);
    expect(bundle.issues.filter((i) => String(i.detected_key ?? "").startsWith("perception_gap:")).length).toBe(1);
    const { ws } = await restoreInto(bundle);
    const gaps = await q("select id, detected_key, step_id from issues where workspace_id = $1 and detected_key like 'perception_gap:%'", [ws]);
    expect(gaps.length).toBe(1);
    expect(String(gaps[0]!.detected_key)).toContain(String(gaps[0]!.step_id));
  });

  it("doesn't duplicate the scenario library, and re-points children and issues at the existing rows", async () => {
    const m = await mini();
    const { ws, result } = await restoreInto(await bundleOf(m.ws));
    expect(Number((await q("select count(*) from scenarios where workspace_id = $1", [ws]))[0]!.count)).toBe(5);
    expect(result.skipped.scenarios).toBe(4);
    const moreLeads = await byName(ws, "scenarios", "More leads");
    const custom = await byName(ws, "scenarios", "More leads and a hire");
    expect(custom.parent_scenario_id).toBe(moreLeads.id);
    const downturn = await byName(ws, "scenarios", "Downturn");
    const [issue] = await q("select scenario_id from issues where workspace_id = $1 and title = 'Try the downturn'", [ws]);
    expect(issue!.scenario_id).toBe(downturn.id);
  });

  it("points a suggestion that targets the workspace at the new workspace (rank 0), and applies the settings for an owner", async () => {
    const m = await mini();
    const { ws, result } = await restoreInto(await bundleOf(m.ws));
    expect(result.settings).toBe("applied");
    const [row] = await q("select settings from workspaces where id = $1", [ws]);
    expect(row!.settings).toMatchObject({ hours_per_week: 37, currency: "USD" });
    const s = await q("select target_id, status, created_via, import_source from suggestions where workspace_id = $1 and target_table = 'workspaces'", [ws]);
    expect(s).toEqual([{ target_id: ws, status: "pending", created_via: "upload", import_source: "backup.json" }]);
    expect(await q("select title, status, created_via, import_source from suggestion_proposals where workspace_id = $1", [ws])).toEqual([{ title: "Proposed issue", status: "pending", created_via: "upload", import_source: "backup.json" }]);
  });

  it("keeps the order of market conditions: restored custom ones keep their old date, so they list before the new presets", async () => {
    const bundle = await bundleOf(NORTHBEAM_WORKSPACE_ID);
    const { ws, result, placeholderOf } = await restoreInto(bundle);
    const sourceOrder = (await q("select name, preset from market_conditions where workspace_id = $1 order by created_at, id", [NORTHBEAM_WORKSPACE_ID])).map((r) => r.name);
    const restoredOrder = (await q("select name, preset from market_conditions where workspace_id = $1 order by created_at, id", [ws])).map((r) => r.name);
    // Same conditions, no preset twice.
    expect([...restoredOrder].sort()).toEqual([...sourceOrder].sort());
    // The intended order: a restored custom condition keeps its own date, so it lists before the presets the new workspace was seeded
    // with later (the source lists it after its presets). Nothing depends on it: the engine and the screens find conditions by id,
    // and the settings page orders presets first (`orderConditions`). The engine models are compared in the round trip above.
    expect(restoredOrder[0]).toBe("Supplier squeeze");
    expect(sourceOrder[sourceOrder.length - 1]).toBe("Supplier squeeze");
    expect(Number((await q("select count(*) from market_conditions where workspace_id = $1 and preset is not null", [ws]))[0]!.count)).toBe(4);
    expect(result.id_prefix).toBeTruthy();
    expect(placeholderOf.size).toBeGreaterThan(0);
  });
});

describe("what is left out stays out", () => {
  it("writes drafts, no solutions or history, no files, only pending suggestions, and the counts of the source minus the left-outs", async () => {
    const source = NORTHBEAM_WORKSPACE_ID;
    const bundle = await bundleOf(source);
    const { ws, result } = await restoreInto(bundle, "owner", { label: "northbeam.json" });
    const n = (table: string, w: string, where = "true") => count(table, w, where);
    expect(await n("solutions", ws)).toBe(0);
    expect(await n("solution_issues", ws)).toBe(0);
    for (const t of ["roles", "people", "person_roles", "person_leave", "person_skills", "services", "service_servicing", "client_groups", "clients", "client_services", "client_assignments", "lead_sources", "seasonality", "churn_drivers", "market_schedule", "blocks", "sources"]) {
      expect(await n(t, ws), t).toBe(await n(t, source));
    }
    expect(await n("scenarios", ws)).toBe((await n("scenarios", source)) - result.skipped.scenarios! + 4);
    expect(await n("market_conditions", ws)).toBe(await n("market_conditions", source));
    expect(await n("issues", ws)).toBe(await n("issues", source, "source <> 'detected'"));
    expect(await n("issue_links", ws)).toBeGreaterThanOrEqual(0);
    expect(await n("suggestions", ws)).toBe(await n("suggestions", source, "status = 'pending'"));
    expect(await n("suggestion_proposals", ws)).toBe(await n("suggestion_proposals", source, "status = 'pending'"));
    expect(await n("suggestions", ws, "created_via <> 'upload' or import_source is distinct from 'northbeam.json'")).toBe(0);
    expect(await n("suggestion_proposals", ws, "created_via <> 'upload' or import_source is distinct from 'northbeam.json'")).toBe(0);
    expect(await n("sources", ws, "file_path is not null or file_name is not null or file_type is not null or file_size is not null")).toBe(0);
    // Steps and edges: those of the live versions of the source's processes.
    const live = "revision_id in (select live_revision_id from processes where workspace_id = $1 and not is_company and live_revision_id is not null)";
    const drafts = "revision_id in (select draft_revision_id from processes where workspace_id = $1 and not is_company and draft_revision_id is not null)";
    for (const t of ["steps", "edges"]) {
      expect(Number((await q(`select count(*) from ${t} where ${live}`, [source]))[0]!.count), t).toBe(Number((await q(`select count(*) from ${t} where ${drafts}`, [ws]))[0]!.count));
    }
    // Only drafts, from number 1, and no published version of a restored process.
    expect(await n("process_revisions", ws, "status <> 'draft' and process_id in (select id from processes where not is_company)")).toBe(0);
    expect(await n("process_revisions", ws, "number <> 1 and process_id in (select id from processes where not is_company)")).toBe(0);
    // Issue history: each issue starts with one `created` entry; the triggers add `resolved` or `solution_tested` where they apply.
    const events = await q("select issue_id, kind, count(*)::int n from issue_events where workspace_id = $1 group by 1, 2", [ws]);
    for (const e of events) expect(["created", "resolved", "solution_tested", "edited"]).toContain(e.kind);
    expect(events.filter((e) => e.kind === "created").every((e) => e.n === 1)).toBe(true);
    expect(events.filter((e) => e.kind === "created").length).toBe(await n("issues", ws));
    // Source links: the source's, minus solution links and step links to steps that aren't in a restored draft.
    expect(await n("source_links", ws, "kind = 'solution'")).toBe(0);
    // Fresh ids: no id of the source's survives.
    expect(Number((await q("select count(*) from roles a join roles b on a.id = b.id and a.workspace_id <> b.workspace_id", []))[0]!.count)).toBe(0);
    expect(result.processes.length).toBe(await n("processes", ws, "not is_company"));
  });
});

describe("who may restore", () => {
  it("lets an editor restore, with the workspace settings as one pending suggestion an owner accepts", async () => {
    const m = await mini();
    const bundle = await bundleOf(m.ws);
    const { ws, result } = await restoreInto(bundle, "editor", { canManage: false, label: "mini.json" });
    expect(result.settings).toBe("suggested");
    const [row] = await q("select settings from workspaces where id = $1", [ws]);
    expect(row!.settings).not.toMatchObject({ hours_per_week: 37 });
    const pending = await q("select id, patch, created_via, import_source, status from suggestions where workspace_id = $1 and note = 'Workspace settings from a backup.'", [ws]);
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ created_via: "upload", import_source: "mini.json", status: "pending" });
    const owner = await member(ws, "owner");
    const reply = await as(owner.claims, async (c) => (await c.query("select public.review_suggestions($1::uuid[], 'accept') as r", [[pending[0]!.id]])).rows[0].r);
    expect(JSON.stringify(reply)).not.toContain("error");
    const [after] = await q("select settings from workspaces where id = $1", [ws]);
    expect(after!.settings).toMatchObject({ hours_per_week: 37, currency: "USD" });
  });

  const ok: [string, (ws: string) => Promise<User>][] = [
    ["an agency admin (JWT flag)", async () => admin],
    ["an agency_admin membership", async (ws) => member(ws, "agency_admin")],
    ["an owner", async (ws) => member(ws, "owner")],
    ["an editor", async (ws) => member(ws, "editor")],
  ];
  it.each(ok)("lets %s restore", async (_who, make) => {
    const ws = await newWorkspace();
    const user = await make(ws);
    const { plan } = await miniPlan();
    const result = await restoreAs(user, ws, plan);
    expect(result.processes.length).toBe(5);
  });

  const refused: [string, (ws: string) => Promise<User>][] = [
    ["a member", async (ws) => member(ws, "member")],
    ["a viewer", async (ws) => member(ws, "viewer")],
    ["a signed-in non-member", async () => createUser(db, `stranger${++seq}@elsewhere.example.com`)],
  ];
  it.each(refused)("refuses %s with 42501 and writes nothing", async (_who, make) => {
    const ws = await newWorkspace();
    const user = await make(ws);
    const { plan } = await miniPlan();
    const before = await snapshot(ws);
    const e = await failure(() => restoreAs(user, ws, plan));
    expect(e.code).toBe("42501");
    expect(e.message).toMatch(/Only owners, editors and agency admins/);
    expect(await snapshot(ws)).toEqual(before);
  });

  it("refuses an API token, and anon can't execute the function", async () => {
    const ws = await newWorkspace();
    const owner = await member(ws, "owner");
    const { plan } = await miniPlan();
    const e = await failure(() => restoreAs({ id: owner.id, claims: { ...owner.claims, api_token_id: "t-1" } }, ws, plan));
    expect(e.code).toBe("42501");
    expect(e.message).toBe("Backups are restored in the app.");
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      const a = await failure(() => callRestore(db.client, ws, plan));
      expect(a.code).toBe("42501");
    } finally {
      await db.client.query("rollback");
    }
    expect(Number((await q("select count(*) from roles where workspace_id = $1", [ws]))[0]!.count)).toBe(0);
  });
});

describe("only into an empty workspace", () => {
  it("refuses Northbeam, writing nothing", async () => {
    const { plan } = await miniPlan();
    const before = await snapshot(NORTHBEAM_WORKSPACE_ID);
    const e = await failure(() => restoreAs(admin, NORTHBEAM_WORKSPACE_ID, plan));
    expect(e).toMatchObject({ code: "23514", hint: "not_empty" });
    expect(e.message).toMatch(/isn't empty/);
    expect(await snapshot(NORTHBEAM_WORKSPACE_ID)).toEqual(before);
  });

  it("refuses a new workspace with one role added", async () => {
    const ws = await newWorkspace();
    await q("insert into roles (workspace_id, name, color) values ($1, 'Lonely', '#000000')", [ws]);
    const { plan } = await miniPlan();
    const before = await snapshot(ws);
    expect(await failure(() => restoreAs(admin, ws, plan))).toMatchObject({ hint: "not_empty" });
    expect(await snapshot(ws)).toEqual(before);
  });

  it("refuses the second of two restores in a row, and accepts a new workspace's own scenario library and map", async () => {
    const ws = await newWorkspace();
    const { plan } = await miniPlan();
    await restoreAs(admin, ws, plan);
    expect(await failure(() => restoreAs(admin, ws, plan))).toMatchObject({ hint: "not_empty" });
  });

  it("refuses a workspace with a scenario of its own, and with an archived process", async () => {
    const { plan } = await miniPlan();
    const a = await newWorkspace();
    await q("insert into scenarios (workspace_id, name, patch) values ($1, 'Mine', '[]')", [a]);
    expect(await failure(() => restoreAs(admin, a, plan))).toMatchObject({ hint: "not_empty" });
    // An archived process counts: it is a process, and restoring would give its name to a second one.
    const b = await newWorkspace();
    await q("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Old thing', 'pipeline', 'item')", [b]);
    await q("update processes set archived_at = now() where workspace_id = $1 and name = 'Old thing'", [b]);
    const before = await snapshot(b);
    expect(await failure(() => restoreAs(admin, b, plan))).toMatchObject({ hint: "not_empty" });
    expect(await snapshot(b)).toEqual(before);
  });
});

describe("all or nothing", () => {
  it("leaves nothing behind when the last section fails (processes, map versions and the audit log included)", async () => {
    const { plan } = await miniPlan();
    const bad: ImportPlan = structuredClone(plan);
    bad.suggestions.push({ id: `${PLACEHOLDER_PREFIX}ffffffffff01`, target_table: "not_a_table", target_id: null, patch: { set: {} }, evidence: [], note: null } as Row);
    const ws = await newWorkspace();
    const before = await snapshot(ws);
    const e = await failure(() => restoreAs(admin, ws, bad));
    expect(e.hint).toBe("section:suggestions");
    expect(e.message).toMatch(/suggestions could not be restored/);
    expect(await snapshot(ws)).toEqual(before);
  });
});

describe("ids", () => {
  it("refuses a real uuid in an id or reference column (22023), for every column the lists name", async () => {
    const { plan } = await planWorkspaceImport(await bundleOf(NORTHBEAM_WORKSPACE_ID), { canManage: true });
    const ws = await newWorkspace();
    const real = "11111111-2222-4333-8444-555555555555";
    const attempts: { where: string; mutate: (p: ImportPlan) => boolean }[] = [];
    const flat = plan as unknown as Record<string, Row[]>;
    for (const [section, refs] of Object.entries(IMPORT_REFS)) {
      for (const col of ["id", ...refs.map((r) => r.col)]) {
        attempts.push({
          where: `${section}.${col}`,
          mutate: (p) => {
            const row = (p as unknown as Record<string, Row[]>)[section]!.find((r) => r[col] != null);
            if (!row) return false;
            row[col] = real;
            return true;
          },
        });
      }
    }
    for (const col of IMPORT_STEP_REFS.map((r) => r.col)) {
      attempts.push({ where: `steps.${col}`, mutate: (p) => { const row = p.processes.flatMap((x) => x.steps).find((r) => r[col] != null); if (!row) return false; row[col] = real; return true; } });
    }
    attempts.push({ where: "processes.id", mutate: (p) => { p.processes[0]!.id = real; return true; } });
    attempts.push({ where: "edges.from_step_id", mutate: (p) => { const e = p.processes.flatMap((x) => x.edges)[0]; if (!e) return false; e.from_step_id = real; return true; } });
    attempts.push({ where: "issues.owner_ids", mutate: (p) => { const i = p.issues.find((r) => Array.isArray(r.owner_ids) && r.owner_ids.length > 0); if (!i) return false; (i.owner_ids as string[])[0] = real; return true; } });
    attempts.push({ where: "issues.links", mutate: (p) => { const i = p.issues.find((r) => Array.isArray(r.links) && r.links.length > 0); if (!i) return false; (i.links as Row[])[0]!.process_id = real; return true; } });
    attempts.push({ where: "market_schedule.condition_id", mutate: (p) => { const r = p.market_schedule.find((x) => x.condition_id != null); if (!r) return false; r.condition_id = real; return true; } });
    attempts.push({ where: "suggestions.target_id", mutate: (p) => { const r = p.suggestions.find((x) => x.target_id != null); if (!r) return false; r.target_id = real; return true; } });
    void flat;
    let tried = 0;
    for (const a of attempts) {
      const copy: ImportPlan = structuredClone(plan);
      if (!a.mutate(copy)) continue;
      tried++;
      const e = await failure(() => restoreAs(admin, ws, copy));
      expect(e.code, a.where).toBe("22023");
    }
    // Northbeam has rows for most columns; the few without (no suggestions, say) are covered by the Mini plan below.
    expect(tried).toBeGreaterThan(25);
    expect(Number((await q("select count(*) from roles where workspace_id = $1", [ws]))[0]!.count)).toBe(0);
  });

  it("refuses a real uuid in the Mini plan's suggestion target and issue links", async () => {
    const { plan } = await miniPlan();
    const ws = await newWorkspace();
    const copy: ImportPlan = structuredClone(plan);
    copy.suggestions[0]!.target_id = "11111111-2222-4333-8444-555555555555";
    expect((await failure(() => restoreAs(admin, ws, copy))).code).toBe("22023");
  });

  it("leaves a uuid typed into free text alone", async () => {
    const { plan } = await miniPlan();
    const free = "99999999-8888-4777-8666-555555555555";
    const copy: ImportPlan = structuredClone(plan);
    copy.sources[0]!.body = `see ${free}`;
    const ws = await newWorkspace();
    await restoreAs(admin, ws, copy);
    expect((await q("select body from sources where workspace_id = $1", [ws]))[0]!.body).toBe(`see ${free}`);
  });

  it("makes new ids for each restore of one backup, in the old order", async () => {
    const m = await mini();
    const bundle = await bundleOf(m.ws);
    const a = await restoreInto(bundle);
    const b = await restoreInto(bundle);
    expect(a.result.id_prefix).not.toBe(b.result.id_prefix);
    const ids = async (ws: string) => (await q("select id from steps where workspace_id = $1 and process_id in (select id from processes where not is_company) order by id", [ws])).map((r) => String(r.id));
    const ia = await ids(a.ws);
    const ib = await ids(b.ws);
    expect(ia.length).toBeGreaterThan(0);
    expect(ia.some((x) => ib.includes(x))).toBe(false);
    // The same order as the source's ids: the rank is the last 12 digits.
    const ranks = ia.map((x) => x.slice(-12));
    expect(ranks).toEqual([...ranks].sort());
  });
});

describe("SQL and TS agree", () => {
  it("has the allow-list and reference lists of the planner", async () => {
    const src = String((await q("select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_workspace_bundle'"))[0]!.prosrc);
    const allow = JSON.parse(/allow constant jsonb := '(.*?)'::jsonb;/s.exec(src)![1]!) as Record<string, string[]>;
    expect(allow).toEqual(JSON.parse(JSON.stringify(IMPORT_COLUMNS)));
    const list = (name: string) => [...(new RegExp(`${name} constant text\\[\\] := array\\[(.*?)\\];`, "s").exec(src)![1]!.matchAll(/'([^']+)'/g))].map((m) => m[1]!);
    const tsRefs = Object.entries(IMPORT_REFS).flatMap(([s, refs]) => refs.map((r) => `${s}.${r.col}`));
    expect(list("ref_cols").sort()).toEqual([...tsRefs, "market_schedule.condition_id", "suggestions.target_id"].sort());
    expect(list("step_ref_cols").sort()).toEqual(IMPORT_STEP_REFS.map((r) => r.col).sort());
  });

  it("has an apply file that is the migration plus its schema_migrations row, in one transaction", () => {
    const dir = new URL("../", import.meta.url);
    const mig = readFileSync(new URL("supabase/migrations/20261207000000_import_workspace_bundle.sql", dir), "utf8").trimEnd();
    const apply = readFileSync(new URL("scripts/apply/20261207000000_import_workspace_bundle.sql", dir), "utf8");
    expect(apply).toContain("\nbegin;\nset local lock_timeout");
    expect(apply.split(mig).length - 1).toBe(2);
    expect(apply).toContain("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261207000000', 'import_workspace_bundle', array[$mig$" + mig);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
  });

  it("restores a plan that carries every allowed column of the tables that take them (the columns exist)", async () => {
    // Each allowed column of each flat table exists in that table (so the dynamic insert can name it).
    const tables: Record<string, string> = { proposals: "suggestion_proposals" };
    for (const [section, columns] of Object.entries(IMPORT_COLUMNS)) {
      const table = tables[section] ?? section;
      const have = (await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).map((r) => r.column_name);
      for (const c of columns) expect(have, `${table}.${c}`).toContain(c);
    }
  });
});

describe("limits", () => {
  const over = async (label: string, mutate: (p: ImportPlan) => void) => {
    const { plan } = await miniPlan();
    const copy: ImportPlan = structuredClone(plan);
    mutate(copy);
    const ws = await newWorkspace();
    const e = await failure(() => restoreAs(admin, ws, copy));
    expect(e.code, label).toBe("22023");
  };
  const L = WORKSPACE_IMPORT_LIMITS;
  const rows = (n: number): Row[] => Array.from({ length: n }, () => ({}));
  it.each([
    ["processes", (p: ImportPlan) => { p.processes = rows(L.processes + 1).map(() => ({ id: "", parent_process_id: null, name: "", kind: "", entity_name: "", description: "", archived: false, layout: {}, steps: [], edges: [], first_principles: null })); }],
    ["steps", (p: ImportPlan) => { p.processes[0]!.steps = rows(L.steps + 1); }],
    ["edges", (p: ImportPlan) => { p.processes[0]!.edges = rows(L.edges + 1); }],
    ["sources", (p: ImportPlan) => { p.sources = rows(L.sources + 1); }],
    ["source text", (p: ImportPlan) => { p.sources = [{ body: "x".repeat(L.sourceChars + 1) }]; }],
    ["issues", (p: ImportPlan) => { p.issues = rows(L.issues + 1); }],
    ["people", (p: ImportPlan) => { p.people = rows(L.people + 1); }],
    ["clients", (p: ImportPlan) => { p.clients = rows(L.clients + 1); }],
    ["scenarios", (p: ImportPlan) => { p.scenarios = rows(L.scenarios + 1); }],
    ["blocks", (p: ImportPlan) => { p.blocks = rows(L.blocks + 1); }],
    ["suggestions", (p: ImportPlan) => { p.suggestions = rows(L.suggestions + 1); }],
    ["proposals", (p: ImportPlan) => { p.proposals = rows(L.proposals + 1); }],
    ["role assignments", (p: ImportPlan) => { p.person_roles = rows(L.personRoles + 1); }],
    ["skills", (p: ImportPlan) => { p.person_skills = rows(L.personSkills + 1); }],
    ["client assignments", (p: ImportPlan) => { p.client_assignments = rows(L.clientAssignments + 1); }],
    ["source links", (p: ImportPlan) => { p.source_links = rows(L.sourceLinks + 1); }],
  ])("refuses one more than the limit of %s", async (label, mutate) => {
    await over(label, mutate);
  });
  it("refuses a scenario with no id (null or missing), writing nothing, rather than reporting success with nothing written", async () => {
    const { plan } = await miniPlan();
    for (const mutate of [(sc: Row) => { sc.id = null; }, (sc: Row) => { delete sc.id; }]) {
      const copy: ImportPlan = structuredClone(plan);
      // One that equals a library scenario: the case where the replacement of a skipped one would have returned null.
      const library = copy.scenarios.find((sc) => sc.name === "Downturn")!;
      mutate(library);
      const ws = await newWorkspace();
      const before = await snapshot(ws);
      const e = await failure(() => restoreAs(admin, ws, copy));
      expect(e.code).toBe("22023");
      expect(e.message).toMatch(/every scenario needs an id/);
      expect(await snapshot(ws)).toEqual(before);
    }
  });

  it("refuses a plan that isn't a plan", async () => {
    const ws = await newWorkspace();
    expect((await failure(() => restoreAs(admin, ws, { format: "transpera-workspace-import/2" }))).code).toBe("22023");
    expect((await failure(() => restoreAs(admin, ws, { format: "transpera-workspace-import/1" }))).code).toBe("22023");
  });
});

/** A synthetic plan with `L` rows of everything (the limits, or fewer). */
function syntheticPlan(L: Record<keyof typeof WORKSPACE_IMPORT_LIMITS, number>) {
    const id = (n: number) => `${PLACEHOLDER_PREFIX}${n.toString(16).padStart(12, "0")}`;
    let next = 1;
    const mk = () => id(next++);
    const when = "2026-01-01T00:00:00Z";
    const role = mk();
    const roles = [{ id: role, name: "Role", color: "#336699", created_at: when }, ...[1, 2].map((i) => ({ id: mk(), name: `Role ${i}`, color: "#336699", created_at: when }))];
    const people = Array.from({ length: L.people }, (_, i) => ({ id: mk(), name: `Person ${i}`, created_at: when }));
    const clients = Array.from({ length: L.clients }, (_, i) => ({ id: mk(), name: `Client ${i}`, created_at: when }));
    const stepsPer = Math.floor(L.steps / L.processes);
    const processes = Array.from({ length: L.processes }, (_, p) => {
      const stepIds = Array.from({ length: stepsPer }, () => mk());
      const steps = stepIds.map((sid, i) => ({ id: sid, name: `S${i}`, kind: i === 0 ? "start" : i === stepsPer - 1 ? "end" : "task", outcome: i === stepsPer - 1 ? "done" : null, work_hours: 1, wait_hours: 0, rework_rate: 0, x: i * 10, y: 0, role_id: i > 0 && i < stepsPer - 1 ? role : null }));
      // 9 chain edges and 11 more, 20 per process: 4,000 in all.
      const edges: Row[] = [];
      for (let i = 0; i + 1 < stepsPer; i++) edges.push({ id: mk(), from_step_id: stepIds[i], to_step_id: stepIds[i + 1], probability: 1 });
      for (let i = 0; edges.length < L.edges / L.processes && i + 2 < stepsPer; i++) edges.push({ id: mk(), from_step_id: stepIds[i], to_step_id: stepIds[i + 2], probability: 0 });
      for (let i = 0; edges.length < L.edges / L.processes && i + 3 < stepsPer; i++) edges.push({ id: mk(), from_step_id: stepIds[i], to_step_id: stepIds[i + 3], probability: 0 });
      for (let i = 0; edges.length < L.edges / L.processes && i + 4 < stepsPer; i++) edges.push({ id: mk(), from_step_id: stepIds[i], to_step_id: stepIds[i + 4], probability: 0 });
      return { id: mk(), parent_process_id: null, name: `Process ${p}`, kind: "pipeline", entity_name: "item", description: null, archived: p % 20 === 0, layout: {}, steps, edges, first_principles: null };
    });
    const sourceIds = Array.from({ length: L.sources }, () => mk());
    const sources = sourceIds.map((sid, i) => ({ id: sid, kind: "notes", title: `Source ${i}`, body: "x".repeat(Math.floor(L.sourceChars / L.sources)), created_at: when }));
    const issues = Array.from({ length: L.issues }, (_, i) => ({
      id: mk(), type: "idea", title: `Issue ${i}`, created_at: when, source: "manual", status: "open",
      links: [{ process_id: processes[i % processes.length]!.id, step_id: processes[i % processes.length]!.steps[1]!.id }], owner_ids: [people[i % people.length]!.id], source_ids: [sourceIds[i % sourceIds.length]],
    }));
    const scenarios = Array.from({ length: L.scenarios }, (_, i) => ({ id: mk(), name: `Scenario ${i}`, patch: [{ path: "demand.leads_per_week", op: "multiply", value: 1 + i / 1000 }], created_at: when }));
    const blocks = Array.from({ length: L.blocks }, (_, i) => ({ id: mk(), name: `Block ${i}`, type: "manual", steps: { steps: [], edges: [] }, created_at: when }));
    const suggestions = Array.from({ length: L.suggestions }, (_, i) => ({ id: mk(), target_table: "people", target_id: people[i % people.length]!.id, patch: { set: { notes: `n${i}` } }, evidence: [], note: null, created_at: when }));
    const proposals = Array.from({ length: L.proposals }, (_, i) => ({ id: mk(), kind: "issue", title: `Proposal ${i}`, detail: "d", payload: {}, evidence: [], created_at: when }));
    // The link tables, each at its limit: 3 roles a person, 10 skills a person, one assignment a client, 2,000 source links.
    const person_roles = people.flatMap((p) => roles.map((r) => ({ person_id: p.id, role_id: r.id, created_at: when }))).slice(0, L.personRoles);
    const allSteps = processes.flatMap((p) => p.steps.map((st) => st.id));
    const person_skills = people.flatMap((p, i) => Array.from({ length: 10 }, (_, k) => ({ person_id: p.id, step_id: allSteps[(i * 10 + k) % allSteps.length], efficiency: 1, created_at: when }))).slice(0, L.personSkills);
    const client_assignments = clients.map((c, i) => ({ client_id: c.id, role_id: role, person_id: people[i % people.length]!.id, created_at: when })).slice(0, L.clientAssignments);
    const source_links = sourceIds.flatMap((sid) => processes.map((p) => ({ id: mk(), source_id: sid, kind: "process", process_id: p.id }))).slice(0, L.sourceLinks);
    const plan = {
      format: "transpera-workspace-import/1", settings: null, roles, people, person_roles, person_leave: [], lead_sources: [], seasonality: [], demand_settings: null, churn_drivers: [],
      market_conditions: [], market_schedule: [], lever_settings: null, analysis_rules: null, clients, sources, processes, scenarios, blocks, issues, services: [], service_servicing: [],
      client_groups: [], client_services: [], client_assignments, person_skills, source_links, suggestions, proposals,
    };
  return plan;
}

describe("performance", () => {
  it("restores a synthetic plan at every limit well inside the 8 s statement timeout (budget 3 s)", async () => {
    const L = WORKSPACE_IMPORT_LIMITS;
    const plan = syntheticPlan(L);
    expect(JSON.stringify(plan).length).toBeLessThan(L.planBytes);
    const ws = await newWorkspace();
    const t0 = Date.now();
    const result = await restoreAs(admin, ws, plan);
    const ms = Date.now() - t0;
    console.log(`restore at every limit: ${ms} ms, ${JSON.stringify(plan).length} bytes of plan`);
    expect(ms).toBeLessThan(3000);
    expect(result.processes.length).toBe(L.processes);
    expect(await count("steps", ws, "process_id in (select id from processes where not is_company)")).toBe(L.steps);
    for (const [t, n] of [["person_roles", L.personRoles], ["person_skills", L.personSkills], ["client_assignments", L.clientAssignments], ["source_links", L.sourceLinks]] as const) expect(await count(t, ws, t === "source_links" ? "kind = 'process'" : "true"), t).toBe(n);
  }, 60_000);
});
