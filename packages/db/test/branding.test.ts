import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Client branding (issue #34, B5, migration 20261214000000): `workspaces.branding` with its shape check and logo guard, the
// public `branding` bucket and its three policies on `storage.objects` (owners and agency admins), saving through
// `save_fields`, and the audit entry. Storage is the stand-in in sql/storage-shim.sql (verified only against plain Postgres:
// docs/supabase-notes.md). Nothing here relies on `storage.objects.owner_id`.

type Claims = Record<string, unknown>;
interface User {
  id: string;
  claims: Claims;
}

let db: TestDb;
let ws = "";
let other = "";
const users: Record<string, User> = {};
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

/** Run `fn` as a role with claims, in a transaction that is committed (or rolled back when it throws). */
async function as<T>(claims: Claims | null, fn: (c: pg.Client) => Promise<T>, role = "authenticated"): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query(`set local role ${role}`);
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

async function refused(run: Promise<unknown>, code: string, why: RegExp) {
  const err = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message?: string } | null;
  expect(err, "expected the statement to be refused").not.toBeNull();
  expect({ code: err!.code, message: err!.message }).toEqual({ code, message: expect.stringMatching(why) });
}

const upload = (c: pg.Client, name: string, owner: string, bucket = "branding") =>
  c.query("insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3::uuid, $3, '{\"size\": 12}') returning name", [bucket, name, owner]);
const names = (c: pg.Client) => c.query("select name from storage.objects where bucket_id = 'branding' order by name").then((r) => r.rows.map((x) => x.name as string));
const logo = (workspace: string, ext = "png") => `${workspace}/${randomUUID()}.${ext}`;
/** An object in the bucket, made as the superuser. */
const object = async (name: string) => {
  await q("insert into storage.objects (bucket_id, name) values ('branding', $1)", [name]);
  return name;
};
/** Set `branding` as the superuser (no JWT: the guard passes). */
const set = (workspace: string, branding: unknown) => q("update workspaces set branding = $2::jsonb where id = $1", [workspace, JSON.stringify(branding)]);

interface SaveResult {
  status: "saved" | "conflict" | "not_found";
  row?: Record<string, unknown>;
}
const saveFields = async (c: pg.Client, key: object, base: object, changes: object): Promise<SaveResult> =>
  (await c.query("select public.save_fields('workspaces', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify(key), JSON.stringify(base), JSON.stringify(changes)])).rows[0].r;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  [{ id: ws }] = await q("insert into workspaces (name, slug) values ('Brand Co', 'brand-co') returning id");
  [{ id: other }] = await q("insert into workspaces (name, slug) values ('Other Brand Co', 'other-brand-co') returning id");
  const roles = ["owner", "editor", "member", "viewer", "agency_member"] as const;
  for (const role of roles) users[role] = await createUser(db, `${role}@branding.example.com`);
  users.flag = await createUser(db, "flag@branding.example.com", { agency_admin: true });
  users.stranger = await createUser(db, "stranger@branding.example.com");
  users.otherOwner = await createUser(db, "other-owner@branding.example.com");
  const memberships: [string, string, string][] = [
    [ws, users.owner!.id, "owner"],
    [ws, users.editor!.id, "editor"],
    [ws, users.member!.id, "member"],
    [ws, users.viewer!.id, "viewer"],
    [ws, users.agency_member!.id, "agency_admin"],
    [other, users.otherOwner!.id, "owner"],
  ];
  for (const m of memberships) await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", m);
});

afterAll(async () => {
  await db?.close();
});

