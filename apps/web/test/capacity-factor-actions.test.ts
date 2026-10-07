import { beforeEach, describe, expect, it, vi } from "vitest";

// The Settings Server Actions for per-person times (C6, #198): input checks, what reaches the database, and that a save or a
// conflict refreshes the page (the other fields' placeholders and the "Not used now" list read what is stored).

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  rpc: vi.fn(),
  signedIn: true,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: mocks.refresh, revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: mocks.signedIn ? { claims: { sub: "u1" } } : null }) },
    rpc: mocks.rpc,
  }),
}));
const { savePersonCapacityFactor, saveCapacityFactorsEnabled } = await import("@/app/w/[slug]/settings/actions");

const PERSON = "11111111-1111-4111-8111-111111111111";
const STEP = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  mocks.refresh.mockClear();
  mocks.rpc.mockReset();
  mocks.signedIn = true;
});

describe("savePersonCapacityFactor", () => {
  it("sends the value rounded to two decimals, and refreshes the page on a save", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "saved", value: 0.83 }, error: null });
    expect(await savePersonCapacityFactor(PERSON, STEP, null, 0.8333)).toEqual({ status: "saved", value: 0.83 });
    expect(mocks.rpc).toHaveBeenCalledWith("save_capacity_factor", { person: PERSON, step: STEP, base: null, value: 0.83 });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on a conflict too, and answers with their value", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "conflict", theirs: 1.5 }, error: null });
    expect(await savePersonCapacityFactor(PERSON, null, 0.9, 0.8)).toEqual({ status: "conflict", theirs: 1.5 });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("doesn't refresh when nothing changed on the server: not found, a database error, bad input or a signed-out user", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    expect(await savePersonCapacityFactor(PERSON, STEP, null, 1.2)).toEqual({ status: "not_found" });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "x" } });
    expect((await savePersonCapacityFactor(PERSON, STEP, null, 1.2)).status).toBe("error");
    const calls = mocks.rpc.mock.calls.length;
    for (const bad of [0.49, 2.01, Number.NaN, Number.POSITIVE_INFINITY]) expect((await savePersonCapacityFactor(PERSON, STEP, null, bad)).status, String(bad)).toBe("error");
    expect((await savePersonCapacityFactor("nope", STEP, null, 1)).status).toBe("error");
    expect((await savePersonCapacityFactor(PERSON, "nope", null, 1)).status).toBe("error");
    mocks.signedIn = false;
    expect((await savePersonCapacityFactor(PERSON, STEP, null, 1)).status).toBe("error");
    expect(mocks.rpc.mock.calls.length).toBe(calls);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("a null value removes the time and the bounds 0.5 and 2 are accepted", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "saved", value: null }, error: null });
    expect(await savePersonCapacityFactor(PERSON, STEP, 0.9, null)).toEqual({ status: "saved", value: null });
    for (const edge of [0.5, 2]) {
      mocks.rpc.mockResolvedValue({ data: { status: "saved", value: edge }, error: null });
      expect((await savePersonCapacityFactor(PERSON, null, null, edge)).status).toBe("saved");
    }
  });
});

describe("saveCapacityFactorsEnabled", () => {
  it("saves the switch against the base, and refreshes only on a save", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "saved", row: { settings: { capacity_factor_enabled: true } }, conflicts: {} }, error: null });
    expect(await saveCapacityFactorsEnabled(WS, false, true)).toEqual({ status: "saved", value: true });
    expect(mocks.rpc).toHaveBeenCalledWith("save_capacity_factor_switch", { ws: WS, base: { capacity_factor_enabled: false }, changes: { capacity_factor_enabled: true } });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    mocks.refresh.mockClear();
    mocks.rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    expect(await saveCapacityFactorsEnabled(WS, false, true)).toEqual({ status: "not_found" });
    expect((await saveCapacityFactorsEnabled(WS, "yes" as never, true)).status).toBe("error");
    expect((await saveCapacityFactorsEnabled(WS, false, "yes" as never)).status).toBe("error");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
