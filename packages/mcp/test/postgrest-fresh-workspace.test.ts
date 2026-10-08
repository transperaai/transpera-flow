import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCompanyProcessId, loadLiveCompanyPart, loadProcessBySlug, loadSetupCounts, type Db } from "@transpera-flow/db";
import { createFreshWorkspace, removeFreshWorkspace, type FreshUser, type FreshWorkspace } from "./fresh-workspace";

// A new client's workspace (issue #243): only what `create_workspace` makes. The web app's pages treat "nothing published" as
// something to show, not as a missing workspace; these are the reads under them, as each kind of member makes them over PostgREST.
// Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

const USERS = ["agency", "owner", "editor", "member", "viewer"] as const satisfies readonly FreshUser[];

let admin: pg.Client;
let fresh: FreshWorkspace;
const dbs = {} as Record<FreshUser, Db>;

/** A signed-in session's client: the user's JWT as the bearer, as the web app sends it. supabase-js talks to <url>/rest/v1; PostgREST here serves from its root. */
const session = (jwt: string) =>
  createClient("http://postgrest.invalid", jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { authorization: `Bearer ${jwt}` },
      fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
    },
  }) as unknown as Db;

const ZERO = { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0 };

describe.skipIf(!POSTGREST_URL)("a new client's workspace over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    fresh = await createFreshWorkspace(admin, JWT_SECRET);
    for (const k of USERS) dbs[k] = session(fresh.users[k].jwt);
    const deadline = Date.now() + 60_000;
    while ((await loadLiveCompanyPart(dbs.owner, fresh.wsId).catch(() => null)) === null) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (fresh) await removeFreshWorkspace(admin, fresh);
    await admin?.end();
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
    const must = <T extends { error: { message: string } | null }>(r: T): T => {
      if (r.error) throw new Error(r.error.message);
      return r;
    };

    must(await editor.from("roles").insert({ workspace_id: ws, name: "Sales lead" }));
    expect(await counts()).toEqual({ ...ZERO, roles: 1, companyId: fresh.companyId });

    must(await editor.from("people").insert({ workspace_id: ws, name: "Pat Example" }));
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, companyId: fresh.companyId });

    must(await editor.from("clients").insert({ workspace_id: ws, name: "Acme" }));
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, clients: 1, companyId: fresh.companyId });

    // A process as createProcess makes it: the row, a draft, a start and an end, and the edge between them.
    const proc = must(await editor.from("processes").insert({ workspace_id: ws, name: "Sales pipeline", kind: "pipeline", entity_name: "lead", source: "manual" }).select("id").single());
    const processId = (proc.data as { id: string }).id;
    const opened = must(await editor.rpc("open_draft", { target_process: processId })).data as { status: string; revision_id: string };
    expect(opened.status).toBe("ok");
    const [start, end] = [crypto.randomUUID(), crypto.randomUUID()];
    const base = { revision_id: opened.revision_id, workspace_id: ws, process_id: processId };
    must(await editor.from("steps").insert([
      { ...base, id: start, name: "New lead", kind: "start", x: 60, y: 60 },
      { ...base, id: end, name: "Won", kind: "end", outcome: "won", x: 520, y: 60 },
    ]));
    must(await editor.from("edges").insert({ ...base, from_step_id: start, to_step_id: end, probability: 1 }));
    // A draft is a process, not yet a published one; the pages still have nothing to simulate.
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, clients: 1, processes: 1, companyId: fresh.companyId });
    expect(await loadProcessBySlug(editor, fresh.slug)).toBeNull();

    const published = must(await editor.rpc("publish_process", { target_process: processId, accept_estimates: true })).data as { status: string };
    expect(published.status).toBe("published");
    expect(await counts()).toEqual({ ...ZERO, roles: 1, people: 1, clients: 1, processes: 1, published: 1, companyId: fresh.companyId });
    const loaded = await loadProcessBySlug(editor, fresh.slug);
    expect(loaded?.live.process.id).toBe(processId);
  });
});
