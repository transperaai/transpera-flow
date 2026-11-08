import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamSourceIds } from "@transpera-flow/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signInWithBrokenDb, signOut, type TestUser } from "./action-harness";

// The Server Actions behind the Sources library and the Editor tour (issue #176, B18): what they check before they ask the
// database, what they ask it (the search is passed as a value, never built into a filter string), and what they say when it fails.
// Run against a real database with the seeded Northbeam workspace and its two sources.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const { searchSourcesPage, readSourceBody } = await import("@/app/w/[slug]/source-actions");
const { dismissEditorTour } = await import("@/app/w/[slug]/tour-actions");
const { liveLibraryBackend } = await import("@/lib/sources/library-backend");
const { DEFAULT_QUERY } = await import("@/lib/sources/library");

const WS = NORTHBEAM_WORKSPACE_ID;
const PROCESS = "22222222-2222-4222-8222-222222222222";

let tdb: TestDb;
let editor: TestUser;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(() => {
  signInAs({ tdb }, editor);
});

describe("searching the library", () => {
  it("passes the words, filters and page to the database as values, and drops the full text of nothing it didn't get", async () => {
    // Whatever the words are, they are matched as plain text: this finds nothing and fails nothing.
    const nasty = `x') or true --, %_\\`;
    expect(await searchSourcesPage(WS, { ...DEFAULT_QUERY, search: nasty, kind: "sop", processId: PROCESS, unlinkedOnly: true, sort: "title" }, 50, 25)).toEqual({ status: "ok", total: 0, rows: [] });
    // The filters and the paging do their work: every source, then the title search, then the second page of one.
    const all = await searchSourcesPage(WS, { ...DEFAULT_QUERY, sort: "title" }, 0, 25);
    expect(all).toMatchObject({ status: "ok", total: 2 });
    if (all.status !== "ok") return;
    expect(all.rows.map((r) => r.id).sort()).toEqual([northbeamSourceIds.strategyInterview, northbeamSourceIds.salesNotes].sort());
    expect(all.rows[0]).toEqual({ ...all.rows[0], title: expect.any(String), kind: expect.any(String), excerpt: expect.any(String), has_body: expect.any(Boolean) });
    expect(all.rows[0]).not.toHaveProperty("body");
    expect(all.rows[0]).not.toHaveProperty("total");
    const named = all.rows[0]!.title;
    const found = await searchSourcesPage(WS, { ...DEFAULT_QUERY, search: named }, 0, 25);
    expect(found).toMatchObject({ status: "ok", total: expect.any(Number) });
    if (found.status === "ok") expect(found.rows.map((r) => r.title)).toContain(named);
    const second = await searchSourcesPage(WS, { ...DEFAULT_QUERY, sort: "title" }, 1, 1);
    expect(second).toMatchObject({ status: "ok", total: 2 });
    if (second.status === "ok") expect(second.rows.map((r) => r.id)).toEqual([all.rows[1]!.id]);
  });

  it("asks nothing when what arrived isn't a query, a workspace, or a page", async () => {
    for (const [ws, q, offset, limit] of [
      ["nope", DEFAULT_QUERY, 0, 50],
      [WS, null, 0, 50],
      [WS, { ...DEFAULT_QUERY, kind: "video" }, 0, 50],
      [WS, DEFAULT_QUERY, -1, 50],
      [WS, DEFAULT_QUERY, 1.5, 50],
      [WS, DEFAULT_QUERY, "0", 50],
    ] as const) {
      expect((await searchSourcesPage(ws, q, offset, limit)).status).toBe("error");
    }
  });

  it("keeps a page to at most 200 rows", async () => {
    await tdb.client.query("insert into sources (workspace_id, kind, title, body) select $1, 'notes', 'Bulk ' || n, 'x' from generate_series(1, 60) n", [WS]);
    // Over the limit it falls back to the library's page of 50.
    const r = await searchSourcesPage(WS, DEFAULT_QUERY, 0, 100000);
    expect(r).toMatchObject({ status: "ok", total: 62 });
    if (r.status === "ok") expect(r.rows).toHaveLength(50);
    const some = await searchSourcesPage(WS, DEFAULT_QUERY, 0, 200);
    if (some.status === "ok") expect(some.rows).toHaveLength(62);
    await tdb.client.query("delete from sources where title like 'Bulk %'");
  });

  it("says so when signed out or when the database fails, and the backend turns that into an error", async () => {
    signOut({ tdb });
    expect(await searchSourcesPage(WS, DEFAULT_QUERY, 0, 50)).toMatchObject({ status: "error" });
    // Signed in, but the database refuses the call (a role that can't run it).
    signInWithBrokenDb({ tdb }, editor);
    expect(await searchSourcesPage(WS, DEFAULT_QUERY, 0, 50)).toEqual({ status: "error", message: "Couldn't load the sources. Try again." });
    await expect(liveLibraryBackend(WS).search(DEFAULT_QUERY, 0)).rejects.toThrow("Couldn't load the sources");
  });
});

describe("reading a source's text", () => {
  it("reads one source's text on its own", async () => {
    const stored = (await tdb.client.query("select body from sources where id = $1", [northbeamSourceIds.strategyInterview])).rows[0].body as string;
    expect(stored.length).toBeGreaterThan(0);
    expect(await readSourceBody(northbeamSourceIds.strategyInterview)).toEqual({ status: "ok", body: stored });
    expect(await readSourceBody("22222222-2222-4222-8222-222222222299")).toEqual({ status: "ok", body: null });
    expect((await readSourceBody("not-an-id")).status).toBe("error");
  });
});

describe("dismissing the tour", () => {
  const tours = async () => (await tdb.client.query("select user_id, tour from user_tours order by tour")).rows;

  it("saves a dismissal for the signed-in person, once however often", async () => {
    expect(await dismissEditorTour("process")).toEqual({ status: "ok" });
    expect(await dismissEditorTour("process")).toEqual({ status: "ok" });
    expect(await tours()).toEqual([{ user_id: editor.id, tour: "process" }]);
  });

  it("refuses an unknown tour, and says so when signed out or when saving fails", async () => {
    const before = await tours();
    expect((await dismissEditorTour("everything")).status).toBe("error");
    signOut({ tdb });
    expect((await dismissEditorTour("company")).status).toBe("error");
    signInWithBrokenDb({ tdb }, editor);
    expect((await dismissEditorTour("company")).status).toBe("error");
    expect(await tours()).toEqual(before);
  });
});
