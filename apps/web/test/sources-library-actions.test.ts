import { beforeEach, describe, expect, it, vi } from "vitest";

// The Server Actions behind the Sources library and the Editor tour (issue #176, B18): what they check before they ask the
// database, what they ask it (the search is passed as a value, never built into a filter string), and what they say when it fails.

const rpc = vi.fn();
const upsert = vi.fn();
const maybeSingle = vi.fn();
let signedIn = true;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: signedIn ? { claims: { sub: "user-1" } } : null }) },
    rpc,
    from: (table: string) => ({
      upsert: (...args: unknown[]) => upsert(table, ...args),
      select: () => ({ eq: () => ({ maybeSingle }) }),
    }),
  }),
}));

const { searchSourcesPage, readSourceBody } = await import("@/app/w/[slug]/source-actions");
const { dismissEditorTour } = await import("@/app/w/[slug]/tour-actions");
const { liveLibraryBackend } = await import("@/lib/sources/library-backend");
const { DEFAULT_QUERY } = await import("@/lib/sources/library");

const WS = "11111111-1111-4111-8111-111111111111";
const PROCESS = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  rpc.mockReset();
  upsert.mockReset();
  maybeSingle.mockReset();
  signedIn = true;
});

describe("searching the library", () => {
  it("passes the words, filters and page to the database as values, and drops the full text of nothing it didn't get", async () => {
    rpc.mockResolvedValue({
      data: [
        { id: "a", title: "A", kind: "sop", excerpt: "x", has_body: true, total: 7 },
        { id: "b", title: "B", kind: "sop", excerpt: "", has_body: false, total: 7 },
      ],
      error: null,
    });
    const nasty = `x') or true --, %_\\`;
    const r = await searchSourcesPage(WS, { ...DEFAULT_QUERY, search: nasty, kind: "sop", processId: PROCESS, unlinkedOnly: true, sort: "title" }, 50, 25);
    expect(rpc).toHaveBeenCalledWith("search_sources", {
      p_workspace: WS,
      p_search: nasty,
      p_kind: "sop",
      p_process: PROCESS,
      p_unlinked: true,
      p_sort: "title",
      p_limit: 25,
      p_offset: 50,
    });
    expect(r).toEqual({
      status: "ok",
      total: 7,
      rows: [
        { id: "a", title: "A", kind: "sop", excerpt: "x", has_body: true },
        { id: "b", title: "B", kind: "sop", excerpt: "", has_body: false },
      ],
    });
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
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps a page to at most 200 rows", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await searchSourcesPage(WS, DEFAULT_QUERY, 0, 100000);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_limit: 50 });
  });

  it("says so when signed out or when the database fails, and the backend turns that into an error", async () => {
    signedIn = false;
    expect(await searchSourcesPage(WS, DEFAULT_QUERY, 0, 50)).toMatchObject({ status: "error" });
    signedIn = true;
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await searchSourcesPage(WS, DEFAULT_QUERY, 0, 50)).toEqual({ status: "error", message: "Couldn't load the sources. Try again." });
    await expect(liveLibraryBackend(WS).search(DEFAULT_QUERY, 0)).rejects.toThrow("Couldn't load the sources");
  });
});

describe("reading a source's text", () => {
  it("reads one source's text on its own", async () => {
    maybeSingle.mockResolvedValue({ data: { body: "the whole text" }, error: null });
    expect(await readSourceBody(WS)).toEqual({ status: "ok", body: "the whole text" });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await readSourceBody(WS)).toEqual({ status: "ok", body: null });
    expect((await readSourceBody("not-an-id")).status).toBe("error");
  });
});

describe("dismissing the tour", () => {
  it("saves a dismissal for the signed-in person, once however often", async () => {
    upsert.mockResolvedValue({ error: null });
    expect(await dismissEditorTour("process")).toEqual({ status: "ok" });
    expect(upsert).toHaveBeenCalledWith("user_tours", { tour: "process" }, { onConflict: "user_id,tour", ignoreDuplicates: true });
  });

  it("refuses an unknown tour, and says so when signed out or when saving fails", async () => {
    expect((await dismissEditorTour("everything")).status).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
    signedIn = false;
    expect((await dismissEditorTour("company")).status).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
    signedIn = true;
    upsert.mockResolvedValue({ error: { message: "boom" } });
    expect((await dismissEditorTour("company")).status).toBe("error");
  });
});
