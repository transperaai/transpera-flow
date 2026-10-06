import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Saved text carries no pay and no real names (issue #30, B1 2b; migration 20261207700000). Applies every migration before
// this one, seeds the leaks (overtime issues that state money, AI text that names people), applies it, and checks what was
// cleaned and what was left alone, the history and timestamps included.

const MIGRATION = "20261207700000_saved_text_privacy.sql";
const dir = (p: string) => new URL(p, import.meta.url);
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

const SENTENCE = (money: string) =>
  `Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap, costing about ${money} at cost rates over the 26-week run. The cap is used up.`;
const CLEAN = "Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap. The cap is used up.";

let client: pg.Client;
let name: string;
const ws = randomUUID();
const ws2 = randomUUID();
const proc = randomUUID();
const rev = randomUUID();
const role = randomUUID();
const user = randomUUID();
const person = { maya: randomUUID(), annLee: randomUUID(), ann: randomUUID(), al: randomUUID(), rosa: randomUUID() };
const issue = { person: randomUUID(), role: randomUUID(), capacity: randomUUID(), manual: randomUUID() };
const analysis = randomUUID();
const aiFinding = randomUUID();
const handFinding = randomUUID();
const run = randomUUID();
let issuesBefore: Record<string, Record<string, unknown>>;
let triggersBefore: string;
let eventsBefore: number;
let analysisBefore: Record<string, unknown>;
let aiBefore: Record<string, unknown>;
let handBefore: Record<string, unknown>;

const MAYA_FACT = `Maya Collins works 4 h/wk overtime. ${SENTENCE("£1,040")}`;

beforeAll(async () => {
  name = `transpera_flow_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(readFileSync(dir("./sql/auth-shim.sql"), "utf8"));
  await client.query(readFileSync(dir("./sql/storage-shim.sql"), "utf8"));
  // Everything before this migration: the schema as production has it.
  for (const f of readdirSync(dir("../supabase/migrations")).filter((f) => f.endsWith(".sql") && f < MIGRATION).sort()) {
    await client.query(readFileSync(dir(`../supabase/migrations/${f}`), "utf8"));
  }
  await client.query("insert into auth.users (id, email) values ($1, 'ed@example.com')", [user]);
  await client.query("insert into workspaces (id, name, slug) values ($1, 'Old Co', 'old-co'), ($2, 'Other Co', 'other-co')", [ws, ws2]);
  await client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Pipeline')", [proc, ws]);
  await client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [rev, ws, proc]);
  await client.query("update process_revisions set status = 'published' where id = $1", [rev]);
  await client.query("update processes set live_revision_id = $1 where id = $2", [rev, proc]);
  await client.query("insert into roles (id, workspace_id, name) values ($1, $2, 'Strategist')", [role, ws]);
  // Created in this order, so they are people 1 to 4 of Old Co. "Ann" is inside "Ann Lee"; "Al" is too short to match.
  for (const [i, [key, who, w]] of (
    [["maya", "Maya Collins", ws], ["annLee", "Ann Lee", ws], ["ann", "Ann", ws], ["al", "Al", ws], ["rosa", "Rosa Diaz", ws2]] as const
  ).entries()) {
    await client.query("insert into people (id, workspace_id, name, created_at) values ($1, $2, $3, $4)", [person[key], w, who, `2026-01-0${i + 1}T09:00:00Z`]);
  }

  // Issues. The overtime ones state money; so do a capacity issue with the same words and a manual one a person typed.
  const ins = (id: string, f: Record<string, unknown>) => {
    const row = { id, workspace_id: ws, type: "capacity", created_at: "2026-09-01T09:00:00Z", severity: "serious", title: "T", ...f };
    const cols = Object.keys(row);
    return client.query(`insert into issues (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  };
  const metrics = JSON.stringify({ overtime_hours_week: 4, overtime_cost: 1040, utilisation: 1 });
  await ins(issue.person, { source: "promoted", detected_key: `overtime:person:${person.maya}`, title: "Maya Collins works 4 h/wk overtime", evidence: SENTENCE("£1,040"), evidence_metrics: metrics });
  await ins(issue.role, { source: "promoted", detected_key: `overtime:role:${role}`, title: "Strategist works 4 h/wk overtime", evidence: SENTENCE("A$1,040.50"), evidence_metrics: metrics, status: "dismissed" });
  await ins(issue.capacity, { source: "promoted", detected_key: `capacity:person:${person.maya}`, evidence: SENTENCE("£1,040"), evidence_metrics: metrics });
  await ins(issue.manual, { source: "manual", type: "manual", evidence: SENTENCE("£1,040"), evidence_metrics: metrics });
  // A little history, as the app leaves it.
  await client.query("update issues set status = 'in_progress' where id = $1", [issue.person]);

  // An analysis and an AI finding that name people (seeded as a restore would: triggers off).
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  await client.query("insert into ai_runs (id, workspace_id, process_id, trigger, user_id, user_name, started_at) values ($1, $2, $3, 'manual', $4, 'Ed Itor', '2026-09-20T09:00:00Z')", [run, ws, proc, user]);
  await client.query(
    `insert into ai_analyses (id, workspace_id, process_id, revision_id, status, reason, trigger, summary, insights, review, input_hash, run_id, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, 'ok', $5, 'manual', $6, $7, $8, 'h', $9, $10, '2026-09-20T09:00:00Z', '2026-09-20T09:05:00Z')`,
    [
      analysis, ws, proc, rev,
      "Left out: “Maya Collins earns more”",
      JSON.stringify(["Maya Collins works late. Ann Lee covers for Maya Collins.", "Al and Rosa Diaz are fine, and the Annual review is on."]),
      JSON.stringify([{ key: "ai:insight:abc123", type: "capacity", rating: "bad", title: "Maya Collins at the cap", evidence: "Ann Lee can't cover.", why: "y", stepId: null, facts: [{ kind: "fact", key: "overtime:person:x", text: MAYA_FACT }] }]),
      JSON.stringify([{ step: "job", level: "warn", text: "Ann Lee owns the pitch." }]),
      run, user,
    ],
  );
  await client.query(
    `insert into findings (id, workspace_id, process_id, origin, status, rating, type, title, evidence, why, facts, ai_key, analysis_id, run_id, created_by, created_at, updated_at)
     values ($1, $2, $3, 'ai', 'proposed', 'bad', 'capacity', 'Maya Collins is the only one who prices', 'Ann Lee reviews it.', 'Annual cover is thin in March.', $4, 'ai:insight:abc123', $5, $6, $7, '2026-09-20T09:00:00Z', '2026-09-20T09:05:00Z')`,
    [aiFinding, ws, proc, JSON.stringify([{ kind: "fact", key: "overtime:person:x", text: MAYA_FACT }]), analysis, run, user],
  );
  await client.query(
    `insert into findings (id, workspace_id, process_id, origin, status, rating, type, title, evidence, why, created_at, updated_at)
     values ($1, $2, $3, 'manual', 'accepted', 'bad', 'manual', 'Maya Collins pitched alone', 'Maya Collins told us.', '', '2026-09-21T09:00:00Z', '2026-09-21T09:00:00Z')`,
    [handFinding, ws, proc],
  );
  await client.query("commit");

  issuesBefore = Object.fromEntries((await client.query("select * from issues")).rows.map((r) => [r.id, r]));
  eventsBefore = (await client.query("select count(*)::int as n from issue_events")).rows[0].n;
  analysisBefore = (await client.query("select * from ai_analyses where id = $1", [analysis])).rows[0];
  aiBefore = (await client.query("select * from findings where id = $1", [aiFinding])).rows[0];
  handBefore = (await client.query("select * from findings where id = $1", [handFinding])).rows[0];
  triggersBefore = await triggerStates();
  await client.query(readFileSync(dir(`../supabase/migrations/${MIGRATION}`), "utf8"));
}, 120_000);

afterAll(async () => {
  await client?.end();
  const a = new pg.Client({ connectionString: ADMIN_URL });
  await a.connect();
  await a.query(`drop database if exists ${name} with (force)`);
  await a.end();
});

const triggerStates = async () =>
  JSON.stringify(
    (
      await client.query(
        `select tgrelid::regclass::text as t, tgname, tgenabled::text as e from pg_trigger
         where not tgisinternal and tgrelid in ('public.issues'::regclass, 'public.ai_analyses'::regclass, 'public.findings'::regclass) order by 1, 2`,
      )
    ).rows,
  );
const issuesNow = async () => Object.fromEntries((await client.query("select * from issues")).rows.map((r) => [r.id, r]));
const one = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0];

