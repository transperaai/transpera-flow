import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, type TestDb } from "./harness";

// Review of the strip (migration 20270105000000_strip_review.sql): the holes the three roles (20270103000000) left between "the list
// is the single source of truth" and what a live session or API token could still do.
//   1. A change to Who can sign in reaches memberships at once, not at the person's next sign-in: an Agency admin made a Viewer
//      stops seeing pay and managing the list on their open session and API tokens.
//   2. A guest (signed in only for a restricted share link) gets nothing from a membership they still hold.
//   3. An Agency admin can't make or unmake an Owner through an email rule that overrides an owner domain rule.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;

async function signUp(email: string) {
  const id = randomUUID();
  await db.client.query(`insert into better_auth."user" (id, name, email, "emailVerified") values ($1, 'Test', $2, true)`, [id, email]);
  return id;
}
const sync = async (id: string) => (await db.client.query("select private.sync_deployment_access($1, '{}', '[]') as r", [id])).rows[0].r as string | null;
const claimsOf = (id: string, meta: Record<string, unknown> = {}) => ({ sub: id, role: "authenticated", app_metadata: meta });
const ask = <T>(claims: Record<string, unknown>, sql: string, values: unknown[] = []) =>
  db.as(claims, async (c) => (await c.query(sql, values)).rows[0].v as T);
const roles = async (id: string) =>
  new Set((await db.client.query("select role::text || ':' || active as r from memberships where user_id = $1", [id])).rows.map((r) => r.r as string));

let ownerClaims: Record<string, unknown>;

beforeAll(async () => {
  db = await createTestDb();
  await db.client.query("update people set cost_rate = 55 where workspace_id = $1", [ws]);
  await db.client.query("insert into workspaces (name, slug) values ('Second Co', 'second-co')");
  await db.client.query(
    `insert into deployment_access (kind, value, role) values
       ('domain', 'client.co', 'viewer'), ('email', 'lead@client.co', 'agency_admin'), ('email', 'cs@client.co', 'agency_admin'),
       ('domain', 'hq.io', 'owner')`,
  );
  const owner = await signUp("owner@hq.io");
  expect(await sync(owner)).toBe("owner");
  ownerClaims = claimsOf(owner, { agency_admin: true });
});

afterAll(async () => {
  await db?.close();
});

describe("a change to Who can sign in applies at once", () => {
  it("lowers an Agency admin made a Viewer by another Agency admin: no pay and no list on their open session", async () => {
    const lead = await signUp("lead@client.co");
    const cs = await signUp("cs@client.co");
    expect(await sync(lead)).toBe("agency_admin");
    expect(await sync(cs)).toBe("agency_admin");
    expect(await ask(claimsOf(cs), "select public.can_see_people($1) as v", [ws])).toBe(true);

    // The lead demotes cs through RLS, as Settings > Access does (db.as rolls back, so check inside it). cs doesn't sign in again.
    await db.as(claimsOf(lead), async (c) => {
      expect((await c.query("update deployment_access set role = 'viewer' where value = 'cs@client.co'")).rowCount).toBe(1);
      await c.query("reset role");
      expect((await c.query("select distinct role::text as r from memberships where user_id = $1", [cs])).rows).toEqual([{ r: "viewer" }]);
    });
    expect(await roles(cs)).toEqual(new Set(["owner:true"]));
    await db.client.query("update deployment_access set role = 'viewer' where value = 'cs@client.co'");

    expect(await roles(cs)).toEqual(new Set(["viewer:true"]));
    expect(await ask(claimsOf(cs), "select public.can_see_people($1) as v", [ws])).toBe(false);
    expect(await ask(claimsOf(cs), "select public.can_edit_workspace($1) as v", [ws])).toBe(false);
    expect(await ask(claimsOf(cs), "select public.is_sign_in_admin() as v")).toBe(false);
    const pay = await ask<{ people: { cost_rate: number | null }[] }>(claimsOf(cs), "select public.team_capacity($1) as v", [ws]);
    expect(pay.people.every((p) => p.cost_rate === null)).toBe(true);
    // ... so they can't put themselves back.
    await expect(
      db.as(claimsOf(cs), async (c) => (await c.query("update deployment_access set role = 'agency_admin' where value = 'cs@client.co' returning id")).rowCount),
    ).resolves.toBe(0);
  });

  it("raises a Viewer made an Agency admin, and a domain change reaches everyone in it", async () => {
    const a = await signUp("a@client.co");
    const b = await signUp("b@client.co");
    expect(await sync(a)).toBe("viewer");
    expect(await sync(b)).toBe("viewer");
    await db.client.query("update deployment_access set role = 'agency_admin' where value = 'client.co'");
    expect(await roles(a)).toEqual(new Set(["owner:true"]));
    expect(await roles(b)).toEqual(new Set(["owner:true"]));
    await db.client.query("update deployment_access set role = 'viewer' where value = 'client.co'");
    expect(await roles(a)).toEqual(new Set(["viewer:true"]));
    expect(await roles(b)).toEqual(new Set(["viewer:true"]));
  });

  it("leaves someone the list refuses as they were, never raising them (a null role isn't an Agency admin)", async () => {
    const gone = await signUp("gone@gone.io");
    await db.client.query("insert into deployment_access (kind, value, role) values ('domain', 'gone.io', 'viewer')");
    expect(await sync(gone)).toBe("viewer");
    const before = await roles(gone);
    expect(before).toEqual(new Set(["viewer:true"]));
    await db.client.query("delete from deployment_access where value = 'gone.io'");
    expect(await roles(gone)).toEqual(before);
    // Any later change to the list, about anyone else, leaves them alone too.
    await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'unrelated@client.co', 'agency_admin')");
    expect(await roles(gone)).toEqual(before);
    // And someone who never signed up for a workspace and isn't listed gets no membership at all.
    const stranger = await signUp("never@nowhere.org");
    await db.client.query("update deployment_access set role = 'viewer' where value = 'unrelated@client.co'");
    expect(await roles(stranger)).toEqual(new Set());
    expect(await ask(claimsOf(gone), "select public.is_sign_in_admin() as v")).toBe(false);
  });

  it("keeps a migration's 'system' actor for the rest of its transaction", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("select set_config('transpera.actor_kind', 'system', true)");
      await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'kept@client.co', 'viewer')");
      expect((await db.client.query("select current_setting('transpera.actor_kind', true) as k")).rows[0].k).toBe("system");
    } finally {
      await db.client.query("rollback");
    }
  });

  it("records the membership changes as the system", async () => {
    const c = await signUp("c@client.co");
    await sync(c);
    await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'c@client.co', 'agency_admin')");
    const { rows } = await db.client.query(
      "select distinct actor_kind from audit_log where target_table = 'memberships' and action = 'update' and diff -> 'old' ->> 'role' = 'viewer' and target_id in (select id from memberships where user_id = $1)",
      [c],
    );
    expect(rows).toEqual([{ actor_kind: "system" }]);
  });
});

