import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import { timeSplitOf, workingShare } from "../../../apps/web/src/lib/overview/time-split";
import type pg from "pg";
import {
  BUNDLE_TABLES,
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
import { headerRollback } from "./header-rollback";

// #228 (C6 follow-up, migration 20261226000000): a restore brings per-person times (`person_capacity_factors`) back. The round trip with
// per-person times switched on (the restored engine model equals the source's, and the headline results are within run-to-run variation,
// as #209's round trip in workspace-import.test.ts), and the function: a plan from before the migration, the refusals of the new section,
// all or nothing, the settings, the body (the old body plus the six marked hunks) and the header's rollback. The planner's own tests are
// in workspace-import-plan.test.ts; the at-the-limits restore is in workspace-import-large.test.ts. Made with Supabase's default privileges.

const FILE = "20261226000000_restore_capacity_factors.sql";
const B21_FILE = "20261215000000_bigger_restores.sql";
const B21_MD5 = "32b64f2ad9be79d0044f640e4a4d2ed2";
const SOURCE = NORTHBEAM_WORKSPACE_ID;

let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
let admin: User;
let sourceEditor: User;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  admin = await createUser(db, "admin@import-factors.example.com", { agency_admin: true });
  sourceEditor = await member(SOURCE, "editor");
  await setUpFactors();
}, 120_000);
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

async function newWorkspace(name = "Restored Co"): Promise<string> {
  seq++;
  return as(admin.claims, async (c) => (await c.query("select public.create_workspace($1, $2) as id", [name, `factors-${seq}-${Date.now()}`])).rows[0].id as string);
}

async function member(ws: string, role: string): Promise<User> {
  const user = await createUser(db, `u${++seq}.${role}@import-factors.example.com`);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  return user;
}