describe("saved overtime issues", () => {
  it("lose the money clause and the overtime_cost metric, for a person and for a role, whatever the currency", async () => {
    const now = await issuesNow();
    for (const id of [issue.person, issue.role]) {
      expect(now[id].evidence, id).toBe(CLEAN);
      expect(now[id].evidence).toMatch(/cap\. The cap is used up\.$/);
      expect(now[id].evidence_metrics, id).toEqual({ overtime_hours_week: 4, utilisation: 1 });
    }
  });

  it("change nothing else: every other column of every issue, updated_at included, is as it was, and the other issues are untouched", async () => {
    const now = await issuesNow();
    for (const id of Object.values(issue)) {
      const { evidence: _e, evidence_metrics: _m, ...before } = issuesBefore[id]!;
      const { evidence: _e2, evidence_metrics: _m2, ...after } = now[id]!;
      expect(after, id).toEqual(before);
    }
    // A detection of another kind with the same words, and a manual issue a person typed, keep everything.
    for (const id of [issue.capacity, issue.manual]) expect(now[id], id).toEqual(issuesBefore[id]);
  });

  it("add no history", async () => {
    expect((await one("select count(*)::int as n from issue_events", [])).n).toBe(eventsBefore);
  });
});

describe("saved AI text", () => {
  it("holds labels where full names were, never 'Maya Collins' or 'Ann Lee', numbered by creation order", async () => {
    const a = await one("select * from ai_analyses where id = $1", [analysis]);
    expect(a.summary).toEqual(["Team member 1 works late. Team member 2 covers for Team member 1.", "Al and Rosa Diaz are fine, and the Annual review is on."]);
    expect(a.review).toEqual([{ step: "job", level: "warn", text: "Team member 2 owns the pitch." }]);
    expect(a.reason).toBe("Left out: “Team member 1 earns more”");
    const [insight] = a.insights;
    expect(insight.title).toBe("Team member 1 at the cap");
    expect(insight.evidence).toBe("Team member 2 can't cover.");
    expect(insight.facts[0].text).toBe(`Team member 1 works 4 h/wk overtime. ${CLEAN}`);
    expect(JSON.stringify([a.summary, a.insights, a.review, a.reason])).not.toMatch(/Maya Collins|Ann Lee|costing about/);
  });

  it("maps exactly those labels to the right ids: 'Ann' inside 'Ann Lee' isn't counted twice, 'Al' and Rosa are left", async () => {
    const a = await one("select person_labels from ai_analyses where id = $1", [analysis]);
    expect(a.person_labels).toEqual({ "Team member 1": person.maya, "Team member 2": person.annLee });
    const f = await one("select * from findings where id = $1", [aiFinding]);
    expect(f.person_labels).toEqual({ "Team member 1": person.maya, "Team member 2": person.annLee });
    expect(f.title).toBe("Team member 1 is the only one who prices");
    expect(f.evidence).toBe("Team member 2 reviews it.");
    // "Ann" inside "Ann Lee" is not counted again (no "Team member 3"), and "Annual" is not "Ann".
    expect(f.why).toBe("Annual cover is thin in March.");
    expect(f.facts).toEqual([{ kind: "fact", key: "overtime:person:x", text: `Team member 1 works 4 h/wk overtime. ${CLEAN}` }]);
  });

  it("leave updated_at, edited, analysis_id, run_id and status as they were", async () => {
    const a = await one("select * from ai_analyses where id = $1", [analysis]);
    for (const k of ["updated_at", "created_at", "run_id", "status", "model_hash", "input_hash", "checked", "dropped", "created_by", "process_id", "revision_id"]) expect(a[k], k).toEqual(analysisBefore[k]);
    const f = await one("select * from findings where id = $1", [aiFinding]);
    for (const k of ["updated_at", "created_at", "edited", "analysis_id", "run_id", "status", "ai_key", "rating", "type", "decided_by", "updated_by"]) expect(f[k], k).toEqual(aiBefore[k]);
  });

  it("leave a finding added by hand alone, with no labels", async () => {
    const h = await one("select * from findings where id = $1", [handFinding]);
    expect({ ...h, person_labels: undefined }).toEqual({ ...handBefore, person_labels: undefined });
    expect(h.person_labels).toEqual({});
    expect(h.title).toBe("Maya Collins pitched alone");
  });
});

