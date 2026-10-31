import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { NORTHBEAM_WORKSPACE_ID, northbeamBundle, toEngineModel, type ChurnDriverRow, type ServiceRow } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Churn drivers as chances and fee ranges (sandbox phase 3, migration 20270112000000_churn_chances_and_fee_ranges.sql): the migration
// runs on a database full of real rows. It is built as it was before it (every migration up to 20270111000000), given every built-in
// driver, two of your own and a service of each pricing model, and then migrated: no row changes, every new column is null, the
// engine model of the workspace is the same, and the new checks, the provenance stamp and the lever table are there.

const BASE = "20270111000000";
const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let owner: { id: string; claims: Record<string, unknown> };
let before: { drivers: Record<string, unknown>[]; services: Record<string, unknown>[]; model: unknown; scenarios: number };

const BUILT_IN = ["late", "resp", "onb", "rework", "load", "handoff", "results", "tenure", "price", "market"] as const;
const rows = async (table: string) => (await db.client.query(`select to_jsonb(t) as j from public.${table} t where workspace_id = $1 order by id`, [ws])).rows.map((r) => r.j as Record<string, unknown>);
const start = { startDate: "2026-10-05" };
const modelOf = async () => {
  const bundle = northbeamBundle();
  return toEngineModel({ ...bundle, services: (await rows("services")) as unknown as ServiceRow[], churnDrivers: (await rows("churn_drivers")) as unknown as ChurnDriverRow[] }, start);
};

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  owner = await createUser(db, "chances-owner@example.com", { agency_admin: true });
  let weight = 0.5;
  for (const driver of BUILT_IN) {
    const value = driver === "price" ? 10 : driver === "results" ? 7 : driver === "handoff" ? 0.3 : driver === "tenure" ? 1.6 : driver === "onb" ? 10 : null;
    const month = driver === "price" ? 3 : null;
    await db.client.query("insert into churn_drivers (workspace_id, driver, weight, enabled, value, month) values ($1, $2, $3, $4, $5, $6)", [ws, driver, (weight += 0.25) % 3, driver !== "rework", value, month]);
  }
  for (const [name, value] of [["A competitor undercuts us", 15], ["Poor onboarding calls", 40]] as const) {
    await db.client.query("insert into churn_drivers (workspace_id, name, weight, enabled, value) values ($1, $2, 1.5, true, $3)", [ws, name, value]);
  }
  await db.client.query("insert into services (workspace_id, name, pricing_model, price, margin, tenure_months, churn_monthly_base, mix_share) values ($1, 'Website build', 'one_off', 9500, 0.3, 0, 0, 0.2), ($1, 'Consulting', 'hourly', 140, 0.5, 6, 0.02, 0.1)", [ws]);
  before = {
    drivers: await rows("churn_drivers"),
    services: await rows("services"),
    model: await modelOf(),
    scenarios: Number((await db.client.query("select count(*) from sandbox_scenarios")).rows[0].count),
  };
  // Scenarios as they were saved before: every lever of the old table, with its old targets.
  await db.client.query(
    "insert into sandbox_scenarios (workspace_id, name, changes) values ($1, 'Everything before', $2::jsonb)",
    [
      ws,
      JSON.stringify([
        { id: "11111111-1111-4111-8111-000000000001", lever: "A1", target: null, op: "multiply", value: 1.1, from: "2027-01" },
        { id: "11111111-1111-4111-8111-000000000002", lever: "B3", target: null, op: "multiply", value: 1.5 },
        { id: "11111111-1111-4111-8111-000000000003", lever: "B1", target: null, op: "set", value: 30 },
        { id: "11111111-1111-4111-8111-000000000004", lever: "D4", target: "p", op: "set", value: 0.8, from: "2027-03" },
        { id: "11111111-1111-4111-8111-000000000005", lever: "D5", target: "@busiest", op: "add", value: 1, from: "2027-04" },
        { id: "11111111-1111-4111-8111-000000000006", lever: "C1", target: "@busiest", op: "multiply", value: 1.1, from: "2027-05" },
      ]),
    ],
  );
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270112000000_churn_chances_and_fee_ranges.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration does to stored rows", () => {
  it("changes no driver or service: every old column is as it was, and the five new ones are null", async () => {
    const drivers = await rows("churn_drivers");
    const services = await rows("services");
    expect(drivers).toHaveLength(before.drivers.length);
    expect(services).toHaveLength(before.services.length);
    for (const [i, d] of drivers.entries()) {
      const { chance, effect, effect_months, ...rest } = d;
      expect([chance, effect, effect_months], String(d.driver ?? d.name)).toEqual([null, null, null]);
      expect(rest).toEqual(before.drivers[i]);
    }
    for (const [i, s] of services.entries()) {
      // Later migrations add columns (Set up, 20270119000000): left out here, and the one provenance key they stamp on existing rows.
      const { price_low, price_high, department_id, tier_id, words, links, tech_hours, meetings, builds, creative_sets, channels, adhoc_chance, adhoc_requests, price_rise_churn, ...rest } = s;
      expect([price_low, price_high], String(s.name)).toEqual([null, null]);
      expect([department_id, tier_id, words, links, tech_hours, meetings, builds, creative_sets, channels, adhoc_chance, adhoc_requests]).toEqual(Array(11).fill(null));
      expect(price_rise_churn).toBe(0.5);
      const { price_rise_churn: _stamped, ...provenance } = rest.provenance as Record<string, unknown>;
      expect({ ...rest, provenance }).toEqual(before.services[i]);
    }
  });

  it("counts every built-in driver once, two custom drivers and the three kinds of service", async () => {
    const byDriver = (await db.client.query("select driver, count(*)::int as n from churn_drivers where workspace_id = $1 group by driver order by driver nulls last", [ws])).rows;
    expect(byDriver.filter((r) => r.driver !== null).map((r) => r.driver).sort()).toEqual([...BUILT_IN].sort());
    expect(byDriver.find((r) => r.driver === null)!.n).toBe(2);
    const kinds = (await db.client.query("select distinct pricing_model from services where workspace_id = $1 order by 1", [ws])).rows.map((r) => r.pricing_model);
    expect(kinds).toEqual(["hourly", "one_off", "retainer"]);
  });

  it("leaves the workspace's engine model exactly as it was", async () => {
    expect(await modelOf()).toEqual(before.model);
  });

  it("every saved scenario still passes the change check, and the library and the extra scenario are still there", async () => {
    expect(Number((await db.client.query("select count(*) from sandbox_scenarios where not private.is_sandbox_changes(changes)")).rows[0].count)).toBe(0);
    expect(Number((await db.client.query("select count(*) from sandbox_scenarios")).rows[0].count)).toBe(before.scenarios + 1);
  });

  it("has 25 levers in the lever table", async () => {
    expect(Number((await db.client.query("select count(*) from private.sandbox_levers()")).rows[0].count)).toBe(25);
  });

  it("has both stamp_provenance triggers enabled", async () => {
    const { rows: t } = await db.client.query(
      "select c.relname, g.tgenabled from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'stamp_provenance' and c.relname in ('churn_drivers', 'services') order by 1",
    );
    expect(t).toEqual([
      { relname: "churn_drivers", tgenabled: "O" },
      { relname: "services", tgenabled: "O" },
    ]);
  });
});

