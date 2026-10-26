import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, toJsonTimestamp, type Claims } from "../src/client";
import type { DB } from "../src/db-types";
import { LOCK_TIMEOUT, applyCompat, applyMigrations, migrationFiles } from "../src/migrations";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// createDb and its ClaimsDriver (src/client.ts): every query runs as authenticated / anon with the caller's claims,
// so RLS applies; plus the migration runner (src/migrations.ts, scripts/migrate.ts).

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const ws = NORTHBEAM_WORKSPACE_ID;
const run = promisify(execFile);

let db: TestDb;
let pool: pg.Pool;
let member: { id: string; claims: Claims };
let stranger: { id: string; claims: Claims };

const as = (u: { claims: Record<string, unknown> } | null): Kysely<DB> => createDb(pool, (u?.claims as Claims | undefined) ?? null);
const workspaceNames = async (kdb: Kysely<DB>) => (await kdb.selectFrom("workspaces").select("name").execute()).map((r) => r.name);

beforeAll(async () => {
  db = await createTestDb();
  // One connection, so a connection a test breaks or poisons is the one the next test gets.
  pool = createPool(db.url, { max: 1 });
  member = (await createUser(db, "owner@client.example")) as typeof member;
  stranger = (await createUser(db, "stranger@client.example")) as typeof stranger;
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, member.id]);
});

afterAll(async () => {
  await pool?.end();
  await db?.close();
});

describe("claims", () => {
  it("sets auth.uid() and the role for a signed-in user, and RLS shows only their rows", async () => {
    const kdb = as(member);
    const { rows } = await sql<{ uid: string; who: string }>`select auth.uid() as uid, current_user as who`.execute(kdb);
    expect(rows).toEqual([{ uid: member.id, who: "authenticated" }]);
    expect(await workspaceNames(kdb)).toEqual(["Northbeam Digital"]);
    expect(await workspaceNames(as(stranger))).toEqual([]);
  });

  it("reads app_metadata from the claims (agency admin sees every workspace)", async () => {
    const admin = await createUser(db, "admin@client.example", { agency_admin: true });
    expect((await workspaceNames(as(admin))).length).toBeGreaterThan(1);
  });

  it("runs as anon with no claims, and tables are closed to it", async () => {
    const kdb = as(null);
    const { rows } = await sql<{ uid: string | null; who: string }>`select auth.uid() as uid, current_user as who`.execute(kdb);
    expect(rows).toEqual([{ uid: null, who: "anon" }]);
    // anon holds no table privileges at all (20261224000000_revoke_unused_table_privileges.sql): refused, not empty.
    await expect(workspaceNames(kdb)).rejects.toMatchObject({ code: "42501" });
  });

  it("does not leak one query's role or claims into the next on the same connection", async () => {
    await sql`select 1`.execute(as(member));
    const { rows } = await sql<{ uid: string | null; who: string }>`select auth.uid() as uid, current_user as who`.execute(as(null));
    expect(rows).toEqual([{ uid: null, who: "anon" }]);
    const { rows: after } = await sql<{ who: string }>`select current_user as who`.execute(createDb(pool, null));
    expect(after[0]!.who).toBe("anon");
    const owner = await pool.connect();
    try {
      // The setting was transaction-local: it reads as unset (or empty once set in this session), never as the claims.
      const r = (await owner.query("select current_user as who, current_setting('request.jwt.claims', true) as c")).rows[0];
      expect({ who: r.who, c: r.c ?? "" }).toEqual({ who: "postgres", c: "" });
    } finally {
      owner.release();
    }
  });

  it("escapes claim values", async () => {
    const nasty = { ...member.claims, email: "o'brien\\'; select 1 --" } as Claims;
    const { rows } = await sql<{ email: string }>`select auth.jwt() ->> 'email' as email`.execute(createDb(pool, nasty));
    expect(rows[0]!.email).toBe(nasty.email);
  });
});

