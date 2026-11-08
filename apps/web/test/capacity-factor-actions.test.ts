import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamStepIds } from "@transpera-flow/db";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// The Settings Server Actions for per-person times (C6, #198): input checks, what reaches the database, and that a save or a
// conflict refreshes the page (the other fields' placeholders and the "Not used now" list read what is stored). Runs against a
// real database as an editor (and a viewer, who is refused).

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: mocks.refresh, revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { savePersonCapacityFactor, saveCapacityFactorsEnabled } = await import("@/app/w/[slug]/settings/actions");

const PERSON = northbeamPersonIds["Rosa Diaz"]!;
const STEP = northbeamStepIds.audit;
const WS = NORTHBEAM_WORKSPACE_ID;

let tdb: TestDb;
let editor: TestUser;
let viewer: TestUser;
let larkspurStep: string;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  viewer = await addMember(tdb, WS, "viewer");
  larkspurStep = (await tdb.client.query("select id from steps where workspace_id = $1 limit 1", [LARKSPUR_WORKSPACE_ID])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  mocks.refresh.mockClear();
  await tdb.client.query("delete from person_capacity_factors");
  await tdb.client.query("update workspaces set settings = settings - 'capacity_factor_enabled' where id = $1", [WS]);
  signInAs({ tdb }, editor);
});

const stored = async (step: string | null = STEP) =>
  (await tdb.client.query("select factor::float8 as factor from person_capacity_factors where person_id = $1 and step_id is not distinct from $2", [PERSON, step])).rows.map((r) => r.factor as number);
const total = async () => Number((await tdb.client.query("select count(*) from person_capacity_factors")).rows[0].count);

describe("savePersonCapacityFactor", () => {
  it("stores the value rounded to two decimals, and refreshes the page on a save", async () => {
    expect(await savePersonCapacityFactor(PERSON, STEP, null, 0.8333)).toEqual({ status: "saved", value: 0.83 });
    expect(await stored()).toEqual([0.83]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on a conflict too, and answers with their value", async () => {
    await tdb.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, 1.5)", [PERSON, WS]);
    expect(await savePersonCapacityFactor(PERSON, null, 0.9, 0.8)).toEqual({ status: "conflict", theirs: 1.5 });
    expect(await stored(null)).toEqual([1.5]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("doesn't refresh when nothing changed on the server: not found, a database error, bad input or a signed-out user", async () => {
    // A viewer can't write: the function answers not found, and nothing is stored.
    signInAs({ tdb }, viewer);
    expect(await savePersonCapacityFactor(PERSON, STEP, null, 1.2)).toEqual({ status: "not_found" });
    signInAs({ tdb }, editor);
    // The database refuses a step of another workspace.
    expect((await savePersonCapacityFactor(PERSON, larkspurStep, null, 1.2)).status).toBe("error");
    for (const bad of [0.49, 2.01, Number.NaN, Number.POSITIVE_INFINITY]) expect((await savePersonCapacityFactor(PERSON, STEP, null, bad)).status, String(bad)).toBe("error");
    expect((await savePersonCapacityFactor("nope", STEP, null, 1)).status).toBe("error");
    expect((await savePersonCapacityFactor(PERSON, "nope", null, 1)).status).toBe("error");
    signOut({ tdb });
    expect((await savePersonCapacityFactor(PERSON, STEP, null, 1)).status).toBe("error");
    expect(await total()).toBe(0);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("a null value removes the time and the bounds 0.5 and 2 are accepted", async () => {
    await tdb.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, $3, 0.9)", [PERSON, WS, STEP]);
    expect(await savePersonCapacityFactor(PERSON, STEP, 0.9, null)).toEqual({ status: "saved", value: null });
    expect(await stored()).toEqual([]);
    for (const edge of [0.5, 2]) {
      expect((await savePersonCapacityFactor(PERSON, null, null, edge)).status).toBe("saved");
      expect(await stored(null)).toEqual([edge]);
      expect((await savePersonCapacityFactor(PERSON, null, edge, null)).status).toBe("saved");
    }
  });
});

describe("saveCapacityFactorsEnabled", () => {
  const enabled = async () => (await tdb.client.query("select settings -> 'capacity_factor_enabled' as v from workspaces where id = $1", [WS])).rows[0].v;

  it("saves the switch against the base, and refreshes only on a save", async () => {
    expect(await saveCapacityFactorsEnabled(WS, false, true)).toEqual({ status: "saved", value: true });
    expect(await enabled()).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    mocks.refresh.mockClear();
    signInAs({ tdb }, viewer);
    expect(await saveCapacityFactorsEnabled(WS, false, false)).toEqual({ status: "not_found" });
    signInAs({ tdb }, editor);
    expect((await saveCapacityFactorsEnabled(WS, "yes" as never, true)).status).toBe("error");
    expect((await saveCapacityFactorsEnabled(WS, false, "yes" as never)).status).toBe("error");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
