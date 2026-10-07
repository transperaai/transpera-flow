import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headerRollback } from "./header-rollback";
import { createTestDb, type TestDb } from "./harness";

// Migration 20261224000000_revoke_unused_table_privileges.sql: anon and authenticated lose TRUNCATE, TRIGGER and REFERENCES (and
// MAINTAIN on Postgres 17) on every public table, and new tables made by postgres stop getting them. Plain Postgres has no Supabase
// defaults, so this file first puts back what production has (the harness's Supabase default privileges, plus the three extra
// privileges granted on every public table), then runs the migration's own SQL and its header's checks and rollback.

const FILE = "20261224000000_revoke_unused_table_privileges.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), "utf8");
const applyFile = readFileSync(new URL(`../scripts/apply/${FILE}`, import.meta.url), "utf8");
const EXTRA = ["TRUNCATE", "TRIGGER", "REFERENCES", "MAINTAIN"];
const RELKINDS = "('r', 'p', 'v', 'm', 'f')";
/** A table with no grants to either role (row 64 grants by column only); Supabase's defaults never reached it either. */
const UNTOUCHED = "share_links";

/** The SQL statements of item `n` of a header section (`PREFLIGHT` or `POST-APPLY CHECK`), as an operator would copy them. */
function headerItem(section: string, n: number): string[] {
  const lines = migration.slice(migration.indexOf(`-- ${section}`)).split("\n").slice(1);
  const start = lines.findIndex((l) => l.startsWith(`--   ${n}. `));
  if (start < 0) throw new Error(`${section} ${n} not found`);
  const sql: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^--   \d+\. /.test(line) || line === "--" || !line.startsWith("--")) break;
    if (line.startsWith("--        ")) sql.push(line.slice(10));
  }
  return sql
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let db: TestDb;
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

/** Every privilege on every public relation and column, for every grantee: [relation, column, grantee, privilege, grantable]. */
const acl = async () =>
  (
    await q(`select c.relname, null::name as col, g.grantee::regrole::text as grantee, g.privilege_type, g.is_grantable
      from pg_class c cross join lateral aclexplode(c.relacl) g where c.relnamespace = 'public'::regnamespace
      union all
      select c.relname, a.attname, g.grantee::regrole::text, g.privilege_type, g.is_grantable
      from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join lateral aclexplode(a.attacl) g where c.relnamespace = 'public'::regnamespace
      order by 1, 2 nulls first, 3, 4`)
  ).map((r) => `${r.relname}.${r.col ?? "*"} ${r.grantee} ${r.privilege_type}${r.is_grantable ? " +grant" : ""}`);
const defaults = async () =>
  (await q("select defaclrole::regrole::text as role, defaclobjtype as kind, defaclacl::text as acl from pg_default_acl where defaclnamespace = 'public'::regnamespace order by 1, 2"));
const isExtraForClients = (line: string) => new RegExp(`^\\S+ (anon|authenticated) (${EXTRA.join("|")})( |$)`).test(line);

