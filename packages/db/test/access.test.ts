import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamPersonIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// What is left of per-workspace access after the three-roles strip (migration 20270103000000; docs/plans/cut-list.md item 9):
// the memberships table RLS reads, who may write to it (only the person link), who may list members, and proof that the old
// per-workspace lists, domain joins and the keep-an-owner guard are gone. "Who can sign in" and the sign-in sync are in
// deployment-access.test.ts; what each role can do across the tables is in role-matrix.test.ts.
//
// The roles: the Owner is the agency-admin JWT flag (no membership needed); an Agency admin holds an `owner` membership; a Viewer
// holds a `viewer` membership.

let db: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

type Claims = Record<string, unknown>;

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
  (await db.client.query("select role, source, active, person_id from memberships where user_id = $1 and workspace_id = $2", [userId, workspaceId]))
    .rows[0] as { role: string; source: string; active: boolean; person_id: string | null } | undefined;

/** A user holding `role` in Northbeam and a sign-in rule for their address, so the members list still shows them. */
async function withRole(email: string, role: "owner" | "viewer", listed = true) {
  const user = await createUser(db, email);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  if (listed) await db.client.query("insert into deployment_access (kind, value, role) values ('email', $1, $2)", [email, role === "owner" ? "agency_admin" : "viewer"]);
  return user;
}

