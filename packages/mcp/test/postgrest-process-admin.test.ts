import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { listProcesses, loadSourceFile } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./helpers";

// Adding things by hand, part 2 (issue #182, B19 2/2; migration 20261204000000), as the web app writes it: over PostgREST with
// Supabase's default table privileges and RLS. An editor makes a process of either kind, renames it, changes its kind, archives
// it (it leaves `listProcesses`, the company map gets a system version) and restores it; archiving a process inside another is
// refused with the database's plain message. An editor keeps a file's details on a source. A viewer and an anonymous caller
// change nothing. (Storage's own policies are tested in packages/db/test/source-files.test.ts: PostgREST doesn't serve the
// storage schema.) Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", company: "" };
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

/** Make a process as the app does (an insert as the editor), and publish a first version, linking `children` in it. */
async function made(name: string, kind: "pipeline" | "servicing", children: string[] = []): Promise<string> {
  const { data, error } = await editor.from("processes").insert({ workspace_id: ids.ws, name, kind }).select("id").single();
  if (error) throw error;
  await publishWith(data.id as string, children);
  return data.id as string;
}

async function publishWith(id: string, children: string[]) {
  const opened = (await editor.rpc("open_draft", { target_process: id })).data as { revision_id: string };
  await editor.from("steps").delete().eq("revision_id", opened.revision_id).not("child_process_id", "is", null);
  for (const child of children) {
    const { error } = await editor.from("steps").insert({ id: randomUUID(), revision_id: opened.revision_id, workspace_id: ids.ws, process_id: id, name: "Linked", kind: "subprocess", child_process_id: child, x: 0, y: 0 });
    if (error) throw error;
  }
  const { data, error } = await editor.rpc("publish_process", { target_process: id });
  if (error || (data as { status: string }).status !== "published") throw error ?? new Error(JSON.stringify(data));
}

const mapCards = async () =>
  (await admin.query("select s.child_process_id from steps s join processes p on p.live_revision_id = s.revision_id where p.id = $1 and s.child_process_id is not null", [ids.company])).rows.map(
    (r) => r.child_process_id as string,
  );

