import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness";
import { headerRollback } from "./header-rollback";
import { MONEY_NOT, MONEY_YES } from "./money-cases";

// The money-rule follow-up to B3 (#32), migration 20261228000000 (row 72): its place in the apply order, that the function it
// replaces is a full copy of B4's body changing only the `-- share_money_rule` lines, that the header's md5s are the real ones, that
// the apply file carries the migration byte for byte, and that the header's checks and ROLLBACK block do what they say.

const VERSION = "20261228000000";
const FILE = `${VERSION}_share_money_rule.sql`;
const SOURCE = "20261221000000_play_links.sql";
const root = join(__dirname, "..");
const migrations = (f: string) => readFileSync(join(root, "supabase/migrations", f), "utf8");
const migration = migrations(FILE);
const apply = readFileSync(join(root, "scripts/apply", FILE), "utf8");
const ledger = readFileSync(join(root, "../../docs/production-migrations.md"), "utf8");
const versions = readdirSync(join(root, "supabase/migrations")).map((f) => f.slice(0, 14)).sort();
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const MD5_BEFORE = "76ac6261c43393b9fb36615d727af8fc";
const MARK = "-- share_money_rule";

function statement(text: string, header: RegExp): string {
  const m = header.exec(text);
  if (!m) throw new Error(`no ${header}`);
  const first = text.indexOf("$$", m.index);
  return text.slice(m.index, text.indexOf("\n$$;", first) + "\n$$;".length);
}
const bodyOf = (stmt: string) => stmt.slice(stmt.indexOf("$$") + 2, stmt.lastIndexOf("$$"));
const headOf = (stmt: string) => stmt.slice(0, stmt.indexOf("$$") + 2);
const HEADER = /^create or replace function private\.share_snapshot_problem\(/m;
const src = statement(migrations(SOURCE), HEADER);
const mig = statement(migration, HEADER);
const header = migration.slice(0, migration.indexOf("-- ROLLBACK ("));

describe("share money rule: row 72 of the production ledger", () => {
  it("it is on disk once, after C6 (20261223000000, row 67); rows 68 to 71 (other work) may sit between", () => {
    expect(versions.filter((v) => v === VERSION)).toEqual([VERSION]);
    expect(versions.indexOf("20261223000000")).toBeGreaterThanOrEqual(0);
    expect(versions.indexOf("20261223000000")).toBeLessThan(versions.indexOf(VERSION));
  });

  it("the headers name row 72 and what it follows; preflight 0 expects nothing at or past this version", () => {
    for (const text of [migration, apply]) {
      expect(text).toContain("this is row 72");
      expect(text).toContain(`nothing >= '${VERSION}'`);
    }
    expect(migration).toContain("after 20261223000000 (C6, row 67), 20261221000000 (B4, row 66)");
    expect(apply).toContain("after row 67 (20261223000000, C6)");
  });

  it("the ledger has row 72 for this version, NOT applied, and no other row uses 72 or this version", () => {
    expect(ledger).toMatch(new RegExp(`^\\| 72 \\| ${VERSION} \\| share_money_rule \\| [^|]*NOT applied[^|]* \\| B3 follow-up`, "m"));
    expect(ledger.match(/^\| 72 \|/gm)).toHaveLength(1);
    expect(ledger.match(new RegExp(`^\\| \\d+ \\| ${VERSION} `, "gm"))).toHaveLength(1);
  });
});

describe("share money rule: the apply file", () => {
  it("carries the migration byte for byte, once as the body and once in the ledger row, inside a lock timeout", () => {
    const m = migration.trimEnd();
    expect(apply.split(m).length - 1).toBe(2);
    expect(apply).toContain("begin;\nset local lock_timeout = '5s';\n\n" + m);
    expect(apply).toContain(`insert into supabase_migrations.schema_migrations (version, name, statements) values ('${VERSION}', 'share_money_rule', array[$mig$` + m);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
    expect(m).not.toContain("$mig$");
  });
});

describe("share money rule: share_snapshot_problem is a full copy of B4's, changing only the marked lines", () => {
  it("replaces only that one function, and keeps its signature, language, volatility, security flag and search_path", () => {
    expect([...migration.matchAll(/^create (?:or replace )?function /gm)]).toHaveLength(1);
    expect(headOf(mig)).toBe(headOf(src));
    expect(migration).not.toMatch(/^(?:grant|revoke|alter|drop|insert|update|delete) /im);
  });

  it("has B4's body once its marked lines are taken out and the one line they replace is taken out of B4's", () => {
    const removed = "      || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]/-]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'\n";
    const expected = bodyOf(src);
    expect(expected.split(removed)).toHaveLength(2);
    const kept = bodyOf(mig).split("\n").filter((l) => !l.trimEnd().endsWith(MARK)).join("\n");
    expect(kept).toBe(expected.replace(removed, ""));
    expect(bodyOf(mig).split("\n").filter((l) => l.trimEnd().endsWith(MARK)).length).toBeGreaterThan(1);
  });

  it("B4's body is the one production holds (preflight 1's md5), and post-apply 1 names the new body's md5", () => {
    expect(md5(bodyOf(src))).toBe(MD5_BEFORE);
    expect(header).toContain(`private | share_snapshot_problem | ${MD5_BEFORE} | f`);
    expect(header).toContain(`md5\n--      ${md5(bodyOf(mig))}:`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// On a test database
// ---------------------------------------------------------------------------------------------------------------------

let db: TestDb;
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;
const qa = async (sql: string) => (await db.client.query({ text: sql, rowMode: "array" })).rows as unknown[][];
const liveMd5 = async () => (await q("select md5(prosrc) as m from pg_proc where proname = 'share_snapshot_problem'"))[0]!.m as string;

/** The header's queries for a numbered PREFLIGHT or POST-APPLY item, exactly as written (lines that start `--        select`). */
function queries(section: "-- PREFLIGHT" | "-- POST-APPLY CHECK:", n: number): string[] {
  const from = header.indexOf(section);
  const end = section === "-- PREFLIGHT" ? header.indexOf("-- POST-APPLY CHECK:") : header.length;
  const part = header.slice(from, end);
  const at = part.indexOf(`--   ${n}. `);
  const next = part.indexOf(`\n--   ${n + 1}. `, at);
  return [...part.slice(at, next < 0 ? part.length : next).matchAll(/^--\s{8}(select [^\n]*;)$/gm)].map((m) => m[1]!);
}

describe("share money rule: the header's checks and rollback, run on a test database", () => {
  beforeAll(async () => {
    db = await createTestDb({ supabaseDefaultPrivileges: true });
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("post-apply 1 and 2: the new body's md5, not SECURITY DEFINER, empty search_path, stable, and still private", async () => {
    const [c1] = queries("-- POST-APPLY CHECK:", 1);
    expect(await qa(c1!)).toEqual([["private", "share_snapshot_problem", md5(bodyOf(mig)), false, true, "s"]]);
    const [c2] = queries("-- POST-APPLY CHECK:", 2);
    expect(await qa(c2!)).toEqual([[false, false]]);
  });

  it("post-apply 3, the smoke test: the five texts that were hidden pass, and a hyphenated amount is refused", async () => {
    const [ok, refused] = queries("-- POST-APPLY CHECK:", 3);
    expect(await qa(ok!)).toEqual([[null]]);
    expect(await qa(refused!)).toEqual([["The snapshot contains costs or margins."]]);
  });

  it("the function itself: the shared lists, with Financials off and on", async () => {
    const ws = (await q("select id from workspaces where slug = 'northbeam'"))[0]!.id as string;
    const check = async (note: string, financials: boolean) =>
      (await q("select private.share_snapshot_problem($1, 'overview', $2::jsonb, false, $3) as p", [ws, JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials }, note }), financials]))[0]!.p;
    for (const { text } of MONEY_NOT) expect(await check(text, false), text).toBeNull();
    for (const text of MONEY_YES) expect(await check(text, false), text).toBe("The snapshot contains costs or margins.");
    for (const text of MONEY_YES) expect(await check(text, true), text).toBeNull();
  });

  it("the ROLLBACK block puts B4's body back (preflight 1's md5 returns), the preflight reads as written, and the migration applies again", async () => {
    await q("create schema if not exists supabase_migrations");
    await q("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
    for (const v of ["20261221000000", "20261223000000", VERSION]) await q("insert into supabase_migrations.schema_migrations (version) values ($1) on conflict do nothing", [v]);
    const after = await liveMd5();
    expect(after).toBe(md5(bodyOf(mig)));

    const rollback = headerRollback(FILE);
    expect(rollback).toMatch(/^begin;/);
    expect(rollback).toMatch(/commit;$/);
    expect(rollback).toContain(`delete from supabase_migrations.schema_migrations where version = '${VERSION}';`);
    await db.client.query(rollback);
    expect(await liveMd5()).toBe(MD5_BEFORE);

    // The preflight now reads as the header says.
    const [p0] = queries("-- PREFLIGHT", 0);
    const rows = (await qa(p0!)).map((r) => r[0]);
    expect(rows).toEqual(expect.arrayContaining(["20261221000000", "20261223000000"]));
    expect(rows.filter((v) => (v as string) >= VERSION)).toEqual([]);
    const [p1] = queries("-- PREFLIGHT", 1);
    expect(await qa(p1!)).toEqual([["private", "share_snapshot_problem", MD5_BEFORE, false]]);
    const [p2] = queries("-- PREFLIGHT", 2);
    expect((await qa(p2!))[0]!.every((v) => v !== null)).toBe(true);
    // With B4's rule back, the old over-hiding returns: "page 3/GBP" is refused again.
    const ws = (await q("select id from workspaces where slug = 'northbeam'"))[0]!.id as string;
    const snap = JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials: false }, note: "page 3/GBP" });
    expect((await q("select private.share_snapshot_problem($1, 'overview', $2::jsonb, false, false) as p", [ws, snap]))[0]!.p).toBe("The snapshot contains costs or margins.");

    // And the migration applies again, to the same md5.
    await db.client.query(migration);
    expect(await liveMd5()).toBe(after);
  });
});
