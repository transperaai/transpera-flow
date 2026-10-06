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

  it("ai_runs: editors and owners read both runs, a member only their own, a viewer none", async () => {
    const names = async (role: RoleName) =>
      (await db.as(callers[role]!.claims, async (c) => (await c.query("select user_name from ai_runs where workspace_id = $1 order by user_name", [ws])).rows)).map((r) => r.user_name as string);
    for (const role of ["agency admin (JWT flag)", "agency_admin membership", "owner", "editor"] as const) expect(await names(role), role).toEqual(["Ed Itor", "Mem Ber"]);
    expect(await names("member")).toEqual(["Mem Ber"]);
    expect(await names("viewer")).toEqual([]);
    expect(await names("member, no person")).toEqual([]);
    expect(await names("signed in, no membership")).toEqual([]);
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

  it("nobody can write to a table that has no grant for it: datasets and calibrations are insert-only, findings, suggestions and clients are never deleted", async () => {
    await db.as(callers.owner!.claims, async (c) => {
      for (const [table, verb] of [["datasets", "delete from datasets"], ["datasets", "update datasets set row_count = 2"], ["calibrations", "delete from calibrations"], ["findings", "delete from findings"], ["suggestions", "delete from suggestions"], ["clients", "delete from clients"]] as const) {
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
        }
        expect(raw, role).not.toMatch(/x@y\.example|private|"email"|"notes"|"note"|efficiency/);
      }
    } finally {
      await db.client.query("update people set provenance = '{}', email = null, notes = null where workspace_id = $1", [ws]);
      await db.client.query("update person_leave set note = null where workspace_id = $1", [ws]);
      await db.client.query("update person_skills set efficiency = 1 where workspace_id = $1", [ws]);
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
