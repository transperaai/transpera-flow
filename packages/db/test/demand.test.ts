import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOnce, WEEKS_PER_CALENDAR_MONTH } from "@transpera-flow/engine";
import {
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamLeadSourceIds,
  northbeamServiceIds,
  qualifiedLeadsPerWeek,
  seasonalityCurve,
  toEngineModel,
  type LeadSourceRow,
  type ProcessBundle,
  type SeasonalityRow,
  type ServiceRow,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Demand (issue #13): lead sources, seasonality and growth resolve into the
// engine's arrivals; the tables' row-level security, checks, provenance
// stamping and per-field saves.

const START = "2026-10-05";
const ws = NORTHBEAM_WORKSPACE_ID;
const { seo, ppc } = northbeamServiceIds;

const source = (id: string, volume: number, conversion: number): LeadSourceRow => ({
  id,
  workspace_id: ws,
  name: id,
  volume_week: volume,
  conversion_to_qualified: conversion,
  provenance: {},
});

const season = (month: number, multiplier: number): SeasonalityRow => ({
  id: `s${month}`,
  workspace_id: ws,
  month,
  multiplier,
  provenance: {},
});

const withService = (b: ProcessBundle, id: string, changes: Partial<ServiceRow>): ProcessBundle => ({
  ...b,
  services: b.services.map((sv) => (sv.id === id ? { ...sv, ...changes } : sv)),
});

describe("arrival rate from lead sources", () => {
  it("Northbeam's seeded sources reproduce its 7 qualified leads a week, with no demand settings", () => {
    const b = northbeamBundle();
    expect(qualifiedLeadsPerWeek(b.leadSources!)).toBe(7);
    const model = toEngineModel(b, { startDate: START });
    expect(model.leadsPerWeek).toBe(7);
    expect(model).not.toHaveProperty("demand");
    // Exactly the model the interim leads_per_week gave before lead sources existed.
    const before = { ...b, leadSources: undefined, seasonality: undefined, demand: undefined };
    expect(model).toEqual(toEngineModel(before, { startDate: START }));
  });

  it("is the sum of volume × conversion, whatever the row order or numeric spelling", () => {
    const b = northbeamBundle();
    b.leadSources = [source("b", 5, 0.5), source("a", 10, 0.3), source("c", "4" as unknown as number, "0.25" as unknown as number)];
    // 10 × 0.3 + 5 × 0.5 + 4 × 0.25 = 3 + 2.5 + 1
    expect(toEngineModel(b, { startDate: START }).leadsPerWeek).toBeCloseTo(6.5, 12);
    const reversed = { ...b, leadSources: [...b.leadSources].reverse() };
    expect(toEngineModel(reversed, { startDate: START }).leadsPerWeek).toBe(toEngineModel(b, { startDate: START }).leadsPerWeek);
  });

  it("falls back to the interim leads per week when there are no lead sources", () => {
    const b = northbeamBundle();
    b.leadSources = [];
    b.workspace.settings = { ...b.workspace.settings, leads_per_week: 11 };
    expect(toEngineModel(b, { startDate: START }).leadsPerWeek).toBe(11);
  });

  it("is split between processes by the services mix", () => {
    // SEO (0.55) enters this process and PPC (0.45) another: 7 × 0.55 here, 7 × 0.45 there.
    const other = "c0000000-0000-4000-8000-0000000000ff";
    const b = withService(northbeamBundle(), ppc, { entry_process_id: other });
    const here = toEngineModel(b, { startDate: START });
    expect(Object.keys(here.services!)).toEqual([seo]);
    expect(here.leadsPerWeek).toBeCloseTo(7 * 0.55, 12);
    const there = toEngineModel({ ...b, process: { ...b.process, id: other } }, { startDate: START });
    expect(Object.keys(there.services!)).toEqual([ppc]);
    expect(there.leadsPerWeek).toBeCloseTo(7 * 0.45, 12);
    expect(here.leadsPerWeek + there.leadsPerWeek).toBeCloseTo(7, 12);
  });

  it("leaves inactive services out of the split", () => {
    const other = "c0000000-0000-4000-8000-0000000000ff";
    const b = withService(withService(northbeamBundle(), ppc, { entry_process_id: other }), ppc, { active: false });
    expect(toEngineModel(b, { startDate: START }).leadsPerWeek).toBe(7);
  });

  it("simulates each service's share of the arrivals", () => {
    const res = runOnce({ ...toEngineModel(northbeamBundle(), { startDate: START }), horizonWeeks: 2000, warmupWeeks: 0 }, 1, false);
    // 7 a week for 2,000 weeks, split 55 : 45 (σ ≈ 118 of 14,000).
    const total = res.services[seo]!.arrivals + res.services[ppc]!.arrivals;
    expect(Math.abs(total - 14_000)).toBeLessThan(4 * Math.sqrt(14_000));
    expect(res.services[seo]!.arrivals / total).toBeCloseTo(0.55, 1);
  });
});

describe("seasonality and growth", () => {
  it("builds the twelve-month curve, a missing month being 1", () => {
    expect(seasonalityCurve([season(1, 1.4), season(12, 0.5)])).toEqual([1.4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5]);
    expect(seasonalityCurve([])).toEqual(new Array(12).fill(1));
  });

  it("passes the curve, the growth and the start date's place in the calendar to the engine", () => {
    const b = northbeamBundle();
    b.seasonality = [season(12, "0.6" as unknown as number), season(1, 1.3)];
    b.demand = { workspace_id: ws, growth_monthly: "0.02" as unknown as number, provenance: {} };
    // 5 October: month 9 (0 = January) plus 4 of its 31 days.
    expect(toEngineModel(b, { startDate: START }).demand).toEqual({
      seasonality: [1.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.6],
      growthMonthly: 0.02,
      startMonth: 9 + 4 / 31,
    });
    b.seasonality = [];
    expect(toEngineModel(b, { startDate: "2027-02-15" }).demand).toEqual({ growthMonthly: 0.02, startMonth: 1 + 14 / 28 });
  });

  it("leaves demand out when the curve is flat and there is no growth", () => {
    const b = northbeamBundle();
    b.seasonality = Array.from({ length: 12 }, (_, i) => season(i + 1, 1));
    b.demand = { workspace_id: ws, growth_monthly: 0, provenance: {} };
    expect(toEngineModel(b, { startDate: START })).toEqual(toEngineModel(northbeamBundle(), { startDate: START }));
  });

  it("changes arrivals by simulated month: none arrive in a December with a multiplier of 0", () => {
    const b = northbeamBundle();
    b.seasonality = [season(12, 0), season(1, 2)];
    const model = { ...toEngineModel(b, { startDate: "2026-12-01" }), warmupWeeks: 0 };
    const month = WEEKS_PER_CALENDAR_MONTH * model.hoursPerWeek;
    const counts = [0, 0, 0];
    for (let seed = 1; seed <= 20; seed++) {
      // Leads only: servicing tasks (issue #19) come from the client roster, not demand.
      for (const e of runOnce(model, seed, true).entities!) if (!e.servicing) counts[Math.floor(e.t0 / month)]!++;
    }
    // December none; January twice February (7 × 52/12 × 20 ≈ 607 a normal month).
    expect(counts[0]).toBe(0);
    expect(Math.abs(counts[1]! - 2 * 607)).toBeLessThan(4 * Math.sqrt(2 * 607));
    expect(Math.abs(counts[2]! - 607)).toBeLessThan(4 * Math.sqrt(607));
  });
});

// ---- The tables, as the signed-in user ----

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
let otherWs: string;
const website = northbeamLeadSourceIds.website;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@demand.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@demand.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-demand') returning id")).rows[0].id;
  await db.client.query("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Theirs', 99)", [otherWs]);
  await db.client.query("insert into seasonality (workspace_id, month, multiplier) values ($1, 3, 2)", [otherWs]);
  await db.client.query("insert into demand_settings (workspace_id, growth_monthly) values ($1, 0.5)", [otherWs]);
});

