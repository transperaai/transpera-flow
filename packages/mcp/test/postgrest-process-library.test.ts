import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./helpers";

// The process library on the company map (issue #164, B12; migration 20261129500000), as the web app writes it: over PostgREST
// with Supabase's default table privileges and RLS. An editor places processes on the map's draft in one request and takes
// cards off it, publishes, and the processes are byte-identical. A process sits on the map at most once; another workspace's
// process, the company map itself and a process held by another are refused; a viewer and an anonymous caller change nothing;
// a card of a published version is not removable and unlinking by update is refused. Skipped unless POSTGREST_URL is set
// (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
const rows = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as Row[];

const ids = { ws: "", other: "", company: "", sales: "", delivery: "", support: "", theirs: "" };
let editor: SupabaseClient;
let viewer: SupabaseClient;
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

const processState = (...pids: string[]) =>
  Promise.all([
    rows("select * from processes where id = any($1) order by id", [pids]),
    rows("select * from process_revisions where process_id = any($1) order by id", [pids]),
    rows("select * from steps where process_id = any($1) order by revision_id, id", [pids]),
    rows("select * from edges where process_id = any($1) order by revision_id, id", [pids]),
  ]);

const company = async () => (await one("select live_revision_id, draft_revision_id from processes where id = $1", [ids.company])) as { live_revision_id: string; draft_revision_id: string | null };
const holders = async (rev: string) => rows("select id, child_process_id, name from steps where revision_id = $1 and child_process_id is not null order by name", [rev]);
const openDraft = async () => {
  const r = await editor.rpc("open_draft", { target_process: ids.company });
  expect(r.error).toBeNull();
  return (r.data as { revision_id: string }).revision_id;
};
const card = (rev: string, process: string, name: string, x: number) => ({ id: randomUUID(), revision_id: rev, workspace_id: ids.ws, process_id: ids.company, name, kind: "subprocess", child_process_id: process, x, y: 0 });

