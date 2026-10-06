import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  LARKSPUR_PROCESS_ID,
  LARKSPUR_WORKSPACE_ID,
  larkspurBundle,
  northbeamAccess,
  northbeamBundle,
  northbeamIssues,
  northbeamScenarios,
  northbeamSources,
  northbeamSourceLinks,
  northbeamStepIds,
  seedSql,
  toEngineModel,
  type ProcessBundle,
} from "../src";
import { bootstrapSql } from "../src/bootstrap";
import { createTestDb, createUser, type TestDb } from "./harness";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/** A seeded workspace's pipeline bundle, as the database returns it. */
async function loadSeeded(claims: Record<string, unknown>, wsId: string): Promise<ProcessBundle> {
  return db.as(claims, async (c) => {
    const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0];
    const many = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows;
    const workspace = await one("select id, name, slug, settings from workspaces where id = $1", [wsId]);
    const process = await one("select * from processes where workspace_id = $1 and kind = 'pipeline' and not is_company", [wsId]);
    // Its servicing processes at their live revisions (issue #19).
    const servicing = await many("select * from processes where workspace_id = $1 and kind = 'servicing' order by id", [wsId]);
    const otherProcesses = [];
    for (const p of servicing) {
      otherProcesses.push({
        process: p,
        revision: await one("select * from process_revisions where id = $1", [p.live_revision_id]),
        steps: await many("select * from steps where revision_id = $1", [p.live_revision_id]),
        edges: await many("select * from edges where revision_id = $1", [p.live_revision_id]),
      });
    }
    return {
      workspace,
      process,
      revision: await one("select * from process_revisions where id = $1", [process.live_revision_id]),
      roles: await many("select * from roles where workspace_id = $1", [wsId]),
      steps: await many("select * from steps where revision_id = $1", [process.live_revision_id]),
      edges: await many("select * from edges where revision_id = $1", [process.live_revision_id]),
      people: await many("select * from people where workspace_id = $1", [wsId]),
      personRoles: await many("select * from person_roles where workspace_id = $1", [wsId]),
      personSkills: await many("select * from person_skills where workspace_id = $1", [wsId]),
      personLeave: await many(
        "select id, person_id, workspace_id, start_date::text, end_date::text from person_leave where workspace_id = $1",
        [wsId],
      ),
      services: await many("select * from services where workspace_id = $1", [wsId]),
      leadSources: await many("select * from lead_sources where workspace_id = $1", [wsId]),
      seasonality: await many("select * from seasonality where workspace_id = $1", [wsId]),
      demand: (await one("select * from demand_settings where workspace_id = $1", [wsId])) ?? null,
      clients: await many(
        "select id, workspace_id, name, start_date::text, mrr, health, provenance, notes, active from clients where workspace_id = $1",
        [wsId],
      ),
      clientServices: await many("select * from client_services where workspace_id = $1", [wsId]),
      clientAssignments: await many("select * from client_assignments where workspace_id = $1", [wsId]),
      clientGroups: await many("select id, workspace_id, service_id, client_count, fee, churn_monthly, stay_months, starting_health, provenance from client_groups where workspace_id = $1", [wsId]),
      servicingLinks: await many("select * from service_servicing where workspace_id = $1", [wsId]),
      otherProcesses,
    } as ProcessBundle;
  });
}

describe("seed", () => {
  it("bootstrap.sql is up to date with the migrations and seed", () => {
    const dir = new URL("../supabase/", import.meta.url);
    expect(readFileSync(new URL("bootstrap.sql", dir), "utf8")).toBe(bootstrapSql(dir));
  });

  it("seed.sql is up to date with the fixtures", () => {
    const onDisk = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
    expect(onDisk).toBe(seedSql([northbeamBundle(), larkspurBundle()], [northbeamAccess()], northbeamScenarios(), northbeamIssues(), northbeamSources(), northbeamSourceLinks()));
  });

  it("round-trips: rows loaded from the database resolve to the same engine model", async () => {
    const admin = await createUser(db, "admin@example.com", { agency_admin: true });
    const bundle = await loadSeeded(admin.claims, NORTHBEAM_WORKSPACE_ID);
    expect(bundle.process.live_revision_id).toBe(NORTHBEAM_REVISION_ID);
    expect(bundle.services).toHaveLength(2);
    expect(bundle.leadSources).toHaveLength(3);
    expect(bundle.leadSources!.map((s) => s.provenance)).toEqual(northbeamBundle().leadSources!.map((s) => s.provenance));
    expect(bundle.demand).toMatchObject({ provenance: northbeamBundle().demand!.provenance });
    // Churn sensitivity is seeded as the PRD's estimate, so robustness perturbs it; the rest is stamped entered (issue #79).
    for (const s of bundle.services) {
      expect(s.provenance).toMatchObject({ churn_health_sensitivity: { source: "estimated" }, price: { source: "entered" } });
    }
    const opts = { startDate: "2026-10-05" };
    expect(toEngineModel(bundle, opts)).toEqual(toEngineModel(northbeamBundle(), opts));
  });

  it("round-trips through team_capacity: an admin's bundle built from it resolves to the same engine model (B1 2a)", async () => {
    const admin = await createUser(db, "admin-team@example.com", { agency_admin: true });
    const opts = { startDate: "2026-10-05" };
    for (const [wsId, expected] of [
      [NORTHBEAM_WORKSPACE_ID, northbeamBundle()],
      [LARKSPUR_WORKSPACE_ID, larkspurBundle()],
    ] as const) {
      const bundle = await loadSeeded(admin.claims, wsId);
      const t = (await db.as(admin.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [wsId])).rows[0].t)) as Record<string, never>;
      expect(t.sees_everyone).toBe(true);
      const fromTeam = {
        ...bundle,
        people: t.people,
        personRoles: t.person_roles,
        personSkills: t.person_skills,
        personLeave: t.person_leave,
        clientAssignments: t.client_assignments,
      } as unknown as ProcessBundle;
      expect(toEngineModel(fromTeam, opts)).toEqual(toEngineModel(expected, opts));
    }
  });

  it("loads Larkspur Creative, the second golden agency, which round-trips to the same engine model (issue #22)", async () => {
    const admin = await createUser(db, "admin-larkspur@example.com", { agency_admin: true });
    const bundle = await loadSeeded(admin.claims, LARKSPUR_WORKSPACE_ID);
    expect(bundle.process.id).toBe(LARKSPUR_PROCESS_ID);
    expect(bundle.workspace.slug).toBe("larkspur");
    expect(bundle.clients).toHaveLength(18);
    expect(bundle.personLeave).toHaveLength(2);
    expect(bundle.otherProcesses).toHaveLength(2);
    const opts = { startDate: "2026-10-05" };
    expect(toEngineModel(bundle, opts)).toEqual(toEngineModel(larkspurBundle(), opts));
  });
});

