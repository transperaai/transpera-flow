import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  BUNDLE_TABLES,
  IMPORT_REFS,
  NORTHBEAM_WORKSPACE_ID,
  PLACEHOLDER_PREFIX,
  WORKSPACE_IMPORT_LIMITS,
  checkWorkspaceBundle,
  exportWorkspaceBundle,
  planWorkspaceImport,
  restoreSizeWarning,
  type ImportPlan,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";
import { otherShape, syntheticPlan, type Limits } from "./synthetic-plan";

// B21 (issue #203, migration 20261215000000): bigger restores in the same one call. The performance test (every limit at once,
// every table at its limit), the export of a workspace at the limits, the three new caps, the id remap (two plain replacements now),
// the "already running" refusal, the function's settings and index, and that the migration's rollback and the new body are
// what the brief says. The round trip itself stays in workspace-import.test.ts. Made with Supabase's default privileges, as production.

let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
let admin: User;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  admin = await createUser(db, "admin@import-large.example.com", { agency_admin: true });
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


// The Mini workspace of workspace-import.test.ts (a copy): every awkward case in a few rows.
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


const L = WORKSPACE_IMPORT_LIMITS;
const sqlOf = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const OLD_MIGRATION = "20261207000000_import_workspace_bundle.sql";
const NEW_MIGRATION = "20261215000000_bigger_restores.sql";
/** The latest migration that defines `import_workspace_bundle` (#228 replaced B21's body, which NEW_MIGRATION still holds). */
const LATEST_MIGRATION = "20261226000000_restore_capacity_factors.sql";
const OLD_MD5 = "968cbd0034a0bb1479b8ee0c9eaf7962";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
/** The text between the first `$$` and the last `$$` of a function (what `pg_proc.prosrc` holds). */
const bodyOf = (sql: string) => {
  const fn = sql.slice(sql.search(/^create (?:or replace )?function /m));
  return fn.slice(fn.indexOf("$$") + 2, fn.lastIndexOf("$$"));
};
/** Each limit divided by `k`, rounded down (a smaller synthetic plan for the tests that don't time anything). */
const scaled = (k: number): Limits => Object.fromEntries(Object.entries(L).map(([key, v]) => [key, Math.floor(v / k)])) as Limits;

/** Where a restored id comes from: the placeholder's rank under the restore's fresh prefix; rank 0 is the workspace. */
const realId = (placeholder: string, prefix: string, ws: string) => (placeholder === `${PLACEHOLDER_PREFIX}000000000000` ? ws : prefix + placeholder.slice(PLACEHOLDER_PREFIX.length));
const TABLE_OF: Record<string, string> = { proposals: "suggestion_proposals" };

/** The CPU time (user and system, ms) the database backend of the test connection has used, from /proc (Linux); null where it can't be read. The wall clock below is noisy on a shared machine, this isn't. */
async function backendCpuMs(): Promise<number | null> {
  try {
    const pid = Number((await q("select pg_backend_pid() as pid"))[0]!.pid);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(f[11]) + Number(f[12])) * 10;
  } catch {
    return null;
  }
}

const BUDGET_MS = 15_000;
/** Loose ceiling on the wall clock when the budget is judged on database CPU: a shared machine can stretch the clock, not the CPU time. */
const WALL_CEILING_MS = 30_000;
/** What breaks the 15 s budget: the database CPU time when it is known (steady under load), otherwise the wall clock (CI, where Postgres is a service container). */
function overBudget(wallMs: number, cpuMs: number | null): string | null {
  if (cpuMs !== null) {
    if (cpuMs >= BUDGET_MS) return `${cpuMs} ms of database CPU is over the ${BUDGET_MS} ms budget`;
    if (wallMs >= WALL_CEILING_MS) return `${wallMs} ms of wall clock is over the ${WALL_CEILING_MS} ms ceiling`;
    return null;
  }
  return wallMs >= BUDGET_MS ? `${wallMs} ms of wall clock is over the ${BUDGET_MS} ms budget` : null;
}

