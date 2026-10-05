import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// A source's original file (issue #182, B19 2/2, migration 20261204000000): the private `sources` bucket and its policies on
// `storage.objects`, keyed by the workspace id in the object's first folder (members read, owners and editors write, anon
// nothing), and the file columns on `sources` with their checks. Storage itself is the stand-in in sql/storage-shim.sql: a
// query here as `authenticated` (or `anon`) with the JWT's claims is what Supabase's Storage API runs for an upload, a
// download or a delete (verified only against plain Postgres: docs/supabase-notes.md).

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
let stranger: { id: string; claims: Record<string, unknown> };
let second: { id: string; claims: Record<string, unknown> };
let ws = "";
let other = "";

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

/** Run `fn` as a role with claims, in a transaction that is committed (or rolled back when it throws). */
async function as<T>(claims: Record<string, unknown> | null, fn: (c: pg.Client) => Promise<T>, role = "authenticated"): Promise<T> {
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

/** An upload as Supabase's Storage API makes it: the object's `owner_id` is the caller's id. */
const upload = (c: pg.Client, name: string, owner: string, bucket = "sources") =>
  c.query("insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3::uuid, $3, '{\"size\": 12}') returning name", [bucket, name, owner]);
const names = (c: pg.Client, prefix: string) => c.query("select name from storage.objects where bucket_id = 'sources' and name like $1 order by name", [`${prefix}%`]).then((r) => r.rows.map((x) => x.name as string));
/** A source of `workspace`, made as the superuser. */
const source = async (workspace: string) => (await q("insert into sources (workspace_id, kind, title) values ($1, 'sop', 'SOP') returning id", [workspace]))[0].id as string;
/** Keep `name` on source `id` (what the app's server does once it has checked the file). */
const keep = (id: string, name: string) => q("update sources set file_path = $2, file_name = 'SOP.pdf', file_type = 'pdf', file_size = 12 where id = $1", [id, name]);

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@source-files.example.com");
  viewer = await createUser(db, "viewer@source-files.example.com");
  stranger = await createUser(db, "stranger@source-files.example.com");
  second = await createUser(db, "second-editor@source-files.example.com");
  [{ id: ws }] = await q("insert into workspaces (name, slug) values ('Files Co', 'files-co') returning id");
  [{ id: other }] = await q("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer'), ($4, $5, 'editor'), ($1, $6, 'editor')", [ws, editor.id, viewer.id, other, stranger.id, second.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("the sources bucket", () => {
  it("is private, 10 MB a file, and takes only the five kinds of file", async () => {
    expect(await q("select id, public, file_size_limit::int, allowed_mime_types from storage.buckets where id = 'sources'")).toEqual([
      {
        id: "sources",
        public: false,
        file_size_limit: 10 * 1024 * 1024,
        allowed_mime_types: ["text/plain", "text/markdown", "text/csv", "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      },
    ]);
    // Read, upload and delete; never an update in place.
    expect(await q("select cmd, roles::text[] roles from pg_policies where schemaname = 'storage' and policyname like 'sources:%' order by cmd")).toEqual([
      { cmd: "DELETE", roles: ["authenticated"] },
      { cmd: "INSERT", roles: ["authenticated"] },
      { cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });

  it("an editor uploads into a source's folder; only they read it until a source keeps it, then every member does", async () => {
    const id = await source(ws);
    const name = `${ws}/${id}/${randomUUID()}/Interview notes.pdf`;
    expect((await as(editor.claims, (c) => upload(c, name, editor.id))).rows).toEqual([{ name }]);
    // Not checked yet: only the uploader (the app's server reads it back as them) sees it.
    expect(await as(editor.claims, (c) => names(c, `${ws}/`))).toEqual([name]);
    expect(await as(second.claims, (c) => names(c, `${ws}/`))).toEqual([]);
    expect(await as(viewer.claims, (c) => names(c, `${ws}/`))).toEqual([]);
    await keep(id, name);
    // Kept by a source: every member reads it; another workspace's editor and anon see nothing.
    expect(await as(viewer.claims, (c) => names(c, `${ws}/`))).toEqual([name]);
    expect(await as(second.claims, (c) => names(c, `${ws}/`))).toEqual([name]);
    expect(await as(stranger.claims, (c) => names(c, `${ws}/`))).toEqual([]);
    expect(await as(null, (c) => names(c, `${ws}/`), "anon")).toEqual([]);
  });

  it("refuses a viewer, another workspace's editor and anon an upload", async () => {
    const id = await source(ws);
    const at = () => `${ws}/${id}/${randomUUID()}/a.txt`;
    await refused(as(viewer.claims, (c) => upload(c, at(), viewer.id)), "42501", /row-level security/);
    await refused(as(stranger.claims, (c) => upload(c, at(), stranger.id)), "42501", /row-level security/);
    await refused(as(null, (c) => upload(c, at(), editor.id), "anon"), "42501", /row-level security/);
    // An editor writes only into a source of their own workspace, as themselves.
    const theirs = await source(other);
    await refused(as(editor.claims, (c) => upload(c, `${other}/${theirs}/${randomUUID()}/a.txt`, editor.id)), "42501", /row-level security/);
    await refused(as(editor.claims, (c) => upload(c, `${ws}/${theirs}/${randomUUID()}/a.txt`, editor.id)), "42501", /row-level security/);
    await refused(as(editor.claims, (c) => upload(c, `${ws}/${randomUUID()}/${randomUUID()}/a.txt`, editor.id)), "42501", /row-level security/);
    await refused(as(editor.claims, (c) => upload(c, at(), second.id)), "42501", /row-level security/);
  });

  it("refuses a name off the layout or another kind of file (an HTML page, a script)", async () => {
    const id = await source(ws);
    const bad = [
      `${ws}/${id}/a.txt`, // no folder of its own
      `${ws}/${randomUUID()}/a.txt`,
      `${ws}/${id}/${randomUUID()}/page.html`,
      `${ws}/${id}/${randomUUID()}/run.js`,
      `${ws}/${id}/${randomUUID()}/notes.txt.html`,
      `${ws}/${id}/${randomUUID()}/notes.TXT`,
      `${ws}/${id}/${randomUUID()}/sub/a.txt`,
      `${ws}/${id}/not-a-uuid/a.txt`,
      `../${ws}/${id}/${randomUUID()}/a.txt`,
      `${ws.toUpperCase()}/${id}/${randomUUID()}/a.txt`,
    ];
    for (const name of bad) await refused(as(editor.claims, (c) => upload(c, name, editor.id)), "42501", /row-level security/);
    // Other buckets are untouched by these policies (and have none for anyone here).
    await q("insert into storage.buckets (id, name) values ('elsewhere', 'elsewhere') on conflict do nothing");
    await refused(as(editor.claims, (c) => upload(c, `${ws}/${id}/${randomUUID()}/a.txt`, editor.id, "elsewhere")), "42501", /row-level security/);
  });

  it("never replaces a file in place, nor under the name of one a source keeps; an editor deletes, a viewer can't", async () => {
    const id = await source(ws);
    const name = `${ws}/${id}/${randomUUID()}/sheet.xlsx`;
    await as(editor.claims, (c) => upload(c, name, editor.id));
    await keep(id, name);
    expect((await as(editor.claims, (c) => c.query("update storage.objects set metadata = '{}' where name = $1", [name]))).rowCount).toBe(0);
    expect((await as(viewer.claims, (c) => c.query("delete from storage.objects where name = $1", [name]))).rowCount).toBe(0);
    expect((await as(stranger.claims, (c) => c.query("delete from storage.objects where name = $1", [name]))).rowCount).toBe(0);
    expect((await as(editor.claims, (c) => c.query("delete from storage.objects where name = $1", [name]))).rowCount).toBe(1);
    // Deleted, a file a source still names can't be swapped in under that name.
    await refused(as(editor.claims, (c) => upload(c, name, editor.id)), "42501", /row-level security/);
    expect(await q("select count(*)::int n from storage.objects where name = $1", [name])).toEqual([{ n: 0 }]);
  });
});

describe("a source's file columns", () => {
  const add = (claims: Record<string, unknown>) =>
    as(claims, async (c) => (await c.query("insert into sources (workspace_id, kind, title) values ($1, 'sop', 'Onboarding SOP') returning id", [ws])).rows[0].id as string);
  const attach = (claims: Record<string, unknown>, id: string, f: { path: string; name?: string; type?: string; size?: number | null }) =>
    as(claims, (c) =>
      c.query("update sources set file_path = $2, file_name = $3, file_type = $4, file_size = $5, body = 'Step 1' where id = $1 returning id", [id, f.path, f.name ?? "SOP.pdf", f.type ?? "pdf", f.size === undefined ? 2048 : f.size]),
    );

  it("an editor keeps a file on a source; a viewer can't", async () => {
    const id = await add(editor.claims);
    const path = `${ws}/${id}/${randomUUID()}/SOP.pdf`;
    expect((await attach(viewer.claims, id, { path })).rowCount).toBe(0);
    expect((await attach(editor.claims, id, { path })).rowCount).toBe(1);
    expect(await q("select file_path, file_name, file_type, file_size, body from sources where id = $1", [id])).toEqual([{ file_path: path, file_name: "SOP.pdf", file_type: "pdf", file_size: 2048, body: "Step 1" }]);
  });

  it("checks the path is in the source's own workspace, the type, the size, and all four together", async () => {
    const id = await add(editor.claims);
    await refused(attach(editor.claims, id, { path: `${other}/${id}/${randomUUID()}/SOP.pdf` }), "23514", /sources_file_path_shape/);
    // Another source's folder, or none.
    await refused(attach(editor.claims, id, { path: `${ws}/${randomUUID()}/${randomUUID()}/SOP.pdf` }), "23514", /sources_file_path_shape/);
    await refused(attach(editor.claims, id, { path: `${ws}/${randomUUID()}/SOP.pdf` }), "23514", /sources_file_path_shape/);
    await refused(attach(editor.claims, id, { path: `${ws}/${id}/${randomUUID()}/SOP.html`, type: "html" }), "23514", /sources_file_type/);
    await refused(attach(editor.claims, id, { path: `${ws}/${id}/${randomUUID()}/SOP.pdf`, size: 10 * 1024 * 1024 + 1 }), "23514", /sources_file_size/);
    await refused(attach(editor.claims, id, { path: `${ws}/${id}/${randomUUID()}/SOP.pdf`, size: 0 }), "23514", /sources_file_size/);
    await refused(attach(editor.claims, id, { path: `${ws}/${id}/${randomUUID()}/SOP.pdf`, size: null }), "23514", /sources_file_all_or_none/);
    expect((await attach(editor.claims, id, { path: `${ws}/${id}/${randomUUID()}/SOP.pdf`, size: 10 * 1024 * 1024 })).rowCount).toBe(1);
  });
});
