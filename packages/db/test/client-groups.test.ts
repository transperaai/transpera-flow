import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamServiceIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Client groups (issue #120): the seeded Northbeam groups, row-level security,
// checks, per-field saves, the company-model triggers and the migration's backfill.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const seo = northbeamServiceIds.seo;
const ppc = northbeamServiceIds.ppc;
let otherWs: string;
let otherService: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@groups.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@groups.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-groups') returning id")).rows[0].id;
  otherService = (await db.client.query("insert into services (workspace_id, name, price) values ($1, 'Theirs', 100) returning id", [otherWs])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const saveFields = async (c: pg.Client, key: object, base: object, changes: object) =>
  (
    await c.query("select public.save_fields('client_groups', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
      JSON.stringify(key),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r as { status: string; row?: Record<string, unknown>; conflicts?: Record<string, unknown> };

describe("the seeded groups", () => {
  it("has Northbeam's clients counted per service, visible to every member", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      const rows = await db.as(users[role]!.claims, async (c) =>
        (
          await c.query(
            "select service_id, client_count, fee::float8 as fee, churn_monthly::float8 as churn, stay_months::float8 as stay, starting_health::float8 as health from client_groups order by service_id",
          )
        ).rows,
      );
      expect(rows).toEqual([
        { service_id: seo, client_count: 17, fee: 3456, churn: 0.03, stay: 18, health: 83 },
        { service_id: ppc, client_count: 12, fee: 4229, churn: 0.04, stay: 12, health: 52 },
      ]);
    }
  });

  it("keeps the named clients: nothing is deleted", async () => {
    expect((await db.client.query("select count(*)::int as n from clients where workspace_id = $1", [ws])).rows[0].n).toBe(26);
  });

  it("hides another workspace's groups from non-members", async () => {
    expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select id from client_groups")).rowCount)).toBe(0);
  });
});

describe("row-level security and checks", () => {
  it("lets owners and editors add, change and remove a group, and stops members and viewers", async () => {
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update client_groups set client_count = 1 where service_id = $1", [seo])).rowCount).toBe(0);
        expect((await c.query("delete from client_groups where service_id = $1", [seo])).rowCount).toBe(0);
      });
    }
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("update client_groups set client_count = 20 where service_id = $1", [seo])).rowCount).toBe(1);
      expect((await c.query("delete from client_groups where service_id = $1", [ppc])).rowCount).toBe(1);
      const back = await c.query("insert into client_groups (workspace_id, service_id, client_count) values ($1, $2, 5) returning fee, stay_months::float8 as stay, starting_health::float8 as health", [ws, ppc]);
      expect(back.rows[0]).toEqual({ fee: "0", stay: 12, health: 80 });
    });
  });

  it("refuses a group for a service in another workspace, and a second group for one service", async () => {
    await expect(
      db.as(users.owner!.claims, async (c) => c.query("insert into client_groups (workspace_id, service_id) values ($1, $2)", [ws, otherService])),
    ).rejects.toThrow(/foreign key|violates/);
    await expect(
      db.as(users.owner!.claims, async (c) => c.query("insert into client_groups (workspace_id, service_id) values ($1, $2)", [ws, seo])),
    ).rejects.toThrow(/unique/);
  });

  it("checks the numbers", async () => {
    for (const set of ["client_count = -1", "client_count = 2001", "fee = -1", "churn_monthly = 1.5", "stay_months = -2", "starting_health = 101", "starting_health = -1"]) {
      await expect(db.as(users.owner!.claims, async (c) => c.query(`update client_groups set ${set} where service_id = $1`, [seo]))).rejects.toThrow(/check/);
    }
  });

  it("stamps a value a person changes as entered, and keeps the seed's estimates for the rest", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const before = (await c.query("select provenance from client_groups where service_id = $1", [seo])).rows[0].provenance;
      expect(before.fee.source).toBe("estimated");
      await c.query("update client_groups set fee = 3000 where service_id = $1", [seo]);
      const after = (await c.query("select provenance from client_groups where service_id = $1", [seo])).rows[0].provenance;
      expect(after.fee).toMatchObject({ source: "entered", by: users.editor!.id });
      expect(after.client_count.source).toBe("estimated");
    });
  });

  it("goes when its service goes", async () => {
    const id = (await db.client.query("insert into services (workspace_id, name, price) values ($1, 'Temp', 1) returning id", [ws])).rows[0].id;
    await db.client.query("insert into client_groups (workspace_id, service_id) values ($1, $2)", [ws, id]);
    await db.client.query("delete from services where id = $1", [id]);
    expect((await db.client.query("select 1 from client_groups where service_id = $1", [id])).rowCount).toBe(0);
  });
});

