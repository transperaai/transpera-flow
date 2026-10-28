import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamRoleIds, type Db } from "@transpera-flow/db";
import type { Claims } from "@transpera-flow/db/client";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// The lib functions that read and write through `getDb()`, run against a throwaway Postgres as real users, so row-level
// security applies. Only the session is faked: `getDb()` gives a `Db` for the chosen claims and `getSessionUser()` the user.

const session = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({
  getDb: async () => session.db,
  getSessionUser: async () => session.user,
}));

const { canEditWorkspace, canManageWorkspace, currentUserId, isAgencyAdmin, loadAccessSettings, resolveMyAccess } = await import("@/lib/access-data");
const { listAgencyWorkspaces, listWorkspaces, loadMemberNames, loadWorkspaceHead } = await import("@/lib/data");
const { shellCounts } = await import("@/lib/company-data");
const { saveCapacityFactor, saveCapacityFactorSwitch, saveField, saveFields, saveHealthRule, saveLinks } = await import("@/lib/fields/server");
const { cachedNarration, findNarration } = await import("@/lib/narration/service");
const { explainRun } = await import("@/lib/narration/explain");
const { loadShareLinks } = await import("@/lib/share/list");
const { workspaceIsEmpty } = await import("@/lib/restore/empty");
const { loadImports, loadLeadSourceOptions } = await import("@/lib/calibration/import-data");
const { loadLatestChecks } = await import("@/lib/calibration/client-data");
const { loadLastChange } = await import("@/lib/process-page/data");

let tdb: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;
const users: Record<string, { id: string; email: string; claims: Claims }> = {};
let current: Db;

/** Act as `role` from now on. */
function actAs(role: string | null) {
  if (!role) {
    current = tdb.dbAs(null);
    session.db = current;
    session.user = null;
    return;
  }
  const u = users[role]!;
  current = tdb.dbAs(u.claims);
  session.db = current;
  session.user = { id: u.id, email: u.email, agencyAdmin: Boolean(u.claims.app_metadata?.agency_admin), name: null };
}

beforeAll(async () => {
  tdb = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    const email = `${role}@lib.example.com`;
    const u = await createUser(tdb, email);
    await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, u.id, role]);
    users[role] = { id: u.id, email, claims: { sub: u.id, role: "authenticated", email } };
  }
  const agency = await createUser(tdb, "agency@lib.example.com", { agency_admin: true });
  users.agency = { id: agency.id, email: "agency@lib.example.com", claims: { sub: agency.id, role: "authenticated", email: "agency@lib.example.com", app_metadata: { agency_admin: true } } };
  const stranger = await createUser(tdb, "stranger@lib.example.com");
  users.stranger = { id: stranger.id, email: "stranger@lib.example.com", claims: { sub: stranger.id, role: "authenticated", email: "stranger@lib.example.com" } };
});

afterAll(async () => {
  await tdb?.close();
});

describe("access-data", () => {
  it("reads who is signed in from the session", async () => {
    actAs("owner");
    expect(await currentUserId()).toBe(users.owner!.id);
    actAs(null);
    expect(await currentUserId()).toBeNull();
  });

  it("answers the role helpers per user", async () => {
    actAs("owner");
    expect(await canEditWorkspace(ws)).toBe(true);
    expect(await canManageWorkspace(ws)).toBe(true);
    actAs("member");
    expect(await canEditWorkspace(ws)).toBe(false);
    expect(await canManageWorkspace(ws)).toBe(false);
    expect(await isAgencyAdmin()).toBe(false);
    actAs("agency");
    expect(await isAgencyAdmin()).toBe(true);
  });

  it("counts the workspaces resolve_my_access leaves a member with", async () => {
    actAs("editor");
    expect(await resolveMyAccess()).toBe(1);
    actAs("stranger");
    expect(await resolveMyAccess()).toBe(0);
  });

  it("gives an owner the Access page and nobody else but an agency admin", async () => {
    actAs("owner");
    const page = await loadAccessSettings("northbeam");
    expect(page?.workspace.slug).toBe("northbeam");
    expect(page?.isAgencyAdmin).toBe(false);
    expect(page?.members.map((m) => m.email)).toContain("owner@lib.example.com");
    expect(page?.members.find((m) => m.email === "viewer@lib.example.com")).toMatchObject({ role: "viewer", active: true });
    expect(page?.people.length).toBeGreaterThan(0);
    expect(page?.domains.map((d) => d.domain)).toEqual(["northbeam.example"]);
    expect(page?.emails.length).toBeGreaterThan(0);
    expect(page?.emails[0]).toHaveProperty("email");
    actAs("agency");
    expect((await loadAccessSettings("northbeam"))?.isAgencyAdmin).toBe(true);
    for (const role of ["editor", "member", "viewer", "stranger"]) {
      actAs(role);
      expect(await loadAccessSettings("northbeam")).toBeNull();
    }
    actAs("owner");
    expect(await loadAccessSettings("no-such-workspace")).toBeNull();
  });
});

