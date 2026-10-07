import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness";
import { headerRollback } from "./header-rollback";

// Play links, migration 20261221000000 (B4, row 66): where it sits in the apply order, that the six functions it replaces are full
// copies of their sources changing only the `-- B4` lines, that the header's md5s are the real ones, that the apply file carries the
// migration byte for byte, and that the header's ROLLBACK block puts everything back (run on a test database).

const VERSION = "20261221000000";
const FILE = `${VERSION}_play_links.sql`;
const root = join(__dirname, "..");
const migrations = (f: string) => readFileSync(join(root, "supabase/migrations", f), "utf8");
const migration = migrations(FILE);
const apply = readFileSync(join(root, "scripts/apply", FILE), "utf8");
const ledger = readFileSync(join(root, "../../docs/production-migrations.md"), "utf8");
const versions = readdirSync(join(root, "supabase/migrations")).map((f) => f.slice(0, 14)).sort();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

describe("play links: row 66 of the production ledger", () => {
  it("it follows B3's 20261220000000 with nothing between (the workspace-delete fix, 20261220500000, is row 65); later tickets' migrations (C6, row 67) may follow it", () => {
    expect(versions.filter((v) => v >= "20261220000000" && v <= VERSION && v !== "20261220500000")).toEqual(["20261220000000", VERSION]);
  });

  it("preflight 0 expects B3 as the latest applied and nothing at or past this version; the headers name row 66", () => {
    for (const text of [migration, apply]) {
      expect(text).toContain(`Expect 20261219000000, 20261220000000, 20261220500000 and nothing >= '${VERSION}'`);
      expect(text).toContain("where version >= '20261219000000'");
    }
    expect(migration).toContain("after 20261220500000 (the workspace-delete fix, row 65)");
    expect(migration).toContain("this is row 66");
    expect(apply).toContain("this is row 66");
    expect(apply).toContain("row 65 (20261220500000, the workspace-delete fix)");
  });

  it("the ledger has row 66 for this version (its status column changes once applied), and no other row uses 66 or this version", () => {
    expect(ledger).toMatch(new RegExp(`\\| 66 \\| ${VERSION} \\| play_links \\| `));
    expect(ledger.match(/^\| 66 \|/gm)).toHaveLength(1);
    expect(ledger.split(VERSION).length - 1).toBeGreaterThanOrEqual(1);
    expect(ledger).toMatch(new RegExp(`\\| 66 \\| ${VERSION} \\| play_links \\| [^|]+ \\| B4`));
  });
});