describe("what the new columns refuse", () => {
  const driver = async (set: string) => db.client.query(`update churn_drivers set ${set} where workspace_id = $1 and driver = 'late'`, [ws]);
  const insertDriver = async (cols: string, vals: string) => db.client.query(`insert into churn_drivers (workspace_id, name, ${cols}) values ($1, 'x', ${vals})`, [ws]);

  it("a chance over 100, an effect below 0 or over 500, and months outside 1 to 24", async () => {
    await expect(driver("chance = 101"), "chance 101").rejects.toThrow(/churn_drivers_chance/);
    await expect(driver("chance = -1"), "chance -1").rejects.toThrow(/churn_drivers_chance/);
    await expect(driver("effect = -1"), "effect -1").rejects.toThrow(/churn_drivers_effect/);
    await expect(driver("effect = 501"), "effect 501").rejects.toThrow(/churn_drivers_effect/);
    await expect(driver("effect_months = 0"), "months 0").rejects.toThrow(/churn_drivers_effect_months/);
    await expect(driver("effect_months = 25"), "months 25").rejects.toThrow(/churn_drivers_effect_months/);
    await expect(insertDriver("chance", "101")).rejects.toThrow(/churn_drivers_chance/);
    await expect(insertDriver("effect", "-1")).rejects.toThrow(/churn_drivers_effect/);
    await expect(insertDriver("effect_months", "0")).rejects.toThrow(/churn_drivers_effect_months/);
  });

  it("accepts the limits, on a built-in and on a driver of your own", async () => {
    await expect(driver("chance = 0, effect = 0, effect_months = 1")).resolves.toBeDefined();
    await expect(driver("chance = 100, effect = 500, effect_months = 24")).resolves.toBeDefined();
    await expect(insertDriver("chance, effect, effect_months", "12.5, 60, 3")).resolves.toBeDefined();
    await driver("chance = null, effect = null, effect_months = null");
  });

  it("a chance or an effect on the tenure and market drivers (they have no events)", async () => {
    for (const d of ["tenure", "market"]) {
      for (const set of ["chance = 5", "effect = 50", "effect_months = 3"]) {
        await expect(db.client.query(`update churn_drivers set ${set} where workspace_id = $1 and driver = $2`, [ws, d]), `${d} ${set}`).rejects.toThrow(/churn_drivers_chance_kinds/);
      }
    }
    // The other built-ins and your own take them.
    await expect(db.client.query("update churn_drivers set chance = 5, effect = 50 where workspace_id = $1 and driver = 'price'", [ws])).resolves.toBeDefined();
    await db.client.query("update churn_drivers set chance = null, effect = null where workspace_id = $1 and driver = 'price'", [ws]);
  });

  it("a fee below 0 at either end of a range, and accepts any order of price and ends (the engine uses the price as an end)", async () => {
    await expect(db.client.query("update services set price_low = -1 where workspace_id = $1 and name = 'Consulting'", [ws])).rejects.toThrow(/services_price_low/);
    await expect(db.client.query("update services set price_high = -1 where workspace_id = $1 and name = 'Consulting'", [ws])).rejects.toThrow(/services_price_high/);
    await expect(db.client.query("update services set price_low = 500, price_high = 100 where workspace_id = $1 and name = 'Consulting'", [ws])).resolves.toBeDefined();
    await db.client.query("update services set price_low = null, price_high = null where workspace_id = $1 and name = 'Consulting'", [ws]);
  });

  it("through the app's own update, as the signed-in agency admin (row-level security applies)", async () => {
    const set = (c: import("pg").Client, sql: string) => c.query(`update services set ${sql} where workspace_id = $1 and name = 'Consulting'`, [ws]);
    await expect(db.as(owner.claims, (c) => set(c, "price_low = -5"))).rejects.toThrow(/services_price_low/);
    await db.as(owner.claims, async (c) => {
      await set(c, "price_low = 100, price_high = 200");
      const r = (await c.query("select price_low, price_high, provenance from services where workspace_id = $1 and name = 'Consulting'", [ws])).rows[0];
      expect([Number(r.price_low), Number(r.price_high)]).toEqual([100, 200]);
      // The stamp: a value a person sets is `entered`, and the trigger now names the range too.
      expect(r.provenance.price_low).toMatchObject({ source: "entered", by: owner.id });
      expect(r.provenance.price_high).toMatchObject({ source: "entered", by: owner.id });
    });
  });

  it("provenance is stamped for chance, effect and effect_months as entered", async () => {
    await db.as(owner.claims, async (c) => {
      await c.query("update churn_drivers set chance = 12, effect = 80, effect_months = 4 where workspace_id = $1 and driver = 'load'", [ws]);
      const p = (await c.query("select provenance from churn_drivers where workspace_id = $1 and driver = 'load'", [ws])).rows[0].provenance;
      for (const col of ["chance", "effect", "effect_months"]) expect(p[col], col).toMatchObject({ source: "entered", by: owner.id });
    });
  });
});

