import { randomUUID } from "node:crypto";
import type { Db } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@transpera-flow/db/client";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// Adding things by hand, part 1 (issue #182, B19; migration 20261201000000), as the web app writes it: through Kysely
// under RLS. An editor adds a client, edits it field by field, sets its services and who
// looks after it, makes it inactive, and can't delete it; deletes a saved scenario and a solution (whose links land in the
// audit log and on each issue's history). An owner changes the workspace's name and currency; an editor can't. A viewer
// and an anonymous caller change nothing. Runs on a throwaway database (test/helpers.ts).


let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", service: "", role: "", person: "", process: "", revision: "", issue: "" };
let owner: Db;
let editor: Db;
let viewer: Db;
let anon: Db;

const save = (c: Db, target: string, key: object, base: object, changes: object) => rpc(c, "save_fields", { target, key, base, changes } as never);

describe("adding things by hand", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
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
    owner = env.dbAs(userClaims(ow));
    editor = env.dbAs(userClaims(ed));
    viewer = env.dbAs(userClaims(vw));
    anon = env.dbAs(null);
  });

  afterAll(async () => {
    // Only this suite's own workspace (the database is shared): its rows go with it.
    if (ids.ws) {
      await admin.query("delete from workspaces where id = $1", [ids.ws]);
      await admin.query("delete from audit_log where workspace_id = $1", [ids.ws]);
    }
    await env?.close();
  });

  it("an editor adds a client, edits it, sets its services and account director, and makes it inactive; nobody deletes it", async () => {
    const added = await editor.insertInto("clients").values({ workspace_id: ids.ws, name: "Harbour Lane Dental", mrr: 3600, start_date: "2025-03-01" }).returning("id").executeTakeFirstOrThrow();
    const id = added.id as string;
    expect(await save(editor, "clients", { id }, { mrr: 3600 }, { mrr: 3800 })).toMatchObject({ status: "saved" });
    expect(
      await rpc(editor, "save_links", { target: "client_services", owner: { client_id: id, workspace_id: ids.ws }, member: "service_id", base: JSON.stringify([]) as never, next: JSON.stringify([ids.service]) as never }),
    ).toMatchObject({ status: "saved" });
    await editor.insertInto("client_assignments").values({ client_id: id, role_id: ids.role, person_id: ids.person, workspace_id: ids.ws }).execute();
    expect(await save(editor, "clients", { id }, { active: true }, { active: false })).toMatchObject({ status: "saved" });

    for (const who of [editor, owner]) {
      const del = await errorOf(() => who.deleteFrom("clients").where("id", "=", id).returning("id").execute());
      expect(del?.message).toMatch(/never deleted: mark them inactive/);
    }
    expect(await one("select name, mrr::float as mrr, active from clients where id = $1", [id])).toEqual({ name: "Harbour Lane Dental", mrr: 3800, active: false });
    expect((await one("select count(*)::int as n from client_services where client_id = $1", [id])).n).toBe(1);
    expect((await one("select person_id from client_assignments where client_id = $1", [id])).person_id).toBe(ids.person);
  });

  it("refuses a viewer and an anonymous caller every client write", async () => {
    const id = (await one("insert into clients (workspace_id, name) values ($1, 'Old Mill Bakery') returning id", [ids.ws])).id as string;
    expect((await errorOf(() => viewer.insertInto("clients").values({ workspace_id: ids.ws, name: "Nope" }).execute()))?.message).toMatch(/row-level security/);
    expect(await save(viewer, "clients", { id }, { active: true }, { active: false })).toMatchObject({ status: "not_found" });
    expect(await viewer.deleteFrom("clients").where("id", "=", id).returning("id").execute()).toEqual([]);
    expect(await errorOf(() => viewer.insertInto("client_assignments").values({ client_id: id, role_id: ids.role, person_id: ids.person, workspace_id: ids.ws }).execute())).not.toBeNull();
    expect(await errorOf(() => anon.insertInto("clients").values({ workspace_id: ids.ws, name: "Nope" }).execute())).not.toBeNull();
    expect(await one("select active from clients where id = $1", [id])).toEqual({ active: true });
  });

  it("an owner changes the workspace's name and currency; an editor and a viewer can't; a bad code is refused", async () => {
    expect(await save(owner, "workspaces", { id: ids.ws }, { name: "Manual Co" }, { name: "Manual Company" })).toMatchObject({ status: "saved" });
    expect(await save(owner, "workspaces", { id: ids.ws }, { "settings.currency": "AUD" }, { "settings.currency": "GBP" })).toMatchObject({ status: "saved" });
    expect((await errorOf(() => save(owner, "workspaces", { id: ids.ws }, { "settings.currency": "GBP" }, { "settings.currency": "pounds" })))?.message).toMatch(/workspaces_currency_code/);
    for (const who of [editor, viewer]) {
      expect(await save(who, "workspaces", { id: ids.ws }, { name: "Manual Company" }, { name: "Theirs" })).toMatchObject({ status: "not_found" });
    }
    expect(await one("select name, settings ->> 'currency' as currency from workspaces where id = $1", [ids.ws])).toEqual({ name: "Manual Company", currency: "GBP" });
  });

  it("an editor deletes a saved scenario; a viewer can't", async () => {
    const mk = async (name: string) =>
      (await one("insert into scenarios (workspace_id, name, patch) values ($1, $2, '[{\"path\": \"demand.leads_per_week\", \"op\": \"multiply\", \"value\": 1.2}]') returning id", [ids.ws, name])).id as string;
    const [keep, gone] = [await mk("Keep me"), await mk("Delete me")];
    expect(await viewer.deleteFrom("scenarios").where("id", "=", keep).returning("id").execute()).toEqual([]);
    expect(await editor.deleteFrom("scenarios").where("id", "=", gone).returning("id").execute()).toEqual([{ id: gone }]);
    expect((await one("select count(*)::int as n from scenarios where id = any($1)", [[keep, gone]])).n).toBe(1);
  });

  it("an editor deletes a solution, and its issue link lands in the audit log and the issue's history; a viewer can't", async () => {
    const saved = await rpc(editor, "save_solution", {
      p_workspace: ids.ws,
      p_process: ids.process,
      p_base_revision: ids.revision,
      p_name: "Reply templates",
      p_steps: { steps: [], edges: [], entry_step_id: null },
      p_links: JSON.stringify([{ issue_id: ids.issue, auto_verdict: "pass", holds_pct: 80, auto_note: "Wait 2 h against under 4 hours" }]) as never,
    });
    const sol = (saved as { id: string }).id;
    expect(await viewer.deleteFrom("solutions").where("id", "=", sol).returning("id").execute()).toEqual([]);
    expect((await one("select count(*)::int as n from audit_log where target_id = $1", [sol])).n).toBe(0);

    expect(await editor.deleteFrom("solutions").where("id", "=", sol).returning("id").execute()).toEqual([{ id: sol }]);
    const audit = await one("select action, target_table, diff from audit_log where target_id = $1", [sol]);
    expect(audit).toMatchObject({ action: "delete", target_table: "solutions" });
    expect((audit.diff as { issue_links: Row[] }).issue_links).toEqual([
      expect.objectContaining({ issue_id: ids.issue, auto_verdict: "pass", holds_pct: 80, auto_note: "Wait 2 h against under 4 hours" }),
    ]);
    const last = await one("select kind, detail from issue_events where issue_id = $1 order by seq desc limit 1", [ids.issue]);
    // It was the issue's only solution, so the issue is back to Open: one entry says both.
    expect(last).toEqual({ kind: "edited", detail: { from: "testing", to: "open", solution_deleted: { solution_id: sol, solution: "Reply templates" } } });
    expect((await one("select status from issues where id = $1", [ids.issue])).status).toBe("open");
    // The editor can't read the audit log (owners can) and can't write it.
    expect(await editor.selectFrom("audit_log").select("id").where("target_id", "=", sol).execute()).toEqual([]);
    expect(await owner.selectFrom("audit_log").select("action").where("target_id", "=", sol).execute()).toEqual([{ action: "delete" }]);
  });
});
