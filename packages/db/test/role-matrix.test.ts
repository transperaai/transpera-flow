import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamIssues,
  northbeamLeadSourceIds,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamServicingProcessIds,
  northbeamStepIds,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The role matrix (issue #30, B1 parts 1 and 2a): what each kind of caller can read, write and call in a workspace,
// as RLS and the SECURITY INVOKER functions enforce it. The matrix is data (`TABLES`, `ROLES`, `RPCS`). Per-person privacy
// (2a) is the `reads` field of a table and the `sees` field of a caller. Rolled-back transactions throughout (`db.as`), so
// every probe starts from the same rows.

const ws = NORTHBEAM_WORKSPACE_ID;
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });
const servicingProcess = Object.values(northbeamServicingProcessIds)[0]!;
const [openIssue] = northbeamIssues().map((i) => i.id) as [string, string, string];

type Claims = Record<string, unknown>;
interface Caller {
  id: string;
  claims: Claims;
}

let db: TestDb;
const callers: Record<string, Caller> = {};
// The people the callers are linked to (B1 2a): the member, the viewer and the editor each look at a different person; `spare`
// is nobody's, and holds the rows the write cases use.
const person = {
  member: northbeamPersonIds["Leah Brooks"]!,
  viewer: northbeamPersonIds["Dan Okafor"]!,
  editor: northbeamPersonIds["Maya Collins"]!,
  spare: northbeamPersonIds["Rosa Diaz"]!,
};
/** Rows each table holds in the workspace, and each linked person's rows in it, counted as the superuser once seeded. */
const totals: Record<string, number> = {};
const owns: Record<string, Record<string, number>> = {};
/** `settings.health_recover` as stored when the matrix starts (Northbeam: absent, so null), the base a save is made against. */
let healthRecover = "null";
const headlineNumbers = JSON.stringify({ flow_efficiency: 0.4, processes_attention: 1, processes_total: 4, client_groups_at_risk: 0, client_groups_total: 2 });
const ids = { suggestion: "", proposal: "", client: "", svcSeed: "", svcProbe: "", condition: "", seedDataset: "", probeDataset: "" };

/** A SQL statement and its parameters. */
type Q = [sql: string, params: unknown[]];

interface TableCase {
  table: string;
  /** Inserts one row; `tag` is 'seed' (done once as the superuser) or 'probe' (done by the caller under test). */
  insert: (tag: "seed" | "probe") => Q;
  /** Changes the seed row without changing what finds it. Null: nobody holds UPDATE on the table. */
  update: Q | null;
  /** Deletes the seed row. Null: nobody holds DELETE on the table. */
  delete: Q | null;
  /**
   * Who reads which rows. "everyone": every reader (the default). "per-person": callers who see everyone read every row; a
   * member or viewer reads only their own person's rows. "editors": only callers who see everyone.
   */
  reads?: "everyone" | "per-person" | "editors";
  /** The column that names the person a "per-person" row is about. */
  personColumn?: string;
}

const named = (table: string, column = "name"): TableCase => ({
  table,
  insert: (tag) => [`insert into ${table} (workspace_id, ${column}) values ($1, $2)`, [ws, `x ${tag}`]],
  update: [`update ${table} set ${column} = ${column} where workspace_id = $1 and ${column} = 'x seed'`, [ws]],
  delete: [`delete from ${table} where workspace_id = $1 and ${column} = 'x seed'`, [ws]],
});

/** One row per workspace, keyed by it: the insert is an upsert, so it works whatever the seed holds. */
const singleton = (table: string, deletable = true): TableCase => ({
  table,
  insert: () => [`insert into ${table} (workspace_id) values ($1) on conflict (workspace_id) do update set workspace_id = excluded.workspace_id`, [ws]],
  update: [`update ${table} set workspace_id = workspace_id where workspace_id = $1`, [ws]],
  delete: deletable ? [`delete from ${table} where workspace_id = $1`, [ws]] : null,
});

