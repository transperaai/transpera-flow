import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  loadProcessBundle,
  northbeamPersonIds,
  type Db,
} from "@transpera-flow/db";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, signJwt } from "./helpers";

// Keeping an owner (issue #30, B1 part 1; migration 20261206000000), as an API token reaches it: the request carries `x-api-token`
// on an anonymous JWT, the pre-request hook switches the transaction to `authenticated` with the token owner's claims, and the guard
// (which reads `current_user`) must fire there and not for the SECURITY DEFINER reconciliation behind it. Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Record<string, unknown>;

let ws = "";
const users = { owner: "", second: "", editor: "", agency: "" };
const tokens = { second: "" };
let owner: SupabaseClient;
let editor: SupabaseClient;
let agency: SupabaseClient;

/** An API token's client: an anonymous JWT plus `x-api-token`, as the MCP server sends it. */
function client(apiToken: string): SupabaseClient {
  const anon = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
  return createClient("http://postgrest.invalid", anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { authorization: `Bearer ${anon}`, "x-api-token": apiToken },
      fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
    },
  });
}

describe.skipIf(!POSTGREST_URL)("keeping an owner over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ws = (await one("insert into workspaces (name, slug) values ('Roles Co', $1) returning id", [`roles-${tag}`])).id as string;
    for (const k of Object.keys(users) as (keyof typeof users)[]) {
      users[k] = randomUUID();
      await admin.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [
        users[k],
        `roles-${k}-${tag}@example.com`,
        k === "agency" ? { agency_admin: true } : {},
      ]);
    }
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor')", [ws, users.owner, users.editor]);
    const issue = async (userId: string) => {
      const { token, hash } = generateApiToken();
      await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'roles')", [userId, hash]);
      return token;
    };
    owner = client(await issue(users.owner));
    editor = client(await issue(users.editor));
    agency = client(await issue(users.agency));
    tokens.second = await issue(users.second);
    const deadline = Date.now() + 60_000;
    while ((await owner.from("workspaces").select("id").eq("id", ws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (ws) {
      await admin.query("delete from workspaces where id = $1", [ws]);
      await admin.query("delete from audit_log where workspace_id = $1", [ws]);
    }
    await admin?.end();
  });

  const role = async (userId: string) => (await one("select role, active from memberships where workspace_id = $1 and user_id = $2", [ws, userId])) as { role: string; active: boolean } | undefined;

  it("refuses an owner's token demoting, deactivating or removing the last owner, with the guard's message", async () => {
    const demote = await owner.from("memberships").update({ role: "editor" }).eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(demote.error?.message).toMatch(/workspace_keeps_an_owner/);
    expect(demote.error?.code).toBe("23514");
    const off = await owner.from("memberships").update({ active: false }).eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(off.error?.message).toMatch(/workspace_keeps_an_owner/);
    const gone = await owner.from("memberships").delete().eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(gone.error?.message).toMatch(/workspace_keeps_an_owner/);
    expect(await role(users.owner)).toEqual({ role: "owner", active: true });
  });

  it("lets an editor's token change no membership at all", async () => {
    const res = await editor.from("memberships").update({ role: "owner" }).eq("workspace_id", ws).eq("user_id", users.editor).select("id");
    expect(res.data).toEqual([]);
    expect(await role(users.editor)).toEqual({ role: "editor", active: true });
  });

  it("allows the demotion once there is a second owner, and the new owner is then the last", async () => {
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, users.second]);
    const demote = await owner.from("memberships").update({ role: "editor" }).eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(demote.error).toBeNull();
    expect(demote.data).toHaveLength(1);
    expect(await role(users.owner)).toEqual({ role: "editor", active: true });
    // The demoted owner can no longer manage anything, and the second is now the last owner.
    const second = client(tokens.second);
    const again = await second.from("memberships").update({ role: "viewer" }).eq("workspace_id", ws).eq("user_id", users.second).select("id");
    expect(again.error?.message).toMatch(/workspace_keeps_an_owner/);
  });

  it("lets an agency admin's token remove the last owner", async () => {
    const gone = await agency.from("memberships").delete().eq("workspace_id", ws).eq("user_id", users.second).select("id");
    expect(gone.error).toBeNull();
    expect(gone.data).toHaveLength(1);
    expect(await role(users.second)).toBeUndefined();
  });
});