describe("the change check learns the new levers without refusing an old row", () => {
  const ok = async (changes: unknown) => (await db.client.query("select private.is_sandbox_changes($1::jsonb) as ok", [JSON.stringify(changes)])).rows[0].ok as boolean;
  const one = (lever: string, extra: Record<string, unknown>) => [{ id: "22222222-2222-4222-8222-000000000001", lever, target: null, op: "set", value: 1, ...extra }];

  it("takes B5 and A5 with its range, and refuses A5 without one", async () => {
    expect(await ok(one("B5", { value: 0.08, from: "2027-07" }))).toBe(true);
    expect(await ok(one("A5", { target: "s", value: 4000, params: { low: 3000, high: 6000 } }))).toBe(true);
    expect(await ok(one("A5", { target: "s", value: 4000 }))).toBe(false);
  });

  it("counts only a headcount cut and a solution toward the six months now", async () => {
    const months = ["01", "02", "03", "04", "05", "06", "07"];
    const as = (lever: string, m: string, i: number, extra: Record<string, unknown> = {}) => ({ id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, lever, target: lever === "A1" ? null : "r", op: "add", value: 1, from: `2027-${m}`, ...extra });
    expect(await ok(months.map((m, i) => as("A1", m, i)))).toBe(true);
    expect(await ok(months.map((m, i) => as("D5", m, i)))).toBe(false);
    expect(await ok(months.slice(0, 6).map((m, i) => as("D5", m, i)))).toBe(true);
  });
});
