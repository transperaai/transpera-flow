import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatches, isBlocking, parsePatches, simulate, type ScenarioPatch } from "@transpera-flow/engine";
import { NORTHBEAM_WORKSPACE_ID, northbeamBundle, northbeamScenarios, northbeamStepIds, toEngineModel } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Scenarios table (issue #15): shape check, library seeding, row-level security.

let db: TestDb;
let other: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const START = { startDate: "2026-10-05" };

beforeAll(async () => {
  db = await createTestDb();
  other = (await db.client.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
  users.admin = await createUser(db, "admin@agency.example", { agency_admin: true });
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@northbeam.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [NORTHBEAM_WORKSPACE_ID, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@example.com");
});

afterAll(async () => {
  await db?.close();
});

const names = async (c: pg.Client, ws: string) =>
  (await c.query("select name from scenarios where workspace_id = $1 order by name", [ws])).rows.map((r) => r.name as string);

describe("scenario library", () => {
  it("the seed gives Northbeam its four scenarios (hire, automate a step, more leads, downturn)", async () => {
    const rows = (await db.client.query("select id, name, patch from scenarios where workspace_id = $1 order by id", [NORTHBEAM_WORKSPACE_ID])).rows;
    expect(rows.map((r) => r.name)).toEqual(["Hire a strategist", "Automate proposals", "More leads", "Downturn"]);
    expect(rows.map((r) => r.patch)).toEqual(northbeamScenarios().map((s) => s.patch));
    // Each applies cleanly to Northbeam's model.
    const model = toEngineModel(northbeamBundle(), START);
    for (const r of rows) expect(applyPatches(model, r.patch).issues, r.name).toEqual([]);
  });

  it("a new workspace gets the four library scenarios, which parse and apply to any model", async () => {
    const rows = (await db.client.query("select name, patch, created_by from scenarios where workspace_id = $1 order by name", [other])).rows;
    expect(rows.map((r) => r.name)).toEqual(["Automate the heaviest step", "Downturn", "Hire into the busiest role", "More leads"]);
    const model = toEngineModel(northbeamBundle(), START);
    for (const r of rows) {
      const parsed = parsePatches(r.patch);
      expect(parsed.ok, r.name).toBe(true);
      expect(applyPatches(model, r.patch).issues.filter(isBlocking), r.name).toEqual([]);
    }
  });

  it("seeds the library when an agency admin creates a workspace through the API (RLS on)", async () => {
    const seeded = await db.as(users.admin!.claims, async (c) => {
      const ws = (await c.query("insert into workspaces (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
      return (await c.query("select name, created_by from scenarios where workspace_id = $1", [ws])).rows;
    });
    expect(seeded).toHaveLength(4);
    expect(seeded.every((r) => r.created_by === users.admin!.id)).toBe(true);
  });
});

describe("patch shape", () => {
  const healthPatches: ScenarioPatch[] = [
    { path: "health.initial", op: "set", value: 70 },
    { path: "health.recover", op: "multiply", value: 1.25 },
    { path: "health.late_penalty", op: "add", value: 1 },
    { path: "health.missed_penalty", op: "multiply", value: 0.75 },
    { path: "services.s1.churn_health_sensitivity", op: "multiply", value: 1.25 },
  ];
  const cases: unknown[] = [
    [],
    [{ path: "steps.e1.work_hours", op: "multiply", value: 0.5 }],
    [{ path: "roles.@busiest.headcount", op: "add", value: 1 }],
    [{ path: "steps.@heaviest.rework_rate", op: "set", value: 0 }],
    [{ path: "people.p-1.fte", op: "set", value: 0.8 }, { path: "finances.retainer", op: "add", value: 100 }],
    [{ path: "services.s1.mix_share", op: "set", value: 2 }, { path: "demand.churn_monthly", op: "set", value: 0.1 }],
    {},
    "x",
    [1],
    [{ path: "steps.e1.work_hours", op: "multiply" }],
    [{ path: "steps.e1.work_hours", op: "multiply", value: "0.5" }],
    [{ path: "steps.e1.work_hours", op: "multiply", value: 0.5, note: "x" }],
    [{ path: "steps.e1.colour", op: "set", value: 1 }],
    [{ path: "steps.e1.work_hours", op: "divide", value: 2 }],
    [{ path: "steps.@busiest.work_hours", op: "set", value: 1 }],
    [{ path: "roles.@anything.headcount", op: "set", value: 1 }],
    [{ path: "steps.a b.work_hours", op: "set", value: 1 }],
    [{ path: "demand.retainer", op: "set", value: 1 }],
    [{ path: 3, op: "set", value: 1 }],
    Array.from({ length: 201 }, () => ({ path: "demand.leads_per_week", op: "add", value: 0 })),
    // Client health and churn (issue #79).
    ...healthPatches.map((p) => [p]),
    healthPatches,
    [{ path: "health.missed_threshold", op: "set", value: 2 }],
    [{ path: "health.recover.x", op: "set", value: 1 }],
    // Overheads (sandbox phase 2): accepted in both; any other finances path still refused in both.
    [{ path: "finances.overhead_monthly", op: "multiply", value: 1.2 }],
    [{ path: "finances.overhead_monthly", op: "set", value: 0 }, { path: "finances.retainer", op: "add", value: 100 }],
    [{ path: "finances.margin", op: "set", value: 0.4 }],
    [{ path: "finances.overhead", op: "set", value: 1 }],
    [{ path: "finances.overhead_monthly.x", op: "set", value: 1 }],
    [{ path: "health.s1.recover", op: "set", value: 1 }],
    [{ path: "health", op: "set", value: 1 }],
    [{ path: "health.@busiest", op: "set", value: 1 }],
    [{ path: "health.health_recover", op: "set", value: 1 }],
    [{ path: "services.s1.churn_sensitivity", op: "set", value: 1 }],
    [{ path: "services.@busiest.churn_health_sensitivity", op: "set", value: 1 }],
    [{ path: "roles.r1.churn_health_sensitivity", op: "set", value: 1 }],
    [{ path: "services.churn_health_sensitivity", op: "set", value: 1 }],
  ];

  it("accepts the health-rule and churn-sensitivity paths, in the engine and the database", async () => {
    expect(parsePatches(healthPatches).ok).toBe(true);
    const { rows } = await db.client.query("select private.is_scenario_patch($1::jsonb) as ok", [JSON.stringify(healthPatches)]);
    expect(rows[0].ok).toBe(true);
    const saved = await db.as(users.editor!.claims, (c) =>
      c.query("insert into scenarios (workspace_id, name, patch) values ($1, 'Health', $2) returning patch", [NORTHBEAM_WORKSPACE_ID, JSON.stringify(healthPatches)]),
    );
    expect(saved.rows[0].patch).toEqual(healthPatches);
  });

  it("the database accepts exactly what the engine's parsePatches accepts", async () => {
    for (const patch of cases) {
      const { rows } = await db.client.query("select private.is_scenario_patch($1::jsonb) as ok", [JSON.stringify(patch)]);
      expect(rows[0].ok, JSON.stringify(patch).slice(0, 80)).toBe(parsePatches(patch).ok);
    }
  });

  it("accepts finances.overhead_monthly and still refuses finances.margin", async () => {
    const ok = (patch: unknown) => db.client.query("select private.is_scenario_patch($1::jsonb) as ok", [JSON.stringify(patch)]).then((r) => r.rows[0].ok as boolean);
    expect(await ok([{ path: "finances.overhead_monthly", op: "multiply", value: 1.1 }])).toBe(true);
    expect(await ok([{ path: "finances.retainer", op: "set", value: 4000 }])).toBe(true);
    expect(await ok([{ path: "finances.margin", op: "set", value: 0.4 }])).toBe(false);
  });

  it("rejects a malformed patch on insert and update", async () => {
    const bad = JSON.stringify([{ path: "steps.x.colour", op: "set", value: 1 }]);
    await expect(db.as(users.editor!.claims, (c) => c.query("insert into scenarios (workspace_id, name, patch) values ($1, 'Bad', $2)", [NORTHBEAM_WORKSPACE_ID, bad]))).rejects.toThrow(/scenarios_patch_shape/);
    await expect(
      db.as(users.editor!.claims, (c) => c.query("update scenarios set patch = $2 where workspace_id = $1", [NORTHBEAM_WORKSPACE_ID, bad])),
    ).rejects.toThrow(/scenarios_patch_shape/);
    await expect(db.as(users.editor!.claims, (c) => c.query("insert into scenarios (workspace_id, name) values ($1, '  ')", [NORTHBEAM_WORKSPACE_ID]))).rejects.toThrow(/scenarios_name_length/);
  });
});

describe("row-level security", () => {
  const insert = (c: pg.Client, ws: string) =>
    c.query("insert into scenarios (workspace_id, name, patch) values ($1, 'Mine', $2) returning id, created_by", [
      ws,
      JSON.stringify([{ path: "demand.leads_per_week", op: "add", value: 1 }]),
    ]);

  it("every member of the workspace can read its scenarios; strangers see none", async () => {
    for (const role of ["admin", "owner", "editor", "member", "viewer"]) {
      expect(await db.as(users[role]!.claims, (c) => names(c, NORTHBEAM_WORKSPACE_ID)), role).toHaveLength(4);
    }
    expect(await db.as(users.stranger!.claims, (c) => c.query("select count(*) from scenarios").then((r) => Number(r.rows[0].count)))).toBe(0);
    // A Northbeam member sees nothing of another workspace's library.
    expect(await db.as(users.editor!.claims, (c) => names(c, other))).toEqual([]);
  });

  it("editors, owners and agency admins can save, change and delete; members and viewers can't", async () => {
    for (const role of ["admin", "owner", "editor"]) {
      const saved = await db.as(users[role]!.claims, async (c) => {
        const row = (await insert(c, NORTHBEAM_WORKSPACE_ID)).rows[0];
        const renamed = (await c.query("update scenarios set name = 'Renamed' where id = $1 returning id", [row.id])).rowCount;
        const deleted = (await c.query("delete from scenarios where id = $1", [row.id])).rowCount;
        return { createdBy: row.created_by, renamed, deleted };
      });
      expect(saved, role).toEqual({ createdBy: users[role]!.id, renamed: 1, deleted: 1 });
    }
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => insert(c, NORTHBEAM_WORKSPACE_ID)), role).rejects.toThrow(/row-level security/);
      const changed = await db.as(users[role]!.claims, async (c) => ({
        updated: (await c.query("update scenarios set name = 'Hacked' where workspace_id = $1", [NORTHBEAM_WORKSPACE_ID])).rowCount,
        deleted: (await c.query("delete from scenarios where workspace_id = $1", [NORTHBEAM_WORKSPACE_ID])).rowCount,
      }));
      expect(changed, role).toEqual({ updated: 0, deleted: 0 });
    }
  });

  it("an editor of one workspace can't write into another, or move a scenario there", async () => {
    await expect(db.as(users.editor!.claims, (c) => insert(c, other))).rejects.toThrow(/row-level security/);
    await expect(
      db.as(users.editor!.claims, (c) => c.query("update scenarios set workspace_id = $1 where workspace_id = $2", [other, NORTHBEAM_WORKSPACE_ID])),
    ).rejects.toThrow(/row-level security/);
  });

  it("a duplicate's parent must be in the same workspace", async () => {
    const [foreign] = (await db.client.query("select id from scenarios where workspace_id = $1 limit 1", [other])).rows;
    const [own] = (await db.client.query("select id from scenarios where workspace_id = $1 limit 1", [NORTHBEAM_WORKSPACE_ID])).rows;
    const dup = (parent: string) => (c: pg.Client) =>
      c.query("insert into scenarios (workspace_id, name, parent_scenario_id) values ($1, 'Copy', $2)", [NORTHBEAM_WORKSPACE_ID, parent]);
    await expect(db.as(users.editor!.claims, dup(own.id))).resolves.toBeTruthy();
    await expect(db.as(users.editor!.claims, dup(foreign.id))).rejects.toThrow(/foreign key/);
  });

  it("gives the anon role no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from scenarios")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("keeps updated_at current", async () => {
    const { id } = (
      await db.client.query("insert into scenarios (workspace_id, name) values ($1, 'Timed') returning id", [NORTHBEAM_WORKSPACE_ID])
    ).rows[0];
    // Compared in SQL: the two timestamps can fall in the same millisecond, and
    // a JS Date drops the microseconds.
    const { later } = (
      await db.client.query("update scenarios set description = 'x' where id = $1 returning updated_at > created_at as later", [id])
    ).rows[0];
    await db.client.query("delete from scenarios where id = $1", [id]);
    expect(later).toBe(true);
  });
});

describe("a multiply patch survives re-measurement", () => {
  it("re-measuring the step in the stored process changes the scenario's value and result proportionally", () => {
    const automate = northbeamScenarios().find((s) => s.name === "Automate proposals")!.patch as ScenarioPatch[];
    const at = (hours: number) => {
      const bundle = northbeamBundle();
      bundle.steps.find((s) => s.id === northbeamStepIds.audit)!.work_hours = hours;
      return toEngineModel(bundle, START);
    };
    const auditWork = (hours: number) => applyPatches(at(hours), automate).model.steps.find((s) => s.id === northbeamStepIds.audit)!.work;
    expect(auditWork(6)).toBeCloseTo(2.4);
    expect(auditWork(8)).toBeCloseTo(3.2);
    // The scenario on the re-measured baseline is exactly the model with 0.4 × 8 h.
    expect(simulate(applyPatches(at(8), automate).model, 4, 2)).toEqual(simulate(at(3.2), 4, 2));
  });
});
