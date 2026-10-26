import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as tcpConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { applyCompat, applyMigrations, migrationFiles } from "../src/migrations";
import { connectTarget } from "../scripts/copy-from-supabase/connect.ts";
import { planLoad, type ForeignKey } from "../scripts/copy-from-supabase/foreign-keys.ts";
import { postgresSource, runExport } from "../scripts/copy-from-supabase/export.ts";
import { formatReport, runImport, type ImportReport } from "../scripts/copy-from-supabase/import.ts";
import { runVerify } from "../scripts/copy-from-supabase/verify.ts";
import { assertReadOnlySelect, brandingFile, managementApiSource, parseRowsExactly, type Manifest } from "../scripts/copy-from-supabase/shared.ts";
import { createTestDb, createUser, type TestDb } from "./harness";

// Step 7a of the move off Supabase: scripts/copy-from-supabase/. The source is "Supabase-like": the shims and the migrations up to
// 20261227000000 (production's row 72, before Better Auth, references and logos), with the seed, users, identities, memberships,
// logos in storage.objects and a source with file columns. It is exported, imported into a fresh database at head by both
// paths (the replica role, and the fallback for a database that refuses it), and verified. Nothing here touches Supabase: the
// Management API and Storage are a local http server.

const execFileAsync = promisify(execFile);
const scripts = fileURLToPath(new URL("../scripts/copy-from-supabase/", import.meta.url));
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const SOURCE_HEAD = "20261227000000";
const NORTHBEAM = "a0000000-0000-4000-8000-000000000001";
const LARKSPUR = "a0000000-0000-4000-8001-000000000001";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const png = (size: number) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(size - 8, 7)]);

let source: TestDb;
let exportDir = "";
let exportProblems: string[] = [];
const targets: TestDb[] = [];
const scratch: string[] = [];
let storageServer: Server;
let storageBase = "";
const logos: Record<string, { workspace: string; path: string; bytes: Buffer; mime: string }> = {};
const users: Record<string, { id: string; email: string; claims: Record<string, unknown> }> = {};
let sourceAuditRows = 0;
/** Queries whose answers must be the same, text for text, on the source and on every target: values a JavaScript number would change. */
const EXACT = [
  "select id, fte::text, capacity_hours_week::text, cost_rate::text from people order by id",
  "select seq, tx::text from issue_events order by seq",
  "select id, diff::text from audit_log where target_table <> 'deployment_access' order by id",
];

const q = (db: TestDb) => async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

async function emptyTarget(): Promise<TestDb> {
  const t = await createTestDb({ seed: false });
  targets.push(t);
  return t;
}

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "copy-from-supabase-"));
  scratch.push(d);
  return d;
};

/** The tables a copy must reproduce exactly: every public table the source has, bar the migration log. */
async function publicTables(db: TestDb): Promise<string[]> {
  const { rows } = await db.client.query("select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by 1");
  return rows.map((r) => r.tablename as string);
}
const count = async (db: TestDb, table: string) => Number((await db.client.query(`select count(*)::int as n from ${table}`)).rows[0].n);

