import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Overheads (sandbox phase 2, migration 20270108000000_overheads.sql): the migration runs on a database full of real rows. It is
// built as it was before it (every migration up to 20270105000000), given workspaces holding every kind of value the key could
// have been given (a removed Suggestion or a restore could have written any of them), and then migrated.

const BASE = "20270105000000";
const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let owner: { id: string; claims: Record<string, unknown> };
const ids: Record<string, string> = {};
const CASES: [string, string][] = [
  ["string", '{"overhead_monthly": "12000"}'],
  ["number", '{"overhead_monthly": 12000}'],
  ["negative", '{"overhead_monthly": -5}'],
  ["text", '{"overhead_monthly": "abc"}'],
  ["null", '{"overhead_monthly": null}'],
  ["bool", '{"overhead_monthly": true}'],
  ["huge", '{"overhead_monthly": 2000000000}'],
  ["stringHuge", '{"overhead_monthly": "999999999"}'],
  ["stringDecimal", '{"overhead_monthly": " 99.5 "}'],
  ["object", '{"overhead_monthly": {"a": 1}}'],
  ["unset", '{"currency": "GBP"}'],
];

const stored = async (name: string) => (await db.client.query("select settings -> 'overhead_monthly' as v, settings ? 'overhead_monthly' as has, settings ->> 'currency' as currency from workspaces where id = $1", [ids[name]])).rows[0] as { v: unknown; has: boolean; currency: string | null };

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  for (const [name, settings] of CASES) {
    ids[name] = (await db.client.query("insert into workspaces (name, slug, settings) values ($1, $2, $3::jsonb) returning id", [name, `overheads-${name.toLowerCase()}`, settings])).rows[0].id;
  }
  owner = await createUser(db, "overheads-owner@example.com", { agency_admin: true });
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270108000000_overheads.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration does to stored values", () => {
  it("keeps a plain number, turns a number written as a string into one, keeps null, and removes anything else", async () => {
    expect((await stored("string")).v).toBe(12000);
    expect((await stored("number")).v).toBe(12000);
    expect((await stored("null")).v).toBeNull();
    expect((await stored("null")).has).toBe(true);
    // Nine digits is over the limit for a string (the pattern takes at most eight).
    expect((await stored("stringHuge")).has).toBe(false);
    expect((await stored("stringDecimal")).v).toBe(99.5);
    for (const name of ["negative", "text", "bool", "huge", "object"]) expect((await stored(name)).has, name).toBe(false);
  });

  it("leaves every other setting, and workspaces without the key, alone", async () => {
    expect(await stored("unset")).toEqual({ v: null, has: false, currency: "GBP" });
    expect((await db.client.query("select settings from workspaces where id = $1", [ws])).rows).toHaveLength(1);
  });

  it("the check is there and validated", async () => {
    const { rows } = await db.client.query("select convalidated from pg_constraint where conname = 'workspaces_overhead_monthly'");
    expect(rows).toEqual([{ convalidated: true }]);
  });
});

describe("what the check refuses", () => {
  const set = (value: string) => db.client.query("update workspaces set settings = settings || $2::jsonb where id = $1", [ids.unset, `{"overhead_monthly": ${value}}`]);

  it("a negative number, a string, a boolean and a number over 100,000,000, and accepts 0, null and the limit", async () => {
    for (const bad of ["-1", '"5"', "true", "100000001", "[]"]) await expect(set(bad), bad).rejects.toThrow(/workspaces_overhead_monthly/);
    for (const good of ["0", "null", "100000000", "18000.5"]) await expect(set(good), good).resolves.toBeDefined();
  });

  it("through save_fields, as the signed-in user", async () => {
    await set("18000.5");
    const save = (c: pg.Client, value: unknown) =>
      c.query("select public.save_fields('workspaces', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
        JSON.stringify({ id: ids.unset }),
        JSON.stringify({ "settings.overhead_monthly": 18000.5 }),
        JSON.stringify({ "settings.overhead_monthly": value }),
      ]);
    // Each in its own rolled-back transaction: a refused write aborts it.
    await expect(db.as(owner.claims, (c) => save(c, -1))).rejects.toThrow(/workspaces_overhead_monthly/);
    await expect(db.as(owner.claims, (c) => save(c, "5"))).rejects.toThrow(/workspaces_overhead_monthly/);
    const saved = await db.as(owner.claims, async (c) => {
      const out = (await save(c, 20000)).rows[0].r as { status: string };
      return { out, now: (await c.query("select settings -> 'overhead_monthly' as v from workspaces where id = $1", [ids.unset])).rows[0].v as number };
    });
    expect(saved).toEqual({ out: expect.objectContaining({ status: "saved" }), now: 20000 });
    expect((await stored("unset")).v).toBe(18000.5);
  });

  it("through a restore, which merges the file's settings wholesale", async () => {
    await set("18000.5");
    // A plan with a settings section and nothing else (every list empty).
    const lists = ["roles", "people", "person_roles", "person_leave", "lead_sources", "seasonality", "churn_drivers", "market_conditions", "market_schedule", "clients", "sources", "processes", "sandbox_scenarios", "blocks", "issues", "services", "service_servicing", "client_groups", "client_services", "client_assignments", "person_skills", "person_capacity_factors", "source_links"];
    const plan = (value: unknown) => ({ format: "transpera-workspace-import/1", settings: { overhead_monthly: value }, ...Object.fromEntries(lists.map((l) => [l, []])) });
    const restore = (c: pg.Client, value: unknown) =>
      c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, 'backup.json') as r", [ids.unset, JSON.stringify(plan(value))]);
    await expect(db.as(owner.claims, (c) => restore(c, -1))).rejects.toThrow(/workspaces_overhead_monthly/);
    await expect(db.as(owner.claims, (c) => restore(c, "5"))).rejects.toThrow(/workspaces_overhead_monthly/);
    const now = await db.as(owner.claims, async (c) => {
      await restore(c, 15000);
      return (await c.query("select settings -> 'overhead_monthly' as v from workspaces where id = $1", [ids.unset])).rows[0].v as number;
    });
    expect(now).toBe(15000);
    expect((await stored("unset")).v).toBe(18000.5);
  });
});
