import { randomUUID } from "node:crypto";
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
import { rpc } from "@transpera-flow/db/client";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, errorOf, startTestDb, tokenDbFor, userClaims, type McpTestDb } from "./helpers";

let env: McpTestDb;
let admin: pg.Client;

// One throwaway database for the file's three suites.
beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

// Per-person privacy (issue #30, B1 part 2a; migration 20261207500000) as the web app and the connector reach it: a linked
// member's session loads a process bundle whose people are labels, an editor's loads the real names, and a member's API token sees
// only its own person in the summary.
describe("per-person privacy", () => {
  let db: pg.Client;
  const pid = { member: "", editor: "", memberPerson: "" };
  let memberSession: Db;
  let editorSession: Db;
  let memberToken = "";
  let options: McpHandlerOptions;
  const NORTHBEAM_PERSON = northbeamPersonIds["Leah Brooks"]!;

  beforeAll(async () => {
    db = admin;
    const tag = randomUUID().slice(0, 8);
    for (const k of ["member", "editor"] as const) {
      pid[k] = randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [pid[k], `priv-${k}-${tag}@example.com`]);
    }
    pid.memberPerson = NORTHBEAM_PERSON;
    await db.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'viewer', $3), ($1, $4, 'owner', null)", [
      NORTHBEAM_WORKSPACE_ID,
      pid.member,
      pid.memberPerson,
      pid.editor,
    ]);
    memberSession = env.dbAs(userClaims(pid.member));
    editorSession = env.dbAs(userClaims(pid.editor));
    const { token, hash } = generateApiToken();
    await db.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'privacy')", [pid.member, hash]);
    memberToken = token;
    options = env.options;
  });

  const bundle = async (c: Db) => {
    const workspace = await c.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("id", "=", NORTHBEAM_WORKSPACE_ID).executeTakeFirstOrThrow();
    const process = await c.selectFrom("processes").selectAll().where("id", "=", NORTHBEAM_PROCESS_ID).executeTakeFirstOrThrow();
    return loadProcessBundle(c, workspace, process as never, NORTHBEAM_REVISION_ID);
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
    const rows = await memberSession.selectFrom("people").select("id").where("workspace_id", "=", NORTHBEAM_WORKSPACE_ID).execute();
    expect(rows).toEqual([{ id: pid.memberPerson }]);
    // And only their own membership, so a label can't be tied to a person through user_id and person_id.
    const mine = await memberSession.selectFrom("memberships").select(["user_id", "person_id"]).where("workspace_id", "=", NORTHBEAM_WORKSPACE_ID).execute();
    expect(mine).toEqual([{ user_id: pid.member, person_id: pid.memberPerson }]);
    expect((await editorSession.selectFrom("memberships").select("id").where("workspace_id", "=", NORTHBEAM_WORKSPACE_ID).execute()).length).toBeGreaterThan(1);
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
      // The database: the function and the tables, as the member's session.
      seen.team_capacity = JSON.stringify(await rpc(memberSession, "team_capacity", { ws: NORTHBEAM_WORKSPACE_ID }));
      seen.people = JSON.stringify(await memberSession.selectFrom("people").selectAll().where("workspace_id", "=", NORTHBEAM_WORKSPACE_ID).execute());
      const others = await memberSession.selectFrom("people").selectAll().where("id", "<>", pid.memberPerson).execute();
      const rated = await memberSession.selectFrom("people").select(["id", "cost_rate"]).where("cost_rate", "is not", null).execute();
      seen.peopleOthers = JSON.stringify(others);
      seen.peopleRated = JSON.stringify(rated);
      seen.roles = JSON.stringify(await memberSession.selectFrom("roles").selectAll().where("workspace_id", "=", NORTHBEAM_WORKSPACE_ID).execute());
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
      expect(others).toEqual([]);
      expect(rated).toEqual([]);
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
describe("client health rules", () => {
  let db: pg.Client;
  let hws = "";
  const hu = { editor: "", member: "" };
  let editorSession: Db;
  let memberSession: Db;
  let editorToken: Db;
  const save = (c: Db, base: number | null, value: number | null) =>
    rpc(c, "save_health_rules", { ws: hws, base: { health_recover: base }, changes: { health_recover: value } });

  beforeAll(async () => {
    db = admin;
    const tag = randomUUID().slice(0, 8);
    hws = (await db.query("insert into workspaces (name, slug) values ('Health Co', $1) returning id", [`health-${tag}`])).rows[0].id as string;
    for (const k of ["editor", "member"] as const) {
      hu[k] = randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [hu[k], `health-${k}-${tag}@example.com`]);
    }
    await db.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [hws, hu.editor, hu.member]);
    editorSession = env.dbAs(userClaims(hu.editor));
    memberSession = env.dbAs(userClaims(hu.member));
    editorToken = (await tokenDbFor(env, hu.editor)).db;
  });

  it("an editor's session saves a rule, stamped and logged as them", async () => {
    const res = await save(editorSession, null, 7);
    expect(res).toMatchObject({ status: "saved", row: { settings: { health_recover: 7 } } });
    const w = (await db.query("select settings -> 'health_recover' as v, provenance -> 'settings.health_recover' ->> 'by' as by from workspaces where id = $1", [hws])).rows[0];
    expect(w).toEqual({ v: 7, by: hu.editor });
    const log = (await db.query("select actor_id, actor_kind from audit_log where workspace_id = $1 and target_table = 'workspaces'", [hws])).rows;
    expect(log).toEqual([{ actor_id: hu.editor, actor_kind: "user" }]);
  });

  it("a member's session gets not_found and changes nothing", async () => {
    const res = await save(memberSession, 7, 9);
    expect(res).toEqual({ status: "not_found" });
    expect((await db.query("select settings -> 'health_recover' as v from workspaces where id = $1", [hws])).rows[0].v).toBe(7);
  });

  it("an editor's API token is refused: the company model changes only by review", async () => {
    const res = await errorOf(() => save(editorToken, 7, 9));
    expect(res?.message).toMatch(/changes only by review/);
    expect((await db.query("select settings -> 'health_recover' as v from workspaces where id = $1", [hws])).rows[0].v).toBe(7);
  });
});
