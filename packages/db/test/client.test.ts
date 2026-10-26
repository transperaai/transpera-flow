import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, type Claims } from "../src/client";
import type { DB } from "../src/db-types";
import { applyCompat, applyMigrations, migrationFiles } from "../src/migrations";
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
    expect(typeof r.tz).toBe("string");
    expect(r.tz).toBe("2026-10-26 10:00:00+00");
    expect(r.ts).toBe("2026-10-26 10:00:00");
    expect(r.d).toBe("2026-10-26");
    expect(r.j).toEqual({ a: [1, { b: null }] });
    expect(r.na).toEqual([1.5, 2]);
    expect(r.ba).toEqual([3, 4]);
    expect(r.da).toEqual(["2026-10-26", "2026-10-27"]);
    expect(r.tza).toEqual(["2026-10-26 10:00:00+00"]);
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