describe("the 15 s budget", () => {
  it("is judged on database CPU when it is known, so a busy machine's slow clock doesn't fail it", () => {
    expect(overBudget(21_000, 9_700)).toBeNull();
    expect(overBudget(16_000, 14_999)).toBeNull();
    expect(overBudget(10_000, 15_000)).toMatch(/database CPU/);
    expect(overBudget(31_000, 5_000)).toMatch(/ceiling/);
  });
  it("falls back to the wall clock when the CPU time can't be read", () => {
    expect(overBudget(14_999, null)).toBeNull();
    expect(overBudget(15_000, null)).toMatch(/wall clock/);
  });
});

describe("every limit at once", () => {
  it("restores a synthetic plan with every table at its limit in one call, inside the 15 s budget", async () => {
    const plan = syntheticPlan(L);
    const bytes = JSON.stringify(plan).length;
    expect(bytes).toBeLessThan(L.planBytes);
    const ws = await newWorkspace();
    const cpu0 = await backendCpuMs();
    const t0 = Date.now();
    const result = await restoreAs(admin, ws, plan);
    const ms = Date.now() - t0;
    const cpu1 = await backendCpuMs();
    console.log(`B21 restore at every limit: ${ms} ms wall clock, ${cpu0 !== null && cpu1 !== null ? `${cpu1 - cpu0} ms of database CPU` : "database CPU unknown"}, ${bytes} bytes of plan (${(bytes / 1024 / 1024).toFixed(1)} MB), load ${os.loadavg()[0]!.toFixed(1)} on ${os.cpus().length} CPUs`);
    expect(overBudget(ms, cpu0 !== null && cpu1 !== null ? cpu1 - cpu0 : null)).toBeNull();

    const notCompany = "process_id in (select id from public.processes where not is_company)";
    const o = otherShape(L.companyOther);
    expect(Object.values(o).reduce((a, b) => a + b, 0)).toBe(L.companyOther);
    const expected: [string, number, string?][] = [
      ["processes", L.processes, "not is_company"],
      ["steps", L.steps, notCompany],
      ["edges", L.edges, notCompany],
      ["people", L.people],
      ["clients", L.clients],
      ["issues", L.issues],
      ["issue_links", L.issues],
      ["issue_owners", L.issues],
      ["issue_sources", L.issues],
      ["sources", L.sources],
      // The four library scenarios every new workspace has come on top of the plan's.
      ["scenarios", L.scenarios + 4],
      ["blocks", L.blocks],
      ["suggestions", L.suggestions],
      ["suggestion_proposals", L.proposals],
      ["person_roles", L.personRoles],
      ["person_skills", L.personSkills],
      ["person_capacity_factors", L.capacityFactors],
      ["person_leave", L.personLeave],
      ["client_services", L.clientServices],
      ["client_assignments", L.clientAssignments],
      // The eight small company-model tables (the market presets are not counted).
      ["seasonality", o.seasonality],
      ["services", o.services],
      ["client_groups", o.clientGroups],
      ["service_servicing", o.serviceServicing],
      ["market_conditions", o.marketConditions, "preset is null"],
      ["market_schedule", o.marketSchedule],
      ["churn_drivers", o.churnDrivers],
      ["lead_sources", o.leadSources],
    ];
    for (const [table, want, where] of expected) expect(await count(table, ws, where), table).toBe(want);
    // The link tables by kind: the plan's links, with the `issue` and cited `step` links the database makes itself being the ones the plan already holds.
    const planned = plan.source_links as Row[];
    for (const kind of ["process", "step", "issue"]) {
      const want = planned.filter((r) => r.kind === kind).length;
      expect(want, `plan has ${kind} links`).toBeGreaterThan(0);
      expect(await count("source_links", ws, `kind = '${kind}'`), `source_links of kind ${kind}`).toBe(want);
    }
    expect(await count("source_links", ws, "kind in ('process', 'step', 'issue')")).toBe(L.sourceLinks);
    expect(result.processes.length).toBe(L.processes);
    expect(result.counts.processes).toBe(L.processes);
    expect(result.counts.steps).toBe(L.steps);
    expect(result.counts.edges).toBe(L.edges);
    expect(await count("first_principles", ws)).toBe(L.processes);
    expect(await count("processes", ws, "archived_at is not null")).toBeGreaterThan(0);
    expect(Number((await q("select count(*) from public.steps where workspace_id = $1 and person_id is not null", [ws]))[0]!.count)).toBeGreaterThan(0);
    expect(Number((await q("select count(*) from public.steps where workspace_id = $1 and child_process_id is not null and process_id in (select id from public.processes where not is_company)", [ws]))[0]!.count)).toBe(1);
    // `link_cited_sources` ran: steps that cite a source in their evidence are linked to it.
    expect(await count("source_links", ws, "kind = 'step'")).toBeGreaterThan(0);
  }, 120_000);
});

