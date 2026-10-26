import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// A workspace's logo in the database (step 4 of the move off Supabase, migration 20261230000000): `workspace_logos` with its
// checks and its row-level security (written by the people who could change the branding before: owners and agency admins;
// read by the workspace's members; nothing for anon), `workspace_logo(uuid)`, which anon may call because a share link's visitors
// see the logo, and what the migration took away (the logo guard, the `sources` and `branding` storage policies, the file columns).

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
async function as<T>(claims: Claims | null, fn: (c: pg.Client) => Promise<T>, role = claims ? "authenticated" : "anon"): Promise<T> {
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

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const insert = (c: pg.Client, workspace: string, bytes = PNG, mime = "image/png", hash = sha(bytes)) =>
  c.query("insert into workspace_logos (workspace_id, mime, bytes, sha256) values ($1, $2, $3, $4)", [workspace, mime, bytes, hash]);
const logos = (workspace = ws) => q("select mime, sha256 from workspace_logos where workspace_id = $1", [workspace]);
const clear = () => q("delete from workspace_logos");

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  [{ id: ws }] = await q("insert into workspaces (name, slug) values ('Logo Co', 'logo-co') returning id");
  [{ id: other }] = await q("insert into workspaces (name, slug) values ('Other Logo Co', 'other-logo-co') returning id");
  for (const role of ["owner", "editor", "member", "viewer", "agency_member"] as const) users[role] = await createUser(db, `${role}@logos.example.com`);
  users.flag = await createUser(db, "flag@logos.example.com", { agency_admin: true });
  users.stranger = await createUser(db, "stranger@logos.example.com");
  users.otherOwner = await createUser(db, "other-owner@logos.example.com");
  const memberships: [string, string, string][] = [
    [ws, users.owner!.id, "owner"],
    [ws, users.editor!.id, "editor"],
    [ws, users.member!.id, "member"],
    [ws, users.viewer!.id, "viewer"],
    [ws, users.agency_member!.id, "agency_admin"],
    [other, users.otherOwner!.id, "owner"],
  ];
  for (const m of memberships) await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", m);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the table", () => {
  it("has the columns and keys the route needs, and row-level security on", async () => {
    expect(await q("select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'workspace_logos' order by ordinal_position")).toEqual([
      { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "mime", data_type: "text", is_nullable: "NO" },
      { column_name: "bytes", data_type: "bytea", is_nullable: "NO" },
      { column_name: "sha256", data_type: "text", is_nullable: "NO" },
      { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
    expect(await q("select relrowsecurity from pg_class where oid = 'public.workspace_logos'::regclass")).toEqual([{ relrowsecurity: true }]);
  });

  it("takes PNG, JPEG and WebP of 1 byte to 512 KB (the old bucket's limit) whose hash is the bytes' hash, and one per workspace", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
      await clear();
      await insert(db.client, ws, PNG, mime);
    }
    await clear();
    const edge = Buffer.alloc(524_288, 1);
    await insert(db.client, ws, edge);
    await refused(insert(db.client, ws, PNG), "23505", /duplicate key|workspace_logos_pkey/);
    await clear();
    await refused(insert(db.client, ws, Buffer.alloc(524_289, 1)), "23514", /workspace_logos_size/);
    await refused(insert(db.client, ws, Buffer.alloc(0)), "23514", /workspace_logos_size/);
    for (const mime of ["image/svg+xml", "image/gif", "text/html", "IMAGE/PNG"]) await refused(insert(db.client, ws, PNG, mime), "23514", /workspace_logos_mime/);
    await refused(insert(db.client, ws, PNG, "image/png", "0".repeat(64)), "23514", /workspace_logos_sha256/);
    await refused(insert(db.client, ws, PNG, "image/png", sha(PNG).toUpperCase()), "23514", /workspace_logos_sha256/);
    expect(await logos()).toEqual([]);
  });

  it("goes with its workspace", async () => {
    const [{ id }] = await q("insert into workspaces (name, slug) values ('Doomed', 'doomed-logo-co') returning id");
    await insert(db.client, id);
    expect(await logos(id)).toHaveLength(1);
    await q("delete from workspaces where id = $1", [id]);
    expect(await logos(id)).toEqual([]);
  });
});

describe("who writes it: owners and agency admins, the rule the branding has always had", () => {
  it("lets an owner, an agency admin (by membership) and an agency admin (by JWT flag) add, replace and remove it", async () => {
    for (const who of ["owner", "agency_member", "flag"]) {
      await clear();
      await as(users[who]!.claims, (c) => insert(c, ws));
      const next = Buffer.concat([PNG, Buffer.from([1])]);
      const updated = await as(users[who]!.claims, (c) => c.query("update workspace_logos set bytes = $2, sha256 = $3 where workspace_id = $1", [ws, next, sha(next)]));
      expect(updated.rowCount, who).toBe(1);
      expect((await logos())[0]!.sha256, who).toBe(sha(next));
      const removed = await as(users[who]!.claims, (c) => c.query("delete from workspace_logos where workspace_id = $1", [ws]));
      expect(removed.rowCount, who).toBe(1);
    }
  });

  it("refuses an editor, a member, a viewer, a stranger, another workspace's owner and anon a write, and changes nothing", async () => {
    await clear();
    await insert(db.client, ws);
    const before = await logos();
    for (const who of ["editor", "member", "viewer", "stranger", "otherOwner", "anon"]) {
      const claims = who === "anon" ? null : users[who]!.claims;
      await refused(as(claims, (c) => insert(c, ws, Buffer.from("x"))), "42501", /row-level security|permission denied/);
      // An update or delete of a row they may see (or not) matches nothing.
      if (who !== "anon") {
        expect((await as(claims, (c) => c.query("update workspace_logos set mime = 'image/webp' where workspace_id = $1", [ws]))).rowCount, who).toBe(0);
        expect((await as(claims, (c) => c.query("delete from workspace_logos where workspace_id = $1", [ws]))).rowCount, who).toBe(0);
      }
    }
    expect(await logos()).toEqual(before);
    await clear();
  });
});

describe("who reads it", () => {
  it("lets every member of the workspace read the row, and nobody else: a stranger and another workspace's owner see none, anon has no table access", async () => {
    await clear();
    await insert(db.client, ws);
    for (const who of ["owner", "editor", "member", "viewer", "agency_member", "flag"]) {
      expect((await as(users[who]!.claims, (c) => c.query("select sha256 from workspace_logos where workspace_id = $1", [ws]))).rows, who).toEqual([{ sha256: sha(PNG) }]);
    }
    for (const who of ["stranger", "otherOwner"]) {
      expect((await as(users[who]!.claims, (c) => c.query("select 1 from workspace_logos"))).rows, who).toEqual([]);
    }
    await refused(as(null, (c) => c.query("select 1 from workspace_logos")), "42501", /permission denied/);
    expect(await q("select has_table_privilege('anon', 'public.workspace_logos', 'select, insert, update, delete') as any_priv")).toEqual([{ any_priv: false }]);
    await clear();
  });
});

describe("the audit entry (as save_fields wrote one when the logo was branding.logo_path)", () => {
  const entries = () =>
    q("select actor_id, actor_kind, action, target_table, target_id, diff from audit_log where workspace_id = $1 and diff::text like '%logo_sha256%' order by created_at, id", [ws]);
  const clearLog = () => q("delete from audit_log where workspace_id = $1 and diff::text like '%logo_sha256%'", [ws]);

  it("logs adding, replacing and removing a logo on the workspace, by its hash and never its bytes, naming who did it", async () => {
    await clear();
    await clearLog();
    const owner = users.owner!;
    const next = Buffer.concat([PNG, Buffer.from([2])]);
    await as(owner.claims, (c) => insert(c, ws));
    await as(owner.claims, (c) => c.query("update workspace_logos set bytes = $2, sha256 = $3 where workspace_id = $1", [ws, next, sha(next)]));
    // A write that keeps the same logo (only updated_at moves) is not a change.
    await as(owner.claims, (c) => c.query("update workspace_logos set updated_at = now() where workspace_id = $1", [ws]));
    await as(owner.claims, (c) => c.query("delete from workspace_logos where workspace_id = $1", [ws]));
    const base = { actor_id: owner.id, actor_kind: "user", action: "update", target_table: "workspaces", target_id: ws };
    expect(await entries()).toEqual([
      { ...base, diff: { old: { branding: {} }, new: { branding: { logo_sha256: sha(PNG) } } } },
      { ...base, diff: { old: { branding: { logo_sha256: sha(PNG) } }, new: { branding: { logo_sha256: sha(next) } } } },
      { ...base, diff: { old: { branding: { logo_sha256: sha(next) } }, new: { branding: {} } } },
    ]);
    expect(JSON.stringify(await entries())).not.toContain(PNG.toString("hex"));
  });

  it("names an agency admin too, and logs nothing for a refused write or one made without a signed-in person", async () => {
    await clear();
    await clearLog();
    await as(users.flag!.claims, (c) => insert(c, ws));
    expect((await entries()).map((e) => e.actor_id)).toEqual([users.flag!.id]);
    await clearLog();
    await refused(as(users.editor!.claims, (c) => c.query("insert into workspace_logos (workspace_id, mime, bytes, sha256) values ($1, 'image/png', $2, $3) on conflict (workspace_id) do update set bytes = excluded.bytes, sha256 = excluded.sha256", [ws, Buffer.from("y"), sha(Buffer.from("y"))])), "42501", /row-level security/);
    // The superuser (a restore, a script): no person to name, as with audit_company_write.
    await q("delete from workspace_logos where workspace_id = $1", [ws]);
    await insert(db.client, ws);
    expect(await entries()).toEqual([]);
    await clear();
  });

  it("logs nothing when the logo goes with its workspace", async () => {
    const [{ id }] = await q("insert into workspaces (name, slug) values ('Gone Logo Co', 'gone-logo-co') returning id");
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [id, users.owner!.id]);
    await as(users.owner!.claims, (c) => insert(c, id));
    await as(users.owner!.claims, (c) => c.query("delete from workspaces where id = $1", [id]));
    expect(await q("select action from audit_log where workspace_id = $1 and diff::text like '%logo_sha256%'", [id])).toEqual([{ action: "update" }]);
  });

  it("is security definer with an empty search_path, and nobody may call it", async () => {
    expect(await q("select prosecdef, proconfig from pg_proc where oid = 'private.audit_workspace_logo_write()'::regprocedure")).toEqual([{ prosecdef: true, proconfig: ["search_path=\"\""] }]);
    expect(await q("select tgname from pg_trigger where tgrelid = 'public.workspace_logos'::regclass and not tgisinternal")).toEqual([{ tgname: "audit_logo" }]);
  });
});

