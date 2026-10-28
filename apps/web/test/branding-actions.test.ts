import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, signInAs, signOut, type World } from "./action-harness";

// The server half of client branding (issue #34, B5): a failing accent is refused with the nearest passing colour in the message
// and never reaches the database; a passing one is saved lower-cased under `branding.accent` or `branding.accent_dark`; a logo
// is checked by content, then its bytes are kept in `workspace_logos` (step 4) against the hash of the one it replaces. The
// workspace row is in a real database (the owner changes it, anyone else is told they may not); the table's policies themselves
// are tested in packages/db/test/workspace-logos.test.ts.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const { attachWorkspaceLogo, removeWorkspaceLogo, saveBrandAccent } = await import("@/app/w/[slug]/settings/branding/actions");

const OTHER = "a0000000-0000-4000-8000-000000000002";
let world: World;
let WS: string;

beforeAll(async () => {
  world = await createWorld("brandco");
  WS = world.workspaceId;
}, 120_000);

afterAll(async () => {
  await world?.tdb.close();
});

const branding = async () => (await world.tdb.client.query("select branding from workspaces where id = $1", [WS])).rows[0].branding as Record<string, unknown>;
const setBranding = (value: Record<string, unknown>) => world.tdb.client.query("update workspaces set branding = $2::jsonb where id = $1", [WS, JSON.stringify(value)]);
const logoRow = async () => (await world.tdb.client.query("select mime, bytes, sha256 from workspace_logos where workspace_id = $1", [WS])).rows[0] as { mime: string; bytes: Buffer; sha256: string } | undefined;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** What the browser sends: the workspace, the hash of the logo it replaces (blank for none) and the file. */
const form = (workspaceId: string, base: string | null, bytes: Uint8Array | null, name = "logo.png") => {
  const f = new FormData();
  f.set("workspaceId", workspaceId);
  f.set("base", base ?? "");
  if (bytes) f.set("file", new File([new Uint8Array(bytes)], name));
  return f;
};
/** A logo already kept, put there as the owner of the database (no RLS). */
const keep = async (bytes: Uint8Array) => {
  await world.tdb.client.query("insert into workspace_logos (workspace_id, mime, bytes, sha256) values ($1, 'image/png', $2, $3) on conflict (workspace_id) do update set mime = excluded.mime, bytes = excluded.bytes, sha256 = excluded.sha256", [WS, Buffer.from(bytes), sha(bytes)]);
  return sha(bytes);
};

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const pngBytes = (w = 64, h = 64) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...u32(w), ...u32(h), 8, 6, 0, 0, 0]), ...chunk("IDAT", [0]), ...chunk("IEND", [])]);
const jpegBytes = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 64, 0, 64, 1, 0x11, 0, 0xff, 0xda, 0x00, 0x02]);

beforeEach(async () => {
  await setBranding({});
  await world.tdb.client.query("delete from workspace_logos");
  signInAs(world, "owner");
});

