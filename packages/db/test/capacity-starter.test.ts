import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, STARTER_ROLES, applyCapacityStarter, missingForCapacity, loadCapacitySetup, uniqueClients } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The capacity starter (D19): an empty workspace gets the prototype's tiers, example numbers and nine roles, all marked estimate; one that
// has anything in it gets nothing; running it twice changes nothing.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];
const newWorkspace = async (slug: string) => (await q("insert into workspaces (name, slug) values ($1, $1) returning id", [slug]))[0]!.id as string;

describe("applyCapacityStarter", () => {
  it("gives an empty workspace two departments, T1 to T3 with the prototype's numbers, and nine roles; no people and no clients", async () => {
    const ws = await newWorkspace("starter-fresh");
    const result = await applyCapacityStarter(db.client, ws);
    expect(result).toEqual({ applied: true, tiers: 3, services: 6, roles: 9 });
    expect((await q("select name from departments where workspace_id = $1 order by sort", [ws])).map((r) => r.name)).toEqual(["Organic (SEO)", "Performance"]);
    expect((await q("select key from tiers where workspace_id = $1 order by sort", [ws])).map((r) => r.key)).toEqual(["T1", "T2", "T3"]);
    const row = async (name: string) =>
      (await q("select price::float8 as price, words::float8 as words, links::float8 as links, tech_hours::float8 as tech, meetings::float8 as meetings, adhoc_chance::float8 as chance, adhoc_requests::float8 as requests, churn_monthly_base::float8 as churn, channels::float8 as channels, builds::float8 as builds, creative_sets::float8 as sets, mix_share::float8 as mix, price_rise_churn::float8 as rise from services where workspace_id = $1 and name = $2", [ws, name]))[0]!;
    expect(await row("Organic Tier 1")).toEqual({ price: 11000, words: 4000, links: 8, tech: 10, meetings: 4, chance: 0.9, requests: 6.5, churn: 0.01, channels: null, builds: null, sets: null, mix: 0.05, rise: 0.5 });
    expect(await row("Organic Tier 3")).toMatchObject({ price: 3000, words: 1000, links: 3, tech: 2, churn: 0.025, mix: 0.25 });
    expect(await row("Performance Tier 1")).toEqual({ price: 8000, words: null, links: null, tech: null, meetings: 4, chance: 0.95, requests: 8.5, churn: 0.01, channels: 4, builds: 5, sets: 2, mix: 0.05, rise: 0.5 });
    expect(await row("Performance Tier 3")).toMatchObject({ price: 2200, channels: 1.2, builds: 1.5, sets: 0.5, chance: 0.5, requests: 4 });
    // Every number is an estimate, never "entered".
    for (const s of await q("select provenance from services where workspace_id = $1", [ws])) {
      const p = s.provenance as Record<string, { source: string }>;
      for (const col of ["price", "churn_monthly_base", "meetings", "adhoc_chance", "adhoc_requests", "price_rise_churn", "mix_share"]) expect(p[col]?.source, col).toBe("estimate");
    }
    const roles = await q("select name, kind, line::float8 as line, rule_of_thumb, unit, (select name from departments d where d.id = r.department_id) as department, provenance from roles r where workspace_id = $1 order by name", [ws]);
    expect(roles).toHaveLength(9);
    expect(roles.map((r) => [r.name, r.department, r.kind, r.line, r.rule_of_thumb, r.unit])).toEqual(
      [...STARTER_ROLES].sort((a, b) => (a.name < b.name ? -1 : 1)).map((r) => [r.name, r.department, r.kind, r.line, r.rule, r.unit]),
    );
    expect(roles.find((r) => r.name === "Content team")).toMatchObject({ kind: "shared", unit: "words" });
    expect(roles.find((r) => r.name === "Technical SEO")).toMatchObject({ unit: "ticket hours" });
    expect(roles.find((r) => r.name === "Conversion tracking")).toMatchObject({ unit: "set-ups and incidents" });
    expect(roles.find((r) => r.name === "Performance implementers")).toMatchObject({ unit: "tasks" });
    expect(roles.find((r) => r.name === "Performance Director")).toMatchObject({ line: 0.8, rule_of_thumb: 6, kind: "client_facing", unit: null });
    expect((roles[0]!.provenance as Record<string, { source: string }>).line?.source).toBe("estimate");
    for (const table of ["people", "clients", "client_groups", "person_portfolio", "person_tiers"]) expect(await q(`select 1 from ${table} where workspace_id = $1`, [ws]), table).toEqual([]);
  });

  it("is idempotent: a second run changes nothing and says why", async () => {
    const ws = await newWorkspace("starter-twice");
    expect((await applyCapacityStarter(db.client, ws)).applied).toBe(true);
    const counts = async () => (await q("select (select count(*) from tiers where workspace_id = $1)::int as tiers, (select count(*) from services where workspace_id = $1)::int as services, (select count(*) from roles where workspace_id = $1)::int as roles, (select count(*) from departments where workspace_id = $1)::int as departments", [ws]))[0];
    const before = await counts();
    const again = await applyCapacityStarter(db.client, ws);
    expect(again.applied).toBe(false);
    expect(again).toMatchObject({ reason: expect.stringContaining("already has") });
    expect(await counts()).toEqual(before);
  });

  it("never touches a workspace in use: Northbeam and Larkspur, or one with a single person", async () => {
    for (const ws of [NORTHBEAM_WORKSPACE_ID, LARKSPUR_WORKSPACE_ID]) {
      const before = (await q("select (select count(*) from roles where workspace_id = $1)::int as r, (select count(*) from services where workspace_id = $1)::int as s, (select count(*) from tiers where workspace_id = $1)::int as t", [ws]))[0];
      expect((await applyCapacityStarter(db.client, ws)).applied).toBe(false);
      expect((await q("select (select count(*) from roles where workspace_id = $1)::int as r, (select count(*) from services where workspace_id = $1)::int as s, (select count(*) from tiers where workspace_id = $1)::int as t", [ws]))[0]).toEqual(before);
    }
    const ws = await newWorkspace("starter-person");
    await q("insert into people (workspace_id, name) values ($1, 'Already here')", [ws]);
    expect(await applyCapacityStarter(db.client, ws)).toMatchObject({ applied: false, reason: expect.stringContaining("people") });
    expect(await q("select 1 from tiers where workspace_id = $1", [ws])).toEqual([]);
    expect(await applyCapacityStarter(db.client, "00000000-0000-4000-8000-0000000000ff")).toEqual({ applied: false, reason: "No such workspace." });
  });

  it("leaves Set up showing what is still missing, not a blank page, and a Viewer reads it too", async () => {
    const ws = await newWorkspace("starter-read");
    await applyCapacityStarter(db.client, ws);
    const owner = await createUser(db, "owner@starter.example.com", { agency_admin: true });
    const setup = (await loadCapacitySetup(db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } }), ws))!;
    expect(setup.tiers).toHaveLength(3);
    expect(uniqueClients(setup)).toEqual({ byDepartment: expect.any(Object), both: 0, unique: 0 });
    const missing = missingForCapacity(setup);
    // Every tier deliverable is entered; what is left is the four shared teams' rates, and nobody to put in a portfolio yet.
    expect(missing.filter((m) => m.kind === "tier_deliverable")).toEqual([]);
    expect(missing.filter((m) => m.kind === "shared_role_unit")).toEqual([]);
    expect(missing.filter((m) => m.kind === "shared_role_rate")).toHaveLength(5);
  });

  it("the script does the same from the command line, on the slug, and refuses a second run", async () => {
    const ws = await newWorkspace("starter-script");
    const run = () =>
      execFileSync("node", ["--experimental-strip-types", "scripts/capacity-starter.ts", "--workspace", "starter-script"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, DATABASE_URL: db.url, NODE_NO_WARNINGS: "1" },
        encoding: "utf8",
      });
    expect(run()).toContain('Gave "starter-script" 3 tiers, 6 services and 9 roles.');
    expect(run()).toContain("Nothing changed: The workspace already has tiers");
    expect((await q("select count(*)::int as n from roles where workspace_id = $1", [ws]))[0]!.n).toBe(9);
  }, 60_000);
});
