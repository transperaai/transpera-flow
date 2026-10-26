import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadIssuesForReader, loadLinkTargets, NORTHBEAM_WORKSPACE_ID, readerSeesPeople, type Db } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// What a member reads of issue keys (B1 2b, issue #30), against Postgres: `can_see_people` is decided by the caller's role
// (owners and editors see everyone; members, viewers and signed-out callers don't).

const WS = NORTHBEAM_WORKSPACE_ID;
const KEY = { ai: "ai:insight:0123456789ab", eng: "overtime:person:00000000-0000-4000-8000-000000000001", dismissed: "ai:insight:ba9876543210" };
const ID = {} as { ai: string; eng: string; dismissed: string };

let tdb: TestDb;
let owner: Db;
let member: Db;
let signedOut: Db;

beforeAll(async () => {
  tdb = await createTestDb();
  const o = await createUser(tdb, "owner@reader-issues.example.com");
  const m = await createUser(tdb, "member@reader-issues.example.com");
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member')", [WS, o.id, m.id]);
  owner = tdb.dbAs(o.claims as never);
  member = tdb.dbAs(m.claims as never);
  signedOut = tdb.dbAs(null);
  // The stored keys are inserted past the privacy trigger (as the owner role, which a migration's backfill also was).
  for (const [name, key, status] of [["ai", KEY.ai, "open"], ["eng", KEY.eng, "open"], ["dismissed", KEY.dismissed, "dismissed"]] as const) {
    const r = await tdb.client.query(
      "insert into issues (workspace_id, type, title, status, source, detected_key) values ($1, 'capacity', $2, $3, 'promoted', $4) returning id, detected_key",
      [WS, `Issue ${name}`, status, key],
    );
    ID[name] = r.rows[0].id;
    KEY[name] = r.rows[0].detected_key;
  }
});
afterAll(async () => {
  await tdb?.close();
});

describe("readerSeesPeople", () => {
  it("is true for a reader who sees everyone, and false for anyone else, including a caller the database refuses", async () => {
    expect(await readerSeesPeople(owner, WS)).toBe(true);
    expect(await readerSeesPeople(member, WS)).toBe(false);
    expect(await readerSeesPeople(signedOut, WS)).toBe(false);
  });
});

describe("loadIssuesForReader", () => {
  const keys = (issues: { id: string; detected_key: string | null }[]) => Object.fromEntries(issues.map((i) => [i.id, i.detected_key]));

  it("gives a reader who can't see everyone an opaque key for an AI insight, and leaves engine keys alone", async () => {
    const out = keys(await loadIssuesForReader(member, WS));
    expect(out[ID.ai]).toBe(`ai:insight:${ID.ai}`);
    expect(out[ID.dismissed]).toBe(`ai:insight:${ID.dismissed}`);
    expect(out[ID.eng]).toBe("overtime:person:00000000-0000-4000-8000-000000000001");
  });

  it("leaves every stored key for a reader who sees everyone", async () => {
    const out = keys(await loadIssuesForReader(owner, WS));
    expect(out[ID.ai]).toBe(KEY.ai);
    expect(out[ID.dismissed]).toBe(KEY.dismissed);
  });
});

describe("loadLinkTargets", () => {
  it("masks the insight keys of a reader who can't see everyone, leaves them for one who can, and skips dismissed insights", async () => {
    const hidden = (await loadLinkTargets(member, WS)).insights.map((i) => i.key);
    expect(hidden).toContain(`ai:insight:${ID.ai}`);
    expect(hidden).toContain(KEY.eng);
    expect(hidden).not.toContain(KEY.ai);
    expect(hidden).not.toContain(`ai:insight:${ID.dismissed}`);
    const open = (await loadLinkTargets(owner, WS)).insights.map((i) => i.key);
    expect(open).toContain(KEY.ai);
    expect(open).toContain(KEY.eng);
    expect(open).not.toContain(KEY.dismissed);
    expect(open).not.toContain(`ai:insight:${ID.ai}`);
  });
});
