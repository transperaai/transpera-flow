import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, signInAs, signOut, type World } from "./action-harness";

// The server half of client branding (issue #34, B5): a failing accent is refused with the nearest passing colour in the message
// and never reaches the database; a passing one is saved lower-cased under `branding.accent` or `branding.accent_dark`; a logo
// is read back as the signed-in user, checked by content, kept (deleting the logo it replaces) or deleted. The workspace row is in
// a real database (the owner changes it, anyone else is told they may not); Storage is faked until step 4 drops it: the policies
// themselves are tested in packages/db/test/branding.test.ts.

const fake = vi.hoisted(() => ({
  object: null as null | Blob,
  removed: [] as string[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
// Storage only (step 4): the database calls go to the real database.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    storage: {
      from: () => ({
        download: async () => (fake.object ? { data: fake.object, error: null } : { data: null, error: { message: "not found" } }),
        remove: async (paths: string[]) => {
          fake.removed.push(paths);
          return { data: [], error: null };
        },
      }),
    },
  }),
}));

const { attachWorkspaceLogo, removeWorkspaceLogo, saveBrandAccent } = await import("@/app/w/[slug]/settings/branding/actions");

const OTHER = "a0000000-0000-4000-8000-000000000002";
const U1 = "11111111-2222-4333-8444-555555555551";
const U2 = "11111111-2222-4333-8444-555555555552";
let world: World;
let WS: string;
let NEW: string;
let OLD: string;

beforeAll(async () => {
  world = await createWorld("brandco");
  WS = world.workspaceId;
  NEW = `${WS}/${U1}.png`;
  OLD = `${WS}/${U2}.png`;
}, 120_000);

afterAll(async () => {
  await world?.tdb.close();
});

/** The browser's upload to the branding bucket, as the database sees it: an object owned by the uploader (a logo path must name one). */
const upload = (path: string, owner = world.users.owner) =>
  world.tdb.client.query("insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ('branding', $1, $2::uuid, $2, '{\"size\": 1234, \"mimetype\": \"image/png\"}') on conflict do nothing", [path, owner.id]);
const branding = async () => (await world.tdb.client.query("select branding from workspaces where id = $1", [WS])).rows[0].branding as Record<string, unknown>;
const setBranding = (value: Record<string, unknown>) => world.tdb.client.query("update workspaces set branding = $2::jsonb where id = $1", [WS, JSON.stringify(value)]);

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const pngBytes = (w = 64, h = 64) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...u32(w), ...u32(h), 8, 6, 0, 0, 0]), ...chunk("IDAT", [0]), ...chunk("IEND", [])]);
const jpegBytes = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 64, 0, 64, 1, 0x11, 0, 0xff, 0xda, 0x00, 0x02]);

beforeEach(async () => {
  fake.object = null;
  fake.removed = [];
  await setBranding({});
  await world.tdb.client.query("delete from storage.objects where bucket_id = 'branding'");
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

  it("passes on a conflict, a refused (not owner) save and a session that has ended", async () => {
    await setBranding({ accent: "#123456" });
    expect(await saveBrandAccent(WS, "light", null, "#0b6e8a")).toEqual({ status: "conflict", theirs: "#123456" });
    expect(await branding()).toEqual({ accent: "#123456" });
    // An editor may not change the branding.
    signInAs(world, "editor");
    expect(await saveBrandAccent(WS, "light", "#123456", "#0b6e8a")).toEqual({ status: "not_found" });
    expect(await branding()).toEqual({ accent: "#123456" });
    signOut(world);
    expect(await saveBrandAccent(WS, "light", null, "#0b6e8a")).toMatchObject({ status: "error", message: expect.stringMatching(/session has ended/) });
  });
});