describe("the column", () => {
  it("is jsonb, not null, default {}, and every workspace starts unbranded", async () => {
    expect(await q("select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding'")).toEqual([
      { data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" },
    ]);
    expect(await q("select count(*)::int n from workspaces where branding <> '{}'::jsonb")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int n from workspaces")).not.toEqual([{ n: 0 }]);
    expect(await q("select convalidated from pg_constraint where conname = 'workspaces_branding_shape'")).toEqual([{ convalidated: true }]);
  });
});

describe("the shape check", () => {
  it("accepts {}, an accent, a dark accent with a null accent, and a logo in the workspace's own folder", async () => {
    await set(ws, {});
    await set(ws, { accent: "#0b6e8a" });
    await set(ws, { accent: null, accent_dark: "#aabbcc" });
    await set(ws, { accent: "#0b6e8a", accent_dark: null, logo_path: await object(logo(ws, "png")) });
    await set(ws, { logo_path: await object(logo(ws, "jpg")) });
    await set(ws, { logo_path: await object(logo(ws, "webp")) });
    await set(ws, {});
  });

  it("refuses bad hex, a wrong type, an unknown key, a non-object and a logo that isn't in the workspace's own folder", async () => {
    const bad: unknown[] = [
      { accent: "#FFF" },
      { accent: "#abc" },
      { accent: "#ABCDEF" },
      { accent: "0b6e8a" },
      { accent: 5 },
      { accent_dark: "#12345g" },
      { accent_dark: ["#aabbcc"] },
      { color: "#aabbcc" },
      { report_colors: [] },
      [],
      "x",
      5,
      null,
      { logo_path: 5 },
      { logo_path: logo(other) },
      { logo_path: logo(ws, "svg") },
      { logo_path: `${ws}/x/${randomUUID()}.png` },
      { logo_path: `${ws}/not-a-uuid.png` },
      { logo_path: `${ws}/${randomUUID()}.PNG` },
      { logo_path: `${ws}/${randomUUID()}.gif` },
    ];
    for (const value of bad) {
      await refused(q("update workspaces set branding = $2::jsonb where id = $1", [ws, JSON.stringify(value)]), "23514", /workspaces_branding_shape|violates check/);
    }
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });
});

describe("the logo guard", () => {
  it("refuses a logo path with nothing behind it, for anyone signed in", async () => {
    const path = logo(ws);
    await refused(as(users.owner!.claims, (c) => c.query("update workspaces set branding = jsonb_build_object('logo_path', $2::text) where id = $1", [ws, path])), "42501", /^Upload the logo first: the workspace keeps only a logo uploaded for it$/);
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });

  it("keeps a logo whose object is in the bucket (whoever uploaded it); the operator passes; an unchanged path is not checked again", async () => {
    const path = await object(logo(ws));
    await as(users.owner!.claims, (c) => c.query("update workspaces set branding = jsonb_build_object('logo_path', $2::text) where id = $1", [ws, path]));
    expect(await q("select branding ->> 'logo_path' p from workspaces where id = $1", [ws])).toEqual([{ p: path }]);
    // The operator (no JWT) passes with nothing behind the name.
    const ghost = logo(ws);
    await set(ws, { logo_path: ghost });
    // An unchanged path on another update is not checked (the object may be gone).
    await as(users.owner!.claims, (c) => c.query("update workspaces set branding = branding || '{\"accent\": \"#0b6e8a\"}' where id = $1", [ws]));
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: { logo_path: ghost, accent: "#0b6e8a" } }]);
    // An object in another bucket doesn't count.
    await q("insert into storage.buckets (id, name) values ('elsewhere', 'elsewhere') on conflict do nothing");
    const wrong = logo(ws);
    await q("insert into storage.objects (bucket_id, name) values ('elsewhere', $1)", [wrong]);
    await refused(as(users.owner!.claims, (c) => c.query("update workspaces set branding = jsonb_build_object('logo_path', $2::text) where id = $1", [ws, wrong])), "42501", /Upload the logo first/);
    await set(ws, {});
  });

  it("is not executable by anyone signed in, and has an empty search_path", async () => {
    expect(await q("select proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname = 'branding_logo_guard'")).toEqual([{ proconfig: ['search_path=""'] }]);
    expect(await q("select grantee from information_schema.routine_privileges where routine_schema = 'private' and routine_name = 'branding_logo_guard' and grantee in ('anon', 'authenticated', 'PUBLIC')")).toEqual([]);
    expect(await q("select tgname, tgenabled::text e from pg_trigger where tgname = 'branding_logo_guard'")).toEqual([{ tgname: "branding_logo_guard", e: "O" }]);
  });
});

