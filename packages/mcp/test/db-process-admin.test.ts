import { randomUUID } from "node:crypto";
import { listProcesses, loadSourceFile } from "@transpera-flow/db";
import type { Db } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@transpera-flow/db/client";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// Adding things by hand, part 2 (issue #182, B19 2/2; migration 20261204000000), as the web app writes it: through Kysely
// under RLS. An editor makes a process of either kind, renames it, changes its kind, archives
// it (it leaves `listProcesses`, the company map gets a system version) and restores it; archiving a process inside another is
// refused with the database's plain message. An editor keeps a file's details on a source. A viewer and an anonymous caller
// change nothing. (Storage's own policies are tested in packages/db/test/source-files.test.ts.) Runs on a throwaway database (test/helpers.ts).


let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", company: "", editor: "" };
let editor: Db;
let viewer: Db;
let anon: Db;

/** Make a process as the app does (an insert as the editor), and publish a first version, linking `children` in it. */
async function made(name: string, kind: "pipeline" | "servicing", children: string[] = []): Promise<string> {
  const data = await editor.insertInto("processes").values({ workspace_id: ids.ws, name, kind }).returning("id").executeTakeFirstOrThrow();
  await publishWith(data.id as string, children);
  return data.id as string;
}

async function publishWith(id: string, children: string[]) {
  const opened = (await rpc(editor, "open_draft", { target_process: id })) as { revision_id: string };
  await editor.deleteFrom("steps").where("revision_id", "=", opened.revision_id).where("child_process_id", "is not", null).execute();
  for (const child of children) {
    await editor.insertInto("steps").values({ id: randomUUID(), revision_id: opened.revision_id, workspace_id: ids.ws, process_id: id, name: "Linked", kind: "subprocess", child_process_id: child, x: 0, y: 0 }).execute();
  }
  const data = await rpc(editor, "publish_process", { target_process: id });
  if ((data as { status: string }).status !== "published") throw new Error(JSON.stringify(data));
}

const mapCards = async () =>
  (await admin.query("select s.child_process_id from steps s join processes p on p.live_revision_id = s.revision_id where p.id = $1 and s.child_process_id is not null", [ids.company])).rows.map(
    (r) => r.child_process_id as string,
  );