describe("data.ts", () => {
  it("lists the workspaces the user can see, in name order", async () => {
    actAs("viewer");
    expect(await listWorkspaces()).toEqual([{ id: ws, name: expect.any(String), slug: "northbeam" }]);
    actAs("stranger");
    expect(await listWorkspaces()).toEqual([]);
  });

  it("loads a workspace head by slug, or null", async () => {
    actAs("member");
    expect(await loadWorkspaceHead("northbeam")).toMatchObject({ id: ws, slug: "northbeam" });
    expect(await loadWorkspaceHead("nope")).toBeNull();
    actAs("stranger");
    expect(await loadWorkspaceHead("northbeam")).toBeNull();
  });

  it("gives the agency its workspace list with numbers as numbers", async () => {
    actAs("agency");
    const rows = await listAgencyWorkspaces();
    const northbeam = rows.find((r) => r.id === ws);
    expect(northbeam).toBeDefined();
    expect(typeof northbeam!.openRiskIssues).toBe("number");
    expect(northbeam!.headline).toBeNull();
  });

  it("names members by their linked person", async () => {
    await tdb.client.query("update memberships set person_id = $1 where user_id = $2 and workspace_id = $3", [northbeamPersonIds["Priya Shah"], users.owner!.id, ws]);
    actAs("owner");
    const names = await loadMemberNames(ws);
    expect(names[users.owner!.id]).toBe("Priya Shah");
    // A member without a person linked is left out.
    expect(names[users.editor!.id]).toBeUndefined();
  });
});

describe("company-data", () => {
  it("counts processes, open issues and unlinked sources for the shell", async () => {
    actAs("viewer");
    const counts = await shellCounts(ws);
    expect(counts.processes).toBeGreaterThan(0);
    expect(typeof counts.openIssues).toBe("number");
    expect(typeof counts.unlinkedSources).toBe("number");
    const direct = await tdb.client.query("select count(*)::int as n from processes where workspace_id = $1 and not is_company and archived_at is null", [ws]);
    expect(counts.processes).toBe(direct.rows[0].n);
  });
});