describe("transactions", () => {
  const nameOf = async () => (await db.client.query("select name from workspaces where id = $1", [ws])).rows[0].name as string;

  it("rolls back when the callback throws, and the claims apply inside", async () => {
    const before = await nameOf();
    await expect(
      as(member)
        .transaction()
        .execute(async (trx) => {
          const { rows } = await sql<{ uid: string }>`select auth.uid() as uid`.execute(trx);
          expect(rows[0]!.uid).toBe(member.id);
          await trx.updateTable("workspaces").set({ name: "Renamed" }).where("id", "=", ws).execute();
          // The change is visible inside, under RLS.
          expect((await trx.selectFrom("workspaces").select("name").execute()).map((r) => r.name)).toEqual(["Renamed"]);
          throw new Error("boom");
        }),
    ).rejects.toThrow("boom");
    expect(await nameOf()).toBe(before);
  });

  it("commits when the callback returns", async () => {
    const before = await nameOf();
    await as(member)
      .transaction()
      .execute((trx) => trx.updateTable("workspaces").set({ name: "Committed" }).where("id", "=", ws).execute());
    expect(await nameOf()).toBe("Committed");
    await db.client.query("update workspaces set name = $1 where id = $2", [before, ws]);
  });

  it("commits a single statement outside a transaction", async () => {
    const before = await nameOf();
    await as(member).updateTable("workspaces").set({ name: "Single" }).where("id", "=", ws).execute();
    expect(await nameOf()).toBe("Single");
    await db.client.query("update workspaces set name = $1 where id = $2", [before, ws]);
  });

  it("a statement RLS refuses changes nothing", async () => {
    const before = await nameOf();
    const res = await as(stranger).updateTable("workspaces").set({ name: "Hijacked" }).where("id", "=", ws).executeTakeFirst();
    expect(res.numUpdatedRows).toBe(0n);
    expect(await nameOf()).toBe(before);
  });

  it("supports savepoints inside a transaction", async () => {
    const before = await nameOf();
    const trx = await as(member).startTransaction().execute();
    const sp = await trx.savepoint("sp1").execute();
    await sp.updateTable("workspaces").set({ name: "Inner" }).where("id", "=", ws).execute();
    await sp.rollbackToSavepoint("sp1").execute();
    await sp.commit().execute();
    expect(await nameOf()).toBe(before);
  });
});

