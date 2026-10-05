import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./helpers";

// The Sources library and the editor tour (issue #176, B18; migration 20261130500000), as the web app calls them: over PostgREST
// with Supabase's default table privileges and RLS. `search_sources` matches every word as plain text over title, speakers and
// text, filters, sorts and pages, and never returns a full text; another workspace's member sees nothing and anon is refused.
// `user_tours` holds a person's dismissed tours: their own rows only. The widened `sources_kind` check allows the new kinds.
// Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", other: "", sales: "", delivery: "", editor: "", outsider: "" };
const src: Record<string, string> = {};
let editor: SupabaseClient;
let outsider: SupabaseClient;
let anon: SupabaseClient;

function client(token: string): SupabaseClient {
  return createClient("http://postgrest.invalid", token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { authorization: `Bearer ${token}` },
      fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
    },
  });
}

interface Listed {
  id: string;
  title: string;
  kind: string;
  excerpt: string;
  has_body: boolean;
  total: number;
  body?: unknown;
}
const search = async (c: SupabaseClient, args: Record<string, unknown> = {}, ws = ids.ws) => {
  const r = await c.rpc("search_sources", { p_workspace: ws, ...args });
  return { error: r.error, rows: (r.data ?? []) as Listed[] };
};
const titles = (rows: Listed[]) => rows.map((r) => r.title);

const LONG = `${"The intake form goes back and forth. ".repeat(100)}Then the refund policy is checked by Dana. ${"More words follow. ".repeat(100)}`;

