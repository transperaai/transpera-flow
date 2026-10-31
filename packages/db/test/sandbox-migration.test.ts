import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, SANDBOX_LIBRARY, northbeamPersonIds, northbeamRoleIds, parseChanges } from "../src";
import { applyMigrations } from "../src/migrations";
import { createTestDb, createUser, type TestDb } from "./harness";

// Migration 20270109000000 on a database full of rows, the way the cutover runs it (the production copy is imported at row 76, then
// the remaining migrations run on it): scenarios and forecast plans become sandbox scenarios with their ids kept, every patch path
// and every marker kind maps to a lever, clashing names are renamed, the issue and run links follow, the old tables go, and the
// rewritten restore still restores. The rows at the base are the seeded Northbeam plus the awkward ones below.

// The last migration before this one: the old `scenarios` check accepts finances.overhead_monthly from 20270108000000 on.
const BASE = "20270108000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const role = northbeamRoleIds.ppc;
const person = northbeamPersonIds["Dan Okafor"]!;
let db: TestDb;
let viewer: { id: string; claims: Record<string, unknown> };
let admin: { id: string; claims: Record<string, unknown> };
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

const ID = {
  everyPath: randomUUID(),
  selectors: randomUUID(),
  empty: randomUUID(),
  copy: randomUUID(),
  downturnA: randomUUID(),
  downturnB: randomUUID(),
  caseA: randomUUID(),
  caseB: randomUUID(),
  planJan: randomUUID(),
  planClash: randomUUID(),
  planLong: randomUUID(),
  hireNamed: randomUUID(),
  hirePlain: randomUUID(),
  leave: randomUUID(),
  solutionMarker: randomUUID(),
  planLeave: randomUUID(),
  solution: randomUUID(),
  issue: randomUUID(),
  run: randomUUID(),
};
// Real-shaped awkward rows (what the app could have saved): float noise, the value bounds, a hire whose name is only spaces or 120
// characters with spaces round it, the FTE and week limits, the first and last years the old check took, a solution deleted after the
// plan named it, 40 markers with four solutions, a name whose " (2)" is taken, the same name in another workspace, and a workspace
// made before the migration whose old library rows must still count as "only the library" for a restore.
const AWK = {
  floats: randomUUID(),
  planB: randomUUID(),
  planB2: randomUUID(),
  planBPlan: randomUUID(),
  edgePlan: randomUUID(),
  fullPlan: randomUUID(),
  otherWs: randomUUID(),
  goneSolution: randomUUID(),
  liveSolutions: [randomUUID(), randomUUID(), randomUUID()],
};
// 116 characters, saved with two spaces each side: 120, the most the old check took.
const name120 = `${"N".repeat(114)}xy`;
const longA = "A".repeat(120);
const longB = "a".repeat(120);
const PATHS = [
  ["demand.leads_per_week", "multiply", 1.25],
  ["demand.active_clients", "set", 30],
  ["demand.churn_monthly", "set", 0.03],
  ["finances.retainer", "add", 100],
  ["finances.overhead_monthly", "multiply", 1.1],
  ["health.initial", "set", 70],
  ["health.recover", "multiply", 1.25],
  ["health.late_penalty", "add", 1],
  ["health.missed_penalty", "multiply", 0.75],
  ["services.s1.price", "set", 4600],
  ["services.s1.mix_share", "multiply", 2],
  ["services.s1.churn_health_sensitivity", "set", 20],
  ["roles.r1.headcount", "add", 1],
  ["roles.r1.cost_rate", "multiply", 1.1],
  ["roles.r1.ongoing_hours", "set", 2],
  ["people.p1.fte", "set", 0.8],
  ["steps.st1.work_hours", "multiply", 0.5],
  ["steps.st1.wait_hours", "set", 4],
  ["steps.st1.rework_rate", "set", 0.05],
] as const;
const LEVERS = ["A1", "B1", "B3", "B2", "C2", "X1", "X1", "X1", "X1", "B2", "A6", "X3", "D5", "C1", "X2", "D4", "E1", "E2", "E3"];
const TARGETS = [null, null, null, null, null, "initial", "recover", "late_penalty", "missed_penalty", "s1", "s1", "s1", "r1", "r1", "r1", "p1", "st1", "st1", "st1"];
let before: { scenarios: number; plans: number };
let edgeMarkersSaved: Record<string, unknown>[] = [];
let fullMarkersSaved: Record<string, unknown>[] = [];
let oldLibraryWs = "";
let oldLibraryRows = 0;

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  viewer = await createUser(db, "viewer@sandbox-migration.example");
  admin = await createUser(db, "admin@sandbox-migration.example", { agency_admin: true });
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, viewer.id]);
  const scenario = (id: string, name: string, patch: unknown, at: string, parent: string | null = null) =>
    q("insert into scenarios (id, workspace_id, name, description, patch, parent_scenario_id, created_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)", [id, ws, name, `about ${name}`.slice(0, 40), JSON.stringify(patch), parent, at]);
  await scenario(ID.everyPath, "Every path", PATHS.map(([path, op, value]) => ({ path, op, value })), "2030-01-01T00:00:01Z");
  await scenario(ID.selectors, "Selectors", [{ path: "roles.@busiest.headcount", op: "add", value: 1 }, { path: "steps.@heaviest.work_hours", op: "multiply", value: 0.4 }], "2030-01-01T00:00:02Z");
  await scenario(ID.empty, "Empty", [], "2030-01-01T00:00:03Z");
  await scenario(ID.copy, "Copy of Empty", [], "2030-01-01T00:00:04Z", ID.empty);
  await scenario(ID.downturnA, "Downturn", [{ path: "demand.leads_per_week", op: "multiply", value: 0.5 }], "2030-01-01T00:00:05Z");
  await scenario(ID.downturnB, "downturn  ", [{ path: "demand.leads_per_week", op: "multiply", value: 0.6 }], "2030-01-01T00:00:06Z");
  await scenario(ID.caseA, longA, [], "2030-01-01T00:00:07Z");
  await scenario(ID.caseB, longB, [], "2030-01-01T00:00:08Z");
  await q("insert into solutions (id, workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, $4, 'Ours', $5::jsonb)", [ID.solution, ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, JSON.stringify({ steps: [], edges: [], entry_step_id: null })]);
  const plan = (id: string, name: string, markers: unknown[], at: string) =>
    q("insert into forecast_plans (id, workspace_id, name, markers, created_at) values ($1, $2, $3, $4::jsonb, $5)", [id, ws, name, JSON.stringify(markers), at]);
  await plan(
    ID.planJan,
    "Hire in January",
    [
      { id: ID.hireNamed, kind: "hire", date: "2027-01-01", role_id: role, fte: 1.5, name: "  Jade  " },
      { id: ID.hirePlain, kind: "hire", date: "2027-02-01", role_id: role, fte: 0.5 },
      { id: ID.leave, kind: "leave", date: "2027-03-01", person_id: person, weeks: 3 },
      { id: ID.solutionMarker, kind: "solution", date: "2027-04-01", solution_id: ID.solution },
    ],
    "2030-02-01T00:00:00Z",
  );
  await plan(ID.planClash, "  DOWNTURN ", [], "2030-02-02T00:00:00Z");
  await plan(ID.planLong, longA.toLowerCase(), [], "2030-02-03T00:00:00Z");
  await plan(ID.planLeave, "Leave only", [{ id: randomUUID(), kind: "leave", date: "2027-05-10", person_id: person, weeks: 1 }], "2030-02-04T00:00:00Z");
  await q("insert into issues (id, workspace_id, type, title, scenario_id) values ($1, $2, 'idea', 'Try every path', $3)", [ID.issue, ws, ID.everyPath]);
  await q("insert into runs (id, workspace_id, name, reps, seed, params_snapshot, scenario_id) values ($1, $2, 'Run', 30, 1, '{}', $3)", [ID.run, ws, ID.everyPath]);
  // The awkward rows.
  await scenario(AWK.floats, "Floats", [
    { path: "demand.leads_per_week", op: "multiply", value: 0.30000000000000004 },
    { path: "demand.active_clients", op: "set", value: 1000000000 },
    { path: "finances.retainer", op: "add", value: -1000000000 },
    { path: "steps.@heaviest.rework_rate", op: "set", value: 1e-7 },
    { path: "roles.@busiest.ongoing_hours", op: "multiply", value: 0 },
    { path: "roles.@busiest.cost_rate", op: "add", value: 12.5 },
    { path: "steps.@heaviest.wait_hours", op: "set", value: 0 },
  ], "2030-01-01T00:00:09Z");
  await scenario(AWK.planB, "Plan B", [], "2030-01-01T00:00:10Z");
  await scenario(AWK.planB2, "Plan B (2)", [], "2030-01-01T00:00:11Z");
  for (const [i, sid] of [AWK.goneSolution, ...AWK.liveSolutions].entries()) {
    await q("insert into solutions (id, workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, $4, $5, $6::jsonb)", [sid, ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, `Sol ${i}`, JSON.stringify({ steps: [], edges: [], entry_step_id: null })]);
  }
  const m = (kind: string, extra: Record<string, unknown>) => ({ id: randomUUID(), kind, ...extra });
  const edgeMarkers = [
    m("hire", { date: "2000-01-01", role_id: role, fte: 0.1, name: "   " }),
    m("hire", { date: "2100-12-01", role_id: role, fte: 2, name: `  ${name120}  ` }),
    m("leave", { date: "2000-01-03", person_id: person, weeks: 52 }),
    m("leave", { date: "2100-12-27", person_id: person, weeks: 1 }),
    m("solution", { date: "2027-06-01", solution_id: AWK.goneSolution }),
  ];
  await plan(AWK.edgePlan, "Edges", edgeMarkers, "2030-02-05T00:00:00Z");
  // The solution is deleted after the plan named it (markers are not foreign keys).
  await q("delete from solutions where id = $1", [AWK.goneSolution]);
  const fullMarkers = [
    ...AWK.liveSolutions.map((sid, i) => m("solution", { date: `2027-0${i + 1}-01`, solution_id: sid })),
    m("solution", { date: "2027-09-01", solution_id: AWK.liveSolutions[0] }),
    ...Array.from({ length: 36 }, (_, i) => (i % 2 ? m("hire", { date: `2027-${String((i % 12) + 1).padStart(2, "0")}-01`, role_id: role, fte: 0.5 }) : m("leave", { date: "2027-03-01", person_id: person, weeks: 1 + (i % 52) }))),
  ];
  await plan(AWK.fullPlan, "Forty markers", fullMarkers, "2030-02-06T00:00:00Z");
  await plan(AWK.planBPlan, "plan b", [], "2030-02-07T00:00:00Z");
  edgeMarkersSaved = edgeMarkers;
  fullMarkersSaved = fullMarkers;
  const oldWs = (await q("insert into workspaces (name, slug) values ('Made before', 'made-before') returning id"))[0]!.id as string;
  oldLibraryWs = oldWs;
  await q("insert into forecast_plans (id, workspace_id, name, markers) values ($1, $2, 'Plan B', '[]')", [AWK.otherWs, oldWs]);
  oldLibraryRows = Number((await q("select count(*) from scenarios where workspace_id = $1", [oldWs]))[0]!.count);
  before = {
    scenarios: Number((await q("select count(*) from scenarios"))[0]!.count),
    plans: Number((await q("select count(*) from forecast_plans"))[0]!.count),
  };
  await applyMigrations(db.client);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const row = async (id: string) => (await q("select * from sandbox_scenarios where id = $1", [id]))[0]!;