describe("saving through save_fields", () => {
  const save = (claims: Claims, accent = "#0b6e8a") => as(claims, (c) => saveFields(c, { id: ws }, { "branding.accent": null }, { "branding.accent": accent }));

  it("owners and agency admins save it (JWT flag and membership)", async () => {
    for (const who of ["owner", "agency_member", "flag"]) {
      await set(ws, {});
      const r = await save(users[who]!.claims);
      expect(r.status, who).toBe("saved");
      expect(await q("select branding from workspaces where id = $1", [ws]), who).toEqual([{ branding: { accent: "#0b6e8a" } }]);
    }
    await set(ws, {});
  });

  it("an editor, member, viewer and stranger find nothing", async () => {
    for (const who of ["editor", "member", "viewer", "stranger", "otherOwner"]) {
      expect((await save(users[who]!.claims)).status, who).toBe("not_found");
    }
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });

  it("saves the dark accent, and refuses a version clash", async () => {
    await as(users.owner!.claims, async (c) => {
      expect((await saveFields(c, { id: ws }, { "branding.accent_dark": null }, { "branding.accent_dark": "#4cc3e0" })).status).toBe("saved");
      expect(await saveFields(c, { id: ws }, { "branding.accent_dark": null }, { "branding.accent_dark": "#aabbcc" })).toMatchObject({ status: "conflict" });
    });
    await set(ws, {});
  });

  it("refuses a bad value at the check (the app has already refused contrast; Postgres checks the shape only)", async () => {
    await refused(save(users.owner!.claims, "#ABC"), "23514", /workspaces_branding_shape|violates check/);
    // A low-contrast accent is allowed in the database: the app refuses it at save time and ignores it at render time (Q11).
    expect((await save(users.owner!.claims, "#ffff00")).status).toBe("saved");
    await set(ws, {});
  });

  it("an MCP caller (an API token) is refused by the needs_review trigger", async () => {
    await refused(save({ ...users.owner!.claims, api_token_id: randomUUID() }), "42501", /company model changes only by review/);
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });

  it("writes an audit_log row for the workspace naming the actor", async () => {
    await save(users.owner!.claims, "#123456");
    const rows = await q("select actor_id, actor_kind, action, diff from audit_log where target_table = 'workspaces' and diff::text like '%#123456%' order by created_at");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: users.owner!.id, actor_kind: "user", action: "update" });
    expect(rows[0].diff.new.branding).toEqual({ accent: "#123456" });
    expect(rows[0].diff.old.branding).toEqual({});
    await set(ws, {});
  });
});