describe("a workspace at the limits exports without the warning and checks clean", () => {
  it("restores, exports as an editor, and is a backup a restore takes", async () => {
    const plan = syntheticPlan(L, { forExport: true });
    const ws = await newWorkspace();
    await restoreAs(admin, ws, plan);
    const bundle = await exportOf(ws);
    expect(restoreSizeWarning(bundle)).toBeNull();
    const check = checkWorkspaceBundle(bundle);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
    const m = check.summary.measures;
    // Equal where the synthetic plan can land exactly. Every list below comes back as it went in; the library scenarios the new workspace
    // has already are in its export (so the plan leaves four out: `forExport`), and the `issue` source links the database made from the
    // issue sources are the ones the plan already holds.
    for (const key of ["processes", "steps", "edges", "issues", "people", "clients", "scenarios", "blocks", "suggestions", "proposals", "personRoles", "personSkills", "capacityFactors", "clientAssignments", "sourceLinks", "clientServices", "personLeave", "companyOther", "sources"] as const) {
      expect(m[key], key).toBe(L[key]);
    }
    for (const key of Object.keys(m) as (keyof typeof m)[]) expect(m[key], key).toBeLessThanOrEqual(L[key]);
    if (process.env.B21_BACKUP_OUT) writeFileSync(process.env.B21_BACKUP_OUT, JSON.stringify(bundle));
  }, 180_000);
});

describe("the new caps", () => {
  it.each([
    ["client services", (p: ImportPlan) => { p.client_services = Array.from({ length: L.clientServices + 1 }, () => ({})); }],
    ["leave entries", (p: ImportPlan) => { p.person_leave = Array.from({ length: L.personLeave + 1 }, () => ({})); }],
    ["other company rows", (p: ImportPlan) => { p.lead_sources = Array.from({ length: L.companyOther + 1 }, () => ({})); }],
    // The eight sections are counted together: each under its own count, over together.
    ["other company rows, spread over the sections", (p: ImportPlan) => {
      p.lead_sources = Array.from({ length: 1000 }, () => ({}));
      p.churn_drivers = Array.from({ length: 500 }, () => ({}));
      p.client_groups = Array.from({ length: 500 }, () => ({}));
      p.services = [{}];
    }],
  ])("refuses one more than the limit of %s (22023, the limits sentence), and writes nothing", async (label, mutate) => {
    const plan = planWorkspaceImport(await exportOf(NORTHBEAM_WORKSPACE_ID), { canManage: true }).plan;
    const copy: ImportPlan = structuredClone(plan);
    mutate(copy);
    const ws = await newWorkspace();
    const before = await snapshot(ws);
    const e = await failure(() => restoreAs(admin, ws, copy));
    expect(e.code, label).toBe("22023");
    expect(e.message).toMatch(/^import_workspace_bundle: the plan is over a limit \(.*3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times\)$/);
    expect(await snapshot(ws)).toEqual(before);
  });
});

