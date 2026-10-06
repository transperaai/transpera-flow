import { Client } from "pg";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_DOMAIN, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Workspace access without invitations (issue #51): pre-assigned emails,
// allowed domains with Google's hosted-domain check, who may manage them,
// removal and the audit log.

let db: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

type Claims = Record<string, unknown>;

const resolve = (claims: Claims) =>
  db.as(claims, async (c) => (await c.query("select workspace_id, role, source from resolve_my_access()")).rows);

/** Like `db.as`, but commits, for multi-step scenarios. Cleans up nothing. */
async function commitAs<T>(claims: Claims, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await fn(db.client);
    await db.client.query("commit");
    return result;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}

const membership = async (userId: string, workspaceId = ws) =>
  (
    await db.client.query("select role, source, active, person_id from memberships where user_id = $1 and workspace_id = $2", [
      userId,
      workspaceId,
    ])
  ).rows[0] as { role: string; source: string; active: boolean; person_id: string | null } | undefined;

const visibleWorkspaces = (claims: Claims) =>
  db.as(claims, async (c) => Number((await c.query("select count(*) from workspaces")).rows[0].count));

async function withRole(email: string, role: string) {
  const user = await createUser(db, email);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  return user;
}

describe("resolution at sign-in", () => {
  it("gives a pre-assigned email exactly its role and person link", async () => {
    const rosa = await createUser(db, "rosa.diaz@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    expect(await resolve(rosa.claims)).toEqual([{ workspace_id: ws, role: "owner", source: "access_list" }]);
    await commitAs(rosa.claims, (c) => c.query("select resolve_my_access()"));
    expect(await membership(rosa.id)).toEqual({
      role: "owner",
      source: "access_list",
      active: true,
      person_id: northbeamPersonIds["Rosa Diaz"],
    });
  });

  it("matches pre-assigned emails case-insensitively, even on a free-mail address", async () => {
    const sam = await createUser(db, "Sam.Patel.SEO@example.com", {}, { google: {} });
    expect(await resolve(sam.claims)).toEqual([{ workspace_id: ws, role: "member", source: "access_list" }]);
  });

  it("ignores a pre-assigned email that is not confirmed", async () => {
    const unconfirmed = await createUser(db, "leah.brooks@northbeam.example", {}, { unconfirmed: true });
    expect(await resolve(unconfirmed.claims)).toEqual([]);
  });

  it("joins a managed Google account on an allowed domain as member", async () => {
    const user = await createUser(db, "new.hire@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    expect(await resolve(user.claims)).toEqual([{ workspace_id: ws, role: "member", source: "domain" }]);
  });

  it("does not let a personal Google account (no hd) join by email domain", async () => {
    const personal = await createUser(db, "ex.staff@northbeam.example", {}, { google: {} });
    expect(await resolve(personal.claims)).toEqual([]);
    expect(await visibleWorkspaces(personal.claims)).toBe(0);
  });

  it("requires hd to match the allowed domain, not just the email", async () => {
    const other = await createUser(db, "someone@northbeam.example", {}, { google: { hd: "elsewhere.example" } });
    expect(await resolve(other.claims)).toEqual([]);
  });

  it("does not trust an hd claim the user wrote into user_metadata", async () => {
    const sneaky = await createUser(db, "sneaky@northbeam.example", {}, { google: {} });
    await db.client.query(
      `update auth.users set raw_user_meta_data = '{"custom_claims": {"hd": "northbeam.example"}, "hd": "northbeam.example"}' where id = $1`,
      [sneaky.id],
    );
    const claims = { ...sneaky.claims, user_metadata: { custom_claims: { hd: NORTHBEAM_DOMAIN } } };
    expect(await resolve(claims)).toEqual([]);
  });

  it("leaves a user with neither with no workspace", async () => {
    const stranger = await createUser(db, "stranger@gmail.com", {}, { google: {} });
    expect(await resolve(stranger.claims)).toEqual([]);
  });

  it("is idempotent and keeps a promotion of a domain member", async () => {
    const user = await createUser(db, "promoted@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    await db.client.query("update memberships set role = 'editor' where user_id = $1", [user.id]);
    const auditBefore = Number((await db.client.query("select count(*) from audit_log")).rows[0].count);
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    expect(await membership(user.id)).toMatchObject({ role: "editor", source: "domain" });
    expect(Number((await db.client.query("select count(*) from audit_log")).rows[0].count)).toBe(auditBefore);
  });

  it("never changes manual memberships", async () => {
    const admin = await withRole("leah.brooks+manual@northbeam.example", "viewer");
    await db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, $2, 'editor')", [
      ws,
      "leah.brooks+manual@northbeam.example",
    ]);
    expect(await membership(admin.id)).toMatchObject({ role: "viewer", source: "manual" });
    await db.client.query("delete from workspace_access_emails where email = $1", ["leah.brooks+manual@northbeam.example"]);
    expect(await membership(admin.id)).toMatchObject({ role: "viewer", source: "manual" });
  });

  it("refuses anonymous callers", async () => {
    await expect(db.as(null, (c) => c.query("select * from resolve_my_access()"))).rejects.toThrow(/not signed in/);
  });

  it("does not expose the internal functions", async () => {
    const user = await createUser(db, "curious@example.org");
    await expect(
      db.as(user.claims, (c) => c.query("select reconcile_access($1)", [user.id])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.as(user.claims, (c) => c.query("select qualifies_for_domain($1, 'northbeam.example')", [user.id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("allowed domains", () => {
  it.each(["gmail.com", "outlook.com", "hotmail.com", "icloud.com", "yahoo.com", "GMAIL.COM"])("rejects free-mail %s", async (d) => {
    const agency = await createUser(db, `agency-${d}@transpera.example`, { agency_admin: true });
    await expect(
      db.as(agency.claims, (c) => c.query("insert into workspace_domains (workspace_id, domain) values ($1, lower($2))", [ws, d])),
    ).rejects.toThrow(/workspace_domains_not_free_mail/);
  });

  it("rejects malformed domains and a domain another workspace already has", async () => {
    await expect(
      db.client.query("insert into workspace_domains (workspace_id, domain) values ($1, 'Acme.com')", [ws]),
    ).rejects.toThrow(/workspace_domains_domain_format/);
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Other co', 'other-co') returning id")).rows[0]
      .id as string;
    await expect(
      db.client.query("insert into workspace_domains (workspace_id, domain) values ($1, $2)", [other, NORTHBEAM_DOMAIN]),
    ).rejects.toThrow(/workspace_domains_domain_key/);
  });

  it("rejects agency_admin as a pre-assigned role", async () => {
    await expect(
      db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, 'x@y.example', 'agency_admin')", [ws]),
    ).rejects.toThrow(/workspace_access_emails_role_check/);
  });
});

describe("who can manage access", () => {
  const tryManage = (claims: Claims) =>
    db.as(claims, async (c) => {
      const read = (await c.query("select count(*) from workspace_access_emails")).rows[0].count;
      await c.query("savepoint s");
      let inserted = true;
      try {
        await c.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, 'probe@acme.example', 'viewer')", [ws]);
        await c.query("insert into workspace_domains (workspace_id, domain) values ($1, 'probe.example')", [ws]);
      } catch {
        inserted = false;
        await c.query("rollback to savepoint s");
      }
      const updated = (await c.query("update workspace_access_emails set role = 'viewer' where email = 'leah.brooks@northbeam.example'"))
        .rowCount;
      const deleted = (await c.query("delete from workspace_domains where domain = $1", [NORTHBEAM_DOMAIN])).rowCount;
      return { read: Number(read), inserted, updated, deleted };
    });

  it("lets owners and agency admins manage domains and the list", async () => {
    const owner = await withRole("owner@northbeam.example", "owner");
    const agency = await createUser(db, "austin@transpera.example", { agency_admin: true });
    for (const u of [owner, agency]) {
      expect(await tryManage(u.claims)).toEqual({ read: 3, inserted: true, updated: 1, deleted: 1 });
    }
  });

  it.each(["editor", "member", "viewer"])("stops a %s from seeing or changing access", async (role) => {
    const user = await withRole(`${role}-rls@northbeam.example`, role);
    expect(await tryManage(user.claims)).toEqual({ read: 0, inserted: false, updated: 0, deleted: 0 });
    expect(await db.as(user.claims, async (c) => (await c.query("select * from workspace_members($1)", [ws])).rowCount)).toBe(0);
    expect(
      await db.as(user.claims, async (c) => (await c.query("update memberships set role = 'owner' where workspace_id = $1", [ws])).rowCount),
    ).toBe(0);
  });

  it("lets an owner list members with email and last sign-in", async () => {
    const owner = await withRole("owner2@northbeam.example", "owner");
    const rows = await db.as(owner.claims, async (c) => (await c.query("select * from workspace_members($1)", [ws])).rows);
    expect(rows.map((r) => r.email)).toContain("owner2@northbeam.example");
    expect(rows[0]).toHaveProperty("last_sign_in_at");
  });

  it("stops owners granting or touching agency_admin memberships", async () => {
    const owner = await withRole("owner3@northbeam.example", "owner");
    const target = await createUser(db, "target@northbeam.example");
    await expect(
      db.as(owner.claims, (c) =>
        c.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'agency_admin')", [ws, target.id]),
      ),
    ).rejects.toThrow(/row-level security/);
    const admin = await withRole("agency-member@transpera.example", "agency_admin");
    expect(
      await db.as(owner.claims, async (c) => (await c.query("delete from memberships where user_id = $1", [admin.id])).rowCount),
    ).toBe(0);
  });
});

describe("removal and audit", () => {
  it("removes access on the next request when the email leaves the list, and audits it", async () => {
    const owner = await withRole("owner4@northbeam.example", "owner");
    const temp = await createUser(db, "temp.contractor@example.com", {}, { google: {} });
    await commitAs(owner.claims, (c) =>
      c.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, 'temp.contractor@example.com', 'editor')", [ws]),
    );
    // Already signed in: the trigger grants access without another sign-in.
    expect(await membership(temp.id)).toMatchObject({ role: "editor", source: "access_list" });
    expect(await visibleWorkspaces(temp.claims)).toBe(1);

    await commitAs(owner.claims, (c) => c.query("update workspace_access_emails set role = 'viewer' where email = 'temp.contractor@example.com'"));
    expect(await membership(temp.id)).toMatchObject({ role: "viewer" });

    await commitAs(owner.claims, (c) => c.query("delete from workspace_access_emails where email = 'temp.contractor@example.com'"));
    expect(await membership(temp.id)).toBeUndefined();
    expect(await visibleWorkspaces(temp.claims)).toBe(0);

    const log = (
      await db.client.query(
        "select actor_id, actor_kind, action, target_table from audit_log where diff::text like '%temp.contractor%' or diff -> 'old' ->> 'user_id' = $1::text or diff -> 'new' ->> 'user_id' = $1::text order by created_at, action",
        [temp.id],
      )
    ).rows;
    expect(log).toEqual(
      expect.arrayContaining([
        { actor_id: owner.id, actor_kind: "user", action: "insert", target_table: "workspace_access_emails" },
        { actor_id: owner.id, actor_kind: "user", action: "insert", target_table: "memberships" },
        { actor_id: owner.id, actor_kind: "user", action: "update", target_table: "memberships" },
        { actor_id: owner.id, actor_kind: "user", action: "delete", target_table: "workspace_access_emails" },
        { actor_id: owner.id, actor_kind: "user", action: "delete", target_table: "memberships" },
      ]),
    );
  });

  it("falls back to member when a listed domain user leaves the list", async () => {
    const user = await createUser(db, "listed@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    await db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, 'listed@northbeam.example', 'editor')", [ws]);
    expect(await membership(user.id)).toMatchObject({ role: "editor", source: "access_list" });
    await db.client.query("delete from workspace_access_emails where email = 'listed@northbeam.example'");
    expect(await membership(user.id)).toMatchObject({ role: "member", source: "domain" });
  });

  it("removes domain members when the domain is removed", async () => {
    const user = await createUser(db, "domain.only@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    expect(await membership(user.id)).toMatchObject({ source: "domain" });
    await db.client.query("begin");
    try {
      await db.client.query("delete from workspace_domains where domain = $1", [NORTHBEAM_DOMAIN]);
      expect(await membership(user.id)).toBeUndefined();
      // Adding it back lets them in again straight away.
      await db.client.query("insert into workspace_domains (workspace_id, domain) values ($1, $2)", [ws, NORTHBEAM_DOMAIN]);
      expect(await membership(user.id)).toMatchObject({ role: "member", source: "domain" });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("blocks a deactivated member, and signing in again does not reactivate them", async () => {
    const user = await createUser(db, "deactivated@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    expect(await visibleWorkspaces(user.claims)).toBe(1);
    await db.client.query("update memberships set active = false where user_id = $1", [user.id]);
    expect(await visibleWorkspaces(user.claims)).toBe(0);
    expect(await resolve(user.claims)).toEqual([]);
    expect(await membership(user.id)).toMatchObject({ active: false });
  });

  it("records automatic joins as system actions and lets only managers read the log", async () => {
    const user = await createUser(db, "auto.join@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    const row = (
      await db.client.query("select actor_kind, action from audit_log where target_table = 'memberships' and diff -> 'new' ->> 'user_id' = $1", [
        user.id,
      ])
    ).rows;
    expect(row).toEqual([{ actor_kind: "system", action: "insert" }]);
    const editor = await withRole("editor-audit@northbeam.example", "editor");
    expect(await db.as(editor.claims, async (c) => Number((await c.query("select count(*) from audit_log")).rows[0].count))).toBe(0);
    await expect(
      db.as(editor.claims, (c) => c.query("insert into audit_log (action, target_table) values ('x', 'y')")),
    ).rejects.toThrow(/permission denied/);
  });
});

// Keeping an owner and linking members to people (issue #30, B1 part 1; migration 20261206000000). Each test makes its own
// workspace, so the rule is exercised on workspaces with exactly the owners the test gives them.

describe("keeping an owner", () => {
  let n = 0;
  const guard = /workspace_keeps_an_owner/;

  /** A workspace with the given owners (manual memberships), and the user ids. */
  async function workspaceWith(owners: number) {
    n += 1;
    const wsId = (await db.client.query("insert into workspaces (name, slug) values ($1, $2) returning id", [`Guard ${n}`, `guard-${n}`])).rows[0]
      .id as string;
    const users = [];
    for (let i = 0; i < owners; i++) {
      const u = await createUser(db, `owner${i}-guard${n}@guard.example`);
      await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsId, u.id]);
      users.push(u);
    }
    return { wsId, users };
  }

  /** Runs `run` as the claims in a rolled-back transaction, inside a savepoint, and returns the error or the row count. */
  const attempt = (claims: Claims, run: (c: pg.Client) => Promise<{ rowCount: number | null }>) =>
    db.as(claims, async (c) => {
      await c.query("savepoint attempt");
      try {
        return { rows: (await run(c)).rowCount, error: null as { message: string; code?: string } | null };
      } catch (e) {
        return { rows: null, error: e as { message: string; code?: string } };
      }
    });

  const change = (wsId: string, userId: string, set: string | null) => (c: pg.Client) =>
    set
      ? c.query(`update memberships set ${set} where workspace_id = $1 and user_id = $2`, [wsId, userId])
      : c.query("delete from memberships where workspace_id = $1 and user_id = $2", [wsId, userId]);

  it.each([
    ["demote", "role = 'editor'"],
    ["deactivate", "active = false"],
    ["delete", null],
  ])("the last active owner can't %s themselves", async (_, set) => {
    const { wsId, users } = await workspaceWith(1);
    const res = await attempt(users[0]!.claims, change(wsId, users[0]!.id, set));
    expect(res.error?.message).toMatch(guard);
    expect(res.error?.code).toBe("23514");
  });

  it("stops one owner demoting another when that leaves none (only inactive owners remain)", async () => {
    const { wsId, users } = await workspaceWith(2);
    await db.client.query("update memberships set active = false where workspace_id = $1 and user_id = $2", [wsId, users[1]!.id]);
    const res = await attempt(users[0]!.claims, change(wsId, users[0]!.id, "role = 'viewer'"));
    expect(res.error?.message).toMatch(guard);
  });

  it.each([
    ["demote", "role = 'editor'"],
    ["deactivate", "active = false"],
    ["delete", null],
  ])("with a second owner, an owner can %s themselves", async (_, set) => {
    const { wsId, users } = await workspaceWith(2);
    expect(await attempt(users[0]!.claims, change(wsId, users[0]!.id, set))).toEqual({ rows: 1, error: null });
  });

  it("lets an owner change anything else about the last owner row, such as the person link", async () => {
    const { wsId, users } = await workspaceWith(1);
    const person = (await db.client.query("insert into people (workspace_id, name) values ($1, 'Pat') returning id", [wsId])).rows[0].id;
    expect(await attempt(users[0]!.claims, change(wsId, users[0]!.id, `person_id = '${person}'`))).toEqual({ rows: 1, error: null });
  });

  it("lets an agency admin remove the last owner (offboarding)", async () => {
    const { wsId, users } = await workspaceWith(1);
    const agency = await createUser(db, `agency-guard${n}@transpera.example`, { agency_admin: true });
    expect(await attempt(agency.claims, change(wsId, users[0]!.id, null))).toEqual({ rows: 1, error: null });
  });

  it("allows a workspace that has no owner at all, and adding the first; the guard bites from then on", async () => {
    const { wsId } = await workspaceWith(0);
    // A manager who isn't an agency admin by JWT flag (an agency_admin membership), so the guard applies to them.
    const manager = await createUser(db, `manager-guard${n}@transpera.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'agency_admin')", [wsId, manager.id]);
    const first = await createUser(db, `first-guard${n}@guard.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [wsId, first.id]);
    await db.as(manager.claims, async (c) => {
      expect((await c.query("update memberships set role = 'owner' where user_id = $1 and workspace_id = $2", [first.id, wsId])).rowCount).toBe(1);
      await c.query("savepoint s");
      await expect(c.query("update memberships set role = 'editor' where user_id = $1 and workspace_id = $2", [first.id, wsId])).rejects.toThrow(guard);
      await c.query("rollback to savepoint s");
    });
  });

  it.each([
    ["source", "source = 'manual'"],
    ["workspace", null],
  ])("refuses the last owner changing their %s", async (what, set) => {
    const { wsId, users } = await workspaceWith(1);
    await db.client.query("update memberships set source = 'domain' where workspace_id = $1", [wsId]);
    const other = (await workspaceWith(1)).wsId;
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [other, users[0]!.id]);
    const sql = set ?? `workspace_id = '${other}'`;
    const res = await attempt(users[0]!.claims, change(wsId, users[0]!.id, what === "source" ? set : sql));
    // (They own the other workspace too, so row-level security would let the move through: the guard is what stops it.)
    expect(res.error?.message ?? res.error).toMatch(guard);
  });

  it("refuses changing the last owner's source then letting resolve_my_access drop them", async () => {
    const { wsId } = await workspaceWith(0);
    const owner = await createUser(db, `listsrc-guard${n}@guard.example`, {}, { google: {} });
    await db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, $2, 'owner')", [wsId, `listsrc-guard${n}@guard.example`]);
    const res = await attempt(owner.claims, (c) =>
      c.query("update memberships set source = 'domain' where workspace_id = $1 and user_id = $2", [wsId, owner.id]),
    );
    expect(res.error?.message).toMatch(guard);
    expect(await membership(owner.id, wsId)).toMatchObject({ role: "owner", source: "access_list" });
  });

  it("serialises two owners demoting each other at the same moment, so one owner is left", async () => {
    const { wsId, users } = await workspaceWith(2);
    const open = async (claims: Claims) => {
      const c = new Client({ connectionString: db.url });
      await c.connect();
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      return c;
    };
    const demote = (c: Client, userId: string) =>
      c.query("update memberships set role = 'editor' where workspace_id = $1 and user_id = $2", [wsId, userId]);
    const [one, two] = [await open(users[0]!.claims), await open(users[1]!.claims)];
    try {
      await demote(one, users[1]!.id);
      let settled = false;
      const second = demote(two, users[0]!.id).then(
        () => ({ error: null as Error | null }),
        (e: Error) => ({ error: e }),
      ).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 400));
      expect(settled, "the second demotion waits for the first").toBe(false);
      await one.query("commit");
      expect((await second).error?.message).toMatch(guard);
    } finally {
      await two.query("rollback").catch(() => undefined);
      await one.query("rollback").catch(() => undefined);
      await one.end();
      await two.end();
    }
    const owners = (await db.client.query("select count(*) from memberships where workspace_id = $1 and role = 'owner'", [wsId])).rows[0].count;
    expect(owners).toBe("1");
  });

  describe("on the pre-assigned list", () => {
    /** A workspace whose one owner got in by a pre-assigned email, so the list row and the membership are linked. */
    async function listedOwner() {
      const { wsId } = await workspaceWith(0);
      const owner = await createUser(db, `listed-guard${n}@guard.example`, {}, { google: {} });
      await db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, $2, 'owner')", [
        wsId,
        `listed-guard${n}@guard.example`,
      ]);
      expect(await membership(owner.id, wsId)).toMatchObject({ role: "owner", source: "access_list" });
      return { wsId, owner, email: `listed-guard${n}@guard.example` };
    }
    const listRow = (wsId: string, email: string, set: string | null) => (c: pg.Client) =>
      set
        ? c.query(`update workspace_access_emails set ${set} where workspace_id = $1 and email = $2`, [wsId, email])
        : c.query("delete from workspace_access_emails where workspace_id = $1 and email = $2", [wsId, email]);

    it.each([
      ["remove", null],
      ["demote", "role = 'editor'"],
      ["re-address", "email = 'someone.else@guard.example'"],
    ])("refuses to %s the last owner's row", async (_, set) => {
      const { wsId, owner, email } = await listedOwner();
      const res = await attempt(owner.claims, listRow(wsId, email, set));
      expect(res.error?.message).toMatch(guard);
      expect(res.error?.code).toBe("23514");
    });

    it("refuses pointing the last list owner's row at another workspace they own", async () => {
      const { wsId, owner, email } = await listedOwner();
      const other = (await workspaceWith(0)).wsId;
      await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [other, owner.id]);
      const res = await attempt(owner.claims, listRow(wsId, email, `workspace_id = '${other}'`));
      expect(res.error?.message).toMatch(guard);
      expect(await membership(owner.id, wsId)).toMatchObject({ role: "owner" });
    });

    it("does not apply to SQL run as another role (support work as the superuser)", async () => {
      const { wsId, owner, email } = await listedOwner();
      await db.client.query("delete from workspace_access_emails where workspace_id = $1 and email = $2", [wsId, email]);
      expect(await membership(owner.id, wsId)).toBeUndefined();
    });

    it("works with a second owner", async () => {
      const { wsId, owner, email } = await listedOwner();
      const second = await createUser(db, `second-guard${n}@guard.example`);
      await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsId, second.id]);
      expect(await attempt(owner.claims, listRow(wsId, email, null))).toEqual({ rows: 1, error: null });
    });

    it("lets an owner change the person on the last owner's row", async () => {
      const { wsId, owner, email } = await listedOwner();
      const person = (await db.client.query("insert into people (workspace_id, name) values ($1, 'Pat') returning id", [wsId])).rows[0].id;
      expect(await attempt(owner.claims, listRow(wsId, email, `person_id = '${person}'`))).toEqual({ rows: 1, error: null });
    });

    it("lets an agency admin remove the last owner's row, which removes their access", async () => {
      const { wsId, owner, email } = await listedOwner();
      const agency = await createUser(db, `agency-listed${n}@transpera.example`, { agency_admin: true });
      await commitAs(agency.claims, (c) => listRow(wsId, email, null)(c));
      expect(await membership(owner.id, wsId)).toBeUndefined();
    });

    it("lets resolve_my_access remove an access-list member whose row is gone, and does not guard it", async () => {
      const { wsId, owner, email } = await listedOwner();
      // Take the row away as the superuser (no trigger of the caller's), then let the owner's next sign-in reconcile.
      await db.client.query("alter table workspace_access_emails disable trigger user");
      await db.client.query("delete from workspace_access_emails where workspace_id = $1 and email = $2", [wsId, email]);
      await db.client.query("alter table workspace_access_emails enable trigger user");
      expect(await membership(owner.id, wsId)).toMatchObject({ role: "owner" });
      await commitAs(owner.claims, (c) => c.query("select resolve_my_access()"));
      expect(await membership(owner.id, wsId)).toBeUndefined();
    });

    it("does not stop a workspace delete from cascading through the list", async () => {
      const { wsId, owner } = await listedOwner();
      await db.client.query("delete from workspaces where id = $1", [wsId]);
      expect(await membership(owner.id, wsId)).toBeUndefined();
      expect((await db.client.query("select count(*) from workspace_access_emails where workspace_id = $1", [wsId])).rows[0].count).toBe("0");
    });
  });

  it("does not stop a workspace with an owner being deleted", async () => {
    const { wsId, users } = await workspaceWith(1);
    await db.client.query("delete from workspaces where id = $1", [wsId]);
    expect(await membership(users[0]!.id, wsId)).toBeUndefined();
  });

  it("does not stop the auth user of the last owner being deleted", async () => {
    const { wsId, users } = await workspaceWith(1);
    await db.client.query("delete from auth.users where id = $1", [users[0]!.id]);
    expect(await membership(users[0]!.id, wsId)).toBeUndefined();
  });

  it("known gap: an owner who joined by domain, promoted, loses the membership when they delete the domain (reconciliation isn't guarded)", async () => {
    const { wsId } = await workspaceWith(0);
    await db.client.query("insert into workspace_domains (workspace_id, domain) values ($1, 'gap-guard.example')", [wsId]);
    const user = await createUser(db, "gap@gap-guard.example", {}, { google: { hd: "gap-guard.example" } });
    await commitAs(user.claims, (c) => c.query("select resolve_my_access()"));
    await db.client.query("update memberships set role = 'owner' where user_id = $1 and workspace_id = $2", [user.id, wsId]);
    await commitAs(user.claims, (c) => c.query("delete from workspace_domains where workspace_id = $1", [wsId]));
    expect(await membership(user.id, wsId)).toBeUndefined();
  });
});