/** Every table the audit lists as read by every member and written by editors and above, apart from the per-person ones (B1 part 2). */
const TABLES: TableCase[] = [
  { ...named("people"), reads: "per-person", personColumn: "id" },
  // The spare person (Rosa) holds no skills or leave and only her own role, so these rows are free to insert, change and delete.
  {
    table: "person_roles",
    insert: (tag) => [
      "insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)",
      [person.spare, tag === "seed" ? northbeamRoleIds.ppc : northbeamRoleIds.seo, ws],
    ],
    update: [`update person_roles set role_id = role_id where person_id = $1 and role_id = '${northbeamRoleIds.ppc}'`, [person.spare]],
    delete: [`delete from person_roles where person_id = $1 and role_id = '${northbeamRoleIds.ppc}'`, [person.spare]],
    reads: "per-person",
    personColumn: "person_id",
  },
  {
    table: "person_skills",
    insert: (tag) => [
      "insert into person_skills (person_id, step_id, workspace_id) values ($1, $2, $3)",
      [person.spare, tag === "seed" ? northbeamStepIds.qualify : northbeamStepIds.discovery, ws],
    ],
    update: [`update person_skills set efficiency = efficiency where person_id = $1 and step_id = '${northbeamStepIds.qualify}'`, [person.spare]],
    delete: [`delete from person_skills where person_id = $1 and step_id = '${northbeamStepIds.qualify}'`, [person.spare]],
    reads: "per-person",
    personColumn: "person_id",
  },
  {
    table: "person_leave",
    insert: (tag) => [
      "insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, $3, $3)",
      [person.spare, ws, tag === "seed" ? "2027-01-04" : "2027-02-01"],
    ],
    update: ["update person_leave set note = note where person_id = $1 and start_date = '2027-01-04'", [person.spare]],
    delete: ["delete from person_leave where person_id = $1 and start_date = '2027-01-04'", [person.spare]],
    reads: "per-person",
    personColumn: "person_id",
  },
  {
    table: "client_assignments",
    insert: (tag) => [
      "insert into client_assignments (client_id, role_id, person_id, workspace_id) values ($1, $2, $3, $4)",
      [ids.client, tag === "seed" ? northbeamRoleIds.sales : northbeamRoleIds.fin, person.spare, ws],
    ],
    update: [
      `update client_assignments set person_id = person_id where role_id = '${northbeamRoleIds.sales}' and client_id = (select id from clients where workspace_id = $1 and name = 'x seed')`,
      [ws],
    ],
    delete: [
      `delete from client_assignments where role_id = '${northbeamRoleIds.sales}' and client_id = (select id from clients where workspace_id = $1 and name = 'x seed')`,
      [ws],
    ],
    reads: "per-person",
    personColumn: "person_id",
  },
  // Saved runs and their cached robustness results hold per-person utilisation: only callers who see everyone read them (Q4).
  {
    table: "runs",
    insert: (tag) => ["insert into runs (workspace_id, name, reps, seed, params_snapshot) values ($1, $2, 30, 1, '{}')", [ws, `x ${tag}`]],
    update: ["update runs set name = name where workspace_id = $1 and name = 'x seed'", [ws]],
    delete: ["delete from runs where workspace_id = $1 and name = 'x seed'", [ws]],
    reads: "editors",
  },
  {
    table: "robustness_results",
    insert: (tag) => [
      "insert into robustness_results (workspace_id, check_key, cache_key, results) values ($1, $2, $3, '{}')",
      [ws, `v1|${tag}`, `v1|${tag}|k`],
    ],
    update: null,
    delete: ["delete from robustness_results where workspace_id = $1 and check_key = 'v1|seed'", [ws]],
    reads: "editors",
  },
  {
    table: "issues",
    insert: (tag) => ["insert into issues (workspace_id, type, title) values ($1, 'delay', $2)", [ws, `x ${tag}`]],
    update: ["update issues set title = title where workspace_id = $1 and title = 'x seed'", [ws]],
    delete: ["delete from issues where workspace_id = $1 and title = 'x seed'", [ws]],
  },
  {
    table: "findings",
    insert: (tag) => [
      "insert into findings (workspace_id, origin, status, rating, type, title) values ($1, 'manual', 'accepted', 'good', 'manual', $2)",
      [ws, `x ${tag}`],
    ],
    update: ["update findings set title = title where workspace_id = $1 and title = 'x seed'", [ws]],
    delete: null,
  },
  {
    table: "solutions",
    insert: (tag) => [
      "insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, $4, $5::jsonb)",
      [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, `x ${tag}`, bundle],
    ],
    update: ["update solutions set name = name where workspace_id = $1 and name = 'x seed'", [ws]],
    delete: ["delete from solutions where workspace_id = $1 and name = 'x seed'", [ws]],
  },
  {
    table: "blocks",
    insert: (tag) => ["insert into blocks (workspace_id, name, steps) values ($1, $2, $3::jsonb)", [ws, `x ${tag}`, bundle]],
    update: ["update blocks set name = name where workspace_id = $1 and name = 'x seed'", [ws]],
    delete: ["delete from blocks where workspace_id = $1 and name = 'x seed'", [ws]],
  },
  named("sources", "title"),
  {
    table: "suggestions",
    insert: (tag) => [
      "insert into suggestions (workspace_id, target_table, target_id, patch, evidence, note) values ($1, 'lead_sources', $2, $3::jsonb, '[]', $4)",
      [ws, northbeamLeadSourceIds.ads, JSON.stringify({ set: { volume_week: 33 } }), `x ${tag}`],
    ],
    update: ["update suggestions set note = note where workspace_id = $1 and note = 'x seed'", [ws]],
    delete: null,
  },
  {
    table: "suggestion_proposals",
    insert: (tag) => ["insert into suggestion_proposals (workspace_id, kind, title) values ($1, 'issue', $2)", [ws, `x ${tag}`]],
    update: ["update suggestion_proposals set review_note = review_note where workspace_id = $1 and title = 'x seed'", [ws]],
    delete: null,
  },
  // Settings tables.
  singleton("ai_settings", false),
  singleton("lever_settings"),
  singleton("analysis_rules"),
  singleton("demand_settings"),
  {
    table: "churn_drivers",
    insert: (tag) => ["insert into churn_drivers (workspace_id, name) values ($1, $2)", [ws, `x ${tag}`]],
    update: ["update churn_drivers set name = name where workspace_id = $1 and name = 'x seed'", [ws]],
    delete: ["delete from churn_drivers where workspace_id = $1 and name = 'x seed'", [ws]],
  },
  {
    table: "market_conditions",
    insert: (tag) => ["insert into market_conditions (workspace_id, name) values ($1, $2)", [ws, `x ${tag}`]],
    update: ["update market_conditions set name = name where workspace_id = $1 and name = 'x seed'", [ws]],
    delete: ["delete from market_conditions where workspace_id = $1 and name = 'x seed'", [ws]],
  },
  {
    table: "market_schedule",
    insert: (tag) => [
      "insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, $2, $2, $3)",
      [ws, tag === "seed" ? 1 : 2, ids.condition],
    ],
    update: ["update market_schedule set to_month = to_month where workspace_id = $1 and from_month = 1", [ws]],
    delete: ["delete from market_schedule where workspace_id = $1 and from_month = 1", [ws]],
  },
  {
    table: "client_groups",
    insert: (tag) => ["insert into client_groups (workspace_id, service_id) values ($1, $2)", [ws, tag === "seed" ? ids.svcSeed : ids.svcProbe]],
    update: ["update client_groups set fee = fee where workspace_id = $1 and service_id = $2", [ws, "seed"]],
    delete: ["delete from client_groups where workspace_id = $1 and service_id = $2", [ws, "seed"]],
  },
  named("services"),
  {
    table: "service_servicing",
    insert: (tag) => [
      "insert into service_servicing (workspace_id, service_id, process_id) values ($1, $2, $3)",
      [ws, tag === "seed" ? ids.svcSeed : ids.svcProbe, servicingProcess],
    ],
    update: ["update service_servicing set service_id = service_id where workspace_id = $1 and service_id = $2", [ws, "seed"]],
    delete: ["delete from service_servicing where workspace_id = $1 and service_id = $2", [ws, "seed"]],
  },
  named("lead_sources"),
  {
    table: "seasonality",
    // Northbeam has all twelve months already, so the insert is an upsert.
    insert: () => ["insert into seasonality (workspace_id, month) values ($1, 1) on conflict (workspace_id, month) do update set multiplier = excluded.multiplier", [ws]],
    update: ["update seasonality set month = month where workspace_id = $1 and month = 1", [ws]],
    delete: ["delete from seasonality where workspace_id = $1 and month = 1", [ws]],
  },
  named("roles"),
  {
    ...named("clients"),
    // Clients are never deleted: mark them inactive (asserted below).
    delete: null,
  },
  {
    table: "client_services",
    insert: (tag) => [
      "insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)",
      [ids.client, tag === "seed" ? ids.svcSeed : ids.svcProbe, ws],
    ],
    update: ["update client_services set service_id = service_id where workspace_id = $1 and service_id = $2", [ws, "seed"]],
    delete: ["delete from client_services where workspace_id = $1 and service_id = $2", [ws, "seed"]],
  },
  {
    table: "datasets",
    insert: (tag) => ["insert into datasets (workspace_id, kind, file_name, row_count) values ($1, 'step_log', $2, 1)", [ws, `x ${tag}.csv`]],
    update: null,
    delete: null,
  },
  // The agency list's headline numbers (B1 3/3): every reader reads, owners and editors write, nobody deletes.
  {
    table: "workspace_headlines",
    insert: () => [
      "insert into workspace_headlines (workspace_id, engine_version, revision_ids, horizon_weeks, numbers) values ($1, '1.7.0', '{}', 52, $2::jsonb) on conflict (workspace_id) do update set horizon_weeks = excluded.horizon_weeks",
      [ws, headlineNumbers],
    ],
    update: ["update workspace_headlines set horizon_weeks = horizon_weeks where workspace_id = $1", [ws]],
    delete: null,
  },
  // Share links (B3): owners, editors and agency admins only; links are revoked, never deleted (asserted below).
  {
    table: "share_links",
    insert: (tag) => [
      "insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version) values ($1, $2, 'overview', $3::jsonb, '1.8.0')",
      [ws, (tag === "seed" ? "a" : "b").repeat(64), JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials: false } })],
    ],
    update: ["update share_links set label = 'x' where workspace_id = $1 and engine_version = '1.8.0'", [ws]],
    delete: null,
    reads: "editors",
  },
  {
    table: "calibrations",
    insert: (tag) => [
      "insert into calibrations (workspace_id, dataset_id, process_id, results) values ($1, $2, $3, $4::jsonb)",
      [ws, tag === "seed" ? ids.seedDataset : ids.probeDataset, NORTHBEAM_PROCESS_ID, JSON.stringify({ proposals: [] })],
    ],
    update: null,
    delete: null,
  },
];

// A few tables key their sample rows by a seeded id rather than a name: swap the placeholder for it.
const resolve = ([sql, params]: Q): Q => [
  sql,
  params.map((p) => (p === "seed" && /service_id = \$2/.test(sql) ? ids.svcSeed : p)),
];

