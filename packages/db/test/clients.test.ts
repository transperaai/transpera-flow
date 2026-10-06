import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rosterLoads } from "@transpera-flow/engine";
import {
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamClientIds,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamServiceIds,
  toEngineModel,
  type ProcessBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The client roster (issue #18): the seeded Northbeam roster, row-level
// security, checks, provenance stamping, per-field saves of clients and
// assignments, the services set, and how the roster resolves for the engine.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const START = "2026-10-05";
const first = northbeamClientIds.c01!; // Harbour Lane Dental: SEO, Sam Patel, Leah Brooks
const sam = northbeamPersonIds["Sam Patel"]!;
const chloe = northbeamPersonIds["Chloe Evans"]!;
let otherWs: string;
let otherPerson: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@clients.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@clients.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-clients') returning id")).rows[0].id;
  otherPerson = (await db.client.query("insert into people (workspace_id, name) values ($1, 'Someone else') returning id", [otherWs])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

type SaveResult = { status: string; row?: Record<string, unknown>; conflicts?: Record<string, unknown>; members?: string[] };

const saveFields = async (c: pg.Client, target: string, key: object, base: object, changes: object): Promise<SaveResult> =>
  (
    await c.query("select public.save_fields($1, $2::jsonb, $3::jsonb, $4::jsonb) as r", [
      target,
      JSON.stringify(key),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r;

const saveServices = async (c: pg.Client, client: string, base: string[], next: string[]): Promise<SaveResult> =>
  (
    await c.query("select public.save_links('client_services', $1::jsonb, 'service_id', $2::jsonb, $3::jsonb) as r", [
      JSON.stringify({ client_id: client, workspace_id: ws }),
      JSON.stringify(base),
      JSON.stringify(next),
    ])
  ).rows[0].r;

describe("the seeded roster", () => {
  it("has Northbeam's 26 active clients, with services and a person per role", async () => {
    const q = async (sql: string) => (await db.client.query(sql, [ws])).rows[0].n;
    expect(await q("select count(*)::int as n from clients where workspace_id = $1 and active")).toBe(26);
    expect(await q("select count(*)::int as n from client_services where workspace_id = $1")).toBe(29);
    // Everyone has a strategist, an account manager and finance; plus their specialists.
    expect(await q("select count(*)::int as n from client_assignments where workspace_id = $1")).toBe(26 * 3 + 29);
    const mrr = (await db.client.query("select sum(mrr)::float8 as total from clients where workspace_id = $1", [ws])).rows[0].total;
    expect(mrr).toBe(northbeamBundle().clients!.reduce((sum, c) => sum + c.mrr, 0));
  });

  it("derives per-person client counts from the assignments", async () => {
    const counts = Object.fromEntries(
      (
        await db.client.query(
          "select p.name, count(distinct a.client_id)::int as n from people p join client_assignments a on a.person_id = p.id where p.workspace_id = $1 group by p.name",
          [ws],
        )
      ).rows.map((r) => [r.name, r.n]),
    );
    expect(counts).toMatchObject({ "Maya Collins": 26, "Rosa Diaz": 26, "Nina Kowalski": 8, "Sam Patel": 7, "Leah Brooks": 14 });
    expect(counts["Leah Brooks"] + counts["Dan Okafor"]).toBe(26);
  });

  it("stores the fallback ongoing load on each service and a 10% overtime cap on the workspace", async () => {
    const svc = (await db.client.query("select fallback_ongoing_load from services where id = $1", [northbeamServiceIds.ppc])).rows[0];
    expect(svc.fallback_ongoing_load).toEqual({
      [northbeamRoleIds.strat]: 1.5,
      [northbeamRoleIds.am]: 6,
      [northbeamRoleIds.ppc]: 19,
      [northbeamRoleIds.fin]: 1.2,
    });
    const settings = (await db.client.query("select settings from workspaces where id = $1", [ws])).rows[0].settings;
    expect(settings.overtime_cap).toBe(0.1);
  });
});

describe("row-level security", () => {
  it("every member reads the roster, but who looks after which client only owners and editors (B1 2/3); strangers see none of it", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        const seesAssignments = role === "owner" || role === "editor";
        for (const t of ["clients", "client_services", "client_assignments"]) {
          const n = (await c.query(`select count(*)::int as n from ${t} where workspace_id = $1`, [ws])).rows[0].n;
          if (t === "client_assignments" && !seesAssignments) expect(n, `${role} ${t}`).toBe(0);
          else expect(n, `${role} ${t}`).toBeGreaterThan(0);
        }
      });
    }
    await db.as(users.stranger!.claims, async (c) => {
      for (const t of ["clients", "client_services", "client_assignments"]) {
        expect((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n).toBe(0);
      }
    });
  });

  it("owners and editors add and change clients but never delete one (B19: hidden, never deleted); members and viewers can't", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await c.query("insert into clients (workspace_id, name, mrr) values ($1, 'New Co', 2500) returning id", [ws])).rows[0].id;
        await c.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [id, northbeamServiceIds.seo, ws]);
        await c.query("insert into client_assignments (client_id, role_id, person_id, workspace_id) values ($1, $2, $3, $4)", [
          id,
          northbeamRoleIds.seo,
          sam,
          ws,
        ]);
        expect((await c.query("update clients set notes = 'Hi' where id = $1", [id])).rowCount).toBe(1);
        await c.query("savepoint d");
        await expect(c.query("delete from clients where id = $1", [id])).rejects.toThrow(/never deleted: mark them inactive/);
        await c.query("rollback to savepoint d");
        expect((await c.query("select count(*)::int as n from client_assignments where client_id = $1", [id])).rows[0].n).toBe(1);
      });
    }
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("insert into clients (workspace_id, name) values ($1, 'Nope')", [ws])).rejects.toThrow(/row-level security/);
      });
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update clients set mrr = 1 where id = $1", [first])).rowCount).toBe(0);
        expect((await c.query("delete from client_assignments where client_id = $1", [first])).rowCount).toBe(0);
      });
    }
  });

  it("anon has no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from clients")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("can't assign a person or service from another workspace", async () => {
    await db.as(users.owner!.claims, async (c) => {
      await expect(
        c.query("insert into client_assignments (client_id, role_id, person_id, workspace_id) values ($1, $2, $3, $4)", [
          first,
          northbeamRoleIds.sales,
          otherPerson,
          ws,
        ]),
      ).rejects.toThrow(/foreign key/);
    });
    await db.as(users.owner!.claims, async (c) => {
      const theirs = (await c.query("select id from services where workspace_id <> $1", [ws])).rows;
      expect(theirs).toEqual([]); // not even visible; and the key would refuse it anyway:
      await expect(
        c.query("insert into client_services (client_id, service_id, workspace_id) values ($1, gen_random_uuid(), $2)", [first, ws]),
      ).rejects.toThrow(/foreign key/);
    });
  });

  it("rejects health outside 0–100, negative MRR and a blank name", async () => {
    for (const sql of [
      "update clients set health = 101 where id = $1",
      "update clients set mrr = -1 where id = $1",
      "update clients set name = '  ' where id = $1",
    ]) {
      await db.as(users.owner!.claims, async (c) => {
        await expect(c.query(sql, [first])).rejects.toThrow(/check constraint/);
      });
    }
  });
});