describe("attachWorkspaceLogo", () => {
  it("refuses a path outside the workspace's folder without removing anything", async () => {
    const invalid = { status: "error", message: "That value isn't valid." };
    for (const path of [`${OTHER}/${U1}.png`, `${WS}/x/${U1}.png`, `${WS}/${U1}.svg`, "../x.png", 5, null]) {
      expect(await attachWorkspaceLogo(WS, path, null), String(path)).toEqual(invalid);
    }
    expect(await attachWorkspaceLogo("nope", NEW, null)).toEqual(invalid);
    expect(fake.removed).toEqual([]);
    expect(await branding()).toEqual({});
  });

  it("keeps a checked logo, saves its path against the old one, and deletes the logo it replaces", async () => {
    await upload(OLD);
    await setBranding({ logo_path: OLD });
    await upload(NEW);
    fake.object = new Blob([pngBytes()]);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(await attachWorkspaceLogo(WS, NEW, OLD)).toEqual({ status: "ok", path: NEW, url: null });
    vi.unstubAllEnvs();
    expect(await branding()).toEqual({ logo_path: NEW });
    expect(fake.removed).toEqual([[OLD]]);
  });

  it("a first logo has nothing to delete", async () => {
    await upload(NEW);
    fake.object = new Blob([pngBytes()]);
    expect((await attachWorkspaceLogo(WS, NEW, null)).status).toBe("ok");
    expect(fake.removed).toEqual([]);
    expect(await branding()).toEqual({ logo_path: NEW });
  });

  it("returns the public URL when the project's URL is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    await upload(NEW);
    fake.object = new Blob([pngBytes()]);
    expect(await attachWorkspaceLogo(WS, NEW, null)).toEqual({ status: "ok", path: NEW, url: `https://abc.supabase.co/storage/v1/object/public/branding/${NEW}` });
    vi.unstubAllEnvs();
  });

  it("refuses bad content and removes the upload", async () => {
    fake.object = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>']);
    expect(await attachWorkspaceLogo(WS, NEW, null)).toMatchObject({ status: "error", message: expect.stringMatching(/^Use a PNG, JPG or WebP image/) });
    expect(fake.removed).toEqual([[NEW]]);
    expect(await branding()).toEqual({});
  });

  it("refuses an image that is too large in pixels and removes the upload", async () => {
    fake.object = new Blob([pngBytes(5000, 5000)]);
    expect(await attachWorkspaceLogo(WS, NEW, null)).toEqual({ status: "error", message: "That image is too large: up to 2048 × 2048 pixels." });
    expect(fake.removed).toEqual([[NEW]]);
  });

  it("refuses a file over 512 KB and removes the upload", async () => {
    fake.object = new Blob([new Uint8Array(524_289)]);
    expect(await attachWorkspaceLogo(WS, NEW, null)).toEqual({ status: "error", message: "That image is over 512 KB." });
    expect(fake.removed).toEqual([[NEW]]);
  });

  it("refuses an extension that doesn't match the content (a JPEG named .png) and removes the upload", async () => {
    fake.object = new Blob([jpegBytes()]);
    expect((await attachWorkspaceLogo(WS, NEW, null)).status).toBe("error");
    expect(fake.removed).toEqual([[NEW]]);
    expect(await branding()).toEqual({});
  });

  it("removes the upload when it can't be read back", async () => {
    fake.object = null;
    expect(await attachWorkspaceLogo(WS, NEW, null)).toMatchObject({ status: "error" });
    expect(fake.removed).toEqual([[NEW]]);
  });

  it("on a conflict removes the new upload and says so; the old logo stays", async () => {
    const theirs = `${WS}/33333333-3333-4333-8333-333333333333.png`;
    await upload(theirs);
    await setBranding({ logo_path: theirs });
    await upload(NEW);
    fake.object = new Blob([pngBytes()]);
    expect(await attachWorkspaceLogo(WS, NEW, OLD)).toEqual({ status: "error", message: "Someone else changed the logo. Reload to see it." });
    expect(fake.removed).toEqual([[NEW]]);
    expect(await branding()).toEqual({ logo_path: theirs });
  });

  it("when the caller may not change the workspace, removes the new upload", async () => {
    signInAs(world, "editor");
    await upload(NEW, world.users.editor);
    fake.object = new Blob([pngBytes()]);
    expect(await attachWorkspaceLogo(WS, NEW, null)).toMatchObject({ status: "error", message: expect.stringMatching(/Only workspace owners/) });
    expect(fake.removed).toEqual([[NEW]]);
    expect(await branding()).toEqual({});
  });

  it("when the database refuses, removes the new upload", async () => {
    // Nothing was uploaded under this name, so the database refuses a logo path that names no object.
    fake.object = new Blob([pngBytes()]);
    expect(await attachWorkspaceLogo(WS, NEW, null)).toMatchObject({ status: "error" });
    expect(fake.removed).toEqual([[NEW]]);
    expect(await branding()).toEqual({});
  });
});

describe("removeWorkspaceLogo", () => {
  it("saves null, then deletes the object", async () => {
    await upload(OLD);
    await setBranding({ logo_path: OLD });
    expect(await removeWorkspaceLogo(WS, OLD)).toEqual({ status: "ok", path: null, url: null });
    expect((await branding()).logo_path ?? null).toBeNull();
    expect(fake.removed).toEqual([[OLD]]);
  });

  it("deletes nothing when the save didn't happen", async () => {
    await setBranding({ logo_path: NEW });
    expect(await removeWorkspaceLogo(WS, OLD)).toMatchObject({ status: "error" });
    signInAs(world, "editor");
    await setBranding({ logo_path: OLD });
    expect(await removeWorkspaceLogo(WS, OLD)).toMatchObject({ status: "error" });
    expect(await branding()).toEqual({ logo_path: OLD });
    expect(fake.removed).toEqual([]);
  });

  it("refuses a path from another workspace", async () => {
    expect(await removeWorkspaceLogo(WS, `${OTHER}/${U1}.png`)).toEqual({ status: "error", message: "That value isn't valid." });
    expect(await removeWorkspaceLogo(WS, null)).toEqual({ status: "error", message: "That value isn't valid." });
    expect(fake.removed).toEqual([]);
  });
});