describe("fields/server", () => {
  it("saves a field when the stored value is still the base, and reports a conflict otherwise", async () => {
    actAs("editor");
    const sales = northbeamRoleIds.sales;
    const stored = (await tdb.client.query("select name from roles where id = $1", [sales])).rows[0].name as string;
    expect(await saveField("roles", { id: sales }, "name", stored, "Sales (renamed)")).toEqual({ status: "saved", value: "Sales (renamed)" });
    expect(await saveField("roles", { id: sales }, "name", stored, "Sales (again)")).toEqual({ status: "conflict", theirs: "Sales (renamed)" });
    expect(await saveField("roles", { id: randomUUID() }, "name", "x", "y")).toEqual({ status: "not_found" });
  });

  it("maps database errors to the messages the screens show", async () => {
    actAs("editor");
    const names = (await tdb.client.query("select id, name from roles where workspace_id = $1 order by name", [ws])).rows as { id: string; name: string }[];
    const [a, b] = names as [{ id: string; name: string }, { id: string; name: string }];
    // 23505: a rename onto a name the workspace already has.
    expect(await saveField("roles", { id: a.id }, "name", a.name, b.name)).toEqual({ status: "error", message: "That name is already taken." });
    // 23514: a check constraint.
    const priya = northbeamPersonIds["Priya Shah"]!;
    const fte = Number((await tdb.client.query("select fte from people where id = $1", [priya])).rows[0].fte);
    expect(await saveField("people", { id: priya }, "fte", fte, 9)).toEqual({ status: "error", message: "That value isn't allowed here." });
  });

  it("saves several fields at once", async () => {
    actAs("editor");
    const priya = northbeamPersonIds["Priya Shah"]!;
    const row = (await tdb.client.query("select fte, capacity_hours_week from people where id = $1", [priya])).rows[0];
    const stored = (v: unknown) => (v === null ? null : Number(v));
    const out = await saveFields("people", { id: priya }, { fte: stored(row.fte), capacity_hours_week: stored(row.capacity_hours_week) }, { fte: 0.5, capacity_hours_week: 20 });
    expect(out).toEqual({ status: "saved" });
    expect(Number((await tdb.client.query("select fte from people where id = $1", [priya])).rows[0].fte)).toBe(0.5);
  });

  it("replaces a set held in a link table, with the base checked", async () => {
    actAs("editor");
    const priya = northbeamPersonIds["Priya Shah"]!;
    const roleIds = (await tdb.client.query("select role_id from person_roles where person_id = $1 order by role_id", [priya])).rows.map((r) => r.role_id as string);
    const owner = { person_id: priya, workspace_id: ws };
    const out = await saveLinks("person_roles", owner, roleIds, [northbeamRoleIds.seo]);
    expect(out).toEqual({ status: "saved", value: [northbeamRoleIds.seo] });
    const stale = await saveLinks("person_roles", owner, roleIds, []);
    expect(stale).toEqual({ status: "conflict", theirs: [northbeamRoleIds.seo] });
    actAs("viewer");
    expect(await saveLinks("person_roles", owner, [northbeamRoleIds.seo], [])).toEqual({ status: "not_found" });
  });

  it("saves a health rule, the per-person switch and a person's time", async () => {
    actAs("editor");
    expect(await saveHealthRule(ws, "health_initial", null, 70)).toEqual({ status: "saved", value: 70 });
    expect(await saveHealthRule(ws, "health_initial", null, 80)).toEqual({ status: "conflict", theirs: 70 });
    expect(await saveCapacityFactorSwitch(ws, null, true)).toEqual({ status: "saved", value: true });
    expect(await saveCapacityFactorSwitch(ws, null, false)).toEqual({ status: "conflict", theirs: true });
    const priya = northbeamPersonIds["Priya Shah"]!;
    expect(await saveCapacityFactor(priya, null, null, 1.25)).toEqual({ status: "saved", value: 1.25 });
    expect(await saveCapacityFactor(priya, null, 1.25, null)).toEqual({ status: "saved", value: null });
    actAs("viewer");
    expect(await saveCapacityFactor(priya, null, null, 1.1)).toMatchObject({ status: expect.stringMatching(/error|not_found/) });
  });
});

