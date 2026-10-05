import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCompanyPartVersion, loadLiveCompanyPart, type Db } from "@transpera-flow/db";
import { signJwt } from "./helpers";

// The Overview's "view an old version of the company map" (QA wave 1), as the web app reads it: loadCompanyPartVersion over PostgREST,
// as an editor. A published version (live or earlier) comes back whole; a draft, a number only another process has, and another
// workspace's map all read as not found. Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
let db: Db;
const ids = { ws: "", otherWs: "", company: "", v1: "", v2: "", v3: "", process: "" };

type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0] as Row;

/** A company map in `ws` with its versions: 1 superseded, 2 live, 3 a draft, each holding one card named after it. */
async function companyMap(ws: string, label: string) {
  // A new workspace gets a company map with one published version; replace it with the versions this test needs. The database's
  // rules about how versions are made (published ones are kept, a draft is made before it is published) are switched off for this setup only.
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from steps where process_id in (select id from processes where workspace_id = $1 and is_company)", [ws]);
  await admin.query("delete from process_revisions where process_id in (select id from processes where workspace_id = $1 and is_company)", [ws]);
  await admin.query("delete from processes where workspace_id = $1 and is_company", [ws]);
  const company = (await one("insert into processes (workspace_id, name, is_company) values ($1, 'Company map', true) returning id", [ws])).id as string;
  const out: string[] = [];
  for (const [number, status] of [[1, "superseded"], [2, "published"], [3, "draft"]] as const) {
    const rev = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, $3, $4) returning id", [ws, company, number, status])).id as string;
    await admin.query("insert into steps (revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $2, $3, $4, 'group', 0, 0)", [rev, ws, company, `${label} v${number}`]);
    out.push(rev);
  }
  await admin.query("update processes set live_revision_id = $1, draft_revision_id = $2 where id = $3", [out[1], out[2], company]);
  await admin.query("set session_replication_role = origin");
  return { company, revisions: out };
}

describe.skipIf(!POSTGREST_URL)("viewing an earlier company map over PostgREST (editor)", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Map Co', $1) returning id", [`map-${tag}`])).id as string;
    ids.otherWs = (await one("insert into workspaces (name, slug) values ('Other Co', $1) returning id", [`other-${tag}`])).id as string;
    const editor = randomUUID();
    await admin.query("insert into auth.users (id, email) values ($1, $2)", [editor, `map-editor-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ids.ws, editor]);
    // A process of this workspace with a version number the company map does not have. (Made first: a new process adds a version of the map.)
    ids.process = (await one("insert into processes (workspace_id, name) values ($1, 'Onboarding') returning id", [ids.ws])).id as string;
    const rev = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 7, 'published') returning id", [ids.ws, ids.process])).id as string;
    await admin.query("update processes set live_revision_id = $1 where id = $2", [rev, ids.process]);

    const mine = await companyMap(ids.ws, "Mine");
    await companyMap(ids.otherWs, "Theirs");
    [ids.company, [ids.v1, ids.v2, ids.v3]] = [mine.company, mine.revisions];

    const session = signJwt({ sub: editor, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    // supabase-js talks to <url>/rest/v1; PostgREST here serves from its root.
    db = createClient("http://postgrest.invalid", session, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { authorization: `Bearer ${session}` },
        fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
      },
    }) as unknown as Db;
    const deadline = Date.now() + 60_000;
    while ((await loadLiveCompanyPart(db, ids.ws).catch(() => null)) === null) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  const names = (part: { steps: { name: string }[] } | null) => part?.steps.map((s) => s.name);

  it("gives an earlier published version as it was", async () => {
    const part = await loadCompanyPartVersion(db, ids.ws, 1);
    expect(part?.revision).toMatchObject({ id: ids.v1, number: 1, status: "superseded" });
    expect(names(part)).toEqual(["Mine v1"]);
  });

  it("gives the live map for the live number", async () => {
    const part = await loadCompanyPartVersion(db, ids.ws, 2);
    expect(part?.revision.id).toBe(ids.v2);
    expect(names(part)).toEqual(["Mine v2"]);
    expect(part).toEqual(await loadLiveCompanyPart(db, ids.ws));
  });

  it("does not find a draft", async () => {
    expect(await loadCompanyPartVersion(db, ids.ws, 3)).toBeNull();
  });

  it("does not find a number only another process has, or one that doesn't exist", async () => {
    expect(await loadCompanyPartVersion(db, ids.ws, 7)).toBeNull();
    expect(await loadCompanyPartVersion(db, ids.ws, 99)).toBeNull();
  });

  it("does not find another workspace's map", async () => {
    expect(await loadCompanyPartVersion(db, ids.otherWs, 1)).toBeNull();
    expect(await loadCompanyPartVersion(db, ids.otherWs, 2)).toBeNull();
  });
});
