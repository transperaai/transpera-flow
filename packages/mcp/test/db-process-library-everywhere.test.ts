import { randomUUID } from "node:crypto";
import type { Db } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@transpera-flow/db/client";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// The process library in every editor (issue #164, B12 part 2; migration 20261130000000), as the web app writes it:
// through Kysely under RLS. "New process" (`create_library_process`) makes a process on no
// map; an editor links processes into an ORDINARY process's draft in one request, publishes, and the linked processes are
// byte-identical. Publishing refuses a process that already sits somewhere (on the company map or inside another process),
// naming where, and a loop. Another workspace's process is refused; a viewer and an anonymous caller change and read nothing.
// Runs on a throwaway database (test/helpers.ts).


let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
const rows = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as Row[];

const ids = { ws: "", other: "", company: "", theirs: "" };
const p: Record<string, string> = {};
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

const openDraft = async (target: string) => {
  const r = await rpc(editor, "open_draft", { target_process: target });
  return (r as { revision_id: string }).revision_id;
};
const publish = (target: string) => rpc(editor, "publish_process", { target_process: target, accept_estimates: false });
const discard = async (target: string) => void (await rpc(editor, "discard_draft", { target_process: target }));
const link = (rev: string, holder: string, child: string, name: string, x: number) => ({ id: randomUUID(), revision_id: rev, workspace_id: ids.ws, process_id: holder, name, kind: "subprocess", child_process_id: child, x, y: 0 });
const placements = (c: Db) => c.selectFrom("process_placements").select(["process_id", "holder_process_id", "holder_name"]).where("workspace_id", "=", ids.ws).orderBy("process_id").execute();

