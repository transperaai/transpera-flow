import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import { NORTHBEAM_WORKSPACE_ID, engineChurnDrivers, northbeamBundle, toEngineModel, type ChurnDriverRow } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Churn drivers (issue #121): the table, row-level security, checks, provenance, the company-model
// triggers, the cap on drivers of your own, and the mapping to the engine.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let otherWs: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@drivers.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@drivers.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-drivers') returning id")).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.client.query("delete from churn_drivers");
});

const insertBuiltin = (c: { query: (q: string, v: unknown[]) => Promise<unknown> }, workspace: string, driver: string, extra = "") =>
  c.query(`insert into churn_drivers (workspace_id, driver${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2${extra ? ", " + extra.split("=")[1] : ""})`, [workspace, driver]);

describe("a fresh workspace", () => {
  it("has no drivers set: they are at their defaults, so it churns as it always did", async () => {
    expect((await db.client.query("select count(*)::int as n from churn_drivers")).rows[0].n).toBe(0);
  });
});

describe("row-level security", () => {
  it("lets owners and editors add, change and remove drivers, and stops members and viewers", async () => {
    await db.client.query("insert into churn_drivers (workspace_id, driver, weight) values ($1, 'late', 1.5)", [ws]);
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("select id from churn_drivers")).rowCount).toBe(1);
        expect((await c.query("update churn_drivers set weight = 3")).rowCount).toBe(0);
        expect((await c.query("delete from churn_drivers")).rowCount).toBe(0);
        await expect(c.query("insert into churn_drivers (workspace_id, driver) values ($1, 'resp')", [ws])).rejects.toThrow(/row-level security/);
      });
    }
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("update churn_drivers set weight = 2.5, enabled = false")).rowCount).toBe(1);
      expect((await c.query("delete from churn_drivers")).rowCount).toBe(1);
    });
    await db.as(users.owner!.claims, async (c) => {
      await insertBuiltin(c, ws, "market");
      expect((await c.query("select driver from churn_drivers order by driver")).rows).toEqual([{ driver: "late" }, { driver: "market" }]);
    });
  });

  it("hides one workspace's drivers from non-members and refuses a stranger's write", async () => {
    await db.client.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [ws]);
    expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select id from churn_drivers")).rowCount)).toBe(0);
    await expect(db.as(users.stranger!.claims, async (c) => insertBuiltin(c, ws, "resp"))).rejects.toThrow(/row-level security/);
    await db.client.query("delete from churn_drivers");
  });
});

describe("checks", () => {
  const owner = () => users.owner!.claims;
  const bad = (sql: string, params: unknown[] = []) => expect(db.as(owner(), async (c) => c.query(sql, [ws, ...params]))).rejects.toThrow(/check|unique|violates|at most 25/);

  it("keeps weight between 0 and 3, value between 0 and 500 and the month between 1 and 24", async () => {
    await bad("insert into churn_drivers (workspace_id, driver, weight) values ($1, 'late', 3.1)");
    await bad("insert into churn_drivers (workspace_id, driver, weight) values ($1, 'late', -0.1)");
    await bad("insert into churn_drivers (workspace_id, driver, value) values ($1, 'results', 501)");
    await bad("insert into churn_drivers (workspace_id, driver, value) values ($1, 'results', -1)");
    await bad("insert into churn_drivers (workspace_id, driver, month) values ($1, 'price', 0)");
    await bad("insert into churn_drivers (workspace_id, driver, month) values ($1, 'price', 25)");
    await db.as(owner(), async (c) => {
      await c.query("insert into churn_drivers (workspace_id, driver, weight, value, month) values ($1, 'price', 0, 100, 24)", [ws]);
      await c.query("insert into churn_drivers (workspace_id, driver, weight) values ($1, 'late', 3)", [ws]);
    });
  });

  it("allows only the ten built-ins, one row each, and a month only for price changes", async () => {
    await bad("insert into churn_drivers (workspace_id, driver) values ($1, 'weather')");
    await db.client.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [ws]);
    await bad("insert into churn_drivers (workspace_id, driver) values ($1, 'late')");
    await bad("insert into churn_drivers (workspace_id, driver, month) values ($1, 'results', 3)");
    // The same built-in in another workspace is fine.
    await db.client.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [otherWs]);
    await db.client.query("delete from churn_drivers");
  });

  it("gives a driver of your own a name, description and example, and a built-in none", async () => {
    await db.as(owner(), async (c) => {
      const row = await c.query(
        "insert into churn_drivers (workspace_id, name, description, example, weight, value) values ($1, 'A rival', 'A cheaper agency opens nearby.', 'Two clients move to them.', 1, 15) returning driver, enabled",
        [ws],
      );
      expect(row.rows[0]).toEqual({ driver: null, enabled: true });
    });
    await bad("insert into churn_drivers (workspace_id) values ($1)");
    await bad("insert into churn_drivers (workspace_id, name) values ($1, '   ')");
    await bad("insert into churn_drivers (workspace_id, name) values ($1, $2)", ["x".repeat(81)]);
    await bad("insert into churn_drivers (workspace_id, name, description) values ($1, 'ok', $2)", ["x".repeat(301)]);
    await bad("insert into churn_drivers (workspace_id, driver, name) values ($1, 'late', 'Renamed')");
    await bad("insert into churn_drivers (workspace_id, driver, description) values ($1, 'late', 'Mine')");
    await db.client.query("delete from churn_drivers");
  });

  it("allows at most 25 drivers of your own per workspace", async () => {
    for (let i = 1; i <= 25; i++) await db.client.query("insert into churn_drivers (workspace_id, name) values ($1, $2)", [ws, `Mine ${i}`]);
    await bad("insert into churn_drivers (workspace_id, name) values ($1, 'One too many')");
    // Built-ins and other workspaces don't count against it.
    await db.client.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [ws]);
    await db.client.query("insert into churn_drivers (workspace_id, name) values ($1, 'Theirs')", [otherWs]);
    await db.client.query("delete from churn_drivers");
  });

  it("goes when its workspace goes", async () => {
    const w = (await db.client.query("insert into workspaces (name, slug) values ('Temp', 'temp-drivers') returning id")).rows[0].id;
    await db.client.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [w]);
    await db.client.query("delete from workspaces where id = $1", [w]);
    expect((await db.client.query("select 1 from churn_drivers where workspace_id = $1", [w])).rowCount).toBe(0);
  });
});