const noIds = (changes: { id: string }[]) => changes.map(({ id: _id, ...c }) => c);

describe("the data mapping", () => {
  it("starts with scenarios and plans, including every awkward case", () => {
    expect(before.scenarios).toBeGreaterThan(8);
    expect(before.plans).toBe(8);
  });

  it("keeps every row: scenarios plus plans, with their ids", async () => {
    expect(Number((await q("select count(*) from sandbox_scenarios"))[0]!.count)).toBe(before.scenarios + before.plans);
    for (const id of Object.values(ID).filter((_, i) => i < 12)) void id;
    for (const id of [ID.everyPath, ID.selectors, ID.empty, ID.copy, ID.downturnA, ID.downturnB, ID.caseA, ID.caseB, ID.planJan, ID.planClash, ID.planLong, ID.planLeave]) {
      expect((await q("select 1 from sandbox_scenarios where id = $1", [id])).length, id).toBe(1);
    }
  });

  it("maps every patch path to its lever, in order, keeping op and value", async () => {
    const r = await row(ID.everyPath);
    expect(noIds(r.changes)).toEqual(PATHS.map(([, op, value], i) => ({ lever: LEVERS[i], target: TARGETS[i], op, value })));
    expect(new Set(r.changes.map((c: { id: string }) => c.id)).size).toBe(PATHS.length);
    expect(r.description).toBe("about Every path");
    expect(r.horizon_months).toBe(12);
    expect(r.start_date).toBeNull();
    expect(parseChanges(r.changes).ok).toBe(true);
  });

  it("maps the selectors, and an empty patch to no changes", async () => {
    expect(noIds((await row(ID.selectors)).changes)).toEqual([
      { lever: "D5", target: "@busiest", op: "add", value: 1 },
      { lever: "E1", target: "@heaviest", op: "multiply", value: 0.4 },
    ]);
    expect((await row(ID.empty)).changes).toEqual([]);
  });

  it("makes each plan marker one change, lossless: the marker's id, its date as from, the hire's name", async () => {
    const r = await row(ID.planJan);
    expect(r.changes).toEqual([
      { id: ID.hireNamed, lever: "D1", target: role, op: "set", value: 1.5, from: "2027-01", params: { name: "Jade" } },
      { id: ID.hirePlain, lever: "D1", target: role, op: "set", value: 0.5, from: "2027-02" },
      { id: ID.leave, lever: "D3", target: person, op: "set", value: 3, from: "2027-03-01" },
      { id: ID.solutionMarker, lever: "E6", target: ID.solution, op: "set", value: 1, from: "2027-04" },
    ]);
    expect(parseChanges(r.changes).ok).toBe(true);
    expect(r.description).toBeNull();
    expect((await row(ID.planLeave)).changes).toMatchObject([{ lever: "D3", from: "2027-05-10", value: 1 }]);
  });

  it("does not turn a copy's old parent into 'build on' (it holds the patches already)", async () => {
    expect((await row(ID.copy)).parent_id).toBeNull();
    expect(Number((await q("select count(*) from sandbox_scenarios where parent_id is not null"))[0]!.count)).toBe(0);
  });

  it("renames clashing names (ignoring case and spaces): scenarios first, then plans, oldest first", async () => {
    // Northbeam's own seeded 'Downturn' is the oldest; then the two scenarios; then the plan.
    expect((await row(ID.downturnA)).name).toBe("Downturn (2)");
    expect((await row(ID.downturnB)).name).toBe("downturn (3)");
    expect((await row(ID.planClash)).name).toBe("DOWNTURN (4)");
    expect((await row(ID.caseA)).name).toBe(longA);
    expect((await row(ID.caseB)).name).toBe(`${longB.slice(0, 116)} (2)`);
    expect((await row(ID.planLong)).name).toBe(`${longA.toLowerCase().slice(0, 116)} (3)`);
    const names = await q("select workspace_id, name from sandbox_scenarios");
    expect(names.every((n) => (n.name as string).length <= 120)).toBe(true);
    const keys = names.map((n) => `${n.workspace_id}|${(n.name as string).trim().toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the issue and run links, which now point at the new table", async () => {
    expect((await q("select scenario_id from issues where id = $1", [ID.issue]))[0]!.scenario_id).toBe(ID.everyPath);
    expect((await q("select scenario_id from runs where id = $1", [ID.run]))[0]!.scenario_id).toBe(ID.everyPath);
    const fks = await q("select conname, confrelid::regclass::text as t from pg_constraint where conname in ('issues_scenario_id_workspace_id_fkey', 'runs_scenario_id_workspace_id_fkey') order by 1");
    expect(fks).toEqual([
      { conname: "issues_scenario_id_workspace_id_fkey", t: "sandbox_scenarios" },
      { conname: "runs_scenario_id_workspace_id_fkey", t: "sandbox_scenarios" },
    ]);
    await q("delete from sandbox_scenarios where id = $1", [ID.everyPath]);
    expect((await q("select scenario_id from issues where id = $1", [ID.issue]))[0]!.scenario_id).toBeNull();
  });

  it("keeps the seeded Northbeam scenarios the issues link to", async () => {
    const linked = await q("select i.scenario_id, s.name from issues i join sandbox_scenarios s on s.id = i.scenario_id where i.workspace_id = $1 order by s.name", [ws]);
    expect(linked.map((l) => l.name)).toEqual(["Automate proposals", "Hire a strategist"]);
  });
});

describe("real-shaped awkward rows", () => {
  it("keeps float noise, the value bounds and every selector exactly", async () => {
    expect(noIds((await row(AWK.floats)).changes)).toEqual([
      { lever: "A1", target: null, op: "multiply", value: 0.30000000000000004 },
      { lever: "B1", target: null, op: "set", value: 1000000000 },
      { lever: "B2", target: null, op: "add", value: -1000000000 },
      { lever: "E3", target: "@heaviest", op: "set", value: 1e-7 },
      { lever: "X2", target: "@busiest", op: "multiply", value: 0 },
      { lever: "C1", target: "@busiest", op: "add", value: 12.5 },
      { lever: "E2", target: "@heaviest", op: "set", value: 0 },
    ]);
    expect(parseChanges((await row(AWK.floats)).changes).ok).toBe(true);
  });

  it("keeps the edge markers: a name of spaces dropped, a padded 120-character name trimmed, 2000 and 2100, 52 weeks, a deleted solution", async () => {
    const [blank, long, leave52, leave2100, gone] = edgeMarkersSaved as { id: string }[];
    const r = await row(AWK.edgePlan);
    expect(r.changes).toEqual([
      { id: blank!.id, lever: "D1", target: role, op: "set", value: 0.1, from: "2000-01" },
      { id: long!.id, lever: "D1", target: role, op: "set", value: 2, from: "2100-12", params: { name: name120 } },
      { id: leave52!.id, lever: "D3", target: person, op: "set", value: 52, from: "2000-01-03" },
      { id: leave2100!.id, lever: "D3", target: person, op: "set", value: 1, from: "2100-12-27" },
      { id: gone!.id, lever: "E6", target: AWK.goneSolution, op: "set", value: 1, from: "2027-06" },
    ]);
    expect(parseChanges(r.changes).ok).toBe(true);
  });

  it("converts a plan of 40 markers with four solutions, each marker one change in order", async () => {
    const r = await row(AWK.fullPlan);
    expect(r.changes.map((c: { id: string }) => c.id)).toEqual(fullMarkersSaved.map((x) => x.id));
    expect(r.changes.filter((c: { lever: string }) => c.lever === "E6")).toHaveLength(4);
    expect(parseChanges(r.changes).ok).toBe(true);
  });

  it("skips a suffix that is taken, and leaves the same name in another workspace alone", async () => {
    expect((await row(AWK.planB)).name).toBe("Plan B");
    expect((await row(AWK.planB2)).name).toBe("Plan B (2)");
    expect((await row(AWK.planBPlan)).name).toBe("plan b (3)");
    expect((await row(AWK.otherWs)).name).toBe("Plan B");
  });

  it("a workspace made before the migration, with only its old library, still takes a restore (its library rows have random change ids)", async () => {
    expect(oldLibraryRows).toBe(4);
    await q("delete from sandbox_scenarios where id = $1", [AWK.otherWs]);
    const lib = await q("select name, changes from sandbox_scenarios where workspace_id = $1 order by name", [oldLibraryWs]);
    expect(lib.map((l) => l.name)).toEqual([...SANDBOX_LIBRARY].map((l) => l.name).sort());
    expect(lib.map((l) => noIds(l.changes))).toEqual([...SANDBOX_LIBRARY].sort((a, b) => (a.name < b.name ? -1 : 1)).map((l) => noIds(l.changes as never)));
    const result = await restoreInto(oldLibraryWs, []);
    expect(result.counts.sandbox_scenarios).toBe(0);
  });
});

describe("what is left", () => {
  it("drops the old tables and the functions only they used, and keeps the solution patch check", async () => {
    const r = (await q("select to_regclass('public.scenarios') as s, to_regclass('public.forecast_plans') as f, to_regprocedure('private.scenario_library()') as l, to_regprocedure('private.seed_scenario_library()') as sl, to_regprocedure('private.forecast_plans_before_write()') as fp, to_regprocedure('private.is_scenario_patch(jsonb)') as isp"))[0]!;
    expect(r).toEqual({ s: null, f: null, l: null, sl: null, fp: null, isp: "private.is_scenario_patch(jsonb)" });
    const left = await q("select proname from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace) and prosrc ~ 'public\\.scenarios|forecast_plans|scenario_library'");
    expect(left).toEqual([]);
  });

  it("gives a Viewer the migrated scenarios to read, and no way to write", async () => {
    const read = await db.as(viewer.claims, (c) => c.query("select name, changes from sandbox_scenarios where workspace_id = $1", [ws]));
    expect(read.rows.length).toBeGreaterThan(8);
    expect(read.rows.map((r) => r.name)).toContain("Hire in January");
    await expect(db.as(viewer.claims, (c) => c.query("insert into sandbox_scenarios (workspace_id, name) values ($1, 'Nope')", [ws]))).rejects.toThrow(/row-level security/);
  });

  it("gives a new workspace the four library scenarios", async () => {
    const w = (await q("insert into workspaces (name, slug) values ('After', 'after') returning id"))[0]!.id;
    const rows = await q("select name, changes from sandbox_scenarios where workspace_id = $1 order by name", [w]);
    expect(rows.map((r) => r.name)).toEqual(["Automate the heaviest step", "Downturn", "Hire into the busiest role", "More leads"]);
    expect(rows.map((r) => r.changes)).toEqual([...SANDBOX_LIBRARY].sort((a, b) => (a.name < b.name ? -1 : 1)).map((l) => l.changes));
  });
});

const LISTS = ["roles", "people", "person_roles", "person_leave", "lead_sources", "seasonality", "churn_drivers", "market_conditions", "market_schedule", "clients", "sources", "processes", "sandbox_scenarios", "blocks", "issues", "services", "service_servicing", "client_groups", "client_services", "client_assignments", "person_skills", "person_capacity_factors", "source_links"];
async function restoreInto(w: string, scenarios: unknown[]) {
  const plan = { format: "transpera-workspace-import/1", settings: null, demand_settings: null, analysis_rules: null, ...Object.fromEntries(LISTS.map((k) => [k, []])), sandbox_scenarios: scenarios };
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin.claims)]);
    const r = (await db.client.query("select public.import_workspace_bundle($1, $2::jsonb) as r", [w, JSON.stringify(plan)])).rows[0].r;
    await db.client.query("commit");
    return r;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}

describe("the rewritten restore", () => {
  const P = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const restore = restoreInto;

  it("restores scenarios with their parents and skips the library, whatever ids its changes have", async () => {
    const w = (await q("insert into workspaces (name, slug) values ('Restored', 'restored') returning id"))[0]!.id;
    const downturnFromOldMigration = [
      { id: randomUUID(), lever: "A1", target: null, op: "multiply", value: 0.7 },
      { id: randomUUID(), lever: "B3", target: null, op: "multiply", value: 1.5 },
    ];
    const result = await restore(w, [
      { id: P(3), parent_id: P(2), name: "Child", description: null, changes: [{ id: randomUUID(), lever: "A1", target: null, op: "multiply", value: 1.1, from: "2027-05" }] },
      { id: P(2), parent_id: null, name: "Parent", description: "base", changes: [], horizon_months: 24 },
      { id: P(1), parent_id: null, name: "Downturn", description: "x", changes: downturnFromOldMigration },
    ]);
    expect(result.skipped.scenarios).toBe(1);
    const rows = await q("select name, parent_id, horizon_months from sandbox_scenarios where workspace_id = $1 order by name", [w]);
    expect(rows.map((r) => r.name)).toEqual(["Automate the heaviest step", "Child", "Downturn", "Hire into the busiest role", "More leads", "Parent"]);
    const parent = (await q("select id from sandbox_scenarios where workspace_id = $1 and name = 'Parent'", [w]))[0]!.id;
    expect(rows.find((r) => r.name === "Child")!.parent_id).toBe(parent);
    expect(rows.find((r) => r.name === "Parent")!.horizon_months).toBe(24);
    expect(result.counts.sandbox_scenarios).toBe(2);
  });

  it("refuses a workspace that has a scenario of its own, and a scenario with no id", async () => {
    const w = (await q("insert into workspaces (name, slug) values ('Has own', 'has-own') returning id"))[0]!.id;
    await q("insert into sandbox_scenarios (workspace_id, name) values ($1, 'Mine')", [w]);
    await expect(restore(w, [])).rejects.toMatchObject({ code: "23514" });
    const w2 = (await q("insert into workspaces (name, slug) values ('No id', 'no-id') returning id"))[0]!.id;
    await expect(restore(w2, [{ name: "x", changes: [] }])).rejects.toThrow(/every scenario needs an id/);
  });
});