describe("issues about a client", () => {
  it("links an issue to a client in the workspace; deleting the client (outside the app) keeps the issue, unlinked", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const client = (await c.query("insert into clients (workspace_id, name) values ($1, 'Short-lived Ltd') returning id", [ws])).rows[0].id;
      const issue = (
        await c.query("insert into issues (workspace_id, client_id, type, title) values ($1, $2, 'churn_risk', 'May leave') returning id", [ws, client])
      ).rows[0].id;
      // Nobody signed in deletes a client (B19); the operator can, outside the app.
      await c.query("reset role");
      await c.query("delete from clients where id = $1", [client]);
      expect((await c.query("select client_id from issues where id = $1", [issue])).rows[0].client_id).toBeNull();
    });
  });

  it("refuses a client from another workspace", async () => {
    const theirs = (await db.client.query("insert into clients (workspace_id, name) values ($1, 'Their client') returning id", [otherWs])).rows[0].id;
    await db.as(users.editor!.claims, async (c) => {
      await expect(
        c.query("insert into issues (workspace_id, client_id, type, title) values ($1, $2, 'churn_risk', 'Nope')", [ws, theirs]),
      ).rejects.toThrow(/foreign key/);
    });
  });
});

describe("per-field saves", () => {
  it("saves a client's MRR and stamps it as entered by the person", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, "clients", { id: first }, { mrr: 3500 }, { mrr: 3750 });
      expect(r.status).toBe("saved");
      expect(r.row!.mrr).toBe(3750);
      const prov = (r.row!.provenance as Record<string, { source: string; by?: string }>).mrr!;
      expect(prov.source).toBe("entered");
      expect(prov.by).toBe(users.editor!.id);
      // Health wasn't touched: still the seeded estimate.
      expect((r.row!.provenance as Record<string, { source: string }>).health!.source).toBe("estimated");
    });
  });

  it("reports a conflict when someone else changed the field", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, "clients", { id: first }, { health: 50 }, { health: 60 });
      expect(r.status).toBe("conflict");
      expect(r.conflicts).toEqual({ health: 88 });
    });
  });

  it("reassigns a client for a role, keyed by client and role", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const key = { client_id: first, role_id: northbeamRoleIds.seo };
      const r = await saveFields(c, "client_assignments", key, { person_id: sam }, { person_id: chloe });
      expect(r.status).toBe("saved");
      expect(r.row!.person_id).toBe(chloe);
      // The key can't be changed through a save.
      await expect(saveFields(c, "client_assignments", key, { role_id: northbeamRoleIds.seo }, { role_id: northbeamRoleIds.am })).rejects.toThrow(
        /cannot be saved/,
      );
    });
    await db.as(users.viewer!.claims, async (c) => {
      const r = await saveFields(c, "client_assignments", { client_id: first, role_id: northbeamRoleIds.seo }, { person_id: sam }, { person_id: chloe });
      expect(r.status).toBe("not_found");
    });
  });

  it("saves a client's services as one set, with a conflict when it changed meanwhile", async () => {
    const { seo, ppc } = northbeamServiceIds;
    await db.as(users.editor!.claims, async (c) => {
      expect((await saveServices(c, first, [seo], [seo, ppc])).status).toBe("saved");
      expect((await c.query("select count(*)::int as n from client_services where client_id = $1", [first])).rows[0].n).toBe(2);
      const stale = await saveServices(c, first, [], [ppc]);
      expect(stale.status).toBe("conflict");
      expect(stale.members!.sort()).toEqual([seo, ppc].sort());
    });
    await db.as(users.member!.claims, async (c) => {
      expect((await saveServices(c, first, [seo], [])).status).toBe("not_found");
    });
  });
});

