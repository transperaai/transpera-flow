import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "@transpera-flow/db";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// The Settings action for overheads a month (sandbox phase 2): input checks (null, or a finite number from 0 to 100,000,000),
// what reaches the database (and its own check, workspaces_overhead_monthly), conflicts, who may write, and the page refreshing
// on a save. Runs against a real database as an owner, and as a viewer, who is refused.

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: mocks.refresh, revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { saveOverheadMonthly } = await import("@/app/w/[slug]/settings/actions");

const WS = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let editor: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  viewer = await addMember(tdb, WS, "viewer");
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  mocks.refresh.mockClear();
  await tdb.client.query("update workspaces set settings = settings - 'overhead_monthly' where id = $1", [WS]);
  signInAs({ tdb }, editor);
});

const stored = async () => (await tdb.client.query("select settings -> 'overhead_monthly' as v, settings ? 'overhead_monthly' as has from workspaces where id = $1", [WS])).rows[0] as { v: unknown; has: boolean };

describe("saveOverheadMonthly", () => {
  it("saves a number from 0 to 100,000,000, and refreshes the page", async () => {
    for (const [base, value] of [[null, 18000], [18000, 0], [0, 100_000_000], [100_000_000, 12500.5]] as const) {
      expect(await saveOverheadMonthly(WS, base, value)).toEqual({ status: "saved", value });
      expect((await stored()).v).toBe(value);
    }
    expect(mocks.refresh).toHaveBeenCalledTimes(4);
  });

  it("null (a blank field) is accepted and stored as not set", async () => {
    await saveOverheadMonthly(WS, null, 18000);
    expect(await saveOverheadMonthly(WS, 18000, null)).toEqual({ status: "saved", value: null });
    expect((await stored()).v).toBeNull();
  });

  it("refuses a negative number, one over the limit, a string, NaN and infinity, writing nothing", async () => {
    for (const bad of [-1, 100_000_001, "5", Number.NaN, Number.POSITIVE_INFINITY, undefined, true, [1]] as unknown[]) {
      expect((await saveOverheadMonthly(WS, null, bad as number)).status, String(bad)).toBe("error");
    }
    expect((await saveOverheadMonthly(WS, "5" as never, 5)).status).toBe("error");
    expect((await saveOverheadMonthly("nope", null, 5)).status).toBe("error");
    expect(await stored()).toEqual({ v: null, has: false });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("answers with their value when someone else changed it first", async () => {
    await tdb.client.query("update workspaces set settings = settings || '{\"overhead_monthly\": 9000}' where id = $1", [WS]);
    expect(await saveOverheadMonthly(WS, 18000, 20000)).toEqual({ status: "conflict", theirs: 9000 });
    expect((await stored()).v).toBe(9000);
  });

  it("is refused to a viewer and a signed-out user", async () => {
    signInAs({ tdb }, viewer);
    expect((await saveOverheadMonthly(WS, null, 18000)).status).not.toBe("saved");
    signOut({ tdb });
    expect((await saveOverheadMonthly(WS, null, 18000)).status).toBe("error");
    expect(await stored()).toEqual({ v: null, has: false });
  });
});