afterAll(async () => {
  await db?.close();
});

const saveFields = async (c: pg.Client, table: string, key: object, base: object, changes: object) =>
  (
    await c.query("select public.save_fields($1, $2::jsonb, $3::jsonb, $4::jsonb) as r", [
      table,
      JSON.stringify(key),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r as { status: string; row?: Record<string, unknown>; conflicts?: Record<string, unknown> };

const TABLES = ["lead_sources", "seasonality", "demand_settings"] as const;
const insertInto = (c: pg.Client, table: (typeof TABLES)[number], workspace: string) =>
  table === "lead_sources"
    ? c.query("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Events', 2)", [workspace])
    : table === "seasonality"
      ? c.query("insert into seasonality (workspace_id, month, multiplier) values ($1, 7, 0.8)", [workspace])
      : c.query("insert into demand_settings (workspace_id, growth_monthly) values ($1, 0.01) on conflict (workspace_id) do update set growth_monthly = 0.01", [workspace]);

describe("demand tables: row-level security", () => {
  it("seeds Northbeam's lead sources and growth, visible to every member", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      const rows = await db.as(users[role]!.claims, async (c) => ({
        sources: (await c.query("select name, volume_week::float8 as v, conversion_to_qualified::float8 as q from lead_sources order by id")).rows,
        seasons: (await c.query("select count(*)::int as n from seasonality")).rows[0].n,
        growth: (await c.query("select growth_monthly::float8 as g from demand_settings")).rows,
      }));
      expect(rows).toEqual({
        sources: [
          { name: "Website enquiries", v: 8, q: 0.25 },
          { name: "Google Ads", v: 4, q: 0.5 },
          { name: "Client referrals", v: 3, q: 1 },
        ],
        seasons: 0,
        growth: [{ g: 0 }],
      });
    }
  });

  it("hides every row from a stranger, and another workspace's rows from members", async () => {
    for (const table of TABLES) {
      expect(await db.as(users.stranger!.claims, async (c) => (await c.query(`select 1 from ${table}`)).rowCount), table).toBe(0);
      const seen = await db.as(users.owner!.claims, async (c) => (await c.query(`select workspace_id from ${table}`)).rows);
      expect(seen.every((r) => r.workspace_id === ws), table).toBe(true);
    }
  });

  it("lets owners and editors add, change and remove rows", async () => {
    for (const role of ["owner", "editor"]) {
      for (const table of TABLES) {
        await db.as(users[role]!.claims, async (c) => {
          expect((await insertInto(c, table, ws)).rowCount, `${role} ${table}`).toBe(1);
          expect((await c.query(`delete from ${table} where workspace_id = $1`, [ws])).rowCount).toBeGreaterThan(0);
        });
      }
    }
  });

  it("stops members and viewers writing, and editors writing into another workspace", async () => {
    for (const role of ["member", "viewer"]) {
      for (const table of TABLES) {
        await expect(db.as(users[role]!.claims, (c) => insertInto(c, table, ws))).rejects.toThrow(/row-level security/);
        await db.as(users[role]!.claims, async (c) => {
          expect((await c.query(`delete from ${table} where workspace_id = $1`, [ws])).rowCount).toBe(0);
        });
      }
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update lead_sources set volume_week = 1 where id = $1", [website])).rowCount).toBe(0);
      });
    }
    for (const table of TABLES) {
      await expect(db.as(users.editor!.claims, (c) => insertInto(c, table, otherWs))).rejects.toThrow(/row-level security/);
    }
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("update lead_sources set workspace_id = $1 where id = $2", [otherWs, website])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("gives the anon role no access", async () => {
    for (const table of TABLES) {
      await db.client.query("begin");
      try {
        await db.client.query("set local role anon");
        await expect(db.client.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.client.query("rollback");
      }
    }
  });
});

describe("demand tables: constraints", () => {
  const bad: [string, string][] = [
    ["update lead_sources set volume_week = -1", "check"],
    ["update lead_sources set conversion_to_qualified = 1.5", "check"],
    ["update lead_sources set conversion_to_qualified = -0.1", "check"],
    ["update lead_sources set name = ' '", "check"],
    ["update lead_sources set provenance = '[]'", "check"],
    ["insert into seasonality (workspace_id, month) values ($1, 13)", "check"],
    ["insert into seasonality (workspace_id, month) values ($1, 0)", "check"],
    ["insert into seasonality (workspace_id, month, multiplier) values ($1, 2, -0.5)", "check"],
    ["update demand_settings set growth_monthly = -1", "check"],
  ];
  it.each(bad)("rejects %s", async (sql) => {
    const params = sql.includes("$1") ? [ws] : [];
    await expect(db.as(users.editor!.claims, (c) => c.query(sql, params))).rejects.toThrow(/check constraint/);
  });

  it("allows one row per month, and the edges of each range", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("insert into seasonality (workspace_id, month, multiplier) values ($1, 1, 0), ($1, 12, 100)", [ws]);
      await expect(c.query("insert into seasonality (workspace_id, month) values ($1, 1)", [ws])).rejects.toThrow(/duplicate key/);
    });
    await db.as(users.editor!.claims, async (c) => {
      const r = await c.query("update lead_sources set volume_week = 0, conversion_to_qualified = 0 where id = $1", [website]);
      expect(r.rowCount).toBe(1);
      expect((await c.query("update demand_settings set growth_monthly = -0.99 where workspace_id = $1", [ws])).rowCount).toBe(1);
    });
  });
});