describe.skipIf(!POSTGREST_URL)("the process library over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Library Co', $1) returning id", [`library-${tag}`])).id as string;
    ids.other = (await one("insert into workspaces (name, slug) values ('Other Library Co', $1) returning id", [`library-other-${tag}`])).id as string;
    const [ed, vw] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `lib-editor-${tag}@example.com`, vw, `lib-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    for (const [key, name, kind, ws] of [["sales", "Sales", "pipeline", ids.ws], ["delivery", "Delivery", "servicing", ids.ws], ["support", "Support", "servicing", ids.ws], ["theirs", "Their process", "pipeline", ids.other]] as const) {
      ids[key] = (await one("insert into processes (workspace_id, name, kind) values ($1, $2, $3) returning id", [ws, name, kind])).id as string;
    }
    ids.company = (await one("select id from processes where workspace_id = $1 and is_company", [ids.ws])).id as string;
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editor = client(token(ed));
    viewer = client(token(vw));
    anon = client(signJwt({ role: "anon" }, JWT_SECRET));
    const deadline = Date.now() + 60_000;
    while ((await editor.from("processes").select("id").eq("id", ids.company)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("takes three cards off in one request, places three in one request, publishes, and never touches the processes", async () => {
    const mine = [ids.sales, ids.delivery, ids.support];
    const before = await processState(...mine);
    const draft = await openDraft();
    const cards = await holders(draft);
    expect(cards.map((c) => c.child_process_id).sort()).toEqual([...mine].sort());
    // Remove from the map: the Editor's remove writes (a delete of the cards).
    const removed = await editor.from("steps").delete().eq("revision_id", draft).in("id", cards.map((c) => c.id as string)).select("id");
    expect(removed.error).toBeNull();
    expect(removed.data).toHaveLength(3);
    expect((await editor.rpc("publish_process", { target_process: ids.company, accept_estimates: false })).error).toBeNull();
    expect(await holders((await company()).live_revision_id)).toEqual([]);
    expect(await processState(...mine)).toEqual(before);

    // Add three at once: one insert of three cards.
    const draft2 = await openDraft();
    const placed = await editor.from("steps").insert([card(draft2, ids.sales, "Sales", 0), card(draft2, ids.delivery, "Delivery", 240), card(draft2, ids.support, "Support", 480)]).select("id");
    expect(placed.error).toBeNull();
    expect(placed.data).toHaveLength(3);
    expect(await processState(...mine)).toEqual(before);
    expect((await editor.rpc("publish_process", { target_process: ids.company, accept_estimates: false })).error).toBeNull();
    expect((await holders((await company()).live_revision_id)).map((h) => h.name)).toEqual(["Delivery", "Sales", "Support"]);
    expect(await processState(...mine)).toEqual(before);
    expect(((await one("select count(*)::int n from processes where id = any($1) and parent_process_id is not null", [mine])).n)).toBe(0);
  });

  it("refuses a second card for a process already on the map, another workspace's process, the company map, and a process inside another", async () => {
    const draft = await openDraft();
    const dup = await editor.from("steps").insert(card(draft, ids.sales, "Sales again", 700));
    expect(dup.error?.message).toMatch(/duplicate key|steps_one_holder_per_child/);
    const theirs = await editor.from("steps").insert(card(draft, ids.theirs, "Theirs", 700));
    expect(theirs.error).not.toBeNull();
    const self = await editor.from("steps").insert(card(draft, ids.company, "Company map", 700));
    expect(self.error).not.toBeNull();
    // A process held by another is not placeable (take its card off first so the refusal is about nesting).
    await admin.query("update processes set parent_process_id = $2 where id = $1", [ids.support, ids.sales]);
    const supportCard = (await holders(draft)).find((h) => h.child_process_id === ids.support);
    if (supportCard) expect((await editor.from("steps").delete().eq("id", supportCard.id as string)).error).toBeNull();
    const nested = await editor.from("steps").insert(card(draft, ids.support, "Support", 700));
    expect(nested.error).not.toBeNull();
    await admin.query("update processes set parent_process_id = null where id = $1", [ids.support]);
    expect((await editor.rpc("discard_draft", { target_process: ids.company })).error).toBeNull();
  });

  it("refuses removing a card from a published version, and unlinking a card by update", async () => {
    const live = (await company()).live_revision_id;
    const liveCard = (await holders(live))[0]!;
    const del = await editor.from("steps").delete().eq("id", liveCard.id as string).eq("revision_id", live);
    expect(del.error).not.toBeNull();
    const draft = await openDraft();
    const draftCard = (await holders(draft))[0]!;
    const unlink = await editor.from("steps").update({ child_process_id: null }).eq("id", draftCard.id as string).eq("revision_id", draft);
    expect(unlink.error?.message).toMatch(/removing its card in a draft/);
    expect((await holders(live)).length).toBe(3);
    expect((await editor.rpc("discard_draft", { target_process: ids.company })).error).toBeNull();
  });

  it("changes nothing for a viewer or an anonymous caller", async () => {
    const draft = await openDraft();
    const target = (await holders(draft))[0]!;
    const free = await editor.from("steps").delete().eq("id", target.id as string).eq("revision_id", draft).select("id");
    expect(free.data).toHaveLength(1);
    const before = await holders(draft);
    const v = await viewer.from("steps").insert(card(draft, target.child_process_id as string, "Back", 900));
    expect(v.error).not.toBeNull();
    const vDelete = await viewer.from("steps").delete().eq("revision_id", draft).select("id");
    expect(vDelete.error ?? vDelete.data?.length === 0).toBeTruthy();
    const a = await anon.from("steps").insert(card(draft, target.child_process_id as string, "Back", 900));
    expect(a.error).not.toBeNull();
    const aDelete = await anon.from("steps").delete().eq("revision_id", draft).select("id");
    expect(aDelete.error ?? aDelete.data?.length === 0).toBeTruthy();
    expect(await holders(draft)).toEqual(before);
    expect((await viewer.rpc("publish_process", { target_process: ids.company, accept_estimates: false })).data).not.toMatchObject({ status: "published" });
    expect((await editor.rpc("discard_draft", { target_process: ids.company })).error).toBeNull();
  });

  it("keeps Supabase's default privileges in check: the guard function is not callable by clients", async () => {
    const r = await editor.schema("private" as never).rpc("company_holder_guard");
    expect(r.error).not.toBeNull();
    const grants = await one(
      "select has_function_privilege('anon', 'private.company_holder_guard()', 'execute') as anon_x, has_function_privilege('authenticated', 'private.company_holder_guard()', 'execute') as auth_x",
    );
    expect(grants).toEqual({ anon_x: false, auth_x: false });
  });
});