describe("narration cache", () => {
  const input = { purpose: "explain" as const, payload: {}, check: {} as never, aliases: [], template: ["The run finished.", "Nothing else."], hash: "a".repeat(64) };

  it("drafts, stores and re-reads a narration, and redrafts over the same row", async () => {
    actAs("editor");
    const targetId = randomUUID();
    expect(await findNarration(current, ws, targetId, input)).toBeNull();
    const first = await cachedNarration(current, { workspaceId: ws, targetId, input, model: null });
    expect(first.cached).toBe(false);
    expect(first.id).toEqual(expect.any(String));
    expect(first.fallback).toBe(true);
    const row = await findNarration(current, ws, targetId, input);
    expect(row).toMatchObject({ id: first.id, text: "The run finished.\n\nNothing else.", fallback: true, fallback_kind: "unavailable" });
    expect(row!.rejected).toEqual([]);
    expect(row!.usage).toEqual([]);
    const again = await cachedNarration(current, { workspaceId: ws, targetId, input, model: null, regenerate: true });
    expect(again.id).toBe(first.id);
    const n = (await tdb.client.query("select count(*)::int as n from narrations where target_id = $1", [targetId])).rows[0].n;
    expect(n).toBe(1);
  });

  it("keeps going when the cache can't be written", async () => {
    // A viewer may read narrations but not write one: the text is still returned, without an id.
    actAs("viewer");
    const out = await cachedNarration(current, { workspaceId: ws, targetId: randomUUID(), input, model: null });
    expect(out.id).toBeNull();
    expect(out.paragraphs).toEqual(input.template);
  });

  it("says a saved run isn't available when it is not there", async () => {
    actAs("editor");
    const out = await explainRun(current, randomUUID(), { model: null });
    expect(out).toEqual({ status: "error", code: "not_found", message: "That saved run isn't available." });
  });
});

describe("share links list", () => {
  it("lists a workspace's links newest first with what they show", async () => {
    // The snapshot check belongs to the sharing code (packages/db); this test is about the list, so insert around it.
    await tdb.client.query("alter table share_links disable trigger user");
    await tdb.client.query(
      "insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version, created_by) values ($1, $2, 'overview', '{}', 'test', $3)",
      [ws, "b".repeat(64), users.owner!.id],
    );
    await tdb.client.query("alter table share_links enable trigger user");
    actAs("owner");
    const links = await loadShareLinks(ws);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "overview", mode: "view", what: "The Overview", madeBy: "Priya Shah", opens: 0, status: expect.anything() });
    actAs("viewer");
    expect(await loadShareLinks(ws)).toEqual([]);
  });
});

describe("restore/empty", () => {
  it("says a workspace with data is not empty, and a bare one is", async () => {
    actAs("agency");
    expect(await workspaceIsEmpty(current, ws)).toBe(false);
    const fresh = (await tdb.client.query("insert into workspaces (name, slug) values ('Fresh', 'fresh') returning id")).rows[0].id as string;
    expect(await workspaceIsEmpty(current, fresh)).toBe(true);
    await tdb.client.query("insert into roles (workspace_id, name) values ($1, 'Someone')", [fresh]);
    expect(await workspaceIsEmpty(current, fresh)).toBe(false);
  });

  it("asks in one statement, and sees a row in any table it checks", async () => {
    actAs("agency");
    const other = (await tdb.client.query("insert into workspaces (name, slug) values ('Other', 'other-empty') returning id")).rows[0].id as string;
    let statements = 0;
    const counting = current.withPlugin({ transformQuery: ({ node }) => (statements++, node), transformResult: async ({ result }) => result });
    expect(await workspaceIsEmpty(counting, other)).toBe(true);
    expect(statements).toBe(1);
    await tdb.client.query("insert into issues (workspace_id, title, type) values ($1, 'An issue', 'delay')", [other]);
    expect(await workspaceIsEmpty(current, other)).toBe(false);
  });
});

describe("calibration reads", () => {
  it("lists a workspace's imports and lead sources", async () => {
    actAs("viewer");
    const imports = await loadImports(ws);
    expect(imports.imports).toEqual([]);
    const sources = await loadLeadSourceOptions(ws);
    expect(sources.length).toBeGreaterThan(0);
    expect(typeof sources[0]!.volumeWeek).toBe("number");
  });

  it("finds no latest client checks when none were saved", async () => {
    actAs("viewer");
    expect(await loadLatestChecks(ws)).toBeNull();
  });
});

describe("process page reads", () => {
  it("names who published the live version, and the system when nobody did", async () => {
    const live = (await tdb.client.query("select live_revision_id from processes where workspace_id = $1 and live_revision_id is not null limit 1", [ws])).rows[0].live_revision_id as string;
    actAs("viewer");
    const out = await loadLastChange(live, {});
    expect(out).not.toBeNull();
    expect(out!.by).toMatch(/A team member|The system/);
    expect(await loadLastChange(randomUUID(), {})).toBeNull();
  });
});
