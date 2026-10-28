import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamRoleIds, type Db } from "@transpera-flow/db";
import type { Claims } from "@transpera-flow/db/client";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// The lib functions that go through the shared loaders in packages/db (processes, settings, suggestions, calibration),
// run against a throwaway Postgres as real users. Only the session is faked.

const session = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({
  getDb: async () => session.db,
  getSessionUser: async () => session.user,
}));

const data = await import("@/lib/data");
const companyData = await import("@/lib/company-data");
const { loadHistory } = await import("@/lib/history/data");
const { loadProcessCard, loadProcessesAndArchived, loadProcessesPage } = await import("@/lib/processes/data");
const { loadLibrary } = await import("@/lib/editor/library-data");
const { loadCalibrationPage } = await import("@/lib/calibration/data");
const { loadClientCalibration } = await import("@/lib/calibration/client-data");
const { loadWorkspaceLeverSettings } = await import("@/lib/levers/data");
const { loadProcessFirstPrinciples } = await import("@/lib/first-principles/data");
const { loadLiveCompany, loadLiveParts } = await import("@/lib/overview/data");

let tdb: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;
const users: Record<string, { id: string; email: string; claims: Claims }> = {};
let current: Db;
let processId: string;

function actAs(role: string) {
  const u = users[role]!;
  current = tdb.dbAs(u.claims);
  session.db = current;
  session.user = { id: u.id, email: u.email, agencyAdmin: false, name: null };
}

beforeAll(async () => {
  tdb = await createTestDb();
  for (const role of ["owner", "editor", "viewer", "stranger"] as const) {
    const email = `${role}@loaders.example.com`;
    const u = await createUser(tdb, email);
    // The sign-in list names them too (the members list only shows people it still lets in). The rule makes their membership at
    // once (20270105000000); the insert below states it anyway.
    if (role !== "stranger") await tdb.client.query("insert into deployment_access (kind, value, role) values ('email', $1, $2)", [email, role === "editor" || role === "owner" ? "agency_admin" : "viewer"]);
    if (role !== "stranger") await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role) on conflict (workspace_id, user_id) do update set role = excluded.role", [ws, u.id, role]);
    users[role] = { id: u.id, email, claims: { sub: u.id, role: "authenticated", email } };
  }
  processId = (await tdb.client.query("select id from processes where workspace_id = $1 and live_revision_id is not null and not is_company order by created_at, id limit 1", [ws])).rows[0].id as string;
});

afterAll(async () => {
  await tdb?.close();
});

describe("workspace settings", () => {
  it("loads everything the settings page edits, with the rights of the reader", async () => {
    actAs("owner");
    const s = await data.loadWorkspaceSettings("northbeam");
    expect(s).not.toBeNull();
    expect(s!.canEdit).toBe(true);
    expect(s!.canManage).toBe(true);
    expect(s!.roles.map((r) => r.id)).toContain(northbeamRoleIds.sales);
    expect(s!.people.length).toBeGreaterThan(0);
    expect(s!.services.length).toBeGreaterThan(0);
    expect(s!.leadSources.length).toBeGreaterThan(0);
    expect(Array.isArray(s!.seasonality)).toBe(true);
    expect(s!.demand === null || typeof s!.demand === "object").toBe(true);
    expect(s!.processes.length).toBeGreaterThan(0);
    expect(Array.isArray(s!.conditionTags)).toBe(true);
    expect(Array.isArray(s!.personCapacityFactors)).toBe(true);
    expect(s!.roleUsage[northbeamRoleIds.sales]).toBeDefined();
    actAs("viewer");
    const v = await data.loadWorkspaceSettings("northbeam");
    expect(v!.canEdit).toBe(false);
    actAs("stranger");
    expect(await data.loadWorkspaceSettings("northbeam")).toBeNull();
  });

  it("loads the sources page, the overview of a workspace and the company map id", async () => {
    actAs("viewer");
    const sources = await data.loadSourcesPage("northbeam");
    expect(sources!.workspace.slug).toBe("northbeam");
    expect(sources!.totalAll).toBeGreaterThan(0);
    const overview = await data.loadWorkspaceOverview("northbeam");
    expect(overview!.processes.length).toBeGreaterThan(0);
    expect(await data.loadPublishState("northbeam")).toMatchObject({ published: true });
    expect(await data.loadWorkspaceOverview("nope")).toBeNull();
    expect(typeof (await data.loadCompanyId(ws))).toBe("string");
    expect(await data.loadWorkspaceSolutions(ws)).toHaveProperty("solutions");
    expect(await data.loadWorkspaceSandboxScenarios(ws)).toEqual(expect.any(Array));
  });

  it("finds an earlier version of a process, or null for the live one", async () => {
    actAs("viewer");
    const live = (await data.loadProcessForEditing("northbeam", processId))!.live;
    expect(await data.loadProcessVersion(live, live.revision.number)).toBeNull();
    expect(await data.loadProcessVersion(live, 9999)).toBeNull();
  });
});