// Per-person privacy (issue #30, B1 part 2a; migration 20261207500000) as the web app and the connector reach it: a linked
// member's session loads a process bundle whose people are labels, an editor's loads the real names, and a member's API token sees
// only its own person in the summary.
describe.skipIf(!POSTGREST_URL)("per-person privacy over PostgREST", () => {
  const SUPABASE_URL = "https://project.supabase.test";
  let db: pg.Client;
  const pid = { member: "", editor: "", memberPerson: "" };
  let memberSession: SupabaseClient;
  let editorSession: SupabaseClient;
  let memberToken = "";
  let options: McpHandlerOptions;
  /** A signed-in session's client: the user's JWT as the bearer, as the web app sends it. */
  const session = (token: string): SupabaseClient =>
    createClient("http://postgrest.invalid", token, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
      },
    });
  const NORTHBEAM_PERSON = northbeamPersonIds["Leah Brooks"]!;
  const toPostgrest: typeof fetch = (input, init) => {
    if (input instanceof Request) throw new Error("expected supabase-js to pass a URL string");
    return fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);
  };

  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    const tag = randomUUID().slice(0, 8);
    for (const k of ["member", "editor"] as const) {
      pid[k] = randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [pid[k], `priv-${k}-${tag}@example.com`]);
    }
    pid.memberPerson = NORTHBEAM_PERSON;
    await db.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'member', $3), ($1, $4, 'editor', null)", [
      NORTHBEAM_WORKSPACE_ID,
      pid.member,
      pid.memberPerson,
      pid.editor,
    ]);
    const jwt = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    memberSession = session(jwt(pid.member));
    editorSession = session(jwt(pid.editor));
    const { token, hash } = generateApiToken();
    await db.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'privacy')", [pid.member, hash]);
    memberToken = token;
    options = { supabaseUrl: SUPABASE_URL, supabaseKey: signJwt({ role: "anon", iss: "test" }, JWT_SECRET), fetch: toPostgrest };
    const deadline = Date.now() + 60_000;
    while ((await memberSession.from("workspaces").select("id")).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (db) {
      await db.query("delete from memberships where user_id = any($1)", [[pid.member, pid.editor]]);
      await db.query("delete from api_tokens where user_id = $1", [pid.member]);
      await db.query("delete from auth.users where id = any($1)", [[pid.member, pid.editor]]);
    }
    await db?.end();
  });

  const bundle = async (c: SupabaseClient) => {
    const workspace = (await c.from("workspaces").select("id, name, slug, settings").eq("id", NORTHBEAM_WORKSPACE_ID).single()).data!;
    const process = (await c.from("processes").select("*").eq("id", NORTHBEAM_PROCESS_ID).single()).data!;
    return loadProcessBundle(c as unknown as Db, workspace, process as never, NORTHBEAM_REVISION_ID);
  };

  it("loadProcessBundle as a linked member: labels for everyone else, the editor's ids", async () => {
    const asMember = await bundle(memberSession);
    const asEditor = await bundle(editorSession);
    expect(asMember.viewer).toEqual({ seesEveryone: false, ownPersonId: pid.memberPerson });
    expect(asEditor.viewer).toEqual({ seesEveryone: true, ownPersonId: null });
    expect(asMember.people.map((p) => p.id).sort()).toEqual(asEditor.people.map((p) => p.id).sort());
    expect(asMember.personRoles).toHaveLength(asEditor.personRoles.length);
    const own = asMember.people.find((p) => p.id === pid.memberPerson)!;
    expect(own.name).toBe(asEditor.people.find((p) => p.id === pid.memberPerson)!.name);
    for (const p of asMember.people.filter((x) => x.id !== pid.memberPerson)) expect(p.name).toMatch(/^Team member \d+$/);
    // The editor's names are real.
    expect(asEditor.people.every((p) => !/^Team member/.test(p.name))).toBe(true);
    // The client roster's assignments come from the same call.
    expect(asMember.clientAssignments).toHaveLength(asEditor.clientAssignments?.length ?? 0);
  });

  it("a member's tables hold only their own person; their API token's get_workspace_summary lists exactly one", async () => {
    const rows = await memberSession.from("people").select("id").eq("workspace_id", NORTHBEAM_WORKSPACE_ID);
    expect(rows.data).toEqual([{ id: pid.memberPerson }]);
    // And only their own membership, so a label can't be tied to a person through user_id and person_id.
    const mine = await memberSession.from("memberships").select("user_id, person_id").eq("workspace_id", NORTHBEAM_WORKSPACE_ID);
    expect(mine.data).toEqual([{ user_id: pid.member, person_id: pid.memberPerson }]);
    expect((await editorSession.from("memberships").select("id").eq("workspace_id", NORTHBEAM_WORKSPACE_ID)).data!.length).toBeGreaterThan(1);
    const mcp = await connect(memberToken, options);
    const summary = await call<{ people: { id: string }[] }>(mcp, "get_workspace_summary");
    expect(summary.ok).toBe(true);
    expect(summary.data.people).toEqual([expect.objectContaining({ id: pid.memberPerson })]);
    await mcp.close();
  });
  it("no response a member can get contains any cost rate: team_capacity, the people endpoints and MCP (Austin, 6 Oct: no pay for members)", async () => {
    // Give everyone but the member's own person a rate nothing else would produce; restore afterwards.
    const before = (await db.query("select id, cost_rate::float8 as cost_rate from people where workspace_id = $1", [NORTHBEAM_WORKSPACE_ID])).rows as { id: string; cost_rate: number | null }[];
    const rates = new Map<string, number>();
    before.filter((p) => p.id !== pid.memberPerson).forEach((p, i) => rates.set(p.id, 913.37 + i * 11.11));
    try {
      for (const [id, rate] of rates) await db.query("update people set cost_rate = $1 where id = $2", [rate, id]);
      const seen: Record<string, string> = {};
      // The database: the function and the tables, through PostgREST as the member's session.
      seen.team_capacity = JSON.stringify((await memberSession.rpc("team_capacity", { ws: NORTHBEAM_WORKSPACE_ID })).data);
      seen.people = JSON.stringify((await memberSession.from("people").select("*").eq("workspace_id", NORTHBEAM_WORKSPACE_ID)).data);
      const others = await memberSession.from("people").select("*").neq("id", pid.memberPerson);
      const rated = await memberSession.from("people").select("id, cost_rate").not("cost_rate", "is", null);
      seen.peopleOthers = JSON.stringify(others.data);
      seen.peopleRated = JSON.stringify(rated.data);
      seen.roles = JSON.stringify((await memberSession.from("roles").select("*").eq("workspace_id", NORTHBEAM_WORKSPACE_ID)).data);
      // The app's loader.
      seen.bundle = JSON.stringify((await bundle(memberSession)).people);
      // MCP, as the member's own API token.
      const mcp = await connect(memberToken, options);
      for (const tool of ["get_workspace_summary", "get_bottlenecks", "get_facts", "list_findings", "list_issues", "get_process"]) {
        const r = await mcp.callTool({ name: tool, arguments: {} });
        seen[`mcp ${tool}`] = JSON.stringify(r.content);
      }
      const facts = await call<{ facts?: { cost: { per_month: number | null; pay_hidden?: boolean } }[] }>(mcp, "get_facts", {});
      await mcp.close();
      // Only their own person is readable, and Northbeam's own person has no rate here.
      expect(others.data).toEqual([]);
      expect(rated.data).toEqual([]);
      for (const [where, text] of Object.entries(seen)) {
        // No stored rate of anyone's, whatever the key it is under, and no cost_rate with a value.
        for (const rate of rates.values()) expect(text, `${where}: ${rate}`).not.toContain(String(rate));
        // (A role's default_cost_rate is the role, not a person's pay.)
        expect(text, where).not.toMatch(/(?<![a-z_])cost_rate\\?"\s*:\s*[0-9]/);
      }
      // The figures that need pay come back unavailable: marked, not 0.
      expect(facts.ok).toBe(true);
      expect(facts.data?.facts?.length ?? 0).toBeGreaterThan(0);
      for (const f of facts.data?.facts ?? []) if (f.cost.pay_hidden) expect(f.cost.per_month).toBeNull();
    } finally {
      for (const p of before) await db.query("update people set cost_rate = $1 where id = $2", [p.cost_rate, p.id]);
    }
  });
});

