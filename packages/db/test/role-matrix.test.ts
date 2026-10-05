import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamIssues,
  northbeamLeadSourceIds,
  northbeamServicingProcessIds,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The role matrix (issue #30, B1 part 1): what each of the seven kinds of caller can read, write and call in a workspace,
// as RLS and the SECURITY INVOKER functions enforce it. The matrix is data (`TABLES`, `RPCS`) so a later slice (B1 part 2,
// per-person privacy) changes the `people` expectations in one place. Rolled-back transactions throughout (`db.as`), so
// every probe starts from the same rows.

const ws = NORTHBEAM_WORKSPACE_ID;
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });
const servicingProcess = Object.values(northbeamServicingProcessIds)[0]!;
const [openIssue] = northbeamIssues().map((i) => i.id) as [string, string, string];

type Claims = Record<string, unknown>;
interface Caller {
  claims: Claims;
}

let db: TestDb;
const callers: Record<string, Caller> = {};
const ids = { client: "", svcSeed: "", svcProbe: "", condition: "", seedDataset: "", probeDataset: "" };

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
  named("people"),
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

const ROLES = {
  "agency admin (JWT flag)": { writes: true, reads: true },
  "agency_admin membership": { writes: true, reads: true },
  owner: { writes: true, reads: true },
  editor: { writes: true, reads: true },
  member: { writes: false, reads: true },
  viewer: { writes: false, reads: true },
  "signed in, no membership": { writes: false, reads: false },
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
  callers["signed in, no membership"] = await createUser(db, "stranger@matrix.example");

  const svc = async (name: string) =>
    (await db.client.query("insert into services (workspace_id, name) values ($1, $2) returning id", [ws, name])).rows[0].id as string;
  ids.svcSeed = await svc("Matrix seed service");
  ids.svcProbe = await svc("Matrix probe service");
  ids.condition = (await db.client.query("select id from market_conditions where workspace_id = $1 limit 1", [ws])).rows[0].id;
  const dataset = async (name: string) =>
    (await db.client.query("insert into datasets (workspace_id, kind, file_name, row_count) values ($1, 'step_log', $2, 1) returning id", [ws, name])).rows[0].id as string;
  ids.seedDataset = await dataset("seed-ds.csv");
  ids.probeDataset = await dataset("probe-ds.csv");

  // Every table gets a seed row (as the superuser), so a read count above zero and a refused update or delete mean something.
  ids.client = (await db.client.query("insert into clients (workspace_id, name) values ($1, 'x seed') returning id", [ws])).rows[0].id;
  for (const t of TABLES) {
    if (t.table === "clients") continue;
    const [sql, params] = t.insert("seed");
    await db.client.query(sql.includes("on conflict") ? sql : `${sql} on conflict do nothing`, params);
  }
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
  for (const [role, { reads }] of Object.entries(ROLES) as [RoleName, (typeof ROLES)[RoleName]][]) {
    it(`${role}: ${reads ? "reads" : "does not read"} every table`, async () => {
      await db.as(callers[role]!.claims, async (c) => {
        for (const t of TABLES) {
          const n = await rowsIn(c, t.table);
          if (reads) expect(n, t.table).toBeGreaterThan(0);
          else expect(n, t.table).toBe(0);
        }
      });
    });
  }

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
    { name: "review_suggestions", call: (c) => c.query("select public.review_suggestions(array[]::uuid[], 'reject', null) as r"), refusal: { throws: /./ } },
    { name: "review_proposals", call: (c) => c.query("select public.review_proposals(array[]::uuid[], 'reject', null) as r"), refusal: { throws: /./ } },
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
      const r = res.rows[0]?.r as { status?: string } | null | undefined;
      return { status: r?.status };
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
        expect(seen[role], `${rpc.name} as ${role}`).not.toMatchObject({ status: "not_found" });
        expect(seen[role]!.error ?? "", `${rpc.name} as ${role}`).not.toMatch(/permission denied|row-level security|not allowed/i);
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
