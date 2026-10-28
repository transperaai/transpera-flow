import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { LEVER_KIND_IDS } from "../src/share";
import { createTestDb, createUser, type TestDb } from "./harness";

// Play links (issue #33, B4): a visitor tries levers on a shared process, in their browser; nothing is saved. A play link is a
// share link made in `play` mode with the list of lever kinds the workspace hides. (Sending the idea to Suggestions,
// public.submit_play_proposal, was removed 28 Oct 2026 with Suggestions, docs/plans/cut-list.md item 2; its tests went with it.)
// Each test runs in a rolled-back transaction unless it says so.

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
  retiredStep: "",
  issue: "",
  resolvedIssue: "",
  detectedIssue: "",
  otherProcessIssue: "",
  foreignIssue: "",
};

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

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const member = async (email: string, role: string) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, u.id, role]);
    return u;
  };
  who.owner = await member("owner@play.example", "owner");
  who.editor = await member("editor@play.example", "editor");
  who.member = await member("member@play.example", "member");
  who.viewer = await member("viewer@play.example", "viewer");
  who.admin = await createUser(db, "admin@play.example", { agency_admin: true });
  who.otherEditor = await createUser(db, "other-editor@play.example");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [other, who.otherEditor.id]);

  const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0]?.id as string;
  ids.liveRevision = (await db.client.query("select live_revision_id from processes where id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].live_revision_id;
  ids.step = await one("select id from steps where revision_id = $1 order by id limit 1", [ids.liveRevision]);
  ids.stepOther = await one("select id from steps where workspace_id = $1 and revision_id <> $2 order by id limit 1", [ws, ids.liveRevision]);
  if (!ids.stepOther) ids.stepOther = await one("select id from steps where revision_id = $1 order by id offset 1 limit 1", [ids.liveRevision]);
  ids.unseenStep = await one("select id from steps where workspace_id = $1 and id not in ($2, $3) order by id desc limit 1", [ws, ids.step, ids.stepOther]);
  ids.retiredStep = await one("select id from steps where workspace_id = $1 and id not in ($2, $3, $4) order by id limit 1 offset 1", [ws, ids.step, ids.stepOther, ids.unseenStep]);
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

  it("hiddenLevers is refused anywhere but the top: a copy nested under another key can't carry a name past the checks (23514)", async () => {
    await db.client.query("begin");
    try {
      const person = (await db.client.query("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws])).rows[0].name as string;
      for (const nested of [{ x: { hiddenLevers: person } }, { bundle: { revision: { id: ids.liveRevision }, steps: [{ id: ids.step }], roles: [], people: [], services: [], hiddenLevers: [person] } }, { deep: [{ a: { hiddenLevers: ["process.wait"] } }] }]) {
        const r = await attempt(db.client, () => insertLink(db.client, { tok: "nested", extraSnapshot: nested }));
        expect(r, JSON.stringify(nested)).toMatchObject({ ok: false, code: "23514", message: "The snapshot doesn't match the link." });
      }
      // The same string under an ordinary key is a name, as before; and the top-level key still works.
      expect(await attempt(db.client, () => insertLink(db.client, { tok: "nested2", extraSnapshot: { notes: person } }))).toMatchObject({ ok: false, code: "23514", message: "The snapshot names a person." });
      expect((await attempt(db.client, () => insertLink(db.client, { tok: "nested3", snapshot: snapshot({ hidden: ["process.wait"] }) }))).ok).toBe(true);
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
