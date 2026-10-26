import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createWorld, signInAs, signOut, type World } from "./action-harness";

// The logo route (step 4): GET /api/branding/<workspace id>/logo serves the bytes in `workspace_logos` through the database
// function `workspace_logo(uuid)`, with the hash as its ETag, a 304 when it comes back, and a cache lifetime. Anyone may ask,
// signed out too (a share link's visitors see the logo): the proxy lets exactly this path through without a session cookie.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SHA = createHash("sha256").update(PNG).digest("hex");

const { GET } = await import("@/app/api/branding/[workspaceId]/logo/route");
const { proxy } = await import("@/proxy");

let world: World;
let WS: string;

beforeAll(async () => {
  world = await createWorld("logoroute");
  WS = world.workspaceId;
}, 120_000);

afterAll(async () => {
  await world?.tdb.close();
});

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://example/none");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-of-some-length-0123456789");
  await world.tdb.client.query("delete from workspace_logos");
  signOut(world);
});

const keep = (bytes = PNG, mime = "image/png") =>
  world.tdb.client.query("insert into workspace_logos (workspace_id, mime, bytes, sha256) values ($1, $2, $3, $4)", [WS, mime, bytes, createHash("sha256").update(bytes).digest("hex")]);
const get = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/branding/${id}/logo?v=${SHA.slice(0, 12)}`, { headers }), { params: Promise.resolve({ workspaceId: id }) } as never);

describe("GET /api/branding/[workspaceId]/logo", () => {
  it("serves the logo to anyone, signed out too: its type, its bytes, the hash as ETag and a cache lifetime", async () => {
    await keep();
    const res = await get(WS);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toBe(`"${SHA}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), PNG)).toBe(0);
  });

  it("serves it to a signed-in person of any workspace as well, and the type it was stored with", async () => {
    await keep(PNG, "image/webp");
    signInAs(world, "stranger");
    const res = await get(WS.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  it("answers 304 with no body when the ETag comes back (also weak, or in a list), and 200 when it doesn't match", async () => {
    await keep();
    for (const header of [`"${SHA}"`, `W/"${SHA}"`, `"other", "${SHA}"`, "*"]) {
      const res = await get(WS, { "if-none-match": header });
      expect(res.status, header).toBe(304);
      expect(res.headers.get("etag"), header).toBe(`"${SHA}"`);
      expect(res.headers.get("cache-control"), header).toBe("public, max-age=300");
      expect(await res.text(), header).toBe("");
    }
    expect((await get(WS, { "if-none-match": '"0000"' })).status).toBe(200);
  });

  it("a replaced logo has a new ETag, so the old one no longer gets a 304", async () => {
    await keep();
    const next = Buffer.concat([PNG, Buffer.from([7])]);
    await world.tdb.client.query("update workspace_logos set bytes = $2, sha256 = $3 where workspace_id = $1", [WS, next, createHash("sha256").update(next).digest("hex")]);
    const res = await get(WS, { "if-none-match": `"${SHA}"` });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(`"${SHA}"`);
  });

  it("answers 404 for a workspace with no logo, one that doesn't exist, and an id that isn't one", async () => {
    expect((await get(WS)).status).toBe(404);
    expect((await get("a0000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await get("1; drop table workspaces")).status).toBe(404);
  });

  it("answers 404 in demo mode, where there is no database", async () => {
    await keep();
    vi.stubEnv("DATABASE_URL", "");
    expect((await get(WS)).status).toBe(404);
  });
});

describe("the proxy", () => {
  const through = (path: string) => proxy(new NextRequest(`http://localhost${path}`));
  const redirected = (path: string) => through(path).headers.get("location")?.replace(/\/$/, "").endsWith("/login") === true;

  it("lets the logo route through without a session cookie, and nothing else under /api/branding", () => {
    expect(redirected(`/api/branding/${WS}/logo`)).toBe(false);
    for (const path of ["/api/branding", "/api/branding/", `/api/branding/${WS}`, `/api/branding/${WS}/logo/x`, `/api/branding/${WS}/other`, "/api/branding/not-a-uuid/logo", `/api/branding/${WS}/../logo`, "/w/northbeam"]) {
      expect([path, redirected(path)], path).toEqual([path, true]);
    }
  });
});