describe("nothing runs as the owner role", () => {
  const who = sql<{ who: string; uid: string | null }>`select current_user as who, auth.uid() as uid`;

  it("re-applies the claims after a transaction rolls back inside db.connection()", async () => {
    const after = await as(member)
      .connection()
      .execute(async (conn) => {
        await expect(
          conn.transaction().execute(async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        return (await who.execute(conn)).rows[0];
      });
    expect(after).toEqual({ who: "authenticated", uid: member.id });
  });

  it("re-applies the claims after a raw commit, rollback, reset role or set role", async () => {
    const seen = await as(member)
      .connection()
      .execute(async (conn) => {
        const out: unknown[] = [];
        for (const stmt of ["commit", "rollback", "reset role", "set role postgres", "set session authorization postgres"]) {
          await sql.raw(stmt).execute(conn);
          out.push((await who.execute(conn)).rows[0]);
        }
        return out;
      });
    expect(seen).toEqual(Array(5).fill({ who: "authenticated", uid: member.id }));
  });

  it("refuses several statements in one query", async () => {
    await expect(sql.raw("commit; select current_user").execute(as(member))).rejects.toMatchObject({ code: "42601" });
  });

  it("ignores legacy per-claim settings left on a pooled connection", async () => {
    const c = await pool.connect();
    await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim', '{}', false)", [stranger.id]);
    c.release();
    expect((await who.execute(as(member))).rows[0]).toEqual({ who: "authenticated", uid: member.id });
    expect((await who.execute(as(null))).rows[0]).toEqual({ who: "anon", uid: null });
  });

  it("forces the claims' role to match the database role", async () => {
    const forged = { ...member.claims, role: "service_role" } as unknown as Claims;
    const { rows } = await sql<{ r: string }>`select auth.role() as r`.execute(createDb(pool, forged));
    expect(rows[0]!.r).toBe("authenticated");
    const { rows: anon } = await sql<{ r: string }>`select auth.role() as r`.execute(as(null));
    expect(anon[0]!.r).toBe("anon");
  });
});

describe("a failed query doesn't poison the pool", () => {
  it("serves the next query on the same connection after a statement error", async () => {
    const kdb = as(member);
    await expect(sql`select 1 / 0`.execute(kdb)).rejects.toMatchObject({ code: "22012" });
    expect(pool.totalCount).toBe(1);
    expect((await sql<{ n: number }>`select 1 as n`.execute(kdb)).rows).toEqual([{ n: 1 }]);
    expect(pool.totalCount).toBe(1);
  });

  it("serves the next query after a failed transaction", async () => {
    const kdb = as(member);
    await expect(
      kdb.transaction().execute(async (trx) => {
        await sql`select 1 / 0`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "22012" });
    expect((await sql<{ who: string }>`select current_user as who`.execute(kdb)).rows).toEqual([{ who: "authenticated" }]);
  });

  it("drops a connection that dies mid-transaction instead of returning it to the pool", async () => {
    const kdb = as(member);
    await expect(
      kdb.transaction().execute(async (trx) => {
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
        await db.client.query("select pg_terminate_backend($1)", [rows[0]!.pid]);
        await sql`select 1`.execute(trx);
      }),
    ).rejects.toThrow();
    expect((await sql<{ n: number }>`select 1 as n`.execute(kdb)).rows).toEqual([{ n: 1 }]);
  });
});

describe("type parsing", () => {
  it("matches PostgREST: numeric and int8 are numbers, dates stay strings, json parses", async () => {
    await db.client.query(`create table public.type_probe (
      n numeric, b int8, tz timestamptz, ts timestamp, d date, j jsonb, na numeric[], ba int8[], da date[], tza timestamptz[]
    )`);
    await db.client.query("grant select on public.type_probe to authenticated");
    await db.client.query(
      `insert into public.type_probe values (12.50, 9007199254740, '2026-10-26 10:00:00+00', '2026-10-26 10:00:00', '2026-10-26',
        '{"a": [1, {"b": null}]}', '{1.5,2}', '{3,4}', '{2026-10-26,2026-10-27}', '{"2026-10-26 10:00:00+00"}')`,
    );
    const { rows } = await sql<Record<string, unknown>>`select * from public.type_probe`.execute(as(member));
    const r = rows[0]!;
    expect(r.n).toBe(12.5);
    expect(r.b).toBe(9007199254740);
    expect(r.tz).toBe("2026-10-26T10:00:00+00:00");
    expect(r.ts).toBe("2026-10-26T10:00:00");
    expect(r.d).toBe("2026-10-26");
    expect(r.j).toEqual({ a: [1, { b: null }] });
    expect(r.na).toEqual([1.5, 2]);
    expect(r.ba).toEqual([3, 4]);
    expect(r.da).toEqual(["2026-10-26", "2026-10-27"]);
    expect(r.tza).toEqual(["2026-10-26T10:00:00+00:00"]);
  });

  // What PostgREST sent was to_json() of the value, in a UTC session.
  const timestamps = [
    "2026-10-26 10:00:00+00",
    "2026-10-26 10:00:00.5+00",
    "2026-10-26 10:00:00.123456+00",
    "2026-10-26 23:59:59.999999+05:30",
    "1850-06-01 12:00:00 Europe/Amsterdam",
    "0044-03-15 10:00:00+00 BC",
    "12026-01-01 00:00:00+00",
    "infinity",
    "-infinity",
  ];
  const probe = (cast: string) =>
    sql<{ v: unknown; j: unknown; va: unknown; ja: unknown }>`
      select x.v, to_json(x.v) as j, array[x.v, null] as va, to_json(array[x.v, null]) as ja
      from (select unnest(${timestamps}::text[])::${sql.raw(cast)} as v) x`;

  it.each(["timestamptz", "timestamp"])("returns %s exactly as to_json() does, arrays included", async (cast) => {
    const { rows } = await probe(cast).execute(as(member));
    expect(rows).toHaveLength(timestamps.length);
    for (const r of rows) {
      expect(r.v).toBe(r.j);
      expect(r.va).toEqual(r.ja);
    }
    expect(rows[0]!.v).toBe(cast === "timestamptz" ? "2026-10-26T10:00:00+00:00" : "2026-10-26T10:00:00");
  });

  it("runs in UTC with ISO dates whatever the session defaults are, as PostgREST on Supabase did", async () => {
    const other = createPool(db.url, { max: 1, options: "-c TimeZone=Asia/Kolkata -c DateStyle=SQL,DMY" });
    try {
      const { rows } = await probe("timestamptz").execute(createDb(other, member.claims));
      for (const r of rows) expect(r.v).toBe(r.j);
      expect(rows[0]!.v).toBe("2026-10-26T10:00:00+00:00");
      const { rows: d } = await sql<{ d: string }>`select '2026-10-26'::date as d`.execute(createDb(other, null));
      expect(d[0]!.d).toBe("2026-10-26");
    } finally {
      await other.end();
    }
  });

  it("converts the text forms Postgres outputs for any offset", () => {
    expect(toJsonTimestamp("2026-10-26 15:30:00.1234+05:30")).toBe("2026-10-26T15:30:00.1234+05:30");
    expect(toJsonTimestamp("2026-10-26 07:30:00-02")).toBe("2026-10-26T07:30:00-02:00");
    expect(toJsonTimestamp("1850-01-01 05:53:28+05:53:28")).toBe("1850-01-01T05:53:28+05:53:28");
    expect(toJsonTimestamp("0044-03-15 10:00:00 BC")).toBe("0044-03-15T10:00:00 BC");
  });

  it("leaves other pg users on pg's defaults (parsers are per pool)", async () => {
    const r = await db.client.query("select 12.50::numeric as n, '2026-10-26'::date as d");
    expect(r.rows[0].n).toBe("12.50");
    expect(r.rows[0].d).toBeInstanceOf(Date);
  });
});

describe("migration runner", () => {
  const databases: string[] = [];
  const urlOf = (name: string) => {
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    return u.toString();
  };
  async function emptyDatabase() {
    const name = `transpera_flow_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    databases.push(name);
    return name;
  }
  const migrateCli = (name: string, ...args: string[]) =>
    run("node", ["--experimental-strip-types", "--no-warnings", "scripts/migrate.ts", ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: urlOf(name) },
    });

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of databases) await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  });

  it("applies to an empty database, is a no-op the second time, and a dry run lists nothing after", { timeout: 60_000 }, async () => {
    const name = await emptyDatabase();
    const c = new pg.Client({ connectionString: urlOf(name) });
    await c.connect();
    try {
      const all = migrationFiles();
      expect((await applyMigrations(c, { dryRun: true })).files).toEqual(all);
      await applyCompat(c);
      const first = await applyMigrations(c);
      expect(first.files).toEqual(all);
      expect((await c.query("select count(*)::int as n from public.schema_migrations")).rows[0]!.n).toBe(all.length);
      await applyCompat(c);
      expect((await applyMigrations(c)).files).toEqual([]);
      expect((await applyMigrations(c, { dryRun: true })).files).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("scripts/migrate.ts builds the schema and seed on a fresh database, then reports nothing pending", { timeout: 60_000 }, async () => {
    const name = await emptyDatabase();
    expect((await migrateCli(name, "--dry-run")).stdout).toContain(`Pending ${migrationFiles().length} migration(s)`);
    expect((await migrateCli(name, "--seed")).stdout).toContain("and the seed");
    expect((await migrateCli(name, "--dry-run")).stdout).toContain("Nothing to apply");
    const c = new pg.Client({ connectionString: urlOf(name) });
    await c.connect();
    try {
      expect((await c.query("select count(*)::int as n from public.workspaces")).rows[0]!.n).toBeGreaterThan(0);
    } finally {
      await c.end();
    }
  });

  it("runs one runner at a time: a concurrent second run waits, then finds nothing to apply", { timeout: 60_000 }, async () => {
    const name = await emptyDatabase();
    const clients = [new pg.Client({ connectionString: urlOf(name) }), new pg.Client({ connectionString: urlOf(name) })];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      await applyCompat(clients[0]!);
      const results = await Promise.all(clients.map((c) => applyMigrations(c)));
      expect(results.map((r) => r.files.length).sort((a, b) => a - b)).toEqual([0, migrationFiles().length]);
      const grants = await clients[0]!.query(
        "select grantee from information_schema.role_table_grants where table_name = 'schema_migrations' and grantee <> current_user",
      );
      expect(grants.rows).toEqual([]);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("lets a non-superuser owner (Neon's neondb_owner) set role after compat.sql", async () => {
    // From Postgres 16 a role that creates anon/authenticated holds them with admin option only (no SET, no INHERIT),
    // which is what Neon's neondb_owner ends up with. Reproduce that grant, then let compat.sql run as the owner.
    const owner = "transpera_flow_test_owner";
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `transpera_flow_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      await admin.query(`do $$ begin
        create role ${owner} login password 'owner' createrole createdb;
      exception when duplicate_object or unique_violation then null; end $$`);
      await admin.query(`revoke anon, authenticated, service_role from ${owner} cascade`);
      await admin.query(`grant anon, authenticated, service_role to ${owner} with admin true, set false, inherit false`);
      await admin.query(`create database ${name} owner ${owner}`);
      databases.push(name);
    } finally {
      await admin.end();
    }
    const u = new URL(urlOf(name));
    u.username = owner;
    u.password = "owner";
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      await expect(c.query("set role authenticated")).rejects.toMatchObject({ code: "42501" });
      await applyCompat(c);
      await applyCompat(c);
      const grants = await c.query(
        `select r.rolname as role, m.set_option, m.inherit_option from pg_auth_members m join pg_roles r on r.oid = m.roleid
         where m.member = current_user::regrole and m.grantor = current_user::regrole order by 1`,
      );
      expect(grants.rows).toEqual(
        ["anon", "authenticated", "service_role"].map((role) => ({ role, set_option: true, inherit_option: false })),
      );
      await c.query("set role authenticated");
      expect((await c.query("select current_user as who")).rows[0].who).toBe("authenticated");
    } finally {
      await c.end();
    }
  });

  it("gives each migration a lock timeout inside its own transaction, so it fails rather than queueing behind traffic", async () => {
    const name = await emptyDatabase();
    const c = new pg.Client({ connectionString: urlOf(name) });
    await c.connect();
    try {
      await applyCompat(c);
      const sent: string[] = [];
      const spy = { query: (text: string, values?: unknown[]) => (sent.push(text), c.query(text, values)) };
      const { files } = await applyMigrations(spy);
      const begins = sent.flatMap((q, i) => (q === "begin" ? [i] : []));
      expect(begins).toHaveLength(files.length);
      for (const i of begins) expect(sent.slice(i, i + 3)).toContain(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
      expect(LOCK_TIMEOUT).toBe("5s");
    } finally {
      await c.end();
    }
  });

  it("stops at a failing migration and records only what committed", async () => {
    const name = await emptyDatabase();
    const c = new pg.Client({ connectionString: urlOf(name) });
    await c.connect();
    try {
      // Without the compat layer the first migration can't run.
      await expect(applyMigrations(c)).rejects.toThrow(/^migration \d+_.*failed/);
      expect((await c.query("select count(*)::int as n from public.schema_migrations")).rows[0]!.n).toBe(0);
    } finally {
      await c.end();
    }
  });
});