describe("demand tables: provenance", () => {
  it("marks values a person inserts as entered, by them, unless provenance is given", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const { provenance } = (
        await c.query("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Events', 2) returning provenance", [ws])
      ).rows[0];
      expect(provenance).toEqual({
        volume_week: { source: "entered", at: expect.any(String), by: users.editor!.id },
        conversion_to_qualified: { source: "entered", at: expect.any(String), by: users.editor!.id },
      });
      const given = { multiplier: { source: "measured", dataset_id: "d1" } };
      const row = (
        await c.query("insert into seasonality (workspace_id, month, multiplier, provenance) values ($1, 5, 1.2, $2) returning provenance", [
          ws,
          given,
        ])
      ).rows[0];
      expect(row.provenance).toEqual(given);
    });
  });

  it("stamps a changed value as entered and leaves the others' provenance alone", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, "lead_sources", { id: website }, { volume_week: 8 }, { volume_week: 10 });
      expect(r.status).toBe("saved");
      const prov = r.row!.provenance as Record<string, Record<string, unknown>>;
      expect(prov.volume_week).toEqual({ source: "entered", at: expect.any(String), by: users.editor!.id });
      expect(prov.conversion_to_qualified).toMatchObject({ source: "estimated", note: "Northbeam sample data" });
    });
  });

  it("keeps provenance unchanged when only the name changes or the value is saved unchanged", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const before = (await c.query("select provenance from lead_sources where id = $1", [website])).rows[0].provenance;
      await c.query("update lead_sources set name = 'Website', volume_week = 8.0 where id = $1", [website]);
      expect((await c.query("select provenance from lead_sources where id = $1", [website])).rows[0].provenance).toEqual(before);
    });
  });

  it("keeps provenance a writer sets along with the value (calibration's measured values)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const measured = { source: "measured", at: "2026-10-01T00:00:00Z", dataset_id: "d1" };
      const { provenance } = (
        await c.query(
          "update lead_sources set volume_week = 12, provenance = provenance || jsonb_build_object('volume_week', $2::jsonb) where id = $1 returning provenance",
          [website, measured],
        )
      ).rows[0];
      expect(provenance.volume_week).toEqual(measured);
    });
  });
});