describe("saveBrandAccent", () => {
  it("refuses a failing accent with the nearest passing colour in the message, and does not call the database", async () => {
    const out = await saveBrandAccent(WS, "light", null, "#ffff00");
    expect(out.status).toBe("error");
    if (out.status !== "error") return;
    expect(out.message).toMatch(/^Too light to read on a white page: \d\.\d:1, and text needs 4\.5:1\. Try #[0-9a-f]{6}, the nearest darker shade\.$/);
    expect(await branding()).toEqual({});
    // The suggestion it names is accepted.
    const hex = /#[0-9a-f]{6}/.exec(out.message)![0];
    expect((await saveBrandAccent(WS, "light", null, hex)).status).toBe("saved");
    expect(await branding()).toMatchObject({ accent: hex });
  });

  it("refuses a too-dark dark accent with a lighter one", async () => {
    const out = await saveBrandAccent(WS, "dark", null, "#000080");
    expect(out).toMatchObject({ status: "error", message: expect.stringMatching(/^Too dark to read on the dark page: .*nearest lighter shade\.$/) });
    expect(await branding()).toEqual({});
  });

  it("refuses what isn't a colour, with the words from the brief, and no database call", async () => {
    for (const bad of ["red", "#abcd", "rgb(1,2,3)", "", "#gg0000"]) {
      expect(await saveBrandAccent(WS, "light", null, bad), bad).toEqual({ status: "error", message: "Enter a colour as six hex digits, like #0b6e8a." });
    }
    expect(await branding()).toEqual({});
  });

  it("refuses malformed arguments", async () => {
    const invalid = { status: "error", message: "That value isn't valid." };
    expect(await saveBrandAccent("nope", "light", null, "#0b6e8a")).toEqual(invalid);
    expect(await saveBrandAccent(WS, "sepia" as never, null, "#0b6e8a")).toEqual(invalid);
    expect(await saveBrandAccent(WS, "light", 5 as never, "#0b6e8a")).toEqual(invalid);
    expect(await saveBrandAccent(WS, "light", null, 5 as never)).toEqual(invalid);
    expect(await branding()).toEqual({});
  });

  it("saves a passing accent lower-cased under branding.accent, checked against the base", async () => {
    await setBranding({ accent: "#007595" });
    expect(await saveBrandAccent(WS, "light", "#007595", "0B6E8A")).toEqual({ status: "saved", value: "#0b6e8a" });
    expect(await branding()).toEqual({ accent: "#0b6e8a" });
  });

  it("the dark theme saves branding.accent_dark", async () => {
    expect(await saveBrandAccent(WS, "dark", null, "#4CC3E0")).toEqual({ status: "saved", value: "#4cc3e0" });
    expect(await branding()).toEqual({ accent_dark: "#4cc3e0" });
  });

  it("null resets, with no contrast check", async () => {
    await setBranding({ accent: "#0b6e8a" });
    expect(await saveBrandAccent(WS, "light", "#0b6e8a", null)).toEqual({ status: "saved", value: null });
    expect((await branding()).accent ?? null).toBeNull();
  });

  it("passes on a conflict, a refused (viewer) save and a session that has ended", async () => {
    await setBranding({ accent: "#123456" });
    expect(await saveBrandAccent(WS, "light", null, "#0b6e8a")).toEqual({ status: "conflict", theirs: "#123456" });
    expect(await branding()).toEqual({ accent: "#123456" });
    // A viewer may not change the branding.
    signInAs(world, "viewer");
    expect(await saveBrandAccent(WS, "light", "#123456", "#0b6e8a")).toEqual({ status: "not_found" });
    expect(await branding()).toEqual({ accent: "#123456" });
    signOut(world);
    expect(await saveBrandAccent(WS, "light", null, "#0b6e8a")).toMatchObject({ status: "error", message: expect.stringMatching(/session has ended/) });
  });
});

describe("attachWorkspaceLogo", () => {
  it("refuses malformed form data", async () => {
    const invalid = { status: "error", message: "That value isn't valid." };
    expect(await attachWorkspaceLogo(null)).toEqual(invalid);
    expect(await attachWorkspaceLogo({ workspaceId: WS })).toEqual(invalid);
    expect(await attachWorkspaceLogo(form("nope", null, pngBytes()))).toEqual(invalid);
    expect(await attachWorkspaceLogo(form(WS, "not-a-hash", pngBytes()))).toEqual(invalid);
    expect(await attachWorkspaceLogo(form(WS, null, null))).toEqual(invalid);
    expect(await logoRow()).toBeUndefined();
  });

  it("keeps a checked logo as bytes, with its type and hash, and answers with the hash and the route's URL", async () => {
    const bytes = pngBytes();
    const out = await attachWorkspaceLogo(form(WS, null, bytes));
    expect(out).toEqual({ status: "ok", sha: sha(bytes), url: `/api/branding/${WS}/logo?v=${sha(bytes).slice(0, 12)}` });
    const row = await logoRow();
    expect(row?.mime).toBe("image/png");
    expect(row?.sha256).toBe(sha(bytes));
    expect(new Uint8Array(row!.bytes)).toEqual(bytes);
    // The branding column keeps no logo path.
    expect(await branding()).toEqual({});
  });

  it("stores the type the bytes say, whatever the file is called", async () => {
    const bytes = jpegBytes();
    expect((await attachWorkspaceLogo(form(WS, null, bytes, "logo.png"))).status).toBe("ok");
    expect((await logoRow())?.mime).toBe("image/jpeg");
  });

  it("replaces a logo against the hash of the one it replaces", async () => {
    const old = await keep(pngBytes(32, 32));
    const next = pngBytes(64, 64);
    expect(await attachWorkspaceLogo(form(WS, old, next))).toMatchObject({ status: "ok", sha: sha(next) });
    expect((await logoRow())?.sha256).toBe(sha(next));
  });

  it("on a conflict says so, and the logo someone else kept stays (for a first logo too)", async () => {
    const theirs = await keep(pngBytes(48, 48));
    const changed = { status: "error", message: "Someone else changed the logo. Reload to see it." };
    expect(await attachWorkspaceLogo(form(WS, "0".repeat(64), pngBytes()))).toEqual(changed);
    expect(await attachWorkspaceLogo(form(WS, null, pngBytes()))).toEqual(changed);
    expect((await logoRow())?.sha256).toBe(theirs);
  });

  it("refuses bad content, SVG included, and keeps nothing", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await attachWorkspaceLogo(form(WS, null, svg, "logo.svg"))).toMatchObject({ status: "error", message: expect.stringMatching(/^Use a PNG, JPG or WebP image/) });
    expect(await logoRow()).toBeUndefined();
  });

  it("refuses an image that is too large in pixels", async () => {
    expect(await attachWorkspaceLogo(form(WS, null, pngBytes(5000, 5000)))).toEqual({ status: "error", message: "That image is too large: up to 2048 × 2048 pixels." });
    expect(await logoRow()).toBeUndefined();
  });

  it("refuses a file over 512 KB, and takes one of exactly 512 KB", async () => {
    expect(await attachWorkspaceLogo(form(WS, null, new Uint8Array(524_289)))).toEqual({ status: "error", message: "That image is over 512 KB." });
    expect(await logoRow()).toBeUndefined();
    const edge = new Uint8Array(524_288);
    edge.set(pngBytes());
    expect((await attachWorkspaceLogo(form(WS, null, edge))).status).toBe("ok");
  });

  it("only Agency admins and the Owner may change the logo", async () => {
    signInAs(world, "viewer");
    expect(await attachWorkspaceLogo(form(WS, null, pngBytes()))).toMatchObject({ status: "error", message: expect.stringMatching(/Only Agency admins/) });
    signInAs(world, "viewer");
    expect(await attachWorkspaceLogo(form(WS, null, pngBytes()))).toMatchObject({ status: "error", message: expect.stringMatching(/Only Agency admins/) });
    expect(await logoRow()).toBeUndefined();
    signInAs(world, "admin");
    expect((await attachWorkspaceLogo(form(WS, null, pngBytes()))).status).toBe("ok");
  });

  it("asks for a signed-in person", async () => {
    signOut(world);
    expect(await attachWorkspaceLogo(form(WS, null, pngBytes()))).toMatchObject({ status: "error", message: expect.stringMatching(/session has ended/) });
    expect(await logoRow()).toBeUndefined();
  });

  it("another workspace's id changes nothing here", async () => {
    expect((await attachWorkspaceLogo(form(OTHER, null, pngBytes()))).status).toBe("error");
    expect(await logoRow()).toBeUndefined();
  });
});

