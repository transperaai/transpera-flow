import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_PRESETS, percentsFromFactors, simulate, STABLE_MARKET } from "@transpera-flow/engine";
import { NORTHBEAM_WORKSPACE_ID, engineMarket, northbeamBundle, toEngineModel, type MarketConditionRow, type MarketScheduleRow } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Market conditions (A57): the four read-only presets every workspace has,
// custom conditions, and the 24-month schedule; row-level security, checks,
// and how the rows become the engine's market.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let otherWs: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@market.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-market') returning id")).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const presetId = async (workspace: string, preset: string) =>
  (await db.client.query("select id from market_conditions where workspace_id = $1 and preset = $2", [workspace, preset])).rows[0].id as string;

const addCustom = (c: import("pg").Client, workspace: string, name = "Cautious 2027") =>
  c.query("insert into market_conditions (workspace_id, name, leads, churn) values ($1, $2, 92, 108) returning id", [workspace, name]);

describe("presets", () => {
  it("every workspace, seeded or new, has the four presets with the engine's values", async () => {
    for (const workspace of [ws, otherWs]) {
      const rows = (
        await db.client.query(
          "select preset, name, leads, conv, cycle, price, churn, hire, pay from market_conditions where workspace_id = $1 and preset is not null order by preset",
          [workspace],
        )
      ).rows;
      expect(rows.map((r) => r.preset)).toEqual(["boom", "downturn", "soft", "stable"]);
      for (const r of rows) {
        const { preset, name, ...pct } = r;
        expect(name).toBe(MARKET_PRESETS[preset as keyof typeof MARKET_PRESETS].name);
        expect(pct).toEqual(percentsFromFactors(MARKET_PRESETS[preset as keyof typeof MARKET_PRESETS].factors));
      }
    }
  });

  it("are read-only through the API, whoever you are", async () => {
    const boom = await presetId(ws, "boom");
    await db.as(users.owner!.claims, async (c) => {
      expect((await c.query("update market_conditions set leads = 200 where id = $1", [boom])).rowCount).toBe(0);
      expect((await c.query("delete from market_conditions where id = $1", [boom])).rowCount).toBe(0);
      await expect(c.query("insert into market_conditions (workspace_id, name, preset) values ($1, 'Boom again', 'boom')", [ws])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("a custom condition can't be turned into a preset", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = (await addCustom(c, ws)).rows[0].id;
      await expect(c.query("update market_conditions set preset = 'soft' where id = $1", [id])).rejects.toThrow(/row-level security/);
    });
  });
});

describe("custom conditions: row-level security and checks", () => {
  it("owners and editors can add, change and delete; members and viewers can only read", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await addCustom(c, ws, `Mine ${role}`)).rows[0].id;
        expect((await c.query("update market_conditions set conv = 80 where id = $1", [id])).rowCount).toBe(1);
        expect((await c.query("delete from market_conditions where id = $1", [id])).rowCount).toBe(1);
      });
    }
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("select 1 from market_conditions where workspace_id = $1", [ws])).rowCount).toBeGreaterThanOrEqual(4);
        await expect(addCustom(c, ws)).rejects.toThrow(/row-level security/);
      });
    }
  });

  it("is invisible and unwritable across workspaces", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("select 1 from market_conditions where workspace_id = $1", [otherWs])).rowCount).toBe(0);
      await expect(addCustom(c, otherWs)).rejects.toThrow(/row-level security/);
    });
  });

  it("is not readable by anon", async () => {
    await expect(db.client.query("set role anon").then(() => db.client.query("select * from market_conditions"))).rejects.toThrow(/permission denied/);
    await db.client.query("reset role");
  });

  it.each([
    ["leads", -1],
    ["conv", 501],
    ["churn", 1000],
  ])("rejects %s = %s", async (col, value) => {
    await expect(
      db.client.query(`insert into market_conditions (workspace_id, name, ${col}) values ($1, 'Bad', $2)`, [ws, value]),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects an empty name", async () => {
    await expect(db.client.query("insert into market_conditions (workspace_id, name) values ($1, '  ')", [ws])).rejects.toThrow(/check constraint/);
  });
});

