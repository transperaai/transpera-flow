import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isSlug, parseNewWorkspace, slugify } from "@/lib/workspaces";
import { createWorld, signInAs, signOut, type World } from "./action-harness";

// Creating a workspace (issue #88): the form's checks, and the Server Action that calls create_workspace, run against a real
// database as a chosen user. The one thing faked is a database error no form input can reach (`inject`).
const inject = vi.hoisted(() => ({ error: null as { code: string } | null }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
vi.mock("@transpera-flow/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@transpera-flow/db/client")>();
  return { ...actual, rpc: (...args: Parameters<typeof actual.rpc>) => (inject.error ? Promise.reject(inject.error) : actual.rpc(...args)) };
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
const { redirect } = await import("next/navigation");
const { createWorkspace } = await import("@/app/actions");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("slugify", () => {
  it("lower-cases, drops accents and joins words with single dashes", () => {
    expect(slugify("Acme Dental & Co.")).toBe("acme-dental-co");
    expect(slugify("Café Río")).toBe("cafe-rio");
  });
  it("gives an empty slug for a name with no letters or digits", () => {
    expect(slugify("  --  ")).toBe("");
  });
  it("cuts to 60 characters without leaving a trailing dash", () => {
    const slug = slugify(`${"a".repeat(59)} bbb`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe("a".repeat(59));
    expect(slug.endsWith("-")).toBe(false);
    expect(isSlug(slugify("word ".repeat(30)))).toBe(true);
  });
});

describe("isSlug", () => {
  it("matches the database's check", () => {
    for (const ok of ["acme", "acme-dental", "a1-b2"]) expect(isSlug(ok), ok).toBe(true);
    for (const bad of ["", "Acme", "-acme", "acme-", "a--b", "a b", "a".repeat(61)]) expect(isSlug(bad), bad).toBe(false);
  });
});

describe("parseNewWorkspace", () => {
  it("takes the defaults, and the slug from the name", () => {
    expect(parseNewWorkspace(form({ name: "  Acme Dental " }))).toEqual({
      name: "Acme Dental",
      slug: "acme-dental",
      settings: { hours_per_week: 40, currency: "AUD", horizon_weeks: 13 },
    });
  });
  it("uses the values given, the slug trimmed and lower-cased and the currency upper-cased", () => {
    expect(parseNewWorkspace(form({ name: "Acme", slug: " Acme-2 ", hours_per_week: "37.5", currency: "usd", horizon_weeks: "26" }))).toEqual({
      name: "Acme",
      slug: "acme-2",
      settings: { hours_per_week: 37.5, currency: "USD", horizon_weeks: 26 },
    });
  });
  it("refuses what the database would", () => {
    const bad: Record<string, string>[] = [
      { name: "  " },
      { name: "x".repeat(201) },
      { name: "!!!" },
      { name: "Acme", slug: "not a slug" },
      { name: "Acme", hours_per_week: "0" },
      { name: "Acme", hours_per_week: "169" },
      { name: "Acme", hours_per_week: "lots" },
      { name: "Acme", currency: "pounds" },
      { name: "Acme", horizon_weeks: "1.5" },
      { name: "Acme", horizon_weeks: "0" },
      { name: "Acme", horizon_weeks: "105" },
    ];
    for (const fields of bad) expect(parseNewWorkspace(form(fields)), JSON.stringify(fields)).toHaveProperty("error");
  });
});

describe("the createWorkspace action", () => {
  let world: World;
  const count = async () => Number((await world.tdb.client.query("select count(*) from workspaces")).rows[0].count);
  beforeAll(async () => {
    world = await createWorld("acme");
  });
  afterAll(async () => {
    await world?.tdb.close();
  });
  beforeEach(() => {
    inject.error = null;
    signInAs(world, "admin");
    vi.mocked(redirect).mockClear();
  });

  it("never reaches the database with bad input", async () => {
    const before = await count();
    expect(await createWorkspace({}, form({ name: "" }))).toHaveProperty("error");
    expect(await createWorkspace({}, form({ name: "Acme", hours_per_week: "0" }))).toHaveProperty("error");
    expect(await count()).toBe(before);
  });

  it("creates the workspace and goes to it", async () => {
    await expect(createWorkspace({}, form({ name: "Acme Dental", currency: "eur" }))).rejects.toThrow("NEXT_REDIRECT");
    const made = (await world.tdb.client.query("select id, name, settings from workspaces where slug = 'acme-dental'")).rows[0];
    expect(made.name).toBe("Acme Dental");
    expect(made.settings).toMatchObject({ hours_per_week: 40, currency: "EUR", horizon_weeks: 13 });
    // The creator becomes the workspace's agency admin.
    const members = (await world.tdb.client.query("select user_id, role from memberships where workspace_id = $1", [made.id])).rows;
    expect(members).toEqual([{ user_id: world.users.admin.id, role: "agency_admin" }]);
    expect(redirect).toHaveBeenCalledWith("/w/acme-dental");
  });

  it("says why it was refused", async () => {
    signInAs(world, "owner");
    expect(await createWorkspace({}, form({ name: "Other" }))).toEqual({ error: "Only agency admins can create workspaces." });
    signInAs(world, "admin");
    // The address "acme" belongs to the seeded workspace.
    expect(await createWorkspace({}, form({ name: "Acme" }))).toEqual({ error: "The address /w/acme is already taken. Choose another." });
    // Errors no valid form can reach.
    inject.error = { code: "23514" };
    expect(await createWorkspace({}, form({ name: "Acme" }))).toEqual({ error: "Some of those values aren't allowed." });
    inject.error = { code: "XX000" };
    expect(await createWorkspace({}, form({ name: "Acme" }))).toEqual({ error: "Couldn't create it. Try again." });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("asks a signed-out user to sign in, without calling the database", async () => {
    signOut(world);
    const before = await count();
    expect(await createWorkspace({}, form({ name: "Signed Out Co" }))).toEqual({ error: "Your session has ended. Sign in again." });
    expect(await count()).toBe(before);
  });
});