describe("process admin and source files", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Admin Co', $1) returning id", [`admin-${tag}`])).id as string;
    ids.company = (await one("select id from processes where workspace_id = $1 and is_company", [ids.ws])).id as string;
    const [ed, vw] = [randomUUID(), randomUUID()];
    ids.editor = ed;
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `adm-editor-${tag}@example.com`, vw, `adm-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    editor = env.dbAs(userClaims(ed));
    viewer = env.dbAs(userClaims(vw));
    anon = env.dbAs(null);
  });

  afterAll(async () => {
    await env?.close();
  });

  it("an editor makes either kind, renames it, changes its kind, archives and restores it; the lists and the map follow", async () => {
    const sales = await made("Sales", "pipeline");
    const reporting = await made("Reporting", "servicing");
    expect((await mapCards()).sort()).toEqual([sales, reporting].sort());

    expect(await editor.updateTable("processes").set({ name: "New business" }).where("id", "=", sales).returning("id").execute()).toHaveLength(1);
    expect(await editor.updateTable("processes").set({ kind: "servicing", entity_name: "task" }).where("id", "=", sales).returning("id").execute()).toHaveLength(1);
    expect(await one("select name, kind from processes where id = $1", [sales])).toEqual({ name: "New business", kind: "servicing" });

    const archived = await editor.updateTable("processes").set({ archived_at: new Date().toISOString() }).where("id", "=", sales).returning(["archived_at", "archived_by"]).execute();
    expect(archived[0]!.archived_by).not.toBeNull();
    expect(await mapCards()).toEqual([reporting]);
    expect((await listProcesses(editor, ids.ws)).map((p) => p.name)).toEqual(["Reporting"]);
    const all = await listProcesses(editor, ids.ws, { includeArchived: true });
    expect(all.map((p) => [p.name, Boolean(p.archived_at)])).toEqual([
      ["New business", true],
      ["Reporting", false],
    ]);

    expect(await editor.updateTable("processes").set({ archived_at: null }).where("id", "=", sales).returning("id").execute()).toHaveLength(1);
    expect((await mapCards()).sort()).toEqual([sales, reporting].sort());
    expect((await listProcesses(editor, ids.ws)).map((p) => p.name).sort()).toEqual(["New business", "Reporting"]);
    const notes = (await admin.query("select diff ->> 'note' note from audit_log where target_id = $1 and actor_kind = 'system' order by created_at, id", [ids.company])).rows.map((r) => r.note);
    expect(notes.slice(-4)).toEqual(["Renamed Sales to New business", "New business is now a servicing process", "Archived New business", "Restored New business"]);
  });

  /** The change an archive makes, and the error the database answers it with (null when it goes through). */
  const archive = (id: string) => errorOf(() => editor.updateTable("processes").set({ archived_at: new Date().toISOString() }).where("id", "=", id).returning("id").execute());

  it("refuses to archive a process inside another, or holding others, naming them; and the company map", async () => {
    const kickoff = await made("Kickoff", "pipeline");
    const onboarding = await made("Onboarding", "pipeline", [kickoff]);
    const inside = await archive(kickoff);
    expect({ code: inside?.code, message: inside?.message }).toEqual({ code: "55000", message: "Kickoff sits inside Onboarding. Take it out of Onboarding and publish, then archive it." });
    const holds = await archive(onboarding);
    expect(holds?.message).toBe("Onboarding holds Kickoff. Take Kickoff out of Onboarding and publish, then archive it.");
    const map = await archive(ids.company);
    expect(map?.message).toBe("The company map can't be archived");
    expect(await one("select count(*)::int n from processes where workspace_id = $1 and archived_at is not null", [ids.ws])).toEqual({ n: 0 });
  });

  it("while archived, a draft, a publish and a restored version are refused; who archived it can't be forged", async () => {
    const x = await made("X", "pipeline");
    const y = await made("Y", "pipeline");
    const first = (await one("select live_revision_id from processes where id = $1", [x])).live_revision_id as string;
    await publishWith(x, []);
    // X's draft links Y; X is archived; publishing X must not move Y off the company map.
    const opened = (await rpc(editor, "open_draft", { target_process: x })) as { revision_id: string };
    await editor.insertInto("steps").values({ id: randomUUID(), revision_id: opened.revision_id, workspace_id: ids.ws, process_id: x, name: "Linked", kind: "subprocess", child_process_id: y, x: 0, y: 0 }).execute();
    const forged = await editor.updateTable("processes").set({ archived_at: new Date().toISOString(), archived_by: randomUUID() }).where("id", "=", x).returning("archived_by").execute();
    expect(forged[0]!.archived_by).not.toBeNull();
    expect(forged[0]!.archived_by).toBe((await one("select archived_by from processes where id = $1", [x])).archived_by);
    const message = "X is archived. Restore it from Processes (Archived) before changing it.";
    expect((await errorOf(() => rpc(editor, "publish_process", { target_process: x })))?.message).toMatch(/^X is archived\. Restore it from Processes \(Archived\) before (changing|publishing) it\.$/);
    expect((await errorOf(() => rpc(editor, "open_draft", { target_process: x })))?.message).toBe(message);
    expect((await errorOf(() => rpc(editor, "restore_version", { target_process: x, source_revision: first, replace_draft: true })))?.message).toBe(message);
    expect((await errorOf(() => editor.updateTable("processes").set({ archived_by: randomUUID() }).where("id", "=", x).returning("id").execute()))?.code).toBe("55000");
    expect(await mapCards()).toContain(y);
    expect(await mapCards()).not.toContain(x);
  });

  it("refuses archiving a service's way in, naming the service", async () => {
    const sales = await made("Inbound", "pipeline");
    await admin.query("insert into services (workspace_id, name, entry_process_id) values ($1, 'SEO', $2)", [ids.ws, sales]);
    const r = await archive(sales);
    expect({ code: r?.code, message: r?.message }).toEqual({ code: "55000", message: "Inbound is where new work for SEO comes in. Choose another process for it in Settings, Services, then archive it." });
  });

  it("a viewer and anon can't make, rename, re-kind, archive or restore a process", async () => {
    const target = await made("Audit", "pipeline");
    const ins = await errorOf(() => viewer.insertInto("processes").values({ workspace_id: ids.ws, name: "Viewer made", kind: "pipeline" }).returning("id").execute());
    expect(ins?.code).toBe("42501");
    for (const change of [{ name: "Viewer" }, { kind: "servicing" }, { archived_at: new Date().toISOString() }]) {
      // The update goes through without an error and changes no row: RLS hides the process from a viewer's writes.
      const r = await viewer.updateTable("processes").set(change).where("id", "=", target).returning("id").execute();
      expect(r, JSON.stringify(change)).toEqual([]);
    }
    await admin.query("update processes set archived_at = now() where id = $1", [target]);
    expect(await viewer.updateTable("processes").set({ archived_at: null }).where("id", "=", target).returning("id").execute()).toEqual([]);
    expect((await errorOf(() => anon.updateTable("processes").set({ archived_at: null }).where("id", "=", target).returning("id").execute()))?.code).toBe("42501");
    expect((await errorOf(() => anon.selectFrom("processes").select("id").where("workspace_id", "=", ids.ws).execute()))?.code).toBe("42501");
    expect(await one("select name, kind, archived_at is not null archived from processes where id = $1", [target])).toEqual({ name: "Audit", kind: "pipeline", archived: true });
    // The viewer still sees it (its history is kept), and it is off their lists.
    expect((await listProcesses(viewer, ids.ws)).map((p) => p.name)).not.toContain("Audit");
    expect((await listProcesses(viewer, ids.ws, { includeArchived: true })).map((p) => p.name)).toContain("Audit");
  });

  it("an editor keeps a file's details on a source; a viewer and anon can't", async () => {
    const source = (await one("insert into sources (workspace_id, kind, title) values ($1, 'sop', 'Onboarding SOP') returning id", [ids.ws])).id as string;
    // Uploaded by the editor (as Storage records it: the object's owner).
    const uploaded = async (name: string, owner = ids.editor) => {
      await admin.query("insert into storage.objects (bucket_id, name, owner, owner_id) values ('sources', $1, $2::uuid, $2)", [name, owner]);
      return name;
    };
    const path = `${ids.ws}/${source}/${randomUUID()}/Onboarding SOP.pdf`;
    const set = (db: Db, change: Record<string, unknown>) => db.updateTable("sources").set(change as never).where("id", "=", source).returning("id").execute();
    // Nothing uploaded there yet: refused.
    const early = await errorOf(() => set(editor, { file_path: path, file_name: "Onboarding SOP.pdf", file_type: "pdf", file_size: 2048 }));
    expect({ code: early?.code, message: early?.message }).toEqual({ code: "42501", message: "Upload the file first: a source keeps only a file you have just uploaded for it" });
    await uploaded(path);
    const file = { file_path: path, file_name: "Onboarding SOP.pdf", file_type: "pdf", file_size: 2048, body: "1. Send the welcome pack." };
    expect(await set(viewer, file)).toEqual([]);
    expect((await errorOf(() => set(anon, file)))?.code).toBe("42501");
    expect(await loadSourceFile(viewer, source)).toBeNull();
    expect(await set(editor, file)).toHaveLength(1);
    expect(await loadSourceFile(viewer, source)).toEqual({ path, name: "Onboarding SOP.pdf", type: "pdf", size: 2048 });
    // The database's checks hold over the API too: another workspace's folder, another kind, over 10 MB.
    const other = await errorOf(async () => set(editor, { ...file, file_path: await uploaded(`${randomUUID()}/${source}/${randomUUID()}/x.pdf`) }));
    expect(other?.code).toBe("23514");
    expect((await errorOf(() => set(editor, { ...file, file_type: "html" })))?.code).toBe("23514");
    expect((await errorOf(() => set(editor, { ...file, file_size: 10 * 1024 * 1024 + 1 })))?.code).toBe("23514");
  });
});
