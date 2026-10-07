import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, larkspurPersonIds, northbeamIssues } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Share links (issue #32, B3): the table, its write trigger, the leak check Postgres runs on every snapshot, the team-input
// function and the one function a visitor reads through. Each test runs in a rolled-back transaction.

const ws = NORTHBEAM_WORKSPACE_ID;
const other = LARKSPUR_WORKSPACE_ID;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (n: string) => n.padEnd(43, "x").slice(0, 43);

type Json = Record<string, unknown>;
const clean = (kind = "overview", people = false, financials = false): Json => ({ v: 1, kind, toggles: { people, financials } });

type Claims = Record<string, unknown>;
interface Caller {
  id: string;
  claims: Claims;
}
let db: TestDb;
const who: Record<string, Caller> = {};
let personName = "";
let personFirst = "";
let multiWordClient = "";
let solutionId = "";
let issueId = "";

interface Made {
  kind?: string;
  target?: string | null;
  people?: boolean;
  financials?: boolean;
  emails?: string[];
  expires?: string | null;
  label?: string | null;
  snapshot?: Json;
  workspace?: string;
  tok?: string;
  mode?: string;
}

const INSERT =
  "insert into share_links (workspace_id, token_hash, kind, target_id, show_people, show_financials, allowed_emails, expires_at, label, snapshot, engine_version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '1.8.0') returning id";

/** The in-the-future expiry used when a test doesn't care. */
const future = () => new Date(Date.now() + 7 * 86400_000).toISOString();

async function insertLink(c: pg.Client, m: Made = {}) {
  const kind = m.kind ?? "overview";
  const restricted = m.people || m.financials;
  return c.query(INSERT, [
    m.workspace ?? ws,
    sha(m.tok ?? token("default")),
    kind,
    m.target === undefined ? (kind === "overview" ? null : null) : m.target,
    m.people ?? false,
    m.financials ?? false,
    m.emails ?? (restricted ? ["a@x.example"] : []),
    m.expires === undefined ? (restricted ? future() : null) : m.expires,
    m.label ?? null,
    JSON.stringify(m.snapshot ?? clean(kind, m.people ?? false, m.financials ?? false)),
  ]);
}

interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  constraint?: string;
  rows?: pg.QueryResult["rows"];
}
/** Run `fn` inside a savepoint; report the database's refusal instead of throwing. */
async function attempt(c: pg.Client, fn: () => Promise<pg.QueryResult>): Promise<Outcome> {
  await c.query("savepoint attempt");
  try {
    const r = await fn();
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query("rollback to savepoint attempt");
    const err = e as { code?: string; message: string; constraint?: string };
    return { ok: false, code: err.code, message: err.message, constraint: err.constraint };
  }
}
const make = (c: pg.Client, m: Made = {}) => attempt(c, () => insertLink(c, m));

const asEditor = <T>(fn: (c: pg.Client) => Promise<T>) => db.as(who.editor!.claims, fn);

/** Run `fn` as the anon role, after `setup` ran as the superuser in the same rolled-back transaction. */
async function asAnon<T>(setup: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await setup(db.client);
    await db.client.query("set local role anon");
    await db.client.query("select set_config('request.jwt.claims', '', true)");
    return await fn(db.client);
  } finally {
    await db.client.query("rollback");
  }
}
const open = async (c: pg.Client, tok: string) => (await c.query("select public.open_share_link($1) as r", [tok])).rows[0].r as Json | null;