describe("schedule", () => {
  it("accepts non-overlapping changes, refuses overlaps and bad months", async () => {
    const soft = await presetId(ws, "soft");
    const add = (c: import("pg").Client, from: number, to: number) =>
      c.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, $2, $3, $4)", [ws, from, to, soft]);
    await db.as(users.editor!.claims, (c) => add(c, 7, 14));
    // Rolled back with the transaction above, so add it as the admin to test the overlap.
    await add(db.client, 7, 14);
    await expect(db.as(users.editor!.claims, (c) => add(c, 14, 16))).rejects.toThrow(/overlap/);
    await expect(db.as(users.editor!.claims, (c) => add(c, 1, 7))).rejects.toThrow(/overlap/);
    await db.as(users.editor!.claims, (c) => add(c, 15, 24));
    await db.as(users.editor!.claims, (c) => add(c, 1, 6));
    await expect(
      db.client.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 0, 3, $2)", [ws, soft]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.client.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 25, 25, $2)", [ws, soft]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.client.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 5, 3, $2)", [ws, soft]),
    ).rejects.toThrow(/check constraint/);
    await db.client.query("delete from market_schedule where workspace_id = $1", [ws]);
  });

  it("two concurrent overlapping inserts can't both succeed", async () => {
    const soft = await presetId(ws, "soft");
    const b = new pg.Client({ connectionString: db.url });
    await b.connect();
    const sql = "insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, $2, $3, $4)";
    try {
      await db.client.query("begin");
      await db.client.query(sql, [ws, 3, 8, soft]);
      await b.query("begin");
      // Blocks on the workspace's lock until the first transaction ends.
      const second = b.query(sql, [ws, 6, 10, soft]);
      const outcome = second.then(
        () => "inserted",
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 200));
      await db.client.query("commit");
      expect(await outcome).toMatch(/overlap/);
    } finally {
      await b.query("rollback").catch(() => undefined);
      await b.end();
      await db.client.query("delete from market_schedule where workspace_id = $1", [ws]);
    }
  });

  it("can't use another workspace's condition, and a condition in use can't be deleted", async () => {
    const theirs = await presetId(otherWs, "soft");
    await expect(
      db.client.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 1, 3, $2)", [ws, theirs]),
    ).rejects.toThrow(/foreign key/);
    const custom = (await addCustom(db.client, ws, "In use")).rows[0].id;
    await db.client.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 1, 3, $2)", [ws, custom]);
    await expect(db.client.query("delete from market_conditions where id = $1", [custom])).rejects.toThrow(/foreign key/);
    await db.client.query("delete from market_schedule where workspace_id = $1", [ws]);
    await db.client.query("delete from market_conditions where id = $1", [custom]);
  });

  it("members and viewers can't change it", async () => {
    const soft = await presetId(ws, "soft");
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        await expect(
          c.query("insert into market_schedule (workspace_id, from_month, to_month, condition_id) values ($1, 1, 3, $2)", [ws, soft]),
        ).rejects.toThrow(/row-level security/);
      });
    }
  });
});

describe("rows to engine market", () => {
  const cond = (id: string, over: Partial<MarketConditionRow>): MarketConditionRow => ({
    id,
    workspace_id: ws,
    name: id,
    preset: null,
    leads: 100,
    conv: 100,
    cycle: 100,
    price: 100,
    churn: 100,
    hire: 100,
    pay: 100,
    ...over,
  });
  const entry = (from: number, to: number, condition_id: string): MarketScheduleRow => ({ id: `${from}`, workspace_id: ws, from_month: from, to_month: to, condition_id });

  it("no schedule, or Stable throughout, leaves the model exactly as before", () => {
    const b = northbeamBundle();
    const plain = toEngineModel(b, { startDate: "2026-10-05" });
    expect(plain).not.toHaveProperty("market");
    const stable = cond("s", {});
    expect(toEngineModel({ ...b, marketConditions: [stable], marketSchedule: [entry(1, 24, "s")] }, { startDate: "2026-10-05" })).toEqual(plain);
  });

  it("expands the schedule month by month, Stable where nothing is set", () => {
    const soft = cond("soft", { leads: 85, conv: 90 });
    const mine = cond("mine", { leads: 92 });
    const market = engineMarket({ ...northbeamBundle(), marketConditions: [soft, mine], marketSchedule: [entry(7, 14, "soft"), entry(15, 24, "mine")] })!;
    expect(market.months).toHaveLength(24);
    expect(market.months[0]).toEqual(STABLE_MARKET);
    expect(market.months[6]!.leads).toBe(0.85);
    expect(market.months[6]!.conv).toBe(0.9);
    expect(market.months[23]!.leads).toBe(0.92);
  });

  it("a Downturn from month 1 lowers Northbeam's wins", async () => {
    const b = northbeamBundle();
    const down = cond("down", { leads: 65, conv: 75, cycle: 140, price: 88, churn: 135, hire: 80, pay: 135 });
    const base = simulate(toEngineModel(b, { startDate: "2026-10-05" }), 6, 1);
    const hit = simulate(toEngineModel({ ...b, marketConditions: [down], marketSchedule: [entry(1, 24, "down")] }, { startDate: "2026-10-05" }), 6, 1);
    expect(hit.won).toBeLessThan(base.won);
  });
});