describe("linking members to people", () => {
  const person = async (wsId: string, name: string) =>
    (await db.client.query("insert into people (workspace_id, name) values ($1, $2) returning id", [wsId, name])).rows[0].id as string;
  const myPerson = (claims: Claims, wsId: string) =>
    db.as(claims, async (c) => (await c.query("select public.my_person_id($1) as id", [wsId])).rows[0].id as string | null);

  it("lets an owner link a domain member to a person, and my_person_id then names that person", async () => {
    const owner = await withRole("owner-link@northbeam.example", "owner");
    const member = await createUser(db, "link.me@northbeam.example", {}, { google: { hd: NORTHBEAM_DOMAIN } });
    await commitAs(member.claims, (c) => c.query("select resolve_my_access()"));
    expect(await membership(member.id)).toMatchObject({ source: "domain", person_id: null });
    expect(await myPerson(member.claims, ws)).toBeNull();

    const target = northbeamPersonIds["Rosa Diaz"]!;
    const updated = await commitAs(owner.claims, async (c) =>
      (await c.query("update memberships set person_id = $1 where user_id = $2 and workspace_id = $3", [target, member.id, ws])).rowCount,
    );
    expect(updated).toBe(1);
    expect(await membership(member.id)).toMatchObject({ source: "domain", person_id: target });
    expect(await myPerson(member.claims, ws)).toBe(target);
    // Signing in again keeps the link.
    await commitAs(member.claims, (c) => c.query("select resolve_my_access()"));
    expect(await myPerson(member.claims, ws)).toBe(target);
  });

  it("stops an editor linking anyone", async () => {
    const editor = await withRole("editor-link@northbeam.example", "editor");
    const victim = await withRole("victim-link@northbeam.example", "member");
    const updated = await db.as(editor.claims, async (c) =>
      (await c.query("update memberships set person_id = $1 where user_id = $2", [northbeamPersonIds["Rosa Diaz"], victim.id])).rowCount,
    );
    expect(updated).toBe(0);
  });

  it("returns null for an inactive membership, for another workspace and for someone with no membership", async () => {
    const user = await withRole("inactive-link@northbeam.example", "member");
    const mine = await person(ws, "Linked Lee");
    await db.client.query("update memberships set person_id = $1 where user_id = $2", [mine, user.id]);
    expect(await myPerson(user.claims, ws)).toBe(mine);
    await db.client.query("update memberships set active = false where user_id = $1", [user.id]);
    expect(await myPerson(user.claims, ws)).toBeNull();
    await db.client.query("update memberships set active = true where user_id = $1", [user.id]);
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Link other', 'link-other') returning id")).rows[0].id;
    expect(await myPerson(user.claims, other)).toBeNull();
    const stranger = await createUser(db, "stranger-link@example.com");
    expect(await myPerson(stranger.claims, ws)).toBeNull();
  });

  it("is null for an agency admin with no membership, and not executable by anon", async () => {
    const agency = await createUser(db, "agency-link@transpera.example", { agency_admin: true });
    expect(await myPerson(agency.claims, ws)).toBeNull();
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select public.my_person_id($1)", [ws])).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});
