import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAnalysisRules, NORTHBEAM_WORKSPACE_ID, saveAnalysisRules, type Db } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// saveAnalysisRules / loadAnalysisRules (issue #109) against Postgres as a real user: the compare-and-set on
// `updated_at`, the conflict it reports, and a write the policy refuses. The policies themselves are tested in
// analysis-rules.test.ts.

const ws = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let editor: Db;
let viewer: Db;

beforeAll(async () => {
  tdb = await createTestDb();
  const e = await createUser(tdb, "editor@rules-save.example.com");
  const v = await createUser(tdb, "viewer@rules-save.example.com");
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ws, e.id, v.id]);
  editor = tdb.dbAs(e.claims as never);
  viewer = tdb.dbAs(v.claims as never);
});
afterAll(async () => {
  await tdb?.close();
});
beforeEach(async () => {
  await tdb.client.query("delete from analysis_rules where workspace_id = $1", [ws]);
});

const doc = { rules: { busy: { inputs: [0.6, 0.8, 0.9] } } };
const stored = async () => (await tdb.client.query("select settings from analysis_rules where workspace_id = $1", [ws])).rows[0] as { settings: unknown } | undefined;
const seed = (settings: unknown) => tdb.client.query("insert into analysis_rules (workspace_id, settings) values ($1, $2)", [ws, JSON.stringify(settings)]);

describe("loadAnalysisRules", () => {
  it("is all defaults with no row, and reads and cleans a stored one", async () => {
    expect(await loadAnalysisRules(viewer, ws)).toEqual({ settings: {}, version: null });
    await seed({ ...doc, junk: 1, rules: { ...doc.rules, nope: {} } });
    const loaded = await loadAnalysisRules(viewer, ws);
    expect(loaded.settings).toEqual(doc);
    expect(loaded.version).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("saveAnalysisRules", () => {
  it("inserts the first save and updates later ones against the version it was given", async () => {
    const first = await saveAnalysisRules(editor, ws, doc, null);
    expect(first.status).toBe("saved");
    if (first.status !== "saved") return;
    expect(first.rules.settings).toEqual(doc);
    const second = await saveAnalysisRules(editor, ws, {}, first.rules.version);
    expect(second.status).toBe("saved");
    expect((await stored())?.settings).toEqual({});
  });

  it("reports a conflict, with their rules, when someone saved since", async () => {
    await seed(doc);
    const theirs = (await loadAnalysisRules(editor, ws)).version;
    const stale = await saveAnalysisRules(editor, ws, { escalators: { badMonth: false } }, "2020-01-01T00:00:00+00:00");
    expect(stale).toEqual({ status: "conflict", rules: { settings: doc, version: theirs } });
    expect((await stored())?.settings).toEqual(doc);
    // Two first saves: the second finds the row already there.
    expect((await saveAnalysisRules(editor, ws, {}, null)).status).toBe("conflict");
  });

  it("is forbidden when the write isn't allowed", async () => {
    const insert = await saveAnalysisRules(viewer, ws, doc, null);
    expect(insert.status).toBe("forbidden");
    await seed({});
    const version = (await loadAnalysisRules(viewer, ws)).version;
    const update = await saveAnalysisRules(viewer, ws, doc, version);
    expect(update.status).toBe("forbidden");
    expect((await stored())?.settings).toEqual({});
  });

  it("rejects a document that isn't valid without touching the table", async () => {
    const out = await saveAnalysisRules(editor, ws, { rules: { busy: { inputs: [0.9, 0.5, 0.1] } } }, null);
    expect(out.status).toBe("invalid");
    expect(await stored()).toBeUndefined();
  });
});