describe.skipIf(!POSTGREST_URL)("process admin and source files over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug) values ('Admin Co', $1) returning id", [`admin-${tag}`])).id as string;
    ids.company = (await one("select id from processes where workspace_id = $1 and is_company", [ids.ws])).id as string;
    const [ed, vw] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `adm-editor-${tag}@example.com`, vw, `adm-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editor = client(token(ed));
    viewer = client(token(vw));
    anon = client(signJwt({ role: "anon" }, JWT_SECRET));
    const deadline = Date.now() + 60_000;
    while ((await editor.from("workspaces").select("id").eq("id", ids.ws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (ids.ws) {
      await admin.query("delete from workspaces where id = $1", [ids.ws]);
      await admin.query("delete from audit_log where workspace_id = $1", [ids.ws]);
    }
    await admin?.end();
  });

  it("an editor makes either kind, renames it, changes its kind, archives and restores it; the lists and the map follow", async () => {
    const sales = await made("Sales", "pipeline");
    const reporting = await made("Reporting", "servicing");
    expect((await mapCards()).sort()).toEqual([sales, reporting].sort());

    expect((await editor.from("processes").update({ name: "New business" }).eq("id", sales).select("id")).data).toHaveLength(1);
    expect((await editor.from("processes").update({ kind: "servicing", entity_name: "task" }).eq("id", sales).select("id")).data).toHaveLength(1);
    expect(await one("select name, kind from processes where id = $1", [sales])).toEqual({ name: "New business", kind: "servicing" });

    const archived = await editor.from("processes").update({ archived_at: new Date().toISOString() }).eq("id", sales).select("archived_at, archived_by");
    expect(archived.error).toBeNull();
    expect(archived.data![0]!.archived_by).not.toBeNull();
    expect(await mapCards()).toEqual([reporting]);
    expect((await listProcesses(editor as never, ids.ws)).map((p) => p.name)).toEqual(["Reporting"]);
    const all = await listProcesses(editor as never, ids.ws, { includeArchived: true });
    expect(all.map((p) => [p.name, Boolean(p.archived_at)])).toEqual([
      ["New business", true],
      ["Reporting", false],
    ]);

    expect((await editor.from("processes").update({ archived_at: null }).eq("id", sales).select("id")).data).toHaveLength(1);
    expect((await mapCards()).sort()).toEqual([sales, reporting].sort());
    expect((await listProcesses(editor as never, ids.ws)).map((p) => p.name).sort()).toEqual(["New business", "Reporting"]);
    const notes = (await admin.query("select diff ->> 'note' note from audit_log where target_id = $1 and actor_kind = 'system' order by created_at, id", [ids.company])).rows.map((r) => r.note);
    expect(notes.slice(-4)).toEqual(["Renamed Sales to New business", "New business is now a servicing process", "Archived New business", "Restored New business"]);
  });

  it("refuses to archive a process inside another, or holding others, naming them; and the company map", async () => {
    const kickoff = await made("Kickoff", "pipeline");
    const onboarding = await made("Onboarding", "pipeline", [kickoff]);
    const inside = await editor.from("processes").update({ archived_at: new Date().toISOString() }).eq("id", kickoff).select("id");
    expect({ code: inside.error?.code, message: inside.error?.message }).toEqual({ code: "55000", message: "Kickoff sits inside Onboarding. Take it out of Onboarding and publish, then archive it." });
    const holds = await editor.from("processes").update({ archived_at: new Date().toISOString() }).eq("id", onboarding).select("id");
    expect(holds.error?.message).toBe("Onboarding holds Kickoff. Take Kickoff out of Onboarding and publish, then archive it.");
    const map = await editor.from("processes").update({ archived_at: new Date().toISOString() }).eq("id", ids.company).select("id");
    expect(map.error?.message).toBe("The company map can't be archived");
    expect(await one("select count(*)::int n from processes where workspace_id = $1 and archived_at is not null", [ids.ws])).toEqual({ n: 0 });
  });

  it("while archived, a draft, a publish and a restored version are refused; who archived it can't be forged", async () => {
    const x = await made("X", "pipeline");
    const y = await made("Y", "pipeline");
    const first = (await one("select live_revision_id from processes where id = $1", [x])).live_revision_id as string;
    await publishWith(x, []);
    // X's draft links Y; X is archived; publishing X must not move Y off the company map.
    const opened = (await editor.rpc("open_draft", { target_process: x })).data as { revision_id: string };
    expect((await editor.from("steps").insert({ id: randomUUID(), revision_id: opened.revision_id, workspace_id: ids.ws, process_id: x, name: "Linked", kind: "subprocess", child_process_id: y, x: 0, y: 0 })).error).toBeNull();
    const forged = await editor.from("processes").update({ archived_at: new Date().toISOString(), archived_by: randomUUID() }).eq("id", x).select("archived_by");
    expect(forged.error).toBeNull();
    expect(forged.data![0]!.archived_by).not.toBeNull();
    expect(forged.data![0]!.archived_by).toBe((await one("select archived_by from processes where id = $1", [x])).archived_by);
    const message = "X is archived. Restore it from Processes (Archived) before changing it.";
    expect((await editor.rpc("publish_process", { target_process: x })).error?.message).toMatch(/^X is archived\. Restore it from Processes \(Archived\) before (changing|publishing) it\.$/);
    expect((await editor.rpc("open_draft", { target_process: x })).error?.message).toBe(message);
    expect((await editor.rpc("restore_version", { target_process: x, source_revision: first, replace_draft: true })).error?.message).toBe(message);
    expect((await editor.from("processes").update({ archived_by: randomUUID() }).eq("id", x).select("id")).error?.code).toBe("55000");
    expect(await mapCards()).toContain(y);
    expect(await mapCards()).not.toContain(x);
  });

  it("refuses archiving a service's way in, naming the service", async () => {
    const sales = await made("Inbound", "pipeline");
    await admin.query("insert into services (workspace_id, name, entry_process_id) values ($1, 'SEO', $2)", [ids.ws, sales]);
    const r = await editor.from("processes").update({ archived_at: new Date().toISOString() }).eq("id", sales).select("id");
    expect({ code: r.error?.code, message: r.error?.message }).toEqual({ code: "55000", message: "Inbound is where new work for SEO comes in. Choose another process for it in Settings, Services, then archive it." });
  });

  it("a viewer and anon can't make, rename, re-kind, archive or restore a process", async () => {
    const target = await made("Audit", "pipeline");
    const ins = await viewer.from("processes").insert({ workspace_id: ids.ws, name: "Viewer made", kind: "pipeline" }).select("id");
    expect(ins.error?.code).toBe("42501");
    for (const change of [{ name: "Viewer" }, { kind: "servicing" }, { archived_at: new Date().toISOString() }]) {
      const r = await viewer.from("processes").update(change).eq("id", target).select("id");
      expect(r.error, JSON.stringify(change)).toBeNull();
      expect(r.data, JSON.stringify(change)).toEqual([]);
    }
    await admin.query("update processes set archived_at = now() where id = $1", [target]);
    expect((await viewer.from("processes").update({ archived_at: null }).eq("id", target).select("id")).data).toEqual([]);
    expect((await anon.from("processes").update({ archived_at: null }).eq("id", target).select("id")).error?.code).toBe("42501");
    expect((await anon.from("processes").select("id").eq("workspace_id", ids.ws)).error?.code).toBe("42501");
    expect(await one("select name, kind, archived_at is not null archived from processes where id = $1", [target])).toEqual({ name: "Audit", kind: "pipeline", archived: true });
    // The viewer still sees it (its history is kept), and it is off their lists.
    expect((await listProcesses(viewer as never, ids.ws)).map((p) => p.name)).not.toContain("Audit");
    expect((await listProcesses(viewer as never, ids.ws, { includeArchived: true })).map((p) => p.name)).toContain("Audit");
  });

  it("an editor keeps a file's details on a source; a viewer and anon can't", async () => {
    const source = (await one("insert into sources (workspace_id, kind, title) values ($1, 'sop', 'Onboarding SOP') returning id", [ids.ws])).id as string;
    const path = `${ids.ws}/${source}/${randomUUID()}/Onboarding SOP.pdf`;
    const file = { file_path: path, file_name: "Onboarding SOP.pdf", file_type: "pdf", file_size: 2048, body: "1. Send the welcome pack." };
    expect((await viewer.from("sources").update(file).eq("id", source).select("id")).data).toEqual([]);
    expect((await anon.from("sources").update(file).eq("id", source).select("id")).error?.code).toBe("42501");
    expect(await loadSourceFile(viewer as never, source)).toBeNull();
    expect((await editor.from("sources").update(file).eq("id", source).select("id")).data).toHaveLength(1);
    expect(await loadSourceFile(viewer as never, source)).toEqual({ path, name: "Onboarding SOP.pdf", type: "pdf", size: 2048 });
    // The database's checks hold over the API too: another workspace's folder, another kind, over 10 MB.
    const other = await editor.from("sources").update({ ...file, file_path: `${randomUUID()}/${source}/${randomUUID()}/x.pdf` }).eq("id", source).select("id");
    expect(other.error?.code).toBe("23514");
    expect((await editor.from("sources").update({ ...file, file_type: "html" }).eq("id", source).select("id")).error?.code).toBe("23514");
    expect((await editor.from("sources").update({ ...file, file_size: 10 * 1024 * 1024 + 1 }).eq("id", source).select("id")).error?.code).toBe("23514");
  });
});
