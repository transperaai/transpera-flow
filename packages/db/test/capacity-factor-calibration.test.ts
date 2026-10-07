import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamStepIds } from "../src";
import { headerRollback } from "./header-rollback";
import { createTestDb, createUser, type TestDb } from "./harness";

// Per-person times measured from a log that names people (issue #227, migration 20261227000000_calibrate_capacity_factors.sql):
// the proposals table only owners, editors and agency admins read, the capacity_factor kind in record_calibration_import and
// apply_calibration, `items` in team_capacity, and the header's md5s and rollback.

const FILE = "20261227000000_calibrate_capacity_factors.sql";
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const P = {
  member: northbeamPersonIds["Leah Brooks"]!,
  viewer: northbeamPersonIds["Dan Okafor"]!,
  editor: northbeamPersonIds["Maya Collins"]!,
  a: northbeamPersonIds["Sam Patel"]!,
  b: northbeamPersonIds["Chloe Evans"]!,
};
const S1 = northbeamStepIds.audit;
const S2 = northbeamStepIds.kickoff;

type Claims = Record<string, unknown>;
interface User {
  id: string;
  claims: Claims;
}
let db: TestDb;
let editor: User;
let owner: User;
let member: User;
let viewer: User;
let admin: User;
let stranger: User;
const tokenId = randomUUID();
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

const setSwitch = (on: boolean) =>
  q("update workspaces set settings = settings || $2::jsonb where id = $1", [ws, JSON.stringify({ capacity_factor_enabled: on })]);

/** A per-person proposal as `proposePersonTimes` writes it (the fields the database reads, and a few it keeps). */
const proposal = (person: string, step: string, factor: number, before: number | null = null, n = 14) => ({
  key: `factor:${person}:${step}`,
  kind: "capacity_factor",
  target: { table: "person_capacity_factors", id: person, step_id: step },
  personId: person,
  stepId: step,
  subject: "A step",
  n,
  stepN: 40,
  enough: true,
  current: before,
  currentSource: before === null ? null : "entered",
  every: null,
  measured: factor,
  proposed: factor,
  limited: false,
  within: false,
  changed: true,
  blocked: null,
  note: "note",
  set: { factor },
  before: { factor: before },
});

type Applied = { status: string; results: { key: string; status: string }[]; calibration_id: string; dataset_id: string };

