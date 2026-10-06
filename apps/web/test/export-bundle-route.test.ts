import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /w/<slug>/export/bundle (issue #39, B10): only agency admins, owners and editors (403 for anyone else, nothing read), as a download, nothing cached, and no detail in errors.

const state = { env: true, claims: { claims: { sub: "u1" } } as { claims?: { sub?: string } } | null, workspace: { id: "w1" } as { id: string } | null, bundle: { format: "transpera-workspace/1", workspace: { id: "w1" } } as unknown, boom: false, big: false, canEdit: true, seen: [] as unknown[] };

vi.mock("@/lib/supabase/env", () => ({ supabaseEnv: () => (state.env ? { url: "x", key: "y" } : null) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: state.claims }) },
    rpc: async () => ({ data: state.canEdit }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.workspace, error: null }) }) }) }),
  }),
}));
vi.mock("@transpera-flow/db", async (orig) => ({
  ...(await orig<typeof import("@transpera-flow/db")>()),
  exportWorkspaceBundle: async (_id: string, _a: unknown, _b: unknown, options: unknown) => {
    state.seen.push(options);
    if (state.big) throw new (await orig<typeof import("@transpera-flow/db")>()).BundleTooLargeError("x");
    if (state.boom) throw new Error("select * from secret_table failed");
    return state.bundle;
  },
  supabaseReader: () => async () => [],
  supabaseWorkspaceReader: () => async () => null,
}));

const call = async (slug = "northbeam") => {
  const { GET } = await import("@/app/w/[slug]/export/bundle/route");
  return GET(new Request("http://localhost/x"), { params: Promise.resolve({ slug }) } as never);
};

beforeEach(() => {
  state.env = true;
  state.claims = { claims: { sub: "u1" } };
  state.workspace = { id: "w1" };
  state.bundle = { format: "transpera-workspace/1", workspace: { id: "w1" } };
  state.boom = false;
  state.big = false;
  state.canEdit = true;
  state.seen = [];
});

describe("bundle route", () => {
  it("sends the bundle as a private, uncached download", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="northbeam-workspace-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await r.json()).format).toBe("transpera-workspace/1");
  });

  it("makes a file name from the slug that can't break the header", async () => {
    const r = await call('a"b\r\nSet-Cookie: x');
    expect(r.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(r.headers.get("content-disposition")).toMatch(/filename="a-b--Set-Cookie--x-workspace/);
  });

  it("refuses without a session, and answers 404 alike for a workspace the user can't read or that doesn't exist", async () => {
    state.claims = null;
    expect((await call()).status).toBe(401);
    state.claims = { claims: { sub: "u1" } };
    state.workspace = null;
    expect((await call()).status).toBe(404);
    state.workspace = { id: "w1" };
    state.bundle = null;
    expect((await call()).status).toBe(404);
  });

  it("says nothing about why an export failed", async () => {
    state.boom = true;
    const r = await call();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret_table");
  });

  it("refuses anyone who can't edit with 403 and reads nothing", async () => {
    state.canEdit = false;
    const r = await call();
    expect(r.status).toBe(403);
    expect((await r.json()).message).toBe("Only owners, editors and agency admins can export the workspace.");
    expect(state.seen).toEqual([]);
  });

  it("exports everything for someone who can edit, and says so when a workspace is too large", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(state.seen).toEqual([expect.objectContaining({ canEdit: true })]);
    state.big = true;
    const big = await call();
    expect(big.status).toBe(413);
    expect((await big.json()).message).toMatch(/too large/);
  });

  it("answers a non-member 404 before any role check", async () => {
    state.workspace = null;
    state.canEdit = false;
    expect((await call()).status).toBe(404);
    expect(state.seen).toEqual([]);
  });

  it("has nothing to export in the demo", async () => {
    state.env = false;
    expect((await call()).status).toBe(503);
  });
});
