import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@transpera-flow/db/client";
import { loadCompanyProcessId, loadLiveCompanyPart, loadProcessBySlug, loadSetupCounts, type Db } from "@transpera-flow/db";
import { createFreshWorkspace, removeFreshWorkspace, type FreshUser, type FreshWorkspace } from "./fresh-workspace";
import { startTestDb, type McpTestDb } from "./helpers";

// A new client's workspace (issue #243): only what `create_workspace` makes. The web app's pages treat "nothing published" as
// something to show, not as a missing workspace; these are the reads under them, as each kind of member makes them, through Kysely under RLS.
// Runs on a throwaway database (test/helpers.ts).


const USERS = ["agency", "owner", "editor", "member", "viewer"] as const satisfies readonly FreshUser[];

let env: McpTestDb;
let admin: pg.Client;
let fresh: FreshWorkspace;
const dbs = {} as Record<FreshUser, Db>;

const ZERO = { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0 };

describe("a new client's workspace", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    fresh = await createFreshWorkspace(admin);
    for (const k of USERS) dbs[k] = env.dbAs(fresh.users[k].claims);
  });

  afterAll(async () => {
    if (fresh) await removeFreshWorkspace(admin, fresh);
    await env?.close();
  });

  it.each(USERS)("has no process to open by default, but a company map, for the %s", async (k) => {
    // The root cause of the 404s: the loader never defaults to the company map, so a workspace with only that has nothing to simulate.
    expect(await loadProcessBySlug(dbs[k], fresh.slug)).toBeNull();
    expect(await loadLiveCompanyPart(dbs[k], fresh.wsId)).not.toBeNull();
  });

  it.each(USERS)("finds the company map's id for the %s", async (k) => {
    expect(await loadCompanyProcessId(dbs[k], fresh.wsId)).toBe(fresh.companyId);
  });

  it.each(["agency", "owner", "editor"] as const)("counts nothing set up, and the company map, for the %s", async (k) => {
    expect(await loadSetupCounts(dbs[k], fresh.wsId)).toEqual({ ...ZERO, companyId: fresh.companyId });
  });

  it("ticks exactly one more item at each step an editor takes, and the process loads once it is published", async () => {
    const editor = dbs.editor;
    const ws = fresh.wsId;
    const counts = () => loadSetupCounts(editor, ws);

    await editor.insertInto("roles").values({ workspace_id: ws, name: "Sales lead" }).execute();
    expect(await counts()).toEqual({ ...ZERO, roles: 1, companyId: fresh.companyId });

    await editor.insertInto("people").values({ workspace_id: ws, name: "Pat Example" }).execute();
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, companyId: fresh.companyId });

    await editor.insertInto("clients").values({ workspace_id: ws, name: "Acme" }).execute();
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, clients: 1, companyId: fresh.companyId });

    // A process as createProcess makes it: the row, a draft, a start and an end, and the edge between them.
    const proc = await editor.insertInto("processes").values({ workspace_id: ws, name: "Sales pipeline", kind: "pipeline", entity_name: "lead", source: "manual" }).returning("id").executeTakeFirstOrThrow();
    const processId = proc.id;
    const opened = (await rpc(editor, "open_draft", { target_process: processId })) as { status: string; revision_id: string };
    expect(opened.status).toBe("ok");
    const [start, end] = [crypto.randomUUID(), crypto.randomUUID()];
    const base = { revision_id: opened.revision_id, workspace_id: ws, process_id: processId };
    await editor
      .insertInto("steps")
      .values([
        { ...base, id: start, name: "New lead", kind: "start", x: 60, y: 60 },
        { ...base, id: end, name: "Won", kind: "end", outcome: "won", x: 520, y: 60 },
      ])
      .execute();
    await editor.insertInto("edges").values({ ...base, from_step_id: start, to_step_id: end, probability: 1 }).execute();
    // A draft is a process, not yet a published one; the pages still have nothing to simulate.
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, clients: 1, processes: 1, companyId: fresh.companyId });
    expect(await loadProcessBySlug(editor, fresh.slug)).toBeNull();

    const published = (await rpc(editor, "publish_process", { target_process: processId, accept_estimates: true })) as { status: string };
    expect(published.status).toBe("published");
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, clients: 1, processes: 1, published: 1, companyId: fresh.companyId });
    const loaded = await loadProcessBySlug(editor, fresh.slug);
    expect(loaded?.live.process.id).toBe(processId);
  });
});