describe("the migration", () => {
  it("drops its three helper functions", async () => {
    const r = await one(
      "select to_regprocedure('private.b1_2b_relabel(text, uuid)') as a, to_regprocedure('private.b1_2b_labels(text, uuid)') as b, to_regprocedure('private.b1_2b_people(uuid)') as c",
      [],
    );
    expect(r).toEqual({ a: null, b: null, c: null });
  });

  it("leaves all six triggers enabled, and every trigger of the three tables as it was", async () => {
    expect(await triggerStates()).toBe(triggersBefore);
    const six = await client.query(
      `select tgname, tgenabled::text as e from pg_trigger where not tgisinternal and (tgrelid, tgname) in (
         ('public.issues'::regclass, 'issue_log'), ('public.issues'::regclass, 'set_updated_at'),
         ('public.ai_analyses'::regclass, 'ai_analyses_stamp'), ('public.ai_analyses'::regclass, 'set_updated_at'),
         ('public.findings'::regclass, 'findings_before_write'), ('public.findings'::regclass, 'set_updated_at'))`,
    );
    expect(six.rows).toHaveLength(6);
    expect(six.rows.every((r) => r.e === "O")).toBe(true);
  });

  it("has an apply file that is the migration plus its schema_migrations row, in one transaction", () => {
    const base = new URL("../", import.meta.url);
    const mig = readFileSync(new URL(`supabase/migrations/${MIGRATION}`, base), "utf8").trimEnd();
    const apply = readFileSync(new URL(`scripts/apply/${MIGRATION}`, base), "utf8");
    expect(apply).toContain("\nbegin;\nset local lock_timeout = '5s';");
    expect(apply.split(mig).length - 1).toBe(2);
    expect(apply).toContain("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261207700000', 'saved_text_privacy', array[$mig$" + mig);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
  });

  it("rejects a person_labels that isn't an object", async () => {
    // As the administrator with triggers off, so only the column's own check is in the way.
    for (const [table, id, value] of [["ai_analyses", analysis, "[]"], ["findings", aiFinding, '"x"']] as const) {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await expect(client.query(`update ${table} set person_labels = $2 where id = $1`, [id, value])).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback");
    }
  });

  it("defaults person_labels to an empty object, and runs a second time without changing anything", async () => {
    expect((await one("select person_labels from findings where id = $1", [handFinding])).person_labels).toEqual({});
    // The clean-up is not meant to run twice, but what it matched is gone: its patterns find nothing more in the issues.
    const left = await one("select count(*)::int as n from issues where detected_key like 'overtime:%' and (evidence_metrics ? 'overtime_cost' or evidence ~ ', costing about')", []);
    expect(left.n).toBe(0);
  });

  it("can be put back by the rollback in its header: names return, deleted people read 'A team member'", async () => {
    const header = readFileSync(dir(`../supabase/migrations/${MIGRATION}`), "utf8");
    // The ROLLBACK block of the header, uncommented.
    const block = header.split("-- ROLLBACK")[1]!.split("\n").slice(1).filter((l) => l.startsWith("--   ")).map((l) => l.replace(/^--   /, "")).join("\n");
    const sql = block.replace(/^begin;/m, "").replace(/^commit;/m, "");
    await client.query("delete from people where id = $1", [person.annLee]);
    // The ledger the rollback's last line writes to (Supabase has it; the plain database does not).
    await client.query("create schema supabase_migrations");
    await client.query("create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
    await client.query("insert into supabase_migrations.schema_migrations (version, name) values ('20261207700000', 'saved_text_privacy')");
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    const a = await one("select * from ai_analyses where id = $1", [analysis]);
    expect(a.summary[0]).toBe("Maya Collins works late. A team member covers for Maya Collins.");
    const f = await one("select * from findings where id = $1", [aiFinding]);
    expect(f.title).toBe("Maya Collins is the only one who prices");
    expect(f.evidence).toBe("A team member reviews it.");
    const cols = await one("select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name in ('ai_analyses', 'findings') and column_name = 'person_labels'", []);
    expect(cols.n).toBe(0);
    expect((await one("select to_regprocedure('private.b1_2b_unlabel(text, jsonb, boolean)') as f", [])).f).toBeNull();
    expect(await triggerStates()).toBe(triggersBefore);
    expect((await one("select count(*)::int as n from supabase_migrations.schema_migrations", [])).n).toBe(0);
  });
});