describe("a guest holds no workspace access, whatever memberships they still have", () => {
  it("reads nothing, edits nothing, sees no linked person and doesn't manage the list", async () => {
    // Someone who was an Agency admin, taken off the list, and now listed on a restricted share link: may_sign_in says 'guest'.
    const g = await signUp("former@elsewhere.org");
    const person = (await db.client.query("select id from people where workspace_id = $1 limit 1", [ws])).rows[0].id as string;
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'owner', $3)", [ws, g, person]);
    const guest = claimsOf(g, { agency_admin: false, guest: true });
    expect(await ask(guest, "select public.workspace_role($1) as v", [ws])).toBeNull();
    expect(await ask(guest, "select public.can_read_workspace($1) as v", [ws])).toBe(false);
    expect(await ask(guest, "select coalesce(public.can_edit_workspace($1), false) as v", [ws])).toBe(false);
    expect(await ask(guest, "select public.my_person_id($1) as v", [ws])).toBeNull();
    expect(await ask(guest, "select public.is_sign_in_admin() as v")).toBe(false);
    expect(await ask(guest, "select count(*)::int as v from people")).toBe(0);
    expect(await ask(guest, "select count(*)::int as v from workspaces")).toBe(0);
    // The same user without the guest mark (a normal session) still has the membership: only the mark changes.
    expect(await ask(claimsOf(g), "select public.can_edit_workspace($1) as v", [ws])).toBe(true);
  });
});

describe("only the Owner makes or unmakes an Owner", () => {
  const leadClaims = async () => claimsOf((await db.client.query("select id from auth.users where email = 'lead@client.co'")).rows[0].id as string);
  const asLead = async (sql: string) => db.as(await leadClaims(), (c) => c.query(sql));

  it("stops an Agency admin overriding an owner domain with an email rule (demoting an Owner)", async () => {
    await expect(asLead("insert into deployment_access (kind, value, role) values ('email', 'austin@hq.io', 'viewer')")).rejects.toMatchObject({ code: "42501" });
    await expect(asLead("insert into deployment_access (kind, value, role) values ('email', 'austin@hq.io', 'agency_admin')")).rejects.toMatchObject({ code: "42501" });
  });

  it("stops an Agency admin moving an email rule into an owner domain, or removing one there (promoting someone to Owner)", async () => {
    await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'contractor@hq.io', 'viewer'), ('email', 'temp@client.co', 'viewer')");
    expect(await db.client.query("select private.deployment_role('contractor@hq.io', true) as r").then((r) => r.rows[0].r)).toBe("viewer");
    await expect(asLead("delete from deployment_access where value = 'contractor@hq.io'")).rejects.toMatchObject({ code: "42501" });
    await expect(asLead("update deployment_access set role = 'agency_admin' where value = 'contractor@hq.io'")).rejects.toMatchObject({ code: "42501" });
    await expect(asLead("update deployment_access set value = 'austin@hq.io' where value = 'temp@client.co'")).rejects.toMatchObject({ code: "42501" });
    expect(await db.client.query("select count(*)::int as n from deployment_access where value in ('contractor@hq.io', 'temp@client.co')").then((r) => r.rows[0].n)).toBe(2);
  });

  it("still lets an Agency admin manage email rules outside an owner domain, and the Owner do anything", async () => {
    const r = await asLead("insert into deployment_access (kind, value, role) values ('email', 'new@client.co', 'agency_admin') returning id");
    expect(r.rowCount).toBe(1);
    const o = await db.as(ownerClaims, (c) => c.query("insert into deployment_access (kind, value, role) values ('email', 'austin@hq.io', 'viewer') returning id"));
    expect(o.rowCount).toBe(1);
    const d = await db.as(ownerClaims, (c) => c.query("delete from deployment_access where value = 'contractor@hq.io' returning id"));
    expect(d.rowCount).toBe(1);
  });
});