describe("per-field saves", () => {
  it("saves a field when the base still matches, and reports a conflict when it doesn't", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const saved = await saveFields(c, { service_id: seo }, { client_count: 17 }, { client_count: 18 });
      expect(saved.status).toBe("saved");
      expect(saved.row).toMatchObject({ client_count: 18 });
      const stale = await saveFields(c, { service_id: seo }, { client_count: 17 }, { client_count: 19 });
      expect(stale.status).toBe("conflict");
      expect(stale.conflicts).toEqual({ client_count: 18 });
    });
  });

  it("is not found for a member, who can't update it", async () => {
    await db.as(users.member!.claims, async (c) => {
      expect((await saveFields(c, { service_id: seo }, { client_count: 17 }, { client_count: 18 })).status).toBe("not_found");
    });
  });

  it("saves the company's client-health benchmark as keys of the workspace settings", async () => {
    await db.as(users.owner!.claims, async (c) => {
      const r = (
        await c.query("select public.save_fields('workspaces', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
          JSON.stringify({ id: ws }),
          JSON.stringify({ "settings.client_health_benchmark_low": null }),
          JSON.stringify({ "settings.client_health_benchmark_low": 70 }),
        ])
      ).rows[0].r;
      expect(r.status).toBe("saved");
    });
  });
});

describe("the migration's backfill from named clients", () => {
  const migration = readFileSync(new URL("../migrations/20261111000000_client_groups.sql", import.meta.url), "utf8");
  const backfill = /(insert into public\.client_groups[\s\S]*?on conflict \(service_id\) do nothing;)/.exec(migration)![1]!;

  it("rolls the active named clients up per service, and never changes a group that exists", async () => {
    const w = (
      await db.client.query(`insert into workspaces (name, slug, settings) values ('Backfill', 'backfill-groups', '{"health_initial": 65}') returning id`)
    ).rows[0].id;
    const svc = async (name: string, churn: number, tenure: number) =>
      (await db.client.query("insert into services (workspace_id, name, price, churn_monthly_base, tenure_months) values ($1, $2, 1, $3, $4) returning id", [w, name, churn, tenure])).rows[0].id as string;
    const a = await svc("A", 0.02, 20);
    const b = await svc("B", 0.05, 10);
    const none = await svc("None", 0.01, 5);
    const unentered = await svc("Unentered", 0.01, 5);
    const client = async (name: string, mrr: number, health: number | null, active: boolean, services: string[], start: string | null = null) => {
      const id = (
        await db.client.query("insert into clients (workspace_id, name, mrr, health, active, start_date) values ($1, $2, $3, $4, $5, $6) returning id", [w, name, mrr, health, active, start])
      ).rows[0].id;
      for (const s of services) await db.client.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [id, s, w]);
    };
    await client("one", 3000, 90, true, [a]);
    await client("two", 5000, 70, true, [a, b]); // 2,500 to each service
    await client("three", 1000, null, true, [b]); // health not entered
    await client("gone", 9999, 10, false, [a]); // left: not counted
    await client("later", 9999, 10, true, [a], "2999-01-01"); // starts in the future: not counted
    await client("blank", 400, null, true, [unentered]); // no health anywhere: the workspace's health_initial (65)
    await db.client.query(backfill);
    const rows = (
      await db.client.query(
        "select service_id, client_count, fee::float8 as fee, churn_monthly::float8 as churn, stay_months::float8 as stay, starting_health::float8 as health from client_groups where workspace_id = $1",
        [w],
      )
    ).rows;
    const byService = Object.fromEntries(rows.map((r) => [r.service_id, r]));
    expect(byService[a]).toMatchObject({ client_count: 2, fee: 2750, churn: 0.02, stay: 20, health: 80 });
    expect(byService[b]).toMatchObject({ client_count: 2, fee: 1750, churn: 0.05, stay: 10, health: 70 });
    expect(byService[unentered]).toMatchObject({ client_count: 1, fee: 400, health: 65 });
    expect(byService[none]).toBeUndefined();
    // Estimates rolled up from named clients, not entered by a person.
    const prov = (await db.client.query("select provenance from client_groups where service_id = $1", [a])).rows[0].provenance;
    expect(Object.keys(prov).sort()).toEqual(["churn_monthly", "client_count", "fee", "starting_health", "stay_months"]);
    expect(prov.fee).toMatchObject({ source: "estimated" });
    // No health entered and no health_initial setting: 80 (greatest(0, null) would have given 0).
    const plain = (await db.client.query(`insert into workspaces (name, slug) values ('Plain', 'backfill-plain') returning id`)).rows[0].id;
    const ps = (await db.client.query("insert into services (workspace_id, name, price, churn_monthly_base, tenure_months) values ($1, 'P', 1, 0, 12) returning id", [plain])).rows[0].id;
    const pc = (await db.client.query("insert into clients (workspace_id, name, mrr, health, active) values ($1, 'p', 500, null, true) returning id", [plain])).rows[0].id;
    await db.client.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [pc, ps, plain]);
    await db.client.query(backfill);
    expect((await db.client.query("select starting_health::float8 as h from client_groups where service_id = $1", [ps])).rows[0].h).toBe(80);
    // Run again after an edit: nothing is overwritten.
    await db.client.query("update client_groups set client_count = 99 where service_id = $1", [a]);
    await db.client.query(backfill);
    expect((await db.client.query("select client_count from client_groups where service_id = $1", [a])).rows[0].client_count).toBe(99);
  });
});

