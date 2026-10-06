import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { LEVER_KIND_IDS } from "../src/share";
import { createTestDb, createUser, type TestDb } from "./harness";
const cases = JSON.parse(readFileSync(new URL("./fixtures/play-patch-cases.json", import.meta.url), "utf8")) as { messages: Record<string, string>; cases: { name: string; levers: unknown; expect: string | null; hidden?: string[]; people?: boolean }[] };

// Play links (issue #33, B4): a visitor tries levers on a shared process and sends the idea to Suggestions through
// public.submit_play_proposal, the only write a play link can make. Each test runs in a rolled-back transaction unless it says so.

const ws = NORTHBEAM_WORKSPACE_ID;
const other = LARKSPUR_WORKSPACE_ID;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (n: string) => n.padEnd(43, "x").slice(0, 43);
type Json = Record<string, unknown>;
const future = () => new Date(Date.now() + 7 * 86400_000).toISOString();

let db: TestDb;
const who: Record<string, { id: string; claims: Json }> = {};
const ids = {
  liveRevision: "",
  step: "",
  stepOther: "",
  role: "",
  person: "",
  service: "",
  unseenStep: "",
  foreignStep: "",
  retiredStep: "",
  issue: "",
  resolvedIssue: "",
  detectedIssue: "",
  otherProcessIssue: "",
  notInSnapshotIssue: "",
  foreignIssue: "",
};
const LEVER = [{ path: "demand.leads_per_week", op: "set", value: 9 }];
const OK = { status: "ok" };

interface Opts {
  tok?: string;
  people?: boolean;
  financials?: boolean;
  hidden?: unknown;
  emails?: string[];
  expires?: string | null;
  mode?: string;
  kind?: string;
  target?: string | null;
  snapshot?: Json;
  workspace?: string;
  extraSnapshot?: Json;
}

function snapshot(o: Opts = {}): Json {
  return {
    v: 1,
    kind: o.kind ?? "process",
    toggles: { people: o.people ?? false, financials: o.financials ?? false },
    hiddenLevers: o.hidden ?? ["process.rework"],
    workspaceName: "Northbeam",
    bundle: {
      revision: { id: ids.liveRevision },
      steps: [{ id: ids.step }, { id: randomUUID() }],
      roles: [{ id: ids.role }],
      people: [{ id: ids.person }],
      services: [{ id: ids.service }],
      otherProcesses: [{ steps: [{ id: ids.stepOther }] }],
      retired: [{ id: ids.retiredStep }],
    },
    issues: [
      { id: ids.issue, process_id: NORTHBEAM_PROCESS_ID, links: [] },
      { id: ids.resolvedIssue, process_id: NORTHBEAM_PROCESS_ID, links: [] },
      { id: ids.detectedIssue, process_id: NORTHBEAM_PROCESS_ID, links: [] },
      { id: ids.otherProcessIssue, process_id: randomUUID(), links: [] },
      { id: ids.foreignIssue, process_id: NORTHBEAM_PROCESS_ID, links: [] },
    ],
    ...(o.extraSnapshot ?? {}),
  };
}

const INSERT =
  "insert into share_links (workspace_id, token_hash, kind, target_id, mode, show_people, show_financials, allowed_emails, expires_at, snapshot, engine_version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '1.8.0') returning id";
async function insertLink(c: pg.Client, o: Opts = {}) {
  const restricted = o.people || o.financials;
  return c.query(INSERT, [
    o.workspace ?? ws,
    sha(token(o.tok ?? "play")),
    o.kind ?? "process",
    o.target === undefined ? ((o.kind ?? "process") === "overview" ? null : NORTHBEAM_PROCESS_ID) : o.target,
    o.mode ?? "play",
    o.people ?? false,
    o.financials ?? false,
    o.emails ?? (restricted ? ["visitor@play.example"] : []),
    o.expires === undefined ? (restricted ? future() : null) : o.expires,
    JSON.stringify(o.snapshot ?? snapshot(o)),
  ]);
}

interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  rows?: pg.QueryResult["rows"];
}
async function attempt(c: pg.Client, fn: () => Promise<pg.QueryResult>): Promise<Outcome> {
  await c.query("savepoint attempt");
  try {
    const r = await fn();
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query("rollback to savepoint attempt");
    const err = e as { code?: string; message: string };
    return { ok: false, code: err.code, message: err.message };
  }
}

/** Inside a rolled-back transaction: `setup` as the superuser, then `fn` as anon (or as a signed-in visitor). */
async function visitor<T>(setup: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>, claims: Json | null = null): Promise<T> {
  await db.client.query("begin");
  try {
    await setup(db.client);
    await db.client.query(claims ? "set local role authenticated" : "set local role anon");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
    return await fn(db.client);
  } finally {
    await db.client.query("rollback");
  }
}

const submit = async (c: pg.Client, tok: string, a: { title?: string | null; note?: string | null; name?: string | null; email?: string | null; issue?: string | null; levers?: unknown } = {}) =>
  attempt(c, () =>
    c.query("select public.submit_play_proposal($1, $2, $3, $4, $5, $6, $7::jsonb) as r", [
      tok,
      a.title === undefined ? "One more strategist" : a.title,
      a.note === undefined ? null : a.note,
      a.name === undefined ? "Marta Okoye" : a.name,
      a.email === undefined ? "marta@visitor.example" : a.email,
      a.issue === undefined ? null : a.issue,
      JSON.stringify(a.levers === undefined ? LEVER : a.levers),
    ]),
  );
