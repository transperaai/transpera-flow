import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness";
import { headerRollback } from "./header-rollback";
import { MONEY_NOT, MONEY_NOT_VARIANTS, MONEY_OTHER, MONEY_YES } from "./money-cases";

// The money-rule follow-up to B3 (#32), migration 20261224500000 (row 69): its place in the apply order, that the function it
// replaces is a full copy of B4's body changing only the `-- share_money_rule` lines, that the header's md5s are the real ones, that
// the apply file carries the migration byte for byte, and that the header's checks and ROLLBACK block do what they say.

const VERSION = "20261224500000";
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
const MARK = "-- B3 follow-up";

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

describe("share money rule: row 69 of the production ledger", () => {
  it("it is on disk once, after C6 (20261223000000, row 67); row 68 (20261224000000, applied) sits between when it is on disk", () => {
    expect(versions.filter((v) => v === VERSION)).toEqual([VERSION]);
    expect(versions.indexOf("20261223000000")).toBeGreaterThanOrEqual(0);
    expect(versions.indexOf("20261223000000")).toBeLessThan(versions.indexOf(VERSION));
  });

  it("the headers name row 69 and what it follows; preflight 0 expects row 68 as the latest and nothing at or past this version", () => {
    for (const text of [migration, apply]) {
      expect(text).toContain("row 69");
      expect(text).not.toMatch(/row 72|20261228000000/);
      expect(text).toContain(`nothing >= '${VERSION}'`);
    }
    expect(migration).toContain("this is\n-- row 69");
    expect(migration).toContain("after 20261224000000 (row 68, applied), 20261223000000 (C6, row 67), 20261221000000 (B4, row 66)");
    expect(migration).toContain("20261224000000 (the latest), and nothing >= '20261224500000'");
    expect(apply).toContain("This is row 69 of docs/production-migrations.md; apply it after row 68 (20261224000000, applied) and row 67 (20261223000000, C6)");
    expect(apply).toContain(`values ('${VERSION}', 'share_money_rule'`);
  });

  it("the ledger has row 69 for this version, NOT applied, and no other row uses 69 or this version", () => {
    expect(ledger).toMatch(new RegExp(`^\\| 69 \\| ${VERSION} \\| share_money_rule \\| [^|]*NOT applied[^|]* \\| B3 follow-up`, "m"));
    expect(ledger.match(/^\| 69 \|/gm)).toHaveLength(1);
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

  it("has B4's body once its marked lines are taken out and the five lines they replace are taken out of B4's", () => {
    const removed = [
      "    'base_revision_id', 'by', 'child_process_id', 'client_id', 'color', 'comparator', 'condition_id', 'created_at',\n",
      "    'person_id', 'plan', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',\n",
      "  select string_agg(n.v, E'\\x01'), string_agg(n.v, E'\\x01') filter (where n.k is null or n.k <> all (non_text_keys))\n",
      "    from (select s.k, private.share_norm(s.v) as v from private.share_strings(snap) as s\n",
      "      || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]/-]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'\n",
    ];
    let expected = bodyOf(src);
    for (const line of removed) {
      expect(expected.split(line), line).toHaveLength(2);
      expected = expected.replace(line, "");
    }
    const kept = bodyOf(mig).split("\n").filter((l) => !l.includes(MARK)).join("\n");
    expect(kept).toBe(expected);
    expect(bodyOf(mig).split("\n").filter((l) => l.includes(MARK)).length).toBeGreaterThan(3);
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

  it("post-apply 3, the smoke test: the five texts that were hidden pass, and a negative amount and a hyphenated range are refused", async () => {
    const [ok, refused] = queries("-- POST-APPLY CHECK:", 3);
    expect(await qa(ok!)).toEqual([[null]]);
    expect(await qa(refused!)).toEqual([["The snapshot contains costs or margins."]]);
  });

  it("preflight 3 reads 0, 0 on the seed (role colours are hex, plans a word)", async () => {
    const [p3] = queries("-- PREFLIGHT", 3);
    expect((await qa(p3!))[0]!.map(Number)).toEqual([0, 0]);
  });

  const check = async (fn: string, note: string, financials: boolean) => {
    const ws = (await q("select id from workspaces where slug = 'northbeam'"))[0]!.id as string;
    return (await q(`select ${fn}($1, 'overview', $2::jsonb, false, $3) as p`, [ws, JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials }, note }), financials]))[0]!.p as string | null;
  };

  it("the function itself: the shared lists, with Financials off and on", async () => {
    const fn = "private.share_snapshot_problem";
    for (const { text } of MONEY_NOT) expect(await check(fn, text, false), text).toBeNull();
    for (const { text } of MONEY_NOT_VARIANTS) expect(await check(fn, text, false), text).toBeNull();
    for (const text of MONEY_YES) expect(await check(fn, text, false), text).toBe("The snapshot contains costs or margins.");
    for (const text of MONEY_YES) expect(await check(fn, text, true), text).toBeNull();
  });

  it("every case through main's old rule (B4's body) and the new one: what the old refused, the new refuses, except the listed exemptions; the new refuses nothing the old didn't", async () => {
    // B4's function, as main has it, under another name beside the new one.
    await q(src.replace("create or replace function private.share_snapshot_problem(", "create or replace function private.share_snapshot_problem_main("));
    try {
      const exempt = new Set([...MONEY_NOT.map((c) => c.text), ...MONEY_NOT_VARIANTS.map((c) => c.text)]);
      const lost: string[] = [];
      const gained: string[] = [];
      for (const text of [...exempt, ...MONEY_YES, ...MONEY_OTHER]) {
        const before = (await check("private.share_snapshot_problem_main", text, false)) !== null;
        const after = (await check("private.share_snapshot_problem", text, false)) !== null;
        if (before && !after && !exempt.has(text)) lost.push(text);
        if (after && !before) gained.push(text);
        if (exempt.has(text) || MONEY_YES.includes(text)) expect(before, `main refused ${text}`).toBe(true);
      }
      expect(lost).toEqual([]);
      expect(gained).toEqual([]);
    } finally {
      await q("drop function private.share_snapshot_problem_main(uuid, text, jsonb, boolean, boolean)");
    }
  });

  it("color and plan are free text now: a person's name in a role's colour or the plan is refused with People off", async () => {
    const ws = (await q("select id from workspaces where slug = 'northbeam'"))[0]!.id as string;
    const name = (await q("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws]))[0]!.name as string;
    for (const extra of [{ roles: [{ color: name }] }, { workspace: { plan: name } }]) {
      const snap = JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials: true }, ...extra });
      expect((await q("select private.share_snapshot_problem($1, 'overview', $2::jsonb, false, true) as p", [ws, snap]))[0]!.p).toBe("The snapshot names a person.");
    }
    const hex = JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials: false }, roles: [{ color: "#2a78d6" }], workspace: { plan: "agency" } });
    expect((await q("select private.share_snapshot_problem($1, 'overview', $2::jsonb, false, false) as p", [ws, hex]))[0]!.p).toBeNull();
  });

  it("a whole hex colour under color is no text, even when its letters spell a person's or a client's name; anything else under color is free text", async () => {
    const ws = (await q("select id from workspaces where slug = 'northbeam'"))[0]!.id as string;
    const problem = async (extra: object) =>
      (await db.client.query("select private.share_snapshot_problem($1, 'overview', $2::jsonb, false, true) as p", [ws, JSON.stringify({ v: 1, kind: "overview", toggles: { people: false, financials: true }, ...extra })])).rows[0]!.p as string | null;
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'Ada Lovelace')", [ws]);
      await db.client.query("insert into clients (workspace_id, name) values ($1, 'Fab')", [ws]);
      for (const color of ["#ada123", "#ADA", "#fab000", "#FAB000AA", "#2a78d6"]) expect(await problem({ roles: [{ color }] }), color).toBeNull();
      // Not a whole hex colour, or not under `color`: free text, checked.
      expect(await problem({ roles: [{ color: "ada" }] })).toBe("The snapshot names a person.");
      expect(await problem({ roles: [{ color: "#ada123 Ada" }] })).toBe("The snapshot names a person.");
      expect(await problem({ roles: [{ color: "#ada1234567" }] })).toBe("The snapshot names a person.");
      expect(await problem({ roles: [{ color: "#fab" }], note: "#fab000" })).toBe("The snapshot names a client.");
      expect(await problem({ roles: [{ colour: "#ada123" }] })).toBe("The snapshot names a person.");
    } finally {
      await db.client.query("rollback");
    }
  });

  it("the ROLLBACK block puts B4's body back (preflight 1's md5 returns), the preflight reads as written, and the migration applies again", async () => {
    await q("create schema if not exists supabase_migrations");
    await q("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
    for (const v of ["20261221000000", "20261223000000", "20261224000000", VERSION]) await q("insert into supabase_migrations.schema_migrations (version) values ($1) on conflict do nothing", [v]);
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
    expect(rows).toEqual(expect.arrayContaining(["20261221000000", "20261223000000", "20261224000000"]));
    expect(rows.at(-1)).toBe("20261224000000");
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