/** `sees`: every person ("all"), only the caller's linked person ("own"), or no person ("none"). */
const ROLES = {
  "agency admin (JWT flag)": { writes: true, reads: true, sees: "all" },
  "agency_admin membership": { writes: true, reads: true, sees: "all" },
  owner: { writes: true, reads: true, sees: "all" },
  editor: { writes: true, reads: true, sees: "all" },
  member: { writes: false, reads: true, sees: "own" },
  viewer: { writes: false, reads: true, sees: "own" },
  "member, no person": { writes: false, reads: true, sees: "none" },
  "signed in, no membership": { writes: false, reads: false, sees: "none" },
} as const;
type RoleName = keyof typeof ROLES;

// Some triggers check the role themselves and answer in their own words before the policy gets to.
// A caller who can't see the process (the no-membership user) is stopped by the servicing link's own check first; clients are
// stopped by a trigger for everyone.
const refusal = /row-level security|permission denied|you cannot (edit|change)|Only a servicing process|never deleted/;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const flag = await createUser(db, "flag@matrix.example", { agency_admin: true });
  const member = async (email: string, role: string) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, u.id, role]);
    return u;
  };
  callers["agency admin (JWT flag)"] = flag;
  callers["agency_admin membership"] = await member("agency-member@matrix.example", "agency_admin");
  callers.owner = await member("owner@matrix.example", "owner");
  callers.editor = await member("editor@matrix.example", "editor");
  callers.member = await member("member@matrix.example", "member");
  callers.viewer = await member("viewer@matrix.example", "viewer");
  callers["member, no person"] = await member("member-unlinked@matrix.example", "member");
  callers["signed in, no membership"] = await createUser(db, "stranger@matrix.example");
  // Link the member, the viewer and the editor to three different people (B1 2a).
  for (const role of ["member", "viewer", "editor"] as const) {
    await db.client.query("update memberships set person_id = $1 where workspace_id = $2 and user_id = $3", [person[role], ws, callers[role]!.id]);
  }

  const svc = async (name: string) =>
    (await db.client.query("insert into services (workspace_id, name) values ($1, $2) returning id", [ws, name])).rows[0].id as string;
  ids.svcSeed = await svc("Matrix seed service");
  ids.svcProbe = await svc("Matrix probe service");
  ids.condition = (await db.client.query("select id from market_conditions where workspace_id = $1 limit 1", [ws])).rows[0].id;
  const dataset = async (name: string) =>
    (await db.client.query("insert into datasets (workspace_id, kind, file_name, row_count) values ($1, 'step_log', $2, 1) returning id", [ws, name])).rows[0].id as string;
  ids.seedDataset = await dataset("seed-ds.csv");
  ids.probeDataset = await dataset("probe-ds.csv");

  // (Filled once the seed rows below exist.)
  // Every table gets a seed row (as the superuser), so a read count above zero and a refused update or delete mean something.
  ids.client = (await db.client.query("insert into clients (workspace_id, name) values ($1, 'x seed') returning id", [ws])).rows[0].id;
  for (const t of TABLES) {
    if (t.table === "clients") continue;
    const [sql, params] = t.insert("seed");
    await db.client.query(sql.includes("on conflict") ? sql : `${sql} on conflict do nothing`, params);
  }
  // Each linked person holds a skill and a leave entry (the spare person's come from the table cases above).
  for (const role of ["member", "viewer", "editor"] as const) {
    await db.client.query("insert into person_skills (person_id, step_id, workspace_id) values ($1, $2, $3)", [person[role], northbeamStepIds.audit, ws]);
    await db.client.query("insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, '2027-03-01', '2027-03-05')", [person[role], ws]);
  }
  // A suggestion about the member's person, one about another person (the spare), and the non-people one the table case seeds.
  for (const [who, tag] of [[person.member, "x person own"], [person.spare, "x person other"]] as const) {
    await db.client.query(
      "insert into suggestions (workspace_id, target_table, target_id, patch, evidence, note) values ($1, 'people', $2, $3::jsonb, '[]', $4)",
      [ws, who, JSON.stringify({ set: { fte: 0.8 } }), tag],
    );
  }
  // Two analysis runs: one started by the editor, one by the member (ai_runs keeps the runner's name).
  for (const [role, name] of [["editor", "Ed Itor"], ["member", "Mem Ber"]] as const) {
    await db.client.query("insert into ai_runs (workspace_id, trigger, user_id, user_name) values ($1, 'manual', $2, $3)", [ws, callers[role]!.id, name]);
  }
  // What each table holds now, and each linked person's share of it.
  for (const t of TABLES) {
    totals[t.table] = await rowsIn(db.client, t.table);
    if (t.reads === "per-person") {
      owns[t.table] = {};
      for (const role of ["member", "viewer"] as const) {
        owns[t.table]![role] = Number(
          (await db.client.query(`select count(*) from ${t.table} where workspace_id = $1 and ${t.personColumn} = $2`, [ws, person[role]])).rows[0].count,
        );
      }
    }
  }
  healthRecover = JSON.stringify((await db.client.query("select settings -> 'health_recover' as v from workspaces where id = $1", [ws])).rows[0].v ?? null);
  ids.suggestion = (await db.client.query("select id from suggestions where workspace_id = $1 and note = 'x seed'", [ws])).rows[0].id;
  ids.proposal = (await db.client.query("select id from suggestion_proposals where workspace_id = $1 and title = 'x seed'", [ws])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const rowsIn = async (c: pg.Client, table: string) => Number((await c.query(`select count(*) from ${table} where workspace_id = $1`, [ws])).rows[0].count);

/** Run `fn` and report whether the database refused it (an error, or no row changed). */
async function refused(c: pg.Client, run: () => Promise<{ rowCount: number | null }>): Promise<"refused" | "no rows" | number> {
  await c.query("savepoint probe");
  try {
    const { rowCount } = await run();
    return rowCount === 0 ? "no rows" : (rowCount ?? 0);
  } catch (e) {
    await c.query("rollback to savepoint probe");
    if (!refusal.test((e as Error).message)) throw e;
    return "refused";
  }
}

describe("reads", () => {
  for (const [role, { reads, sees }] of Object.entries(ROLES) as [RoleName, (typeof ROLES)[RoleName]][]) {
    it(`${role}: ${reads ? "reads" : "does not read"} every table${sees === "own" ? ", and of the per-person ones only their own person's rows" : ""}`, async () => {
      await db.as(callers[role]!.claims, async (c) => {
        for (const t of TABLES) {
          const n = await rowsIn(c, t.table);
          const kind = t.reads ?? "everyone";
          if (kind === "everyone") {
            if (reads) expect(n, t.table).toBeGreaterThan(0);
            else expect(n, t.table).toBe(0);
          } else if (kind === "editors") {
            if (sees === "all") expect(n, t.table).toBeGreaterThan(0);
            else expect(n, t.table).toBe(0);
          } else if (sees === "all") {
            expect(n, t.table).toBe(totals[t.table]);
          } else if (sees === "own") {
            // At least one row each (seeded above), and exactly the linked person's.
            expect(owns[t.table]![role], `${t.table} seeded for ${role}`).toBeGreaterThan(0);
            expect(n, t.table).toBe(owns[t.table]![role]);
          } else {
            expect(n, t.table).toBe(0);
          }
        }
      });
    });
  }

  it("suggestions: a member reads the suggestion about their own person and the non-people one, not the one about another person; an editor reads all three", async () => {
    const notes = async (role: RoleName) =>
      (await db.as(callers[role]!.claims, async (c) => (await c.query("select note from suggestions where workspace_id = $1 order by note", [ws])).rows)).map((r) => r.note as string);
    expect(await notes("member")).toEqual(["x person own", "x seed"]);
    expect(await notes("viewer")).toEqual(["x seed"]);
    expect(await notes("member, no person")).toEqual(["x seed"]);
    expect(await notes("editor")).toEqual(["x person other", "x person own", "x seed"]);
    expect(await notes("owner")).toEqual(["x person other", "x person own", "x seed"]);
  });

  it("memberships: owners, editors and agency admins read every row; a member or viewer only their own, so labels can't be tied to people (B1 2/3)", async () => {
    const total = Number((await db.client.query("select count(*) from memberships where workspace_id = $1", [ws])).rows[0].count);
    expect(total).toBeGreaterThan(5);
    const own = async (role: RoleName) =>
      db.as(callers[role]!.claims, async (c) => (await c.query("select user_id, person_id from memberships where workspace_id = $1", [ws])).rows as { user_id: string; person_id: string | null }[]);
    for (const role of ["agency admin (JWT flag)", "agency_admin membership", "owner", "editor"] as const) expect((await own(role)).length, role).toBe(total);
    for (const role of ["member", "viewer", "member, no person"] as const) {
      expect(await own(role), role).toEqual([{ user_id: callers[role]!.id, person_id: role === "member" ? person.member : role === "viewer" ? person.viewer : null }]);
    }
    expect(await own("signed in, no membership")).toEqual([]);
    // A deactivated member reads nothing, as before.
    await db.client.query("begin");
    try {
      await db.client.query("update memberships set active = false where user_id = $1", [callers.member!.id]);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(callers.member!.claims)]);
      expect(Number((await db.client.query("select count(*) from memberships")).rows[0].count)).toBe(0);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("ai_runs: editors and owners read both runs, a member only their own, a viewer none", async () => {
    const names = async (role: RoleName) =>
      (await db.as(callers[role]!.claims, async (c) => (await c.query("select user_name from ai_runs where workspace_id = $1 order by user_name", [ws])).rows)).map((r) => r.user_name as string);
    for (const role of ["agency admin (JWT flag)", "agency_admin membership", "owner", "editor"] as const) expect(await names(role), role).toEqual(["Ed Itor", "Mem Ber"]);
    expect(await names("member")).toEqual(["Mem Ber"]);
    expect(await names("viewer")).toEqual([]);
    expect(await names("member, no person")).toEqual([]);
    expect(await names("signed in, no membership")).toEqual([]);
  });

  it("person_labels (B1 2b) reads like every other column of findings and ai_analyses: every member of the workspace reads it, only owners and editors write it", async () => {
    const labels = { "Team member A": person.member };
    await db.client.query("update findings set person_labels = $2 where workspace_id = $1 and title = 'x seed'", [ws, JSON.stringify(labels)]);
    // An analysis, seeded as a restore would (triggers off).
    await db.client.query("begin");
    await db.client.query("set local session_replication_role = replica");
    const run = (await db.client.query("insert into ai_runs (workspace_id, trigger, user_id, user_name) values ($1, 'manual', $2, 'Seeder') returning id", [ws, callers.editor!.id])).rows[0].id;
    await db.client.query(
      "insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, run_id, created_by, person_labels) values ($1, $2, $3, 'ok', 'manual', 'h', $4, $5, $6)",
      [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, run, callers.editor!.id, JSON.stringify(labels)],
    );
    await db.client.query("commit");
    for (const [role, { reads, writes }] of Object.entries(ROLES) as [RoleName, (typeof ROLES)[RoleName]][]) {
      await db.as(callers[role]!.claims, async (c) => {
        const found = await c.query("select person_labels from findings where workspace_id = $1 and title = 'x seed'", [ws]);
        const analyses = await c.query("select person_labels from ai_analyses where workspace_id = $1", [ws]);
        if (reads) {
          expect(found.rows.map((r) => r.person_labels), role).toEqual([labels]);
          expect(analyses.rows.map((r) => r.person_labels), role).toEqual([labels]);
        } else {
          expect(found.rows, role).toEqual([]);
          expect(analyses.rows, role).toEqual([]);
        }
        const wrote = await refused(c, () => c.query("update findings set person_labels = '{}' where workspace_id = $1 and title = 'x seed'", [ws]));
        if (writes) expect(wrote, role).toBeGreaterThan(0);
        else expect(wrote, role).toMatch(/refused|no rows/);
      });
    }
    await db.client.query("delete from ai_analyses where workspace_id = $1", [ws]);
    await db.client.query("update findings set person_labels = '{}' where workspace_id = $1", [ws]);
  });

  it("scopes the readers to their own workspace: nothing of Larkspur's shows in Northbeam's view", async () => {
    await db.as(callers.member!.claims, async (c) => {
      expect(Number((await c.query("select count(*) from workspaces")).rows[0].count)).toBe(1);
      expect(Number((await c.query("select count(*) from people where workspace_id <> $1", [ws])).rows[0].count)).toBe(0);
    });
  });
});

describe("writes", () => {
  for (const [role, { writes }] of Object.entries(ROLES) as [RoleName, (typeof ROLES)[RoleName]][]) {
    describe(role, () => {
      for (const t of TABLES) {
        it(`${t.table}: ${writes ? "insert, update and delete succeed" : "insert, update and delete are refused"}`, async () => {
          await db.as(callers[role]!.claims, async (c) => {
            const insert = await refused(c, () => c.query(...t.insert("probe")));
            const update = t.update ? await refused(c, () => c.query(...resolve(t.update!))) : null;
            const del = t.delete ? await refused(c, () => c.query(...resolve(t.delete!))) : null;
            if (writes) {
              expect(insert, "insert").toBe(1);
              if (update) expect(update, "update").toBeGreaterThan(0);
              if (del) expect(del, "delete").toBeGreaterThan(0);
            } else {
              expect(insert, "insert").toBe("refused");
              if (update) expect(update, "update").toMatch(/refused|no rows/);
              if (del) expect(del, "delete").toMatch(/refused|no rows/);
            }
          });
        });
      }
    });
  }

  it("nobody can write to a table that has no grant for it: datasets and calibrations are insert-only, findings, suggestions, clients and headlines are never deleted", async () => {
    await db.as(callers.owner!.claims, async (c) => {
      for (const [table, verb] of [["datasets", "delete from datasets"], ["datasets", "update datasets set row_count = 2"], ["calibrations", "delete from calibrations"], ["findings", "delete from findings"], ["suggestions", "delete from suggestions"], ["clients", "delete from clients"], ["share_links", "delete from share_links"], ["workspace_headlines", "delete from workspace_headlines"]] as const) {
        expect(await refused(c, () => c.query(verb)), table).toBe("refused");
      }
    });
  });
});

describe("workspace name and currency", () => {
  const rename = (c: pg.Client) => c.query("update workspaces set name = name || '!' where id = $1", [ws]);
  const recurrency = (c: pg.Client) =>
    c.query("update workspaces set settings = jsonb_set(settings, '{currency}', '\"EUR\"') where id = $1", [ws]);

  for (const role of ["agency admin (JWT flag)", "agency_admin membership", "owner"] as const) {
    it(`${role} changes both`, async () => {
      await db.as(callers[role]!.claims, async (c) => {
        expect(await refused(c, () => rename(c))).toBe(1);
        expect(await refused(c, () => recurrency(c))).toBe(1);
      });
    });
  }
  for (const role of ["editor", "member", "viewer", "signed in, no membership"] as const) {
    it(`${role} changes neither`, async () => {
      await db.as(callers[role]!.claims, async (c) => {
        expect(await refused(c, () => rename(c))).toMatch(/refused|no rows/);
        expect(await refused(c, () => recurrency(c))).toMatch(/refused|no rows/);
      });
    });
  }
  it("only an agency admin creates or deletes a workspace", async () => {
    for (const role of ["owner", "editor"] as const) {
      await db.as(callers[role]!.claims, async (c) => {
        expect(await refused(c, () => c.query("insert into workspaces (name, slug) values ('Nope', 'nope')"))).toBe("refused");
        expect(await refused(c, () => c.query("delete from workspaces where id = $1", [ws]))).toMatch(/refused|no rows/);
      });
    }
  });
});

describe("branding", () => {
  // Client branding (#34, B5): the same rule as the name and currency, in a jsonb column of its own.
  const rebrand = (c: pg.Client) => c.query("update workspaces set branding = jsonb_set(branding, '{accent}', '\"#0b6e8a\"') where id = $1", [ws]);

  for (const role of ["agency admin (JWT flag)", "agency_admin membership", "owner"] as const) {
    it(`${role} changes it`, async () => {
      await db.as(callers[role]!.claims, async (c) => {
        expect(await refused(c, () => rebrand(c))).toBe(1);
      });
    });
  }
  for (const role of ["editor", "member", "viewer", "signed in, no membership"] as const) {
    it(`${role} does not`, async () => {
      await db.as(callers[role]!.claims, async (c) => {
        expect(await refused(c, () => rebrand(c))).toMatch(/refused|no rows/);
      });
    });
  }
});

describe("functions", () => {
  // The result of calling each function as a role that may not edit: the function raises, or answers `not_found`.
  interface RpcCase {
    name: string;
    call: (c: pg.Client) => Promise<unknown>;
    /** What a refused caller sees. */
    refusal: { throws: RegExp } | { status: string };
  }

  const RPCS: RpcCase[] = [
    { name: "open_draft", call: (c) => c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID]), refusal: { status: "not_found" } },
    { name: "publish_process", call: (c) => c.query("select public.publish_process($1, true) as r", [NORTHBEAM_PROCESS_ID]), refusal: { status: "not_found" } },
    {
      name: "save_solution",
      call: (c) =>
        c.query("select public.save_solution($1, $2, $3, 'Matrix', $4::jsonb, '[]', '[]', '[]') as r", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, bundle]),
      refusal: { throws: /you cannot edit this workspace/ },
    },
    // B3: only those who may make share links get team inputs for one (no pay for anyone).
    { name: "share_team_capacity", call: (c) => c.query("select public.share_team_capacity($1, false) as r", [ws]), refusal: { throws: /you cannot make share links/ } },
    { name: "save_issue", call: (c) => c.query("select public.save_issue($1, $2::jsonb, $3) as r", [ws, JSON.stringify({ status: "open" }), openIssue]), refusal: { throws: /you cannot change issues/ } },
    {
      name: "resolve_issue",
      call: (c) => c.query("select public.resolve_issue($1, $2, 'not_a_problem', 'Matrix', 'resolved') as r", [ws, openIssue]),
      refusal: { throws: /you cannot change issues/ },
    },
    { name: "review_suggestions", call: (c) => c.query("select public.review_suggestions(array[$1::uuid], 'reject', null) as r", [ids.suggestion]), refusal: { status: "not_found" } },
    { name: "review_proposals", call: (c) => c.query("select public.review_proposals(array[$1::uuid], 'reject', null) as r", [ids.proposal]), refusal: { status: "not_found" } },
    { name: "create_library_process", call: (c) => c.query("select public.create_library_process($1, 'Matrix process', 'pipeline') as r", [ws]), refusal: { status: "not_found" } },
    {
      name: "save_fields",
      call: (c) => c.query("select public.save_fields('services', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id: ids.svcSeed }), JSON.stringify({ name: "Matrix seed service" }), JSON.stringify({ name: "Renamed" })]),
      refusal: { status: "not_found" },
    },
    {
      name: "save_health_rules",
      call: (c) => c.query("select public.save_health_rules($1, $2::jsonb, '{\"health_recover\": 7}') as r", [ws, `{"health_recover": ${healthRecover}}`]),
      refusal: { status: "not_found" },
    },
  ];

  const outcome = async (c: pg.Client, rpc: RpcCase): Promise<{ status?: string; error?: string }> => {
    await c.query("savepoint rpc");
    try {
      const res = (await rpc.call(c)) as pg.QueryResult;
      // A result is an object with a status, or (the review functions) a list of {id, status}, one per id asked for.
      const r = res.rows[0]?.r as { status?: string } | { status?: string }[] | null | undefined;
      return { status: (Array.isArray(r) ? r[0] : r)?.status };
    } catch (e) {
      await c.query("rollback to savepoint rpc");
      return { error: (e as Error).message };
    }
  };

  for (const rpc of RPCS) {
    it(`${rpc.name}: refused to member and viewer and the no-membership user, allowed to editor`, async () => {
      const seen: Record<string, { status?: string; error?: string }> = {};
      for (const role of ["owner", "editor", "member", "viewer", "signed in, no membership"] as const) {
        seen[role] = await db.as(callers[role]!.claims, (c) => outcome(c, rpc));
      }
      for (const role of ["owner", "editor"]) {
        // Allowed: no error at all, and not the refusal's status.
        expect(seen[role]!.error, `${rpc.name} as ${role}`).toBeUndefined();
        if ("status" in rpc.refusal) expect(seen[role]!.status, `${rpc.name} as ${role}`).not.toBe(rpc.refusal.status);
      }
      for (const role of ["member", "viewer", "signed in, no membership"]) {
        if ("status" in rpc.refusal) expect(seen[role], `${rpc.name} as ${role}`).toEqual({ status: rpc.refusal.status });
        else expect(seen[role]!.error, `${rpc.name} as ${role}`).toMatch(rpc.refusal.throws);
      }
    });
  }

  it("anon holds no execute right on any of them", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      for (const rpc of RPCS) {
        await db.client.query("savepoint a");
        await expect(rpc.call(db.client), rpc.name).rejects.toThrow(/permission denied/);
        await db.client.query("rollback to savepoint a");
      }
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("client health rules (B1 3/3)", () => {
  const save = (c: pg.Client, base: string, changes: string, w: string = ws) =>
    c.query("select public.save_health_rules($1, $2::jsonb, $3::jsonb) as r", [w, base, changes]);
  const run = async (role: RoleName, base: string, changes: string) =>
    (await db.as(callers[role]!.claims, (c) => save(c, base, changes))).rows[0].r as {
      status: string;
      row?: { settings: Record<string, unknown> };
      conflicts?: Record<string, unknown>;
    };
  const baseNow = `{"health_recover": ${healthRecover}}`;
  const raises = async (c: pg.Client, code: string, base: string, changes: string) => {
    await c.query("savepoint s");
    await expect(save(c, base, changes), changes).rejects.toMatchObject({ code });
    await c.query("rollback to savepoint s");
  };

  it("an editor saves a rule: saved, stored, stamped as entered by them, and logged with them as the actor", async () => {
    await db.as(callers.editor!.claims, async (c) => {
      const r = (await save(c, baseNow, '{"health_recover": 7}')).rows[0].r;
      expect(r).toMatchObject({ status: "saved", row: { settings: { health_recover: 7 } }, conflicts: {} });
      await c.query("reset role");
      const w = (
        await c.query(
          "select settings -> 'health_recover' as v, provenance -> 'settings.health_recover' ->> 'source' as source, provenance -> 'settings.health_recover' ->> 'by' as by from workspaces where id = $1",
          [ws],
        )
      ).rows[0];
      expect(w).toEqual({ v: 7, source: "entered", by: callers.editor!.id });
      const log = (await c.query("select actor_id, actor_kind, diff from audit_log where workspace_id = $1 and target_table = 'workspaces' and actor_id = $2", [ws, callers.editor!.id])).rows;
      expect(log).toHaveLength(1);
      expect(log[0].actor_kind).toBe("user");
      expect(JSON.stringify(log[0].diff)).toContain("health_recover");
    });
  });

  it("an owner and an agency admin save too; a member, a viewer and a stranger get not_found and change nothing", async () => {
    for (const role of ["owner", "agency admin (JWT flag)", "agency_admin membership"] as const) {
      expect((await run(role, baseNow, '{"health_recover": 8}')).status, role).toBe("saved");
    }
    for (const role of ["member", "viewer", "member, no person", "signed in, no membership"] as const) {
      expect(await run(role, baseNow, '{"health_recover": 9}'), role).toEqual({ status: "not_found" });
    }
    const stored = (await db.client.query("select settings -> 'health_recover' as v from workspaces where id = $1", [ws])).rows[0].v ?? null;
    expect(JSON.stringify(stored)).toBe(healthRecover);
  });

  it("an unknown workspace is not_found", async () => {
    const r = (await db.as(callers.editor!.claims, (c) => save(c, baseNow, '{"health_recover": 7}', "00000000-0000-4000-8000-0000000000bb"))).rows[0].r;
    expect(r).toEqual({ status: "not_found" });
  });

  it("null restores the default: the stored value becomes JSON null", async () => {
    await db.as(callers.editor!.claims, async (c) => {
      expect((await save(c, baseNow, '{"health_recover": 7}')).rows[0].r.status).toBe("saved");
      const r = (await save(c, '{"health_recover": 7}', '{"health_recover": null}')).rows[0].r;
      expect(r).toMatchObject({ status: "saved", row: { settings: { health_recover: null } } });
      await c.query("reset role");
      const w = (await c.query("select jsonb_typeof(settings -> 'health_recover') as t, settings ? 'health_recover' as present from workspaces where id = $1", [ws])).rows[0];
      expect(w).toEqual({ t: "null", present: true });
    });
  });

  it("a stale base gives a conflict with the stored value and writes nothing for that key; each key is checked against its own base", async () => {
    await db.as(callers.editor!.claims, async (c) => {
      await save(c, baseNow, '{"health_recover": 7}');
      const r = (await save(c, '{"health_recover": 3, "health_initial": null}', '{"health_recover": 9, "health_initial": 60}')).rows[0].r;
      expect(r).toMatchObject({ status: "conflict", conflicts: { health_recover: 7 }, row: { settings: { health_recover: 7, health_initial: 60 } } });
      // A value already stored counts as saved, whatever the base was.
      expect((await save(c, '{"health_recover": 3}', '{"health_recover": 7}')).rows[0].r.status).toBe("saved");
    });
  });

  it("a value above 100, below 0 or not a number is refused (23514); a bad changes or base, or a key with no base, is 22023", async () => {
    await db.as(callers.editor!.claims, async (c) => {
      for (const changes of ['{"health_recover": 101}', '{"health_recover": -1}', '{"health_recover": "7"}', '{"health_recover": true}', '{"health_recover": [7]}']) {
        await raises(c, "23514", baseNow, changes);
      }
      for (const [base, changes] of [[baseNow, "{}"], [baseNow, "[]"], ["[]", '{"health_recover": 7}'], ["{}", '{"health_recover": 7}']] as const) {
        await raises(c, "22023", base, changes);
      }
    });
    // 0 and 100 are allowed.
    for (const v of [0, 100]) expect((await run("editor", baseNow, `{"health_recover": ${v}}`)).status).toBe("saved");
  });

  it("no other key can be saved, by an editor or an owner (42501): name, currency, hours_per_week, availability_floor, and the rest", async () => {
    for (const role of ["editor", "owner"] as const) {
      await db.as(callers[role]!.claims, async (c) => {
        for (const key of ["name", "currency", "hours_per_week", "availability_floor", "overtime_cap", "provenance"]) {
          await raises(c, "42501", `{"${key}": null}`, `{"${key}": 5}`);
        }
      });
    }
    // Mixed with an allowed key, nothing is written.
    await db.as(callers.editor!.claims, async (c) => {
      await raises(c, "42501", `{"health_recover": ${healthRecover}, "currency": "GBP"}`, '{"health_recover": 7, "currency": "USD"}');
      await c.query("reset role");
      expect((await c.query("select settings ->> 'currency' as c from workspaces where id = $1", [ws])).rows[0].c).toBe("GBP");
    });
  });

  it("the editor still can't rename the workspace or write its settings directly (the update policy is unchanged)", async () => {
    await db.as(callers.editor!.claims, async (c) => {
      expect(await refused(c, () => c.query("update workspaces set name = name || '!' where id = $1", [ws]))).toMatch(/refused|no rows/);
      expect(await refused(c, () => c.query("update workspaces set settings = jsonb_set(settings, '{health_recover}', '5') where id = $1", [ws]))).toMatch(/refused|no rows/);
    });
  });

  it("an API token (the claims carry api_token_id) is refused by needs_review, even inside the SECURITY DEFINER function", async () => {
    const token = { ...callers.editor!.claims, api_token_id: "00000000-0000-4000-8000-0000000000cc" };
    await db.as(token, async (c) => {
      await c.query("savepoint s");
      await expect(save(c, baseNow, '{"health_recover": 7}')).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/changes only by review/) });
      await c.query("rollback to savepoint s");
    });
  });

  it("anon holds no execute right on it or on the agency list", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      for (const [sql, params] of [
        ["select public.save_health_rules($1, '{\"health_recover\": null}', '{\"health_recover\": 7}')", [ws]],
        ["select * from public.agency_workspace_list()", []],
      ] as const) {
        await db.client.query("savepoint a");
        await expect(db.client.query(sql, [...params]), sql).rejects.toThrow(/permission denied/);
        await db.client.query("rollback to savepoint a");
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("save_health_rules is SECURITY DEFINER with an empty search_path; the list is SECURITY INVOKER", async () => {
    const r = (
      await db.client.query(
        "select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname in ('save_health_rules', 'agency_workspace_list') order by 1",
      )
    ).rows;
    expect(r).toEqual([
      { proname: "agency_workspace_list", prosecdef: false, proconfig: ["search_path=\"\""] },
      { proname: "save_health_rules", prosecdef: true, proconfig: ["search_path=\"\""] },
    ]);
  });
});

describe("workspace_headlines and agency_workspace_list (B1 3/3)", () => {
  const upsert = (c: pg.Client, numbers: string) =>
    c.query(
      "insert into workspace_headlines (workspace_id, engine_version, revision_ids, horizon_weeks, numbers) values ($1, '1.7.0', '{}', 52, $2::jsonb) on conflict (workspace_id) do update set numbers = excluded.numbers",
      [ws, numbers],
    );

  it("the numbers must have the right shape (23514)", async () => {
    const good = JSON.parse(headlineNumbers) as Record<string, unknown>;
    const bad: Record<string, unknown>[] = [
      { ...good, flow_efficiency: 1.5 },
      { ...good, flow_efficiency: -0.1 },
      { ...good, flow_efficiency: "0.4" },
      { ...good, processes_attention: -1 },
      { ...good, processes_total: 1.5 },
      { ...good, client_groups_at_risk: "1" },
      { ...good, client_groups_total: null },
      { ...good, overtime_cost: 5 },
      { ...good, pay: { rate: 99 } },
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== "processes_total")),
    ];
    await db.as(callers.editor!.claims, async (c) => {
      for (const numbers of bad) {
        await c.query("savepoint s");
        await expect(upsert(c, JSON.stringify(numbers)), JSON.stringify(numbers)).rejects.toMatchObject({ code: "23514" });
        await c.query("rollback to savepoint s");
      }
      // A null flow efficiency (nothing to measure yet) is fine.
      await expect(upsert(c, JSON.stringify({ ...good, flow_efficiency: null }))).resolves.toBeTruthy();
    });
  });

  it("computed_by and computed_at are stamped by the database, whatever an editor sends (insert and update)", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("delete from workspace_headlines where workspace_id = $1", [ws]);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(callers.editor!.claims)]);
      const forge = "insert into workspace_headlines (workspace_id, computed_by, computed_at, engine_version, revision_ids, horizon_weeks, numbers) values ($1, $2, '2099-01-01', '1.7.0', '{}', 52, $3::jsonb) returning computed_by, computed_at > now() as future";
      const ins = (await db.client.query(forge, [ws, callers.owner!.id, headlineNumbers])).rows[0];
      expect(ins).toEqual({ computed_by: callers.editor!.id, future: false });
      const upd = (
        await db.client.query(
          "update workspace_headlines set computed_by = $2, computed_at = '2099-01-01' where workspace_id = $1 returning computed_by, computed_at > now() as future",
          [ws, callers.owner!.id],
        )
      ).rows[0];
      expect(upd).toEqual({ computed_by: callers.editor!.id, future: false });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("a member and a viewer can't insert or update; every reader reads", async () => {
    for (const role of ["member", "viewer", "member, no person", "signed in, no membership"] as const) {
      await db.as(callers[role]!.claims, async (c) => {
        expect(await refused(c, () => upsert(c, headlineNumbers)), role).toBe("refused");
        expect(await refused(c, () => c.query("update workspace_headlines set horizon_weeks = 1 where workspace_id = $1", [ws])), role).toMatch(/refused|no rows/);
      });
    }
    for (const role of ["owner", "editor", "member", "viewer", "member, no person"] as const) {
      await db.as(callers[role]!.claims, async (c) => expect(await rowsIn(c, "workspace_headlines"), role).toBe(1));
    }
    await db.as(callers["signed in, no membership"]!.claims, async (c) => expect(await rowsIn(c, "workspace_headlines")).toBe(0));
  });

  it("agency_workspace_list counts critical open and in-progress issues, last activity and the stored numbers, for each workspace the caller reads", async () => {
    const stats = async () =>
      db.as(callers["agency admin (JWT flag)"]!.claims, async (c) => (await c.query("select id, name, slug, open_risk_issues::int as open_risk_issues, last_activity, numbers, computed_at from public.agency_workspace_list()")).rows);
    const before = (await stats()).find((r) => r.id === ws);
    expect(before).toMatchObject({ name: "Northbeam Digital", slug: "northbeam", open_risk_issues: 0 });
    expect(before.last_activity).toBeInstanceOf(Date);

    await db.client.query("begin");
    try {
      for (const [title, severity, status] of [
        ["x risk open", "critical", "open"],
        ["x risk in progress", "critical", "in_progress"],
        ["x risk done", "critical", "done"],
        ["x risk dismissed", "critical", "dismissed"],
        ["x bad open", "serious", "open"],
      ] as const) {
        await db.client.query("insert into issues (workspace_id, type, title, severity, status) values ($1, 'delay', $2, $3, $4)", [ws, title, severity, status]);
      }
      await upsert(db.client, headlineNumbers);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(callers["agency admin (JWT flag)"]!.claims)]);
      const rows = (await db.client.query("select id, open_risk_issues::int as open_risk_issues, last_activity, numbers, computed_at from public.agency_workspace_list()")).rows;
      const nb = rows.find((r) => r.id === ws);
      expect(nb.open_risk_issues).toBe(2);
      expect(nb.numbers).toEqual(JSON.parse(headlineNumbers));
      expect(nb.computed_at).toBeInstanceOf(Date);
      expect(nb.last_activity.getTime()).toBeGreaterThanOrEqual(before.last_activity.getTime());
      // Larkspur has no headline yet.
      const lark = rows.find((r) => r.id !== ws);
      expect(lark.numbers).toBeNull();
      expect(lark.computed_at).toBeNull();
    } finally {
      await db.client.query("rollback");
    }
  });

  it("agency_workspace_list: a member of Northbeam sees only Northbeam, a stranger nothing; the audit log counts toward last activity only for those who manage", async () => {
    for (const role of ["owner", "editor", "member", "viewer"] as const) {
      const rows = await db.as(callers[role]!.claims, async (c) => (await c.query("select id from public.agency_workspace_list()")).rows);
      expect(rows.map((r) => r.id), role).toEqual([ws]);
    }
    expect(await db.as(callers["signed in, no membership"]!.claims, async (c) => (await c.query("select id from public.agency_workspace_list()")).rows)).toEqual([]);
    await db.client.query("begin");
    try {
      await db.client.query("insert into audit_log (workspace_id, actor_id, actor_kind, action, target_table) values ($1, $2, 'user', 'update', 'workspaces')", [ws, callers.owner!.id]);
      await db.client.query("update audit_log set created_at = now() + interval '1 day' where workspace_id = $1 and actor_id = $2", [ws, callers.owner!.id]);
      const latest = async (role: RoleName) => {
        await db.client.query("set local role authenticated");
        await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(callers[role]!.claims)]);
        const t = (await db.client.query("select last_activity from public.agency_workspace_list()")).rows[0].last_activity as Date;
        await db.client.query("reset role");
        return t;
      };
      expect((await latest("owner")).getTime()).toBeGreaterThan((await latest("editor")).getTime());
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("open_share_link (B3)", () => {
  it("anon and every signed-in role may call it, and an unknown token gets nothing from any of them", async () => {
    const tok = "z".repeat(43);
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      expect((await db.client.query("select public.open_share_link($1) as r", [tok])).rows[0].r).toBeNull();
    } finally {
      await db.client.query("rollback");
    }
    for (const role of Object.keys(ROLES) as RoleName[]) {
      await db.as(callers[role]!.claims, async (c) => {
        expect((await c.query("select public.open_share_link($1) as r", [tok])).rows[0].r, role).toBeNull();
      });
    }
  });
});