describe.skipIf(!POSTGREST_URL)("the sources library over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Sources Lib Co', $1) returning id", [`srclib-${tag}`])).id as string;
    ids.other = (await one("insert into workspaces (name, slug) values ('Other Sources Co', $1) returning id", [`srclib-other-${tag}`])).id as string;
    [ids.editor, ids.outsider] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ids.editor, `src-editor-${tag}@example.com`, ids.outsider, `src-out-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($3, $4, 'editor')", [ids.ws, ids.editor, ids.other, ids.outsider]);
    for (const [key, name] of [["sales", "Sales"], ["delivery", "Delivery"]] as const) {
      ids[key] = (await one("insert into processes (workspace_id, name, kind) values ($1, $2, 'pipeline') returning id", [ids.ws, name])).id as string;
    }
    const add = async (key: string, kind: string, title: string, speakers: string[], recorded: string | null, body: string | null) => {
      src[key] = (await one("insert into sources (workspace_id, kind, title, speakers, recorded_at, body) values ($1, $2, $3, $4, $5, $6) returning id", [ids.ws, kind, title, speakers, recorded, body])).id as string;
    };
    await add("kickoff", "transcript", "Kickoff call", ["Maya Collins", "Rosa Diaz"], "2026-09-01", "We talked about onboarding and how long approvals take.");
    await add("sop", "sop", "Refund SOP", [], "2026-09-10", LONG);
    await add("sheet", "spreadsheet", "Lead export", ["Tom Reed"], "2026-09-20", "100% of rows, 50% duplicates; it's \"messy\", (really), a_b, a,b");
    await add("notes", "notes", "Ops notes", ["Leah Brooks"], null, null);
    await add("other", "other", "Zebra whiteboard", [], "2026-08-01", "");
    await admin.query("insert into sources (workspace_id, kind, title, body) values ($1, 'transcript', 'Theirs only', 'refund policy') ", [ids.other]);
    await admin.query("insert into source_links (workspace_id, source_id, kind, process_id) values ($1, $2, 'process', $3), ($1, $4, 'process', $5)", [ids.ws, src.kickoff, ids.sales, src.sop, ids.delivery]);
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editor = client(token(ids.editor));
    outsider = client(token(ids.outsider));
    anon = client(signJwt({ role: "anon" }, JWT_SECRET));
    const deadline = Date.now() + 60_000;
    while ((await editor.from("sources").select("id").eq("id", src.kickoff)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("lists every source with its total, newest first (a source with no date counts as the day it was added), without any full text", async () => {
    const { error, rows } = await search(editor);
    expect(error).toBeNull();
    expect(titles(rows)).toEqual(["Ops notes", "Lead export", "Refund SOP", "Kickoff call", "Zebra whiteboard"]);
    expect(rows.every((r) => r.total === 5)).toBe(true);
    // No row has a `body`, and the long text came back only as a short excerpt.
    expect(rows.every((r) => !("body" in r))).toBe(true);
    const sop = rows.find((r) => r.title === "Refund SOP")!;
    expect(LONG.length).toBeGreaterThan(5000);
    expect(sop.excerpt.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(rows).length).toBeLessThan(5000);
    expect(sop.has_body).toBe(true);
    expect(rows.find((r) => r.title === "Ops notes")!.has_body).toBe(false);
    expect(rows.find((r) => r.title === "Zebra whiteboard")!.has_body).toBe(false);
  });

  it("matches every word against the title, the speakers and the text, in any case", async () => {
    expect(titles((await search(editor, { p_search: "kickoff" })).rows)).toEqual(["Kickoff call"]);
    expect(titles((await search(editor, { p_search: "rosa" })).rows)).toEqual(["Kickoff call"]);
    expect(titles((await search(editor, { p_search: "APPROVALS onboarding" })).rows)).toEqual(["Kickoff call"]);
    expect(titles((await search(editor, { p_search: "approvals refund" })).rows)).toEqual([]);
    // A word only the text has: the excerpt is around it, not the start of the text.
    const hit = (await search(editor, { p_search: "dana" })).rows;
    expect(titles(hit)).toEqual(["Refund SOP"]);
    expect(hit[0]!.excerpt.toLowerCase()).toContain("dana");
    expect(hit[0]!.total).toBe(1);
    // Another workspace's text is never searched.
    expect(titles((await search(editor, { p_search: "refund policy" })).rows)).toEqual(["Refund SOP"]);
  });

  it("treats the search as plain text: wildcards, quotes, commas and brackets match themselves and break nothing", async () => {
    for (const [q, expected] of [
      ["50%", ["Lead export"]],
      ["%", ["Lead export"]],
      ["_", ["Lead export"]],
      ["a_b", ["Lead export"]],
      ['"messy",', ["Lead export"]],
      ["(really),", ["Lead export"]],
      ["a,b", ["Lead export"]],
      ["x') or true --", []],
      ["\\", []],
    ] as const) {
      const { error, rows } = await search(editor, { p_search: q });
      expect(error, q).toBeNull();
      expect(titles(rows), q).toEqual(expected);
    }
  });

  it("filters by kind, by process and by 'linked to nothing'", async () => {
    expect(titles((await search(editor, { p_kind: "sop" })).rows)).toEqual(["Refund SOP"]);
    expect(titles((await search(editor, { p_kind: "other" })).rows)).toEqual(["Zebra whiteboard"]);
    expect(titles((await search(editor, { p_process: ids.sales })).rows)).toEqual(["Kickoff call"]);
    expect(titles((await search(editor, { p_process: ids.delivery })).rows)).toEqual(["Refund SOP"]);
    expect(titles((await search(editor, { p_unlinked: true })).rows)).toEqual(["Ops notes", "Lead export", "Zebra whiteboard"]);
    expect(titles((await search(editor, { p_unlinked: true, p_kind: "notes" })).rows)).toEqual(["Ops notes"]);
    expect(titles((await search(editor, { p_unlinked: true, p_process: ids.sales })).rows)).toEqual([]);
  });

  it("sorts by date or title, both ways", async () => {
    expect(titles((await search(editor, { p_sort: "oldest" })).rows).slice(0, 2)).toEqual(["Zebra whiteboard", "Kickoff call"]);
    expect(titles((await search(editor, { p_sort: "title" })).rows)).toEqual(["Kickoff call", "Lead export", "Ops notes", "Refund SOP", "Zebra whiteboard"]);
    expect(titles((await search(editor, { p_sort: "title-desc" })).rows)).toEqual(["Zebra whiteboard", "Refund SOP", "Ops notes", "Lead export", "Kickoff call"]);
  });

  it("pages: a page at a time, no row twice, the total on every page", async () => {
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const { rows } = await search(editor, { p_limit: 2, p_offset: offset, p_sort: "title" });
      expect(rows.length).toBe(offset === 4 ? 1 : 2);
      expect(rows.every((r) => r.total === 5)).toBe(true);
      seen.push(...titles(rows));
    }
    expect(seen).toEqual(["Kickoff call", "Lead export", "Ops notes", "Refund SOP", "Zebra whiteboard"]);
    expect((await search(editor, { p_limit: 2, p_offset: 10 })).rows).toEqual([]);
    // A page can't be asked to be huge or negative.
    expect((await search(editor, { p_limit: 100000 })).rows.length).toBe(5);
    expect((await search(editor, { p_limit: -4, p_offset: -9 })).rows.length).toBe(1);
  });

  it("shows another workspace's member nothing, and refuses anon", async () => {
    expect((await search(outsider)).rows).toEqual([]);
    expect((await search(outsider, { p_search: "refund" })).rows).toEqual([]);
    expect((await search(outsider, {}, ids.other)).rows.map((r) => r.title)).toEqual(["Theirs only"]);
    expect((await search(editor, {}, ids.other)).rows).toEqual([]);
    const refused = await search(anon);
    expect(refused.error).not.toBeNull();
    expect(refused.rows).toEqual([]);
  });

  it("reads a full text on its own: a member can, another workspace's member and anon cannot", async () => {
    const read = (c: SupabaseClient) => c.from("sources").select("body").eq("id", src.sop);
    expect((await read(editor)).data).toEqual([{ body: LONG }]);
    expect((await read(outsider)).data).toEqual([]);
    expect((await read(anon)).data ?? []).toEqual([]);
  });

  it("accepts the new kinds and still refuses an unknown one", async () => {
    for (const kind of ["transcript", "notes", "sop", "spreadsheet", "data", "screenshot", "other"]) {
      const r = await editor.from("sources").insert({ workspace_id: ids.ws, kind, title: `Kind ${kind}` }).select("kind");
      expect(r.error, kind).toBeNull();
      expect(r.data).toEqual([{ kind }]);
    }
    const bad = await editor.from("sources").insert({ workspace_id: ids.ws, kind: "video", title: "Kind video" });
    expect(bad.error?.code).toBe("23514");
  });
});

describe.skipIf(!POSTGREST_URL)("tour state over PostgREST", () => {
  let a: SupabaseClient;
  let b: SupabaseClient;
  let anonymous: SupabaseClient;
  let aId = "";
  let bId = "";

  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    [aId, bId] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [aId, `tour-a-${tag}@example.com`, bId, `tour-b-${tag}@example.com`]);
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    a = client(token(aId));
    b = client(token(bId));
    anonymous = client(signJwt({ role: "anon" }, JWT_SECRET));
    const deadline = Date.now() + 60_000;
    while ((await a.from("user_tours").select("tour")).error) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("remembers a dismissed tour for the person, once however often it is dismissed", async () => {
    expect((await a.from("user_tours").select("tour")).data).toEqual([]);
    for (let i = 0; i < 2; i++) {
      const r = await a.from("user_tours").upsert({ tour: "process" }, { onConflict: "user_id,tour", ignoreDuplicates: true });
      expect(r.error).toBeNull();
    }
    expect((await a.from("user_tours").select("tour")).data).toEqual([{ tour: "process" }]);
    expect(Number((await one("select count(*)::int n from user_tours where user_id = $1", [aId])).n)).toBe(1);
  });

  it("shows another person none of it, and lets them dismiss on their own", async () => {
    expect((await b.from("user_tours").select("tour")).data).toEqual([]);
    expect((await b.from("user_tours").upsert({ tour: "company" }, { onConflict: "user_id,tour" })).error).toBeNull();
    expect((await b.from("user_tours").select("tour")).data).toEqual([{ tour: "company" }]);
    expect((await a.from("user_tours").select("tour")).data).toEqual([{ tour: "process" }]);
  });

  it("refuses writing, changing or removing another person's row", async () => {
    const forged = await b.from("user_tours").insert({ user_id: aId, tour: "company" });
    expect(forged.error?.code).toBe("42501");
    const changed = await b.from("user_tours").update({ dismissed_at: "2020-01-01T00:00:00Z" }).eq("user_id", aId).select();
    expect(changed.data).toEqual([]);
    const removed = await b.from("user_tours").delete().eq("user_id", aId).select();
    expect(removed.data).toEqual([]);
    expect(Number((await one("select count(*)::int n from user_tours where user_id = $1", [aId])).n)).toBe(1);
  });

  it("refuses an unknown tour and anon", async () => {
    expect((await a.from("user_tours").insert({ tour: "everything" })).error?.code).toBe("23514");
    expect((await anonymous.from("user_tours").select("tour")).error).not.toBeNull();
    expect((await anonymous.from("user_tours").insert({ user_id: aId, tour: "company" })).error).not.toBeNull();
    expect((await anonymous.from("user_tours").delete().eq("user_id", aId)).error).not.toBeNull();
    expect(Number((await one("select count(*)::int n from user_tours where user_id = $1", [aId])).n)).toBe(1);
  });
});