describe("removeWorkspaceLogo", () => {
  it("deletes the logo if it is still the one the person saw", async () => {
    const old = await keep(pngBytes());
    expect(await removeWorkspaceLogo(WS, old)).toEqual({ status: "ok", sha: null, url: null });
    expect(await logoRow()).toBeUndefined();
  });

  it("leaves a logo someone else changed, and one a viewer may not remove", async () => {
    const old = await keep(pngBytes());
    expect(await removeWorkspaceLogo(WS, "0".repeat(64))).toEqual({ status: "error", message: "Someone else changed the logo. Reload to see it." });
    signInAs(world, "viewer");
    expect(await removeWorkspaceLogo(WS, old)).toMatchObject({ status: "error", message: expect.stringMatching(/Only Agency admins/) });
    expect((await logoRow())?.sha256).toBe(old);
  });

  it("is in the change log: adding, replacing and removing a logo each write an audit entry on the workspace, as the person", async () => {
    await world.tdb.client.query("delete from audit_log where workspace_id = $1", [WS]);
    const first = await attachWorkspaceLogo(form(WS, null, pngBytes()));
    const second = await attachWorkspaceLogo(form(WS, first.status === "ok" ? first.sha : null, pngBytes(32, 32)));
    expect(second.status).toBe("ok");
    expect((await removeWorkspaceLogo(WS, second.status === "ok" ? second.sha : null)).status).toBe("ok");
    const { rows } = await world.tdb.client.query("select actor_id, action, target_table, diff from audit_log where workspace_id = $1 order by created_at, id", [WS]);
    const [a, b] = [sha(pngBytes()), sha(pngBytes(32, 32))];
    const entry = (before: string | null, after: string | null) => ({
      actor_id: world.users.owner.id,
      action: "update",
      target_table: "workspaces",
      diff: { old: { branding: before ? { logo_sha256: before } : {} }, new: { branding: after ? { logo_sha256: after } : {} } },
    });
    expect(rows).toEqual([entry(null, a), entry(a, b), entry(b, null)]);
  });

  it("refuses what isn't a hash", async () => {
    expect(await removeWorkspaceLogo(WS, null)).toEqual({ status: "error", message: "That value isn't valid." });
    expect(await removeWorkspaceLogo(WS, `${OTHER}/x.png`)).toEqual({ status: "error", message: "That value isn't valid." });
  });
});