beforeAll(async () => {
  source = await createTestDb({ upTo: SOURCE_HEAD });
  const s = q(source);

  // --- People: Supabase Auth rows, as the app's createUser helper writes them -------------------------------------------------
  users.admin = { ...(await createUser(source, "admin@acme.example.com", { agency_admin: true }, { google: { hd: "acme.example.com" } })), email: "admin@acme.example.com" };
  users.owner = { ...(await createUser(source, "Owner@Acme.example.com", {}, { google: { hd: "acme.example.com" } })), email: "Owner@Acme.example.com" };
  users.editor = { ...(await createUser(source, "editor@acme.example.com", {}, { google: {} })), email: "editor@acme.example.com" };
  users.viewer = { ...(await createUser(source, "viewer@acme.example.com")), email: "viewer@acme.example.com" };
  users.unconfirmed = { ...(await createUser(source, "new@acme.example.com", {}, { unconfirmed: true })), email: "new@acme.example.com" };
  users.weird = { ...(await createUser(source, "weird@localhost")), email: "weird@localhost" };
  users.noEmail = { id: randomUUID(), email: "", claims: {} };
  await s("insert into auth.users (id, email) values ($1, null)", [users.noEmail.id]);
  await s("update auth.users set raw_user_meta_data = $2 where id = $1", [users.owner.id, { full_name: "Olive Owner", avatar_url: "https://example.com/o.png" }]);
  // A password identity next to Google ones: only Google becomes a Better Auth account.
  await s("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'email', $2, '{}')", [users.viewer.id, users.viewer.email]);

  for (const [who, role, ws] of [
    ["owner", "owner", NORTHBEAM],
    ["editor", "editor", NORTHBEAM],
    ["viewer", "viewer", NORTHBEAM],
    ["unconfirmed", "member", NORTHBEAM],
    ["owner", "viewer", LARKSPUR],
  ] as const) {
    await s("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[who]!.id, role]);
  }
  // Audit rows the copy must not add to: written by hand (the operator's own writes are not audited) and by a signed-in change.
  await s("insert into audit_log (workspace_id, actor_kind, action, target_table, target_id) values ($1, 'system', 'update', 'workspaces', $1)", [NORTHBEAM]);

  // Supabase's auth.users has created_at and updated_at, which the target's does not: Better Auth's createdAt is taken from them.
  await s("alter table auth.users add column created_at timestamptz default now(), add column updated_at timestamptz default now()");
  await s("update auth.users set created_at = '2025-03-04 05:06:07.123456+00', updated_at = '2025-06-07 08:09:10+00' where id = $1", [users.owner.id]);

  // Values that do not survive a JavaScript number: more digits than a double holds, an int8 above 2^53, a numeric's scale
  // (1.50), NaN and Infinity, and the same inside jsonb.
  const people = (await s("select id from people where workspace_id = $1 order by id limit 3", [NORTHBEAM])).map((r) => r.id as string);
  await s("update people set fte = 1.50, cost_rate = 12345678901234567890.123456789012345678 where id = $1", [people[0]]);
  await s("update people set capacity_hours_week = 'NaN', cost_rate = 0.1000 where id = $1", [people[1]]);
  await s("update people set capacity_hours_week = 'Infinity' where id = $1", [people[2]]);
  await s("update issue_events set tx = 9007199254740993 where seq = (select min(seq) from issue_events)");
  await s(
    `insert into audit_log (workspace_id, actor_kind, action, target_table, target_id, diff)
     values ($1, 'system', 'update', 'workspaces', $1, '{"big": 123456789012345678901234567890, "rate": 0.10, "n": 9007199254740993}')`,
    [NORTHBEAM],
  );

  // A source with its uploaded original (the file columns step 4 drops).
  const sourceId = randomUUID();
  await s(
    `insert into sources (id, workspace_id, kind, title, body, file_path, file_name, file_type, file_size)
     values ($1, $2, 'transcript', 'Interview notes', 'body text', $3, 'notes.pdf', 'pdf', 1234)`,
    [sourceId, NORTHBEAM, `${NORTHBEAM}/${sourceId}/${randomUUID()}/notes.pdf`],
  );
  await s("insert into storage.objects (bucket_id, name, metadata) values ('sources', $1, $2)", [
    `${NORTHBEAM}/${sourceId}/x/notes.pdf`,
    { size: 1234, mimetype: "application/pdf" },
  ]);

  // --- Logos in the public branding bucket --------------------------------------------------------------------------------------
  const wsLogo = async (key: string, slug: string, ext: string, bytes: Buffer, mime: string, inStorage = true) => {
    const [{ id }] = await s("insert into workspaces (name, slug) values ($1, $1) returning id", [slug]);
    const path = `${id}/${randomUUID()}.${ext}`;
    await s("update workspaces set branding = $2 where id = $1", [id, { accent: "#112233", logo_path: path }]);
    if (inStorage) await s("insert into storage.objects (bucket_id, name, metadata) values ('branding', $1, $2)", [path, { size: bytes.length, mimetype: mime }]);
    logos[key] = { workspace: id as string, path, bytes, mime };
  };
  await wsLogo("fine", "logo-fine", "png", png(2000), "image/png");
  await wsLogo("big", "logo-big", "png", png(600_000), "image/png");
  await wsLogo("gif", "logo-gif", "webp", png(3000), "image/gif");
  await wsLogo("gone", "logo-gone", "jpg", png(3000), "image/jpeg");
  await wsLogo("unlisted", "logo-unlisted", "png", png(3000), "image/png", false);
  await s("update workspaces set branding = $2 where id = $1", [NORTHBEAM, { accent: "#aa00aa", accent_dark: "#00aaaa" }]);
  sourceAuditRows = await count(source, "audit_log");
  expect(sourceAuditRows).toBeGreaterThan(0);

  // The public Storage URL, served locally: every logo's bytes but the "gone" one's.
  storageServer = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").replace(/^\/branding\//, ""));
    const hit = Object.entries(logos).find(([key, l]) => l.path === name && key !== "gone");
    if (!hit) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": hit[1].mime }).end(hit[1].bytes);
  });
  await new Promise<void>((r) => storageServer.listen(0, "127.0.0.1", r));
  storageBase = `http://127.0.0.1:${(storageServer.address() as AddressInfo).port}`;

  // Export through the script itself (--url), as a rehearsal would run it. The "gone" logo can't be downloaded, so it exits 1.
  exportDir = join(tmp(), "export");
  const run = await execFileAsync(
    "node",
    ["--experimental-strip-types", "--no-warnings", join(scripts, "export.ts"), "--out", exportDir, "--url", source.url, "--storage-base", storageBase, "--page-size", "40"],
    { env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" } },
  ).then(
    (r) => ({ code: 0, stderr: r.stderr }),
    (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
  );
  exportProblems = run.stderr.split("\n").filter((l) => l.startsWith("PROBLEM"));
  expect(run.code).toBe(1);
}, 120_000);

afterAll(async () => {
  storageServer?.close();
  for (const t of targets) await t.close();
  await source?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("applyMigrations upTo", () => {
  it("stops at the given version, in a real run and in a dry run", async () => {
    const applied = (await source.client.query("select max(version) as v, count(*)::int as n from schema_migrations")).rows[0];
    expect(applied.v).toBe(SOURCE_HEAD);
    // The source database was built with upTo: a later file is pending without it, and nothing is pending with it.
    expect((await applyMigrations(source.client, { dryRun: true, upTo: SOURCE_HEAD })).files).toEqual([]);
    const pending = (await applyMigrations(source.client, { dryRun: true })).files;
    expect(pending[0]).toBe("20261228000000_better_auth.sql");
    expect(pending.every((f) => f > SOURCE_HEAD)).toBe(true);
    expect((await source.client.query("select to_regclass('better_auth.user') as t, to_regclass('public.workspace_logos') as l")).rows[0]).toEqual({ t: null, l: null });
  });
});

describe("the read-only guard", () => {
  it("accepts a select, with literals and quoted names that look like SQL", () => {
    expect(() => assertReadOnlySelect("select count(*) from \"public\".\"copy\" where note = 'a; delete from x -- ''q'''")).not.toThrow();
    expect(() => assertReadOnlySelect("  SELECT 1;  ")).not.toThrow();
  });
  it.each([
    ["delete from t", /not a select/],
    ["update t set a = 1", /not a select/],
    ["select 1; select 2", /more than one/],
    ["select 1; drop table t", /more than one/],
    ["with x as (select 1) select * from x", /not a select/],
    ["select * into backup from t", /"into"/],
    ["select * from t for update", /for update/],
    ["select set_config('role', 'x', false)", /set_config/],
    ["select 1 -- and then", /comment/],
    ["select /* x */ 1", /comment/],
    ["select $$x$$", /dollar/],
    ["select e'\\x'", /escape string/],
    ["select 1 \\ 2", /backslash/],
    ["select 'open", /unterminated/],
    ["", /not a select/],
  ])("refuses %j", (sql, why) => {
    expect(() => assertReadOnlySelect(sql)).toThrow(why);
  });
});

describe("planLoad", () => {
  const fk = (child: string, parent: string, nullable = true): ForeignKey => ({
    name: `${child}_${parent}_fkey`,
    child,
    parent,
    childColumns: ["x_id"],
    parentColumns: ["id"],
    nullable: [nullable],
    match: "s",
  });
  it("orders parents first, defers a self-reference, and breaks a cycle at one nullable key", () => {
    const keys = [fk("public.c", "public.b"), fk("public.b", "public.a"), fk("public.a", "public.c"), fk("public.tree", "public.tree"), fk("public.b", "public.elsewhere", false)];
    const plan = planLoad(["public.c", "public.a", "public.b", "public.tree", "public.outside"], keys);
    expect(plan.order.slice().sort()).toEqual(["public.a", "public.b", "public.c", "public.outside", "public.tree"]);
    const cycle = plan.deferred.filter((d) => d.child !== d.parent);
    expect(plan.deferred.filter((d) => d.child === d.parent).map((d) => d.child)).toEqual(["public.tree"]);
    expect(cycle).toHaveLength(1);
    // Every key that wasn't deferred has its parent loaded first; the one to a table outside the load is ignored.
    for (const k of keys.filter((k) => k.child !== k.parent && !cycle.includes(k) && k.parent !== "public.elsewhere")) {
      expect(plan.order.indexOf(k.parent), k.name).toBeLessThan(plan.order.indexOf(k.child));
    }
  });
  it("refuses a cycle with no nullable column", () => {
    expect(() => planLoad(["public.a", "public.b"], [fk("public.a", "public.b", false), fk("public.b", "public.a", false)])).toThrow(/cycle/);
  });
});

describe("export", () => {
  it("writes one file per table, the manifest and the storage list, with the counts the source has", () => {
    const manifest = JSON.parse(readFileSync(join(exportDir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.maxMigration).toBe(SOURCE_HEAD);
    expect(manifest.source).toEqual({ kind: "url" });
    expect(Object.keys(manifest.tables)).toContain("auth.users");
    expect(Object.keys(manifest.tables)).toContain("auth.identities");
    expect(Object.keys(manifest.tables)).not.toContain("public.schema_migrations");
    expect(manifest.tables["auth.users"]!.rows).toBe(7);
    expect(manifest.tables["public.person_capacity_factors"]).toBeDefined(); // no primary key: ordered by every column
    expect(manifest.storage).toEqual({ objects: 5, brandingDownloaded: 3, brandingFailed: 1 });
    for (const [name, { rows }] of Object.entries(manifest.tables)) {
      const file = JSON.parse(readFileSync(join(exportDir, `${name}.json`), "utf8")) as unknown[];
      expect(file, name).toHaveLength(rows);
    }
    expect(exportProblems).toEqual([expect.stringMatching(/^PROBLEM branding\/.*download answered 404/)]);
  });

  it("keeps auth to the listed columns: no password hashes or tokens", () => {
    const manifest = JSON.parse(readFileSync(join(exportDir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.tables["auth.users"]!.columns).toEqual([
      "id",
      "email",
      "email_confirmed_at",
      "last_sign_in_at",
      "raw_app_meta_data",
      "raw_user_meta_data",
      "banned_until",
      "created_at",
      "updated_at",
    ]);
    expect(Object.keys((JSON.parse(readFileSync(join(exportDir, "auth.identities.json"), "utf8")) as Record<string, unknown>[])[0]!)).not.toContain("email");
  });

  it("lists every storage object and downloads the branding ones only", () => {
    const storage = JSON.parse(readFileSync(join(exportDir, "storage.json"), "utf8")) as { bucket: string; name: string; size: number; contentType: string; file?: string; error?: string }[];
    expect(storage.filter((o) => o.bucket === "sources")).toHaveLength(1);
    const fine = storage.find((o) => o.name === logos.fine!.path)!;
    expect(fine).toMatchObject({ bucket: "branding", size: 2000, contentType: "image/png", file: brandingFile(logos.fine!.path) });
    expect(readFileSync(join(exportDir, fine.file!)).equals(logos.fine!.bytes)).toBe(true);
    expect(storage.find((o) => o.name === logos.gone!.path)).toMatchObject({ error: "download answered 404" });
    expect(storage.find((o) => o.name === logos.gone!.path)!.file).toBeUndefined();
  });

  it("is owner-only: a 0700 directory and 0600 files", () => {
    expect(statSync(exportDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(exportDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(exportDir, brandingFile(logos.fine!.path))).mode & 0o777).toBe(0o600);
  });

  it("refuses a directory inside the repository, and one that isn't empty", async () => {
    const src = await postgresSource(source.url);
    try {
      await expect(runExport({ out: join(scripts, "out"), source: src, sourceInfo: { kind: "url" } })).rejects.toThrow(/inside the repository/);
      await expect(runExport({ out: exportDir, source: src, sourceInfo: { kind: "url" } })).rejects.toThrow(/not empty/);
      // A folder at the repository's root whose name starts with "..", and a symlink from outside that leads back in.
      const repo = fileURLToPath(new URL("../../../", import.meta.url));
      await expect(runExport({ out: join(repo, "..copy-out"), source: src, sourceInfo: { kind: "url" } })).rejects.toThrow(/inside the repository/);
      expect(existsSync(join(repo, "..copy-out"))).toBe(false);
      const link = join(tmp(), "link");
      symlinkSync(scripts, link);
      await expect(runExport({ out: join(link, "out"), source: src, sourceInfo: { kind: "url" } })).rejects.toThrow(/inside the repository/);
      expect(existsSync(join(scripts, "out"))).toBe(false);
    } finally {
      await src.close();
    }
  });

  it("reads the same data in pages of any size", async () => {
    const dir = join(tmp(), "paged");
    const src = await postgresSource(source.url);
    try {
      const { manifest } = await runExport({ out: dir, source: src, sourceInfo: { kind: "url" }, pageSize: 3 });
      for (const name of Object.keys(manifest.tables)) {
        expect(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")), name).toEqual(JSON.parse(readFileSync(join(exportDir, `${name}.json`), "utf8")));
      }
    } finally {
      await src.close();
    }
  });
});

describe("export as a role that row-level security applies to", () => {
  it("refuses, rather than export only the rows the role can see", async () => {
    const role = `copy_reader_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`create role ${role} login password 'x' nosuperuser nobypassrls`);
      for (const schema of ["public", "auth", "storage"]) {
        await source.client.query(`grant usage on schema ${schema} to ${role}`);
        await source.client.query(`grant select on all tables in schema ${schema} to ${role}`);
      }
      const url = new URL(source.url);
      url.username = role;
      url.password = "x";
      const src = await postgresSource(url.toString());
      try {
        await expect(runExport({ out: join(tmp(), "rls"), source: src, sourceInfo: { kind: "url" } })).rejects.toThrow(
          /row-level security applies to this role on .*public\.workspaces/,
        );
      } finally {
        await src.close();
      }
    } finally {
      await source.client.query(`drop owned by ${role}`);
      await admin.query(`drop role if exists ${role}`);
      await admin.end();
    }
  });
});

describe("parseRowsExactly", () => {
  it("writes every number back as it was read", () => {
    const text = '[{"a":12345678901234567890.123456789,"b":1.50,"c":9007199254740993,"d":[0.10,-0],"e":{"x":1e400},"f":"1.50","g":null}]';
    expect(JSON.stringify(parseRowsExactly(text))).toBe(text);
    expect(() => parseRowsExactly('{"a":1}')).toThrow(/array/);
  });
});

describe("export through the Management API", () => {
  let api: Server;
  let base = "";
  const seen: { auth: string | undefined; path: string | undefined; query: string }[] = [];
  let throttle = 0;
  /** Run once against the source just before the API answers the first query matching `when` (a write the freeze should have stopped). */
  let interfere: { when: RegExp; sql: string } | undefined;

  beforeAll(async () => {
    api = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const { query } = JSON.parse(body) as { query: string };
        seen.push({ auth: req.headers.authorization, path: req.url, query });
        if (req.headers.authorization !== "Bearer test-token") {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Unauthorized: Bearer test-token was refused" }));
          return;
        }
        if (throttle > 0) {
          throttle--;
          res.writeHead(429, { "retry-after": "0" }).end("{}");
          return;
        }
        const before = interfere?.when.test(query) ? interfere.sql : undefined;
        if (before) interfere = undefined;
        (before ? source.client.query(before).then(() => source.client.query("select pg_stat_force_next_flush()")) : Promise.resolve())
          .then(() => source.client.query(query))
          .then(
          (r) => res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(r.rows)),
          (e: Error) => res.writeHead(400).end(JSON.stringify({ message: e.message })),
        );
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    // The source's own writes (the fixtures) reach the statistics up to seconds later; flush them so they don't count as writes
    // made during the export.
    await source.client.query("select pg_stat_force_next_flush()");
    await source.client.query("select 1");
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    api?.close();
  });

  it("posts {query} to /v1/projects/<ref>/database/query with the bearer token, and exports what --url does", async () => {
    const dir = join(tmp(), "api");
    throttle = 1; // the first answer is a 429, which is retried
    const src = managementApiSource({ ref: "abcdefghijklmnopqrst", token: "test-token", apiBase: base, retryDelayMs: 0 });
    const { manifest, problems } = await runExport({ out: dir, source: src, sourceInfo: { kind: "supabase", ref: "abcdefghijklmnopqrst" }, pageSize: 25 });
    expect(problems).toEqual([]);
    expect(seen.length).toBeGreaterThan(20);
    expect(new Set(seen.map((s) => s.auth))).toEqual(new Set(["Bearer test-token"]));
    expect(new Set(seen.map((s) => s.path))).toEqual(new Set(["/v1/projects/abcdefghijklmnopqrst/database/query"]));
    expect(seen.every((s) => /^\s*select\b/i.test(s.query))).toBe(true);
    expect(manifest.source).toEqual({ kind: "supabase", ref: "abcdefghijklmnopqrst" });
    for (const name of Object.keys(manifest.tables)) {
      expect(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")), name).toEqual(JSON.parse(readFileSync(join(exportDir, `${name}.json`), "utf8")));
    }
  });

  it("reports a table written to while the export ran, even when its row count did not change", async () => {
    const src = managementApiSource({ ref: "abcdefghijklmnopqrst", token: "test-token", apiBase: base, retryDelayMs: 0 });
    // An update that changes nothing visible: the row count and the data stay the same, so only the write counters show it.
    interfere = {
      when: /from "public"\."workspaces" order by/,
      sql: "update auth.identities set updated_at = updated_at where id = (select min(id::text)::uuid from auth.identities)",
    };
    const { problems } = await runExport({ out: join(tmp(), "api-changed"), source: src, sourceInfo: { kind: "supabase", ref: "abcdefghijklmnopqrst" }, pageSize: 25 });
    expect(interfere).toBeUndefined();
    expect(problems).toEqual([expect.stringMatching(/^auth\.identities: 1 row write\(s\) while the export ran/)]);
  });

  it("sends nothing that is not a select, and does not echo the token in an error", async () => {
    const before = seen.length;
    const good = managementApiSource({ ref: "abcdefghijklmnopqrst", token: "test-token", apiBase: base });
    await expect(good.query("drop table public.workspaces")).rejects.toThrow(/not a select/);
    await expect(good.query("select 1; select 2")).rejects.toThrow(/more than one/);
    expect(seen.length).toBe(before);
    const bad = managementApiSource({ ref: "abcdefghijklmnopqrst", token: "wrong", apiBase: base });
    const err = await bad.query("select 1").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/answered 401/);
    expect((err as Error).message).not.toContain("wrong");
    expect(() => managementApiSource({ ref: "abc/../x", token: "t" })).toThrow(/project ref/);
    expect(() => managementApiSource({ ref: "abcdefghijklmnopqrst", token: "" })).toThrow(/SUPABASE_ACCESS_TOKEN/);
  });
});

async function expectCopied(target: TestDb, report: ImportReport, preexistingAudit = 0) {
  const t = q(target);
  const s = q(source);

  // Counts: every table the source had, row for row; auth as it was.
  for (const table of [...(await publicTables(source)).filter((n) => n !== "audit_log").map((n) => `public.${n}`), "auth.users", "auth.identities"]) {
    expect(await count(target, table), table).toBe(await count(source, table));
  }
  // The copy didn't audit itself: the audit rows are the source's, plus the one for a rule the target had before.
  expect(await count(target, "audit_log")).toBe(sourceAuditRows + preexistingAudit);
  expect((await t("select count(*)::int as n from audit_log where target_table = 'deployment_access'"))[0]!.n).toBe(preexistingAudit);
  expect((await t("select count(*)::int as n from audit_log where diff ? 'old' and diff -> 'old' ? 'branding'"))[0]!.n).toBe(0);

  // Numbers arrive digit for digit.
  for (const sql of EXACT) expect(await t(sql), sql).toEqual(await s(sql));
  expect((await t("select tx::text as tx from issue_events where tx > 9007199254740992"))[0]).toEqual({ tx: "9007199254740993" });

  // auth.users and identities arrive as they were; sync_auth_user did not rewrite them.
  const authRows = "select id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data from auth.users order by id";
  expect(await t(authRows)).toEqual(await s(authRows));
  const idRows = "select id, user_id, provider, provider_id, identity_data from auth.identities order by id";
  expect(await t(idRows)).toEqual(await s(idRows));

  // Better Auth: a user per auth user with an email, an account per Google identity.
  const owner = users.owner!;
  expect(await t(`select id, name, email, "emailVerified", image from better_auth."user" where id = $1`, [owner.id])).toEqual([
    { id: owner.id, name: "Olive Owner", email: "owner@acme.example.com", emailVerified: true, image: "https://example.com/o.png" },
  ]);
  expect(await t(`select "accountId", "providerId", "userId" from better_auth.account where "userId" = $1`, [owner.id])).toEqual([
    { accountId: owner.id, providerId: "google", userId: owner.id },
  ]);
  expect((await t(`select "emailVerified" from better_auth."user" where id = $1`, [users.unconfirmed!.id]))[0]).toEqual({ emailVerified: false });
  // createdAt and updatedAt are the Supabase user's, not the time of the copy.
  expect(
    (await t(`select "createdAt" = '2025-03-04 05:06:07.123456+00' as c, "updatedAt" = '2025-06-07 08:09:10+00' as u from better_auth."user" where id = $1`, [owner.id]))[0],
  ).toEqual({ c: true, u: true });
  expect((await t(`select name from better_auth."user" where id = $1`, [users.editor!.id]))[0]).toEqual({ name: "editor" });
  expect((await t(`select count(*)::int as n from better_auth."user"`))[0]!.n).toBe(6);
  expect((await t(`select count(*)::int as n from better_auth.account`))[0]!.n).toBe(3);
  expect(report.betterAuth).toMatchObject({ users: 6, accounts: 3, otherProviders: { email: 1 }, skippedUsers: [{ id: users.noEmail!.id, reason: "no email" }] });

  // Logos: the good one, with its hash; the rest reported, none loaded.
  const fine = logos.fine!;
  expect(await t("select workspace_id, mime, octet_length(bytes)::int as n, sha256 from workspace_logos order by 1")).toEqual([
    { workspace_id: fine.workspace, mime: "image/png", n: 2000, sha256: sha(fine.bytes) },
  ]);
  expect((await t("select bytes from workspace_logos"))[0]!.bytes.equals(fine.bytes)).toBe(true);
  expect(report.logos.loaded).toEqual([{ workspaceId: fine.workspace, mime: "image/png", bytes: 2000, sha256: sha(fine.bytes) }]);
  expect(report.logos.oversized).toEqual([{ workspaceId: logos.big!.workspace, path: logos.big!.path, bytes: 600_000 }]);
  expect(report.logos.skipped.map((l) => [l.workspaceId, l.reason]).sort()).toEqual(
    [
      [logos.gif!.workspace, "type image/gif is not PNG, JPEG or WebP"],
      [logos.gone!.workspace, "its bytes are not in the export (download answered 404)"],
      [logos.unlisted!.workspace, "no such object in storage.json"],
    ].sort(),
  );
  expect(report.storageNotCopied).toEqual({ branding: 3, sources: 1 });

  // The step-4 shape: file columns and logo_path are gone, the rest of the rows kept.
  const cols = await t("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sources'");
  expect(cols.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(["file_path"]));
  expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(["file_url", "title"]));
  expect(await t("select title, body from sources where title = 'Interview notes'")).toEqual([{ title: "Interview notes", body: "body text" }]);
  expect(report.droppedColumns["public.sources"]).toEqual(["file_path", "file_name", "file_type", "file_size"]);
  expect(report.droppedColumns["auth.users"]).toEqual(["created_at", "updated_at"]);
  expect((await t("select count(*)::int as n from workspaces where branding ? 'logo_path'"))[0]!.n).toBe(0);
  expect((await t("select branding from workspaces where id = $1", [fine.workspace]))[0]!.branding).toEqual({ accent: "#112233" });
  expect((await t("select branding from workspaces where id = $1", [NORTHBEAM]))[0]!.branding).toEqual({ accent: "#aa00aa", accent_dark: "#00aaaa" });

  // Deployment access: admin, editor (owner or editor anywhere), viewer; a rule that was already there is kept.
  const rules = await t("select value, role from deployment_access where kind = 'email' order by value");
  expect(rules).toEqual([
    { value: "admin@acme.example.com", role: "admin" },
    { value: "editor@acme.example.com", role: "editor" },
    { value: "new@acme.example.com", role: "viewer" },
    { value: "owner@acme.example.com", role: "editor" },
    { value: "viewer@acme.example.com", role: preexistingAudit ? "editor" : "viewer" },
  ]);
  expect(report.deploymentAccess.skipped).toEqual(
    expect.arrayContaining([
      { email: null, reason: "no email" },
      { email: "weird@localhost", reason: "not an address deployment_access accepts" },
    ]),
  );

  // The Better Auth trigger and the others are back on.
  expect((await t("select count(*)::int as n from pg_trigger where not tgisinternal and tgenabled <> 'O'"))[0]!.n).toBe(0);

  // Sequences follow the data.
  const events = await t("select coalesce(max(seq), 0)::int as m from issue_events");
  const next = (await t("select nextval('issue_events_seq_seq')::int as v"))[0]!.v as number;
  expect(next).toBeGreaterThan(events[0]!.m);
}

async function signInAndRead(target: TestDb) {
  // The copied owner signs in through createDb's claims and sees their workspaces under RLS, and only theirs.
  const owner = users.owner!;
  const db = target.dbAs({ sub: owner.id, role: "authenticated", email: "owner@acme.example.com", app_metadata: {} });
  const mine = await db.selectFrom("workspaces").select(["id", "slug"]).orderBy("slug").execute();
  expect(mine.map((w) => w.slug)).toEqual(["larkspur", "northbeam"]);
  const stranger = target.dbAs({ sub: users.viewer!.id, role: "authenticated", email: users.viewer!.email, app_metadata: {} });
  expect((await stranger.selectFrom("workspaces").select("slug").execute()).map((w) => w.slug)).toEqual(["northbeam"]);
  const admin = target.dbAs({ sub: users.admin!.id, role: "authenticated", email: "admin@acme.example.com", app_metadata: { agency_admin: true } });
  expect((await admin.selectFrom("workspaces").select("id").execute()).length).toBe(await count(target, "workspaces"));
}

describe.each([
  ["replica path", false],
  ["fallback path", true],
])("import, %s", (_name, forceFallback) => {
  let target: TestDb;
  let report: ImportReport;
  let verified: Awaited<ReturnType<typeof runVerify>>;

  beforeAll(async () => {
    target = await emptyTarget();
    // A rule the deployment already had for one of the users stays as it is.
    await target.client.query("insert into deployment_access (kind, value, role) values ('email', 'viewer@acme.example.com', 'editor')");
    report = await runImport(target.client, { dir: exportDir, forceFallback, chunkSize: 50 });
    verified = await runVerify(target.client, exportDir);
  }, 120_000);

  it("takes the path it reports", () => {
    expect(report.path).toBe(forceFallback ? "fallback" : "replica");
    expect(report.pathReason).toMatch(forceFallback ? /forced by --no-replica/ : /replica was accepted/);
    expect(report.triggersDisabledOn.length > 0).toBe(forceFallback);
    // Self-references and cycles are loaded as null and filled in, on the fallback path only.
    expect(report.deferredKeys.length > 0).toBe(forceFallback);
    if (forceFallback) expect(report.deferredKeys).toEqual(expect.arrayContaining([expect.stringMatching(/^public\.(processes|steps|scenarios)\./)]));
    expect(formatReport(report).join("\n")).toContain(`path: ${report.path}`);
  });

  it("copies the data, the Better Auth rows, the logo, the access rules, and none of the audit", async () => {
    await expectCopied(target, report, 1);
    // The rule that was already there is kept, and reported.
    expect((await target.client.query("select role from deployment_access where value = 'viewer@acme.example.com'")).rows).toEqual([{ role: "editor" }]);
    expect(report.deploymentAccess.existing).toEqual(["viewer@acme.example.com"]);
  });

  it("passes verify", () => {
    expect(verified.lines.filter((l) => l.status === "FAIL")).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.lines.some((l) => /foreign keys checked by anti-join, 0 broken/.test(l.text))).toBe(true);
  });

  it("lets a copied user sign in and read their workspace under RLS", async () => {
    await signInAndRead(target);
  });
});

describe("import, the rest", () => {
  it("rolls everything back on --dry-run", async () => {
    const target = await emptyTarget();
    const report = await runImport(target.client, { dir: exportDir, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.tables["public.workspaces"]).toBeGreaterThan(0);
    expect(report.betterAuth.users).toBe(6);
    expect(formatReport(report)[0]).toMatch(/^DRY RUN \(rolled back\)/);
    for (const table of ["auth.users", "better_auth.user", "public.workspaces", "public.workspace_logos", "public.deployment_access"]) {
      expect(await count(target, table), table).toBe(0);
    }
    expect((await target.client.query("select current_setting('session_replication_role') as r")).rows[0].r).toBe("origin");
  });

  it("refuses a target that has data, or isn't at head, and changes nothing", async () => {
    const target = await emptyTarget();
    await runImport(target.client, { dir: exportDir });
    await expect(runImport(target.client, { dir: exportDir })).rejects.toThrow(/already has rows in .*public\.workspaces/);
    expect(await count(target, "workspaces")).toBe(await count(source, "workspaces"));

    // A database that is behind (the source itself, at 20261227000000) is not a target.
    await expect(runImport(source.client, { dir: exportDir })).rejects.toThrow(/not at the current head/);
  });

  it("fails, writing nothing, when another session holds a lock on a table it writes", async () => {
    const target = await emptyTarget();
    const other = new pg.Client({ connectionString: target.url });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("lock table auth.users in row exclusive mode");
      await expect(runImport(target.client, { dir: exportDir, lockTimeout: "200ms" })).rejects.toThrow(/lock timeout/);
      await other.query("rollback");
    } finally {
      await other.end();
    }
    expect(await count(target, "workspaces")).toBe(0);
    expect((await target.client.query("select count(*)::int as n from pg_trigger where not tgisinternal and tgenabled <> 'O'")).rows[0].n).toBe(0);
  });

  it("leaves the target untouched, triggers on, when a row is refused after the fallback switched them off", async () => {
    // A copy of the export with one person's fte past the table's check (fte <= 1.5): people load late, after every trigger is off.
    const dir = join(tmp(), "bad-row");
    cpSync(exportDir, dir, { recursive: true });
    rmSync(join(dir, "import-report.json"), { force: true });
    const file = join(dir, "public.people.json");
    const text = readFileSync(file, "utf8");
    expect(text).toContain('"fte":1.50');
    writeFileSync(file, text.replace('"fte":1.50', '"fte":5'));
    const target = await emptyTarget();
    await expect(runImport(target.client, { dir, forceFallback: true })).rejects.toThrow(/people_fte_check|check constraint/);
    expect((await target.client.query("select count(*)::int as n from pg_trigger where not tgisinternal and tgenabled <> 'O'")).rows[0].n).toBe(0);
    for (const table of ["auth.users", "better_auth.user", "public.workspaces", "public.people", "public.deployment_access"]) {
      expect(await count(target, table), table).toBe(0);
    }
  });

  it("imports and verifies through @neondatabase/serverless over a WebSocket, as from the cloud container", async () => {
    // Neon's WebSocket proxy, locally: each socket carries the Postgres protocol to the address in its query string.
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const relayed: string[] = [];
    wss.on("connection", (ws, req) => {
      const address = new URL(req.url ?? "", "http://relay").searchParams.get("address") ?? "";
      relayed.push(address);
      const [host, port] = address.split(":");
      const tcp = tcpConnect(Number(port), host!);
      tcp.on("data", (d) => ws.send(d));
      tcp.on("close", () => ws.close());
      tcp.on("error", () => ws.close());
      ws.on("message", (d) => tcp.write(d as Buffer));
      ws.on("close", () => tcp.destroy());
    });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const relay = `127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const neonWs = { secure: false, wsProxy: (host: string, port: number | string) => `${relay}/v2?address=${host}:${port}` };

    // The migrations take the same route (scripts/migrate.ts --driver neon-ws), into a database with nothing in it.
    const bare = `copy_neon_ws_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`create database ${bare}`);
      const bareUrl = new URL(ADMIN_URL);
      bareUrl.pathname = `/${bare}`;
      const migrating = await connectTarget(bareUrl.toString(), "neon-ws", neonWs);
      try {
        await applyCompat(migrating.client);
        expect((await applyMigrations(migrating.client)).files).toEqual(migrationFiles());
      } finally {
        await migrating.close();
      }
    } finally {
      await admin.query(`drop database if exists ${bare} with (force)`);
      await admin.end();
    }

    const target = await emptyTarget();
    const conn = await connectTarget(target.url, "neon-ws", neonWs);
    let report: ImportReport;
    try {
      expect(conn.client).not.toBeInstanceOf(pg.Client);
      report = await runImport(conn.client, { dir: exportDir, forceFallback: true, chunkSize: 50 });
      expect(report.path).toBe("fallback");
      const verified = await runVerify(conn.client, exportDir);
      expect(verified.lines.filter((l) => l.status === "FAIL")).toEqual([]);
      expect(relayed.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
      await new Promise<void>((r) => wss.close(() => r()));
    }
    await expectCopied(target, report);
  }, 120_000);

  it("falls back for real when the database refuses the replica role (42501), as a non-superuser owner is", async () => {
    const owner = `copy_owner_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const target = await emptyTarget();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    let client: pg.Client | undefined;
    try {
      // What Neon's owner is: it can create roles and is not a superuser, and it owns the tables. (The migrations ran as the
      // superuser here, so the tables are handed over; the migration runner itself is not what is under test.)
      await admin.query(`create role ${owner} login password 'x' createrole nosuperuser`);
      await target.client.query(`grant usage on schema public, private to ${owner}`);
      await target.client.query(`grant execute on all functions in schema public, private to ${owner}`);
      for (const stmt of [
        `select format('alter schema %I owner to ${owner}', nspname) from pg_namespace where nspname in ('auth', 'better_auth')`,
        `select format('alter table %I.%I owner to ${owner}', schemaname, tablename) from pg_tables where schemaname in ('public', 'auth', 'better_auth')`,
        `select format('alter sequence %I.%I owner to ${owner}', schemaname, sequencename) from pg_sequences where schemaname in ('public', 'auth', 'better_auth')`,
      ]) {
        const { rows } = await target.client.query(stmt);
        for (const r of rows) await target.client.query(Object.values(r)[0] as string);
      }
      const url = new URL(target.url);
      url.username = owner;
      url.password = "x";
      client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      expect((await client.query("select rolsuper from pg_roles where rolname = current_user")).rows[0].rolsuper).toBe(false);
      await expect(client.query("set session_replication_role = replica")).rejects.toMatchObject({ code: "42501" });

      const report = await runImport(client, { dir: exportDir });
      expect(report.path).toBe("fallback");
      expect(report.pathReason).toMatch(/refused \(42501/);
      expect((await client.query("select count(*)::int as n from workspaces")).rows[0].n).toBe(await count(source, "workspaces"));
      expect((await client.query("select count(*)::int as n from audit_log")).rows[0].n).toBe(sourceAuditRows);
      const verified = await runVerify(client, exportDir);
      expect(verified.lines.filter((l) => l.status === "FAIL")).toEqual([]);
      await client.end();
      client = undefined;
      await expectCopied(target, report);
    } finally {
      await client?.end();
      // Grants and ownership live in the target's database; the role itself in the cluster.
      await target.client.query(`reassign owned by ${owner} to postgres`);
      await target.client.query(`drop owned by ${owner}`);
      await admin.query(`drop role if exists ${owner}`);
      await admin.end();
    }
  }, 120_000);
});

describe("verify", () => {
  it("fails, and the script exits 1, on a missing row, a dangling reference and a trigger left off; passes with exit 0 otherwise", async () => {
    const target = await emptyTarget();
    const run = (...args: string[]) =>
      execFileAsync("node", ["--experimental-strip-types", "--no-warnings", join(scripts, args[0]!), ...args.slice(1)], { env: { ...process.env, DATABASE_URL: "" } }).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
      );

    const dry = await run("import.ts", "--in", exportDir, "--url", target.url, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/DRY RUN \(rolled back\); path: replica/);
    expect(existsSync(join(exportDir, "import-report.json"))).toBe(false);

    const done = await run("import.ts", "--in", exportDir, "--url", target.url);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/Imported; path: replica/);
    expect(done.out).toMatch(/OVERSIZED logo/);
    expect(statSync(join(exportDir, "import-report.json")).mode & 0o777).toBe(0o600);

    const good = await run("verify.ts", "--in", exportDir, "--url", target.url);
    expect(good, good.out).toMatchObject({ code: 0 });
    expect(good.out).toMatch(/VERIFIED/);

    // Damage it the way an unchecked load could: a parent gone with its children left behind, a trigger off.
    const fixture = "select (select count(*)::int from public.people) as people";
    const before = (await target.client.query(fixture)).rows[0].people as number;
    await target.client.query("begin");
    await target.client.query("set local session_replication_role = replica");
    await target.client.query("delete from public.workspaces where id = $1", [LARKSPUR]);
    // And a value changed in place, which no count shows.
    await target.client.query("update public.people set cost_rate = 12345678901234567000 where cost_rate = 12345678901234567890.123456789012345678");
    await target.client.query("commit");
    await target.client.query("alter table public.roles disable trigger user");
    expect((await target.client.query(fixture)).rows[0].people).toBe(before);
    const bad = await run("verify.ts", "--in", exportDir, "--url", target.url);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL public\.workspaces: \d+ rows, export had \d+/);
    expect(bad.out).toMatch(/FAIL public\.people: 1 exported row\(s\) are missing or differ/);
    expect(bad.out).toMatch(/ok   public\.issue_events: every exported row is in the target unchanged/);
    expect(bad.out).toMatch(/FAIL .*\.roles_workspace_id_fkey: \d+ row\(s\) reference a missing public\.workspaces/);
    expect(bad.out).toMatch(/FAIL 1 user trigger\(s\) are not enabled|FAIL \d+ user trigger\(s\) are not enabled/);
    expect(bad.out).toMatch(/VERIFY FAILED/);

    const result = await runVerify(target.client, exportDir);
    expect(result.ok).toBe(false);
  });
});