describe("workspace_logo(uuid)", () => {
  const call = (claims: Claims | null, workspace = ws) => as(claims, (c) => c.query("select mime, bytes, sha256 from public.workspace_logo($1)", [workspace])).then((r) => r.rows);

  it("gives anon, and anyone signed in, a workspace's logo: its type, bytes and hash", async () => {
    await clear();
    await insert(db.client, ws);
    for (const claims of [null, users.stranger!.claims, users.viewer!.claims, users.otherOwner!.claims]) {
      const rows = await call(claims);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ mime: "image/png", sha256: sha(PNG) });
      expect(Buffer.compare(rows[0].bytes, PNG)).toBe(0);
    }
    await clear();
  });

  it("gives no row for a workspace with no logo, or one that doesn't exist, and nothing else about a workspace", async () => {
    expect(await call(null)).toEqual([]);
    expect(await call(null, randomUUID())).toEqual([]);
    expect(await q("select pg_get_function_result('public.workspace_logo(uuid)'::regprocedure) as r")).toEqual([{ r: "TABLE(mime text, bytes bytea, sha256 text)" }]);
  });

  it("is security definer with an empty search_path, executable by anon and authenticated and not by PUBLIC beyond them", async () => {
    expect(await q("select prosecdef, proconfig from pg_proc where oid = 'public.workspace_logo(uuid)'::regprocedure")).toEqual([{ prosecdef: true, proconfig: ["search_path=\"\""] }]);
    expect(await q("select has_function_privilege('anon', 'public.workspace_logo(uuid)', 'execute') a, has_function_privilege('authenticated', 'public.workspace_logo(uuid)', 'execute') b")).toEqual([{ a: true, b: true }]);
  });
});