describe("demand tables: save_fields", () => {
  it("saves a seasonality month and the growth, keyed as the app keys them", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = (await c.query("insert into seasonality (workspace_id, month) values ($1, 11) returning id", [ws])).rows[0].id;
      const r = await saveFields(c, "seasonality", { id }, { multiplier: 1 }, { multiplier: 1.25 });
      expect(r).toMatchObject({ status: "saved", row: { multiplier: 1.25, provenance: { multiplier: { source: "entered" } } } });
      const g = await saveFields(c, "demand_settings", { workspace_id: ws }, { growth_monthly: "0.00" }, { growth_monthly: 0.015 });
      expect(g).toMatchObject({ status: "saved", row: { growth_monthly: 0.015, provenance: { growth_monthly: { source: "entered" } } } });
    });
  });

  it("reports a same-field conflict with the stored value", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, "lead_sources", { id: website }, { conversion_to_qualified: 0.3 }, { conversion_to_qualified: 0.4 });
      expect(r.status).toBe("conflict");
      expect(r.conflicts).toEqual({ conversion_to_qualified: 0.25 });
    });
  });

  it("finds nothing for a viewer, and refuses fixed columns", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      expect((await saveFields(c, "demand_settings", { workspace_id: ws }, { growth_monthly: 0 }, { growth_monthly: 1 })).status).toBe(
        "not_found",
      );
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(saveFields(c, "lead_sources", { id: website }, { workspace_id: ws }, { workspace_id: otherWs })).rejects.toThrow(
        /cannot be saved/,
      );
    });
  });
});