describe("the roster in the engine model", () => {
  // Northbeam is seeded with client groups, which replace the named roster (client-groups.test.ts); these tests are the roster's.
  const bundle = (change: (b: ProcessBundle) => void = () => {}) => {
    const b = { ...northbeamBundle(), clientGroups: [] };
    change(b);
    return toEngineModel(b, { startDate: START });
  };

  it("resolves every active client that has started, with services and assignments", () => {
    const m = bundle();
    expect(Object.keys(m.clients!)).toHaveLength(26);
    expect(m.activeClients).toBe(26);
    expect(m.overtimeCap).toBe(0.1);
    const c = m.clients![first]!;
    expect(c).toEqual({
      name: "Harbour Lane Dental",
      services: [northbeamServiceIds.seo],
      mrr: 3500,
      health: 88,
      assignments: {
        [northbeamRoleIds.strat]: northbeamPersonIds["Maya Collins"],
        [northbeamRoleIds.am]: northbeamPersonIds["Leah Brooks"],
        [northbeamRoleIds.seo]: sam,
        [northbeamRoleIds.fin]: northbeamPersonIds["Rosa Diaz"],
      },
    });
  });

  it("leaves out clients who left, clients starting after the start date, and unentered health", () => {
    const m = bundle((b) => {
      b.clients = b.clients!.map((c, i) =>
        i === 0 ? { ...c, active: false } : i === 1 ? { ...c, start_date: "2027-01-04" } : i === 2 ? { ...c, health: null } : c,
      );
    });
    expect(Object.keys(m.clients!)).toHaveLength(24);
    expect(m.clients![northbeamClientIds.c03!]).not.toHaveProperty("health");
  });

  it("a workspace without clients keeps the interim client count and pooled load", () => {
    const m = bundle((b) => {
      b.clients = [];
    });
    expect(m).not.toHaveProperty("clients");
    expect(m.activeClients).toBe(26);
  });

  it("derives each person's starting load from their clients' services", () => {
    // Without servicing processes (issue #19), which replace the fallback load.
    const m = bundle((b) => {
      b.servicingLinks = [];
    });
    const loads = rosterLoads(m, m.people!);
    // Nina: 8 PPC clients × 19 h a month.
    expect(loads[northbeamPersonIds["Nina Kowalski"]!]!.hours).toBeCloseTo((8 * 19) / 4.33, 10);
    expect(loads[northbeamPersonIds["Nina Kowalski"]!]!.clients).toBe(8);
    // Sales carry no client work.
    expect(loads[northbeamPersonIds["Priya Shah"]!]!.hours).toBe(0);
  });
});