describe("the process library in every editor", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Everywhere Co', $1) returning id", [`everywhere-${tag}`])).id as string;
    ids.other = (await one("insert into workspaces (name, slug) values ('Other Everywhere Co', $1) returning id", [`everywhere-other-${tag}`])).id as string;
    const [ed, vw] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `ev-editor-${tag}@example.com`, vw, `ev-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    ids.theirs = (await one("insert into processes (workspace_id, name, kind) values ($1, 'Their process', 'pipeline') returning id", [ids.other])).id as string;
    ids.company = (await one("select id from processes where workspace_id = $1 and is_company", [ids.ws])).id as string;
    editor = env.dbAs(userClaims(ed));
    viewer = env.dbAs(userClaims(vw));
    anon = env.dbAs(null);
    // "New process" for each, as the library makes them, then published once (empty) so it has a live version.
    for (const name of ["Sales", "Onboarding", "Delivery", "Support"]) {
      const made = await rpc(editor, "create_library_process", { p_workspace: ids.ws, p_name: name, p_kind: "servicing" });
      expect(made).toMatchObject({ status: "created" });
      p[name] = (made as { process_id: string }).process_id;
      await openDraft(p[name]!);
      await publish(p[name]!);
    }
  });

  afterAll(async () => {
    await env?.close();
  });

  it("makes new processes on no map (the company map gives them no card)", async () => {
    const live = (await one("select live_revision_id from processes where id = $1", [ids.company])).live_revision_id as string;
    expect((await one("select count(*)::int n from steps where revision_id = $1 and child_process_id is not null", [live])).n).toBe(0);
    expect(await placements(editor)).toEqual([]);
  });

  it("links two processes into an ordinary process's draft in one request, publishes, and never touches them", async () => {
    const held = [p.Sales!, p.Delivery!];
    const before = await processState(...held);
    const draft = await openDraft(p.Onboarding!);
    const placed = await editor.insertInto("steps").values([link(draft, p.Onboarding!, p.Sales!, "Sales", 0), link(draft, p.Onboarding!, p.Delivery!, "Delivery", 240)]).returning("id").execute();
    expect(placed).toHaveLength(2);
    expect(await processState(...held)).toEqual(before);
    const pub = await publish(p.Onboarding!);
    expect(pub).toMatchObject({ status: "published" });
    expect(await processState(...held)).toEqual(before);
    const r = await placements(editor);
    expect(r.map((x) => [x.process_id, x.holder_name]).sort()).toEqual([[p.Delivery, "Onboarding"], [p.Sales, "Onboarding"]].sort());
  });

  it("moves a process off the company map when another process publishes a link to it (the map gives way)", async () => {
    const map = await openDraft(ids.company);
    await editor.insertInto("steps").values(link(map, ids.company, p.Support!, "Support", 0)).execute();
    await publish(ids.company);
    const mapLive = (await one("select live_revision_id from processes where id = $1", [ids.company])).live_revision_id;
    const before = await processState(p.Support!);
    const draft = await openDraft(p.Delivery!);
    await editor.insertInto("steps").values([link(draft, p.Delivery!, p.Support!, "Support", 0)]).execute();
    await publish(p.Delivery!);
    expect((await placements(editor)).find((x) => x.process_id === p.Support)?.holder_name).toBe("Delivery");
    // A system version of the map, without the card; the process itself untouched.
    const after = (await one("select live_revision_id from processes where id = $1", [ids.company])).live_revision_id;
    expect(after).not.toBe(mapLive);
    expect((await one("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [after, p.Support])).n).toBe(0);
    expect(await processState(p.Support!)).toEqual(before);
  });

  it("refuses publishing a process that already sits inside an ordinary process, and names where", async () => {
    // Inside another process: Sales sits inside Onboarding; the company map may not have it too.
    const map2 = await openDraft(ids.company);
    await editor.insertInto("steps").values(link(map2, ids.company, p.Sales!, "Sales", 300)).execute();
    const inside = await errorOf(() => publish(ids.company));
    expect(inside?.message).toMatch(/^Sales is already inside Onboarding\. A process can sit in one place only/);
    await discard(ids.company);
  });

  it("refuses a loop at publish", async () => {
    // Onboarding holds Sales; Sales's draft may link Onboarding, but publishing it is refused.
    const draft = await openDraft(p.Sales!);
    await editor.insertInto("steps").values(link(draft, p.Sales!, p.Onboarding!, "Onboarding", 0)).execute();
    const r = await errorOf(() => publish(p.Sales!));
    expect(r?.message).toBe("Sales can't hold Onboarding: Onboarding already holds Sales, so Sales would sit inside itself.");
    await discard(p.Sales!);
  });

  it("refuses another workspace's process", async () => {
    const draft = await openDraft(p.Onboarding!);
    const r = await errorOf(() => editor.insertInto("steps").values(link(draft, p.Onboarding!, ids.theirs, "Theirs", 0)).execute());
    expect(r).not.toBeNull();
    await discard(p.Onboarding!);
  });

  it("changes and reads nothing for a viewer or an anonymous caller", async () => {
    const draft = await openDraft(p.Delivery!);
    const before = await rows("select id from steps where revision_id = $1 order by id", [draft]);
    expect(await errorOf(() => viewer.insertInto("steps").values(link(draft, p.Delivery!, p.Sales!, "Sales", 0)).execute())).not.toBeNull();
    expect(await errorOf(() => anon.insertInto("steps").values(link(draft, p.Delivery!, p.Sales!, "Sales", 0)).execute())).not.toBeNull();
    expect(await rows("select id from steps where revision_id = $1 order by id", [draft])).toEqual(before);
    expect(await rpc(viewer, "create_library_process", { p_workspace: ids.ws, p_name: "Viewer's", p_kind: "pipeline" })).toMatchObject({ status: "not_found" });
    expect(await errorOf(() => rpc(anon, "create_library_process", { p_workspace: ids.ws, p_name: "Anon's", p_kind: "pipeline" }))).not.toBeNull();
    expect((await one("select count(*)::int n from processes where workspace_id = $1 and name in ('Viewer''s', 'Anon''s')", [ids.ws])).n).toBe(0);
    // A viewer reads where processes sit (a member); anon reads nothing.
    expect((await placements(viewer)).length).toBe(3);
    const a = await placements(anon).then((r) => r.length === 0, () => true);
    expect(a).toBeTruthy();
    await discard(p.Delivery!);
  });

  it("keeps the helper functions out of clients' reach", async () => {
    const grants = await one(
      "select has_function_privilege('anon', 'private.live_holder(uuid, uuid)', 'execute') as anon_x, has_function_privilege('authenticated', 'private.live_holder(uuid, uuid)', 'execute') as auth_x, has_function_privilege('authenticated', 'private.check_live_placements()', 'execute') as check_x",
    );
    expect(grants).toEqual({ anon_x: false, auth_x: false, check_x: false });
  });
});