let before: { acl: string[]; defaults: unknown[]; dml: unknown[]; grantBack: string; extra: unknown[] };

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  // The harness ran every migration, this one included. Put production's state back: Supabase's default privileges for tables
  // made by postgres, and the extra privileges on every public relation (bar one), plus a column-level REFERENCES.
  await db.client.query("alter default privileges in schema public grant all on tables to anon, authenticated");
  await db.client.query(`do $$ declare r record; begin
    for r in select oid::regclass as t from pg_class where relnamespace = 'public'::regnamespace and relkind in ${RELKINDS}
      and relname <> '${UNTOUCHED}'
    loop execute format('grant truncate, trigger, references on table %s to anon, authenticated', r.t); end loop; end $$`);
  await db.client.query("grant references (kind) on public.share_links to authenticated");
  await db.client.query("create schema if not exists supabase_migrations");
  await db.client.query("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
  await db.client.query(
    "insert into supabase_migrations.schema_migrations (version, name) values ('20261224000000', 'revoke_unused_table_privileges') on conflict do nothing",
  );

  const [grantBack] = headerItem("PREFLIGHT", 2);
  const [dml] = headerItem("PREFLIGHT", 4);
  before = {
    acl: await acl(),
    defaults: await defaults(),
    dml: await q(dml!),
    grantBack: (await q(grantBack!))[0].string_agg as string,
    extra: await q(headerItem("PREFLIGHT", 1)[0]!),
  };
  await db.client.query(migration);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("before the migration (the simulated Supabase state)", () => {
  it("anon and authenticated held the extra privileges on the public tables", () => {
    expect(before.extra.length).toBeGreaterThan(100);
    expect(before.acl).toContain("workspaces.* anon TRUNCATE");
    expect(before.acl).toContain("workspaces.* authenticated REFERENCES");
    expect(before.acl).toContain("share_links.kind authenticated REFERENCES");
    expect(before.acl.filter((l) => l.startsWith(`${UNTOUCHED}.* `) && isExtraForClients(l))).toEqual([]);
  });

  it("preflight 2 writes one GRANT per table and role, and the column-level REFERENCES", () => {
    expect(before.grantBack).toContain("grant REFERENCES, TRIGGER, TRUNCATE on table workspaces to anon;");
    expect(before.grantBack).toContain("grant references (kind) on table share_links to authenticated;");
    expect(before.grantBack).not.toMatch(/grant [A-Z, ]+ on table share_links to/);
  });
});

describe("after the migration", () => {
  it("leaves no TRUNCATE, TRIGGER, REFERENCES or MAINTAIN for anon or authenticated (post-apply 1)", async () => {
    const [table, column, byName] = headerItem("POST-APPLY CHECK", 1);
    expect((await q(table!))[0].count).toBe("0");
    expect((await q(column!))[0].count).toBe("0");
    expect(await q(byName!)).toEqual([]);
    expect((await acl()).filter(isExtraForClients)).toEqual([]);
  });

  it("keeps every other privilege exactly as it was: DML, column grants, service_role, postgres, sequences", async () => {
    expect(await acl()).toEqual(before.acl.filter((l) => !isExtraForClients(l)));
  });

  it("keeps the DML counts per table (preflight 4 run again, post-apply 2)", async () => {
    const after = await q(headerItem("PREFLIGHT", 4)[0]!);
    expect(after).toEqual(before.dml);
    expect(after.length).toBeGreaterThan(50);
    expect(after.find((r) => r.relname === "suggestion_proposals")).toMatchObject({ anon_table: "0", auth_table: "1" });
  });

  it("can still read and write through the remaining grants", async () => {
    expect(await q("select has_table_privilege('authenticated', 'public.workspaces', 'select, insert, update, delete') as ok")).toEqual([{ ok: true }]);
    expect(await q("select has_table_privilege('authenticated', 'public.workspaces', 'truncate') as t, has_table_privilege('anon', 'public.steps', 'references') as r")).toEqual([
      { t: false, r: false },
    ]);
  });

  it("new tables made by postgres get SELECT, INSERT, UPDATE and DELETE only (post-apply 4); service_role keeps everything", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("create table public.zz_grants_probe (id int)");
      const rows = await q(
        "select g.grantee::regrole::text as grantee, string_agg(g.privilege_type, ', ' order by g.privilege_type) as p from pg_class c cross join lateral aclexplode(c.relacl) g where c.oid = 'public.zz_grants_probe'::regclass group by 1 order by 1",
      );
      const pg17 = Number((await q("show server_version_num"))[0].server_version_num) >= 170000;
      const full = ["DELETE", "INSERT", ...(pg17 ? ["MAINTAIN"] : []), "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"].join(", ");
      expect(rows).toEqual([
        { grantee: "anon", p: "DELETE, INSERT, SELECT, UPDATE" },
        { grantee: "authenticated", p: "DELETE, INSERT, SELECT, UPDATE" },
        { grantee: "postgres", p: full },
        { grantee: "service_role", p: full },
      ]);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("can run again (nothing to do)", async () => {
    const acls = await acl();
    await db.client.query(migration);
    expect(await acl()).toEqual(acls);
  });
});

describe("the header's rollback", () => {
  it("with preflight 2's saved text puts back exactly what was there, default privileges included", async () => {
    const rollback = headerRollback(FILE);
    expect(rollback).toContain("grant all on tables to anon, authenticated");
    await db.client.query(rollback.replace("begin;", `begin;\n${before.grantBack}`));
    expect(await acl()).toEqual(before.acl);
    expect(await defaults()).toEqual(before.defaults);
    expect(await q("select version from supabase_migrations.schema_migrations where version = '20261224000000'")).toEqual([]);
    // And the production apply file applies again on top, recording the version.
    await db.client.query(applyFile);
    expect((await acl()).filter(isExtraForClients)).toEqual([]);
    expect(await q("select name from supabase_migrations.schema_migrations where version = '20261224000000'")).toEqual([{ name: "revoke_unused_table_privileges" }]);
  });

  it("the apply file holds the migration verbatim, in one transaction with a lock timeout", () => {
    expect(applyFile.split(migration)).toHaveLength(3);
    expect(applyFile).toContain("set local lock_timeout = '5s';");
    expect(applyFile).toContain(`values ('20261224000000', 'revoke_unused_table_privileges', array[$mig$${migration}$mig$]);`);
    expect(applyFile.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe("as on Supabase: applied by a member of postgres that is not a superuser, with a supabase_admin", () => {
  it("skips supabase_admin's default privileges with a notice, and warns about (and skips) a table it can't revoke on", async () => {
    const notices: string[] = [];
    const listen = (n: { message?: string }) => notices.push(n.message ?? "");
    db.client.on("notice", listen);
    await db.client.query("begin");
    try {
      await db.client.query("create role supabase_admin nologin");
      await db.client.query("create role zz_grants_applier nologin");
      await db.client.query("grant postgres to zz_grants_applier");
      await db.client.query("alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated");
      await db.client.query("create table public.zz_admin_table (id int)");
      await db.client.query("alter table public.zz_admin_table owner to supabase_admin");
      await db.client.query("grant all on public.zz_admin_table to anon, authenticated");
      await db.client.query("grant truncate, trigger, references on public.workspaces to anon, authenticated");
      await db.client.query("alter default privileges for role postgres in schema public grant all on tables to anon, authenticated");
      const adminDefaults = (await q("select defaclacl::text as acl from pg_default_acl where defaclrole = 'supabase_admin'::regrole"))[0].acl;

      await db.client.query("set local role zz_grants_applier");
      await db.client.query(migration);
      await db.client.query("reset role");

      expect(notices.some((m) => /zz_grants_applier is not a member of supabase_admin/.test(m))).toBe(true);
      expect(notices.some((m) => /zz_admin_table is not owned by a role zz_grants_applier can act for; skipped/.test(m))).toBe(true);
      expect((await q("select defaclacl::text as acl from pg_default_acl where defaclrole = 'supabase_admin'::regrole"))[0].acl).toBe(adminDefaults);
      // Everything postgres owns is done; the one table it can't touch is what post-apply 1 reports.
      const left = (await acl()).filter(isExtraForClients);
      expect(left.length).toBeGreaterThan(0);
      expect(left.every((l) => l.startsWith("zz_admin_table.* "))).toBe(true);
      const [table] = headerItem("POST-APPLY CHECK", 1);
      expect(Number((await q(table!))[0].count)).toBe(left.length);
      expect(await q("select defaclacl::text as acl from pg_default_acl where defaclrole = 'postgres'::regrole and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r'")).toEqual([
        { acl: expect.not.stringMatching(/(anon|authenticated)=[a-zA-Z]*[Dxtm]/) },
      ]);
    } finally {
      await db.client.query("rollback");
      db.client.off("notice", listen);
    }
  });

  it("changes supabase_admin's default privileges too when the applier may (a superuser here)", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("create role supabase_admin nologin");
      await db.client.query("alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated, service_role");
      await db.client.query(migration);
      const acl = (await q("select defaclacl::text as acl from pg_default_acl where defaclrole = 'supabase_admin'::regrole"))[0].acl as string;
      expect(acl).toMatch(/anon=arwd\//);
      expect(acl).toMatch(/authenticated=arwd\//);
      expect(acl).toMatch(/service_role=arwdDxtm?\//);
    } finally {
      await db.client.query("rollback");
    }
  });
});