async function commitAs<T>(claims: Claims, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

const record = (c: pg.Client, factors: ReturnType<typeof proposal>[], keys: string[] | null, extra: Record<string, unknown> = {}) =>
  c
    .query("select public.record_calibration_import($1, $2, 'time_logs', 'log.csv', $3, 100, $4, $5, $6) as r", [
      ws,
      proc,
      { job: "Job", task: "Task", date: "Date", hours: "Hours", person: "Column 5" },
      JSON.stringify({ delimiter: ",", encoding: "utf-8", headerRow: 1, rows: 100, leftOut: 0 }),
      JSON.stringify({ proposals: [], capacity_factors: factors, ...extra }),
      keys,
    ])
    .then((r) => r.rows[0].r as Applied);

const factorRow = async (person: string, step: string) => (await q("select factor::float8 as factor, provenance from person_capacity_factors where person_id = $1 and step_id = $2", [person, step]))[0] as
  | { factor: number; provenance: { factor: Record<string, unknown> } }
  | undefined;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const link = async (email: string, role: string, person: string | null) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, $3, $4)", [ws, u.id, role, person]);
    return u;
  };
  editor = await link("cfc-editor@example.com", "editor", P.editor);
  owner = await link("cfc-owner@example.com", "owner", null);
  member = await link("cfc-member@example.com", "member", P.member);
  viewer = await link("cfc-viewer@example.com", "viewer", P.viewer);
  admin = await createUser(db, "cfc-admin@example.com", { agency_admin: true });
  stranger = await createUser(db, "cfc-stranger@example.com");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("recording and applying per-person times", () => {
  it("an editor with the switch on: the calibration holds no person, the proposals are kept apart, the ticked one is applied measured", async () => {
    await setSwitch(true);
    const one = proposal(P.a, S1, 0.8);
    const two = proposal(P.b, S1, 1.2);
    const r = await commitAs(editor.claims, (c) => record(c, [one, two], [one.key]));
    expect(r.status).toBe("ok");
    // The page's own keys come back.
    expect(r.results).toEqual([{ key: one.key, status: "applied" }]);

    const [cal] = await q("select results, applied_keys from calibrations where id = $1", [r.calibration_id]);
    expect(cal.results).not.toHaveProperty("capacity_factors");
    const text = JSON.stringify(cal);
    for (const person of [P.a, P.b, P.editor]) expect(text).not.toContain(person);
    expect(text).not.toContain("0.8");
    const rows = await q("select id, person_id, step_id, proposal from capacity_factor_proposals where calibration_id = $1 order by person_id", [r.calibration_id]);
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.person_id).sort()).toEqual([P.a, P.b].sort());
    const applied = rows.find((x) => x.person_id === P.a)!;
    expect(applied.proposal.set).toEqual({ factor: 0.8 });
    // The applied key names the row, not the person.
    expect(cal.applied_keys).toEqual([`factor:${applied.id}`]);

    const f = await factorRow(P.a, S1);
    expect(f!.factor).toBe(0.8);
    expect(f!.provenance.factor).toMatchObject({ source: "measured", dataset_id: r.dataset_id, calibration_id: r.calibration_id, n: 14, by: editor.id });
    expect(f!.provenance.factor.at).toBeTruthy();
    expect(await factorRow(P.b, S1)).toBeUndefined();
  });

  it("applying over an entered time updates it and makes it measured", async () => {
    await q("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, $3, 1.3)", [P.b, ws, S2]);
    expect((await factorRow(P.b, S2))!.provenance.factor).toMatchObject({ source: "entered" });
    const p = proposal(P.b, S2, 0.9, 1.3);
    const r = await commitAs(editor.claims, (c) => record(c, [p], [p.key]));
    expect(r.results).toEqual([{ key: p.key, status: "applied" }]);
    const f = await factorRow(P.b, S2);
    expect(f!.factor).toBe(0.9);
    expect(f!.provenance.factor).toMatchObject({ source: "measured", calibration_id: r.calibration_id });
  });

  it("a stale before gives `changed`, a person or step from another workspace `not_found`, a factor of 2.5 `invalid`", async () => {
    const stale = proposal(P.b, S2, 1.1, 1.3); // the stored time is 0.9 now
    const bad = proposal(P.a, S2, 2.5);
    const otherWs = proposal(randomUUID(), S2, 1.1);
    const otherStep = proposal(P.a, randomUUID(), 1.1);
    const r = await commitAs(editor.claims, (c) => record(c, [stale, bad, otherWs, otherStep], [stale.key, bad.key, otherWs.key, otherStep.key]).catch((e) => e));
    // A person id that isn't in `people` fails the table's foreign key: the whole call is refused.
    expect(r).toBeInstanceOf(Error);
    const r2 = await commitAs(editor.claims, (c) => record(c, [stale, bad, otherStep], [stale.key, bad.key, otherStep.key]));
    const by = Object.fromEntries(r2.results.map((x) => [x.key, x.status]));
    expect(by[stale.key]).toBe("changed");
    expect(by[bad.key]).toBe("invalid");
    expect(by[otherStep.key]).toBe("not_found");
    expect((await factorRow(P.b, S2))!.factor).toBe(0.9);
    expect(await factorRow(P.a, S2)).toBeUndefined();
  });

  it("a key that wasn't proposed, or is applied twice, is reported as for any calibration", async () => {
    const p = proposal(P.a, S2, 0.7);
    const r = await commitAs(editor.claims, (c) => record(c, [p], [p.key, `factor:${P.a}:${randomUUID()}`]));
    const by = Object.fromEntries(r.results.map((x) => [x.key, x.status]));
    expect(by[p.key]).toBe("applied");
    expect(Object.values(by).filter((s) => s === "not_proposed")).toHaveLength(1);
    // Apply again over the same calibration: the page's key isn't a row id, so nothing is found; the row id is already applied.
    const [row] = await q("select id from capacity_factor_proposals where calibration_id = $1", [r.calibration_id]);
    const again = (await commitAs(editor.claims, async (c) => (await c.query("select public.apply_calibration($1, $2) as r", [r.calibration_id, [`factor:${row.id}`]])).rows[0].r)) as { results: { status: string }[] };
    expect(again.results).toEqual([{ key: `factor:${row.id}`, status: "already_applied" }]);
  });

  it("with the switch off the record call is refused 22023, and applying an existing calibration gives switched_off", async () => {
    const p = proposal(P.a, S1, 0.85, 0.8);
    await setSwitch(true);
    const r = await commitAs(editor.claims, (c) => record(c, [p], []).catch((e) => e)); // no keys: apply refuses 22023 either way
    expect(r).toBeInstanceOf(Error);
    // Record without applying anything by ticking nothing is refused by apply_calibration; so record while on, then switch off.
    const rec = await commitAs(editor.claims, (c) => record(c, [p], [`factor:${P.a}:${randomUUID()}`]));
    const [row] = await q("select id from capacity_factor_proposals where calibration_id = $1", [rec.calibration_id]);
    await setSwitch(false);
    const off = (await commitAs(editor.claims, async (c) => (await c.query("select public.apply_calibration($1, $2) as r", [rec.calibration_id, [`factor:${row.id}`]])).rows[0].r)) as { results: { status: string }[] };
    expect(off.results).toEqual([{ key: `factor:${row.id}`, status: "switched_off" }]);
    expect((await factorRow(P.a, S1))!.factor).toBe(0.8);
    await expect(commitAs(editor.claims, (c) => record(c, [p], [p.key]))).rejects.toMatchObject({ code: "22023", message: expect.stringContaining("switched off") });
    // No calibration or proposal was left behind by the refused call.
    expect(await q("select 1 from capacity_factor_proposals where proposal ->> 'note' = 'note' and calibration_id not in (select id from calibrations)")).toEqual([]);
    await setSwitch(true);
  });

  it("an owner and an agency admin can apply them too", async () => {
    const o = proposal(P.a, S2, 0.95, 0.7);
    const ro = await commitAs(owner.claims, (c) => record(c, [o], [o.key]));
    expect(ro.results).toEqual([{ key: o.key, status: "applied" }]);
    const ad = proposal(P.b, S1, 1.05);
    const ra = await commitAs(admin.claims, (c) => record(c, [ad], [ad.key]));
    expect(ra.results).toEqual([{ key: ad.key, status: "applied" }]);
  });

  it("a step or arrivals calibration with no per-person data behaves as before", async () => {
    const r = await commitAs(editor.claims, (c) =>
      c
        .query("select public.record_calibration_import($1, $2, 'step_log', 'log.csv', '{}', 10, '{}', $3, $4) as r", [ws, proc, JSON.stringify({ proposals: [] }), [`work:${S1}`]])
        .then((x) => x.rows[0].r as Applied),
    );
    expect(r.results).toEqual([{ key: `work:${S1}`, status: "not_proposed" }]);
    expect(await q("select 1 from capacity_factor_proposals where calibration_id = $1", [r.calibration_id])).toEqual([]);
    // No keys at all is still refused, as it was.
    await expect(commitAs(editor.claims, (c) => record(c, [], null))).rejects.toMatchObject({ code: "22023" });
  });
});