describe("memberships hold two roles", () => {
  it.each(["agency_admin", "editor", "member"])("refuses the legacy role %s (23514)", async (role) => {
    const user = await createUser(db, `legacy-${role}@northbeam.example`);
    await expect(db.client.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, '${role}')`, [ws, user.id])).rejects.toMatchObject({
      code: "23514",
      constraint: "memberships_role_check",
    });
  });

  it("takes owner (an Agency admin) and viewer, and every row is the sync's ('manual')", async () => {
    const a = await withRole("two-roles-a@northbeam.example", "owner");
    const v = await withRole("two-roles-v@northbeam.example", "viewer");
    expect(await membership(a.id)).toMatchObject({ role: "owner", source: "manual", active: true });
    expect(await membership(v.id)).toMatchObject({ role: "viewer", source: "manual", active: true });
    await expect(db.client.query("update memberships set source = 'domain' where user_id = $1", [a.id])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("who writes memberships", () => {
  it("lets nobody signed in insert or delete one, whatever their role", async () => {
    const owner = await createUser(db, "writer-owner@transpera.example", { agency_admin: true });
    const admin = await withRole("writer-admin@northbeam.example", "owner");
    const target = await createUser(db, "writer-target@northbeam.example");
    for (const who of [owner, admin]) {
      await expect(
        db.as(who.claims, (c) => c.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, target.id])),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(db.as(who.claims, (c) => c.query("delete from memberships where user_id = $1", [admin.id]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("lets nobody signed in change a membership's role or active flag: that is the sign-in list's business", async () => {
    const owner = await createUser(db, "role-owner@transpera.example", { agency_admin: true });
    const admin = await withRole("role-admin@northbeam.example", "owner");
    const viewer = await withRole("role-viewer@northbeam.example", "viewer");
    for (const who of [owner, admin]) {
      await expect(db.as(who.claims, (c) => c.query("update memberships set role = 'owner' where user_id = $1", [viewer.id]))).rejects.toMatchObject({ code: "42501" });
      await expect(db.as(who.claims, (c) => c.query("update memberships set active = false where user_id = $1", [viewer.id]))).rejects.toMatchObject({ code: "42501" });
    }
    expect(await membership(viewer.id)).toMatchObject({ role: "viewer", active: true });
  });
});

describe("who lists members", () => {
  it("shows the Owner and an Agency admin the members, with email and last sign-in", async () => {
    const owner = await createUser(db, "lists-owner@transpera.example", { agency_admin: true });
    const admin = await withRole("lists-admin@northbeam.example", "owner");
    for (const who of [owner, admin]) {
      const rows = await db.as(who.claims, async (c) => (await c.query("select * from workspace_members($1)", [ws])).rows);
      expect(rows.map((r) => r.email), who.claims.sub as string).toContain("lists-admin@northbeam.example");
      expect(rows[0]).toHaveProperty("last_sign_in_at");
      expect(rows[0]).not.toHaveProperty("source");
    }
  });

  it("shows a viewer and a stranger nothing, and nobody anonymous may call it", async () => {
    const viewer = await withRole("lists-viewer@northbeam.example", "viewer");
    const stranger = await createUser(db, "lists-stranger@elsewhere.example");
    for (const who of [viewer, stranger]) {
      expect(await db.as(who.claims, async (c) => (await c.query("select * from workspace_members($1)", [ws])).rowCount)).toBe(0);
    }
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from workspace_members($1)", [ws])).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("leaves out a member the sign-in list no longer names", async () => {
    const admin = await withRole("unlisted-admin@northbeam.example", "owner");
    const gone = await withRole("unlisted-gone@northbeam.example", "viewer", false);
    const rows = await db.as(admin.claims, async (c) => (await c.query("select email from workspace_members($1)", [ws])).rows);
    expect(rows.map((r) => r.email)).toContain("unlisted-admin@northbeam.example");
    expect(rows.map((r) => r.email)).not.toContain("unlisted-gone@northbeam.example");
    expect(gone.id).toBeTruthy();
  });
});

describe("linking members to people", () => {
  const person = async (wsId: string, name: string) =>
    (await db.client.query("insert into people (workspace_id, name) values ($1, $2) returning id", [wsId, name])).rows[0].id as string;
  const myPerson = (claims: Claims, wsId: string) =>
    db.as(claims, async (c) => (await c.query("select public.my_person_id($1) as id", [wsId])).rows[0].id as string | null);

  it("lets an Agency admin link a viewer to a person, and my_person_id then names that person; the link is audited", async () => {
    const admin = await withRole("link-admin@northbeam.example", "owner");
    const viewer = await withRole("link-viewer@northbeam.example", "viewer");
    expect(await myPerson(viewer.claims, ws)).toBeNull();

    const target = northbeamPersonIds["Rosa Diaz"]!;
    const updated = await commitAs(admin.claims, async (c) =>
      (await c.query("update memberships set person_id = $1 where user_id = $2 and workspace_id = $3", [target, viewer.id, ws])).rowCount,
    );
    expect(updated).toBe(1);
    expect(await membership(viewer.id)).toMatchObject({ role: "viewer", person_id: target });
    expect(await myPerson(viewer.claims, ws)).toBe(target);
    const log = (
      await db.client.query("select actor_id, actor_kind, action from audit_log where target_table = 'memberships' and diff -> 'new' ->> 'user_id' = $1 and action = 'update'", [viewer.id])
    ).rows;
    expect(log).toEqual([{ actor_id: admin.id, actor_kind: "user", action: "update" }]);
  });

  it("lets the Owner link too", async () => {
    const owner = await createUser(db, "link-owner@transpera.example", { agency_admin: true });
    const viewer = await withRole("link-viewer2@northbeam.example", "viewer");
    const target = northbeamPersonIds["Leah Brooks"]!;
    const updated = await commitAs(owner.claims, async (c) => (await c.query("update memberships set person_id = $1 where user_id = $2", [target, viewer.id])).rowCount);
    expect(updated).toBe(1);
    expect(await myPerson(viewer.claims, ws)).toBe(target);
  });

  it("stops a viewer linking anyone, themselves included", async () => {
    const viewer = await withRole("link-nope@northbeam.example", "viewer");
    const victim = await withRole("link-victim@northbeam.example", "viewer");
    for (const user of [victim, viewer]) {
      const updated = await db.as(viewer.claims, async (c) =>
        (await c.query("update memberships set person_id = $1 where user_id = $2", [northbeamPersonIds["Rosa Diaz"], user.id])).rowCount,
      );
      expect(updated, user.id).toBe(0);
    }
  });

  it("returns null for an inactive membership, for another workspace and for someone with no membership", async () => {
    const user = await withRole("inactive-link@northbeam.example", "viewer");
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

  it("is null for the Owner with no membership, and not executable by anon", async () => {
    const owner = await createUser(db, "agency-link@transpera.example", { agency_admin: true });
    expect(await myPerson(owner.claims, ws)).toBeNull();
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select public.my_person_id($1)", [ws])).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("the audit log of access", () => {
  it("is readable by an Agency admin and the Owner, not by a viewer, and nobody writes it", async () => {
    const admin = await withRole("audit-admin@northbeam.example", "owner");
    const viewer = await withRole("audit-viewer@northbeam.example", "viewer");
    const owner = await createUser(db, "audit-owner@transpera.example", { agency_admin: true });
    const count = (claims: Claims) => db.as(claims, async (c) => Number((await c.query("select count(*) from audit_log")).rows[0].count));
    expect(await count(admin.claims)).toBeGreaterThan(0);
    expect(await count(owner.claims)).toBeGreaterThan(0);
    expect(await count(viewer.claims)).toBe(0);
    for (const who of [admin, viewer, owner]) {
      await expect(db.as(who.claims, (c) => c.query("insert into audit_log (action, target_table) values ('x', 'y')"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("the per-workspace access machinery is gone", () => {
  it("has no allowed-domain or pre-assigned-email tables, no reconcile, resolve or keep-an-owner functions", async () => {
    const tables = (await db.client.query("select to_regclass('public.workspace_domains') as d, to_regclass('public.workspace_access_emails') as e")).rows[0];
    expect(tables).toEqual({ d: null, e: null });
    const fns = (
      await db.client.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private')
           and p.proname in ('reconcile_access', 'reconcile_after_access_change', 'resolve_my_access', 'qualifies_for_domain',
                             'list_owner_is_last', 'access_emails_keep_owner', 'memberships_keep_owner')`,
      )
    ).rows;
    expect(fns).toEqual([]);
    const triggers = (await db.client.query("select tgname from pg_trigger where tgrelid = 'public.memberships'::regclass and not tgisinternal order by 1")).rows;
    expect(triggers).toEqual([{ tgname: "audit" }, { tgname: "set_updated_at" }]);
  });

  it("no longer lets a last Agency admin be protected: removing every Agency admin membership works (the Owner is the safety net)", async () => {
    const workspace = (await db.client.query("insert into workspaces (name, slug) values ('No admins', 'no-admins') returning id")).rows[0].id as string;
    const admin = await createUser(db, "last-admin@northbeam.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace, admin.id]);
    await db.client.query("update memberships set role = 'viewer' where workspace_id = $1", [workspace]);
    await db.client.query("delete from memberships where workspace_id = $1", [workspace]);
    expect((await db.client.query("select count(*)::int as n from memberships where workspace_id = $1", [workspace])).rows[0].n).toBe(0);
  });
});