beforeAll(async () => {
  // As a Supabase project: new tables are granted to anon and authenticated by default, which the migration must take back.
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const member = async (email: string, role: string) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, u.id, role]);
    return u;
  };
  who.owner = await member("owner@share.example", "owner");
  who.editor = await member("editor@share.example", "editor");
  who.member = await member("member@share.example", "member");
  who.viewer = await member("viewer@share.example", "viewer");
  who.stranger = await createUser(db, "stranger@share.example");
  who.admin = await createUser(db, "admin@share.example", { agency_admin: true });
  // An editor of Larkspur only (a different workspace).
  who.otherEditor = await createUser(db, "other-editor@share.example");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [other, who.otherEditor.id]);

  personName = (await db.client.query("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws])).rows[0].name;
  personFirst = personName.split(" ")[0]!;
  const clients = (await db.client.query("select name from clients where workspace_id = $1 and char_length(btrim(name)) >= 3 order by name", [ws])).rows.map((r) => r.name as string);
  multiWordClient = clients.find((n) => /\s/.test(n.trim()) && /^[A-Za-z ]+$/.test(n))!;
  issueId = northbeamIssues()[0]!.id;
  solutionId = (
    await db.client.query(
      "insert into solutions (workspace_id, process_id, base_revision_id, name, steps) select $1, id, live_revision_id, 'Share test', $2::jsonb from processes where id = $3 returning id",
      [ws, JSON.stringify({ steps: [], edges: [], entry_step_id: null }), NORTHBEAM_PROCESS_ID],
    )
  ).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("restricted links (PRD §9, D12)", () => {
  it("both toggles off with no emails and no expiry is fine", async () => {
    await asEditor(async (c) => expect((await make(c)).ok).toBe(true));
  });

  for (const toggle of ["people", "financials"] as const) {
    it(`${toggle} on with no emails: share_links_restricted (23514); with emails and no expiry: the same; with both: ok`, async () => {
      await asEditor(async (c) => {
        const noEmails = await make(c, { [toggle]: true, emails: [], expires: future() });
        expect(noEmails).toMatchObject({ ok: false, code: "23514", constraint: "share_links_restricted" });
        const noExpiry = await make(c, { [toggle]: true, emails: ["a@x.example"], expires: null });
        expect(noExpiry).toMatchObject({ ok: false, code: "23514", constraint: "share_links_restricted" });
        expect((await make(c, { [toggle]: true, emails: ["a@x.example"], expires: future() })).ok).toBe(true);
      });
    });
  }

  it("allowed emails: upper case, bad format, duplicates and more than 50 are refused", async () => {
    await asEditor(async (c) => {
      for (const emails of [["Sam@X.example"], ["not-an-email"], ["a@x.example", "a@x.example"], ["a b@x.example"], [" a@x.example"]]) {
        expect(await make(c, { emails }), JSON.stringify(emails)).toMatchObject({ ok: false, code: "23514", constraint: "share_links_emails" });
      }
      const fifty = Array.from({ length: 50 }, (_, i) => `p${i}@x.example`);
      expect((await make(c, { emails: fifty })).ok).toBe(true);
      expect(await make(c, { emails: [...fifty, "p50@x.example"], tok: token("b") })).toMatchObject({ ok: false, constraint: "share_links_emails" });
    });
  });

  it("other column rules: target, kind, token hash, label and engine version", async () => {
    await asEditor(async (c) => {
      expect(await make(c, { kind: "overview", target: solutionId })).toMatchObject({ ok: false, constraint: "share_links_target" });
      // The trigger answers before the check constraint does.
      expect(await make(c, { kind: "solution", target: null })).toMatchObject({ ok: false, code: "22023" });
      expect(await make(c, { kind: "page" })).toMatchObject({ ok: false, code: "22023" });
      expect(await make(c, { label: "   " })).toMatchObject({ ok: false, constraint: "share_links_label" });
      expect(await make(c, { label: "x".repeat(121) })).toMatchObject({ ok: false, constraint: "share_links_label" });
      expect(await attempt(c, () => c.query(INSERT.replace("'1.8.0'", "''"), [ws, sha("e"), "overview", null, false, false, [], null, null, JSON.stringify(clean())]))).toMatchObject({
        ok: false,
        constraint: "share_links_engine_version",
      });
      expect(await attempt(c, () => c.query(INSERT, [ws, "ABC", "overview", null, false, false, [], null, null, JSON.stringify(clean())]))).toMatchObject({ ok: false, constraint: "share_links_token_hash" });
    });
  });

  it("a duplicate token hash is refused", async () => {
    await asEditor(async (c) => {
      expect((await make(c, { tok: "dup" })).ok).toBe(true);
      expect(await make(c, { tok: "dup" })).toMatchObject({ ok: false, code: "23505" });
    });
  });
});

describe("the write trigger", () => {
  it("stamps the caller and the counters, whatever the caller sends", async () => {
    await asEditor(async (c) => {
      // The column grants stop the caller sending these at all.
      const forged = await attempt(c, () =>
        c.query("insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version, created_by) values ($1, $2, 'overview', $3::jsonb, '1', $4)", [ws, sha("f"), JSON.stringify(clean()), who.owner!.id]),
      );
      expect(forged).toMatchObject({ ok: false, code: "42501" });
      const id = (await insertLink(c, { tok: "stamp" })).rows[0].id;
      const row = (await c.query("select created_by, opens, last_opened_at, revoked_at, revoked_by, mode from share_links where id = $1", [id])).rows[0];
      expect(row).toEqual({ created_by: who.editor!.id, opens: 0, last_opened_at: null, revoked_at: null, revoked_by: null, mode: "view" });
    });
  });

  it("created_by is stamped even when a definer path forges it", async () => {
    const r = await db.client.query(
      "insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version, created_by, opens, revoked_at) values ($1, $2, 'overview', $3::jsonb, '1', $4, 9, now()) returning created_by, opens, revoked_at",
      [ws, sha("forge"), JSON.stringify(clean()), who.owner!.id],
    );
    // auth.uid() is null for the superuser: the stamp replaces the forged value.
    expect(r.rows[0]).toEqual({ created_by: null, opens: 0, revoked_at: null });
    await db.client.query("delete from share_links where token_hash = $1", [sha("forge")]);
  });

  it("a play link for the Overview is refused (22023; B4 allows play links for a process only), as is an expiry in the past", async () => {
    await db.client.query("begin");
    try {
      const play = await attempt(db.client, () =>
        db.client.query("insert into share_links (workspace_id, token_hash, kind, mode, snapshot, engine_version) values ($1, $2, 'overview', 'play', $3::jsonb, '1')", [ws, sha("p"), JSON.stringify(clean())]),
      );
      expect(play).toMatchObject({ ok: false, code: "22023", message: "Only a process can be shared for trying changes." });
    } finally {
      await db.client.query("rollback");
    }
    await asEditor(async (c) => {
      const past = await make(c, { expires: new Date(Date.now() - 1000).toISOString() });
      expect(past).toMatchObject({ ok: false, code: "22023" });
    });
  });

  it("the target must belong to the workspace: a process, an issue and a solution of another workspace are refused (22023)", async () => {
    const otherIds = {
      process: (await db.client.query("select id from processes where workspace_id = $1 limit 1", [other])).rows[0].id,
      issue: (await db.client.query("select id from issues where workspace_id = $1 limit 1", [other])).rows[0]?.id ?? randomUUID(),
      solution: randomUUID(),
    };
    await asEditor(async (c) => {
      for (const kind of ["process", "issue", "solution"] as const) {
        const r = await make(c, { kind, target: otherIds[kind] });
        expect(r, kind).toMatchObject({ ok: false, code: "22023", message: "That isn't in this workspace." });
      }
      // And the same ids are fine where they belong.
      expect((await make(c, { kind: "process", target: NORTHBEAM_PROCESS_ID, tok: "p" })).ok).toBe(true);
      expect((await make(c, { kind: "issue", target: issueId, tok: "i" })).ok).toBe(true);
      expect((await make(c, { kind: "solution", target: solutionId, tok: "s" })).ok).toBe(true);
    });
  });

  it("an issue or a solution of an archived process is refused too (22023)", async () => {
    await db.client.query("begin");
    try {
      const archived = (await db.client.query("select id from processes where workspace_id = $1 and live_revision_id is not null and not is_company and id <> $2 order by id desc limit 1", [ws, NORTHBEAM_PROCESS_ID])).rows[0].id as string;
      const issue = (await db.client.query("insert into issues (workspace_id, process_id, type, title) values ($1, $2, 'bottleneck', 'On an old process') returning id", [ws, archived])).rows[0].id;
      const linked = (await db.client.query("insert into issues (workspace_id, type, title) values ($1, 'bottleneck', 'Linked to an old process') returning id", [ws])).rows[0].id;
      await db.client.query("insert into issue_links (workspace_id, issue_id, process_id) values ($1, $2, $3)", [ws, linked, archived]);
      const solution = (await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) select workspace_id, id, live_revision_id, 'Old idea', $2::jsonb from processes where id = $1 returning id", [archived, JSON.stringify({ steps: [], edges: [], entry_step_id: null })])).rows[0].id;
      // Archived by the superuser with the guards off (the real one refuses while a service enters it); the link trigger runs as usual.
      await db.client.query("set local session_replication_role = replica");
      await db.client.query("update processes set archived_at = now() where id = $1", [archived]);
      await db.client.query("set local session_replication_role = origin");
      for (const [kind, target] of [["issue", issue], ["issue", linked], ["solution", solution]] as const) {
        const r = await attempt(db.client, () => insertLink(db.client, { kind, target }));
        expect(r, `${kind} ${target}`).toMatchObject({ ok: false, code: "22023", message: "An archived process can't be shared. Restore it first." });
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("an unpublished, an archived and the company map process are refused (22023)", async () => {
    await db.client.query("begin");
    try {
      const fresh = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'No version yet') returning id", [ws])).rows[0].id;
      const archived = (await db.client.query("insert into processes (workspace_id, name, live_revision_id) select workspace_id, 'Old', live_revision_id from processes where id = $1 returning id", [NORTHBEAM_PROCESS_ID])).rows[0].id;
      await db.client.query("update processes set archived_at = now() where id = $1", [archived]);
      const company = (await db.client.query("select id from processes where workspace_id = $1 and is_company", [ws])).rows[0]?.id as string | undefined;
      const ids = company ? [fresh, archived, company] : [fresh, archived];
      for (const id of ids) {
        const r = await attempt(db.client, () => insertLink(db.client, { kind: "process", target: id }));
        expect(r, id).toMatchObject({ ok: false, code: "22023" });
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("API-token requests may not insert or change a link (42501)", async () => {
    const api = { ...who.editor!.claims, api_token_id: randomUUID() };
    await db.as(api, async (c) => {
      expect(await make(c)).toMatchObject({ ok: false, code: "42501", message: "Share links are made in the app." });
    });
    // An update is refused too.
    await db.client.query("insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version) values ($1, $2, 'overview', $3::jsonb, '1')", [ws, sha("api"), JSON.stringify(clean())]);
    await db.as(api, async (c) => {
      const r = await attempt(c, () => c.query("update share_links set label = 'x' where token_hash = $1", [sha("api")]));
      expect(r).toMatchObject({ ok: false, code: "42501" });
    });
    await db.client.query("delete from share_links where token_hash = $1", [sha("api")]);
  });

  it("revoking stamps revoked_at and revoked_by; un-revoking and any later update are refused", async () => {
    await asEditor(async (c) => {
      const id = (await insertLink(c, { tok: "rev" })).rows[0].id;
      // The caller can't pick the time: a far-future value becomes now().
      await c.query("update share_links set revoked_at = '2099-01-01' where id = $1", [id]);
      const row = (await c.query("select revoked_at < now() + interval '1 minute' as soon, revoked_by from share_links where id = $1", [id])).rows[0];
      expect(row).toEqual({ soon: true, revoked_by: who.editor!.id });
      expect(await attempt(c, () => c.query("update share_links set revoked_at = null where id = $1", [id]))).toMatchObject({ ok: false, code: "22023" });
      expect(await attempt(c, () => c.query("update share_links set label = 'again' where id = $1", [id]))).toMatchObject({ ok: false, code: "22023", message: "This link was turned off." });
      expect(await attempt(c, () => c.query("update share_links set snapshot = $2::jsonb where id = $1", [id, JSON.stringify(clean())]))).toMatchObject({ ok: false, code: "22023" });
    });
  });

  it("guarded columns can't change, even from a definer path", async () => {
    await db.client.query("begin");
    try {
      const id = (await insertLink(db.client, { tok: "guard" })).rows[0].id;
      const sets = [
        ["workspace_id = $2", other],
        ["token_hash = $2", sha("other")],
        ["kind = 'process'", undefined],
        ["target_id = $2", NORTHBEAM_PROCESS_ID],
        ["show_people = true", undefined],
        ["show_financials = true", undefined],
        ["allowed_emails = array['q@x.example']", undefined],
        ["expires_at = now() + interval '1 day'", undefined],
        ["created_at = now() - interval '1 day'", undefined],
        ["created_by = $2", who.owner!.id],
        ["mode = 'play'", undefined],
      ] as const;
      for (const [set, param] of sets) {
        const r = await attempt(db.client, () => db.client.query(`update share_links set ${set} where id = $1`, param === undefined ? [id] : [id, param]));
        expect(r, set).toMatchObject({ ok: false, code: "22023" });
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("replacing the snapshot stamps snapshot_at and runs the leak check again", async () => {
    await asEditor(async (c) => {
      const id = (await insertLink(c, { tok: "refresh" })).rows[0].id;
      const before = (await c.query("select snapshot_at from share_links where id = $1", [id])).rows[0].snapshot_at as Date;
      await c.query("select pg_sleep(0.01)");
      await c.query("update share_links set snapshot = $2::jsonb, engine_version = '1.9.0' where id = $1", [id, JSON.stringify({ ...clean(), extra: 1 })]);
      // now() is the transaction's start, so compare against the stamped value rather than a later clock.
      const after = (await c.query("select snapshot_at, engine_version from share_links where id = $1", [id])).rows[0];
      expect(after.engine_version).toBe("1.9.0");
      expect(after.snapshot_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      const leaky = await attempt(c, () => c.query("update share_links set snapshot = $2::jsonb where id = $1", [id, JSON.stringify({ ...clean(), note: `Ask ${personName}` })]));
      expect(leaky).toMatchObject({ ok: false, code: "23514", message: "The snapshot names a person." });
    });
  });

  it("deleting the user who made or turned off a link doesn't fail (the foreign key nulls created_by and revoked_by)", async () => {
    const u = await createUser(db, "leaver@share.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, u.id]);
    await db.as(u.claims, async (c) => {
      const id = (await insertLink(c, { tok: "leaver" })).rows[0].id;
      await c.query("update share_links set revoked_at = now() where id = $1", [id]);
    });
    // db.as rolls back; do it for real as the superuser.
    await db.client.query("insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version, revoked_at) values ($1, $2, 'overview', $3::jsonb, '1', null)", [ws, sha("leaver2"), JSON.stringify(clean())]);
    await db.client.query("update share_links set revoked_at = now(), revoked_by = $2 where token_hash = $1", [sha("leaver2"), u.id]).catch(() => undefined);
    await db.client.query("delete from memberships where user_id = $1", [u.id]);
    await db.client.query("delete from auth.users where id = $1", [u.id]);
    const row = (await db.client.query("select revoked_at is not null as revoked, revoked_by from share_links where token_hash = $1", [sha("leaver2")])).rows[0];
    expect(row).toEqual({ revoked: true, revoked_by: null });
    await db.client.query("delete from share_links where token_hash = $1", [sha("leaver2")]);
  });
});

describe("the leak check", () => {
  const refused = async (snapshot: Json, over: Made, message: string) => {
    await asEditor(async (c) => {
      const r = await make(c, { snapshot, ...over });
      expect(r).toMatchObject({ ok: false, code: "23514", message });
      // The message names what leaked, never the value.
      expect(r.message).not.toMatch(/@|Brooks|Okafor/);
      expect(r.message).not.toContain(personName);
      expect(r.message).not.toContain(multiWordClient);
    });
  };
  const accepted = async (snapshot: Json, over: Made = {}) => asEditor(async (c) => expect(await make(c, { snapshot, ...over })).toMatchObject({ ok: true }));
  const both = { people: true, financials: true };

  it("1. the snapshot must match the link: version, kind and both toggles", async () => {
    const msg = "The snapshot doesn't match the link.";
    await refused({ ...clean(), v: 2 }, {}, msg);
    await refused({ ...clean("process") }, { kind: "overview" }, msg);
    await refused(clean("overview", true, false), {}, msg);
    await refused(clean("overview", false, true), {}, msg);
    await refused(clean("overview", false, false), both, msg);
    await refused({ v: 1, kind: "overview" }, {}, msg);
    await refused({ v: 1, kind: "overview", toggles: { people: "false", financials: false } }, {}, msg);
    await asEditor(async (c) => {
      const r = await attempt(c, () => c.query(INSERT, [ws, sha("arr"), "overview", null, false, false, [], null, null, "[]"]));
      expect(r).toMatchObject({ ok: false, code: "23514", message: msg });
    });
  });

  it("2. an email address, anywhere, even with both toggles on", async () => {
    await refused({ ...clean(), note: "write to sam@northbeam.example" }, {}, "The snapshot contains an email address.");
    await refused({ ...clean("overview", true, true), deep: { a: [{ b: "SAM@NORTHBEAM.EXAMPLE" }] } }, both, "The snapshot contains an email address.");
    await accepted({ ...clean(), note: "meet @ 5, then 3.5 later" });
  });

  it("3. a non-null cost_rate at any depth, even with both toggles on", async () => {
    await refused({ ...clean(), people: [{ cost_rate: 40 }] }, {}, "The snapshot contains a person's pay.");
    await refused({ ...clean("overview", true, true), a: { b: [{ c: { cost_rate: 0 } }] } }, both, "The snapshot contains a person's pay.");
    await accepted({ ...clean("overview", true, true), people: [{ cost_rate: null }] }, both);
  });

  it("4. a non-empty provenance anywhere; an empty one is fine", async () => {
    await refused({ ...clean(), a: [{ provenance: { source: "interview" } }] }, {}, "The snapshot contains evidence notes.");
    await refused({ ...clean(), provenance: { x: 1 } }, {}, "The snapshot contains evidence notes.");
    await accepted({ ...clean(), a: [{ provenance: {} }] });
  });

  it("5. a client's name, always, any case and any white space; the word inside another is fine", async () => {
    const msg = "The snapshot names a client.";
    await refused({ ...clean(), note: `Churn risk at ${multiWordClient}.` }, {}, msg);
    await refused({ ...clean("overview", true, true), note: `Churn risk at ${multiWordClient}.` }, both, msg);
    await refused({ ...clean("overview", true, true), arr: [{ name: multiWordClient }] }, both, msg);
    await refused({ ...clean(), note: `x ${multiWordClient.toUpperCase()}` }, {}, msg);
    await refused({ ...clean(), note: `first line\n${multiWordClient}` }, {}, msg);
    // White space between the words: a no-break space (pasted from a document), two spaces, a line break.
    const words = multiWordClient.split(" ");
    for (const gap of ["\u00a0", "  ", "\n", " \u200b "]) await refused({ ...clean(), note: `at ${words.join(gap)}` }, {}, msg);
    // A one-word client ("Blue") is matched in any case, so the word is refused; inside another word it is fine.
    await db.client.query("begin");
    try {
      await db.client.query("insert into clients (workspace_id, name) values ($1, 'Blue')", [ws]);
      const tryNote = (note: string) => attempt(db.client, () => insertLink(db.client, { snapshot: { ...clean(), note }, tok: randomUUID() }));
      expect(await tryNote("Churn risk at Blue.")).toMatchObject({ ok: false, code: "23514", message: msg });
      expect(await tryNote("line one\nBlue")).toMatchObject({ ok: false, message: msg });
      expect(await tryNote("the blue sky")).toMatchObject({ ok: false, message: msg });
      expect(await tryNote("BLUE")).toMatchObject({ ok: false, message: msg });
      expect((await tryNote("Bluebird and xBlue")).ok).toBe(true);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("6. a person's full name with People off (any case, any white space), their surname on its own, allowed with People on", async () => {
    const msg = "The snapshot names a person.";
    await refused({ ...clean(), note: `Ask ${personName}` }, {}, msg);
    await refused({ ...clean(), note: `ask ${personName.toUpperCase()}` }, {}, msg);
    await refused({ ...clean(), note: `Ask\n${personName}` }, {}, msg);
    await refused({ ...clean(), a: { name: personName } }, { financials: false }, msg);
    const words = personName.split(" ");
    for (const gap of ["\u00a0", "  ", "\n", "\t", " \u200b "]) await refused({ ...clean(), note: `Ask ${words.join(gap)}` }, {}, msg);
    // A control character before the name: jsonb writes it as \u001f, so the character before the name is the letter f.
    await refused({ ...clean(), note: `x\u001f${personName}` }, {}, msg);
    // The surname alone (3+ letters), in any case.
    await refused({ ...clean(), note: `${words[words.length - 1]} is slow` }, {}, msg);
    await refused({ ...clean(), note: `${words[words.length - 1]!.toUpperCase()} is slow` }, {}, msg);
    // The first name alone too (3+ letters): any part of a name is a token.
    await refused({ ...clean(), note: `Ask ${personFirst}` }, {}, msg);
    await refused({ ...clean(), note: `ask ${personFirst.toLowerCase()}` }, {}, msg);
    await accepted({ ...clean("overview", true, false), note: `Ask ${personName}` }, { people: true });
  });

  it("6b. one-word person names match in any case; names shorter than 3 characters aren't checked; regex characters in a name are literal", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'Cher'), ($1, 'Li'), ($1, 'A.B (x)')", [ws]);
      const msg = "The snapshot names a person.";
      const tryNote = (note: string, over: Made = {}) => attempt(db.client, () => insertLink(db.client, { snapshot: { ...clean(), note }, tok: randomUUID(), ...over }));
      expect(await tryNote("see Cher today")).toMatchObject({ ok: false, message: msg });
      expect(await tryNote("see cher today")).toMatchObject({ ok: false, message: msg });
      expect((await tryNote("Li is here")).ok).toBe(true);
      // Parts under 3 characters are no tokens; the joined "abx" is.
      expect((await tryNote("see A.B (x) now")).ok).toBe(true);
      expect(await tryNote("see ABX now")).toMatchObject({ ok: false, message: msg });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("7. costs, margins and overhead with Financials off; allowed with it on", async () => {
    const msg = "The snapshot contains costs or margins.";
    await refused({ ...clean(), roles: [{ default_cost_rate: 50 }] }, {}, msg);
    await refused({ ...clean(), services: [{ margin: 0.3 }] }, {}, msg);
    await refused({ ...clean(), settings: { overhead_monthly: 0 } }, {}, msg);
    await refused({ ...clean(), settings: { target_margin: 0.2 } }, {}, msg);
    await accepted({ ...clean(), roles: [{ default_cost_rate: 0 }], services: [{ margin: 0 }], settings: {} });
    await accepted(
      { ...clean("overview", false, true), roles: [{ default_cost_rate: 50 }], services: [{ margin: 0.3 }], settings: { overhead_monthly: 9000, target_margin: 0.2 } },
      { financials: true },
    );
  });

  it("7b. Financials off: numbers stored as strings, role-rate patches in scenarios and lever changes, and money in text, are refused", async () => {
    const msg = "The snapshot contains costs or margins.";
    await refused({ ...clean(), services: [{ margin: "0.4" }] }, {}, msg);
    await refused({ ...clean(), roles: [{ default_cost_rate: "95" }] }, {}, msg);
    await refused({ ...clean(), scenarios: [{ patch: [{ path: "roles.r1.cost_rate", op: "set", value: 95 }] }] }, {}, msg);
    await refused({ ...clean(), solutions: { solutions: [{ lever_changes: [{ path: "roles.r1.cost_rate", op: "set", value: 95 }] }] } }, {}, msg);
    for (const text of ["costs £4,100 a month", "about $ 5k", "4,100 GBP", "GBP 4,100", "4.1k pounds", "EUR 40", "40 euros", "4,512€"]) await refused({ ...clean(), note: text }, {}, msg);
    // Other patches, and the same things with Financials on, are fine.
    await accepted({ ...clean(), scenarios: [{ patch: [{ path: "steps.s1.work_hours", op: "set", value: 2 }] }], note: "12 hours a week, 3 pages of notes" });
    await accepted({ ...clean("overview", false, true), scenarios: [{ patch: [{ path: "roles.r1.cost_rate", op: "set", value: 95 }] }], services: [{ margin: "0.4" }], note: "£4,100" }, { financials: true });
  });

  it("6c. text is checked on its normalised form: a soft hyphen, a zero-width space, a full-width letter, a curly apostrophe, a JSON escape", async () => {
    const msg = "The snapshot names a person.";
    const [first, ...rest] = personName.split(" ");
    const surname = rest[rest.length - 1]!;
    const fullwidth = (s: string) => s.replace(/[A-Za-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    await refused({ ...clean(), note: `${first}­ ${surname}` }, {}, msg);
    await refused({ ...clean(), note: `${first} ${surname.slice(0, 2)}­${surname.slice(2)}` }, {}, msg);
    await refused({ ...clean(), note: `${first}​${surname}` }, {}, msg);
    await refused({ ...clean(), note: `${first} ${surname}` }, {}, msg);
    await refused({ ...clean(), note: `${fullwidth(first!)} ${surname}` }, {}, msg);
    await refused({ ...clean(), note: `${first}\\n${surname}` }, {}, msg);
    await refused({ ...clean(), note: `x\\n${surname} said` }, {}, msg);
    // JSON keys are never text.
    await accepted({ ...clean(), liveRevisions: { [`${first} ${surname}`]: "r1" } });
    // A name with a curly apostrophe is found when the text has a straight one, and the other way round.
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, $2)", [ws, "Ann O’Neil"]);
      const tryNote = (note: string) => attempt(db.client, () => insertLink(db.client, { snapshot: { ...clean(), note }, tok: randomUUID() }));
      expect(await tryNote("Ann O'Neil said")).toMatchObject({ ok: false, message: msg });
      expect(await tryNote("Ann O’Neil said")).toMatchObject({ ok: false, message: msg });
      expect(await tryNote("Ann O‘Neil said")).toMatchObject({ ok: false, message: msg });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("6d. the third review: a name token left in any shape (hyphen, dot, underscore, plus, bracket, %20, invisible characters, next to a label or not) is refused", async () => {
    const msg = "The snapshot names a person.";
    const [first, ...rest] = personName.split(" ");
    const surname = rest[rest.length - 1]!;
    const lf = first!.toLowerCase();
    const ls = surname.toLowerCase();
    for (const note of [
      `Team member 1 ${surname}`, `${first} Team member 1`, `${surname.toUpperCase()} Team member 12`, `Team member 3 ${lf}`,
      `${lf}-Team member 1`, `@${lf}.`, `${lf}_`, `${lf}+`, `${lf} (Team member 1)`, `%20${lf}`, `${lf}%20${ls}`,
      `linkedin.com/in/${lf}-${ls}`, `@${lf}.${ls} on Slack`, `${lf}_${ls}`, `${lf}+${ls}`, `${first!.toUpperCase()}-${surname.toUpperCase()}`,
      `${lf}.${ls}@northbeam`, `/${first}%20${surname}%20contract.pdf`,
      `${first} ${surname.slice(0, 2)}\u034f${surname.slice(2)}`, `${first} ${surname.slice(0, 2)}\ufe00${surname.slice(2)}`, `${lf}\u3164${ls}`, `${lf}\u034f`, `${lf}\ufe00`, `${lf}\u3164`,
      `${first} ${surname.slice(0, 2)}\u0301${surname.slice(2)}`,
    ]) {
      await refused({ ...clean(), note }, {}, msg);
    }
    // The same shapes under keys that are no text (a path, an op) are left alone: an id, an enum or a selector the engine reads, never a name.
    await accepted({ ...clean(), path: `steps.${lf}.${ls}`, op: lf });
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'Zed Quill')", [ws]);
      for (const note of ["Team member 4 Zed", "Quill Team member 4", "zed-quill", "ZedQuill", "zed\u3164quill"]) {
        expect(await attempt(db.client, () => insertLink(db.client, { snapshot: { ...clean(), note }, tok: randomUUID() })), note).toMatchObject({ ok: false, code: "23514", message: msg });
      }
    } finally {
      await db.client.query("rollback");
    }
    await accepted({ ...clean(), note: "Team member 1 and Team member 2" });
  });

  it("6e. people whose names are also field names: Tom Price, Jo Weeks, Ann Kind, Lee Retainer don't break the shape, and are still hidden in text", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'Tom Price'), ($1, 'Jo Weeks'), ($1, 'Ann Kind'), ($1, 'Lee Retainer'), ($1, 'Sarah Day')", [ws]);
      const shape = (base: object) => ({
        ...base,
        services: [{ price: 3500, pricing_model: "retainer", name: "Standard" }],
        settings: { horizon_weeks: 12, retainer: 900 },
        process: { kind: "process" },
        steps: [{ kind: "task", lost_per_day_waiting: 0.1 }],
        scenarios: [{ patch: [{ path: "services.s1.price", op: "set", value: 4000 }] }],
      });
      const tryIt = (snapshot: object, over: Made = {}) => attempt(db.client, () => insertLink(db.client, { snapshot: snapshot as Json, tok: randomUUID(), ...over }));
      expect((await tryIt(shape(clean("overview", false, true)), { financials: true })).ok).toBe(true);
      const off = shape(clean());
      // Financials off refuses money in text, not a number under `price`.
      expect((await tryIt(off)).ok).toBe(true);
      expect(await tryIt({ ...off, note: "Tom Price is away" })).toMatchObject({ ok: false, message: "The snapshot names a person." });
      expect(await tryIt({ ...off, note: "the price is right" })).toMatchObject({ ok: false, message: "The snapshot names a person." });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("6f. the fourth round: ids are never money, an email or a name; 10,000 random uuids and some hashes pass with Financials off", async () => {
    const ids: string[] = Array.from({ length: 10_000 }, () => randomUUID());
    ids.push("0184c93c-120f-4cad-9a3c-5d3e1b2c199c", "00000000-0000-4000-8000-1b2c199cad1a", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    await accepted({ ...clean(), ids, paths: ids.slice(0, 50).map((i) => `steps.${i}.work_hours`), model_hash: ids[ids.length - 1] });
    // A code glued to a digit inside something longer is no money; a standalone one is.
    await accepted({ ...clean(), note: "order 123cad456 and ref 5cadx and v4cad" });
    await refused({ ...clean(), note: "it costs 5 CAD" }, {}, "The snapshot contains costs or margins.");
  });

  it("6g. first-principles keys (job.who, job.situation, why.chain, why.root and the rest) are free text", async () => {
    const msg = "The snapshot names a person.";
    const fp = (over: object) => ({ ...clean(), firstPrinciples: { job: { who: "", progress: "", situation: "", done: "" }, statements: [], requirements: [], deletes: [], improvements: [], why: { problem: "", chain: [""], root: "" }, measures: [], ...over } });
    await refused(fp({ job: { who: `${personName}, our account lead`, progress: "", situation: "", done: "" } }), {}, msg);
    await refused(fp({ job: { who: "", progress: `${personFirst} gets the brief`, situation: "", done: "" } }), {}, msg);
    await refused(fp({ why: { problem: "", chain: ["Because ", `${personName} is away`], root: "" } }), {}, msg);
    await refused(fp({ why: { problem: "", chain: [""], root: `${personName} owns everything` } }), {}, msg);
    await refused(fp({ requirements: [{ text: "x", owner_text: `${personName}, finance director`, why: "", verdict: "keep" }] }), {}, msg);
    await refused(fp({ quote: personName }), {}, msg);
    await refused(fp({ job: { who: "", progress: "", situation: `When ${multiWordClient} calls`, done: "" } }), {}, "The snapshot names a client.");
    await accepted(fp({ statements: [{ text: "Approve", kind: "truth", linked_parameter: "step.abc.work_hours" }] }));
  });

  it("6h. a client is matched by the whole of its name, never by one of its words; a person by any part", async () => {
    const words = multiWordClient.split(" ").filter((w) => w.length >= 3);
    const one = words[0]!;
    // People on (so only clients are in question): a single word of a multi-word client name is just a word.
    await accepted({ ...clean("overview", true, false), note: `a ${one.toLowerCase()} review on Friday` }, { people: true });
    await refused({ ...clean("overview", true, false), note: `at ${multiWordClient.replace(/ /g, "-")}` }, { people: true }, "The snapshot names a client.");
    await refused({ ...clean("overview", true, false), note: `at ${multiWordClient.replace(/[^A-Za-z]/g, "").toUpperCase()}` }, { people: true }, "The snapshot names a client.");
    await refused({ ...clean(), note: `ask ${personFirst.toLowerCase()}` }, {}, "The snapshot names a person.");
  });

  it("6i. accents are folded, Turkish and Greek agree, and a name in Han or Kana counts from 2 characters, also inside a run", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'José Núñez'), ($1, 'Zoë Łukasiewicz'), ($1, 'İbrahim Yılmaz'), ($1, 'Αλέξης Παπά'), ($1, '李伟'), ($1, 'Li')", [ws]);
      const msg = "The snapshot names a person.";
      const tryNote = (note: string) => attempt(db.client, () => insertLink(db.client, { snapshot: { ...clean(), note }, tok: randomUUID() }));
      for (const note of ["Jose Nunez said", "JOSE NUNEZ", "Zoe Lukasiewicz", "Ibrahim Yilmaz said", "İBRAHİM", "ΑΛΈΞΗΣ", "李伟 said", "李伟说过", "请联系李伟"]) {
        expect(await tryNote(note), note).toMatchObject({ ok: false, code: "23514", message: msg });
      }
      expect((await tryNote("Li is here")).ok).toBe(true);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("6j. the fifth round: default deny - a string under a key nobody classified is free text", async () => {
    for (const key of ["handoff_note", "x", "auto_verdict_note", "brand_new_field"]) {
      await refused({ ...clean(), [key]: `Ask ${personName}` }, {}, "The snapshot names a person.");
      await refused({ ...clean(), [key]: `at ${multiWordClient}` }, {}, "The snapshot names a client.");
    }
    // Keys that are no text (a path, an op, an enum) may hold the same words: they are ids and selectors.
    await accepted({ ...clean(), path: `steps.${personFirst.toLowerCase()}.price`, op: "set" });
    // A tag is text: a name in a condition tag or a path tag is refused with People off.
    await refused({ ...clean(), edges: [{ condition_tag: `${personFirst.toLowerCase()}-vip` }] }, {}, "The snapshot names a person.");
    await refused({ ...clean(), services: [{ path_tags: [`${personFirst}-vip`] }] }, {}, "The snapshot names a person.");
  });

  it("6k. the fifth round: ids, hex-looking emails, 'and' for '&', CJK clients and unspaced CJK names, umlauts, and money with a hyphen", async () => {
    const id = "0184c93c-120f-4cad-9a3c-5d3e1b2c199c";
    await accepted({ ...clean(), ids: [`x${id}x`, `ref:${id}.`, id + id] });
    for (const email of ["a1b2c3d4e5f6a7b8@client.example", "ask a1b2c3d4e5f6a7b8c9d0@client.example now", "x@a1b2c3d4e5f6a7b8.example"]) {
      await refused({ ...clean(), note: email }, {}, "The snapshot contains an email address.");
    }
    for (const text of ["4100-GBP", "GBP-4100", "GBP/4100", "4100/GBP", "1e6 GBP", "1.5e3 USD"]) await refused({ ...clean(), note: text }, {}, "The snapshot contains costs or margins.");
    await accepted({ ...clean(), note: "ref4100GBP and CAD3D" });
    await db.client.query("begin");
    try {
      await db.client.query("insert into clients (workspace_id, name) values ($1, 'Quince & Sloe Bakery'), ($1, '株式会社山田')", [ws]);
      await db.client.query("insert into people (workspace_id, name) values ($1, '田中太郎'), ($1, '김민준'), ($1, 'Hans Müller')", [ws]);
      const tryNote = (note: string) => attempt(db.client, () => insertLink(db.client, { snapshot: { ...clean(), note }, tok: randomUUID() }));
      for (const note of ["Quince and Sloe Bakery", "quince & sloe bakery", "Quince+Sloe Bakery", "株式会社山田に連絡"]) {
        expect(await tryNote(note), note).toMatchObject({ ok: false, code: "23514", message: "The snapshot names a client." });
      }
      for (const note of ["田中さん", "太郎に", "민준 said", "Hans Mueller", "MUELLER", "Muller", "Müller"]) {
        expect(await tryNote(note), note).toMatchObject({ ok: false, code: "23514", message: "The snapshot names a person." });
      }
      // A single word of a client's name is no client.
      expect((await tryNote("a quince in the sloe")).ok).toBe(true);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("2b. a scenario's selector (roles.@busiest) is not an email; a full-width email is", async () => {
    await accepted({ ...clean(), scenarios: [{ patch: [{ path: "roles.@busiest.headcount", op: "set", value: 3 }, { path: "steps.@heaviest.work_hours", op: "set", value: 2 }] }] });
    await refused({ ...clean(), note: "write to ｓａｍ@northbeam.example" }, {}, "The snapshot contains an email address.");
    await refused({ ...clean(), roles: [{ owner: "a.b@x.example" }] }, {}, "The snapshot contains an email address.");
    // A key is never text, so an address-shaped key is left alone.
    await accepted({ ...clean(), roles: { "a.b@x.example": 1 } });
  });

  it("7c. money in every form the app hides: several spaces, a French thousands space, a symbol and a no-break space", async () => {
    const msg = "The snapshot contains costs or margins.";
    for (const text of ["GBP  4,100 a month", "4 512 €", "4 512 €", "£ 4,100", "£  4,100", "£  4,100", "4,100 pounds", "1.2m GBP", "1.5 k GBP", "4,100 quid", "4,100 sterling", "x5£", "ABCD$5", "Rs 4,100", "¥4100", "%C2%A34,100", "＄５"]) {
      await refused({ ...clean(), note: text }, {}, msg);
    }
    await accepted({ ...clean("overview", false, true), note: "4 512 €" }, { financials: true });
    // Not money: the code is followed by a letter.
    await accepted({ ...clean(), note: "CAD 3D renders" });
  });

  it("7d. a step's cost_override with Financials off (a number or a string), allowed with it on, null always", async () => {
    const msg = "The snapshot contains costs or margins.";
    await refused({ ...clean(), steps: [{ cost_override: 120 }] }, {}, msg);
    await refused({ ...clean(), a: { b: [{ cost_override: "120" }] } }, {}, msg);
    await accepted({ ...clean(), steps: [{ cost_override: null }] });
    await accepted({ ...clean("overview", false, true), steps: [{ cost_override: 120 }] }, { financials: true });
  });

  it("4b. evidence notes of any JSON type, and quotes from sources, are refused", async () => {
    const msg = "The snapshot contains evidence notes.";
    await refused({ ...clean(), a: { provenance: ["x"] } }, {}, msg);
    await refused({ ...clean(), a: { provenance: "a note" } }, {}, msg);
    await refused({ ...clean(), a: { provenance: 5 } }, {}, msg);
    await refused({ ...clean(), a: { provenance: true } }, {}, msg);
    await refused({ ...clean(), findings: [{ facts: [{ kind: "quote", key: "q", text: "word for word" }] }] }, {}, msg);
    await accepted({ ...clean(), findings: [{ facts: [{ kind: "fact", key: "k", text: "a figure" }] }], a: { provenance: null } });
  });

  it("a snapshot over 5 MB is refused", async () => {
    await asEditor(async (c) => {
      const big = { ...clean(), pad: "y".repeat(5_300_000) };
      expect(await make(c, { snapshot: big })).toMatchObject({ ok: false, code: "23514" });
    });
  });

  it("a clean snapshot with both toggles on, People names and role rates, is stored", async () => {
    await accepted({ ...clean("overview", true, true), people: [{ name: personName, cost_rate: null }], roles: [{ default_cost_rate: 70 }] }, both);
  });
});

describe("rights on the table", () => {
  it("only owners, editors and agency admins read or write; the token hash and the snapshot are never readable", async () => {
    await db.client.query("insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version) values ($1, $2, 'overview', $3::jsonb, '1')", [ws, sha("seen"), JSON.stringify(clean())]);
    for (const role of ["owner", "editor", "admin"] as const) {
      await db.as(who[role]!.claims, async (c) => {
        expect(Number((await c.query("select count(*) from share_links")).rows[0].count), role).toBeGreaterThan(0);
        expect((await make(c, { tok: role })).ok, role).toBe(true);
      });
    }
    for (const role of ["member", "viewer", "stranger", "otherEditor"] as const) {
      await db.as(who[role]!.claims, async (c) => {
        expect(Number((await c.query("select count(*) from share_links")).rows[0].count), role).toBe(0);
        expect(await make(c, { tok: role }), role).toMatchObject({ ok: false, code: "42501" });
      });
    }
    await db.as(who.editor!.claims, async (c) => {
      for (const col of ["token_hash", "snapshot"]) {
        expect(await attempt(c, () => c.query(`select ${col} from share_links`)), col).toMatchObject({ ok: false, code: "42501" });
      }
      expect(await attempt(c, () => c.query("select * from share_links"))).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt(c, () => c.query("delete from share_links"))).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt(c, () => c.query("update share_links set opens = 5"))).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt(c, () => c.query("update share_links set show_people = true"))).toMatchObject({ ok: false, code: "42501" });
    });
    // An editor of another workspace can't make a link in this one.
    await db.as(who.otherEditor!.claims, async (c) => {
      expect(await make(c)).toMatchObject({ ok: false, code: "42501" });
    });
    await db.client.query("delete from share_links where token_hash = $1", [sha("seen")]);
  });

  it("anon can't select, insert or update; and has no privilege on the table at all", async () => {
    await asAnon(async () => undefined, async (c) => {
      for (const sql of ["select count(*) from share_links", "update share_links set label = 'x'", "delete from share_links"]) {
        expect(await attempt(c, () => c.query(sql)), sql).toMatchObject({ ok: false, code: "42501" });
      }
      expect(await make(c)).toMatchObject({ ok: false, code: "42501" });
    });
    const grants = (await db.client.query("select count(*) from information_schema.role_table_grants where table_name = 'share_links' and grantee = 'anon'")).rows[0].count;
    expect(Number(grants)).toBe(0);
  });
});

describe("open_share_link", () => {
  const KEYS = ["expires_at", "kind", "mode", "show_financials", "show_people", "snapshot", "snapshot_at", "status"];
  const seed = (tok: string, m: Made = {}) => async (c: pg.Client) => {
    await insertLink(c, { tok, ...m });
  };

  it("anon opens a live open link: exactly the listed keys, and the open count goes 1 then 2", async () => {
    const t = token("open1");
    await asAnon(seed(t), async (c) => {
      const first = (await open(c, t))!;
      expect(Object.keys(first).sort()).toEqual(KEYS);
      expect(first).toMatchObject({ status: "ok", kind: "overview", mode: "view", show_people: false, show_financials: false, expires_at: null });
      expect(first.snapshot).toEqual(clean());
      await open(c, t);
    });
    await db.client.query("begin");
    try {
      await seed(t)(db.client);
      await db.client.query("set local role anon");
      await open(db.client, t);
      await db.client.query("reset role");
      expect((await db.client.query("select opens, last_opened_at is not null as seen from share_links where token_hash = $1", [sha(t)])).rows[0]).toEqual({ opens: 1, seen: true });
      await db.client.query("set local role anon");
      await open(db.client, t);
      await db.client.query("reset role");
      expect((await db.client.query("select opens from share_links where token_hash = $1", [sha(t)])).rows[0].opens).toBe(2);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("unknown, malformed, expired and revoked links all return null", async () => {
    const good = token("g");
    const revoked = token("r");
    await asAnon(
      async (c) => {
        await insertLink(c, { tok: good });
        await insertLink(c, { tok: revoked });
        await c.query("update share_links set revoked_at = now() where token_hash = $1", [sha(revoked)]);
      },
      async (c) => {
        expect((await open(c, good))?.status).toBe("ok");
        expect(await open(c, revoked)).toBeNull();
        expect(await open(c, token("unknown"))).toBeNull();
        for (const bad of ["", "short", "x".repeat(44), "x".repeat(42), "x".repeat(42) + "!", "x".repeat(42) + " "]) expect(await open(c, bad), bad).toBeNull();
        expect((await c.query("select public.open_share_link(null) as r")).rows[0].r).toBeNull();
      },
    );
  });

  it("an expired link returns nothing (expiry can't be changed, so age the row as the superuser)", async () => {
    const t = token("exp");
    await db.client.query("begin");
    try {
      await db.client.query("alter table share_links disable trigger share_links_before_write");
      await db.client.query("insert into share_links (workspace_id, token_hash, kind, snapshot, engine_version, expires_at) values ($1, $2, 'overview', $3::jsonb, '1', now() - interval '1 second')", [ws, sha(t), JSON.stringify(clean())]);
      await db.client.query("set local role anon");
      expect(await open(db.client, t)).toBeNull();
    } finally {
      await db.client.query("rollback");
    }
  });

  it("a restricted link: anon gets only sign_in; a signed-in unlisted user not_allowed; a listed one ok", async () => {
    const t = token("restricted");
    const listed = await createUser(db, "Sam@Share.example", {}, { google: {} });
    const unconfirmed = await createUser(db, "pending@share.example", {}, { unconfirmed: true, google: {} });
    // Confirmed and listed, but a password sign-up: no Google identity, so it is not the person the address names.
    const password = await createUser(db, "ana@share.example");
    // Confirmed, listed, and a Google identity - but the identity's own email is someone else's: not the person the address names.
    const linked = await createUser(db, "lee@share.example");
    await db.client.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'google', $2, $3)", [linked.id, randomUUID(), { sub: randomUUID(), email: "someone.else@gmail.example" }]);
    const m: Made = { people: true, emails: ["sam@share.example", "pending@share.example", "ana@share.example", "lee@share.example"], expires: future() };
    await asAnon(seed(t, m), async (c) => {
      expect(await open(c, t)).toEqual({ status: "sign_in" });
    });
    await db.client.query("begin");
    try {
      await seed(t, m)(db.client);
      const as = async (claims: Claims) => {
        await db.client.query("set local role authenticated");
        await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        const r = await open(db.client, t);
        await db.client.query("reset role");
        return r;
      };
      // Signed in, not listed (and a workspace member, who gets no member view here).
      expect(await as(who.member!.claims)).toEqual({ status: "not_allowed" });
      expect(await as(password.claims)).toEqual({ status: "not_allowed" });
      expect(await as(linked.claims)).toEqual({ status: "not_allowed" });
      // Listed but the address isn't confirmed.
      expect(await as(unconfirmed.claims)).toEqual({ status: "not_allowed" });
      // Listed `sam@share.example`, signed in as `Sam@Share.example`: the comparison is case-insensitive.
      const ok = (await as(listed.claims))!;
      expect(ok.status).toBe("ok");
      expect(ok).toMatchObject({ show_people: true });
      expect(Object.keys(ok).sort()).toEqual(KEYS);
      for (const secret of ["workspace_id", "token_hash", "allowed_emails", "created_by", "label"]) expect(ok, secret).not.toHaveProperty(secret);
      // Opens are counted for the ok open only.
      expect((await db.client.query("select opens from share_links where token_hash = $1", [sha(t)])).rows[0].opens).toBe(1);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("an API-token caller can open a link like anyone (the counter update isn't refused)", async () => {
    const t = token("apiopen");
    await db.client.query("begin");
    try {
      await seed(t)(db.client);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...who.editor!.claims, api_token_id: randomUUID() })]);
      expect((await open(db.client, t))?.status).toBe("ok");
    } finally {
      await db.client.query("rollback");
    }
  });

  it("anon and authenticated may execute it; the private helpers are not callable", async () => {
    const priv = "private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)";
    const has = async (role: string, fn: string) => (await db.client.query("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0].ok as boolean;
    expect(await has("anon", "public.open_share_link(text)")).toBe(true);
    expect(await has("authenticated", "public.open_share_link(text)")).toBe(true);
    expect(await has("anon", "public.share_team_capacity(uuid, boolean)")).toBe(false);
    expect(await has("authenticated", "public.share_team_capacity(uuid, boolean)")).toBe(true);
    expect(await has("authenticated", priv)).toBe(false);
    expect(await has("anon", priv)).toBe(false);
    const cfg = (await db.client.query(
      "select proname, prosecdef, proconfig from pg_proc where proname in ('open_share_link', 'share_team_capacity', 'share_links_before_write', 'share_snapshot_problem') order by 1",
    )).rows;
    expect(cfg.map((r) => [r.proname, r.prosecdef])).toEqual([["open_share_link", true], ["share_links_before_write", true], ["share_snapshot_problem", false], ["share_team_capacity", true]]);
    for (const r of cfg) expect(r.proconfig, r.proname).toEqual(['search_path=""']);
  });
});

describe("share_team_capacity on Larkspur", () => {
  const P = larkspurPersonIds;
  type Person = { id: string; name: string; cost_rate: number | null; provenance: object };
  type Team = { sees_everyone: boolean; own_person_id: string | null; people: Person[]; [k: string]: unknown };
  let lEditor: Caller;
  let lMember: Caller;

  beforeAll(async () => {
    const link = async (email: string, role: string, person: string | null) => {
      const u = await createUser(db, email);
      await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, $3, $4)", [other, u.id, role, person]);
      return u;
    };
    lEditor = await link("l-editor@share.example", "editor", null);
    lMember = await link("l-member@share.example", "member", P.jess!);
    for (const [key, rate] of [["hana", 80], ["jess", 50], ["callum", 40], ["ruby", 55]] as const) {
      await db.client.query("update people set cost_rate = $1 where id = $2", [rate, P[key]]);
    }
    await db.client.query("update people set notes = 'Prefers mornings', provenance = '{\"source\":\"x\"}' where id = $1", [P.hana]).catch(() => undefined);
  });

  const call = (who: Caller, show: boolean | null) =>
    db.as(who.claims, async (c) => (await c.query("select public.share_team_capacity($1, $2) as t", [other, show])).rows[0].t as Team);
  const asMember = (who: Caller) => db.as(who.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [other])).rows[0].t as Team);

  it("People off: every name is Team member N (the same N a member sees), no rate, empty provenance", async () => {
    const t = await call(lEditor, false);
    const members = await asMember(lMember);
    expect(t.sees_everyone).toBe(false);
    expect(t.own_person_id).toBeNull();
    expect(t.people.length).toBeGreaterThan(5);
    const memberLabels = new Map(members.people.map((p) => [p.id, p.name]));
    for (const p of t.people) {
      expect(p.name).toMatch(/^Team member \d+$/);
      expect(p.cost_rate, p.id).toBeNull();
      expect(p.provenance).toEqual({});
      // Jess is the member's own person, so she sees her own name; everyone else matches.
      if (p.id !== P.jess) expect(p.name, p.id).toBe(memberLabels.get(p.id));
    }
    expect(JSON.stringify(t)).not.toContain('"cost_rate":4');
  });

  it("People on: real names, but the rates are still null for everyone", async () => {
    const t = await call(lEditor, true);
    expect(t.sees_everyone).toBe(true);
    for (const p of t.people) {
      expect(p.name).not.toMatch(/^Team member/);
      expect(p.cost_rate, p.id).toBeNull();
      expect(p.provenance).toEqual({});
    }
    // In the order team_capacity gives an editor (by name).
    const editors = await db.as(lEditor.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [other])).rows[0].t as Team);
    expect(t.people.map((p) => p.id)).toEqual(editors.people.map((p) => p.id));
    expect(t.people.map((p) => p.name)).toEqual(editors.people.map((p) => p.name));
  });

  it("members, viewers, strangers and an editor of another workspace are refused (42501); anon has no execute", async () => {
    const viewer = await createUser(db, "l-viewer@share.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [other, viewer.id]);
    for (const [label, w] of [["member", lMember], ["viewer", viewer], ["stranger", who.stranger!], ["other editor", who.editor!]] as const) {
      await db.as(w.claims, async (c) => {
        expect(await attempt(c, () => c.query("select public.share_team_capacity($1, false)", [other])), label).toMatchObject({ ok: false, code: "42501" });
      });
    }
    await db.as(lEditor.claims, async (c) => {
      expect(await attempt(c, () => c.query("select public.share_team_capacity($1, null)", [other]))).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt(c, () => c.query("select public.share_team_capacity(null, true)"))).toMatchObject({ ok: false, code: "42501" });
    });
    await asAnon(async () => undefined, async (c) => {
      expect(await attempt(c, () => c.query("select public.share_team_capacity($1, false)", [other]))).toMatchObject({ ok: false, code: "42501" });
    });
  });

  it("the same people, roles, skills, leave and assignments as team_capacity gives an editor", async () => {
    const mine = await call(lEditor, false);
    const theirs = await db.as(lEditor.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [other])).rows[0].t as Team);
    for (const key of ["person_roles", "person_skills", "person_leave", "client_assignments"]) expect(mine[key], key).toEqual(theirs[key]);
    expect(mine.people.map((p) => p.id).sort()).toEqual(theirs.people.map((p) => p.id).sort());
  });
});