describe("row-level security", () => {
  const countVisible = async (c: import("pg").Client) => {
    const counts: Record<string, number> = {};
    for (const t of ["workspaces", "roles", "processes", "process_revisions", "steps", "edges", "people", "person_roles"]) {
      counts[t] = Number((await c.query(`select count(*) from ${t}`)).rows[0].count);
    }
    return counts;
  };

  it("lets an agency admin see every workspace", async () => {
    const admin = await createUser(db, "agency@example.com", { agency_admin: true });
    const visible = await db.as(admin.claims, countVisible);
    // Northbeam and Larkspur (issue #22), each a pipeline and two servicing processes (issue #19) and a company map holding the three (B11): a holder each, and a handoff line from the pipeline to each servicing process.
    expect(visible).toMatchObject({ workspaces: 2, roles: 13, processes: 8, steps: 52, edges: 51, people: 21, person_roles: 22 });
  });

  it("lets a member with an agency_admin membership see the workspace", async () => {
    const user = await createUser(db, "member-admin@example.com");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'agency_admin')", [
      NORTHBEAM_WORKSPACE_ID,
      user.id,
    ]);
    expect(await db.as(user.claims, countVisible)).toMatchObject({ workspaces: 1, steps: 25 });
  });

  it("hides everything from a signed-in user with no membership", async () => {
    const stranger = await createUser(db, "stranger@example.com");
    expect(await db.as(stranger.claims, countVisible)).toEqual({
      workspaces: 0,
      roles: 0,
      processes: 0,
      process_revisions: 0,
      steps: 0,
      edges: 0,
      people: 0,
      person_roles: 0,
    });
  });

  it("does not trust an agency_admin flag outside app_metadata", async () => {
    const sneaky = await createUser(db, "sneaky@example.com");
    const claims = { ...sneaky.claims, user_metadata: { agency_admin: true }, agency_admin: true };
    expect((await db.as(claims, countVisible)).workspaces).toBe(0);
  });

  it("gives the anon role no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from workspaces")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("lets editors change steps but not viewers", async () => {
    const editor = await createUser(db, "editor@example.com");
    const viewer = await createUser(db, "viewer@example.com");
    await db.client.query(
      "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')",
      [NORTHBEAM_WORKSPACE_ID, editor.id, viewer.id],
    );
    // Edits go into the process's draft (issue #9); the viewer can't open one, nor write to the editor's.
    const bump = async (c: import("pg").Client) => {
      await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
      return c
        .query("update steps set work_hours = 7 where id = $1 and revision_id <> $2 returning id", [northbeamStepIds.audit, NORTHBEAM_REVISION_ID])
        .then((r) => r.rowCount);
    };
    expect(await db.as(editor.claims, bump)).toBe(1);
    expect(await db.as(viewer.claims, bump)).toBe(0);
    const viewerOnEditorsDraft = async (c: import("pg").Client) => {
      await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(viewer.claims)]);
      return c.query("update steps set work_hours = 7 where id = $1 returning id", [northbeamStepIds.audit]).then((r) => r.rowCount);
    };
    expect(await db.as(editor.claims, viewerOnEditorsDraft)).toBe(0);
  });

  it("stops non-admins creating workspaces", async () => {
    const owner = await createUser(db, "owner@example.com");
    await expect(
      db.as(owner.claims, (c) => c.query("insert into workspaces (name, slug) values ('X', 'x')")),
    ).rejects.toThrow(/row-level security/);
  });

  it("stops an editor of one workspace from writing into another", async () => {
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other') returning id"))
      .rows[0].id as string;
    const editor = await createUser(db, "editor2@example.com");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [
      NORTHBEAM_WORKSPACE_ID,
      editor.id,
    ]);
    await expect(
      db.as(editor.claims, (c) => c.query("insert into roles (workspace_id, name) values ($1, 'Intruder')", [other])),
    ).rejects.toThrow(/row-level security/);
  });
});