describe("team_capacity (B1 2a)", () => {
  type Team = {
    sees_everyone: boolean;
    own_person_id: string | null;
    people: { id: string; name: string; cost_rate: number | null; provenance: object; [k: string]: unknown }[];
    person_roles: Record<string, unknown>[];
    person_skills: Record<string, unknown>[];
    person_leave: Record<string, unknown>[];
    client_assignments: Record<string, unknown>[];
  };
  const team = async (c: pg.Client) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t as Team;
  const READERS = ["agency admin (JWT flag)", "agency_admin membership", "owner", "editor", "member", "viewer", "member, no person"] as const;

  /** Run `fn` as `role`, after `setup` ran as the superuser in the same rolled-back transaction. */
  async function after<T>(setup: string | null, role: RoleName, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    await db.client.query("begin");
    try {
      if (setup) await db.client.query(setup);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(callers[role]!.claims)]);
      return await fn(db.client);
    } finally {
      await db.client.query("rollback");
    }
  }

  const strip = (rows: Record<string, unknown>[], omit: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k))));

  it("every reader gets the same people ids, roles, skills, leave and assignments as the tables hold", async () => {
    const q = async (sql: string) => (await db.client.query(sql, [ws])).rows;
    const expected = {
      ids: (await q("select id from people where workspace_id = $1")).map((r) => r.id).sort(),
      roles: await q("select person_id, role_id from person_roles where workspace_id = $1 order by 1, 2"),
      skills: await q("select person_id, step_id from person_skills where workspace_id = $1 order by 1, 2"),
      leave: await q(
        "select id, person_id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date from person_leave where workspace_id = $1 order by person_id, start_date, id",
      ),
      assignments: await q("select client_id, role_id, person_id from client_assignments where workspace_id = $1 order by 1, 2"),
    };
    expect(expected.skills.length).toBeGreaterThan(0);
    expect(expected.leave.length).toBeGreaterThan(0);
    for (const role of READERS) {
      const t = await db.as(callers[role]!.claims, team);
      expect(t.people.map((p) => p.id).sort(), role).toEqual(expected.ids);
      expect(strip(t.person_roles, ["workspace_id"]), role).toEqual(expected.roles);
      expect(strip(t.person_skills, ["workspace_id"]), role).toEqual(expected.skills);
      expect(strip(t.person_leave, ["workspace_id"]), role).toEqual(expected.leave);
      expect(strip(t.client_assignments, ["workspace_id"]), role).toEqual(expected.assignments);
    }
  });

  it("callers who see everyone get the real names and rates", async () => {
    const real = (await db.client.query("select id, name, cost_rate::float8 as cost_rate from people where workspace_id = $1 order by name", [ws])).rows;
    for (const role of ["agency admin (JWT flag)", "agency_admin membership", "owner", "editor"] as const) {
      const t = await db.as(callers[role]!.claims, team);
      expect(t.sees_everyone, role).toBe(true);
      expect(t.people.map((p) => ({ id: p.id, name: p.name, cost_rate: p.cost_rate })), role).toEqual(real);
    }
    expect((await db.as(callers.editor!.claims, team)).own_person_id).toBe(person.editor);
    expect((await db.as(callers.owner!.claims, team)).own_person_id).toBeNull();
  });

  it("a member gets their own name and 'Team member N' for everyone else; no email, notes, note or efficiency; provenance {}", async () => {
    await db.client.query("update people set provenance = '{\"fte\": {\"source\": \"entered\"}}', email = 'x@y.example', notes = 'private' where workspace_id = $1", [ws]);
    await db.client.query("update person_leave set note = 'private' where workspace_id = $1", [ws]);
    await db.client.query("update person_skills set efficiency = 1.5 where workspace_id = $1", [ws]);
    const rates = (await db.client.query("select id, cost_rate::float8 as cost_rate from people where workspace_id = $1", [ws])).rows as { id: string; cost_rate: number | null }[];
    await db.client.query("update people set cost_rate = 77.7 where workspace_id = $1", [ws]);
    try {
      for (const role of ["member", "viewer", "member, no person"] as const) {
        const raw = await db.as(callers[role]!.claims, async (c) => (await c.query("select public.team_capacity($1)::text as t", [ws])).rows[0].t as string);
        const t = JSON.parse(raw) as Team;
        expect(t.sees_everyone, role).toBe(false);
        const own = role === "member" ? person.member : role === "viewer" ? person.viewer : null;
        expect(t.own_person_id, role).toBe(own);
        for (const p of t.people) {
          if (p.id === own) expect(p.name, role).toBe(role === "member" ? "Leah Brooks" : "Dan Okafor");
          else expect(p.name, role).toMatch(/^Team member \d+$/);
          expect(p.provenance, role).toEqual({});
          // No pay for a member or viewer: null for everyone but themselves (Austin, 6 Oct).
          if (p.id === own) expect(p.cost_rate, role).toBe(77.7);
          else expect(p.cost_rate, role).toBeNull();
        }
        expect(raw.replace(/"cost_rate": 77\.7/, ""), role).not.toContain("77.7");
        expect(raw, role).not.toMatch(/x@y\.example|private|"email"|"notes"|"note"|efficiency/);
      }
    } finally {
      await db.client.query("update people set provenance = '{}', email = null, notes = null where workspace_id = $1", [ws]);
      await db.client.query("update person_leave set note = null where workspace_id = $1", [ws]);
      await db.client.query("update person_skills set efficiency = 1 where workspace_id = $1", [ws]);
      for (const r of rates) await db.client.query("update people set cost_rate = $1 where id = $2", [r.cost_rate, r.id]);
    }
  });

  it("labels are stable: unchanged on a second call, after a person is added (who gets the highest number) and after someone is deactivated", async () => {
    const labels = (t: Team) => Object.fromEntries(t.people.map((p) => [p.id, p.name]));
    const before = labels(await db.as(callers.member!.claims, team));
    expect(labels(await db.as(callers.member!.claims, team))).toEqual(before);
    const newId = "00000000-0000-4000-8000-0000000000aa";
    const added = await after(`insert into people (id, workspace_id, name) values ('${newId}', '${ws}', 'Newcomer')`, "member", async (c) => labels(await team(c)));
    for (const [id, name] of Object.entries(before)) expect(added[id], id).toBe(name);
    const highest = Math.max(...Object.values(before).flatMap((n) => (/^Team member (\d+)$/.test(n) ? [Number(/(\d+)$/.exec(n)![1])] : [])));
    expect(added[newId]).toBe(`Team member ${highest + 1}`);
    const deactivated = await after(`update people set active = false where id = '${person.spare}'`, "member", async (c) => labels(await team(c)));
    expect(deactivated).toEqual(before);
  });

  it("the no-membership user is refused (42501), and anon holds no execute right on it or on the helpers", async () => {
    await db.as(callers["signed in, no membership"]!.claims, async (c) => {
      await c.query("savepoint s");
      await expect(team(c)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/you cannot read this workspace/) });
      await c.query("rollback to savepoint s");
    });
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      for (const sql of ["select public.team_capacity($1)", "select public.can_see_people($1)", "select public.can_see_person($1, null)"]) {
        await db.client.query("savepoint a");
        await expect(db.client.query(sql, [ws]), sql).rejects.toThrow(/permission denied/);
        await db.client.query("rollback to savepoint a");
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("can_see_person: callers who see everyone see anyone; a member only their own person; null only for those who see everyone", async () => {
    const see = async (role: RoleName, who: string | null) =>
      db.as(callers[role]!.claims, async (c) => (await c.query("select public.can_see_person($1, $2) as v", [ws, who])).rows[0].v as boolean);
    expect(await see("editor", person.spare)).toBe(true);
    expect(await see("agency admin (JWT flag)", person.spare)).toBe(true);
    expect(await see("member", person.member)).toBe(true);
    expect(await see("member", person.spare)).toBe(false);
    expect(await see("member", null)).toBe(false);
    // An unlinked member: my_person_id is null, so the comparison is null (not false). A policy treats null as no.
    expect(await see("member, no person", person.member)).not.toBe(true);
    expect(await see("editor", null)).toBe(true);
  });
});

describe("revision_history author names (B1 2a)", () => {
  it("a member sees no name for another person's version and their own name for their own; editors see names", async () => {
    // Make the seeded version the work of one user, in a transaction that is rolled back.
    const names = async (role: RoleName, publisher: string) => {
      await db.client.query("begin");
      try {
        await db.client.query("update process_revisions set published_by = $1 where id = $2", [publisher, NORTHBEAM_REVISION_ID]);
        await db.client.query("set local role authenticated");
        await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(callers[role]!.claims)]);
        const r = await db.client.query("select author_name from public.revision_history($1) where revision_id = $2", [NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID]);
        return r.rows[0].author_name as string | null;
      } finally {
        await db.client.query("rollback");
      }
    };
    const editor = callers.editor!.id;
    expect(await names("member", editor)).toBeNull();
    expect(await names("viewer", editor)).toBeNull();
    expect(await names("editor", editor)).toBe("Maya Collins");
    expect(await names("owner", editor)).toBe("Maya Collins");
    // Their own version keeps the member's name.
    expect(await names("member", callers.member!.id)).toBe("Leah Brooks");
  });
});
