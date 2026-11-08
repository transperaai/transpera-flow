import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Creating a workspace from the app (issue #88; docs/adr/0012-*): agency
// admins only (the Owner), never over an API token, and everyone the sign-in list names gets a membership.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor"] as const) {
    users[role] = await createUser(db, `${role}@workspaces.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.agency = await createUser(db, "agency@workspaces.example.com", { agency_admin: true });
  users.stranger = await createUser(db, "stranger@workspaces.example.com");
});

afterAll(async () => {
  await db?.close();
});

const create = (c: pg.Client, name: string, slug: string, settings: object = {}) =>
  c.query("select public.create_workspace($1, $2, $3::jsonb) as id", [name, slug, JSON.stringify(settings)]);

const token = (claims: Record<string, unknown>) => ({ ...claims, api_token_id: randomUUID() });

describe("create_workspace", () => {
  it("the Owner creates a workspace with default settings and the scenario library, open to everyone on the sign-in list", async () => {
    // Who the list names: an Agency admin and a Viewer get a membership in the new workspace; the Owner (a rule too) needs none;
    // an unconfirmed address and someone the list doesn't name get nothing.
    const admin = await createUser(db, "listed.admin@workspaces.example.com");
    const viewer = await createUser(db, "listed.viewer@listed-viewers.example");
    const ownerRule = await createUser(db, "listed.owner@workspaces.example.com");
    await createUser(db, "unconfirmed@listed-viewers.example", {}, { unconfirmed: true });
    await createUser(db, "unlisted@elsewhere.example.com");
    await db.client.query(
      `insert into deployment_access (kind, value, role) values
         ('email', 'listed.admin@workspaces.example.com', 'agency_admin'), ('email', 'listed.owner@workspaces.example.com', 'owner'),
         ('domain', 'listed-viewers.example', 'viewer')`,
    );
    await db.as(users.agency!.claims, async (c) => {
      const id = (await create(c, "  Acme Dental ", "acme-dental", { hours_per_week: 35, currency: "USD" })).rows[0].id as string;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const row = (await c.query("select name, slug, settings from workspaces where id = $1", [id])).rows[0];
      expect(row.name).toBe("Acme Dental");
      expect(row.slug).toBe("acme-dental");
      expect(row.settings).toEqual({
        hours_per_week: 35,
        horizon_weeks: 13,
        currency: "USD",
        leads_per_week: 0,
        active_clients: 0,
        churn_monthly: 0,
        retainer: 0,
      });
      const members = (await c.query("select user_id, role, source, active from memberships where workspace_id = $1 order by role, user_id", [id])).rows;
      const byRole = (role: string) => members.filter((m) => m.role === role).map((m) => m.user_id).sort();
      expect(byRole("owner")).toEqual([admin.id]);
      expect(byRole("viewer")).toEqual([viewer.id]);
      expect(members.map((m) => m.user_id)).not.toContain(ownerRule.id);
      expect(members.map((m) => m.user_id)).not.toContain(users.agency!.id);
      expect(members.every((m) => m.source === "manual" && m.active)).toBe(true);
      // The unconfirmed address (its email isn't verified) and the unlisted one got nothing.
      expect(members).toHaveLength(2);
      expect((await c.query("select count(*)::int as n from sandbox_scenarios where workspace_id = $1", [id])).rows[0].n).toBe(4);
    });
    await db.client.query("delete from deployment_access");
  });

  it("a new workspace is in AUD unless it says otherwise (issue #108)", async () => {
    await db.as(users.agency!.claims, async (c) => {
      const id = (await create(c, "Fresh", "fresh-aud")).rows[0].id as string;
      expect((await c.query("select settings ->> 'currency' as currency from workspaces where id = $1", [id])).rows[0].currency).toBe("AUD");
      const usd = (await create(c, "Dollars", "dollars-usd", { currency: "USD" })).rows[0].id as string;
      expect((await c.query("select settings ->> 'currency' as currency from workspaces where id = $1", [usd])).rows[0].currency).toBe("USD");
    });
  });

  it("existing workspaces keep their currency: the migration never writes workspace rows", async () => {
    // The seeded Northbeam workspace predates the AUD default and is still in pounds...
    expect((await db.client.query("select settings ->> 'currency' as currency from workspaces where id = $1", [ws])).rows[0].currency).toBe("GBP");
    // ...and nothing in the migration could have changed it: it only redefines create_workspace.
    const sql = readFileSync(new URL("../migrations/20261113000000_cost_per_month.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bupdate\s+(only\s+)?(public\.)?workspaces\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).toMatch(/create or replace function public\.create_workspace/);
  });

  it("an agency admin reads every workspace; a stranger reads none of them", async () => {
    await db.client.query("insert into workspaces (name, slug) values ('Visible', 'visible')");
    const seen = async (claims: Record<string, unknown>) =>
      db.as(claims, async (c) => (await c.query("select slug from workspaces where slug = 'visible'")).rowCount);
    expect(await seen(users.agency!.claims)).toBe(1);
    expect(await seen(users.stranger!.claims)).toBe(0);
    await db.client.query("delete from workspaces where slug = 'visible'");
  });

  it("Agency admins and strangers are refused (only the Owner creates), and a direct insert fails row-level security", async () => {
    for (const who of ["owner", "editor", "stranger"]) {
      await expect(db.as(users[who]!.claims, (c) => create(c, "Nope", "nope")), who).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.as(users[who]!.claims, (c) => c.query("insert into workspaces (name, slug) values ('Nope', 'nope')")),
        who,
      ).rejects.toThrow(/row-level security/);
    }
    await expect(db.as(null, (c) => create(c, "Nope", "nope"))).rejects.toMatchObject({ code: "42501" });
  });

  it("an agency admin's API token can neither call it nor insert a workspace directly", async () => {
    const claims = token(users.agency!.claims);
    await expect(db.as(claims, (c) => create(c, "Via token", "via-token"))).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/created in the app/),
    });
    await expect(db.as(claims, (c) => c.query("insert into workspaces (name, slug) values ('Via token', 'via-token')"))).rejects.toThrow(/can't be changed through an API token/);
    // The same insert as the signed-in admin goes through.
    await db.as(users.agency!.claims, (c) => c.query("insert into workspaces (name, slug) values ('Via token', 'via-token')"));
  });

  it("refuses a duplicate slug (23505) and a bad slug (23514)", async () => {
    await expect(db.as(users.agency!.claims, async (c) => {
      await create(c, "One", "twin");
      await c.query("savepoint s");
      try {
        await create(c, "Two", "twin");
      } catch (e) {
        await c.query("rollback to savepoint s");
        throw e;
      }
    })).rejects.toMatchObject({ code: "23505" });
    for (const slug of ["Has Caps", "-lead", "trail-", "double--dash", ""]) {
      await expect(db.as(users.agency!.claims, (c) => create(c, "Bad", slug)), slug).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("refuses values it doesn't allow (22023)", async () => {
    const bad: [string, string, object][] = [
      ["an unknown key", "Ok", { overhead_monthly: 5 }],
      ["zero hours", "Ok", { hours_per_week: 0 }],
      ["too many hours", "Ok", { hours_per_week: 169 }],
      ["hours as text", "Ok", { hours_per_week: "40" }],
      ["lower-case currency", "Ok", { currency: "gbp" }],
      ["a fractional horizon", "Ok", { horizon_weeks: 1.5 }],
      ["a horizon beyond two years", "Ok", { horizon_weeks: 105 }],
      ["a blank name", "   ", {}],
      ["an overlong name", "x".repeat(201), {}],
    ];
    for (const [what, name, settings] of bad) {
      await expect(db.as(users.agency!.claims, (c) => create(c, name, "ok-slug", settings)), what).rejects.toMatchObject({ code: "22023" });
    }
    await db.as(users.agency!.claims, (c) => create(c, "Edge", "edge", { hours_per_week: 168, horizon_weeks: 104, currency: "EUR" }));
  });
});