describe("the id remap is the same as before", () => {
  async function check(plan: ImportPlan, label: string) {
    const free = "99999999-8888-4777-8666-555555555555";
    const copy: ImportPlan = structuredClone(plan);
    copy.sources[0]!.body = `see ${free}`;
    const ws = await newWorkspace();
    const result = await restoreAs(admin, ws, copy);
    const prefix = result.id_prefix;
    expect(prefix, label).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-$/);
    expect(prefix, label).not.toBe(PLACEHOLDER_PREFIX);

    // A scenario equal (name and patch) to one the new workspace already has (the library) is skipped, and what pointed at it points at the existing row.
    const alias = new Map<string, string>();
    for (const sc of copy.scenarios) {
      const fresh = realId(sc.id as string, prefix, ws);
      if ((await q("select 1 from public.scenarios where workspace_id = $1 and id = $2", [ws, fresh])).length > 0) continue;
      const [existing] = await q("select id::text as id from public.scenarios where workspace_id = $1 and name = $2 and patch = $3::jsonb order by id limit 1", [ws, sc.name, JSON.stringify(sc.patch)]);
      expect(existing, `${label}: a skipped scenario has an existing twin`).toBeDefined();
      alias.set(fresh, String(existing!.id));
    }
    expect(alias.size, label).toBe(result.skipped.scenarios ?? 0);
    const target = (placeholder: string) => {
      const fresh = realId(placeholder, prefix, ws);
      return alias.get(fresh) ?? fresh;
    };

    // Every id the plan holds is `prefix + rank` now, and rank 0 is the workspace.
    const flat = copy as unknown as Record<string, Row[]>;
    let checked = 0;
    for (const [section, rows] of Object.entries(flat)) {
      if (!Array.isArray(rows) || section === "processes" || section === "source_links") continue;
      const table = TABLE_OF[section] ?? section;
      const planned = rows.filter((r) => typeof r.id === "string");
      if (planned.length === 0) continue;
      const wanted = planned.map((r) => realId(r.id as string, prefix, ws));
      const found = Number((await q(`select count(*) from public.${table} where workspace_id = $1 and id = any($2::uuid[])`, [ws, wanted]))[0]!.count);
      expect(found, `${label}: ${section} ids`).toBe(wanted.length - (section === "scenarios" ? alias.size : 0));
      checked++;
      // Every reference column points at the row the plan named.
      const refs = (IMPORT_REFS[section] ?? []).map((r) => r.col).filter((c) => planned.some((r) => r[c] != null));
      if (section === "market_schedule") refs.push("condition_id");
      if (section === "suggestions") refs.push("target_id");
      for (const col of refs) {
        const dbRows = new Map((await q(`select id::text as id, ${col}::text as ref from public.${table} where workspace_id = $1`, [ws])).map((r) => [String(r.id), r.ref as string | null]));
        for (const r of planned) {
          const at = realId(r.id as string, prefix, ws);
          if (r[col] == null || !dbRows.has(at)) continue; // (a skipped scenario has no row of its own)
          expect(dbRows.get(at), `${label}: ${section}.${col}`).toBe(target(r[col] as string));
        }
      }
    }
    expect(checked, label).toBeGreaterThan(5);
    // Processes, steps and edges.
    const procs = (copy.processes as unknown as { id: string; steps: Row[]; edges: Row[] }[]);
    expect(Number((await q("select count(*) from public.processes where workspace_id = $1 and id = any($2::uuid[])", [ws, procs.map((p) => realId(p.id, prefix, ws))]))[0]!.count), `${label}: processes`).toBe(procs.length);
    // Step ids repeat across versions of a process (a draft keeps the ids of its published version), so a step is told apart by its process.
    const stepRows = new Map((await q("select id::text as id, process_id::text as p, child_process_id::text as c, person_id::text as person from public.steps where workspace_id = $1 and process_id in (select id from public.processes where not is_company)", [ws])).map((r) => [`${r.p}|${r.id}`, r]));
    const edgeCounts = new Map((await q("select process_id::text as p, count(*)::int as n from public.edges where workspace_id = $1 and process_id in (select id from public.processes where not is_company) group by 1", [ws])).map((r) => [String(r.p), Number(r.n)]));
    let steps = 0;
    for (const p of procs) {
      const pid = realId(p.id, prefix, ws);
      expect(edgeCounts.get(pid) ?? 0, `${label}: edges of ${p.id}`).toBe(p.edges.length);
      for (const s of p.steps) {
        const got = stepRows.get(`${pid}|${realId(s.id as string, prefix, ws)}`);
        expect(got, `${label}: step ${s.id} of ${p.id}`).toBeDefined();
        if (s.child_process_id) expect(got!.c).toBe(realId(s.child_process_id as string, prefix, ws));
        if (s.person_id) expect(got!.person).toBe(realId(s.person_id as string, prefix, ws));
        steps++;
      }
    }
    expect(stepRows.size, `${label}: no step but the plan's`).toBe(steps);
    // A uuid typed into free text is unchanged.
    expect((await q("select body from public.sources where workspace_id = $1 and id = $2", [ws, realId(copy.sources[0]!.id as string, prefix, ws)]))[0]!.body).toBe(`see ${free}`);
    return { ws, result };
  }

  it("for the synthetic plan", async () => {
    const plan = syntheticPlan(scaled(4)) as unknown as ImportPlan;
    // A suggestion that targets the workspace itself (rank 0) points at the new workspace.
    plan.suggestions.push({ id: `${PLACEHOLDER_PREFIX}ffffffffff01`, target_table: "workspaces", target_id: `${PLACEHOLDER_PREFIX}000000000000`, patch: { set: { hours_per_week: 35 } }, evidence: [], note: null, created_at: "2026-01-01T00:00:00Z" });
    const { ws } = await check(plan, "synthetic");
    expect(Number((await q("select count(*) from public.suggestions where workspace_id = $1 and target_table = 'workspaces' and target_id = $1", [ws]))[0]!.count)).toBe(1);
  }, 120_000);

  it("for a small workspace with the awkward cases (the Mini plan)", async () => {
    const m = await mini();
    const { plan } = planWorkspaceImport(await exportOf(m.ws), { canManage: true });
    const { ws } = await check(plan, "mini");
    expect(Number((await q("select count(*) from public.suggestions where workspace_id = $1 and target_table = 'workspaces' and target_id = $1", [ws]))[0]!.count)).toBe(1);
  }, 120_000);
});

