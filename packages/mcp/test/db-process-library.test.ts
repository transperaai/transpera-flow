import { randomUUID } from "node:crypto";
import type { Db } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@transpera-flow/db/client";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// The process library on the company map (issue #164, B12; migration 20261129500000), as the web app writes it:
// through Kysely under RLS. An editor places processes on the map's draft in one request and takes
// cards off it, publishes, and the processes are byte-identical. A process sits on the map at most once; another workspace's
// process and the company map itself are refused; a viewer and an anonymous caller change nothing;
// a card of a published version is not removable and unlinking by update is refused. Runs on a throwaway database
// (test/helpers.ts).


let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
const rows = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as Row[];

const ids = { ws: "", other: "", company: "", sales: "", delivery: "", support: "", theirs: "", editor: "" };
let editor: Db;
let viewer: Db;
let anon: Db;

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
  const r = await rpc(editor, "open_draft", { target_process: ids.company });
  return (r as { revision_id: string }).revision_id;
};
const card = (rev: string, process: string, name: string, x: number) => ({ id: randomUUID(), revision_id: rev, workspace_id: ids.ws, process_id: ids.company, name, kind: "subprocess", child_process_id: process, x, y: 0 });

describe("the process library", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Library Co', $1) returning id", [`library-${tag}`])).id as string;
    ids.other = (await one("insert into workspaces (name, slug) values ('Other Library Co', $1) returning id", [`library-other-${tag}`])).id as string;
    const [ed, vw] = [randomUUID(), randomUUID()];
    ids.editor = ed;
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `lib-editor-${tag}@example.com`, vw, `lib-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    for (const [key, name, kind, ws] of [["sales", "Sales", "pipeline", ids.ws], ["delivery", "Delivery", "servicing", ids.ws], ["support", "Support", "servicing", ids.ws], ["theirs", "Their process", "pipeline", ids.other]] as const) {
      ids[key] = (await one("insert into processes (workspace_id, name, kind) values ($1, $2, $3) returning id", [ws, name, kind])).id as string;
    }
    ids.company = (await one("select id from processes where workspace_id = $1 and is_company", [ids.ws])).id as string;
    editor = env.dbAs(userClaims(ed));
    viewer = env.dbAs(userClaims(vw));
    anon = env.dbAs(null);
  });

  afterAll(async () => {
    await env?.close();
  });

  it("takes three cards off in one request, places three in one request, publishes, and never touches the processes", async () => {
    const mine = [ids.sales, ids.delivery, ids.support];
    const before = await processState(...mine);
    const draft = await openDraft();
    const cards = await holders(draft);
    expect(cards.map((c) => c.child_process_id).sort()).toEqual([...mine].sort());
    // Remove from the map: the Editor's remove writes (a delete of the cards).
    const removed = await editor.deleteFrom("steps").where("revision_id", "=", draft).where("id", "in", cards.map((c) => c.id as string)).returning("id").execute();
    expect(removed).toHaveLength(3);
    await rpc(editor, "publish_process", { target_process: ids.company, accept_estimates: false });
    expect(await holders((await company()).live_revision_id)).toEqual([]);
    expect(await processState(...mine)).toEqual(before);

    // Add three at once: one insert of three cards.
    const draft2 = await openDraft();
    const placed = await editor.insertInto("steps").values([card(draft2, ids.sales, "Sales", 0), card(draft2, ids.delivery, "Delivery", 240), card(draft2, ids.support, "Support", 480)]).returning("id").execute();
    expect(placed).toHaveLength(3);
    expect(await processState(...mine)).toEqual(before);
    await rpc(editor, "publish_process", { target_process: ids.company, accept_estimates: false });
    expect((await holders((await company()).live_revision_id)).map((h) => h.name)).toEqual(["Delivery", "Sales", "Support"]);
    expect(await processState(...mine)).toEqual(before);
    expect(((await one("select count(*)::int n from processes where id = any($1) and parent_process_id is not null", [mine])).n)).toBe(0);
  });

  it("refuses a second card for a process already on the map, another workspace's process, and the company map", async () => {
    const draft = await openDraft();
    const dup = await errorOf(() => editor.insertInto("steps").values(card(draft, ids.sales, "Sales again", 700)).execute());
    expect(dup?.message).toMatch(/duplicate key|steps_one_holder_per_child/);
    const theirs = await errorOf(() => editor.insertInto("steps").values(card(draft, ids.theirs, "Theirs", 700)).execute());
    expect(theirs).not.toBeNull();
    const self = await errorOf(() => editor.insertInto("steps").values(card(draft, ids.company, "Company map", 700)).execute());
    expect(self).not.toBeNull();
    // A process held by another may be linked in a draft (B12 part 2); publishing is refused (db-process-library-everywhere.test.ts).
    await rpc(editor, "discard_draft", { target_process: ids.company });
  });

  it("refuses removing a card from a published version, and unlinking a card by update", async () => {
    const live = (await company()).live_revision_id;
    const liveCard = (await holders(live))[0]!;
    const del = await errorOf(() => editor.deleteFrom("steps").where("id", "=", liveCard.id as string).where("revision_id", "=", live).execute());
    expect(del).not.toBeNull();
    const draft = await openDraft();
    const draftCard = (await holders(draft))[0]!;
    const unlink = await errorOf(() => editor.updateTable("steps").set({ child_process_id: null }).where("id", "=", draftCard.id as string).where("revision_id", "=", draft).execute());
    expect(unlink?.message).toMatch(/removing its card in a draft/);
    expect((await holders(live)).length).toBe(3);
    await rpc(editor, "discard_draft", { target_process: ids.company });
  });

  it("changes nothing for a viewer or an anonymous caller", async () => {
    const draft = await openDraft();
    const target = (await holders(draft))[0]!;
    const free = await editor.deleteFrom("steps").where("id", "=", target.id as string).where("revision_id", "=", draft).returning("id").execute();
    expect(free).toHaveLength(1);
    const before = await holders(draft);
    const v = await errorOf(() => viewer.insertInto("steps").values(card(draft, target.child_process_id as string, "Back", 900)).execute());
    expect(v).not.toBeNull();
    // A viewer's delete either fails or removes no row.
    const vDelete = await viewer.deleteFrom("steps").where("revision_id", "=", draft).returning("id").execute().then((r) => r.length === 0, () => true);
    expect(vDelete).toBeTruthy();
    const a = await errorOf(() => anon.insertInto("steps").values(card(draft, target.child_process_id as string, "Back", 900)).execute());
    expect(a).not.toBeNull();
    const aDelete = await anon.deleteFrom("steps").where("revision_id", "=", draft).returning("id").execute().then((r) => r.length === 0, () => true);
    expect(aDelete).toBeTruthy();
    expect(await holders(draft)).toEqual(before);
    expect(await rpc(viewer, "publish_process", { target_process: ids.company, accept_estimates: false })).not.toMatchObject({ status: "published" });
    await rpc(editor, "discard_draft", { target_process: ids.company });
  });

  it("keeps Supabase's default privileges in check: the guard function is not callable by clients", async () => {
    // As a signed-in user, straight at the private schema: refused.
    await expect(env.t.as(userClaims(ids.editor), (c) => c.query("select private.company_holder_guard()"))).rejects.toMatchObject({ code: "42501" });
    const grants = await one(
      "select has_function_privilege('anon', 'private.company_holder_guard()', 'execute') as anon_x, has_function_privilege('authenticated', 'private.company_holder_guard()', 'execute') as auth_x",
    );
    expect(grants).toEqual({ anon_x: false, auth_x: false });
  });
});