describe("the production data alignment block", () => {
  const migration = readFileSync(new URL("../migrations/20261111000000_client_groups.sql", import.meta.url), "utf8");
  const block = migration
    .slice(migration.indexOf("-- Production data alignment"))
    .split("\n")
    .filter((l) => l.startsWith("-- begin;") || /^-- (update|set|from|\s|\(|\)|join|where|and|is|commit)/.test(l) || l.startsWith("--   "))
    .map((l) => l.replace(/^-- ?/, ""))
    .join("\n");
  const groups = async () =>
    (
      await db.client.query(
        "select s.name, g.client_count, g.fee::float8 as fee, g.churn_monthly::float8 as churn, g.stay_months::float8 as stay, g.starting_health::float8 as health from client_groups g join services s on s.id = g.service_id where s.workspace_id = $1 order by s.name",
        [ws],
      )
    ).rows;
  const tidy = [
    { name: "PPC management", client_count: 12, fee: 4229, churn: 0.04, stay: 12, health: 52 },
    { name: "SEO retainer", client_count: 17, fee: 3456, churn: 0.03, stay: 18, health: 83 },
  ];

  it("sets production Northbeam's groups to the seed's values, and changes nothing the second time", async () => {
    expect(block).toContain("update public.client_groups g");
    await db.client.query("update client_groups set fee = 1, starting_health = 71 where workspace_id = $1", [ws]);
    await db.client.query(block);
    expect(await groups()).toEqual(tidy);
    const stamp = (await db.client.query("select max(updated_at) as t from client_groups where workspace_id = $1", [ws])).rows[0].t;
    await db.client.query(block);
    expect((await db.client.query("select max(updated_at) as t from client_groups where workspace_id = $1", [ws])).rows[0].t).toEqual(stamp);
    expect(await groups()).toEqual(tidy);
  });

  it("leaves other workspaces' groups alone", async () => {
    const svc = (await db.client.query("insert into services (workspace_id, name, price) values ($1, 'SEO retainer', 1) returning id", [otherWs])).rows[0].id;
    await db.client.query("insert into client_groups (workspace_id, service_id, client_count, fee) values ($1, $2, 3, 10)", [otherWs, svc]);
    await db.client.query(block);
    expect((await db.client.query("select client_count, fee::float8 as fee from client_groups where service_id = $1", [svc])).rows[0]).toEqual({ client_count: 3, fee: 10 });
  });
});