describe("a restore already running", () => {
  it("is refused at once for a second restore into the same workspace (55P03, busy), writing nothing; after it ends a restore works", async () => {
    const plan = syntheticPlan(scaled(40)) as unknown as ImportPlan;
    const ws = await newWorkspace();
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    try {
      // Stands in for a running restore: it holds the advisory lock the function takes first.
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || $1::text, 0))", [ws]);
      const before = await snapshot(ws);
      const t0 = Date.now();
      const e = await failure(() => restoreAs(admin, ws, plan));
      const waited = Date.now() - t0;
      expect(e.code).toBe("55P03");
      expect(e.hint).toBe("busy");
      expect(e.message).toBe("A restore into this workspace is already running.");
      expect(waited).toBeLessThan(1000);
      expect(await snapshot(ws)).toEqual(before);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    const result = await restoreAs(admin, ws, plan);
    expect(result.processes.length).toBe(scaled(40).processes);
  }, 60_000);
});

describe("the function and the migration", () => {
  it("has its own statement timeout of 40 s, runs as the caller, and only authenticated may execute it", async () => {
    const [fn] = await q("select prosecdef, proconfig from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure");
    expect(fn!.prosecdef).toBe(false);
    expect(fn!.proconfig).toEqual(['search_path=""', "statement_timeout=40s"]);
    const grants = await q(
      "select grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'import_workspace_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1",
    );
    expect(grants).toEqual([{ grantee: "authenticated", privilege_type: "EXECUTE" }]);
    // The live body is what the latest migration file says (and the md5 in its post-apply check).
    const live = String((await q("select md5(prosrc) as md5 from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure"))[0]!.md5);
    expect(live).toBe(md5(bodyOf(sqlOf(LATEST_MIGRATION))));
    expect(sqlOf(LATEST_MIGRATION)).toContain(`${live}:`);
  });

  it("has the index on audit_log (target_id)", async () => {
    const rows = await q("select indexdef from pg_indexes where schemaname = 'public' and indexname = 'audit_log_target_id_idx'");
    expect(rows.map((r) => r.indexdef)).toEqual(["CREATE INDEX audit_log_target_id_idx ON public.audit_log USING btree (target_id)"]);
  });

  it("has a commented rollback that is the old function", () => {
    const lines = sqlOf(NEW_MIGRATION).split("\n");
    const from = lines.findIndex((l) => l.startsWith("-- create or replace function public.import_workspace_bundle"));
    const to = lines.findIndex((l, i) => i > from && l === "-- $$;");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const rollback = lines.slice(from, to + 1).map((l) => l.replace(/^-- ?/, "")).join("\n");
    const old = sqlOf(OLD_MIGRATION);
    const oldFunction = old.slice(old.indexOf("create function public.import_workspace_bundle"), old.indexOf("$$;\n", old.indexOf("create function public.import_workspace_bundle")) + 3);
    expect(rollback).toBe(oldFunction.replace("create function", "create or replace function"));
    expect(bodyOf(rollback)).toBe(bodyOf(old));
    expect(md5(bodyOf(rollback))).toBe(OLD_MD5);
    // And it drops the setting: the rollback's header has no statement_timeout.
    expect(rollback).not.toContain("statement_timeout");
  });

  it("differs from the old body only where the brief says", () => {
    const strip = (sql: string) =>
      bodyOf(sql)
        // The limit check and its message.
        .replace(/  if jsonb_array_length\(p_plan -> 'processes'\) > [\s\S]*?using errcode = '22023';\n  end if;\n/, "")
        // `max_plan_chars` and the "too big" message that names it.
        .replace(/^  max_plan_chars constant integer := \d+;\n/m, "")
        .replace(/^.*the plan is too big \(at most \d+ MB\).*\n/m, "")
        // The two id-remap lines.
        .replace(/^.*regexp_replace\(p_plan::text.*\n/m, "")
        .replace(/^.*txt := replace\(p_plan::text, placeholder, prefix\);\n/m, "")
        .replace(/^.*txt := replace\(txt, placeholder \|\| '000000000000', p_workspace::text\);\n/m, "")
        .replace(/^.*txt := replace\(txt, prefix \|\| '000000000000', p_workspace::text\);\n/m, "")
        // The first lock: blocking before, a try-lock that refuses at once now.
        .replace(/^  perform pg_advisory_xact_lock\(hashtextextended\('import_workspace_bundle:'.*\n/m, "")
        .replace(/^  if not pg_try_advisory_xact_lock\(hashtextextended\('import_workspace_bundle:'[\s\S]*?\n  end if;\n/m, "")
        // Comments.
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n");
    const oldStripped = strip(sqlOf(OLD_MIGRATION));
    const newStripped = strip(sqlOf(NEW_MIGRATION));
    expect(oldStripped.length).toBeGreaterThan(20_000);
    expect(newStripped).toBe(oldStripped);
  });

  it("has an apply file that is the migration plus its schema_migrations row, in one transaction", () => {
    const dir = new URL("../", import.meta.url);
    const mig = readFileSync(new URL(`supabase/migrations/${NEW_MIGRATION}`, dir), "utf8").trimEnd();
    const apply = readFileSync(new URL(`scripts/apply/${NEW_MIGRATION}`, dir), "utf8");
    expect(apply).toContain("\nbegin;\nset local lock_timeout");
    expect(apply.split(mig).length - 1).toBe(2);
    expect(apply).toContain("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261215000000', 'bigger_restores', array[$mig$" + mig);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
  });

  it("changes nothing but the function and the index (no other function, trigger or policy)", () => {
    const sql = sqlOf(NEW_MIGRATION);
    const outside = sql.replace(bodyOf(sql), "").split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect([...outside.matchAll(/^(create index|create or replace function|create|drop|alter|insert|update|delete|revoke|grant)\b/gim)].map((m) => m[1]!.toLowerCase())).toEqual(["create index", "create or replace function", "revoke", "grant"]);
  });
});