/** A backup of a workspace, as an editor exports it (JSON round trip, as a file). */
async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
  const editor = await member(workspaceId, "editor");
  const bundle = await db.as(editor.claims, async (c) => {
    const read: TableReader = async (table, wsId) => {
      const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
      return (await c.query(`select to_jsonb(t) as j from (select ${spec.columns ?? "*"} from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
    };
    const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
    return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
  });
  return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
}

let bundleCache: WorkspaceBundle | null = null;
async function sourceBundle(): Promise<WorkspaceBundle> {
  bundleCache ??= await exportOf(SOURCE);
  return structuredClone(bundleCache);
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
  "roles", "people", "person_roles", "person_leave", "person_skills", "person_capacity_factors", "lead_sources", "seasonality", "demand_settings", "churn_drivers", "market_conditions",
  "market_schedule", "lever_settings", "analysis_rules", "clients", "client_services", "client_assignments", "services", "service_servicing", "client_groups", "sources", "source_links",
  "processes", "process_revisions", "steps", "edges", "first_principles", "scenarios", "blocks", "issues", "issue_links", "issue_owners", "issue_sources", "issue_events", "suggestions",
  "suggestion_proposals", "solutions", "audit_log",
];
async function snapshot(ws: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await count(t, ws);
  out.settings = Number((await q("select count(*) from workspaces where id = $1 and settings = (select settings from workspaces where id = $1)", [ws]))[0]!.count);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The source: Northbeam with per-person times switched on, set by an editor through `save_capacity_factor`.

const save = (c: pg.Client, person: string, step: string | null, value: number) => c.query("select public.save_capacity_factor($1, $2, null, $3) as r", [person, step, value]);

let sourceFactorCount = 0;
async function setUpFactors() {
  await as(sourceEditor.claims, (c) =>
    c.query("select public.save_capacity_factor_switch($1, '{\"capacity_factor_enabled\": null}'::jsonb, '{\"capacity_factor_enabled\": true}'::jsonb)", [SOURCE]),
  );
  // What each person does (the C6 rule): the steps of their skills, else the steps of their roles, in the live version of the pipeline.
  const [pipeline] = await q("select live_revision_id from processes where workspace_id = $1 and kind = 'pipeline' and not is_company and archived_at is null", [SOURCE]);
  const steps = await q("select id, role_id from steps where revision_id = $1 and role_id is not null order by id", [pipeline!.live_revision_id]);
  const people = await q("select id from people where workspace_id = $1 and active order by id", [SOURCE]);
  const can = new Map<string, { does: string[]; doesNot: string[] }>();
  for (const p of people) {
    const skills = (await q("select step_id from person_skills where person_id = $1", [p.id])).map((r) => r.step_id as string);
    const roles = (await q("select role_id from person_roles where person_id = $1", [p.id])).map((r) => r.role_id as string);
    const inPipeline = steps.map((s) => s.id as string);
    const does = skills.length ? inPipeline.filter((s) => skills.includes(s)) : steps.filter((s) => roles.includes(s.role_id as string)).map((s) => s.id as string);
    can.set(p.id as string, { does, doesNot: inPipeline.filter((s) => !does.includes(s)) });
  }
  const withSteps = people.map((p) => p.id as string).filter((id) => can.get(id)!.does.length > 0 && can.get(id)!.doesNot.length > 0);
  expect(withSteps.length).toBeGreaterThanOrEqual(4);
  const [a, b, c, d] = withSteps as [string, string, string, string];
  await as(sourceEditor.claims, async (cl) => {
    await save(cl, a, null, 0.9); // "Every step"
    await save(cl, b, can.get(b)!.does[0]!, 0.8); // a step they do
    await save(cl, c, can.get(c)!.does[0]!, 1.25);
    await save(cl, d, can.get(d)!.doesNot[0]!, 1.5); // a step they can't do: stored, unused
  });
  sourceFactorCount = await count("person_capacity_factors", SOURCE);
  expect(sourceFactorCount).toBe(4);
}

// The loader of the round trip (workspace-import.test.ts' `loadPipeline`), with the per-person times in `team_capacity`'s shape.
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
      personCapacityFactors: await many(
        "select person_id, step_id, workspace_id, factor::float8 as factor, coalesce(provenance -> 'factor' ->> 'source', 'entered') as source from person_capacity_factors where workspace_id = $1 order by person_id, step_id nulls first",
        [wsId],
      ),
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

/** Publish every restored process; the order that works is children before the processes that hold them. */
async function publishAll(owner: User, restored: Restored) {
  const pending = restored.processes.filter((p) => !p.archived).map((p) => p.id);
  for (let pass = 0; pending.length > 0 && pass < 10; pass++) {
    for (const id of [...pending]) {
      const reply = await as(owner.claims, async (c) => (await c.query("select public.publish_process($1, true) as r", [id])).rows[0].r);
      if (reply.status === "published") pending.splice(pending.indexOf(id), 1);
    }
  }
  expect(pending).toEqual([]);
}

/** Restore a plan into a new workspace as its owner and publish everything. */
async function restoreAndPublish(plan: ImportPlan) {
  const ws = await newWorkspace("Northbeam restored");
  const owner = await member(ws, "owner");
  const restored = await restoreAs(owner, ws, plan);
  await publishAll(owner, restored);
  return { ws, owner, restored };
}

const OPTS = { startDate: "2026-10-05" };
/** A fresh plan of the source workspace, with its per-person times. */
const plan = async (): Promise<ImportPlan> => structuredClone(planWorkspaceImport(await sourceBundle(), { canManage: true }).plan);
const byPair = (a: { person_id: string; step_id: string | null }, b: { person_id: string; step_id: string | null }) =>
  a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : (a.step_id ?? "") < (b.step_id ?? "") ? -1 : (a.step_id ?? "") > (b.step_id ?? "") ? 1 : 0;

// ---------------------------------------------------------------------------------------------------------------------------

describe("a restore brings per-person times back (round trip)", () => {
  it("restores the model with its per-person times, and the headline results are within run-to-run variation", async () => {
    const bundle = await sourceBundle();
    const check = checkWorkspaceBundle(bundle);
    expect(check.errors).toEqual([]);
    expect(check.summary.restored.find((l) => l.key === "person_capacity_factors")).toMatchObject({ count: sourceFactorCount, label: "per-person times" });
    expect(check.warnings.filter((w) => w.includes("per-person times"))).toEqual([]);
    const planned = planWorkspaceImport(bundle, { canManage: true });
    expect(planned.plan.person_capacity_factors).toHaveLength(sourceFactorCount);
    const { ws, restored } = await restoreAndPublish(planned.plan);
    expect(restored.counts.person_capacity_factors).toBe(sourceFactorCount);

    const before = await loadPipeline(admin.claims, SOURCE);
    const after = await loadPipeline(admin.claims, ws);
    expect(before.workspace.settings.capacity_factor_enabled).toBe(true);
    expect(after.workspace.settings.capacity_factor_enabled).toBe(true);

    // (1) The restored engine model equals the source's, once ids are mapped back, and the per-person times are in it.
    const modelBefore = toEngineModel(before, OPTS);
    const modelAfter = JSON.parse(backToOld(toEngineModel(after, OPTS), restored, ws, planned.placeholderOf, SOURCE));
    const withFactor = Object.values(modelBefore.people ?? {}).filter((p) => p.capacityFactor !== undefined);
    expect(withFactor.length).toBeGreaterThanOrEqual(3);
    expect(modelAfter).toEqual(JSON.parse(JSON.stringify(modelBefore)));

    // The stored rows, mapped back, are the source's: factor, step (or none), and where the time came from and by whom.
    const rowsOf = async (w: string) =>
      (await q("select person_id, step_id, factor::float8 as factor, provenance -> 'factor' as provenance from person_capacity_factors where workspace_id = $1", [w])) as unknown as { person_id: string; step_id: string | null; factor: number; provenance: Row }[];
    const sourceRows = (await rowsOf(SOURCE)).sort(byPair);
    const restoredRows = (JSON.parse(backToOld(await rowsOf(ws), restored, ws, planned.placeholderOf, SOURCE)) as typeof sourceRows).sort(byPair);
    expect(restoredRows).toHaveLength(4);
    expect(restoredRows.map((r) => [r.person_id, r.step_id, r.factor, r.provenance.source])).toEqual(sourceRows.map((r) => [r.person_id, r.step_id, r.factor, r.provenance.source]));
    expect(restoredRows.every((r) => r.provenance.source === "entered")).toBe(true);
    // The provenance is carried as exported: the source and when it was entered. The export removes who entered it (`by`, an account id:
    // "everything about who made what" isn't in a backup, as for people and steps), so the restored row has no `by`.
    expect(sourceRows.every((r) => typeof r.provenance.by === "string" && typeof r.provenance.at === "string")).toBe(true);
    expect(restoredRows.map((r) => r.provenance)).toEqual(sourceRows.map((r) => ({ source: r.provenance.source, at: r.provenance.at })));

    // (2) Headline results. The same two-sample test as workspace-import.test.ts (#209), with its reasoning. The engine seeds its random
    // streams by hashing step, service and client ids into their labels (packages/engine/src/simulate.ts), so a restore, whose ids are
    // all new, draws different random numbers at the same seed, and no seed reproduces the source's numbers. What must hold is that the
    // restored workspace simulates to the same distribution as the source (decision recorded on #39), so this is a two-sample test of
    // means, per headline metric the Overview shows:
    //   - Each side is run RUNS times (30 replications each, as the app runs), source at seeds 42.., restored at seeds 1042..
    //     (disjoint, so the two samples are independent). One run's headline value is a mean of 30 replications, so close to normal.
    //   - t = (mean restored - mean source) / sqrt(var source / RUNS + var restored / RUNS), the sample variances measured here, so the
    //     tolerance follows each metric's own run-to-run spread. With equal sizes and equal true variances (a faithful restore) t follows
    //     Student's t with 2 x RUNS - 2 = 30 degrees of freedom: P(|t| > 6) = 1.4e-6 per metric.
    //   - What it still catches: a shift of more than about 2.1 run-to-run standard deviations fails. The model comparison above catches
    //     a dropped step, a wrong duration, a lost edge or a lost per-person time exactly; this guards the part it can't see (what the ids
    //     alone change).
    // A metric that doesn't vary between runs (no spread on either side) must match exactly.
    const RUNS = 16;
    const T_MAX = 6;
    const modelAfterNew = toEngineModel(after, OPTS);
    const headline = (m: typeof modelBefore, r: ReturnType<typeof simulate>) => ({
      flowEfficiency: workingShare(timeSplitOf(m, r) ?? { handsOn: 0, waitingForPerson: 0, waitingOnOthers: 0 }) ?? 0,
      throughputDone: r.kpi.done.mean,
      throughputWon: r.kpi.won.mean,
      leadTime: r.kpi.cycle.mean,
      costPerWin: r.kpi.costPerWin.mean,
      labour: r.kpi.labour.mean,
    });
    const runs = (m: typeof modelBefore, firstSeed: number) => Array.from({ length: RUNS }, (_, i) => headline(m, simulate(m, 30, firstSeed + i)));
    const src = runs(modelBefore, 42);
    const res = runs(modelAfterNew, 1042);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = (xs: number[], m = mean(xs)) => xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    for (const k of Object.keys(src[0]!) as (keyof (typeof src)[0])[]) {
      const s = src.map((o) => o[k]);
      const r = res.map((o) => o[k]);
      const se = Math.sqrt(variance(s) / RUNS + variance(r) / RUNS);
      const label = `${k}: restored mean ${mean(r)}, source mean ${mean(s)}, standard error ${se}`;
      if (se === 0) expect(mean(r), label).toBe(mean(s));
      else expect(Math.abs(mean(r) - mean(s)) / se, label).toBeLessThanOrEqual(T_MAX);
    }
  }, 180_000);

  it("the rule bites: the same restore without the per-person times gives a different model", async () => {
    const bundle = await sourceBundle();
    const planned = planWorkspaceImport(bundle, { canManage: true });
    const without: ImportPlan = structuredClone(planned.plan);
    without.person_capacity_factors = [];
    const { ws, restored } = await restoreAndPublish(without);
    expect(await count("person_capacity_factors", ws)).toBe(0);
    const modelBefore = toEngineModel(await loadPipeline(admin.claims, SOURCE), OPTS);
    const modelAfter = JSON.parse(backToOld(toEngineModel(await loadPipeline(admin.claims, ws), OPTS), restored, ws, planned.placeholderOf, SOURCE));
    expect(modelAfter).not.toEqual(JSON.parse(JSON.stringify(modelBefore)));
  }, 120_000);

  it("as an editor: the times are restored, and the switch arrives with the settings as one pending suggestion for an owner", async () => {
    const bundle = await sourceBundle();
    const planned = planWorkspaceImport(bundle, { canManage: false });
    const ws = await newWorkspace();
    const editor = await member(ws, "editor");
    const result = await restoreAs(editor, ws, planned.plan, "northbeam.json");
    expect(result.settings).toBe("suggested");
    expect(result.counts.person_capacity_factors).toBe(sourceFactorCount);
    expect(await count("person_capacity_factors", ws)).toBe(sourceFactorCount);
    // The factors are stored; the switch is still off until an owner accepts the suggestion.
    const [row] = await q("select settings from workspaces where id = $1", [ws]);
    expect(row!.settings).not.toHaveProperty("capacity_factor_enabled");
    const pending = await q("select patch, status from suggestions where workspace_id = $1 and note = 'Workspace settings from a backup.'", [ws]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending" });
    expect((pending[0]!.patch as { set: Record<string, unknown> }).set.capacity_factor_enabled).toBe(true);
    // Who entered each time is the editor of the source workspace; the restoring editor is the creator of the row (`created_by`).
    expect(Number((await q("select count(*) from person_capacity_factors where workspace_id = $1 and created_by = $2", [ws, editor.id]))[0]!.count)).toBe(sourceFactorCount);
  }, 120_000);

  it("a numeric string and a number for a factor both restore, to the same stored value", async () => {
    const bundle = await sourceBundle();
    const rows = bundle.company_model.person_capacity_factors as Row[];
    rows.forEach((r, i) => { if (i % 2 === 0) r.factor = String(r.factor); });
    expect(checkWorkspaceBundle(bundle).errors).toEqual([]);
    const planned = planWorkspaceImport(bundle, { canManage: true });
    expect(planned.plan.person_capacity_factors.every((r) => typeof r.factor === "number")).toBe(true);
    const ws = await newWorkspace();
    await restoreAs(await member(ws, "owner"), ws, planned.plan);
    const stored = (await q("select factor::float8 as factor from person_capacity_factors where workspace_id = $1 order by factor", [ws])).map((r) => r.factor as number);
    expect(stored).toEqual((await q("select factor::float8 as factor from person_capacity_factors where workspace_id = $1 order by factor", [SOURCE])).map((r) => r.factor as number));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

describe("import_workspace_bundle and per-person times", () => {
  it("restores a plan made before #228 (no such section) as it did before, with no times", async () => {
    const old = (await plan()) as unknown as Record<string, unknown>;
    delete old.person_capacity_factors;
    expect(old).not.toHaveProperty("person_capacity_factors");
    const ws = await newWorkspace();
    const result = await restoreAs(await member(ws, "owner"), ws, old);
    expect(result.processes.length).toBeGreaterThan(0);
    expect(result.counts.person_capacity_factors).toBe(0);
    expect(await count("person_capacity_factors", ws)).toBe(0);
    expect(await count("people", ws)).toBeGreaterThan(0);
    // A key that is there must still be a list.
    for (const bad of [null, {}, "x"]) {
      const copy = (await plan()) as unknown as Record<string, unknown>;
      copy.person_capacity_factors = bad;
      const w = await newWorkspace();
      const e = await failure(() => restoreAs(admin, w, copy));
      expect([e.code, e.message]).toEqual(["22023", "import_workspace_bundle: person_capacity_factors must be a list"]);
    }
  }, 120_000);

  it("refuses a real (non-placeholder) uuid in person_id or step_id, writing nothing", async () => {
    for (const col of ["person_id", "step_id"]) {
      const copy = await plan();
      copy.person_capacity_factors[0]![col] = "123e4567-e89b-42d3-a456-426614174000";
      const ws = await newWorkspace();
      const before = await snapshot(ws);
      const e = await failure(() => restoreAs(admin, ws, copy));
      expect(e.code, col).toBe("22023");
      expect(e.message, col).toBe(`import_workspace_bundle: ${col} holds an id that is not a placeholder in person_capacity_factors`);
      expect(await snapshot(ws)).toEqual(before);
    }
    // Not a string either.
    const copy = await plan();
    copy.person_capacity_factors[0]!.step_id = 5;
    expect((await failure(async () => restoreAs(admin, await newWorkspace(), copy))).code).toBe("22023");
  }, 120_000);

  it("refuses one over 3,000 with the limits sentence ending ', 3000 per-person times)', writing nothing", async () => {
    expect(WORKSPACE_IMPORT_LIMITS.capacityFactors).toBe(3000);
    const copy = await plan();
    copy.person_capacity_factors = Array.from({ length: 3001 }, () => ({}));
    const ws = await newWorkspace();
    const before = await snapshot(ws);
    const e = await failure(() => restoreAs(admin, ws, copy));
    expect(e.code).toBe("22023");
    expect(e.message).toMatch(/^import_workspace_bundle: the plan is over a limit \(.*1500 other company settings rows, 3000 per-person times\)$/);
    expect(await snapshot(ws)).toEqual(before);
  }, 120_000);

  it("all or nothing: a factor of 3 in a hand-made plan fails the section (hint section:person_capacity_factors) and every table is unchanged", async () => {
    const copy = await plan();
    copy.person_capacity_factors[0]!.factor = 3;
    const ws = await newWorkspace();
    const owner = await member(ws, "owner");
    const before = await snapshot(ws);
    const e = await failure(() => restoreAs(owner, ws, copy));
    expect(e.code).toBe("23514");
    expect(e.hint).toBe("section:person_capacity_factors");
    expect(e.message).toMatch(/^import_workspace_bundle: person_capacity_factors could not be restored: /);
    expect(await snapshot(ws)).toEqual(before);
    expect(await count("people", ws)).toBe(0);
  }, 120_000);

  it("is refused for an API token, a member and a viewer (42501), writing nothing", async () => {
    const copy = await plan();
    const ws = await newWorkspace();
    const token = { ...(await member(ws, "owner")).claims, api_token_id: randomUUID() };
    const others = [{ claims: token }, await member(ws, "member"), await member(ws, "viewer")] as User[];
    const before = await snapshot(ws);
    for (const who of others) {
      const e = await failure(() => restoreAs(who, ws, copy));
      expect(e.code).toBe("42501");
    }
    expect(await snapshot(ws)).toEqual(before);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------

const sqlOf = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
/** The text between the first `$$` and the last `$$` of a function (what `pg_proc.prosrc` holds). */
const bodyOf = (sql: string) => {
  const fn = sql.slice(sql.search(/^create (?:or replace )?function /m));
  return fn.slice(fn.indexOf("$$") + 2, fn.lastIndexOf("$$"));
};
const FN = "public.import_workspace_bundle(uuid, jsonb, text)";

describe("the function and the migration", () => {
  it("is SECURITY INVOKER with its 40 s timeout, only authenticated may execute it, and the live body is this migration's", async () => {
    const [fn] = await q(`select prosecdef, proconfig, md5(prosrc) as md5 from pg_proc where oid = '${FN}'::regprocedure`);
    expect(fn!.prosecdef).toBe(false);
    expect(fn!.proconfig).toEqual(['search_path=""', "statement_timeout=40s"]);
    const grants = await q("select grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'import_workspace_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1");
    expect(grants).toEqual([{ grantee: "authenticated", privilege_type: "EXECUTE" }]);
    const sql = sqlOf(FILE);
    expect(fn!.md5).toBe(md5(bodyOf(sql)));
    // The header says the body's md5 (the post-apply check), and the md5 it replaces (the preflight).
    expect(sql).toContain(`${fn!.md5}:`);
    expect(sql).toContain(B21_MD5);
    expect(md5(bodyOf(sqlOf(B21_FILE)))).toBe(B21_MD5);
  });

  it("is B21's body plus only the six marked hunks (the body with them taken out equals B21's, character for character)", () => {
    const old = bodyOf(sqlOf(B21_FILE));
    const body = bodyOf(sqlOf(FILE));
    // Seven marker lines: one for each of (a) to (e), and two in (f).
    expect(body.match(/^ *-- #228/gm)).toHaveLength(7);
    const once = (text: string, from: string | RegExp, to: string, times = 1) => {
      const found = typeof from === "string" ? text.split(from).length - 1 : (text.match(new RegExp(from.source, `${from.flags}g`)) ?? []).length;
      expect(found, String(from)).toBe(times);
      return typeof from === "string" ? text.split(from).join(to) : text.replace(new RegExp(from.source, `${from.flags}g`), to);
    };
    let s = body;
    // The marker lines (and the comment line that goes with (a)'s and (e)'s).
    s = once(s, /^ *-- #228.*\n/m, "", 7);
    // (a) allow.
    s = once(s, '"person_capacity_factors":["person_id","step_id","factor","provenance"],', "");
    // (b) ref_cols.
    s = once(s, ",'person_capacity_factors.person_id','person_capacity_factors.step_id'", "");
    // (c) sections and (d) list_sections.
    s = once(s, "'person_skills','person_capacity_factors'", "'person_skills'", 2);
    // (e) a plan from before #228.
    s = once(s, /^ {2}-- it restores as an empty one\.\n {2}if not p_plan \? 'person_capacity_factors' then\n {4}p_plan := p_plan \|\| '\{"person_capacity_factors": \[\]\}'::jsonb;\n {2}end if;\n/m, "");
    // (f) the limit and its message.
    s = once(s, "    or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000\n", "");
    s = once(s, ", 3000 per-person times)", ")");
    expect(s.length).toBeGreaterThan(30_000);
    expect(s).toBe(old);
    // The header of the statement is B21's (same signature, SECURITY INVOKER, same settings).
    const head = (sql: string) => sql.slice(sql.search(/^create or replace function public\.import_workspace_bundle/m)).split("as $$")[0];
    expect(head(sqlOf(FILE))).toBe(head(sqlOf(B21_FILE)));
    expect(head(sqlOf(FILE))).toContain("security invoker");
    expect(head(sqlOf(FILE))).toContain("set statement_timeout = '40s'");
  });

  it("changes nothing but the function (no other function, trigger, policy or table)", () => {
    const sql = sqlOf(FILE);
    const outside = sql.replace(bodyOf(sql), "").split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect([...outside.matchAll(/^(create index|create or replace function|create|drop|alter|insert|update|delete|revoke|grant)\b/gim)].map((m) => m[1]!.toLowerCase())).toEqual(["create or replace function", "revoke", "grant"]);
  });

  it("has a header rollback that puts B21's function back: the old md5, the 40 s timeout, and a plan with times restores without them", async () => {
    const rollback = headerRollback(FILE);
    expect(rollback).toMatch(/^begin;/);
    expect(rollback).toMatch(/commit;$/);
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '20261226000000';");
    // B21's whole statement, with `create or replace`, as the operator would run it.
    const b21 = sqlOf(B21_FILE);
    const b21fn = b21.slice(b21.search(/^create or replace function public\.import_workspace_bundle/m), b21.lastIndexOf("$$") + 3);
    expect(rollback).toContain(b21fn);
    expect(rollback).toContain("revoke all on function public.import_workspace_bundle(uuid, jsonb, text) from public, anon, authenticated;\ngrant execute on function public.import_workspace_bundle(uuid, jsonb, text) to authenticated;");
    expect(md5(bodyOf(rollback))).toBe(B21_MD5);

    const live = String((await q(`select md5(prosrc) as md5 from pg_proc where oid = '${FN}'::regprocedure`))[0]!.md5);
    const copy = await plan();
    // In a transaction that is rolled back: the operator's `begin;` and `commit;` are left out, everything between them runs.
    await db.client.query("begin");
    try {
      await db.client.query("create schema if not exists supabase_migrations");
      await db.client.query("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
      await db.client.query("insert into supabase_migrations.schema_migrations (version, name) values ('20261226000000', 'restore_capacity_factors') on conflict do nothing");
      await db.client.query(rollback.replace(/^begin;/, "").replace(/commit;$/, ""));
      const [fn] = await q(`select prosecdef, proconfig, md5(prosrc) as md5 from pg_proc where oid = '${FN}'::regprocedure`);
      expect(fn!.md5).toBe(B21_MD5);
      expect(fn!.prosecdef).toBe(false);
      expect(fn!.proconfig).toEqual(['search_path=""', "statement_timeout=40s"]);
      expect(await q("select version from supabase_migrations.schema_migrations where version = '20261226000000'")).toEqual([]);
      expect(await q("select grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'import_workspace_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1")).toEqual([{ grantee: "authenticated" }]);
      // The old function ignores the section: the restore works and writes no times.
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin.claims)]);
      const ws = (await db.client.query("select public.create_workspace('Rolled back', $1) as id", [`rolled-back-${Date.now()}`])).rows[0].id as string;
      const result = await callRestore(db.client, ws, copy);
      expect(result.processes.length).toBeGreaterThan(0);
      expect(result.counts).not.toHaveProperty("person_capacity_factors");
      await db.client.query("reset role");
      expect(await count("person_capacity_factors", ws)).toBe(0);
      expect(await count("people", ws)).toBeGreaterThan(0);
    } finally {
      await db.client.query("rollback");
    }
    // Rolled back: the new function is back.
    expect(String((await q(`select md5(prosrc) as md5 from pg_proc where oid = '${FN}'::regprocedure`))[0]!.md5)).toBe(live);
  }, 120_000);

  it("has an apply file that is the migration plus its schema_migrations row, in one transaction", () => {
    const dir = new URL("../", import.meta.url);
    const mig = readFileSync(new URL(`supabase/migrations/${FILE}`, dir), "utf8").trimEnd();
    const apply = readFileSync(new URL(`scripts/apply/${FILE}`, dir), "utf8");
    expect(apply).toContain("\nbegin;\nset local lock_timeout = '5s';");
    expect(apply.split(mig).length - 1).toBe(2);
    expect(apply).toContain("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261226000000', 'restore_capacity_factors', array[$mig$" + mig);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
  });
});
