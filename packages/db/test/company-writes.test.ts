import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamClientIds,
  northbeamLeadSourceIds,
  northbeamPersonIds,
  northbeamRoleIds,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The company model changes in the app, by a person (docs/PRD.md D19, amended 28 Oct 2026: Suggestions are gone and MCP is
// read-only): an API token can't write it, every company-model write is audit-logged with its actor kind, and saved runs have
// row-level security. (This was suggestions.test.ts; the tests of suggestions themselves went with them.)

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const ads = northbeamLeadSourceIds.ads; // Google Ads: 4 a week
const sam = northbeamPersonIds["Sam Patel"]!;
const chloe = northbeamPersonIds["Chloe Evans"]!;
const client = northbeamClientIds.c01!; // Harbour Lane Dental: SEO, Sam Patel

/** An editor's API token, as the MCP server's requests carry it (docs/adr/0002-*). */
const mcp = () => ({ ...users.editor!.claims, api_token_id: randomUUID() });

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    // The old role names map as migration 20270103000000 maps them: editor -> owner (Agency admin), member -> viewer.
    users[role] = await createUser(db, `${role}@company-writes.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@company-writes.example.com");
});

afterAll(async () => {
  await db?.close();
});

const one = async (c: pg.Client, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

/** Read audit_log inside a test's transaction (only managers may read it under RLS), then carry on as the user. */
async function auditRows(c: pg.Client, where = "true", params: unknown[] = []) {
  await c.query("reset role");
  try {
    return (
      await c.query(
        `select actor_id, actor_kind, action, target_table, target_id, diff from audit_log
         where target_table not in ('memberships', 'workspace_domains', 'workspace_access_emails') and (${where})
         order by created_at, id`,
        params,
      )
    ).rows;
  } finally {
    await c.query("set local role authenticated");
  }
}

describe("an API token can't write the company model", () => {
  const writes: [string, string, unknown[]][] = [
    ["people", "update people set fte = 0.5 where id = $1", [sam]],
    ["person_roles", "delete from person_roles where person_id = $1", [sam]],
    ["person_leave", "insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, '2026-12-01', '2026-12-05')", [sam, ws]],
    ["services", "insert into services (workspace_id, name) values ($1, 'Content')", [ws]],
    // Not a delete: nobody signed in deletes a client at all (B19).
    ["clients", "update clients set mrr = 999 where id = $1", [client]],
    ["client_assignments", "update client_assignments set person_id = $2 where client_id = $1 and role_id = $3", [client, chloe, northbeamRoleIds.seo]],
    ["lead_sources", "update lead_sources set volume_week = 15 where id = $1", [ads]],
    ["seasonality", "insert into seasonality (workspace_id, month, multiplier) values ($1, 12, 0.5)", [ws]],
    ["demand_settings", "update demand_settings set growth_monthly = 0.05 where workspace_id = $1", [ws]],
    ["roles", "insert into roles (workspace_id, name) values ($1, 'Copywriter')", [ws]],
  ];
  for (const [table, sql, params] of writes) {
    it(`refuses a write to ${table} made with an API token`, async () => {
      await expect(db.as(mcp(), (c) => c.query(sql, params))).rejects.toThrow(/can't be changed through an API token/);
      // The same write as the signed-in editor goes through.
      await db.as(users.editor!.claims, (c) => c.query(sql, params));
    });
  }

  it("refuses an owner's token changing the workspace settings or the roles", async () => {
    const owner = { ...users.owner!.claims, api_token_id: randomUUID() };
    await expect(db.as(owner, (c) => c.query("update workspaces set settings = settings || '{\"hours_per_week\": 35}' where id = $1", [ws]))).rejects.toThrow(
      /can't be changed through an API token/,
    );
    await expect(db.as(owner, (c) => c.query("insert into roles (workspace_id, name) values ($1, 'Copywriter')", [ws]))).rejects.toThrow(/can't be changed through an API token/);
  });

});

describe("human edits apply live and are audit-logged", () => {
  it("the seed wrote no audit entries for the company model", async () => {
    const n = await one(
      db.client,
      "select count(*)::int as n from audit_log where workspace_id = $1 and target_table not in ('memberships', 'workspace_domains', 'workspace_access_emails')",
      [ws],
    );
    expect(n.n).toBe(0);
  });

  it("a person's FTE saved in settings is entered by them and logged with the old and new value", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await one(c, "select public.save_fields('people', $1, $2, $3) as r", [
        JSON.stringify({ id: sam }),
        JSON.stringify({ fte: 1 }),
        JSON.stringify({ fte: 0.6 }),
      ]);
      expect(r.r.status).toBe("saved");
      const p = await one(c, "select fte::float8, provenance from people where id = $1", [sam]);
      expect(p.fte).toBe(0.6);
      expect(p.provenance.fte).toMatchObject({ source: "entered", by: users.editor!.id });
      const [audit] = await auditRows(c, "target_table = 'people'");
      expect(audit).toMatchObject({ actor_id: users.editor!.id, actor_kind: "user", action: "update", target_id: sam });
      expect(audit.diff.old.fte).toBe(1);
      expect(audit.diff.new.fte).toBe(0.6);
      expect(audit.diff.suggestion_id).toBeUndefined();
    });
  });

  it("a workspace setting saved by its owner is entered, per key, and logged", async () => {
    await db.as(users.owner!.claims, async (c) => {
      await c.query("select public.save_fields('workspaces', $1, $2, $3)", [
        JSON.stringify({ id: ws }),
        JSON.stringify({ "settings.overtime_cap": 0.1 }),
        JSON.stringify({ "settings.overtime_cap": 0.2 }),
      ]);
      const w = await one(c, "select provenance from workspaces where id = $1", [ws]);
      expect(w.provenance["settings.overtime_cap"]).toMatchObject({ source: "entered", by: users.owner!.id });
      expect(w.provenance["settings.hours_per_week"]).toBeUndefined();
      const [audit] = await auditRows(c, "target_table = 'workspaces'");
      expect(audit).toMatchObject({ actor_kind: "user", action: "update", target_id: ws });
      expect(audit.diff.new.settings.overtime_cap).toBe(0.2);
    });
  });

  it("logs inserts and deletes of rows and set members (a new lead source, a role taken away)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Podcast', 2)", [ws]);
      await c.query("delete from person_roles where person_id = $1 and role_id = $2", [sam, northbeamRoleIds.seo]);
      const rows = (await auditRows(c)).sort((a, b) => a.target_table.localeCompare(b.target_table));
      expect(rows.map((r) => [r.target_table, r.action, r.actor_kind])).toEqual([
        ["lead_sources", "insert", "user"],
        ["person_roles", "delete", "user"],
      ]);
      expect(rows[1]).toMatchObject({ target_id: sam, diff: { role_id: northbeamRoleIds.seo } });
      expect(rows[0].diff.new).toMatchObject({ name: "Podcast", provenance: { volume_week: { source: "entered" } } });
    });
  });
});

describe("saved runs", () => {
  const insertRun = (c: pg.Client) =>
    c.query(
      "insert into runs (workspace_id, process_id, name, revision_ids, reps, seed, params_snapshot, results) values ($1, $2, 'Baseline', $3, 30, 1, $4, '{}') returning id",
      [ws, NORTHBEAM_PROCESS_ID, [], JSON.stringify({ version: 1 })],
    );

  it("editors save runs; owners and editors read them (B1 2/3: results hold per-person utilisation); members, viewers and strangers can't save", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await insertRun(c)).rowCount).toBe(1);
    });
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => insertRun(c)), role).rejects.toThrow(/row-level security/);
    }
    await db.client.query("insert into runs (workspace_id, name, reps, seed, params_snapshot) values ($1, 'Committed', 30, 1, '{}')", [ws]);
    expect(await db.as(users.editor!.claims, async (c) => (await one(c, "select count(*)::int as n from runs")).n)).toBe(1);
    expect(await db.as(users.viewer!.claims, async (c) => (await one(c, "select count(*)::int as n from runs")).n)).toBe(0);
    expect(await db.as(users.stranger!.claims, async (c) => (await one(c, "select count(*)::int as n from runs")).n)).toBe(0);
    await db.client.query("delete from runs");
  });
});
