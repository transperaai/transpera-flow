import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "../src/client";
import { createTestDb, type TestDb } from "./harness";

// scripts/create-app-login.sql makes `authenticator`, the login the app's query pool uses (APP_DATABASE_URL): it can become
// anon or authenticated and can't read a table as itself.

let db: TestDb;
const password = randomBytes(12).toString("hex");
const script = fileURLToPath(new URL("../scripts/create-app-login.sql", import.meta.url));
const run = (pw: string) =>
  execFileSync("psql", [db.url, "-v", "ON_ERROR_STOP=1", "-v", `app_password=${pw}`, "-f", script], { stdio: "pipe" });
let preexisting = false;

const asAuthenticator = () => {
  const url = new URL(db.url);
  url.username = "authenticator";
  url.password = password;
  return url.toString();
};

beforeAll(async () => {
  db = await createTestDb();
  preexisting = (await db.client.query("select 1 from pg_roles where rolname = 'authenticator'")).rowCount === 1;
  run(password);
});
afterAll(async () => {
  await db.close();
  // A role belongs to the cluster, which other test databases share; drop it only if this test made it.
  if (!preexisting) {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });
    await admin.connect();
    await admin.query("drop role if exists authenticator");
    await admin.end();
  }
});

describe("create-app-login.sql", () => {
  it("makes a login that doesn't inherit, with SET on anon and authenticated only", async () => {
    const { rows } = await db.client.query(`
      select r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             (select array_agg(g.rolname::text order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid
               where m.member = r.oid and m.set_option and not m.inherit_option) as sets
      from pg_roles r where r.rolname = 'authenticator'`);
    expect(rows[0]).toEqual({
      rolcanlogin: true,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      sets: ["anon", "authenticated"],
    });
    const memberships = await db.client.query(
      "select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'authenticator'",
    );
    expect(memberships.rows[0]!.n).toBe(2);
  });

  it("can be run again, and sets the new password", async () => {
    const next = randomBytes(12).toString("hex");
    run(next);
    const old = new pg.Client({ connectionString: asAuthenticator() });
    await expect(old.connect()).rejects.toThrow(/password authentication failed/);
    const fresh = new URL(db.url);
    fresh.username = "authenticator";
    fresh.password = next;
    const c = new pg.Client({ connectionString: fresh.toString() });
    await c.connect();
    await c.end();
    run(password);
  });

  it("refuses to run without a password, and fails", () => {
    let failed: { status?: number; stdout?: Buffer } | undefined;
    try {
      execFileSync("psql", [db.url, "-v", "ON_ERROR_STOP=1", "-f", script], { stdio: "pipe" });
    } catch (e) {
      failed = e as typeof failed;
    }
    expect(failed).toBeDefined();
    expect(failed?.status).not.toBe(0);
    expect(failed?.stdout?.toString()).toContain("app_password is not set");
  });

  it("run again, takes away any other membership and any inherited or admin grant", async () => {
    await db.client.query("grant service_role to authenticator; grant anon to authenticator with inherit true, admin true");
    run(password);
    const { rows } = await db.client.query(`
      select g.rolname::text as role, m.inherit_option, m.admin_option, m.set_option
      from pg_auth_members m join pg_roles g on g.oid = m.roleid
      where m.member = 'authenticator'::regrole order by 1`);
    expect(rows).toEqual([
      { role: "anon", inherit_option: false, admin_option: false, set_option: true },
      { role: "authenticated", inherit_option: false, admin_option: false, set_option: true },
    ]);
  });
});

describe("connected as authenticator", () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: asAuthenticator() });
    await c.connect();
  });
  afterAll(() => c.end());

  it("cannot read a table directly", async () => {
    await expect(c.query("select * from public.workspaces")).rejects.toMatchObject({ code: "42501" });
  });

  it("can become authenticated or anon with set_config, and only those", async () => {
    await c.query("begin");
    const { rows } = await c.query("select set_config('role', 'authenticated', true) as r, current_user as u");
    expect(rows[0]).toEqual({ r: "authenticated", u: "authenticated" });
    await expect(c.query("select * from public.workspaces limit 1")).resolves.toBeDefined();
    await c.query("rollback");

    await c.query("begin");
    await c.query("select set_config('role', 'anon', true)");
    expect((await c.query("select current_user as u")).rows[0]!.u).toBe("anon");
    await c.query("rollback");

    await c.query("begin");
    await expect(c.query("select set_config('role', 'postgres', true)")).rejects.toMatchObject({ code: "42501" });
    await c.query("rollback");
  });

  it("runs the app's queries through createDb (claims, RLS: a stranger sees no workspace, and the role's statement timeout)", async () => {
    const pool = createPool(asAuthenticator(), { max: 2 });
    try {
      const d = createDb(pool, { sub: "a0000000-0000-4000-8000-0000000000aa", role: "authenticated" });
      const { rows } = await sql<{ u: string; t: string }>`select current_user as u, current_setting('statement_timeout') as t`.execute(d);
      expect(rows[0]).toEqual({ u: "authenticated", t: "8s" });
      expect((await sql<{ n: number }>`select count(*)::int as n from public.workspaces`.execute(d)).rows[0]!.n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
