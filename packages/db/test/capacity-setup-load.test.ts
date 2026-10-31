import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LARKSPUR_WORKSPACE_ID,
  NORTHBEAM_WORKSPACE_ID,
  addTier,
  loadCapacitySetup,
  loadProcessBySlug,
  missingForCapacity,
  northbeamPersonIds,
  removeTier,
  tierCount,
  toEngineModel,
  uniqueClients,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The Set up loader and writers, as users with different rights; that keying in Set up data leaves the engine's model exactly as it was
// (against the snapshot taken before P1); compare-and-set under concurrent saves; and a person's tiers as a link set.

let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
const users: Record<string, User> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const START = "2026-10-05";

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  users.owner = await createUser(db, "owner@setup-load.example.com", { agency_admin: true });
  users.viewer = await createUser(db, "viewer@setup-load.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer'), ($3, $2, 'viewer')", [ws, users.viewer.id, LARKSPUR_WORKSPACE_ID]);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, (users.owner as User).id]).catch(() => undefined);
});
afterAll(async () => {
  await db?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];

describe("loadCapacitySetup", () => {
  it("an Owner reads everything, with salaries; a Viewer reads the same rows but no pay", async () => {
    const maya = northbeamPersonIds["Maya Collins"]!;
    await q("update people set salary_monthly = 9000, reserved_share = 0.25, label = 'offshore' where id = $1", [maya]);
    const owner = (await loadCapacitySetup(db.dbAs({ sub: users.owner!.id, role: "authenticated", app_metadata: { agency_admin: true } }), ws))!;
    expect(owner.canEdit).toBe(true);
    expect(owner.payHidden).toBe(false);
    expect(owner.departments.map((d) => d.name)).toEqual(["Organic (SEO)", "Performance"]);
    const person = owner.people.find((p) => p.id === maya)!;
    expect(person).toMatchObject({ salary_monthly: 9000, reserved_share: 0.25, label: "offshore", ramp: null });
    expect(owner.rampDefault).toEqual([0.4, 0.6, 0.8]);
    expect(owner.dlerIncludesLeadership).toBe(true);
    expect(owner.services.length).toBeGreaterThan(0);
    expect(owner.roles.every((r) => r.kind === "client_facing" && r.line === 0.85)).toBe(true);

    const viewer = (await loadCapacitySetup(db.dbAs({ sub: users.viewer!.id, role: "authenticated" }), ws))!;
    expect(viewer.canEdit).toBe(false);
    expect(viewer.payHidden).toBe(true);
    // A Viewer's read holds no pay at all: no salary and no cost rate on any row they can see.
    expect(viewer.people.every((p) => p.salary_monthly === null && p.cost_rate === null)).toBe(true);
    expect(missingForCapacity(viewer, { salariesVisible: !viewer.payHidden }).some((m) => m.kind === "person_salary")).toBe(false);
    expect(viewer.departments).toEqual(owner.departments);
  });

  it("returns null for a workspace the caller can't read", async () => {
    const stranger = await createUser(db, "stranger@setup-load.example.com");
    expect(await loadCapacitySetup(db.dbAs({ sub: stranger.id, role: "authenticated" }), ws)).toBeNull();
  });

  it("a tier's count is the named clients, the portfolios and the group's remainder, end to end", async () => {
    const owner = db.dbAs({ sub: users.owner!.id, role: "authenticated", app_metadata: { agency_admin: true } });
    await addTier(owner, LARKSPUR_WORKSPACE_ID);
    const made = await addTier(owner, LARKSPUR_WORKSPACE_ID);
    expect(made.ok).toBe(true);
    const tier = (made as { value: string }).value;
    const svc = (await q("select id, department_id from services where tier_id = $1 order by name limit 1", [tier]))[0]!;
    const client = (await q("insert into clients (workspace_id, name) values ($1, 'Counted Co') returning id", [LARKSPUR_WORKSPACE_ID]))[0]!.id as string;
    await q("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [client, svc.id, LARKSPUR_WORKSPACE_ID]);
    const person = (await q("insert into people (workspace_id, name) values ($1, 'Holder') returning id", [LARKSPUR_WORKSPACE_ID]))[0]!.id as string;
    await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 6)", [person, svc.id, LARKSPUR_WORKSPACE_ID]);
    await q("insert into client_groups (workspace_id, service_id, client_count) values ($1, $2, 3)", [LARKSPUR_WORKSPACE_ID, svc.id]);
    const setup = (await loadCapacitySetup(owner, LARKSPUR_WORKSPACE_ID))!;
    expect(tierCount(svc.id as string, setup)).toBe(1 + 6 + 3);
    expect(uniqueClients(setup).byDepartment[svc.department_id as string]).toBe(10);
    // A tier that has all that is refused in plain words; the first reason found is the named client.
    const refused = await removeTier(owner, tier);
    expect(refused).toMatchObject({ ok: false, inUse: true });
    expect((refused as { message: string }).message).toMatch(/1 named client still takes T\d+/);
  });
});

describe("the engine's model is untouched by Set up data", () => {
  it("Northbeam with tiers, deliverables, salaries, portfolios and overrides keyed in gives the model of the snapshot", async () => {
    const snapshot = JSON.parse(readFileSync(new URL("./snapshots/to-engine-model.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const before = JSON.parse(JSON.stringify(toEngineModel((await loadProcessBySlug(db.dbAs({ sub: users.owner!.id, role: "authenticated", app_metadata: { agency_admin: true } }), "northbeam"))!.live, { startDate: START })));
    // The model read from the database equals the fixture's snapshot (ids are the seed's).
    expect(before).toEqual(snapshot.northbeam);

    // An existing service becomes a tier of a department (the way a workspace that already sells things gets its tiers): only columns
    // the engine doesn't read change. (A tier made new with add_tier brings new services, which are services like any other.)
    const dept = (await q("select id from departments where workspace_id = $1 order by sort limit 1", [ws]))[0]!.id as string;
    const tier = (await q("insert into tiers (workspace_id, key, name) values ($1, 'T1', 'Tier 1') returning id", [ws]))[0]!.id as string;
    await q("update services set department_id = $2, tier_id = $3, words = 4000, links = 8, adhoc_chance = 0.9, adhoc_requests = 6.5, price_rise_churn = 0.75 where id = (select id from services where workspace_id = $1 order by id limit 1)", [ws, dept, tier]);
    const people = await q("select id from people where workspace_id = $1 order by id", [ws]);
    await q("update people set salary_monthly = 7500, reserved_share = 0.3, label = 'contractor', ramp = '[0.5, 0.75]' where id = $1", [people[0]!.id]);
    const svc = (await q("select id from services where tier_id = $1 limit 1", [tier]))[0]!.id as string;
    await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 4)", [people[0]!.id, svc, ws]);
    await q("update tiers set both_count = 3 where id = $1", [tier]);
    await q("insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [people[0]!.id, tier, ws]);
    const client = (await q("select id from clients where workspace_id = $1 order by id limit 1", [ws]))[0]!.id as string;
    await q("update clients set channels = 6, hand_holding_hours = 3, step_factor = 1.5, adhoc_hours = 0.5 where id = $1", [client]);
    await q("update roles set kind = 'shared', line = 0.7, unit = 'words', rule_of_thumb = 10 where workspace_id = $1 and id = (select id from roles where workspace_id = $1 order by id limit 1)", [ws]);
    await q("update workspaces set settings = settings || '{\"ramp_default\": [0.3, 0.6], \"dler_includes_leadership\": false}'::jsonb where id = $1", [ws]);

    const after = JSON.parse(JSON.stringify(toEngineModel((await loadProcessBySlug(db.dbAs({ sub: users.owner!.id, role: "authenticated", app_metadata: { agency_admin: true } }), "northbeam"))!.live, { startDate: START })));
    expect(after).toEqual(before);
  });
});

describe("compare-and-set, and a person's tiers as a set", () => {
  let c1: pg.Client;
  let c2: pg.Client;
  beforeAll(async () => {
    c1 = new pg.Client({ connectionString: db.url });
    c2 = new pg.Client({ connectionString: db.url });
    await Promise.all([c1.connect(), c2.connect()]);
  });
  afterAll(async () => {
    await Promise.all([c1.end(), c2.end()]);
  });
  async function commitAs<T>(client: pg.Client, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    await client.query("begin");
    try {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.owner!.claims)]);
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  }

  it("two editors saving one tier count at once: one saves, the other is asked, and nothing is clobbered", async () => {
    const tier = (await q("insert into tiers (workspace_id, key, name) values ($1, 'CAS', 'CAS tier') returning id", [ws]))[0]!.id as string;
    const save = (c: pg.Client, value: number) =>
      commitAs(c, async (x) => (await x.query("select public.save_fields('tiers', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id: tier }), JSON.stringify({ both_count: 0 }), JSON.stringify({ both_count: value })])).rows[0].r as { status: string; conflicts?: Record<string, unknown> });
    const [a, b] = await Promise.all([save(c1, 3), save(c2, 5)]);
    expect([a.status, b.status].sort()).toEqual(["conflict", "saved"]);
    const winner = a.status === "saved" ? 3 : 5;
    expect((await q("select both_count from tiers where id = $1", [tier]))[0]!.both_count).toBe(winner);
    expect((a.status === "conflict" ? a : b).conflicts).toEqual({ both_count: winner });
  });

  it("save_links replaces a person's tiers as one set, refuses a stale base, and a Viewer finds nothing to change", async () => {
    const t1 = (await q("insert into tiers (workspace_id, key, name) values ($1, 'L1', 'L1') returning id", [ws]))[0]!.id as string;
    const t2 = (await q("insert into tiers (workspace_id, key, name) values ($1, 'L2', 'L2') returning id", [ws]))[0]!.id as string;
    const p = (await q("insert into people (workspace_id, name) values ($1, 'Linker') returning id", [ws]))[0]!.id as string;
    const links = (user: User, base: string[], next: string[]) =>
      commitAs(c1, async (x) => {
        await x.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user.claims)]);
        return (await x.query("select public.save_links('person_tiers', $1::jsonb, 'tier_id', $2::jsonb, $3::jsonb) as r", [JSON.stringify({ person_id: p, workspace_id: ws }), JSON.stringify(base), JSON.stringify(next)])).rows[0].r as { status: string; members?: string[] };
      });
    expect(await links(users.owner!, [], [t1, t2])).toMatchObject({ status: "saved" });
    expect((await q("select tier_id from person_tiers where person_id = $1 order by tier_id", [p])).map((r) => r.tier_id).sort()).toEqual([t1, t2].sort());
    expect(await links(users.owner!, [t1], [t1])).toMatchObject({ status: "conflict" });
    expect(await links(users.owner!, [t1, t2], [t2])).toMatchObject({ status: "saved", members: [t2] });
    expect(await links(users.viewer!, [t2], [])).toMatchObject({ status: "not_found" });
    expect((await q("select count(*)::int as n from person_tiers where person_id = $1", [p]))[0]!.n).toBe(1);
  });
});
