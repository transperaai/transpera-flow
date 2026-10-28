import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { applyMigrations } from "../src/migrations";
import { createTestDb, createUser, type TestDb } from "./harness";

// Migration 20270103000000 on a database full of rows, the way the cutover runs it (the production copy is imported at row 76,
// then the remaining migrations run on it): the data mapping, what is dropped, and that what each old role could do (and see:
// pay above all) is what the new role can do. The role words at the base are the old ones: memberships agency_admin / owner /
// editor / member / viewer, and the sign-in list's admin / editor / viewer.

const BASE = "20261231000000";
const ws = NORTHBEAM_WORKSPACE_ID;

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
type Team = { sees_everyone: boolean; people: { id: string; name: string; cost_rate: number | null }[] };
const team = (claims: Record<string, unknown>) => db.as(claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t as Team);
const canEdit = (claims: Record<string, unknown>) => db.as(claims, async (c) => (await c.query("select public.can_edit_workspace($1) as ok", [ws])).rows[0].ok as boolean);
const seesPay = async (claims: Record<string, unknown>) => {
  // A deactivated membership reads nothing: team_capacity refuses it.
  const t = await team(claims).catch(() => null);
  return t !== null && t.sees_everyone && t.people.some((p) => p.cost_rate !== null);
};

const before: Record<string, { edit: boolean; pay: boolean }> = {};
const beforeSignIn: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  // The old per-workspace lists, filled first (a change to a list reconciles memberships), and pay set, so seeing it is a difference.
  await db.client.query("update people set cost_rate = 55 where workspace_id = $1", [ws]);
  await db.client.query("insert into workspace_domains (workspace_id, domain) values ($1, 'cutover.example')", [ws]);
  await db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, 'listed@cutover.example', 'editor')", [ws]);
  // A person per way of being in the workspace at the base.
  for (const [name, role, source, active] of [
    ["agencyRole", "agency_admin", "manual", true],
    ["owner", "owner", "access_list", true],
    ["editor", "editor", "domain", true],
    ["member", "member", "domain", true],
    ["viewer", "viewer", "manual", true],
    ["removed", "member", "domain", false],
  ] as const) {
    users[name] = await createUser(db, `${name}@cutover.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role, source, active) values ($1, $2, $3, $4, $5)", [ws, users[name]!.id, role, source, active]);
  }
  users.flag = await createUser(db, "flag@cutover.example", { agency_admin: true });
  await db.client.query(
    `insert into deployment_access (kind, value, role) values
       ('email', 'austin@cutover.example', 'admin'), ('email', 'lead@cutover.example', 'editor'), ('domain', 'cutover.example', 'viewer')`,
  );
  for (const [name, u] of Object.entries(users)) {
    before[name] = { edit: await canEdit(u.claims), pay: await seesPay(u.claims) };
  }
  Object.assign(
    beforeSignIn,
    Object.fromEntries(
      (await db.client.query("select value, role from deployment_access order by value")).rows.map((r) => [r.value as string, r.role as string]),
    ),
  );
  await applyMigrations(db.client);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the data mapping", () => {
  it("starts from the old words", () => {
    expect(before.editor).toEqual({ edit: true, pay: true });
    expect(before.member).toEqual({ edit: false, pay: false });
    expect(beforeSignIn).toEqual({ "austin@cutover.example": "admin", "lead@cutover.example": "editor", "cutover.example": "viewer" });
  });

  it("maps memberships: agency_admin, owner and editor to owner (Agency admin); member and viewer to viewer", async () => {
    const roles = (await db.client.query("select u.email, m.role, m.source, m.active from memberships m join auth.users u on u.id = m.user_id order by u.email")).rows;
    expect(roles).toEqual([
      { email: "agencyRole@cutover.example", role: "owner", source: "manual", active: true },
      { email: "editor@cutover.example", role: "owner", source: "manual", active: true },
      { email: "member@cutover.example", role: "viewer", source: "manual", active: true },
      // A deactivated membership stays deactivated until the person next signs in and the list says they may.
      { email: "removed@cutover.example", role: "viewer", source: "manual", active: false },
      { email: "owner@cutover.example", role: "owner", source: "manual", active: true },
      { email: "viewer@cutover.example", role: "viewer", source: "manual", active: true },
    ].sort((a, b) => a.email.localeCompare(b.email)));
  });

  it("maps the sign-in list: admin to owner, editor to agency_admin, viewer stays", async () => {
    const rules = Object.fromEntries((await db.client.query("select value, role from deployment_access order by value")).rows.map((r) => [r.value, r.role]));
    expect(rules).toEqual({ "austin@cutover.example": "owner", "lead@cutover.example": "agency_admin", "cutover.example": "viewer" });
  });

  it("audits the changes as the system", async () => {
    const kinds = (await db.client.query("select distinct actor_kind from audit_log where target_table in ('memberships', 'deployment_access') and action = 'update' and (diff -> 'new' ->> 'role') is distinct from (diff -> 'old' ->> 'role')")).rows;
    expect(kinds).toEqual([{ actor_kind: "system" }]);
  });
});

describe("what is gone", () => {
  it("drops the per-workspace lists with their rows, and the functions that read them", async () => {
    expect((await db.client.query("select to_regclass('public.workspace_domains') as d, to_regclass('public.workspace_access_emails') as e")).rows[0]).toEqual({ d: null, e: null });
    const left = (
      await db.client.query(
        `select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
           and p.proname in ('reconcile_access', 'reconcile_after_access_change', 'resolve_my_access', 'qualifies_for_domain', 'memberships_keep_owner', 'access_emails_keep_owner', 'list_owner_is_last')`,
      )
    ).rows;
    expect(left).toEqual([]);
  });

  it("keeps free-mail detection, which the sign-in list uses", async () => {
    expect((await db.client.query("select public.is_free_mail_domain('gmail.com') as g, public.is_free_mail_domain('cutover.example') as c")).rows[0]).toEqual({ g: true, c: false });
  });
});

describe("behaviour carries over", () => {
  it("an old editor edits and sees pay as an Agency admin; an old member does neither as a Viewer", async () => {
    for (const name of ["agencyRole", "owner", "editor", "flag"]) {
      expect({ name, edit: await canEdit(users[name]!.claims), pay: await seesPay(users[name]!.claims) }, name).toEqual({ name, edit: true, pay: true });
    }
    for (const name of ["member", "viewer"]) {
      expect({ name, edit: await canEdit(users[name]!.claims), pay: await seesPay(users[name]!.claims) }, name).toEqual({ name, edit: false, pay: false });
    }
  });

  it("no role's edit or pay answer moved, except where the model says so", async () => {
    // The old workspace owner and the old editor were different roles; both are Agency admins now. Nobody who could edit or see
    // pay lost it, and nobody who could not gained it.
    for (const [name, was] of Object.entries(before)) {
      if (name === "removed") continue;
      expect({ name, edit: await canEdit(users[name]!.claims), pay: await seesPay(users[name]!.claims) }, name).toEqual({ name, ...was });
    }
  });

  it("a viewer's team_capacity has no pay for anyone but themselves", async () => {
    const t = await team(users.member!.claims);
    expect(t.sees_everyone).toBe(false);
    expect(t.people.every((p) => p.cost_rate === null)).toBe(true);
  });
});