describe("who may record per-person times", () => {
  it("a member and a viewer are refused 42501 and nothing is recorded", async () => {
    const p = proposal(P.a, S2, 0.6);
    const before = Number((await q("select count(*) from datasets"))[0].count);
    for (const who of [member, viewer]) {
      await expect(commitAs(who.claims, (c) => record(c, [p], [p.key]))).rejects.toMatchObject({ code: "42501" });
    }
    expect(Number((await q("select count(*) from datasets"))[0].count)).toBe(before);
    expect(await q("select 1 from capacity_factor_proposals where person_id = $1 and step_id = $2 and proposal -> 'set' ->> 'factor' = '0.6'", [P.a, S2])).toEqual([]);
  });

  it("a stranger is refused, and so is an API token (even an editor's)", async () => {
    const p = proposal(P.a, S2, 0.6);
    await expect(commitAs(stranger.claims, (c) => record(c, [p], [p.key]))).rejects.toMatchObject({ code: "42501" });
    await expect(commitAs({ ...editor.claims, api_token_id: tokenId }, (c) => record(c, [p], [p.key]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("capacity_factor_proposals", () => {
  it("an editor, an owner and an agency admin read them; a member, a viewer and a stranger read none", async () => {
    expect(Number((await q("select count(*) from capacity_factor_proposals"))[0].count)).toBeGreaterThan(0);
    for (const who of [editor, owner, admin]) {
      expect(Number((await db.as(who.claims, async (c) => (await c.query("select count(*) from capacity_factor_proposals")).rows[0].count))), "reader").toBeGreaterThan(0);
    }
    for (const who of [member, viewer, stranger]) {
      expect(await db.as(who.claims, async (c) => (await c.query("select * from capacity_factor_proposals")).rows)).toEqual([]);
    }
    // Not even a member's own person's proposals.
    const own = proposal(P.member, S1, 1.1);
    await commitAs(editor.claims, (c) => record(c, [own], [own.key]));
    expect(await db.as(member.claims, async (c) => (await c.query("select * from capacity_factor_proposals where person_id = $1", [P.member])).rows)).toEqual([]);
  });

  it("nobody can update or delete them", async () => {
    for (const who of [editor, owner, admin]) {
      await db.as(who.claims, async (c) => {
        await expect(c.query("update capacity_factor_proposals set proposal = proposal")).rejects.toThrow(/permission denied/);
      });
      await db.as(who.claims, async (c) => {
        await expect(c.query("delete from capacity_factor_proposals")).rejects.toThrow(/permission denied/);
      });
    }
    expect((await q("select has_table_privilege('anon', 'public.capacity_factor_proposals', 'select') s")).at(0)!.s).toBe(false);
  });

  it("a proposal must name its own person and step", async () => {
    const [cal] = await q("select id from calibrations limit 1");
    await expect(
      q("insert into capacity_factor_proposals (calibration_id, workspace_id, person_id, step_id, proposal) values ($1, $2, $3, $4, $5::jsonb)", [
        cal.id,
        ws,
        P.a,
        S1,
        JSON.stringify({ kind: "capacity_factor", target: { table: "person_capacity_factors", id: P.b, step_id: S1 } }),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("team_capacity items", () => {
  type Item = { person_id: string; step_id: string | null; source: string; items: number | null; [k: string]: unknown };
  const itemsAs = async (who: User) => (await db.as(who.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t)).person_capacity_factors as Item[];

  it("a measured time has items equal to its n, an entered one null; a member sees only their own, with no provenance", async () => {
    await q("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, 1.2) on conflict do nothing", [P.a, ws]);
    const all = await itemsAs(editor);
    const measured = all.find((x) => x.person_id === P.a && x.step_id === S1)!;
    expect(measured.source).toBe("measured");
    expect(measured.items).toBe(14);
    const entered = all.find((x) => x.person_id === P.a && x.step_id === null)!;
    expect(entered.source).toBe("entered");
    expect(entered.items).toBeNull();
    for (const row of all) expect(Object.keys(row)).not.toContain("provenance");
    // The member's own person has a measured time (applied above): they see it and only their own.
    const mine = await itemsAs(member);
    expect(mine.every((x) => x.person_id === P.member)).toBe(true);
    expect(mine.find((x) => x.step_id === S1)).toMatchObject({ source: "measured", items: 14 });
    expect(JSON.stringify(mine)).not.toContain(P.a);
  });
});

describe("team_capacity with a hand-written provenance", () => {
  it("gives items null, and doesn't fail, when a measured time's n isn't a count", async () => {
    await db.client.query("begin");
    try {
      // As written or restored by hand: a huge number and a string. The read must still work for everyone.
      await q("update person_capacity_factors set provenance = jsonb_build_object('factor', jsonb_build_object('source', 'measured', 'n', 1e20)) where person_id = $1 and step_id = $2", [P.a, S1]);
      await q("update person_capacity_factors set provenance = jsonb_build_object('factor', jsonb_build_object('source', 'measured', 'n', 'many')) where person_id = $1 and step_id = $2", [P.b, S2]);
      await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
      const t = (await q("select public.team_capacity($1) as t", [ws]))[0]!.t as { person_capacity_factors: { person_id: string; step_id: string | null; items: number | null }[] };
      const item = (person: string, step: string) => t.person_capacity_factors.find((x) => x.person_id === person && x.step_id === step)!;
      expect(item(P.a, S1).items).toBeNull();
      expect(item(P.b, S2).items).toBeNull();
    } finally {
      await db.client.query("rollback");
    }
  });
});

/** The text between a function's `$$` marks, as pg_proc.prosrc holds it. */
function body(file: string, name: string): string {
  const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
  const at = sql.search(new RegExp(`^create (or replace )?function ${name.replace(".", "\\.")}\\(`, "m"));
  expect(at, `${name} in ${file}`).toBeGreaterThan(-1);
  const start = sql.indexOf("$$", at) + 2;
  return sql.slice(start, sql.indexOf("\n$$;", start) + 1);
}

const FUNCTIONS = [
  { key: "pp", name: "private.calibration_payload_problem", was: "20261208000000_client_calibration.sql", md5: "d4da9751d6d050289a7dc5f07eb3c414", removed: [] as string[] },
  {
    key: "ac",
    name: "public.apply_calibration",
    was: "20261208000000_client_calibration.sql",
    md5: "28fcf1c8c13a5f2e4b4b9c5d7f3feadb",
    removed: ["    select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;"],
  },
  {
    key: "rci",
    name: "public.record_calibration_import",
    was: "20261216000000_dataset_imports.sql",
    md5: "f1a66685c4bbaeb3c212e5babeea9a6e",
    removed: ["  values (p_workspace, ds, p_process, p_results)", "  out := public.apply_calibration(cal, p_keys);"],
  },
  {
    key: "tc",
    name: "public.team_capacity",
    was: "20261223000000_capacity_factors.sql",
    md5: "a8dcb5d1bddaf549ecef591a3c1b5ae0",
    removed: ["        'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'))"],
  },
];

/** The old body's lines, in order, within the new one; every run of added lines carries a `#227` mark. Returns the old lines not kept. */
function diff(oldBody: string, newBody: string): { dropped: string[]; added: string[][] } {
  const a = oldBody.split("\n");
  const b = newBody.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const dropped: string[] = [];
  const added: string[][] = [];
  let run: string[] | null = null;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      run = null;
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      if (!run) added.push((run = []));
      run.push(b[j]!);
      j++;
    } else {
      dropped.push(a[i]!);
      i++;
    }
  }
  return { dropped, added };
}

describe("the migration file", () => {
  const sql = readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), "utf8");

  for (const f of FUNCTIONS) {
    it(`${f.name}: the live md5 is this migration's, the header states both md5s, and the body is the previous one plus marked #227 lines`, async () => {
      const live = (await q("select md5(prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = $1", [f.name]))[0].m as string;
      const mine = body(FILE, f.name);
      const { createHash } = await import("node:crypto");
      expect(createHash("md5").update(mine).digest("hex")).toBe(live);
      expect(sql).toContain(`${f.name} ${f.md5}`);
      expect(sql).toContain(live);
      const old = body(f.was, f.name);
      expect(createHash("md5").update(old).digest("hex")).toBe(f.md5);
      const { dropped, added } = diff(old, mine);
      expect(dropped).toEqual(f.removed);
      expect(added.length).toBeGreaterThan(0);
      for (const run of added) expect(run.join("\n"), run[0]).toContain("#227");
    });
  }

  it("settings and grants are as before: SECURITY INVOKER except team_capacity, search_path empty, anon can't execute the public ones", async () => {
    const rows = await q(
      "select n.nspname || '.' || p.proname as name, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = any ($1) order by 1",
      [FUNCTIONS.map((f) => f.name)],
    );
    expect(rows.map((r) => [r.name, r.prosecdef, r.proconfig])).toEqual([
      ["private.calibration_payload_problem", false, ["search_path=\"\""]],
      ["public.apply_calibration", false, ["search_path=\"\""]],
      ["public.record_calibration_import", false, ["search_path=\"\""]],
      ["public.team_capacity", true, ["search_path=\"\""]],
    ]);
    const anon = await q(
      "select has_function_privilege('anon', 'public.apply_calibration(uuid, text[])', 'execute') a, has_function_privilege('anon', 'public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])', 'execute') b, has_function_privilege('anon', 'public.team_capacity(uuid)', 'execute') c",
    );
    expect(anon).toEqual([{ a: false, b: false, c: false }]);
  });

  it("the header's rollback, run as written, puts the four md5s back and drops the table", async () => {
    const own = await createTestDb();
    try {
      const oq = async (text: string, params: unknown[] = []) => (await own.client.query(text, params)).rows;
      await oq("create schema if not exists supabase_migrations");
      await oq("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
      await oq("insert into supabase_migrations.schema_migrations (version, name) values ('20261227000000', 'calibrate_capacity_factors') on conflict do nothing");
      const md5s = async () => Object.fromEntries((await oq("select p.proname as n, md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity'))")).map((r) => [r.n, r.m]));
      expect(await oq("select to_regclass('public.capacity_factor_proposals') as t")).toEqual([{ t: "capacity_factor_proposals" }]);
      const rollback = headerRollback(FILE);
      expect(rollback).toMatch(/^begin;/);
      expect(rollback).toMatch(/commit;$/);
      await own.client.query(rollback);
      expect(await oq("select to_regclass('public.capacity_factor_proposals') as t")).toEqual([{ t: null }]);
      // Preflight 1, as the header prints it, now gives exactly what it expects before the migration.
      const pre1 = /^-- {8}(select n\.nspname \|\| '\.' \|\| p\.proname, md5\(p\.prosrc\), p\.prosecdef, p\.proconfig .*;)$/m.exec(readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), "utf8"))![1]!;
      expect((await own.client.query({ text: pre1, rowMode: "array" })).rows).toEqual(
        FUNCTIONS.map((f) => f.name)
          .sort()
          .map((name) => {
            const f = FUNCTIONS.find((x) => x.name === name)!;
            return [name, f.md5, name === "public.team_capacity", ['search_path=""']];
          }),
      );
      expect(await md5s()).toEqual({
        apply_calibration: "28fcf1c8c13a5f2e4b4b9c5d7f3feadb",
        calibration_payload_problem: "d4da9751d6d050289a7dc5f07eb3c414",
        record_calibration_import: "f1a66685c4bbaeb3c212e5babeea9a6e",
        team_capacity: "a8dcb5d1bddaf549ecef591a3c1b5ae0",
      });
      expect(await oq("select version from supabase_migrations.schema_migrations where version = '20261227000000'")).toEqual([]);
      expect(await oq("select has_function_privilege('anon', 'public.apply_calibration(uuid, text[])', 'execute') a, has_function_privilege('authenticated', 'public.apply_calibration(uuid, text[])', 'execute') b")).toEqual([{ a: false, b: true }]);
    } finally {
      await own.close();
    }
  }, 120_000);

  it("says in its header where it goes (after row 71, applied) and what preflight 0 expects", () => {
    expect(sql).toContain("-- ORDER: after row 71 (applied): 20261226000000 (#228), the latest on production.");
    expect(sql).toContain(
      "select version from supabase_migrations.schema_migrations where version in ('20261208000000', '20261216000000', '20261223000000') or version >= '20261224000000' order by 1;",
    );
    expect(sql).toContain("20261208000000, 20261216000000, 20261223000000, 20261224000000, 20261224500000, 20261225000000, 20261226000000 (so nothing\n--      >= 20261227000000)");
    const apply = readFileSync(new URL(`../scripts/apply/${FILE}`, import.meta.url), "utf8");
    expect(apply.slice(0, apply.indexOf("begin;"))).toContain("apply it after row 71 (applied)");
  });

  /** The smoke block exactly as the header prints it (post-apply 6), and the message it must end with. */
  const smoke = () => {
    const head = sql.slice(0, sql.indexOf("-- ROLLBACK ("));
    const lines = head.split("\n");
    const from = lines.indexOf("--        do $smoke$");
    const to = lines.indexOf("--        $smoke$;");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = lines.slice(from, to + 1).map((l) => l.slice("--        ".length)).join("\n");
    expect(block).toContain("<agency admin user id>");
    const expected = lines[from - 1]!.slice("--        ".length);
    return { block, expected };
  };
  const counts = async () => (await q("select (select count(*) from datasets)::int d, (select count(*) from calibrations)::int c, (select count(*) from capacity_factor_proposals)::int p, (select count(*) from person_capacity_factors)::int f, (select count(*) from memberships)::int m, (select settings from workspaces where id = $1) s", [ws]))[0];

  it("has a post-apply smoke test (one do block, as an agency admin, then as a member) that rolls everything back", async () => {
    const { block, expected } = smoke();
    expect(expected).toBe(
      "SMOKE TEST ROLLED BACK: as the admin status=applied, source=measured, n=12, items=12, calibration names nobody=yes; as a member proposals=0, other people's times=0, calibration names nobody=yes, recording=42501",
    );
    // With the switch off, as on production before anyone switches it on: the block switches it on itself.
    await setSwitch(false);
    try {
      const before = await counts();
      // Run as the operator would: outside any transaction, the block as printed with the user id put in.
      const e = await db.client.query(block.replace("<agency admin user id>", admin.id)).then(
        () => null,
        (x: { code?: string; message?: string }) => x,
      );
      expect([e?.code, e?.message]).toEqual(["P0001", expected]);
      expect(await counts()).toEqual(before);
      expect(await q("select count(*)::int as n from datasets where file_name = 'smoke-test-227.csv'")).toEqual([{ n: 0 }]);

      // With no member or viewer in Northbeam, the block makes an account with no access a member (and rolls that back too).
      await db.client.query("begin");
      try {
        await db.client.query("delete from memberships where workspace_id = $1 and role in ('member', 'viewer')", [ws]);
        const e2 = await db.client.query(block.replace("<agency admin user id>", admin.id)).then(
          () => null,
          (x: { code?: string; message?: string }) => x,
        );
        expect([e2?.code, e2?.message]).toEqual(["P0001", expected]);
      } finally {
        await db.client.query("rollback");
      }
      expect(await counts()).toEqual(before);

      // Someone who isn't an agency admin, owner or editor can't pass it by accident: recording is refused.
      const refused = await db.client.query(block.replace("<agency admin user id>", stranger.id).replace('"agency_admin":true', '"agency_admin":false')).then(
        () => null,
        (x: { code?: string }) => x,
      );
      expect(refused?.code).toBe("42501");
      expect(await counts()).toEqual(before);
    } finally {
      await setSwitch(true);
    }
  }, 120_000);

  it("the apply file carries the migration twice (as SQL and as the statement row) and the rollback twice", () => {
    const apply = readFileSync(new URL(`../scripts/apply/${FILE}`, import.meta.url), "utf8");
    expect(apply).toContain(`array[$mig$${sql.trimEnd()}\n$mig$]`);
    expect(apply).toContain("begin;\nset local lock_timeout");
    expect(apply.trimEnd().endsWith("commit;")).toBe(true);
    expect(apply).toContain("'20261227000000', 'calibrate_capacity_factors'");
    expect(apply.split("--   delete from supabase_migrations.schema_migrations where version = '20261227000000';")).toHaveLength(3);
    expect(sql).toContain("APPLY BEFORE DEPLOYING THE APP");
  });
});
