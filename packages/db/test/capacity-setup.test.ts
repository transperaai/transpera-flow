import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_TABLES,
  NORTHBEAM_WORKSPACE_ID,
  checkWorkspaceBundle,
  exportWorkspaceBundle,
  northbeamServiceIds,
  planWorkspaceImport,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { applyMigrations } from "../src/migrations";
import { headerRollback } from "./header-rollback";
import { createTestDb, createUser, type TestDb } from "./harness";

// Capacity Set up (P1, migration 20270119000000): departments, tiers, deliverables, named-client overrides, portfolios, people's team
// time and salary, roles' kind and line. Row-level security, checks, provenance stamping, adding and removing tiers, per-field saves,
// the restore, and the rollback in the migration's header.

let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
const users: Record<string, User> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  users.owner = await createUser(db, "owner@capacity-setup.example.com", { agency_admin: true });
  for (const [name, role] of [["admin", "owner"], ["viewer", "viewer"]] as const) {
    users[name] = await createUser(db, `${name}@capacity-setup.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3::membership_role)", [ws, users[name]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@capacity-setup.example.com");
});
afterAll(async () => {
  await db?.close();
});

/** Run as a signed-in user and COMMIT: what one request does. */
async function as<T>(user: User, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user.claims)]);
    const r = await fn(db.client);
    await db.client.query("commit");
    return r;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
async function fails(fn: () => Promise<unknown>): Promise<{ code?: string; message: string; hint?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string; hint?: string };
  }
  throw new Error("expected the call to fail");
}

/** A fresh workspace (the Owner makes it), so tests don't disturb each other. */
async function newWorkspace(name = "Capacity Co"): Promise<string> {
  seq++;
  return as(users.owner!, async (c) => (await c.query("select public.create_workspace($1, $2) as id", [name, `cap-${seq}-${Date.now()}`])).rows[0].id as string);
}
const departmentOf = async (w: string, like: string) => (await q("select id from departments where workspace_id = $1 and name ilike $2", [w, like]))[0]!.id as string;
const addTier = (user: User, w: string) => as(user, async (c) => (await c.query("select public.add_tier($1) as id", [w])).rows[0].id as string);
const removeTier = (user: User, tier: string) => as(user, (c) => c.query("select public.remove_tier($1)", [tier]));
const person = async (w: string, name = "Pat") => (await q("insert into people (workspace_id, name) values ($1, $2) returning id", [w, name]))[0]!.id as string;

describe("departments", () => {
  it("Northbeam and Larkspur got Organic (SEO) and Performance from the migration, and a new workspace gets them too", async () => {
    const names = async (w: string) => (await q("select name from departments where workspace_id = $1 order by sort", [w])).map((r) => r.name);
    expect(await names(ws)).toEqual(["Organic (SEO)", "Performance"]);
    const fresh = await newWorkspace();
    expect(await names(fresh)).toEqual(["Organic (SEO)", "Performance"]);
  });

  it("seeding a pair only happens where a workspace has none", async () => {
    const fresh = await newWorkspace("Has one");
    await q("delete from departments where workspace_id = $1 and name = 'Performance'", [fresh]);
    await q(
      `insert into departments (workspace_id, name, sort) select w.id, d.name, d.sort from workspaces w cross join (values ('Organic (SEO)', 1), ('Performance', 2)) d (name, sort)
       where w.id = $1 and not exists (select 1 from departments x where x.workspace_id = w.id) on conflict do nothing`,
      [fresh],
    );
    expect(await q("select name from departments where workspace_id = $1", [fresh])).toEqual([{ name: "Organic (SEO)" }]);
  });
});

describe("row-level security", () => {
  const writes: [string, (w: string, ids: { dept: string; tier: string; person: string; service: string }) => [string, unknown[]]][] = [
    ["departments", (w) => ["insert into departments (workspace_id, name) values ($1, 'Social') returning id", [w]]],
    ["tiers", (w) => ["insert into tiers (workspace_id, key, name) values ($1, 'T' || (random() * 1e6)::int, 'Another') returning key", [w]]],
    ["person_tiers", (w, i) => ["insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [i.person, i.tier, w]]],
    ["person_portfolio", (w, i) => ["insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 3)", [i.person, i.service, w]]],
  ];

  it("a Viewer reads the new tables but can write none; the Owner and an Agency admin can write all", async () => {
    const w = ws;
    const tier = (await q("insert into tiers (workspace_id, key, name) values ($1, 'RLS', 'RLS tier') returning id", [w]))[0]!.id as string;
    const dept = await departmentOf(w, "Organic%");
    const service = northbeamServiceIds.seo;
    const p = await person(w, "RLS person");
    const ids = { dept, tier, person: p, service };
    await q("insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [p, tier, w]);
    await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 1)", [p, service, w]);
    for (const table of ["departments", "tiers", "person_tiers", "person_portfolio"]) {
      expect(await as(users.viewer!, async (c) => (await c.query(`select 1 from ${table} where workspace_id = $1`, [w])).rowCount), `viewer reads ${table}`).toBeGreaterThan(0);
      expect(await as(users.stranger!, async (c) => (await c.query(`select 1 from ${table} where workspace_id = $1`, [w])).rowCount), `stranger reads ${table}`).toBe(0);
    }
    for (const [table, make] of writes) {
      const [sql, params] = make(w, ids);
      const denied = await fails(() => as(users.viewer!, (c) => c.query(sql, params)));
      expect(denied.message, `viewer inserts ${table}`).toMatch(/row-level security/);
    }
    // Update and delete as a Viewer touch no row.
    expect(await as(users.viewer!, async (c) => (await c.query("update tiers set both_count = 9 where id = $1", [tier])).rowCount)).toBe(0);
    expect(await as(users.viewer!, async (c) => (await c.query("update person_portfolio set client_count = 9 where person_id = $1", [p])).rowCount)).toBe(0);
    expect(await as(users.viewer!, async (c) => (await c.query("delete from person_tiers where person_id = $1", [p])).rowCount)).toBe(0);
    expect(await as(users.viewer!, async (c) => (await c.query("delete from departments where id = $1", [dept])).rowCount)).toBe(0);
    // The Owner and an Agency admin write (each in a rolled-back run of the same statements, so the second finds the same rows).
    for (const who of ["owner", "admin"]) {
      await as(users[who]!, async (c) => {
        await c.query("update tiers set both_count = both_count + 1 where id = $1", [tier]);
        await c.query("update person_portfolio set client_count = 4 where person_id = $1", [p]);
        await c.query("update departments set sort = sort where id = $1", [dept]);
        await c.query("delete from person_tiers where person_id = $1", [p]);
        await c.query("insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [p, tier, w]);
      });
    }
    expect((await q("select both_count from tiers where id = $1", [tier]))[0]!.both_count).toBe(2);
  });

  it("the new columns on services, clients, people and roles follow the table's own rule", async () => {
    const p = await person(ws, "Column person");
    expect(await as(users.viewer!, async (c) => (await c.query("update services set words = 5 where id = $1", [northbeamServiceIds.seo])).rowCount)).toBe(0);
    await as(users.admin!, (c) => c.query("update services set words = 5, adhoc_chance = 0.4 where id = $1", [northbeamServiceIds.seo]));
    await as(users.admin!, (c) => c.query("update people set salary_monthly = 7500, reserved_share = 0.25, label = 'offshore' where id = $1", [p]));
    expect((await q("select salary_monthly::float8 as s, reserved_share::float8 as r, label from people where id = $1", [p]))[0]).toEqual({ s: 7500, r: 0.25, label: "offshore" });
  });
});

describe("checks and constraints", () => {
  let tier: string;
  let dept: string;
  let svc: string;
  beforeAll(async () => {
    const w = await newWorkspace("Checks Co");
    dept = await departmentOf(w, "Organic%");
    tier = await addTier(users.owner!, w);
    svc = (await q("select id from services where tier_id = $1 and department_id = $2", [tier, dept]))[0]!.id as string;
  });
  const bad = async (sql: string, params: unknown[] = []) => {
    const e = await fails(() => db.client.query(sql, params));
    expect(e.message).toMatch(/violates (check|unique|foreign key)/);
    return e;
  };

  it("keeps deliverables non-negative and chances between 0 and 1", async () => {
    for (const set of ["words = -1", "links = -1", "tech_hours = -1", "meetings = -1", "builds = -1", "creative_sets = -1", "channels = -1", "adhoc_chance = 1.1", "adhoc_chance = -0.1", "adhoc_requests = -1", "price_rise_churn = -0.1"]) {
      await bad(`update services set ${set} where id = $1`, [svc]);
    }
    await db.client.query("update services set words = 0, adhoc_chance = 1, adhoc_requests = 0 where id = $1", [svc]);
  });

  it("a service is a tier of a department only with both set, and a pair has one active service", async () => {
    await bad("update services set tier_id = null where id = $1", [svc]);
    const w = (await q("select workspace_id from services where id = $1", [svc]))[0]!.workspace_id as string;
    await bad("insert into services (workspace_id, name, department_id, tier_id) values ($1, 'Twin', $2, $3)", [w, dept, tier]);
    // An inactive twin is fine, and a service with neither set keeps working.
    await db.client.query("insert into services (workspace_id, name, department_id, tier_id, active) values ($1, 'Old twin', $2, $3, false)", [w, dept, tier]);
    await db.client.query("insert into services (workspace_id, name) values ($1, 'Plain')", [w]);
  });

  it("a department or tier of another workspace is refused", async () => {
    const other = await newWorkspace("Other Co");
    await bad("insert into services (workspace_id, name, department_id, tier_id) values ($1, 'Cross', $2, $3)", [other, dept, tier]);
  });

  it("keeps named-client overrides sane", async () => {
    const w = (await q("select workspace_id from services where id = $1", [svc]))[0]!.workspace_id as string;
    const c = (await q("insert into clients (workspace_id, name) values ($1, 'Override Co') returning id", [w]))[0]!.id as string;
    for (const set of ["channels = -1", "hand_holding_hours = -1", "adhoc_chance = 2", "adhoc_requests = -1", "adhoc_hours = -1", "meetings = -1", "words = -1", "links = -1", "tech_hours = -1", "builds = -1", "creative_sets = -1", "step_factor = 0", "step_factor = -1"]) {
      await bad(`update clients set ${set} where id = $1`, [c]);
    }
    await db.client.query("update clients set channels = 3, hand_holding_hours = 2, adhoc_chance = 1, adhoc_hours = 0.5, step_factor = 1.25 where id = $1", [c]);
  });

  it("keeps people's team time, salary, label and ramp sane", async () => {
    const w = (await q("select workspace_id from services where id = $1", [svc]))[0]!.workspace_id as string;
    const p = await person(w);
    for (const set of ["reserved_share = 0.91", "reserved_share = -0.1", "salary_monthly = -1", "label = 'intern'", "ramp = '[]'", "ramp = '{}'", "ramp = '[0.4, 1.2]'", "ramp = '[0.4, \"x\"]'", "ramp = '[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]'"]) {
      await bad(`update people set ${set} where id = $1`, [p]);
    }
    await db.client.query("update people set reserved_share = 0.9, salary_monthly = 0, label = 'contractor', ramp = '[0.4, 0.6, 0.8]' where id = $1", [p]);
    await db.client.query("update people set label = null, ramp = null where id = $1", [p]);
  });

  it("keeps roles' kind, line, rule of thumb and unit sane, and gives existing roles the defaults", async () => {
    const w = (await q("select workspace_id from services where id = $1", [svc]))[0]!.workspace_id as string;
    const r = (await q("insert into roles (workspace_id, name) values ($1, 'Probe role') returning id, kind, line::float8 as line, rule_of_thumb, unit, department_id", [w]))[0]!;
    expect(r).toMatchObject({ kind: "client_facing", line: 0.85, rule_of_thumb: null, unit: null, department_id: null });
    for (const set of ["kind = 'other'", "line = 0", "line = 2", "rule_of_thumb = 0", "unit = ' '"]) await bad(`update roles set ${set} where id = $1`, [r.id]);
    await db.client.query("update roles set kind = 'shared', line = 0.8, unit = 'words', department_id = $2 where id = $1", [r.id, dept]);
    // A role defaults to client-facing at 85% for every role that already existed (Northbeam's).
    expect(await q("select distinct kind, line::float8 as line from roles where workspace_id = $1", [ws])).toEqual([{ kind: "client_facing", line: 0.85 }]);
  });

  it("keeps a person's tier and portfolio rows unique, with counts of zero or more", async () => {
    const w = (await q("select workspace_id from services where id = $1", [svc]))[0]!.workspace_id as string;
    const p = await person(w);
    await db.client.query("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 2)", [p, svc, w]);
    await bad("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 2)", [p, svc, w]);
    await bad("update person_portfolio set client_count = -1 where person_id = $1", [p]);
    await db.client.query("insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [p, tier, w]);
    await bad("insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [p, tier, w]);
  });

  it("keeps tier keys unique per workspace and counts non-negative", async () => {
    const w = (await q("select workspace_id from services where id = $1", [svc]))[0]!.workspace_id as string;
    await bad("insert into tiers (workspace_id, key, name) values ($1, 'T1', 'Again')", [w]);
    await bad("update tiers set both_count = -1 where id = $1", [tier]);
    await bad("insert into tiers (workspace_id, key, name) values ($1, '', 'No key')", [w]);
  });

  it("checks the two new workspace settings keys", async () => {
    const w = await newWorkspace("Settings Co");
    const set = (json: string) => db.client.query("update workspaces set settings = settings || $2::jsonb where id = $1", [w, json]);
    for (const json of ['{"ramp_default": []}', '{"ramp_default": [0.4, 2]}', '{"ramp_default": "x"}', '{"ramp_default": [0.4, "a"]}', '{"dler_includes_leadership": "yes"}', '{"dler_includes_leadership": 1}']) {
      expect((await fails(() => set(json))).message, json).toMatch(/violates check constraint/);
    }
    await set('{"ramp_default": [0.4, 0.6, 0.8], "dler_includes_leadership": true}');
    await set('{"ramp_default": null, "dler_includes_leadership": null}');
  });
});

describe("provenance", () => {
  it("stamps `entered` on a number a person keys in or changes, and nothing for a null", async () => {
    const w = await newWorkspace("Provenance Co");
    const tier = await addTier(users.owner!, w);
    const dept = await departmentOf(w, "Performance");
    const svc = (await q("select id from services where tier_id = $1 and department_id = $2", [tier, dept]))[0]!.id as string;
    const prov = async () => (await q("select provenance from services where id = $1", [svc]))[0]!.provenance as Record<string, { source: string; at: string; by?: string }>;
    // A fresh tier of a workspace with no tiers has no values to copy: no deliverable is stamped, nor the default price rise.
    expect(Object.keys(await prov())).not.toContain("words");
    expect(Object.keys(await prov())).not.toContain("price_rise_churn");
    await as(users.owner!, (c) => c.query("update services set channels = 4, builds = 5 where id = $1", [svc]));
    let p = await prov();
    expect(p.channels).toMatchObject({ source: "entered", by: users.owner!.id });
    expect(p.builds?.source).toBe("entered");
    expect(p.words).toBeUndefined();
    // Changing a value re-stamps it; an untouched one keeps its stamp; a source set to something else is kept until the value changes.
    await db.client.query(`update services set provenance = provenance || '{"channels": {"source": "interview"}}'::jsonb where id = $1`, [svc]);
    await db.client.query("update services set builds = 6 where id = $1", [svc]);
    p = await prov();
    expect(p.channels).toEqual({ source: "interview" });
    expect(p.builds?.source).toBe("entered");
    await db.client.query("update services set channels = 5 where id = $1", [svc]);
    expect((await prov()).channels?.source).toBe("entered");
    // Clearing a number back to "not entered" removes its stamp.
    await db.client.query("update services set channels = null where id = $1", [svc]);
    expect((await prov()).channels).toBeUndefined();
  });

  it("stamps tiers' counts, portfolio counts, people's team time and salary, and clients' overrides", async () => {
    const w = await newWorkspace("Provenance Two");
    const tier = await addTier(users.owner!, w);
    await db.client.query("update tiers set both_count = 3 where id = $1", [tier]);
    expect((await q("select provenance from tiers where id = $1", [tier]))[0]!.provenance).toMatchObject({ both_count: { source: "entered" } });
    const p = await person(w);
    await db.client.query("update people set salary_monthly = 6000, reserved_share = 0.2 where id = $1", [p]);
    expect((await q("select provenance from people where id = $1", [p]))[0]!.provenance).toMatchObject({ salary_monthly: { source: "entered" }, reserved_share: { source: "entered" } });
    const c = (await q("insert into clients (workspace_id, name, channels) values ($1, 'Stamp Co', 3) returning provenance", [w]))[0]!;
    expect(c.provenance).toMatchObject({ channels: { source: "entered" } });
    expect((c.provenance as Record<string, unknown>).words).toBeUndefined();
    const svc = (await q("select id from services where tier_id = $1 limit 1", [tier]))[0]!.id as string;
    const pp = (await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 4) returning provenance", [p, svc, w]))[0]!;
    expect(pp.provenance).toMatchObject({ client_count: { source: "entered" } });
    expect((await q("select provenance from roles where workspace_id = $1 limit 1", [ws]))[0]!.provenance).not.toHaveProperty("line");
  });

  it("per-field saves work on the new tables and report a conflict", async () => {
    const w = await newWorkspace("Saves Co");
    const tier = await addTier(users.owner!, w);
    const save = (user: User, key: object, base: object, changes: object, target = "tiers") =>
      as(user, async (c) => (await c.query("select public.save_fields($1, $2::jsonb, $3::jsonb, $4::jsonb) as r", [target, JSON.stringify(key), JSON.stringify(base), JSON.stringify(changes)])).rows[0].r as { status: string; row?: Row; conflicts?: Row });
    const saved = await save(users.owner!, { id: tier }, { both_count: 0 }, { both_count: 4 });
    expect(saved.status).toBe("saved");
    expect(saved.row).toMatchObject({ both_count: 4, provenance: { both_count: { source: "entered" } } });
    const stale = await save(users.owner!, { id: tier }, { both_count: 0 }, { both_count: 7 });
    expect(stale).toMatchObject({ status: "conflict", conflicts: { both_count: 4 } });
    const p = await person(w);
    const svc = (await q("select id from services where tier_id = $1 limit 1", [tier]))[0]!.id as string;
    await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 1)", [p, svc, w]);
    expect((await save(users.owner!, { person_id: p, service_id: svc }, { client_count: 1 }, { client_count: 5 }, "person_portfolio")).status).toBe("saved");
    const dept = await departmentOf(w, "Organic%");
    expect((await save(users.owner!, { id: dept }, { name: "Organic (SEO)" }, { name: "SEO" }, "departments")).status).toBe("saved");
    // A Viewer's save finds no row it may change.
    const viewerWs = ws;
    const viewerTier = (await q("insert into tiers (workspace_id, key, name) values ($1, 'V1', 'Viewer probe') returning id", [viewerWs]))[0]!.id as string;
    expect((await save(users.viewer!, { id: viewerTier }, { both_count: 0 }, { both_count: 1 })).status).toBe("not_found");
  });
});

describe("the migration on a database that already has rows", () => {
  it("stamps the two defaulted columns `estimate` on existing services and roles, leaves updated_at alone, and invents no tier", async () => {
    const old = await createTestDb({ upTo: "20270117000000" });
    try {
      const before = (await old.client.query("select id, updated_at from services order by id")).rows;
      const rolesBefore = (await old.client.query("select id, updated_at from roles order by id")).rows;
      expect(before.length).toBeGreaterThan(0);
      await applyMigrations(old.client);
      expect((await old.client.query("select id, updated_at from services order by id")).rows).toEqual(before);
      expect((await old.client.query("select id, updated_at from roles order by id")).rows).toEqual(rolesBefore);
      expect((await old.client.query("select count(*)::int as n from services where provenance #>> '{price_rise_churn,source}' = 'estimate'")).rows[0].n).toBe(before.length);
      expect((await old.client.query("select count(*)::int as n from roles where provenance #>> '{line,source}' = 'estimate'")).rows[0].n).toBe(rolesBefore.length);
      expect((await old.client.query("select count(*)::int as n from tiers")).rows[0].n).toBe(0);
      expect((await old.client.query("select count(*)::int as n from workspaces w where (select count(*) from departments d where d.workspace_id = w.id) <> 2")).rows[0].n).toBe(0);
      expect((await old.client.query("select distinct price_rise_churn::float8 as p from services")).rows).toEqual([{ p: 0.5 }]);
    } finally {
      await old.close();
    }
  }, 60_000);
});

describe("adding and removing tiers", () => {
  it("add_tier starts T1, then copies the last tier's values for each department with counts at 0", async () => {
    const w = await newWorkspace("Tiers Co");
    const t1 = await addTier(users.owner!, w);
    expect(await q("select key, name, sort, both_count from tiers where workspace_id = $1", [w])).toEqual([{ key: "T1", name: "Tier 1", sort: 1, both_count: 0 }]);
    const org = await departmentOf(w, "Organic%");
    const perf = await departmentOf(w, "Performance");
    await q("update services set price = 11000, words = 4000, links = 8, tech_hours = 10, meetings = 4, adhoc_chance = 0.9, adhoc_requests = 6.5, churn_monthly_base = 0.01 where tier_id = $1 and department_id = $2", [t1, org]);
    await q("update services set price = 8000, channels = 4, builds = 5, creative_sets = 2, meetings = 4, adhoc_chance = 0.95, adhoc_requests = 8.5, churn_monthly_base = 0.01 where tier_id = $1 and department_id = $2", [t1, perf]);
    await q("update tiers set both_count = 1 where id = $1", [t1]);
    const t2 = await addTier(users.owner!, w);
    expect(await q("select key, name, sort, both_count from tiers where id = $1", [t2])).toEqual([{ key: "T2", name: "Tier 2", sort: 2, both_count: 0 }]);
    const row = async (tier: string, dept: string) =>
      (await q("select name, price::float8 as price, words::float8 as words, links::float8 as links, channels::float8 as channels, builds::float8 as builds, adhoc_chance::float8 as chance, churn_monthly_base::float8 as churn, price_rise_churn::float8 as rise, provenance from services where tier_id = $1 and department_id = $2", [tier, dept]))[0]!;
    expect(await row(t2, org)).toMatchObject({ name: "Organic Tier 2", price: 11000, words: 4000, links: 8, channels: null, chance: 0.9, churn: 0.01, rise: 0.5 });
    expect(await row(t2, perf)).toMatchObject({ name: "Performance Tier 2", price: 8000, words: null, channels: 4, builds: 5 });
    // The provenance of copied values comes with them.
    expect(((await row(t2, org)).provenance as Record<string, { source: string }>).words?.source).toBe("entered");
    const t3 = await addTier(users.owner!, w);
    expect((await q("select key from tiers where id = $1", [t3]))[0]!.key).toBe("T3");
    // Removing T2 then adding again never reuses a key already taken.
    await removeTier(users.owner!, t2);
    expect((await q("select key from tiers where id = $1", [await addTier(users.owner!, w)]))[0]!.key).toBe("T4");
  });

  it("refuses the last remaining tier, in plain words", async () => {
    const w = await newWorkspace("Last Tier Co");
    const only = await addTier(users.owner!, w);
    const e = await fails(() => removeTier(users.owner!, only));
    expect(e.message).toBe("You can't remove the last tier: every workspace keeps at least one.");
    expect(e.hint).toBe("tier_in_use");
    expect((await q("select count(*)::int as n from tiers where workspace_id = $1", [w]))[0]!.n).toBe(1);
  });

  it("refuses a tier that still has named clients, a portfolio, counted clients or servicing steps; and removes a clean one with its services", async () => {
    const w = await newWorkspace("Busy Tiers Co");
    const t1 = await addTier(users.owner!, w);
    const t2 = await addTier(users.owner!, w);
    const svc2 = (await q("select id from services where tier_id = $1 limit 1", [t2]))[0]!.id as string;

    const client = (await q("insert into clients (workspace_id, name) values ($1, 'Held Co') returning id", [w]))[0]!.id as string;
    await q("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [client, svc2, w]);
    expect((await fails(() => removeTier(users.owner!, t2))).message).toBe("1 named client still takes T2. Move or remove that client first.");
    await q("delete from client_services where client_id = $1", [client]);

    const p = await person(w);
    await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 3)", [p, svc2, w]);
    expect((await fails(() => removeTier(users.owner!, t2))).message).toBe("T2 has clients in people's portfolios. Set those counts to 0 first.");
    await q("update person_portfolio set client_count = 0 where person_id = $1", [p]);

    await q("insert into client_groups (workspace_id, service_id, client_count) values ($1, $2, 5)", [w, svc2]);
    expect((await fails(() => removeTier(users.owner!, t2))).message).toBe("T2 still has 5 counted clients. Set that count to 0 first.");
    await q("update client_groups set client_count = 0 where service_id = $1", [svc2]);

    // The portfolio row at 0 and the group at 0 don't block, and go with the tier.
    await removeTier(users.owner!, t2);
    expect(await q("select id from tiers where id = $1", [t2])).toEqual([]);
    expect(await q("select 1 from services where tier_id = $1", [t2])).toEqual([]);
    expect(await q("select 1 from person_portfolio where person_id = $1", [p])).toEqual([]);
    expect((await q("select count(*)::int as n from tiers where workspace_id = $1", [w]))[0]!.n).toBe(1);
    void t1;
  });

  it("a Viewer can't add or remove a tier", async () => {
    const viewerAdd = await fails(() => addTier(users.viewer!, ws));
    expect(viewerAdd.message).toBe("Only Agency admins and the Owner can change tiers.");
    const w = await newWorkspace("Viewer Tiers");
    const t1 = await addTier(users.owner!, w);
    await addTier(users.owner!, w);
    const stranger = await fails(() => removeTier(users.stranger!, t1));
    expect(stranger.message).toBe("That tier doesn't exist.");
    const tier = (await q("insert into tiers (workspace_id, key, name) values ($1, 'VX', 'x') returning id", [ws]))[0]!.id as string;
    expect((await fails(() => removeTier(users.viewer!, tier))).message).toBe("Only Agency admins and the Owner can change tiers.");
  });

  it("the tier and department a service belongs to can't be deleted from under it", async () => {
    const w = await newWorkspace("Restrict Co");
    const t = await addTier(users.owner!, w);
    expect((await fails(() => db.client.query("delete from tiers where id = $1", [t]))).message).toMatch(/violates foreign key/);
    expect((await fails(() => db.client.query("delete from departments where workspace_id = $1", [w]))).message).toMatch(/violates foreign key/);
  });
});

describe("a backup round-trips the new tables and columns", () => {
  async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
    const bundle = await db.as(users.owner!.claims, async (c) => {
      const read: TableReader = async (table, wsId) => {
        const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
        return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
      };
      const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
      return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
    });
    return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
  }

  it("exports and restores departments, tiers, deliverables, overrides, portfolios, tiers served, people, roles and the two settings", async () => {
    const src = await newWorkspace("Source Co");
    await q("update workspaces set settings = settings || '{\"ramp_default\": [0.4, 0.6, 0.8], \"dler_includes_leadership\": false}'::jsonb where id = $1", [src]);
    await q("update departments set name = 'SEO' where workspace_id = $1 and name like 'Organic%'", [src]);
    const org = await departmentOf(src, "SEO");
    const perf = await departmentOf(src, "Performance");
    const t1 = await addTier(users.owner!, src);
    const t2 = await addTier(users.owner!, src);
    await q("update tiers set both_count = 5 where id = $1", [t2]);
    await q("update services set words = 1500, links = 5, tech_hours = 5, meetings = 1, adhoc_chance = 0.7, adhoc_requests = 4, price = 4500, price_rise_churn = 0.75 where tier_id = $1 and department_id = $2", [t2, org]);
    await q("update services set channels = 1.5, builds = 3, creative_sets = 1 where tier_id = $1 and department_id = $2", [t2, perf]);
    const svc = (await q("select id from services where tier_id = $1 and department_id = $2", [t2, org]))[0]!.id as string;
    const role = (await q("insert into roles (workspace_id, name, department_id, kind, line, rule_of_thumb, unit) values ($1, 'SEO Manager', $2, 'client_facing', 0.8, 10, 'tasks') returning id", [src, org]))[0]!.id as string;
    const pid = (await q("insert into people (workspace_id, name, reserved_share, salary_monthly, label, ramp) values ($1, 'Karl', 0.2, 10000, 'offshore', '[0.5, 0.75]') returning id", [src]))[0]!.id as string;
    await q("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [pid, role, src]);
    await q("insert into person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3), ($1, $4, $3)", [pid, t1, src, t2]);
    await q("insert into person_portfolio (person_id, service_id, workspace_id, client_count) values ($1, $2, $3, 6)", [pid, svc, src]);
    const cid = (await q("insert into clients (workspace_id, name, channels, hand_holding_hours, adhoc_chance, adhoc_requests, adhoc_hours, meetings, words, links, tech_hours, builds, creative_sets, step_factor) values ($1, 'Harbourline', 6, 3, 1, 8, 0.75, 4, 100, 2, 3, 4, 5, 1.5) returning id", [src]))[0]!.id as string;
    await q("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [cid, svc, src]);

    const bundle = await exportOf(src);
    for (const k of ["departments", "tiers", "person_tiers", "person_portfolio"]) expect(bundle.company_model[k]!.length, k).toBeGreaterThan(0);
    const check = checkWorkspaceBundle(bundle, { canManage: true });
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
    const { plan, warnings } = planWorkspaceImport(bundle, { canManage: true });
    expect(warnings).toEqual([]);
    expect(plan.departments).toHaveLength(2);
    expect(plan.tiers).toHaveLength(2);

    const dst = await newWorkspace("Restored Co");
    const result = await as(users.owner!, async (c) => (await c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, 'backup.json') as r", [dst, JSON.stringify(plan)])).rows[0].r as { counts: Record<string, number>; settings: string });
    expect(result.counts).toMatchObject({ departments: 2, tiers: 2, person_tiers: 2, person_portfolio: 1, roles: 1, people: 1, clients: 1 });

    // The new workspace's own two departments were replaced by the backup's, not added to.
    expect((await q("select name from departments where workspace_id = $1 order by sort", [dst])).map((r) => r.name)).toEqual(["SEO", "Performance"]);
    expect(await q("select key, name, sort, both_count from tiers where workspace_id = $1 order by sort", [dst])).toEqual([
      { key: "T1", name: "Tier 1", sort: 1, both_count: 0 },
      { key: "T2", name: "Tier 2", sort: 2, both_count: 5 },
    ]);
    const orgDst = await departmentOf(dst, "SEO");
    const t2Dst = (await q("select id from tiers where workspace_id = $1 and key = 'T2'", [dst]))[0]!.id as string;
    expect(
      (await q("select name, words::float8 as words, links::float8 as links, tech_hours::float8 as tech, meetings::float8 as meetings, adhoc_chance::float8 as chance, adhoc_requests::float8 as requests, price::float8 as price, price_rise_churn::float8 as rise, provenance from services where department_id = $1 and tier_id = $2", [orgDst, t2Dst]))[0],
    ).toMatchObject({ name: "SEO Tier 2", words: 1500, links: 5, tech: 5, meetings: 1, chance: 0.7, requests: 4, price: 4500, rise: 0.75 });
    expect((await q("select channels::float8 as channels, builds::float8 as builds, creative_sets::float8 as sets from services where department_id = $1 and tier_id = $2", [await departmentOf(dst, "Performance"), t2Dst]))[0]).toEqual({ channels: 1.5, builds: 3, sets: 1 });
    expect((await q("select provenance from services where department_id = $1 and tier_id = $2", [orgDst, t2Dst]))[0]!.provenance).toMatchObject({ words: { source: "entered" } });
    expect(await q("select name, kind, line::float8 as line, rule_of_thumb, unit, department_id from roles where workspace_id = $1", [dst])).toEqual([{ name: "SEO Manager", kind: "client_facing", line: 0.8, rule_of_thumb: 10, unit: "tasks", department_id: orgDst }]);
    expect(await q("select name, reserved_share::float8 as share, salary_monthly::float8 as salary, label, ramp from people where workspace_id = $1", [dst])).toEqual([{ name: "Karl", share: 0.2, salary: 10000, label: "offshore", ramp: [0.5, 0.75] }]);
    expect((await q("select count(*)::int as n from person_tiers where workspace_id = $1", [dst]))[0]!.n).toBe(2);
    expect((await q("select client_count from person_portfolio where workspace_id = $1", [dst]))[0]!.client_count).toBe(6);
    expect(
      (await q("select channels::float8 as channels, hand_holding_hours::float8 as hand, adhoc_chance::float8 as chance, adhoc_requests::float8 as requests, adhoc_hours::float8 as hours, meetings::float8 as meetings, words::float8 as words, links::float8 as links, tech_hours::float8 as tech, builds::float8 as builds, creative_sets::float8 as sets, step_factor::float8 as factor from clients where workspace_id = $1", [dst]))[0],
    ).toEqual({ channels: 6, hand: 3, chance: 1, requests: 8, hours: 0.75, meetings: 4, words: 100, links: 2, tech: 3, builds: 4, sets: 5, factor: 1.5 });
    expect((await q("select settings from workspaces where id = $1", [dst]))[0]!.settings).toMatchObject({ ramp_default: [0.4, 0.6, 0.8], dler_includes_leadership: false });

    // A second export of the restored workspace holds the same new-table rows as the first, apart from ids.
    const again = await exportOf(dst);
    const strip = (rows: Row[]) => rows.map(({ id: _i, workspace_id: _w, created_at: _c, updated_at: _u, person_id: _p, tier_id: _t, service_id: _s, department_id: _d, provenance: _pr, ...rest }) => rest);
    for (const k of ["departments", "tiers", "person_tiers", "person_portfolio"]) expect(strip(again.company_model[k]!), k).toEqual(strip(bundle.company_model[k]!));
  });

  it("a backup made before the Set up tables restores into a new workspace that keeps its two departments", async () => {
    const src = await newWorkspace("Old backup source");
    const bundle = await exportOf(src);
    for (const k of ["departments", "tiers", "person_tiers", "person_portfolio"]) delete bundle.company_model[k];
    const { plan } = planWorkspaceImport(bundle, { canManage: true });
    const older = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    for (const k of ["departments", "tiers", "person_tiers", "person_portfolio"]) delete older[k];
    const dst = await newWorkspace("Old backup target");
    await as(users.owner!, (c) => c.query("select public.import_workspace_bundle($1::uuid, $2::jsonb, null)", [dst, JSON.stringify(older)]));
    expect((await q("select name from departments where workspace_id = $1 order by sort", [dst])).map((r) => r.name)).toEqual(["Organic (SEO)", "Performance"]);
  });
});

describe("rollback", () => {
  it("the rollback in the migration's header runs, and removes everything it added", async () => {
    const own = await createTestDb();
    try {
      await own.client.query(headerRollback("20270119000000_capacity_setup.sql"));
      // Everything the migration added is gone ...
      const left = await own.client.query(
        `select (select count(*)::int from information_schema.tables where table_schema = 'public' and table_name in ('departments', 'tiers', 'person_tiers', 'person_portfolio')) as tables,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and ((table_name = 'people' and column_name in ('reserved_share', 'salary_monthly', 'label', 'ramp'))
                  or (table_name = 'services' and column_name in ('tier_id', 'words', 'price_rise_churn')) or (table_name = 'roles' and column_name in ('kind', 'line', 'unit')))) as columns,
                (select count(*)::int from pg_proc where proname in ('add_tier', 'remove_tier', 'stamp_entered')) as functions`,
      );
      expect(left.rows[0]).toEqual({ tables: 0, columns: 0, functions: 0 });
      // ... a new workspace can still be made, and the old data is intact.
      await own.client.query("insert into workspaces (name, slug) values ('After', 'after-rollback')");
      expect((await own.client.query("select count(*)::int as n from workspaces")).rows[0].n).toBeGreaterThan(2);
    } finally {
      await own.close();
    }
  }, 60_000);
});
