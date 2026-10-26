import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleTooLargeError, NORTHBEAM_WORKSPACE_ID } from "@transpera-flow/db";
import type { Claims } from "@transpera-flow/db/client";
import type { Db } from "@transpera-flow/db";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// GET /w/<slug>/export/bundle (issue #39, B10): only agency admins, owners and editors (403 for anyone else, nothing read), as a download, nothing cached, and no detail in errors.
// Runs against a throwaway Postgres as the signed-in user (row-level security decides what can be read); only the session module is replaced.

let tdb: TestDb;
const state = {
  user: null as { id: string; email: string; agencyAdmin: boolean } | null,
  claims: null as Claims | null,
  /** Wraps the Db the route gets, to make a query fail or answer nothing at a chosen point. */
  wrap: null as ((db: Db) => Db) | null,
};

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => state.user,
  getDb: async () => {
    const db = tdb.dbAs(state.claims);
    return state.wrap ? state.wrap(db) : db;
  },
}));

let owner: { id: string };
let editor: { id: string };
let member: { id: string };
let viewer: { id: string };
let stranger: { id: string };
let agency: { id: string };

const as = (u: { id: string }, email: string, agencyAdmin = false) => {
  state.user = { id: u.id, email, agencyAdmin };
  state.claims = { sub: u.id, role: "authenticated", email, app_metadata: { agency_admin: agencyAdmin } };
};

/** A Db whose queries on `table` go through `fn(nth)` (1-based count of selects on it): it may throw, or return rows to answer instead. */
const onTable = (table: string, fn: (nth: number) => Error | unknown[] | null) => (db: Db): Db => {
  let nth = 0;
  const tables = new WeakMap<object, boolean>();
  return db.withPlugin({
    transformQuery(args) {
      // A select that names the table, whether the reader built it with the builder or as raw SQL.
      const text = JSON.stringify(args.node, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      const isSelect = args.node.kind === "SelectQueryNode" || args.node.kind === "RawNode";
      if (isSelect && new RegExp(`"(name|sqlFragments)":\\s*(\\[[^\\]]*)?"?[^"]*\\b${table}\\b`).test(text)) tables.set(args.queryId, true);
      return args.node;
    },
    async transformResult(args) {
      if (!tables.get(args.queryId)) return args.result;
      const out = fn(++nth);
      if (out instanceof Error) throw out;
      return out ? { ...args.result, rows: out as never[] } : args.result;
    },
  }) as Db;
};

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("BETTER_AUTH_SECRET", "unused");
  tdb = await createTestDb();
  const mk = async (name: string, role?: string, meta: Record<string, unknown> = {}) => {
    const u = await createUser(tdb, `${name}-${randomUUID().slice(0, 6)}@export-route.example.com`, meta);
    if (role) await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [NORTHBEAM_WORKSPACE_ID, u.id, role]);
    return u;
  };
  owner = await mk("owner", "owner");
  editor = await mk("editor", "editor");
  member = await mk("member", "member");
  viewer = await mk("viewer", "viewer");
  stranger = await mk("stranger");
  agency = await mk("agency", undefined, { agency_admin: true });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await tdb?.close();
});

beforeEach(() => {
  as(editor, "editor@export-route.example.com");
  state.wrap = null;
});

const call = async (slug = "northbeam") => {
  const { GET } = await import("@/app/w/[slug]/export/bundle/route");
  return GET(new Request("http://localhost/x"), { params: Promise.resolve({ slug }) } as never);
};

describe("bundle route", () => {
  it("sends the bundle as a private, uncached download", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="northbeam-workspace-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const bundle = await r.json();
    expect(bundle.format).toBe("transpera-workspace/1");
    expect(bundle.workspace.id).toBe(NORTHBEAM_WORKSPACE_ID);
  });

  it("makes a file name from the slug that can't break the header", async () => {
    // The database only allows plain slugs, so lift that rule in this throwaway database: the header must be safe whatever the slug.
    await tdb.client.query("alter table workspaces drop constraint workspaces_slug_check");
    await tdb.client.query("insert into workspaces (id, name, slug) values ($1, 'Odd', $2)", ["a0000000-0000-4000-8000-0000000000f1", 'a"b\r\nSet-Cookie: x']);
    as(agency, "agency@export-route.example.com", true);
    const r = await call('a"b\r\nSet-Cookie: x');
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(r.headers.get("content-disposition")).toMatch(/filename="a-b--Set-Cookie--x-workspace/);
  });

  it("refuses without a session, and answers 404 alike for a workspace the user can't read or that doesn't exist", async () => {
    state.user = null;
    state.claims = null;
    expect((await call()).status).toBe(401);
    as(stranger, "stranger@export-route.example.com");
    expect((await call()).status).toBe(404);
    as(editor, "editor@export-route.example.com");
    expect((await call("no-such-workspace")).status).toBe(404);
    // The workspace was readable a moment ago but the export finds nothing: also 404.
    state.wrap = onTable("workspaces", (nth) => (nth >= 2 ? [] : null));
    expect((await call()).status).toBe(404);
  });

  it("says nothing about why an export failed", async () => {
    state.wrap = onTable("processes", () => new Error("select * from secret_table failed"));
    const r = await call();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret_table");
  });

  it.each([
    ["a member", () => member],
    ["a viewer", () => viewer],
  ])("refuses %s with 403 and reads nothing", async (_who, who) => {
    as(who(), "x@export-route.example.com");
    // Reading anything of the workspace would reach the processes table; it must not.
    let reads = 0;
    state.wrap = onTable("processes", () => (++reads, null));
    const r = await call();
    expect(r.status).toBe(403);
    expect((await r.json()).message).toBe("Only owners, editors and agency admins can export the workspace.");
    expect(reads).toBe(0);
  });

  it("exports everything for an owner, an editor or an agency admin, and says so when a workspace is too large", async () => {
    for (const [u, admin] of [[owner, false], [editor, false], [agency, true]] as const) {
      as(u, "x@export-route.example.com", admin);
      const r = await call();
      expect(r.status).toBe(200);
      expect((await r.json()).scope).toBe("everything");
    }
    state.wrap = onTable("processes", () => new BundleTooLargeError("x"));
    const big = await call();
    expect(big.status).toBe(413);
    expect((await big.json()).message).toMatch(/too large/);
  });

  it("answers a non-member 404 before any role check", async () => {
    as(stranger, "stranger@export-route.example.com");
    expect((await call()).status).toBe(404);
  });

  it("has nothing to export in the demo", async () => {
    vi.stubEnv("DATABASE_URL", "");
    try {
      expect((await call()).status).toBe(503);
    } finally {
      vi.stubEnv("DATABASE_URL", "postgres://unused");
    }
  });
});