const status = (o: Outcome) => (o.rows?.[0]?.r as Json | undefined) ?? o;
const rowsOf = async (c: pg.Client, where = "created_via = 'play_link'") => {
  await c.query("reset role");
  return (await c.query(`select * from suggestion_proposals where workspace_id = $1 and ${where} order by created_at, id`, [ws])).rows;
};

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const member = async (email: string, role: string) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, u.id, role]);
    return u;
  };
  who.owner = await member("owner@play.example", "owner");
  who.editor = await member("editor@play.example", "editor");
  who.member = await member("member@play.example", "member");
  who.viewer = await member("viewer@play.example", "viewer");
  who.admin = await createUser(db, "admin@play.example", { agency_admin: true });
  who.otherEditor = await createUser(db, "other-editor@play.example");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [other, who.otherEditor.id]);

  const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0]?.id as string;
  ids.liveRevision = (await db.client.query("select live_revision_id from processes where id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].live_revision_id;
  ids.step = await one("select id from steps where revision_id = $1 order by id limit 1", [ids.liveRevision]);
  ids.stepOther = await one("select id from steps where workspace_id = $1 and revision_id <> $2 order by id limit 1", [ws, ids.liveRevision]);
  if (!ids.stepOther) ids.stepOther = await one("select id from steps where revision_id = $1 order by id offset 1 limit 1", [ids.liveRevision]);
  ids.unseenStep = await one("select id from steps where workspace_id = $1 and id not in ($2, $3) order by id desc limit 1", [ws, ids.step, ids.stepOther]);
  ids.retiredStep = await one("select id from steps where workspace_id = $1 and id not in ($2, $3, $4) order by id limit 1 offset 1", [ws, ids.step, ids.stepOther, ids.unseenStep]);
  ids.foreignStep = await one("select id from steps where workspace_id = $1 limit 1", [other]);
  ids.role = await one("select id from roles where workspace_id = $1 order by id limit 1", [ws]);
  ids.person = await one("select id from people where workspace_id = $1 order by created_at, id limit 1", [ws]);
  ids.service = await one("select id from services where workspace_id = $1 order by id limit 1", [ws]);
  // Issues: an open one, a resolved one, a detected one, one of another process, one the snapshot doesn't hold, one of another workspace.
  const issue = async (w: string, status: string, source: string, title: string) => {
    const detected = source === "detected" ? `'play:test:' || gen_random_uuid()::text` : "null";
    return one(
      `insert into issues (workspace_id, process_id, type, severity, title, status, source, detected_key) values ($1, $2, 'bottleneck', 'warning', $3, $4, $5, ${detected}) returning id`,
      [w, NORTHBEAM_PROCESS_ID, title, status, source],
    );
  };
  ids.issue = await issue(ws, "open", "manual", "Play test: open");
  ids.resolvedIssue = await issue(ws, "done", "manual", "Play test: done");
  ids.detectedIssue = await issue(ws, "open", "detected", "Play test: detected");
  ids.otherProcessIssue = await issue(ws, "open", "manual", "Play test: other process");
  ids.notInSnapshotIssue = await issue(ws, "open", "manual", "Play test: not in snapshot");
  ids.foreignIssue = (await db.client.query("select id from issues where workspace_id = $1 limit 1", [other])).rows[0]?.id ?? randomUUID();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("play links: the write trigger, hiddenLevers and open_share_link", () => {
  it("a play link for a process with hiddenLevers is accepted, and the editor (authenticated) may now set mode", async () => {
    await db.as(who.editor!.claims, async (c) => {
      const r = await attempt(c, () => insertLink(c, { tok: "editorplay" }));
      expect(r.ok).toBe(true);
      expect((await c.query("select mode from share_links where workspace_id = $1 and mode = 'play'", [ws])).rows[0].mode).toBe("play");
    });
  });

  it("a play link for the Overview, an issue or a solution is refused (22023), and so is one without hiddenLevers", async () => {
    await db.client.query("begin");
    try {
      for (const kind of ["overview", "issue", "solution"]) {
        const r = await attempt(db.client, () => insertLink(db.client, { kind, target: kind === "overview" ? null : ids.issue, snapshot: { v: 1, kind, toggles: { people: false, financials: false }, hiddenLevers: [] } }));
        expect(r, kind).toMatchObject({ ok: false, code: "22023", message: "Only a process can be shared for trying changes." });
      }
      const { hiddenLevers: _drop, ...bare } = snapshot();
      expect(await attempt(db.client, () => insertLink(db.client, { snapshot: bare }))).toMatchObject({ ok: false, code: "22023", message: "Only a process can be shared for trying changes." });
      expect(await attempt(db.client, () => insertLink(db.client, { snapshot: { ...bare, hiddenLevers: "process.wait" } }))).toMatchObject({ ok: false, code: "22023" });
      expect(await attempt(db.client, () => insertLink(db.client, { snapshot: { ...bare, hiddenLevers: ["Priya"] } }))).toMatchObject({ ok: false, code: "23514", message: "The snapshot doesn't match the link." });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("Update copy of a play link without hiddenLevers is refused (22023); with it, accepted; mode never changes", async () => {
    await db.client.query("begin");
    try {
      const id = (await insertLink(db.client, { tok: "upd" })).rows[0].id;
      const { hiddenLevers: _drop, ...bare } = snapshot();
      expect(await attempt(db.client, () => db.client.query("update share_links set snapshot = $2::jsonb where id = $1", [id, JSON.stringify(bare)]))).toMatchObject({ ok: false, code: "22023", message: "Only a process can be shared for trying changes." });
      expect((await attempt(db.client, () => db.client.query("update share_links set snapshot = $2::jsonb where id = $1", [id, JSON.stringify(snapshot({ hidden: ["people.leave"] }))]))).ok).toBe(true);
      expect(await attempt(db.client, () => db.client.query("update share_links set mode = 'view' where id = $1", [id]))).toMatchObject({ ok: false, code: "22023" });
      const view = (await insertLink(db.client, { tok: "viewmode", mode: "view" })).rows[0].id;
      expect(await attempt(db.client, () => db.client.query("update share_links set mode = 'play' where id = $1", [view]))).toMatchObject({ ok: false, code: "22023" });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("hiddenLevers must be an array of at most 30 distinct known kind ids, on a view link or a play link alike", async () => {
    await db.client.query("begin");
    try {
      const bad: [string, unknown][] = [
        ["a string", "process.wait"],
        ["an object", { a: 1 }],
        ["a number element", [1]],
        ["an unknown id", ["process.nope"]],
        ["a repeat", ["process.wait", "process.wait"]],
        ["a name", ["Priya"]],
        ["31 elements", Array.from({ length: 31 }, (_, i) => `x${i}`)],
      ];
      for (const mode of ["view", "play"]) {
        for (const [name, v] of bad) {
          const r = await attempt(db.client, () => insertLink(db.client, { tok: `h${mode}`, mode, snapshot: snapshot({ hidden: v }) }));
          expect(r, `${mode}: ${name}`).toMatchObject({ ok: false, code: mode === "play" && (name === "a string" || name === "an object") ? "22023" : "23514" });
          if (r.code === "23514") expect(r.message).toBe("The snapshot doesn't match the link.");
        }
        expect((await attempt(db.client, () => insertLink(db.client, { tok: `ok${mode}`, mode, snapshot: snapshot({ hidden: ["process.wait", "people.leave"] }) }))).ok, mode).toBe(true);
        expect((await attempt(db.client, () => insertLink(db.client, { tok: `empty${mode}`, mode, snapshot: snapshot({ hidden: [] }) }))).ok, mode).toBe(true);
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("with a person called 'Wait Leave' and People off, ['process.wait', 'people.leave'] is accepted unchanged (B3's default deny would have refused it); a name in it is refused", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'Wait Leave')", [ws]);
      expect((await attempt(db.client, () => insertLink(db.client, { tok: "waitleave", snapshot: snapshot({ hidden: ["process.wait", "people.leave"] }) }))).ok).toBe(true);
      expect(await attempt(db.client, () => insertLink(db.client, { tok: "waitleave2", snapshot: snapshot({ hidden: ["Wait Leave"] }) }))).toMatchObject({ ok: false, code: "23514", message: "The snapshot doesn't match the link." });
      // The same person's name anywhere that IS text still leaks.
      expect(await attempt(db.client, () => insertLink(db.client, { tok: "waitleave3", snapshot: snapshot({ extraSnapshot: { workspaceName: "Wait Leave" } }) }))).toMatchObject({ ok: false, code: "23514" });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("private.lever_kind_ids() equals LEVER_KIND_IDS, and the catalogue's ids", async () => {
    const inDb = (await db.client.query("select unnest(private.lever_kind_ids()) as k")).rows.map((r) => r.k as string);
    expect(inDb).toEqual([...LEVER_KIND_IDS]);
    const catalogue = readFileSync(new URL("../../../apps/web/src/lib/scenarios/lever-catalogue.ts", import.meta.url), "utf8");
    const fromCatalogue = [...catalogue.slice(catalogue.indexOf("export const LEVER_KINDS"), catalogue.indexOf("const KIND_BY_ID")).matchAll(/^\s+id: "([^"]+)",/gm)].map((m) => m[1]);
    expect(inDb).toEqual(fromCatalogue);
  });

  it("open_share_link returns mode 'play' and serves view links as before; Google-identity rules hold on a restricted play link", async () => {
    const t = token("openplay");
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "openplay" });
      },
      async (c) => {
        const r = (await c.query("select public.open_share_link($1) as r", [t])).rows[0].r as Json;
        expect(r).toMatchObject({ status: "ok", kind: "process", mode: "play" });
        expect((r.snapshot as Json).hiddenLevers).toEqual(["process.rework"]);
      },
    );
    const restricted = token("restricted");
    const g = await createUser(db, "visitor@play.example", {}, { google: {} });
    const pw = await createUser(db, "pw@play.example");
    const setup = async (c: pg.Client) => {
      await insertLink(c, { tok: "restricted", people: true, emails: ["visitor@play.example", "pw@play.example"] });
    };
    const openAs = (claims: Json | null) => visitor(setup, async (c) => (await c.query("select public.open_share_link($1) as r", [restricted])).rows[0].r as Json, claims);
    expect(await openAs(null)).toEqual({ status: "sign_in" });
    expect(await openAs(pw.claims)).toEqual({ status: "not_allowed" });
    expect(await openAs(g.claims)).toMatchObject({ status: "ok", mode: "play", show_people: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit_play_proposal: the happy path", () => {
  it("anon, open link: returns exactly {status: ok}; one pending solution idea with the checked changes and nothing else changed", async () => {
    const t = token("happy");
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "happy" });
      },
      async (c) => {
        await c.query("reset role");
        const counts = async () =>
          (await c.query(
            "select (select count(*) from issues) i, (select count(*) from solutions) s, (select count(*) from scenarios) sc, (select count(*) from share_links) l, (select count(*) from suggestion_proposals where created_via <> 'play_link') p, (select count(*) from suggestions) g, (select count(*) from audit_log) a",
          )).rows[0];
        const before = await counts();
        await c.query("set local role anon");
        const r = await submit(c, t, { note: "With 3 strategists, leads wait under a day.", email: "  Marta@Visitor.EXAMPLE ", levers: [{ path: "demand.leads_per_week", op: "set", value: 9, ignored: undefined }] });
        expect(status(r)).toEqual(OK);
        expect(r.rows![0]!.r).toStrictEqual(OK);
        const [row, ...rest] = await rowsOf(c);
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
          workspace_id: ws,
          kind: "solution_idea",
          status: "pending",
          created_via: "play_link",
          created_by: null,
          proposer_name: "Marta Okoye",
          proposer_email: "marta@visitor.example",
          title: "One more strategist",
          detail: "With 3 strategists, leads wait under a day.",
          note: null,
          issue_id: null,
          visitor_text: null,
          applied: null,
          reviewed_by: null,
          reviewed_at: null,
          import_source: null,
        });
        expect(row.share_link_id).toBe((await c.query("select id from share_links where token_hash = $1", [sha(t)])).rows[0].id);
        expect(row.payload).toEqual({
          steps: [],
          edges: [],
          replaces_step_ids: [],
          levers: [{ path: "demand.leads_per_week", op: "set", value: 9 }],
          process_id: NORTHBEAM_PROCESS_ID,
          base_revision_id: ids.liveRevision,
        });
        expect(row.evidence).toEqual([]);
        expect(await counts()).toEqual({ ...before });
        // The setting is off again in the same transaction: a later direct insert is MCP.
        await c.query("insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id) values ($1, 'solution_idea', 'Later', '{\"steps\": []}', $2)", [ws, ids.issue]);
        expect((await c.query("select created_via from suggestion_proposals where title = 'Later'")).rows[0].created_via).toBe("mcp");
      },
    );
  });

  it("an idea may name an open issue of this process from the snapshot", async () => {
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "withissue" });
      },
      async (c) => {
        expect(status(await submit(c, token("withissue"), { issue: ids.issue }))).toEqual(OK);
        expect((await rowsOf(c))[0].issue_id).toBe(ids.issue);
      },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit_play_proposal: refusals", () => {
  const withLink = (o: Opts, fn: (c: pg.Client, tok: string) => Promise<void>, claims: Json | null = null) =>
    visitor(
      async (c) => {
        await insertLink(c, { tok: "refuse", ...o });
      },
      (c) => fn(c, token("refuse")),
      claims,
    );
  const message = async (a: Parameters<typeof submit>[2], o: Opts = {}) => {
    let out: Outcome | undefined;
    await withLink(o, async (c, t) => {
      out = await submit(c, t, a);
    });
    return out!;
  };

  it("API-token claims are refused (42501)", async () => {
    await withLink({}, async (c, t) => {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", api_token_id: randomUUID(), sub: who.editor!.id })]);
      expect(await submit(c, t)).toMatchObject({ ok: false, code: "42501" });
    }, { sub: who.editor!.id, role: "authenticated" });
  });

  it("unknown, malformed, revoked, expired and view-mode tokens answer gone", async () => {
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "live" });
        await insertLink(c, { tok: "viewmode", mode: "view" });
        const rv = (await insertLink(c, { tok: "revoked" })).rows[0].id;
        await c.query("update share_links set revoked_at = now() where id = $1", [rv]);
        const ex = (await insertLink(c, { tok: "expired", expires: future() })).rows[0].id;
        await c.query("alter table share_links disable trigger share_links_before_write");
        await c.query("update share_links set expires_at = now() - interval '1 minute' where id = $1", [ex]);
        await c.query("alter table share_links enable trigger share_links_before_write");
      },
      async (c) => {
        for (const t of [token("nothing"), "short", "x".repeat(44), "x".repeat(42) + "!", token("viewmode"), token("revoked"), token("expired")]) {
          expect(status(await submit(c, t)), t).toEqual({ status: "gone" });
        }
        expect(status(await submit(c, null as unknown as string))).toEqual({ status: "gone" });
        expect(status(await submit(c, token("live")))).toEqual(OK);
      },
    );
  });

  it("restricted + anon -> sign_in; unlisted -> not_allowed; no Google identity, or one of another address -> not_allowed; listed + Google -> ok with the VERIFIED email stored", async () => {
    const listed = await createUser(db, "listed@play.example", {}, { google: {} });
    const pw = await createUser(db, "listed-pw@play.example");
    const unlisted = await createUser(db, "unlisted@play.example", {}, { google: {} });
    const unconfirmed = await createUser(db, "unconfirmed@play.example", {}, { google: {}, unconfirmed: true });
    const mismatch = await createUser(db, "mismatch@play.example");
    await db.client.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'google', $2, $3)", [mismatch.id, mismatch.id, { sub: "x", email: "someone-else@play.example" }]);
    const o = { people: true, emails: ["listed@play.example", "listed-pw@play.example", "mismatch@play.example", "unconfirmed@play.example"] };
    const as = async (claims: Json | null) => {
      let out: Outcome | undefined;
      let row: Json | undefined;
      await withLink(o, async (c, t) => {
        out = await submit(c, t, { email: "typed@else.example" });
        row = (await rowsOf(c))[0];
      }, claims);
      return { out: status(out!), row };
    };
    expect((await as(null)).out).toEqual({ status: "sign_in" });
    expect((await as(unlisted.claims)).out).toEqual({ status: "not_allowed" });
    expect((await as(pw.claims)).out).toEqual({ status: "not_allowed" });
    expect((await as(mismatch.claims)).out).toEqual({ status: "not_allowed" });
    expect((await as(unconfirmed.claims)).out).toEqual({ status: "not_allowed" });
    const good = await as(listed.claims);
    expect(good.out).toEqual(OK);
    expect(good.row).toMatchObject({ proposer_email: "listed@play.example", created_by: null, created_via: "play_link" });
  });

  it("format: missing and too long title, name, email; a bad email; control characters; too long note", async () => {
    const cases: [string, Parameters<typeof submit>[2], string][] = [
      ["no title", { title: "  " }, "Give your idea a name."],
      ["title 121", { title: "t".repeat(121) }, "Keep the name under 120 characters."],
      ["no name", { name: "" }, "Add your name."],
      ["name 101", { name: "n".repeat(101) }, "Keep your name under 100 characters."],
      ["no email", { email: " " }, "Add your email address so the team can reply."],
      ["email 255", { email: `${"e".repeat(246)}@x.example` }, "That isn't an email address."],
      ["bad email", { email: "marta at example" }, "That isn't an email address."],
      ["note 1001", { note: "n".repeat(1001) }, "Keep the note under 1,000 characters."],
      ["control in title", { title: "a\u0001b" }, "Remove the unusual characters and try again."],
      ["control in name", { name: "a\u007fb" }, "Remove the unusual characters and try again."],
      ["control in note", { note: "a\u0007b" }, "Remove the unusual characters and try again."],
      ["line break in title", { title: "a\nb" }, "Remove the unusual characters and try again."],
    ];
    for (const [name, a, msg] of cases) {
      expect(await message(a), name).toMatchObject({ ok: false, code: "22023", message: msg });
    }
    // Line breaks are fine in a note; the limits are inclusive.
    await withLink({}, async (c, t) => {
      expect(status(await submit(c, t, { note: "line one\nline two", title: "t".repeat(120), name: "n".repeat(100) }))).toEqual(OK);
    });
  });

  it("lever changes: every case of the shared fixture gets its message (and no id in it)", async () => {
    const msgs = cases.messages;
    const DELETED_STEP = randomUUID();
    const sub = (s: string) =>
      s
        .replaceAll("$stepOther", ids.stepOther)
        .replaceAll("$unseenStep", ids.unseenStep)
        .replaceAll("$foreignStep", ids.foreignStep)
        .replaceAll("$retiredStep", ids.retiredStep)
        .replaceAll("$inventedStep", randomUUID())
        .replaceAll("$deletedStep", DELETED_STEP)
        .replaceAll("$step", ids.step)
        .replaceAll("$role", ids.role)
        .replaceAll("$person", ids.person)
        .replaceAll("$service", ids.service);
    const listed = await createUser(db, "fixture-visitor@play.example", {}, { google: {} });
    for (const k of cases.cases) {
      const levers = typeof k.levers === "string" ? Array.from({ length: Number(k.levers.split(":")[1]) }, () => LEVER[0]) : JSON.parse(sub(JSON.stringify(k.levers)));
      let out: Outcome | undefined;
      await visitor(
        async (c) => {
          const snap = snapshot({ hidden: k.hidden ?? ["process.rework"], people: k.people });
          (snap.bundle as { steps: Json[] }).steps.push({ id: DELETED_STEP });
          await insertLink(c, { tok: "fixture", people: k.people, emails: k.people ? ["fixture-visitor@play.example"] : undefined, snapshot: snap });
        },
        async (c) => {
          out = await submit(c, token("fixture"), { levers });
        },
        k.people ? listed.claims : null,
      );
      if (k.expect === null) expect(status(out!), k.name).toEqual(OK);
      else {
        expect(out, k.name).toMatchObject({ ok: false, code: "22023", message: msgs[k.expect] });
        for (const idv of Object.values(ids)) expect(out!.message, k.name).not.toContain(idv);
      }
    }
  }, 120_000);

  it("ids: another workspace's step, a real step the snapshot doesn't show, a retired step and an invented one read the SAME message (no oracle)", async () => {
    const seen = new Set<string>();
    for (const id of [ids.foreignStep, ids.unseenStep, ids.retiredStep, randomUUID(), "not-a-uuid"]) {
      const r = await message({ levers: [{ path: `steps.${id}.work_hours`, op: "multiply", value: 0.9 }] });
      expect(r.ok).toBe(false);
      seen.add(r.message!);
    }
    expect([...seen]).toEqual(["One of those changes points at something that isn't in this page."]);
  });

  it("an id in the snapshot that the workspace has lost is refused with that message too", async () => {
    const gone = randomUUID();
    let out: Outcome | undefined;
    await visitor(
      async (c) => {
        const snap = snapshot();
        (snap.bundle as { steps: Json[] }).steps.push({ id: gone });
        await insertLink(c, { tok: "gone", snapshot: snap });
      },
      async (c) => {
        out = await submit(c, token("gone"), { levers: [{ path: `steps.${gone}.work_hours`, op: "multiply", value: 0.9 }] });
      },
    );
    expect(out).toMatchObject({ ok: false, code: "22023", message: "One of those changes points at something that isn't in this page." });
  });

  it("issues: another workspace's, another process's, a resolved one, a detected one and one the snapshot doesn't hold all read the same message", async () => {
    const seen = new Set<string>();
    for (const issue of [ids.foreignIssue, ids.otherProcessIssue, ids.resolvedIssue, ids.detectedIssue, ids.notInSnapshotIssue, randomUUID()]) {
      const r = await message({ issue });
      expect(r, issue).toMatchObject({ ok: false, code: "22023" });
      seen.add(r.message!);
    }
    expect([...seen]).toEqual(["Pick an issue from this page, or none."]);
  });

  it("a refused call stores nothing and doesn't count towards the limits", async () => {
    await withLink({}, async (c, t) => {
      for (let i = 0; i < 7; i++) expect((await submit(c, t, { levers: [] })).ok).toBe(false);
      expect(await rowsOf(c)).toEqual([]);
      for (let i = 0; i < 5; i++) expect(status(await submit(c, t, { email: `n${i}@visitor.example` }))).toEqual(OK);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit_play_proposal: limits", () => {
  const seedRows = async (c: pg.Client, linkId: string | null, n: number, o: { email?: string; age?: string; via?: string } = {}) => {
    // Through the same door a submission uses (the trigger keeps share_link_id only then); created_at is set by us.
    await c.query("select set_config('transpera.play_submitting', 'on', true)");
    await c.query(
      `insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id, created_via, proposer_email, share_link_id, created_at)
       select $1, 'solution_idea', 'Seed ' || g, '{"steps": []}'::jsonb, null, 'play_link', coalesce($3, 'seed' || g || '@x.example'), $2, now() - $4::interval from generate_series(1, $5) g`,
      [ws, linkId, o.email ?? null, o.age ?? "2 hours", n],
    );
    await c.query("select set_config('transpera.play_submitting', '', true)");
  };
  const linkId = async (c: pg.Client, tok: string) => (await c.query("select id from share_links where token_hash = $1", [sha(tok)])).rows[0].id as string;

  it("5 ok, then the 6th is rate_limited (10 minutes); a refused call at the limit is rate_limited first (the limit runs before the patch check)", async () => {
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "ten" });
      },
      async (c) => {
        for (let i = 0; i < 5; i++) expect(status(await submit(c, token("ten"), { email: `v${i}@visitor.example` })), String(i)).toEqual(OK);
        expect(status(await submit(c, token("ten"), { email: "v9@visitor.example" }))).toEqual({ status: "rate_limited" });
        expect(status(await submit(c, token("ten"), { email: "v9@visitor.example", levers: [] }))).toEqual({ status: "rate_limited" });
        expect(status(await submit(c, token("ten"), { email: "v9@visitor.example", levers: [{ path: "roles.x.cost_rate", op: "set", value: 1 }] }))).toEqual({ status: "rate_limited" });
        expect((await rowsOf(c)).length).toBe(5);
      },
    );
  });

  it("50 in 24 hours -> rate_limited, while 49 are fine", async () => {
    for (const [n, expected] of [[49, OK], [50, { status: "rate_limited" }]] as const) {
      await visitor(
        async (c) => {
          await insertLink(c, { tok: "day" });
          await seedRows(c, await linkId(c, token("day")), n, { age: "2 hours" });
        },
        async (c) => {
          expect(status(await submit(c, token("day"), { email: "fresh@visitor.example" })), String(n)).toEqual(expected);
        },
      );
    }
    // Older than a day doesn't count.
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "old" });
        await seedRows(c, await linkId(c, token("old")), 60, { age: "25 hours" });
      },
      async (c) => {
        expect(status(await submit(c, token("old"), { email: "fresh@visitor.example" }))).toEqual(OK);
      },
    );
  });

  it("10 per email per link per day: the 11th from one address is rate_limited, another address is fine", async () => {
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "mail" });
        await seedRows(c, await linkId(c, token("mail")), 10, { email: "busy@visitor.example", age: "3 hours" });
      },
      async (c) => {
        expect(status(await submit(c, token("mail"), { email: "BUSY@visitor.example" }))).toEqual({ status: "rate_limited" });
        expect(status(await submit(c, token("mail"), { email: "calm@visitor.example" }))).toEqual(OK);
      },
    );
  });

  it("200 pending visitor ideas in the workspace -> busy; 199 is fine; a held submission counts like any other", async () => {
    for (const [n, expected] of [[199, OK], [200, { status: "busy" }]] as const) {
      await visitor(
        async (c) => {
          await insertLink(c, { tok: "busy" });
          await seedRows(c, null, n);
        },
        async (c) => {
          expect(status(await submit(c, token("busy"), { email: "fresh@visitor.example" })), String(n)).toEqual(expected);
        },
      );
    }
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "heldcount" });
        await c.query("insert into people (workspace_id, name) values ($1, 'Ottoline Brackenridge')", [ws]);
      },
      async (c) => {
        for (let i = 0; i < 5; i++) expect(status(await submit(c, token("heldcount"), { email: `h${i}@visitor.example`, note: "Ask Ottoline Brackenridge" }))).toEqual(OK);
        expect(status(await submit(c, token("heldcount"), { email: "h9@visitor.example" }))).toEqual({ status: "rate_limited" });
      },
    );
  });

  it("two connections submitting to one link at once both finish and the counts hold; an open during a submission waits, then returns ok", async () => {
    const tok = token("concurrent");
    await insertLink(db.client, { tok: "concurrent" });
    const mk = async () => {
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      return c;
    };
    const [a, b, o] = [await mk(), await mk(), await mk()];
    try {
      const anon = async (c: pg.Client) => {
        await c.query("begin");
        await c.query("set local role anon");
        await c.query("select set_config('request.jwt.claims', '', true)");
      };
      await anon(a);
      await anon(b);
      await anon(o);
      expect(status(await submit(a, tok, { email: "a@visitor.example" }))).toEqual(OK);
      // b and o wait for a's row lock on the link.
      const pb = submit(b, tok, { email: "b@visitor.example" });
      // The open ends its transaction as soon as it returns, so it can't hold the link row against b.
      const po = o.query("select public.open_share_link($1) as r", [tok]).then(async (r) => {
        await o.query("commit");
        return r;
      });
      let settled = false;
      void Promise.race([pb, po]).then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await a.query("commit");
      expect(status(await pb)).toEqual(OK);
      await b.query("commit");
      expect(((await po).rows[0].r as Json).status).toBe("ok");
      const n = (await db.client.query("select count(*)::int as n from suggestion_proposals where share_link_id = (select id from share_links where token_hash = $1)", [sha(tok)])).rows[0].n;
      expect(n).toBe(2);
    } finally {
      for (const c of [a, b, o]) await c.end();
      await db.client.query("delete from suggestion_proposals where share_link_id = (select id from share_links where token_hash = $1)", [sha(tok)]);
      await db.client.query("delete from share_links where token_hash = $1", [sha(tok)]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("submit_play_proposal: what a visitor types is held from members and viewers, never refused", () => {
  // People ON and Financials ON for the link: the readers' rules (members and viewers) apply, not the link's.
  const run = async (a: Parameters<typeof submit>[2], o: Opts = {}) => {
    const g = await createUser(db, `txt-${randomUUID().slice(0, 8)}@play.example`, {}, { google: {} });
    const email = (await db.client.query("select email from auth.users where id = $1", [g.id])).rows[0].email as string;
    let out: Outcome | undefined;
    let row: Json | undefined;
    await visitor(
      async (c) => {
        await c.query("insert into people (workspace_id, name) values ($1, 'Ottoline Brackenridge'), ($1, 'Jürgen Müller'), ($1, 'Priya Shah')", [ws]);
        await c.query("insert into clients (workspace_id, name) values ($1, 'Quillfeather Holdings')", [ws]);
        await insertLink(c, { tok: "text", people: true, financials: true, emails: [email], ...o });
      },
      async (c) => {
        out = await submit(c, token("text"), a);
        row = (await rowsOf(c))[0];
      },
      g.claims,
    );
    return { out: status(out!), row: row! };
  };

  it("a clean title, note and name are stored as sent, with no held text", async () => {
    const { out, row } = await run({ title: "Faster proposals", note: "Use a template for the first draft.", name: "Marta Okoye" });
    expect(out).toEqual(OK);
    expect(row).toMatchObject({ title: "Faster proposals", detail: "Use a template for the first draft.", proposer_name: "Marta Okoye", visitor_text: null });
  });

  it("a team member's full name, a surname alone, a dotted form and an umlaut fold in the note: detail null, the original held; title and name untouched", async () => {
    for (const note of ["Ask Ottoline Brackenridge about it", "Brackenridge knows", "per priya.shah", "Mueller said so", "Muller said so", "JÜRGEN müller"]) {
      const { out, row } = await run({ title: "Plain title", note });
      expect(out, note).toEqual(OK);
      expect(row, note).toMatchObject({ title: "Plain title", detail: null, proposer_name: "Marta Okoye", visitor_text: { note } });
    }
  });

  it("a client's whole name in the title: title 'A visitor's idea', original held; one word of it is not held", async () => {
    const held = await run({ title: "Win back Quillfeather Holdings" });
    expect(held.row).toMatchObject({ title: "A visitor's idea", visitor_text: { title: "Win back Quillfeather Holdings" } });
    const word = await run({ title: "Holdings review" });
    expect(word.row).toMatchObject({ title: "Holdings review", visitor_text: null });
  });

  it("an email address or an amount in the note is held: £4,100, 4100 GBP, 4,100 pounds", async () => {
    for (const note of ["write to ops@client.example", "it costs £4,100", "about 4100 GBP a year", "saves 4,100 pounds"]) {
      const { row } = await run({ note });
      expect(row, note).toMatchObject({ detail: null, visitor_text: { note } });
    }
  });

  it("a visitor whose name shares a part with a team member is 'A visitor' to members, original held", async () => {
    const { row } = await run({ name: "Ottoline Okoye" });
    expect(row).toMatchObject({ proposer_name: "A visitor", visitor_text: { name: "Ottoline Okoye" } });
  });

  it("the return value is byte-identical whether or not anything was held", async () => {
    const a = await run({ note: "fine" });
    const b = await run({ note: "Ask Priya Shah" });
    expect(JSON.stringify(a.out)).toBe(JSON.stringify(b.out));
    expect(b.row.visitor_text).not.toBeNull();
  });

  it("members can't select visitor_text or call play_proposal_contacts (42501); an editor reads the held fields and the email", async () => {
    const g = await createUser(db, "txt2@play.example", {}, { google: {} });
    await db.client.query("begin");
    try {
      await db.client.query("insert into people (workspace_id, name) values ($1, 'Ottoline Brackenridge')", [ws]);
      await insertLink(db.client, { tok: "contacts", people: true, emails: ["txt2@play.example"] });
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(g.claims)]);
      expect(status(await submit(db.client, token("contacts"), { note: "Ask Ottoline Brackenridge", title: "Idea", email: "x@x.example" }))).toEqual(OK);
      await db.client.query("reset role");
      const id = (await db.client.query("select id from suggestion_proposals where created_via = 'play_link' and workspace_id = $1", [ws])).rows[0].id;
      for (const role of ["member", "viewer"] as const) {
        await db.client.query("set local role authenticated");
        await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who[role]!.claims)]);
        expect(await attempt(db.client, () => db.client.query("select visitor_text from suggestion_proposals"))).toMatchObject({ ok: false, code: "42501" });
        expect(await attempt(db.client, () => db.client.query("select proposer_email from suggestion_proposals"))).toMatchObject({ ok: false, code: "42501" });
        expect(await attempt(db.client, () => db.client.query("select public.play_proposal_contacts($1)", [ws])), role).toMatchObject({ ok: false, code: "42501" });
        const seen = (await db.client.query("select title, detail, proposer_name, share_link_id from suggestion_proposals where id = $1", [id])).rows[0];
        expect(seen, role).toMatchObject({ detail: null });
        await db.client.query("reset role");
      }
      for (const role of ["editor", "owner", "admin"] as const) {
        await db.client.query("set local role authenticated");
        await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who[role]!.claims)]);
        const contacts = (await db.client.query("select public.play_proposal_contacts($1) as c", [ws])).rows[0].c as Record<string, Json>;
        expect(contacts[id], role).toEqual({ email: "txt2@play.example", held: { note: "Ask Ottoline Brackenridge" } });
        // A workspace the caller can't edit.
        expect(await attempt(db.client, () => db.client.query("select public.play_proposal_contacts($1)", [other])), role).toMatchObject({ ok: role === "admin" });
        await db.client.query("reset role");
      }
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who.otherEditor!.claims)]);
      expect(await attempt(db.client, () => db.client.query("select public.play_proposal_contacts($1)", [ws]))).toMatchObject({ ok: false, code: "42501" });
      await db.client.query("reset role");
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: who.editor!.id, api_token_id: randomUUID() })]);
      expect(await attempt(db.client, () => db.client.query("select public.play_proposal_contacts($1)", [ws]))).toMatchObject({ ok: false, code: "42501", message: "Visitors' emails are shown in the app only." });
    } finally {
      await db.client.query("rollback");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the guard trigger", () => {
  it("an editor inserting play_link, proposer_*, share_link_id and visitor_text directly gets mcp with all of them null; updating share_link_id or visitor_text is 42501", async () => {
    await db.as(who.editor!.claims, async (c) => {
      await c.query(
        `insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id, created_via, proposer_name, proposer_email, share_link_id, visitor_text)
         values ($1, 'solution_idea', 'Forged', '{"steps": []}', $2, 'play_link', 'Someone', 'a@b.example', $3, '{"note": "x"}')`,
        [ws, ids.issue, randomUUID()],
      );
      const row = (await c.query("select created_via, proposer_name, share_link_id, created_by from suggestion_proposals where title = 'Forged'")).rows[0];
      expect(row).toMatchObject({ created_via: "mcp", proposer_name: null, share_link_id: null, created_by: who.editor!.id });
      await c.query("reset role");
      expect((await c.query("select proposer_email, visitor_text from suggestion_proposals where title = 'Forged'")).rows[0]).toEqual({ proposer_email: null, visitor_text: null });
      await c.query("set local role authenticated");
      for (const col of ["share_link_id = gen_random_uuid()", "visitor_text = '{\"note\": \"x\"}'"]) {
        const r = await attempt(c, () => c.query(`update suggestion_proposals set ${col} where title = 'Forged'`));
        expect(r, col).toMatchObject({ ok: false });
      }
    });
    // As the superuser the guard itself refuses a change to the frozen columns.
    await db.client.query("begin");
    try {
      await insertLink(db.client, { tok: "frozen" });
      await db.client.query("set local role anon");
      await submit(db.client, token("frozen"));
      await db.client.query("reset role");
      for (const col of ["share_link_id = gen_random_uuid()", "visitor_text = '{\"note\": \"x\"}'"]) {
        expect(await attempt(db.client, () => db.client.query(`update suggestion_proposals set ${col} where created_via = 'play_link' and workspace_id = $1`, [ws])), col).toMatchObject({ ok: false, code: "42501" });
      }
    } finally {
      await db.client.query("rollback");
    }
  });

  it("an MCP or upload solution idea with no issue is still refused (23514); a play idea with none is fine", async () => {
    await db.client.query("begin");
    try {
      const ins = (via: string) => attempt(db.client, () => db.client.query("insert into suggestion_proposals (workspace_id, kind, title, payload, created_via) values ($1, 'solution_idea', 'No issue', '{\"steps\": []}', $2)", [ws, via]));
      expect(await ins("mcp")).toMatchObject({ ok: false, code: "23514" });
      expect(await ins("upload")).toMatchObject({ ok: false, code: "23514" });
      expect((await ins("play_link")).ok).toBe(true);
      expect(await attempt(db.client, () => db.client.query("insert into suggestion_proposals (workspace_id, kind, title, payload, created_via, issue_id) values ($1, 'issue', 'Has issue', '{}', 'play_link', $2)", [ws, ids.issue]))).toMatchObject({ ok: false, code: "23514" });
    } finally {
      await db.client.query("rollback");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("build_proposal for a visitor's idea", () => {
  const baseBuild = async (c: pg.Client, proposal: string, o: { process?: string; links?: unknown[]; levers?: unknown[] } = {}) =>
    attempt(c, () =>
      c.query("select public.build_proposal($1, $2, $3, $4, 'Built from a visitor', $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) as r", [
        proposal,
        ws,
        o.process ?? NORTHBEAM_PROCESS_ID,
        ids.liveRevision,
        JSON.stringify({ steps: [], edges: [], entry_step_id: null }),
        JSON.stringify([]),
        JSON.stringify(o.levers ?? LEVER),
        JSON.stringify(o.links ?? []),
      ]),
    );

  it("an idea with no issue, p_links [], p_levers its levers: a solution with lever_changes is saved and the idea is built; the wrong process is refused", async () => {
    await visitor(
      async (c) => {
        await insertLink(c, { tok: "build" });
      },
      async (c) => {
        expect(status(await submit(c, token("build")))).toEqual(OK);
        const id = (await rowsOf(c))[0].id as string;
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who.editor!.claims)]);
        await c.query("set local role authenticated");
        const wrong = await baseBuild(c, id, { process: (await c.query("select id from processes where workspace_id = $1 and id <> $2 limit 1", [ws, NORTHBEAM_PROCESS_ID])).rows[0]?.id ?? randomUUID() });
        expect(wrong.ok).toBe(false);
        const built = await baseBuild(c, id);
        expect(built.ok, built.message).toBe(true);
        await c.query("reset role");
        expect((await c.query("select status, applied from suggestion_proposals where id = $1", [id])).rows[0]).toMatchObject({ status: "built" });
        expect((await c.query("select lever_changes from solutions where name = 'Built from a visitor'")).rows[0].lever_changes).toEqual(LEVER);
      },
    );
  });

  it("an MCP idea without its issue in p_links is still refused", async () => {
    await db.as(who.editor!.claims, async (c) => {
      await c.query("insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id) values ($1, 'solution_idea', 'MCP idea', '{\"steps\": []}', $2)", [ws, ids.issue]);
      const id = (await c.query("select id from suggestion_proposals where title = 'MCP idea'")).rows[0].id as string;
      const r = await baseBuild(c, id, { links: [] });
      expect(r).toMatchObject({ ok: false, code: "22023", message: "build_proposal: the solution must be linked to the idea's issue" });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the suggestions delete-user bug (HANDOVER follow-up)", () => {
  it("deleting an auth user who created and reviewed a suggestion succeeds and nulls both columns; any other change at depth 1 is still refused", async () => {
    const maker = await createUser(db, "maker@play.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, maker.id]);
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(maker.claims)]);
      await db.client.query("insert into suggestions (workspace_id, target_table, patch, evidence, note) values ($1, 'roles', '{\"set\":{\"name\":\"X\"}}', '[]', 'bug test')", [ws]);
      await db.client.query("reset role");
      await db.client.query("select set_config('transpera.reviewing', 'on', true)");
      await db.client.query("update suggestions set status = 'rejected', reviewed_by = $1, reviewed_at = now() where note = 'bug test'", [maker.id]);
      expect((await db.client.query("select created_by, reviewed_by from suggestions where note = 'bug test'")).rows[0]).toEqual({ created_by: maker.id, reviewed_by: maker.id });
      // Any other change at depth 1 is still refused.
      expect(await attempt(db.client, () => db.client.query("update suggestions set note = 'changed' where note = 'bug test'"))).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt(db.client, () => db.client.query("update suggestions set created_by = null where note = 'bug test'"))).toMatchObject({ ok: false, code: "42501" });
      await db.client.query("delete from auth.users where id = $1", [maker.id]);
      expect((await db.client.query("select created_by, reviewed_by, status from suggestions where note = 'bug test'")).rows[0]).toEqual({ created_by: null, reviewed_by: null, status: "rejected" });
    } finally {
      await db.client.query("rollback");
    }
  });
});