describe("change log page", () => {
  it("shows the log and the people behind it to owners only", async () => {
    actAs("owner");
    const page = await companyData.loadChangeLogPage("northbeam");
    expect(page!.workspace.slug).toBe("northbeam");
    expect(Array.isArray(page!.changes)).toBe(true);
    expect(page!.people[users.owner!.id]).toBe("owner@loaders.example.com");
    actAs("viewer");
    const v = await companyData.loadChangeLogPage("northbeam");
    expect(v!.changes).toBeNull();
    actAs("stranger");
    expect(await companyData.loadChangeLogPage("northbeam")).toBeNull();
  });
});

describe("process pages", () => {
  it("builds the history of a process", async () => {
    actAs("viewer");
    const h = await loadHistory("northbeam", processId);
    expect(h!.process.id).toBe(processId);
    expect(h!.versions.length).toBeGreaterThan(0);
    expect(h!.versions[0]).toHaveProperty("revisionId");
    expect(await loadHistory("northbeam", randomUUID())).toBeNull();
  });

  it("lists processes with their numbers, and one process's card", async () => {
    actAs("viewer");
    const { rows, archived } = await loadProcessesAndArchived(ws);
    expect(rows.length).toBeGreaterThan(0);
    expect(archived).toEqual([]);
    expect((await loadProcessesPage(ws)).length).toBe(rows.length);
    const card = await loadProcessCard("northbeam", processId);
    expect(card === null || card.bundle.process.id === processId).toBe(true);
  });

  it("lists the process library for an editor", async () => {
    actAs("editor");
    const lib = await loadLibrary(ws);
    expect(lib.processes.length).toBeGreaterThan(0);
    expect(lib.templates.length).toBeGreaterThan(0);
  });

  it("loads the company map and the live parts", async () => {
    actAs("viewer");
    expect(Array.isArray(await loadLiveParts(ws))).toBe(true);
    const map = await loadLiveCompany(ws);
    expect(map === null || typeof map === "object").toBe(true);
  });
});

describe("calibration pages", () => {
  it("loads the calibration page of a process and the client calibration", async () => {
    actAs("editor");
    const page = await loadCalibrationPage("northbeam", processId);
    expect(page!.process.id).toBe(processId);
    expect(page!.history).toEqual([]);
    const clients = await loadClientCalibration("northbeam");
    expect(clients!.workspaceId).toBe(ws);
    expect(clients!.history).toEqual([]);
    expect(clients!.runs.length).toBeGreaterThan(0);
  });
});

describe("settings loaders that fall back", () => {
  it("reads the AI, lever and first-principles settings", async () => {
    actAs("viewer");
    expect(await loadWorkspaceLeverSettings(ws)).toHaveProperty("hidden");
    const fp = await loadProcessFirstPrinciples(processId, [randomUUID()]);
    expect(Object.values(fp)[0]).toMatchObject({ doc: null });
  });
});