describe("what migration 20261230000000 took away", () => {
  it("drops the source file columns, their index and checks, and the guard on them", async () => {
    expect(await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('file_path', 'file_name', 'file_type', 'file_size')")).toEqual([]);
    expect((await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name = 'file_url'")).length).toBe(1);
    expect(await q("select conname from pg_constraint where conrelid = 'public.sources'::regclass and conname like 'sources_file_%' and conname <> 'sources_file_url'")).toEqual([]);
    expect(await q("select indexname from pg_indexes where schemaname = 'public' and indexname = 'sources_workspace_file_path'")).toEqual([]);
    expect(await q("select tgname from pg_trigger where tgname in ('source_file_guard', 'branding_logo_guard') and not tgisinternal")).toEqual([]);
    expect(await q("select proname from pg_proc where pronamespace = 'private'::regnamespace and proname in ('source_file_guard', 'branding_logo_guard', 'storage_workspace')")).toEqual([]);
  });

  it("leaves no policy on storage.objects for the `sources` and `branding` buckets", async () => {
    expect(await q("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and (policyname like 'sources:%' or policyname like 'branding:%')")).toEqual([]);
  });

  it("keeps the other branding keys and refuses a logo_path in the branding column", async () => {
    await q("update workspaces set branding = '{\"accent\": \"#0b6e8a\", \"accent_dark\": \"#4cc3e0\"}' where id = $1", [ws]);
    await refused(q("update workspaces set branding = jsonb_build_object('logo_path', $2::text) where id = $1", [ws, `${ws}/${randomUUID()}.png`]), "23514", /workspaces_branding_shape/);
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: { accent: "#0b6e8a", accent_dark: "#4cc3e0" } }]);
    await q("update workspaces set branding = '{}' where id = $1", [ws]);
  });
});
