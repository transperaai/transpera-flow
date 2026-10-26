import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inUse, parseNewRole, parseRoleField, roleUsage, selectableRoles } from "@/lib/roles";
import { createWorld, signInAs, signOut, type World } from "./action-harness";

// Roles in the settings (issue #88): the checks, the usage counts and the Server Actions, which run against a real database.
const mocks = vi.hoisted(() => ({ refreshed: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => void (mocks.refreshed += 1) }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { createRole, removeRole, saveRoleField } = await import("@/app/w/[slug]/settings/actions");

const ROLE = "b0000000-0000-4000-8000-000000000001";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("parseRoleField", () => {
  it("accepts a name (trimmed) and the active flag", () => {
    expect(parseRoleField(ROLE, "name", "Finance", "  Finance and admin ")).toEqual({ roleId: ROLE, field: "name", base: "Finance", value: "Finance and admin" });
    expect(parseRoleField(ROLE, "active", true, false)).toEqual({ roleId: ROLE, field: "active", base: true, value: false });
  });
  it("refuses anything else", () => {
    expect(parseRoleField("nope", "name", "a", "b")).toBeNull();
    expect(parseRoleField(ROLE, "headcount", 1, 2)).toBeNull();
    expect(parseRoleField(ROLE, "name", "a", "   ")).toBeNull();
    expect(parseRoleField(ROLE, "name", "a", "x".repeat(201))).toBeNull();
    expect(parseRoleField(ROLE, "active", true, "no")).toBeNull();
    expect(parseRoleField(ROLE, "name", { a: 1 }, "b")).toBeNull();
  });
});

describe("parseNewRole", () => {
  it("trims the name, or asks for one", () => {
    expect(parseNewRole(form({ name: "  Copywriter " }))).toEqual({ name: "Copywriter" });
    expect(parseNewRole(form({ name: "   " }))).toEqual({ error: "Enter a name." });
    expect(parseNewRole(form({}))).toEqual({ error: "Enter a name." });
  });
});

describe("roleUsage", () => {
  it("counts distinct steps across revisions, people and clients", () => {
    const usage = roleUsage(
      [
        { id: "s1", role_id: "r1" },
        { id: "s1", role_id: "r1" }, // the same step in another revision
        { id: "s2", role_id: "r1" },
        { id: "s3", role_id: null },
      ],
      [
        { person_id: "p1", role_id: "r1" },
        { person_id: "p1", role_id: "r2" },
      ],
      [{ client_id: "c1", role_id: "r2" }],
      [
        { id: "v1", fallback_ongoing_load: { r3: 2 } },
        { id: "v2", fallback_ongoing_load: {} },
      ],
    );
    expect(usage).toEqual({
      r1: { steps: 2, people: 1, clients: 0, services: 0 },
      r2: { steps: 0, people: 1, clients: 1, services: 0 },
      r3: { steps: 0, people: 0, clients: 0, services: 1 },
    });
    expect(inUse(usage.r1)).toBe(true);
    // Only a service's fallback load names r3: the database refuses its delete too.
    expect(inUse(usage.r3)).toBe(true);
    expect(inUse(undefined)).toBe(false);
    expect(inUse({ steps: 0, people: 0, clients: 0, services: 0 })).toBe(false);
  });
});

describe("selectableRoles", () => {
  const roles = [
    { id: "a", active: true },
    { id: "b", active: false },
    { id: "c", active: false },
  ];
  it("hides inactive roles, except ones already chosen", () => {
    expect(selectableRoles(roles).map((r) => r.id)).toEqual(["a"]);
    expect(selectableRoles(roles, ["b", null]).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("the role actions", () => {
  let world: World;
  let WS: string;
  let roleId: string;
  const roleRows = async (name?: string) =>
    (await world.tdb.client.query("select id, name, active from roles where workspace_id = $1 and ($2::text is null or name = $2)", [WS, name ?? null])).rows;

  beforeAll(async () => {
    world = await createWorld("rolesco");
    WS = world.workspaceId;
    roleId = (await world.tdb.client.query("insert into roles (workspace_id, name) values ($1, 'Finance') returning id", [WS])).rows[0].id;
    await world.tdb.client.query("insert into roles (workspace_id, name) values ($1, 'Sales')", [WS]);
  });
  afterAll(async () => {
    await world?.tdb.close();
  });
  beforeEach(() => {
    mocks.refreshed = 0;
    signInAs(world, "editor");
  });

  it("saves one field through save_fields and refreshes", async () => {
    expect(await saveRoleField(roleId, "name", "Finance", " Finance and admin ")).toEqual({ status: "saved", value: "Finance and admin" });
    expect((await roleRows("Finance and admin")).map((r) => r.id)).toEqual([roleId]);
    expect(mocks.refreshed).toBe(1);
    // Put it back for the tests below.
    expect((await saveRoleField(roleId, "name", "Finance and admin", "Finance")).status).toBe("saved");
    mocks.refreshed = 0;
  });

  it("makes no change for malformed input, or when signed out", async () => {
    expect(await saveRoleField(roleId, "name", "Finance", "  ")).toMatchObject({ status: "error" });
    expect(await saveRoleField("nope", "name", "Finance", "x")).toMatchObject({ status: "error" });
    signOut(world);
    expect(await saveRoleField(roleId, "name", "Finance", "x")).toMatchObject({ status: "error" });
    expect((await roleRows("Finance")).map((r) => r.id)).toEqual([roleId]);
    expect(mocks.refreshed).toBe(0);
  });

  it("says a rename onto an existing name is taken", async () => {
    expect(await saveRoleField(roleId, "name", "Finance", "Sales")).toEqual({ status: "error", message: "That name is already taken." });
    expect(mocks.refreshed).toBe(0);
  });

  it("adds a role", async () => {
    expect(await createRole(WS, {}, form({ name: " Copywriter " }))).toEqual({});
    expect(await roleRows("Copywriter")).toHaveLength(1);
    expect(mocks.refreshed).toBe(1);
  });

  it("refuses a blank name without a change, and names a duplicate", async () => {
    const before = (await roleRows()).length;
    expect(await createRole(WS, {}, form({ name: " " }))).toEqual({ error: "Enter a name." });
    expect((await roleRows()).length).toBe(before);
    expect(await createRole(WS, {}, form({ name: "Sales" }))).toEqual({ error: "There is already a role called 'Sales'." });
  });

  it("removes a role, and explains why it can't", async () => {
    const spare = (await world.tdb.client.query("insert into roles (workspace_id, name) values ($1, 'Spare') returning id", [WS])).rows[0].id;
    expect(await removeRole(spare)).toEqual({});
    expect(await roleRows("Spare")).toHaveLength(0);
    expect(mocks.refreshed).toBe(1);
    // A role a step uses can't go.
    const used = (await world.tdb.client.query("insert into roles (workspace_id, name) values ($1, 'Used') returning id", [WS])).rows[0].id;
    const pat = (await world.tdb.client.query("insert into people (workspace_id, name) values ($1, 'Pat') returning id", [WS])).rows[0].id;
    await world.tdb.client.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [pat, used, WS]);
    expect(await removeRole(used)).toEqual({ error: "That role is still used by steps, people, clients or a service's fallback load. Make it inactive instead." });
    expect(await roleRows("Used")).toHaveLength(1);
    // Already gone.
    expect(await removeRole(spare)).toEqual({ error: "That role was already removed, or you can't edit it." });
    expect(mocks.refreshed).toBe(1);
  });
});