describe("the branding bucket", () => {
  it("is public, 512 KB a file, and takes only PNG, JPEG and WebP", async () => {
    expect(await q("select id, public, file_size_limit::int, allowed_mime_types from storage.buckets where id = 'branding'")).toEqual([
      { id: "branding", public: true, file_size_limit: 524288, allowed_mime_types: ["image/png", "image/jpeg", "image/webp"] },
    ]);
    expect(await q("select cmd, roles::text[] roles from pg_policies where schemaname = 'storage' and policyname like 'branding:%' order by cmd")).toEqual([
      { cmd: "DELETE", roles: ["authenticated"] },
      { cmd: "INSERT", roles: ["authenticated"] },
      { cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });

  it("owners and agency admins upload into their workspace's folder", async () => {
    for (const who of ["owner", "agency_member", "flag"]) {
      const name = logo(ws);
      expect((await as(users[who]!.claims, (c) => upload(c, name, users[who]!.id))).rows, who).toEqual([{ name }]);
    }
  });

  it("refuses an editor, member, viewer, another workspace's owner and anon", async () => {
    for (const who of ["editor", "member", "viewer", "stranger", "otherOwner"]) {
      await refused(as(users[who]!.claims, (c) => upload(c, logo(ws), users[who]!.id)), "42501", /row-level security/);
    }
    await refused(as(null, (c) => upload(c, logo(ws), users.owner!.id), "anon"), "42501", /row-level security/);
    // The owner of another workspace may not write into this one's folder, nor this owner into the other's.
    await refused(as(users.owner!.claims, (c) => upload(c, logo(other), users.owner!.id)), "42501", /row-level security/);
  });

  it("refuses a name off the layout: another kind of file, a nested folder, a name that isn't a uuid", async () => {
    const bad = [
      logo(ws, "svg"),
      logo(ws, "gif"),
      logo(ws, "html"),
      `${ws}/x/${randomUUID()}.png`,
      `${ws}/${randomUUID()}/${randomUUID()}.png`,
      `${ws}/logo.png`,
      `${ws}/${randomUUID()}.PNG`,
      `${ws}/${randomUUID()}.png.html`,
      `../${ws}/${randomUUID()}.png`,
      `${ws.toUpperCase()}/${randomUUID()}.png`,
    ];
    for (const name of bad) await refused(as(users.owner!.claims, (c) => upload(c, name, users.owner!.id)), "42501", /row-level security/);
    // Other buckets are untouched by these policies.
    await q("insert into storage.buckets (id, name) values ('elsewhere', 'elsewhere') on conflict do nothing");
    await refused(as(users.owner!.claims, (c) => upload(c, logo(ws), users.owner!.id, "elsewhere")), "42501", /row-level security/);
  });

  it("owners read and delete; editors can't read or delete; anon can't read; there is no update", async () => {
    const name = logo(ws);
    await as(users.owner!.claims, (c) => upload(c, name, users.owner!.id));
    expect(await as(users.owner!.claims, (c) => names(c))).toContain(name);
    expect(await as(users.agency_member!.claims, (c) => names(c))).toContain(name);
    for (const who of ["editor", "member", "viewer", "stranger", "otherOwner"]) expect(await as(users[who]!.claims, (c) => names(c)), who).not.toContain(name);
    expect(await as(null, (c) => names(c), "anon")).toEqual([]);
    for (const who of ["editor", "viewer", "stranger", "otherOwner"]) {
      expect((await as(users[who]!.claims, (c) => c.query("delete from storage.objects where name = $1", [name]))).rowCount, who).toBe(0);
    }
    expect((await as(null, (c) => c.query("delete from storage.objects where name = $1", [name]), "anon")).rowCount).toBe(0);
    // No update policy: even the owner changes nothing in place.
    expect((await as(users.owner!.claims, (c) => c.query("update storage.objects set metadata = '{}' where name = $1", [name]))).rowCount).toBe(0);
    expect((await as(users.owner!.claims, (c) => c.query("delete from storage.objects where name = $1", [name]))).rowCount).toBe(1);
    expect(await q("select count(*)::int n from storage.objects where name = $1", [name])).toEqual([{ n: 0 }]);
  });

  it("an owner keeps a logo they uploaded, end to end, and an editor then sees the path but can't touch the object", async () => {
    const name = logo(ws);
    await as(users.owner!.claims, (c) => upload(c, name, users.owner!.id));
    await as(users.owner!.claims, (c) => saveFields(c, { id: ws }, { "branding.logo_path": null }, { "branding.logo_path": name }));
    expect(await as(users.viewer!.claims, async (c) => (await c.query("select branding ->> 'logo_path' p from workspaces where id = $1", [ws])).rows)).toEqual([{ p: name }]);
    expect((await as(users.editor!.claims, (c) => c.query("delete from storage.objects where name = $1", [name]))).rowCount).toBe(0);
    await set(ws, {});
  });
});
