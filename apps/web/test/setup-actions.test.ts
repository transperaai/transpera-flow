import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCapacitySetup, tierCount, uniqueClients, type CapacitySetup } from "@transpera-flow/db";
import { getDb } from "@/lib/auth/session";
import { createWorld, signInAs, type World } from "./action-harness";

// Set up, end to end (capacity build P1): the server actions of Tiers & clients and People & roles, run against a real database as an Agency
// admin and as a Viewer. The path: add a tier, add a named client with an override, set a portfolio count, and see the tier count change.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ set: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const actions = () => import("@/app/w/[slug]/setup/actions");

let world: World;
const q = async (sql: string, params: unknown[] = []) => (await world.tdb.client.query(sql, params)).rows as Record<string, unknown>[];
const setup = async (): Promise<CapacitySetup> => (await loadCapacitySetup(await getDb(), world.workspaceId))!;

beforeAll(async () => {
  world = await createWorld("setup");
}, 120_000);
afterAll(async () => {
  await world?.tdb.close();
});

describe("Tiers & clients and People & roles, end to end", () => {
  it("add a tier, add a named client with an override, set a portfolio count, and the tier count follows", async () => {
    const a = await actions();
    signInAs(world, "editor");
    expect(await a.addTierAction(world.workspaceId)).toEqual({});
    expect(await a.addTierAction(world.workspaceId)).toEqual({});
    let s = await setup();
    expect(s.tiers.map((t) => t.key)).toEqual(["T1", "T2"]);
    const org = s.departments.find((d) => d.name.startsWith("Organic"))!;
    const t1 = s.services.find((v) => v.department_id === org.id && v.tier_id === s.tiers[0]!.id)!;
    expect(tierCount(t1.id, s)).toBe(0);

    // A named client on the tier, with one override.
    const added = await a.addNamedClient(world.workspaceId, t1.id, "  Harbourline Group ");
    expect(added.error).toBeUndefined();
    expect(await a.saveSetupField("clients", { id: added.id! }, "hand_holding_hours", null, 3)).toEqual({ status: "saved", value: 3 });
    expect(await a.saveSetupField("clients", { id: added.id! }, "adhoc_chance", null, 1)).toEqual({ status: "saved", value: 1 });
    s = await setup();
    const client = s.clients.find((c) => c.id === added.id)!;
    expect(client).toMatchObject({ name: "Harbourline Group", hand_holding_hours: 3, adhoc_chance: 1, channels: null, service_ids: [t1.id] });
    expect(client.provenance).toMatchObject({ hand_holding_hours: { source: "entered" } });
    expect(tierCount(t1.id, s)).toBe(1);

    // A portfolio count for a person.
    const person = (await q("insert into people (workspace_id, name) values ($1, 'Karl') returning id", [world.workspaceId]))[0]!.id as string;
    expect(await a.savePortfolioCount(world.workspaceId, person, t1.id, 0, 4)).toEqual({ status: "saved", value: 4 });
    s = await setup();
    expect(tierCount(t1.id, s)).toBe(1 + 4);
    expect(uniqueClients(s).byDepartment[org.id]).toBe(5);
    // Changing it checks the base: a stale one is a conflict showing what is stored.
    expect(await a.savePortfolioCount(world.workspaceId, person, t1.id, 2, 9)).toEqual({ status: "conflict", theirs: 4 });
    expect(await a.savePortfolioCount(world.workspaceId, person, t1.id, 4, 6)).toEqual({ status: "saved", value: 6 });
    expect(tierCount(t1.id, await setup())).toBe(7);
    // Counts of 0 over nothing write nothing.
    const other = (await q("insert into people (workspace_id, name) values ($1, 'Zed') returning id", [world.workspaceId]))[0]!.id as string;
    expect(await a.savePortfolioCount(world.workspaceId, other, t1.id, 0, 0)).toEqual({ status: "saved", value: 0 });
    expect(await q("select 1 from person_portfolio where person_id = $1", [other])).toEqual([]);

    // The tiers a person serves, as a set.
    expect(await a.savePersonTiers(person, world.workspaceId, [], [s.tiers[0]!.id])).toEqual({ status: "saved", value: [s.tiers[0]!.id] });
    expect((await setup()).people.find((p) => p.id === person)!.tier_ids).toEqual([s.tiers[0]!.id]);

    // Tier 1 can't go while it has all that; a plain sentence says why.
    const refused = await a.removeTierAction(s.tiers[0]!.id);
    expect(refused.error).toMatch(/1 named client still takes T1/);
  });

  it("checks what is typed before it reaches the database, and takes the rest to the compare-and-set function", async () => {
    const a = await actions();
    signInAs(world, "editor");
    const s = await setup();
    const svc = s.services.find((v) => v.tier_id)!;
    const invalid = { status: "error", message: "That value isn't valid." };
    expect(await a.saveSetupField("services", { id: svc.id }, "adhoc_chance", null, 1.5)).toEqual(invalid);
    expect(await a.saveSetupField("services", { id: svc.id }, "words", null, -1)).toEqual(invalid);
    expect(await a.saveSetupField("services", { id: svc.id }, "workspace_id", null, "x")).toEqual(invalid);
    expect(await a.saveSetupField("services", { id: "nope" }, "words", null, 1)).toEqual(invalid);
    expect(await a.saveSetupField("services", { id: svc.id, extra: svc.id }, "words", null, 1)).toEqual(invalid);
    expect(await a.saveSetupField("toString" as never, { id: svc.id }, "words", null, 1)).toEqual(invalid);
    expect(await a.saveSetupField("people", { id: svc.id }, "label", null, "intern")).toEqual(invalid);
    expect(await a.saveSetupField("services", { id: svc.id }, "words", null, 1500)).toEqual({ status: "saved", value: 1500 });
    // Someone else changed it meanwhile: asked, with what is stored.
    expect(await a.saveSetupField("services", { id: svc.id }, "words", null, 2000)).toEqual({ status: "conflict", theirs: 1500 });
    expect(await a.savePersonRamp((await setup()).people[0]!.id, null, "40, 60, 80")).toEqual({ status: "saved", value: "40, 60, 80" });
    expect(await a.savePersonRamp((await setup()).people[0]!.id, "40, 60, 80", "150")).toEqual(invalid);
    expect(await a.saveRampDefault(world.workspaceId, null, "30, 60")).toEqual({ status: "saved", value: "30, 60" });
    expect((await setup()).rampDefault).toEqual([0.3, 0.6]);
    expect(await a.saveDlerIncludesLeadership(world.workspaceId, true, false)).toEqual({ status: "saved", value: false });
    expect((await setup()).dlerIncludesLeadership).toBe(false);
    expect(await a.saveDlerIncludesLeadership(world.workspaceId, true, true)).toEqual({ status: "conflict", theirs: false });
  });

  it("a Viewer can change nothing, and signed out nothing happens", async () => {
    const a = await actions();
    const s = await setup();
    const svc = s.services.find((v) => v.tier_id)!;
    signInAs(world, "viewer");
    expect((await a.saveSetupField("services", { id: svc.id }, "links", null, 5)).status).toBe("not_found");
    expect((await a.addTierAction(world.workspaceId)).error).toBe("Only Agency admins and the Owner can change tiers.");
    expect((await a.addNamedClient(world.workspaceId, svc.id, "Nope Co")).error).toBeTruthy();
    expect((await a.savePortfolioCount(world.workspaceId, s.people[0]!.id, svc.id, 0, 3)).status).toBe("error");
    expect(await q("select 1 from clients where name = 'Nope Co'")).toEqual([]);
    const seen = await setup();
    expect(seen.canEdit).toBe(false);
    expect(seen.tiers).toHaveLength(2);
  });
});
