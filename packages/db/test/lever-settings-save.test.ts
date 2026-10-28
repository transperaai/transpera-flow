import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadLeverSettings, NORTHBEAM_WORKSPACE_ID, saveLeverSettings, type Db } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// saveLeverSettings / loadLeverSettings (issue #123) against Postgres as a real user: the compare-and-set on
// `updated_at`, the conflict it reports, and a write the policy refuses.

const ws = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let editor: Db;
let viewer: Db;

beforeAll(async () => {
  tdb = await createTestDb();
  const e = await createUser(tdb, "editor@levers-save.example.com");
  const v = await createUser(tdb, "viewer@levers-save.example.com");
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ws, e.id, v.id]);
  editor = tdb.dbAs(e.claims as never);
  viewer = tdb.dbAs(v.claims as never);
});
afterAll(async () => {
  await tdb?.close();
});
beforeEach(async () => {
  await tdb.client.query("delete from lever_settings where workspace_id = $1", [ws]);
});

const doc = ["process.time", "finances.prices"];
const stored = async () => (await tdb.client.query("select hidden from lever_settings where workspace_id = $1", [ws])).rows[0] as { hidden: string[] } | undefined;
const seed = (hidden: string[]) => tdb.client.query("insert into lever_settings (workspace_id, hidden) values ($1, $2)", [ws, hidden]);

describe("loadLeverSettings", () => {
  it("shows every lever with no row, and reads a stored list", async () => {
    expect(await loadLeverSettings(viewer, ws)).toEqual({ hidden: [], version: null });
    await seed(doc);
    const loaded = await loadLeverSettings(viewer, ws);
    expect(loaded.hidden).toEqual(doc);
    expect(loaded.version).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("saveLeverSettings", () => {
  it("inserts the first save and updates later ones against the version it was given", async () => {
    const first = await saveLeverSettings(editor, ws, doc, null);
    expect(first.status).toBe("saved");
    if (first.status !== "saved") return;
    expect(first.settings.hidden).toEqual(doc);
    const second = await saveLeverSettings(editor, ws, [], first.settings.version);
    expect(second.status).toBe("saved");
    expect((await stored())?.hidden).toEqual([]);
  });

  it("stores each id once", async () => {
    await saveLeverSettings(editor, ws, ["a", "b", "a"], null);
    expect((await stored())?.hidden).toEqual(["a", "b"]);
  });

  it("reports a conflict, with their list, when someone saved since", async () => {
    await seed(doc);
    const theirs = (await loadLeverSettings(editor, ws)).version;
    const stale = await saveLeverSettings(editor, ws, ["process.wait"], "2020-01-01T00:00:00+00:00");
    expect(stale).toEqual({ status: "conflict", settings: { hidden: doc, version: theirs } });
    expect((await stored())?.hidden).toEqual(doc);
    // Two first saves: the second finds the row already there.
    expect((await saveLeverSettings(editor, ws, [], null)).status).toBe("conflict");
  });

  it("is forbidden when the write isn't allowed", async () => {
    expect((await saveLeverSettings(viewer, ws, doc, null)).status).toBe("forbidden");
    await seed([]);
    const version = (await loadLeverSettings(viewer, ws)).version;
    const update = await saveLeverSettings(viewer, ws, doc, version);
    expect(update.status).toBe("forbidden");
    expect((await stored())?.hidden).toEqual([]);
  });

  it("rejects a list that isn't valid without touching the table", async () => {
    expect((await saveLeverSettings(editor, ws, Array.from({ length: 101 }, (_, i) => `l${i}`), null)).status).toBe("invalid");
    expect((await saveLeverSettings(editor, ws, [""], null)).status).toBe("invalid");
    expect(await stored()).toBeUndefined();
  });
});
