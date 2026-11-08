import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamServiceIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The services table (issue #12): row-level security, check constraints and
// per-field saves, all run as the signed-in user.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const seo = northbeamServiceIds.seo;
let otherWs: string;
let otherService: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@services.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@services.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-services') returning id")).rows[0].id;
  otherService = (
    await db.client.query("insert into services (workspace_id, name, price) values ($1, 'Their retainer', 999) returning id", [otherWs])
  ).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

const saveFields = async (c: pg.Client, key: object, base: object, changes: object) =>
  (
    await c.query("select public.save_fields('services', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
      JSON.stringify(key),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r as { status: string; row?: Record<string, unknown>; conflicts?: Record<string, unknown> };

const insert = (c: pg.Client, workspace: string, name = "Content retainer") =>
  c.query("insert into services (workspace_id, name, price, mix_share) values ($1, $2, 2000, 0.2) returning id", [workspace, name]);

describe("services: row-level security", () => {
  it("seeds Northbeam's SEO and PPC services, visible to every member", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      const rows = await db.as(users[role]!.claims, async (c) =>
        (await c.query("select name, pricing_model, price::float8 as price, path_tags from services order by id")).rows,
      );
      expect(rows).toEqual([
        { name: "SEO retainer", pricing_model: "retainer", price: 3500, path_tags: ["seo"] },
        { name: "PPC management", pricing_model: "retainer", price: 4200, path_tags: ["ppc"] },
      ]);
    }
  });

  it("hides services from a user with no membership, and another workspace's services from members", async () => {
    expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select id from services")).rowCount)).toBe(0);
    const seen = await db.as(users.owner!.claims, async (c) => (await c.query("select id from services")).rows.map((r) => r.id));
    expect(seen).not.toContain(otherService);
    expect(seen).toHaveLength(2);
  });

  it("lets owners and editors add, change and remove services", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await insert(c, ws)).rows[0].id;
        expect((await c.query("update services set price = 2500 where id = $1", [id])).rowCount).toBe(1);
        expect((await c.query("delete from services where id = $1", [id])).rowCount).toBe(1);
      });
    }
  });

  it("stops members and viewers writing", async () => {
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update services set price = 1 where id = $1", [seo])).rowCount).toBe(0);
        expect((await c.query("delete from services where id = $1", [seo])).rowCount).toBe(0);
      });
      await expect(db.as(users[role]!.claims, (c) => insert(c, ws))).rejects.toThrow(/row-level security/);
    }
  });

  it("stops an editor writing into another workspace", async () => {
    await expect(db.as(users.editor!.claims, (c) => insert(c, otherWs))).rejects.toThrow(/row-level security/);
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("update services set price = 1 where id = $1", [otherService])).rowCount).toBe(0);
      // Moving a service into another workspace fails the policy's check.
      await expect(c.query("update services set workspace_id = $1 where id = $2", [otherWs, seo])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("gives the anon role no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from services")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("services: constraints", () => {
  const bad: [string, string][] = [
    ["pricing_model", "'subscription'"],
    ["price", "-1"],
    ["margin", "1.2"],
    ["margin", "-0.1"],
    ["tenure_months", "-1"],
    ["churn_monthly_base", "1.5"],
    ["churn_monthly_base", "-0.01"],
    ["mix_share", "-0.5"],
    ["name", "'  '"],
    // The fee range (sandbox phase 3): not below 0.
    ["price_low", "-1"],
    ["price_high", "-1"],
  ];
  it.each(bad)("rejects %s = %s", async (col, value) => {
    await expect(
      db.as(users.editor!.claims, (c) => c.query(`update services set ${col} = ${value} where id = $1`, [seo])),
    ).rejects.toThrow(/check constraint/);
  });

  it("allows the edges of each range", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await c.query(
        "update services set price = 0, margin = 1, tenure_months = 0, churn_monthly_base = 1, mix_share = 0, pricing_model = 'one_off' where id = $1",
        [seo],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it("bumps updated_at, and clears only the entry process when that process is deleted", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("update services set updated_at = '2000-01-01' where id = $1", [seo]);
      await db.client.query("update services set name = 'SEO' where id = $1", [seo]);
      const { updated_at } = (await db.client.query("select updated_at from services where id = $1", [seo])).rows[0];
      expect(new Date(updated_at).getFullYear()).toBeGreaterThan(2000);
      await db.client.query("delete from processes where id = $1", [NORTHBEAM_PROCESS_ID]);
      const row = (await db.client.query("select workspace_id, entry_process_id from services where id = $1", [seo])).rows[0];
      expect(row).toEqual({ workspace_id: ws, entry_process_id: null });
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("services: save_fields", () => {
  it("saves a field for an editor, including the path tags array", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, { id: seo }, { price: 3500, path_tags: ["seo"] }, { price: 3750, path_tags: ["seo", "content"] });
      expect(r.status).toBe("saved");
      expect(r.row).toMatchObject({ price: 3750, path_tags: ["seo", "content"] });
    });
  });

  it("compares numbers by value, so a base of '0.55' matches 0.55", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await saveFields(c, { id: seo }, { mix_share: "0.550" }, { mix_share: 0.6 })).status).toBe("saved");
    });
  });

  it("reports a same-field conflict with the stored value", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, { id: seo }, { path_tags: ["old"] }, { path_tags: ["new"] });
      expect(r.status).toBe("conflict");
      expect(r.conflicts).toEqual({ path_tags: ["seo"] });
    });
  });

  it("finds nothing for a viewer or for another workspace's service", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      expect((await saveFields(c, { id: seo }, { price: 3500 }, { price: 1 })).status).toBe("not_found");
    });
    await db.as(users.editor!.claims, async (c) => {
      expect((await saveFields(c, { id: otherService }, { price: 999 }, { price: 1 })).status).toBe("not_found");
    });
  });

  it("refuses fixed columns and values the checks reject", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await expect(saveFields(c, { id: seo }, { workspace_id: ws }, { workspace_id: otherWs })).rejects.toThrow(/cannot be saved/);
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(saveFields(c, { id: seo }, { margin: 0.45 }, { margin: 2 })).rejects.toThrow(/check constraint/);
    });
  });
});

