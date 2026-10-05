import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./helpers";

// Versions and provenance hardened for every process (issue #171, migration 20261128500000), as an editor writing the tables
// directly over PostgREST: history, the version pointers and `created_by` / `created_at` / `source` are refused (SQLSTATE 55000);
// the functions the app calls (open_draft, publish_process, discard_draft, restore_version, duplicate_version) still work. Runs in a
// workspace of its own against the database postgrest-db.ts prepares. Skipped unless POSTGREST_URL is set.

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
let editorId: string;
let session: string;
const ids = { ws: "", proc: "", other: "", v1: "", v2: "", v3: "", otherPublished: "" };

type Row = Record<string, unknown>;

async function rest(method: string, path: string, body?: unknown) {
  const res = await fetch(`${POSTGREST_URL}/${path}`, {
    method,
    headers: { authorization: `Bearer ${session}`, apikey: session, "content-type": "application/json", prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Row | Row[] | null };
}

/** The write is refused by the database's rule (not by row-level security): 4xx with SQLSTATE 55000 and our message. */
async function expectRefused(method: string, path: string, body: unknown, message: RegExp) {
  const r = await rest(method, path, body);
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  expect((r.json as Row).code).toBe("55000");
  expect(String((r.json as Row).message)).toMatch(message);
}

const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0] as Row;
const processRow = () => one("select live_revision_id, draft_revision_id, created_by, created_at, source, name from processes where id = $1", [ids.proc]);
const statusOf = async (id: string) => (await one("select status from process_revisions where id = $1", [id])).status;

describe.skipIf(!POSTGREST_URL)("process versions and provenance over PostgREST (editor, direct writes)", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();

    const slug = `harden-${randomUUID().slice(0, 8)}`;
    ids.ws = (await one("insert into workspaces (name, slug) values ('Harden Co', $1) returning id", [slug])).id as string;
    editorId = randomUUID();
    await admin.query("insert into auth.users (id, email) values ($1, $2)", [editorId, `harden-editor-${slug}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ids.ws, editorId]);
    session = signJwt({ sub: editorId, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);

    const rev = async (proc: string, number: number, status: string) =>
      (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, $3, $4) returning id", [ids.ws, proc, number, status])).id as string;
    ids.proc = (await one("insert into processes (workspace_id, name, created_by) values ($1, 'Lead to cash', null) returning id", [ids.ws])).id as string;
    ids.v1 = await rev(ids.proc, 1, "superseded");
    ids.v2 = await rev(ids.proc, 2, "published");
    ids.v3 = await rev(ids.proc, 3, "draft");
    await admin.query("update processes set live_revision_id = $1, draft_revision_id = $2 where id = $3", [ids.v2, ids.v3, ids.proc]);
    ids.other = (await one("insert into processes (workspace_id, name) values ($1, 'Onboarding') returning id", [ids.ws])).id as string;
    ids.otherPublished = await rev(ids.other, 1, "published");
    await admin.query("update processes set live_revision_id = $1 where id = $2", [ids.otherPublished, ids.other]);

    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await fetch(`${POSTGREST_URL}/processes?select=id&id=eq.${ids.proc}`, { headers: { authorization: `Bearer ${session}` } }).catch(() => null);
      if (res?.status === 200 && (await res.json()).length === 1) break;
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("refuses deleting a superseded or a published version", async () => {
    await expectRefused("DELETE", `process_revisions?id=eq.${ids.v1}`, undefined, /Published versions are kept/);
    await expectRefused("DELETE", `process_revisions?id=eq.${ids.v2}`, undefined, /Published versions are kept/);
    expect(await statusOf(ids.v1)).toBe("superseded");
    expect(await statusOf(ids.v2)).toBe("published");
  });

  it("refuses setting the live version back to a draft, or a superseded one to published", async () => {
    await expectRefused("PATCH", `process_revisions?id=eq.${ids.v2}`, { status: "draft" }, /can't change status/);
    await expectRefused("PATCH", `process_revisions?id=eq.${ids.v1}`, { status: "published" }, /can't change status/);
    await expectRefused("PATCH", `process_revisions?id=eq.${ids.v1}`, { status: "draft" }, /can't change status/);
    expect(await statusOf(ids.v2)).toBe("published");
  });

  it("refuses inserting a published or superseded version", async () => {
    for (const status of ["superseded", "published"]) {
      await expectRefused("POST", "process_revisions", { workspace_id: ids.ws, process_id: ids.proc, number: 50, status }, /starts as a draft/);
    }
    expect((await one("select count(*)::int as n from process_revisions where process_id = $1", [ids.proc])).n).toBe(3);
  });

  it("refuses publishing a draft directly while another version is published", async () => {
    await expectRefused("PATCH", `process_revisions?id=eq.${ids.v3}`, { status: "published" }, /one published version/);
    expect(await statusOf(ids.v3)).toBe("draft");
  });

  it("refuses pointing live at an old or draft version, or at another process's version, and clearing it", async () => {
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { live_revision_id: ids.v1 }, /published version/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { live_revision_id: ids.v3 }, /published version/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { live_revision_id: ids.otherPublished }, /published version/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { live_revision_id: null }, /keeps its live version/);
    expect((await processRow()).live_revision_id).toBe(ids.v2);
  });

  it("refuses pointing the draft at a published version or another process's version", async () => {
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { draft_revision_id: ids.v2 }, /own drafts/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { draft_revision_id: ids.otherPublished }, /own drafts/);
    expect((await processRow()).draft_revision_id).toBe(ids.v3);
  });

  it("refuses rewriting created_by, created_at and source", async () => {
    const before = await processRow();
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { created_by: editorId }, /Who made a process/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { created_at: "2020-01-01T00:00:00Z" }, /Who made a process/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { source: "import" }, /Who made a process/);
    await expectRefused("PATCH", `processes?id=eq.${ids.proc}`, { name: "Renamed", source: "template" }, /Who made a process/);
    expect(await processRow()).toEqual(before);
  });

  it("still lets the editor change an ordinary column and a draft", async () => {
    const renamed = await rest("PATCH", `processes?id=eq.${ids.proc}`, { description: "Edited by an editor" });
    expect(renamed.status).toBe(200);
    const draft = await rest("PATCH", `process_revisions?id=eq.${ids.v3}`, { layout: { note: "ok" } });
    expect(draft.status).toBe(200);
  });

  it("keeps the app's flows working: open, discard, open, publish, restore, duplicate", async () => {
    const call = async (fn: string, args: Row) => {
      const r = await rest("POST", `rpc/${fn}`, args);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json as Row;
    };
    expect((await call("discard_draft", { target_process: ids.proc })).status).toBe("discarded");
    const opened = await call("open_draft", { target_process: ids.proc });
    expect(opened.status).toBe("ok");
    const draft = opened.revision_id as string;
    expect((await call("publish_process", { target_process: ids.proc, accept_estimates: true })).status).toBe("published");
    expect((await processRow()).live_revision_id).toBe(draft);
    expect(await statusOf(ids.v2)).toBe("superseded");
    expect((await call("restore_version", { target_process: ids.proc, source_revision: ids.v1 })).status).toBe("restored");
    expect((await call("duplicate_version", { source_revision: draft, new_name: "Lead to cash copy" })).status).toBe("duplicated");
    expect((await call("publish_process", { target_process: ids.proc, accept_estimates: true })).status).toBe("published");
  });
});
