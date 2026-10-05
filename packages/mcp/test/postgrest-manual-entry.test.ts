import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./helpers";

// Adding things by hand, part 1 (issue #182, B19; migration 20261201000000), as the web app writes it: over PostgREST with
// Supabase's default table privileges and RLS. An editor adds a client, edits it field by field, sets its services and who
// looks after it, makes it inactive, and can't delete it; deletes a saved scenario and a solution (whose links land in the
// audit log and on each issue's history). An owner changes the workspace's name and currency; an editor can't. A viewer
// and an anonymous caller change nothing. Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", service: "", role: "", person: "", process: "", revision: "", issue: "" };
let owner: SupabaseClient;
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

const save = (c: SupabaseClient, target: string, key: object, base: object, changes: object) => c.rpc("save_fields", { target, key, base, changes });

describe.skipIf(!POSTGREST_URL)("adding things by hand over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) values ('Manual Co', $1, '{\"currency\": \"AUD\"}') returning id", [`manual-${tag}`])).id as string;
    const [ow, ed, vw] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [ow, `man-owner-${tag}@example.com`, ed, `man-editor-${tag}@example.com`, vw, `man-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'viewer')", [ids.ws, ow, ed, vw]);
    ids.service = (await one("insert into services (workspace_id, name) values ($1, 'SEO') returning id", [ids.ws])).id as string;
    ids.role = (await one("insert into roles (workspace_id, name) values ($1, 'Account director') returning id", [ids.ws])).id as string;
    ids.person = (await one("insert into people (workspace_id, name) values ($1, 'Maya Collins') returning id", [ids.ws])).id as string;
    ids.process = (await one("insert into processes (workspace_id, name) values ($1, 'Sales') returning id", [ids.ws])).id as string;
    ids.revision = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'draft') returning id", [ids.ws, ids.process])).id as string;
    await admin.query("update process_revisions set status = 'published' where id = $1", [ids.revision]);
    await admin.query("update processes set live_revision_id = $1 where id = $2", [ids.revision, ids.process]);
    ids.issue = (await one("insert into issues (workspace_id, process_id, title, type, severity, source) values ($1, $2, 'Slow replies', 'delay', 'warning', 'manual') returning id", [ids.ws, ids.process])).id as string;
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    owner = client(token(ow));
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
    // Only this suite's own workspace (the database is shared): its rows go with it.
    if (ids.ws) {
      await admin.query("delete from workspaces where id = $1", [ids.ws]);
      await admin.query("delete from audit_log where workspace_id = $1", [ids.ws]);
    }
    await admin?.end();
  });

  it("an editor adds a client, edits it, sets its services and account director, and makes it inactive; nobody deletes it", async () => {
    const added = await editor.from("clients").insert({ workspace_id: ids.ws, name: "Harbour Lane Dental", mrr: 3600, start_date: "2025-03-01" }).select("id").single();
    expect(added.error).toBeNull();
    const id = added.data!.id as string;
    expect((await save(editor, "clients", { id }, { mrr: 3600 }, { mrr: 3800 })).data).toMatchObject({ status: "saved" });
    expect(
      (await editor.rpc("save_links", { target: "client_services", owner: { client_id: id, workspace_id: ids.ws }, member: "service_id", base: [], next: [ids.service] })).data,
    ).toMatchObject({ status: "saved" });
    expect((await editor.from("client_assignments").insert({ client_id: id, role_id: ids.role, person_id: ids.person, workspace_id: ids.ws })).error).toBeNull();
    expect((await save(editor, "clients", { id }, { active: true }, { active: false })).data).toMatchObject({ status: "saved" });

    for (const who of [editor, owner]) {
      const del = await who.from("clients").delete().eq("id", id).select("id");
      expect(del.error?.message).toMatch(/never deleted: mark them inactive/);
    }
    expect(await one("select name, mrr::float as mrr, active from clients where id = $1", [id])).toEqual({ name: "Harbour Lane Dental", mrr: 3800, active: false });
    expect((await one("select count(*)::int as n from client_services where client_id = $1", [id])).n).toBe(1);
    expect((await one("select person_id from client_assignments where client_id = $1", [id])).person_id).toBe(ids.person);
  });

  it("refuses a viewer and an anonymous caller every client write", async () => {
    const id = (await one("insert into clients (workspace_id, name) values ($1, 'Old Mill Bakery') returning id", [ids.ws])).id as string;
    expect((await viewer.from("clients").insert({ workspace_id: ids.ws, name: "Nope" })).error?.message).toMatch(/row-level security/);
    expect((await save(viewer, "clients", { id }, { active: true }, { active: false })).data).toMatchObject({ status: "not_found" });
    expect((await viewer.from("clients").delete().eq("id", id).select("id")).data).toEqual([]);
    expect((await viewer.from("client_assignments").insert({ client_id: id, role_id: ids.role, person_id: ids.person, workspace_id: ids.ws })).error).not.toBeNull();
    expect((await anon.from("clients").insert({ workspace_id: ids.ws, name: "Nope" })).error).not.toBeNull();
    expect(await one("select active from clients where id = $1", [id])).toEqual({ active: true });
  });

  it("an owner changes the workspace's name and currency; an editor and a viewer can't; a bad code is refused", async () => {
    expect((await save(owner, "workspaces", { id: ids.ws }, { name: "Manual Co" }, { name: "Manual Company" })).data).toMatchObject({ status: "saved" });
    expect((await save(owner, "workspaces", { id: ids.ws }, { "settings.currency": "AUD" }, { "settings.currency": "GBP" })).data).toMatchObject({ status: "saved" });
    expect((await save(owner, "workspaces", { id: ids.ws }, { "settings.currency": "GBP" }, { "settings.currency": "pounds" })).error?.message).toMatch(/workspaces_currency_code/);
    for (const who of [editor, viewer]) {
      expect((await save(who, "workspaces", { id: ids.ws }, { name: "Manual Company" }, { name: "Theirs" })).data).toMatchObject({ status: "not_found" });
    }
    expect(await one("select name, settings ->> 'currency' as currency from workspaces where id = $1", [ids.ws])).toEqual({ name: "Manual Company", currency: "GBP" });
  });

  it("an editor deletes a saved scenario; a viewer can't", async () => {
    const mk = async (name: string) =>
      (await one("insert into scenarios (workspace_id, name, patch) values ($1, $2, '[{\"path\": \"demand.leads_per_week\", \"op\": \"multiply\", \"value\": 1.2}]') returning id", [ids.ws, name])).id as string;
    const [keep, gone] = [await mk("Keep me"), await mk("Delete me")];
    expect((await viewer.from("scenarios").delete().eq("id", keep).select("id")).data).toEqual([]);
    expect((await editor.from("scenarios").delete().eq("id", gone).select("id")).data).toEqual([{ id: gone }]);
    expect((await one("select count(*)::int as n from scenarios where id = any($1)", [[keep, gone]])).n).toBe(1);
  });

  it("an editor deletes a solution, and its issue link lands in the audit log and the issue's history; a viewer can't", async () => {
    const saved = await editor.rpc("save_solution", {
      p_workspace: ids.ws,
      p_process: ids.process,
      p_base_revision: ids.revision,
      p_name: "Reply templates",
      p_steps: { steps: [], edges: [], entry_step_id: null },
      p_links: [{ issue_id: ids.issue, auto_verdict: "pass", holds_pct: 80, auto_note: "Wait 2 h against under 4 hours" }],
    });
    expect(saved.error).toBeNull();
    const sol = (saved.data as { id: string }).id;
    expect((await viewer.from("solutions").delete().eq("id", sol).select("id")).data).toEqual([]);
    expect((await one("select count(*)::int as n from audit_log where target_id = $1", [sol])).n).toBe(0);

    expect((await editor.from("solutions").delete().eq("id", sol).select("id")).data).toEqual([{ id: sol }]);
    const audit = await one("select action, target_table, diff from audit_log where target_id = $1", [sol]);
    expect(audit).toMatchObject({ action: "delete", target_table: "solutions" });
    expect((audit.diff as { issue_links: Row[] }).issue_links).toEqual([
      expect.objectContaining({ issue_id: ids.issue, auto_verdict: "pass", holds_pct: 80, auto_note: "Wait 2 h against under 4 hours" }),
    ]);
    const last = await one("select kind, detail from issue_events where issue_id = $1 order by seq desc limit 1", [ids.issue]);
    expect(last).toEqual({ kind: "edited", detail: { solution_deleted: { solution_id: sol, solution: "Reply templates" } } });
    // The editor can't read the audit log (owners can) and can't write it.
    expect((await editor.from("audit_log").select("id").eq("target_id", sol)).data).toEqual([]);
    expect((await owner.from("audit_log").select("action").eq("target_id", sol)).data).toEqual([{ action: "delete" }]);
  });
});