describe("services: the fee range (sandbox phase 3)", () => {
  it("is null by default, on every seeded service", async () => {
    const { rows } = await db.client.query("select price_low, price_high from services where workspace_id = $1", [ws]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ price_low: null, price_high: null });
  });

  it("saves one end at a time through save_fields, with the price on either side of it, and clears with null", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const low = await saveFields(c, { id: seo }, { price_low: null }, { price_low: 3000 });
      expect(low.status).toBe("saved");
      // The other end is still unset, and the price is 3,500: no cross-column check, the engine uses the price as an end.
      const high = await saveFields(c, { id: seo }, { price_high: null }, { price_high: 3200 });
      expect(high.status).toBe("saved");
      const row = (await c.query("select price, price_low, price_high, provenance from services where id = $1", [seo])).rows[0];
      expect([Number(row.price), Number(row.price_low), Number(row.price_high)]).toEqual([3500, 3000, 3200]);
      expect(row.provenance.price_low).toMatchObject({ source: "entered", by: users.editor!.id });
      const cleared = await saveFields(c, { id: seo }, { price_low: 3000, price_high: 3200 }, { price_low: null, price_high: null });
      expect(cleared.status).toBe("saved");
    });
  });

  it("a viewer can't set a range, and a negative end is refused", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      const r = await saveFields(c, { id: seo }, { price_low: null }, { price_low: 1 });
      expect(r.status).toBe("not_found");
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(saveFields(c, { id: seo }, { price_high: null }, { price_high: -5 })).rejects.toThrow(/check constraint/);
    });
  });
});
