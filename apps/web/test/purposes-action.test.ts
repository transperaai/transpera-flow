import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PURPOSES, NORTHBEAM_WORKSPACE_ID, type PurposeCategory } from "@transpera-flow/db";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// The Settings action for the purpose categories (sandbox phase 4): the list is checked as the database checks it, saved whole against the
// list as it was loaded, a stale base is a conflict that returns theirs, a Viewer is refused, and the page refreshes on a save.

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: mocks.refresh, revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { savePurposes } = await import("@/app/w/[slug]/settings/actions");

const WS = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let owner: TestUser;
let viewer: TestUser;
const list = (): PurposeCategory[] => DEFAULT_PURPOSES.map((c) => ({ ...c }));
const renamed = (): PurposeCategory[] => list().map((c) => (c.key === "winning" ? { ...c, name: "Selling" } : c));

beforeAll(async () => {
  tdb = await createTestDb();
  owner = await addMember(tdb, WS, "owner");
  viewer = await addMember(tdb, WS, "viewer");
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  mocks.refresh.mockClear();
  await tdb.client.query("update workspaces set settings = settings - 'purposes' where id = $1", [WS]);
  signInAs({ tdb }, owner);
});

const stored = async () => (await tdb.client.query("select settings -> 'purposes' as v, settings ? 'purposes' as has from workspaces where id = $1", [WS])).rows[0] as { v: unknown; has: boolean };

describe("savePurposes", () => {
  it("saves a valid list against a null base (the defaults), then against the list it saved, and refreshes the page", async () => {
    expect(await savePurposes(WS, null, renamed())).toEqual({ status: "saved", purposes: renamed() });
    expect((await stored()).v).toEqual(renamed());
    const reversed = [...renamed()].reverse();
    expect(await savePurposes(WS, renamed(), reversed)).toEqual({ status: "saved", purposes: reversed });
    expect((await stored()).v).toEqual(reversed);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("refuses an invalid list with the reason, writing nothing", async () => {
    const bad: [string, unknown][] = [
      ["a missing fixed category", list().filter((c) => c.key !== "fixing")],
      ["a duplicate name", [...list(), { key: "c00000001", name: "fixing", description: "" }]],
      ["a long name", [...list(), { key: "c00000001", name: "n".repeat(61), description: "" }]],
      ["too many", [...list(), ...Array.from({ length: 6 }, (_, i) => ({ key: `c0000000${i}`, name: `Extra ${i}`, description: "" }))]],
      ["not a list", "junk"],
    ];
    for (const [why, value] of bad) {
      const out = await savePurposes(WS, null, value);
      expect(out.status, why).toBe("error");
    }
    expect(await stored()).toEqual({ v: null, has: false });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("answers with their list when someone else saved first, and saves on a second try against it ('keep mine')", async () => {
    await tdb.client.query("update workspaces set settings = jsonb_set(settings, '{purposes}', $2::jsonb) where id = $1", [WS, JSON.stringify(renamed())]);
    const out = await savePurposes(WS, null, list().reverse());
    expect(out).toEqual({ status: "conflict", theirs: renamed() });
    expect((await stored()).v).toEqual(renamed());
    expect((await savePurposes(WS, renamed(), list().reverse())).status).toBe("saved");
  });

  it("refuses a bad workspace id or base without calling the database", async () => {
    expect((await savePurposes("nope", null, list())).status).toBe("error");
    expect((await savePurposes(WS, "junk" as never, list())).status).toBe("error");
    expect(await stored()).toEqual({ v: null, has: false });
  });

  it("is refused to a viewer and to a signed-out user", async () => {
    signInAs({ tdb }, viewer);
    const out = await savePurposes(WS, null, renamed());
    expect(out.status).not.toBe("saved");
    signOut({ tdb });
    expect((await savePurposes(WS, null, renamed())).status).toBe("error");
    expect(await stored()).toEqual({ v: null, has: false });
  });
});