describe("provenance and the company-model triggers", () => {
  it("stamps weight, switch and value a person sets as entered", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("insert into churn_drivers (workspace_id, driver, weight, value) values ($1, 'results', 1.5, 6)", [ws]);
      const first = (await c.query("select provenance from churn_drivers where driver = 'results'")).rows[0].provenance;
      expect(Object.keys(first).sort()).toEqual(["chance", "effect", "effect_months", "enabled", "month", "value", "weight"]);
      expect(first.weight).toMatchObject({ source: "entered", by: users.editor!.id });
      await c.query("update churn_drivers set weight = 2 where driver = 'results'");
      expect((await c.query("select provenance from churn_drivers where driver = 'results'")).rows[0].provenance.weight.source).toBe("entered");
    });
    await db.client.query("delete from churn_drivers");
  });

  it("audits every change, and refuses an API token", async () => {
    // As the editor, then read the log as the owner of the database (the audit log isn't readable by members).
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.editor!.claims)]);
      await db.client.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [ws]);
      await db.client.query("update churn_drivers set weight = 2 where driver = 'late'");
      await db.client.query("delete from churn_drivers where driver = 'late'");
      await db.client.query("reset role");
      const actions = (await db.client.query("select action from audit_log where target_table = 'churn_drivers' order by created_at, id")).rows.map((r) => r.action);
      expect(actions.sort()).toEqual(["delete", "insert", "update"]);
    } finally {
      await db.client.query("rollback");
    }
    await expect(
      db.as({ ...users.editor!.claims, api_token_id: "00000000-0000-0000-0000-000000000001" }, async (c) =>
        c.query("insert into churn_drivers (workspace_id, driver) values ($1, 'late')", [ws]),
      ),
    ).rejects.toThrow(/can't be changed through an API token/);
  });
});

describe("the engine model", () => {
  const start = { startDate: "2026-10-05" };
  const row = (over: Partial<ChurnDriverRow> & { weight: number; enabled: boolean }): ChurnDriverRow => ({
    id: "00000000-0000-0000-0000-0000000000aa",
    workspace_id: ws,
    driver: "late",
    name: null,
    description: null,
    example: null,
    value: null,
    month: null,
    chance: null,
    effect: null,
    effect_months: null,
    provenance: {},
    ...over,
  });

  it("maps built-ins by their key and your own as custom:<id>, and leaves them out with no rows", () => {
    const b = northbeamBundle();
    expect(engineChurnDrivers(b)).toBeUndefined();
    expect(toEngineModel(b, start).churnDrivers).toBeUndefined();
    const drivers = engineChurnDrivers({
      ...b,
      churnDrivers: [
        row({ weight: 1.5, enabled: true }),
        row({ id: "00000000-0000-0000-0000-0000000000bb", driver: "price", weight: 0.5, enabled: false, value: 10, month: 3 }),
        row({ id: "00000000-0000-0000-0000-0000000000cc", driver: null, name: "A rival", weight: 1, enabled: true, value: 15 }),
      ],
    });
    expect(drivers).toEqual([
      { id: "late", weight: 1.5, enabled: true },
      { id: "price", weight: 0.5, enabled: false, value: 10, month: 3 },
      { id: "custom:00000000-0000-0000-0000-0000000000cc", name: "A rival", weight: 1, enabled: true, value: 15 },
    ]);
  });

  it("with the defaults spelled out simulates the same as with no rows", () => {
    const b = northbeamBundle();
    const plain = simulate(toEngineModel(b, start), 5, 1);
    const spelled = simulate(
      toEngineModel(
        { ...b, churnDrivers: [row({ weight: 1, enabled: true }), row({ id: "00000000-0000-0000-0000-0000000000dd", driver: "market", weight: 1, enabled: true })] },
        start,
      ),
      5,
      1,
    );
    expect(spelled.kpi).toEqual(plain.kpi);
  });

  it("a stored driver changes the simulation: heavier late work loses more clients", () => {
    const b = northbeamBundle();
    const churned = (weight: number) => simulate(toEngineModel({ ...b, churnDrivers: [row({ weight, enabled: true })] }, start), 10, 1).kpi.clientsChurned!.mean;
    expect(churned(3)).toBeGreaterThan(churned(1));
  });
});