describe("play links: the apply file", () => {
  it("carries the migration byte for byte, once as the body and once in the ledger row, inside a lock timeout", () => {
    const mig = migration.trimEnd();
    expect(apply.split(mig).length - 1).toBe(2);
    expect(apply).toContain("begin;\nset local lock_timeout = '5s';\n\n" + mig);
    expect(apply).toContain(`insert into supabase_migrations.schema_migrations (version, name, statements) values ('${VERSION}', 'play_links', array[$mig$` + mig);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
    expect(mig).not.toContain("$mig$");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The six replaced functions
// ---------------------------------------------------------------------------------------------------------------------

/** The statement of a function: from its `create` line to the closing `$$;`, as written in a file. */
function statement(text: string, header: RegExp): string {
  const m = header.exec(text);
  if (!m) throw new Error(`no ${header}`);
  const first = text.indexOf("$$", m.index);
  return text.slice(m.index, text.indexOf("\n$$;", first) + "\n$$;".length);
}
const bodyOf = (stmt: string) => stmt.slice(stmt.indexOf("$$") + 2, stmt.lastIndexOf("$$"));
const headOf = (stmt: string) => stmt.slice(0, stmt.indexOf("$$") + 2).replace(/^create function/, "create or replace function");

/** The migration's text with every B4 line gone: lines with `-- B4` at their end, and blocks from `-- B4 begin` to `-- B4 end`. */
function withoutB4(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/-- B4 begin\s*$/.test(line)) inBlock = true;
    else if (/-- B4 end\s*$/.test(line)) inBlock = false;
    else if (!inBlock && !/-- B4/.test(line)) out.push(line);
  }
  return out.join("\n");
}

interface Replaced {
  name: string;
  source: string;
  header: RegExp;
  migrationHeader: RegExp;
  /** The lines of the source that the migration replaces (each marked `-- B4` in the copy), in order. */
  removed: string[];
  md5Before: string;
}
const SHARE = "20261220000000_share_links.sql";
const IMPORT = "20261129000000_import_bundle.sql";
const REPLACED: Replaced[] = [
  {
    name: "share_links_before_write",
    source: SHARE,
    header: /^create function private\.share_links_before_write\(\)/m,
    migrationHeader: /^create or replace function private\.share_links_before_write\(\)/m,
    removed: ["    if new.mode <> 'view' then\n      raise exception 'Play links come later.' using errcode = '22023';\n    end if;"],
    md5Before: "d62acd6761b553263ab52f6f2c5df312",
  },
  {
    name: "share_snapshot_problem",
    source: SHARE,
    header: /^create function private\.share_snapshot_problem\(/m,
    migrationHeader: /^create or replace function private\.share_snapshot_problem\(/m,
    removed: ["     or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials) then"],
    md5Before: "0bf3c675bdb2a030543a3151f1075178",
  },
  {
    name: "open_share_link",
    source: SHARE,
    header: /^create function public\.open_share_link\(/m,
    migrationHeader: /^create or replace function public\.open_share_link\(/m,
    removed: ["      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode = 'view';"],
    md5Before: "1f58a06299923867c9ca4e19b9f8fce6",
  },
  {
    name: "suggestion_proposals_before_write",
    source: IMPORT,
    header: /^create or replace function private\.suggestion_proposals_before_write\(\)/m,
    migrationHeader: /^create or replace function private\.suggestion_proposals_before_write\(\)/m,
    removed: [],
    md5Before: "c7e2a34a4f48034bbc132497eaa877db",
  },
  {
    name: "suggestions_before_write",
    source: IMPORT,
    header: /^create or replace function private\.suggestions_before_write\(\)/m,
    migrationHeader: /^create or replace function private\.suggestions_before_write\(\)/m,
    removed: [],
    md5Before: "85b012ee7c6f30f05236fe3ea5f19ada",
  },
  {
    name: "build_proposal",
    source: "20261125500000_build_proposal.sql",
    header: /^create function public\.build_proposal\(/m,
    migrationHeader: /^create or replace function public\.build_proposal\(/m,
    removed: ["  select x.kind, x.status, x.issue_id into v_kind, v_status, v_issue"],
    md5Before: "b911a2835fd900d87c511ea69a2fa1dc",
  },
];

describe("play links: the six replaced functions are full copies, changing only the -- B4 lines", () => {
  for (const r of REPLACED) {
    describe(r.name, () => {
      const src = statement(migrations(r.source), r.header);
      const mig = statement(migration, r.migrationHeader);

      it("keeps the signature, language, volatility, security flag and search_path (the head is the source's, 'or replace' aside)", () => {
        expect(headOf(mig)).toBe(headOf(src));
      });

      it("has the source's body once its B4 lines are taken out (and the lines they replace are taken out of the source)", () => {
        let expected = bodyOf(src);
        for (const line of r.removed) {
          expect(expected.split(line + "\n"), line).toHaveLength(2);
          expected = expected.replace(line + "\n", "");
        }
        expect(withoutB4(bodyOf(mig))).toBe(expected);
      });

      it("has at least one B4 line, and every block is closed", () => {
        expect(mig).toMatch(/-- B4/);
        expect((mig.match(/-- B4 begin/g) ?? []).length).toBe((mig.match(/-- B4 end/g) ?? []).length);
      });

      it("the source's body is the one production holds (md5 of the text between the $$ marks, as preflight 2 lists)", () => {
        expect(md5(bodyOf(src))).toBe(r.md5Before);
        expect(migration).toContain(`${r.md5Before}`);
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The header's numbers, and the rollback
// ---------------------------------------------------------------------------------------------------------------------

let db: TestDb;
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;
const qa = async (sql: string) => (await db.client.query({ text: sql, rowMode: "array" })).rows[0] as unknown[];
/** B4's body of a replaced function, as this migration writes it (md5 of the text between the $$ marks, as pg_proc.prosrc holds it). */
const b4Md5 = (r: Replaced) => md5(bodyOf(statement(migration, r.migrationHeader)));
/**
 * Functions a LATER migration replaces again, with that migration's md5 (what a test database built from every migration holds).
 * 20261228000000_share_money_rule (B3 follow-up, row 72) copies B4's share_snapshot_problem and tightens one line of its money rule.
 */
const REPLACED_LATER: Record<string, string> = {
  share_snapshot_problem: md5(bodyOf(statement(migrations("20261228000000_share_money_rule.sql"), /^create or replace function private\.share_snapshot_problem\(/m))),
};
const md5s = async () =>
  Object.fromEntries(
    (await q("select p.proname, md5(p.prosrc) as m from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname = any ($1)", [REPLACED.map((r) => r.name)])).map((r) => [r.proname, r.m]),
  ) as Record<string, string>;

/** The one-line queries of the header's PREFLIGHT, by number. */
function preflight(n: number): string {
  const head = migration.slice(0, migration.indexOf("-- ROLLBACK ("));
  const at = head.indexOf(`--   ${n}. `);
  const next = head.indexOf(`\n--   ${n + 1}. `, at);
  const body = head.slice(at, next < 0 ? head.indexOf("-- POST-APPLY CHECK:") : next);
  const m = /\n--        (select [^\n]*;)/.exec(body);
  if (!m) throw new Error(`no query in preflight ${n}`);
  return m[1]!;
}

describe("play links: the header's md5s, its rollback and its preflight, run on a test database", () => {
  beforeAll(async () => {
    db = await createTestDb({ supabaseDefaultPrivileges: true });
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("post-apply 5 lists the real md5s of the six replaced functions, which differ from preflight 2's", async () => {
    const real = await md5s();
    const header = migration.slice(0, migration.indexOf("-- ROLLBACK ("));
    const post = header.slice(header.indexOf("5. The six replaced functions' md5s"));
    for (const r of REPLACED) {
      expect(real[r.name], r.name).not.toBe(r.md5Before);
      // A function a later migration replaces again holds that one's body here: B4's own is the one in this file.
      const later = REPLACED_LATER[r.name];
      if (later) expect(real[r.name], r.name).toBe(later);
      expect(post).toMatch(new RegExp(`${r.name}\\s+\\| ${b4Md5(r)} \\|`));
      if (!later) expect(real[r.name], r.name).toBe(b4Md5(r));
    }
  });

  it("post-apply 1, 2 and 4: privileges, security flags, search_path and grants are as the header says", async () => {
    const priv = async (role: string, fn: string) => (await q("select has_function_privilege($1, $2, 'execute') as x", [role, fn]))[0]!.x as boolean;
    const submit = "public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)";
    expect([
      await priv("anon", submit),
      await priv("authenticated", submit),
      await priv("anon", "public.play_proposal_contacts(uuid)"),
      await priv("authenticated", "public.play_proposal_contacts(uuid)"),
      await priv("anon", "private.play_patch_problem(uuid, public.share_links, jsonb)"),
      await priv("authenticated", "private.play_patch_problem(uuid, public.share_links, jsonb)"),
      await priv("anon", "private.lever_kind_ids()"),
      await priv("authenticated", "private.lever_kind_ids()"),
    ]).toEqual([true, true, false, true, false, false, false, false]);
    expect([await priv("anon", "public.open_share_link(text)"), await priv("authenticated", "public.open_share_link(text)")]).toEqual([true, true]);
    expect([await priv("anon", "private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)"), await priv("authenticated", "private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)")]).toEqual([false, false]);
    const flags = Object.fromEntries(
      (await q("select proname, prosecdef, proconfig = array['search_path=\"\"'] as cfg, provolatile from pg_proc where proname = any ($1)", [
        ["submit_play_proposal", "play_proposal_contacts", "play_patch_problem", "lever_kind_ids", "share_links_before_write", "share_snapshot_problem", "open_share_link", "suggestion_proposals_before_write", "suggestions_before_write", "build_proposal"],
      ])).map((r) => [r.proname, r]),
    );
    for (const n of ["submit_play_proposal", "play_proposal_contacts", "share_links_before_write", "open_share_link"]) expect(flags[n].prosecdef, n).toBe(true);
    for (const n of ["play_patch_problem", "lever_kind_ids", "share_snapshot_problem", "suggestion_proposals_before_write", "suggestions_before_write", "build_proposal"]) expect(flags[n].prosecdef, n).toBe(false);
    for (const n of Object.keys(flags)) expect(flags[n].cfg, n).toBe(true);
    expect(flags.open_share_link.provolatile).toBe("v");
    expect(flags.submit_play_proposal.provolatile).toBe("v");
    const grants = await q(
      "select table_name, privilege_type, count(*)::int as n from information_schema.column_privileges where table_schema = 'public' and table_name in ('share_links', 'suggestion_proposals') and grantee in ('anon', 'authenticated') group by 1, 2 order by 1, 2",
    );
    expect(grants.filter((g) => g.table_name === "share_links")).toEqual([
      { table_name: "share_links", privilege_type: "INSERT", n: 12 },
      { table_name: "share_links", privilege_type: "SELECT", n: 18 },
      { table_name: "share_links", privilege_type: "UPDATE", n: 4 },
    ]);
    expect((await q("select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'suggestion_proposals' and grantee = 'authenticated' and privilege_type = 'SELECT' and column_name in ('share_link_id', 'visitor_text', 'proposer_email')")).map((r) => r.column_name)).toEqual(["share_link_id"]);
    expect((await q("select count(*)::int as n from information_schema.column_privileges where table_schema = 'public' and grantee = 'anon'"))[0]!.n).toBe(0);
    expect(await q("select conname, convalidated from pg_constraint where conname in ('suggestion_proposals_issue', 'suggestion_proposals_visitor_text') order by 1")).toEqual([
      { conname: "suggestion_proposals_issue", convalidated: true },
      { conname: "suggestion_proposals_visitor_text", convalidated: true },
    ]);
    expect(await q("select indexname from pg_indexes where indexname = 'suggestion_proposals_share_link_idx'")).toHaveLength(1);
  });

  /** The header's own queries for post-apply check `n`, exactly as written (the lines after `--   n.` that start `--        select`). */
  function postApply(n: number): string[] {
    const head = migration.slice(0, migration.indexOf("-- ROLLBACK ("));
    const from = head.indexOf("-- POST-APPLY CHECK:");
    const at = head.indexOf(`--   ${n}. `, from);
    const next = head.indexOf(`\n--   ${n + 1}. `, at);
    const lines = head.slice(at, next < 0 ? head.length : next).split("\n");
    const out: string[] = [];
    let buf: string[] | null = null;
    for (const line of lines) {
      if (/^--\s{8}select/.test(line)) buf = [];
      if (buf && /^--\s{8,}\S/.test(line)) {
        buf.push(line.replace(/^--\s+/, ""));
        if (line.trimEnd().endsWith(";")) {
          out.push(buf.join(" "));
          buf = null;
        }
      } else if (buf) buf = null;
    }
    return out;
  }

  it("the header's post-apply queries, run verbatim, return what the header says (checks 1 to 4)", async () => {
    // 1: execute privileges.
    const [c1] = postApply(1);
    expect(await qa(c1!)).toEqual([true, true, false, true, false, false, false, false]);
    // 2: security flags, search_path and volatility, one row per function.
    const [c2] = postApply(2);
    const rows = await q(c2!);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r["?column?"] === true)).toBe(true);
    // 3: the two constraints, validated.
    const [c3] = postApply(3);
    expect((await q(c3!)).map((r) => [r.conname, r.convalidated]).sort()).toEqual([
      ["suggestion_proposals_issue", true],
      ["suggestion_proposals_visitor_text", true],
    ]);
    // 4: the first query's six rows, as the header states them, and the second's single column.
    const [first, second] = postApply(4);
    expect((await q(first!)).map((r) => `${r.table_name} ${r.privilege_type} ${r.count}`)).toEqual([
      "share_links INSERT 12",
      "share_links SELECT 18",
      "share_links UPDATE 4",
      "suggestion_proposals INSERT 23",
      "suggestion_proposals SELECT 21",
      "suggestion_proposals UPDATE 5",
    ]);
    expect(migration).toContain("share_links INSERT 12, SELECT 18, UPDATE 4; suggestion_proposals INSERT 23, SELECT 21, UPDATE 5");
    expect((await q(second!)).map((r) => r.column_name)).toEqual(["share_link_id"]);
  });

  it("the smoke test (post-apply 6) runs to the end in ONE transaction: the refused insert sits in a savepoint", async () => {
    const head = migration.slice(0, migration.indexOf("-- ROLLBACK ("));
    expect(head).toContain("`savepoint s;` ... `rollback to savepoint s;`");
    const ws = (await q("select id from workspaces where slug = 'northbeam'"))[0]!.id as string;
    const proc = (await q("select id, live_revision_id from processes where workspace_id = $1 and live_revision_id is not null and not is_company limit 1", [ws]))[0]!;
    const person = (await q("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws]))[0]!.name as string;
    const token = "s".repeat(43);
    const snap = (hidden: unknown) =>
      JSON.stringify({ v: 1, kind: "process", toggles: { people: false, financials: false }, hiddenLevers: hidden, workspaceName: "Northbeam", bundle: { revision: { id: proc.live_revision_id }, steps: [], roles: [], people: [], services: [] }, issues: [] });
    const insert = "insert into share_links (workspace_id, token_hash, kind, target_id, mode, snapshot, engine_version) values ($1, $2, 'process', $3, 'play', $4::jsonb, '1.8.0')";
    const adminId = "00000000-0000-4000-8000-0000000000ad";
    await q("insert into auth.users (id, email) values ($1, 'smoke-admin@example.com') on conflict do nothing", [adminId]);
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: adminId, role: "authenticated", app_metadata: { agency_admin: true } })]);
      await db.client.query(insert, [ws, sha(token), proc.id, snap(["process.rework"])]);
      await db.client.query("savepoint s");
      await expect(db.client.query(insert, [ws, sha("x"), proc.id, snap(["Priya"])])).rejects.toMatchObject({ code: "23514", message: "The snapshot doesn't match the link." });
      await db.client.query("rollback to savepoint s");
      await db.client.query("set local role anon");
      await db.client.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      const call = (title: string) =>
        db.client.query(`select public.submit_play_proposal($1, $2, null, 'Smoke test', 'smoke@example.com', null, '[{"path":"demand.leads_per_week","op":"set","value":9}]') ->> 'status' as s`, [token, title]);
      expect((await call("Smoke")).rows[0].s).toBe("ok");
      await db.client.query("reset role");
      expect((await q("select created_via, created_by, status, visitor_text from suggestion_proposals where title = 'Smoke'"))[0]).toEqual({ created_via: "play_link", created_by: null, status: "pending", visitor_text: null });
      await db.client.query("set local role anon");
      expect((await call(person)).rows[0].s).toBe("ok");
      await db.client.query("reset role");
      expect((await q("select title, visitor_text from suggestion_proposals where share_link_id is not null and visitor_text is not null"))[0]).toEqual({ title: "A visitor's idea", visitor_text: { title: person } });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("the ROLLBACK block puts every replaced function back (preflight 2's md5s return), drops what was added, and the preflight then reads as written; the migration applies again", async () => {
    await q("create schema if not exists supabase_migrations");
    await q("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
    await q("insert into supabase_migrations.schema_migrations (version, name) values ($1, 'play_links') on conflict do nothing", [VERSION]);
    const before = await md5s();
    // A visitor's idea with an issue, one with none, and a play link: what the rollback deletes and keeps.
    const ws = (await q("select id from workspaces limit 1"))[0]!.id as string;
    const issue = (await q("select id from issues where workspace_id = $1 limit 1", [ws]))[0]!.id as string;
    await q("select set_config('transpera.play_submitting', 'on', false)");
    await q("insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id) values ($1, 'solution_idea', 'with issue', '{\"steps\": []}', $2), ($1, 'solution_idea', 'no issue', '{\"steps\": []}', null)", [ws, issue]);
    await q("select set_config('transpera.play_submitting', '', false)");
    expect((await q("select count(*)::int as n from suggestion_proposals where created_via = 'play_link'"))[0]!.n).toBe(2);

    const rollback = headerRollback(FILE);
    expect(rollback).toMatch(/^begin;/);
    expect(rollback).toMatch(/commit;$/);
    expect(rollback).toContain(`delete from supabase_migrations.schema_migrations where version = '${VERSION}';`);
    await db.client.query(rollback);

    const after = await md5s();
    for (const r of REPLACED) expect(after[r.name], r.name).toBe(r.md5Before);
    expect(await q("select to_regprocedure('public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)') as a, to_regprocedure('public.play_proposal_contacts(uuid)') as b, to_regprocedure('private.play_patch_problem(uuid, public.share_links, jsonb)') as c, to_regprocedure('private.lever_kind_ids()') as d")).toEqual([{ a: null, b: null, c: null, d: null }]);
    expect(await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'suggestion_proposals' and column_name in ('share_link_id', 'visitor_text')")).toEqual([]);
    expect(await q("select version from supabase_migrations.schema_migrations where version = $1", [VERSION])).toEqual([]);
    expect((await q("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'suggestion_proposals_issue'"))[0]!.d).toBe("CHECK (((kind = 'solution_idea'::text) = (issue_id IS NOT NULL)))");
    // Visitor ideas with no issue are deleted; the one with an issue stays.
    expect((await q("select title from suggestion_proposals where created_via = 'play_link' order by title")).map((r) => r.title)).toEqual(["with issue"]);
    expect((await q("select count(*)::int as n from information_schema.column_privileges where table_schema = 'public' and table_name = 'share_links' and grantee = 'authenticated' and privilege_type = 'INSERT'"))[0]!.n).toBe(11);
    // The preflight now reads as the header says.
    expect(await qa(preflight(1))).toEqual([null, null, null, null, "0", "0"]);
    const six = await q(preflight(2));
    expect(six.map((r) => [r.nspname, r.proname, r.md5, r.prosecdef])).toEqual([
      ["private", "share_links_before_write", "d62acd6761b553263ab52f6f2c5df312", true],
      ["private", "share_snapshot_problem", "0bf3c675bdb2a030543a3151f1075178", false],
      ["private", "suggestion_proposals_before_write", "c7e2a34a4f48034bbc132497eaa877db", false],
      ["private", "suggestions_before_write", "85b012ee7c6f30f05236fe3ea5f19ada", false],
      ["public", "build_proposal", "b911a2835fd900d87c511ea69a2fa1dc", false],
      ["public", "open_share_link", "1f58a06299923867c9ca4e19b9f8fce6", true],
    ]);
    expect(await qa(preflight(3))).toEqual(["CHECK (((kind = 'solution_idea'::text) = (issue_id IS NOT NULL)))"]);
    // (the one visitor idea with an issue that the rollback keeps is the 1)
    expect((await qa(preflight(4))).map(Number)).toEqual([0, 1, 0, 0]);
    expect((await qa(preflight(5))).every((v) => v !== null)).toBe(true);

    // And the migration applies again, to the same md5s as before the rollback.
    await db.client.query(migration);
    const again = await md5s();
    // ... except a function a later migration replaces again: it now holds B4's body, not the later one's.
    expect(again).toEqual({ ...before, ...Object.fromEntries(REPLACED.filter((r) => REPLACED_LATER[r.name]).map((r) => [r.name, b4Md5(r)])) });
  });
});