// Editors change the Client health rules (issue #30, B1 part 3; migration 20261209000000): `save_health_rules` is SECURITY DEFINER, so
// it must still know who the caller is (`auth.uid()` from the request's claims), stamp and log that person, and leave the company
// model to review for an API token (the `needs_review` trigger reads the claims at trigger depth 1).
describe.skipIf(!POSTGREST_URL)("client health rules over PostgREST", () => {
  let db: pg.Client;
  let hws = "";
  const hu = { editor: "", member: "" };
  let editorSession: SupabaseClient;
  let memberSession: SupabaseClient;
  let editorToken: SupabaseClient;
  const session = (token: string): SupabaseClient =>
    createClient("http://postgrest.invalid", token, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
      },
    });
  const save = (c: SupabaseClient, base: number | null, value: number | null) =>
    c.rpc("save_health_rules", { ws: hws, base: { health_recover: base }, changes: { health_recover: value } });

  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    const tag = randomUUID().slice(0, 8);
    hws = (await db.query("insert into workspaces (name, slug) values ('Health Co', $1) returning id", [`health-${tag}`])).rows[0].id as string;
    for (const k of ["editor", "member"] as const) {
      hu[k] = randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [hu[k], `health-${k}-${tag}@example.com`]);
    }
    await db.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'member')", [hws, hu.editor, hu.member]);
    const jwt = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editorSession = session(jwt(hu.editor));
    memberSession = session(jwt(hu.member));
    const { token, hash } = generateApiToken();
    await db.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'health')", [hu.editor, hash]);
    const anon = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
    editorToken = createClient("http://postgrest.invalid", anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { authorization: `Bearer ${anon}`, "x-api-token": token },
        fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
      },
    });
    const deadline = Date.now() + 60_000;
    while ((await editorSession.from("workspaces").select("id").eq("id", hws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (hws) {
      await db.query("delete from workspaces where id = $1", [hws]);
      await db.query("delete from audit_log where workspace_id = $1", [hws]);
    }
    if (db) {
      await db.query("delete from api_tokens where user_id = $1", [hu.editor]);
      await db.query("delete from auth.users where id = any($1)", [[hu.editor, hu.member]]);
    }
    await db?.end();
  });

  it("an editor's session saves a rule, stamped and logged as them", async () => {
    const res = await save(editorSession, null, 7);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ status: "saved", row: { settings: { health_recover: 7 } } });
    const w = (await db.query("select settings -> 'health_recover' as v, provenance -> 'settings.health_recover' ->> 'by' as by from workspaces where id = $1", [hws])).rows[0];
    expect(w).toEqual({ v: 7, by: hu.editor });
    const log = (await db.query("select actor_id, actor_kind from audit_log where workspace_id = $1 and target_table = 'workspaces'", [hws])).rows;
    expect(log).toEqual([{ actor_id: hu.editor, actor_kind: "user" }]);
  });

  it("a member's session gets not_found and changes nothing", async () => {
    const res = await save(memberSession, 7, 9);
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ status: "not_found" });
    expect((await db.query("select settings -> 'health_recover' as v from workspaces where id = $1", [hws])).rows[0].v).toBe(7);
  });

  it("an editor's API token is refused: the company model changes only by review", async () => {
    const res = await save(editorToken, 7, 9);
    expect(res.error?.message).toMatch(/changes only by review/);
    expect((await db.query("select settings -> 'health_recover' as v from workspaces where id = $1", [hws])).rows[0].v).toBe(7);
  });
});
