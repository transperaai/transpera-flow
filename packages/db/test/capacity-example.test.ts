import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capacityModel, checkCapacityInputs, simulate, type EngineModel } from "@transpera-flow/engine";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, loadProcessBySlug, toEngineModel } from "../src";
import { EXAMPLE_BOTH, fixedRecurrence, loadCapacityExample } from "../src/fixtures/capacity-example";
import { createTestDb, createUser, type TestDb } from "./harness";

// P2b section 3: the example workspace (made-up data, never the client's) loads into an empty workspace, maps to a model with no
// capacity problems, simulates, and its people are about as busy as the engine fixture `capacityModel()` says.

let db: TestDb;
let owner: { id: string };
const SLUG = "capacity-example";
const TODAY = new Date().toISOString().slice(0, 10);
let ws: string;
let model: EngineModel;

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  owner = await createUser(db, "owner@capacity-example.example.com", { agency_admin: true });
  ws = (await q("insert into workspaces (name, slug) values ($1, $1) returning id", [SLUG]))[0]!.id as string;
  await db.client.query("begin");
  const result = await loadCapacityExample(db.client, ws, TODAY);
  await db.client.query("commit");
  expect(result, JSON.stringify(result)).toMatchObject({ applied: true });
  const dbAs = db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const pipeline = (await q("select id from processes where workspace_id = $1 and kind = 'pipeline' and is_company is not true", [ws]))[0]!.id as string;
  const bundle = (await loadProcessBySlug(dbAs, SLUG, { draft: false, processId: pipeline }))!.live;
  // The forecast: people who leave during the run leave (the fixture has the resigning manager leave a month in).
  model = toEngineModel(bundle, { startDate: TODAY, planned: true });
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe("loading the example", () => {
  it("fills an empty workspace: 27 people, 13 named clients, 3 tiers, 6 tier services, the servicing processes and a pipeline", async () => {
    const count = async (table: string) => Number((await q(`select count(*)::int as n from ${table} where workspace_id = $1`, [ws]))[0]!.n);
    expect(await count("people")).toBe(27);
    expect(await count("clients")).toBe(13);
    expect(await count("tiers")).toBe(3);
    expect(await count("services")).toBe(6);
    expect(await count("roles")).toBe(10);
    expect(Number((await q("select count(*)::int as n from processes where workspace_id = $1 and is_company is not true", [ws]))[0]!.n)).toBe(1 + Object.keys(capacityModel().servicingProcesses!).length);
    expect((await q("select key, both_count from tiers where workspace_id = $1 order by key", [ws])).map((r) => [r.key, r.both_count])).toEqual(Object.entries(EXAMPLE_BOTH));
    // Contractors and offshore staff are labelled; nobody has a cost rate (that is not Set up).
    expect((await q("select name, label from people where workspace_id = $1 and label is not null order by name", [ws])).map((r) => [r.name, r.label])).toEqual([
      ["Freelancers (4, pooled)", "contractor"], ["Jasfer", "offshore"], ["Tonie", "offshore"],
    ]);
  });

  it("refuses a workspace that has anything in it, and changes nothing", async () => {
    const before = Number((await q("select count(*)::int as n from people where workspace_id = $1", [ws]))[0]!.n);
    await db.client.query("begin");
    const again = await loadCapacityExample(db.client, ws, TODAY);
    await db.client.query("rollback");
    expect(again).toMatchObject({ applied: false, reason: expect.stringContaining("already has") });
    for (const other of [NORTHBEAM_WORKSPACE_ID, LARKSPUR_WORKSPACE_ID]) {
      await db.client.query("begin");
      expect((await loadCapacityExample(db.client, other, TODAY)).applied).toBe(false);
      await db.client.query("rollback");
    }
    expect(Number((await q("select count(*)::int as n from people where workspace_id = $1", [ws]))[0]!.n)).toBe(before);
    await db.client.query("begin");
    expect(await loadCapacityExample(db.client, "00000000-0000-4000-8000-0000000000ff", TODAY)).toEqual({ applied: false, reason: "No such workspace." });
    await db.client.query("rollback");
  });
});

describe("the example as an engine model", () => {
  const fixture = capacityModel();
  /** The model's person id by name, for either model. */
  const byName = (m: EngineModel) => Object.fromEntries(Object.entries(m.people!).map(([id, p]) => [p.name, id]));

  it("has no capacity problems", () => {
    expect(checkCapacityInputs(model)).toEqual([]);
  });

  it("is a tier workspace: six tier services, counted clients beside the 13 named, least-busy placement", () => {
    expect(Object.values(model.services!).map((s) => s.tier).sort()).toEqual(["T1", "T1", "T2", "T2", "T3", "T3"]);
    expect(model.clientMix).toBe("groups-add");
    expect(model.placeNewClients).toBe("least-busy");
    expect(Object.keys(model.clients!)).toHaveLength(13);
    // Counted clients by tier and department are the fixture's.
    const serviceKey = Object.fromEntries(Object.entries(model.services!).map(([id, s]) => [id, `${s.department === fixture.services!["org-T1"]!.department ? "" : ""}${s.name}`]));
    const counts = (m: EngineModel) => Object.fromEntries(Object.entries(m.clientGroups!).map(([id, g]) => [m.services![id]!.name, g.count]));
    expect(counts(model)).toEqual(counts(fixture));
    expect(serviceKey).toBeDefined();
  });

  it("has the people's team time, tiers and portfolios, and the resigning manager leaves", () => {
    const ids = byName(model);
    const fx = byName(fixture);
    for (const name of Object.keys(fx)) {
      const a = model.people![ids[name]!]!;
      const b = fixture.people![fx[name]!]!;
      expect(a.reservedShare, name).toBe(b.reservedShare);
      expect(a.tiers, name).toEqual(b.tiers);
      expect(a.capacity, name).toBe(b.capacity);
      expect(Object.values(a.portfolio ?? {}).sort(), name).toEqual(Object.values(b.portfolio ?? {}).sort());
      expect(a.capacityFactor?.default ?? 1, name).toBeCloseTo(b.capacityFactor?.default ?? 1, 5);
    }
  });

  it("has the named clients' managers, overrides and hand-holding hours", () => {
    const ids = byName(model);
    const fx = byName(fixture);
    const personName = (m: EngineModel, id: string | undefined) => (id ? m.people![id]?.name : undefined);
    for (const [, c] of Object.entries(fixture.clients!)) {
      const mine = Object.values(model.clients!).find((x) => x.name === c.name)!;
      expect(personName(model, mine.manager), c.name).toBe(personName(fixture, c.manager));
      expect(mine.overrides, c.name).toEqual(c.overrides);
      expect(Object.values(mine.handHoldingHours ?? {}), c.name).toEqual(Object.values(c.handHoldingHours ?? {}));
      expect(mine.mrr).toBe(c.mrr);
    }
    expect(ids).toBeDefined();
    expect(fx).toBeDefined();
  });

  it("has each tier's deliverables and ad-hoc rule, and a fixed rate on every servicing link (until driver recurrences can be stored)", () => {
    for (const sv of Object.values(model.services!)) {
      const f = Object.values(fixture.services!).find((x) => x.name === sv.name)!;
      expect(sv.deliverables, sv.name).toEqual(f.deliverables);
      expect(sv.adhoc, sv.name).toEqual(f.adhoc);
      expect(sv.department).not.toBeUndefined();
      expect(sv.servicing!.length, sv.name).toBeGreaterThan(0);
      for (const l of sv.servicing!) expect("driver" in l.recurrence, sv.name).toBe(false);
    }
  });

  it("the fixed rate is the tasks a month the driver gives", () => {
    expect(fixedRecurrence({ perMonth: 1, driver: "words", per: 1000 }, { words: 4000 }, undefined)).toEqual({ every: "month", times: 4 });
    expect(fixedRecurrence({ perMonth: 1, driver: "adhoc" }, {}, { chance: 0.9, requests: 6.5 })).toEqual({ poisson_per_month: 5.85 });
    expect(fixedRecurrence({ every: "month", times: 1 / 3 }, {}, undefined)).toEqual({ every: "month", times: 0.333333 });
    expect(fixedRecurrence({ perMonth: 1, driver: "channels" }, {}, undefined)).toBeNull();
  });

  it("simulates", () => {
    const r = simulate(model, 4, 1);
    expect(r.kpi).toBeDefined();
    expect(Object.keys(r.people)).toHaveLength(27);
  }, 120_000);
});

describe("won clients are split by the prototype's department x tier mix", () => {
  const mix = (tier: string) => 0.5 * ({ T1: 0.1, T2: 0.4, T3: 0.5 } as Record<string, number>)[tier]!;

  it("the services' shares are half each department, 10 / 40 / 50 by tier", () => {
    const total = Object.values(model.services!).reduce((a, s) => a + s.mixShare, 0);
    expect(total).toBeCloseTo(1, 12);
    for (const s of Object.values(model.services!)) expect(s.mixShare, s.name).toBeCloseTo(mix(s.tier!), 12);
  });

  it("two simulated years of wins land on them in about that proportion", () => {
    const r = simulate({ ...model, horizonWeeks: 104 }, 8, 3);
    const arrivals = Object.entries(r.kpi.services).map(([id, s]) => [id, s.arrivals.mean] as const);
    const total = arrivals.reduce((a, [, n]) => a + n, 0);
    expect(total).toBeGreaterThan(100);
    for (const [id, n] of arrivals) {
      const share = n / total;
      const want = mix(model.services![id]!.tier!);
      expect(share, model.services![id]!.name).toBeGreaterThan(want - 0.08);
      expect(share, model.services![id]!.name).toBeLessThan(want + 0.08);
    }
  }, 120_000);
});

/**
 * The step fields P4 maps (the work split, tier multipliers, routing to the client's manager) and the list of changes, copied from the fixture by process and step name, for a model that doesn't have them yet. A no-op once P4's mapping puts them on the model's own steps.
 */
function withP4StepFields(m: EngineModel, from: EngineModel): { model: EngineModel; patched: boolean } {
  if (m.steps.some((s) => s.toClientManager)) return { model: m, patched: false };
  const fx = new Map(from.steps.map((s) => [s.id, s]));
  const byId = new Map<string, EngineModel["steps"][number]>();
  const mine = new Map<string, string>();
  for (const [, p] of Object.entries(m.servicingProcesses ?? {})) {
    const fixtureProcess = Object.values(from.servicingProcesses ?? {}).find((x) => x.name === p.name);
    if (!fixtureProcess) continue;
    // (The model lists a process's steps in id order, so they are matched by name: unique within a process.)
    for (const id of p.steps) {
      const name = m.steps.find((x) => x.id === id)!.name;
      const f = fixtureProcess.steps.map((sid) => fx.get(sid)!).find((x) => x.name === name)!;
      byId.set(id, f);
      // The fixture's step id (what a change points at) -> this model's.
      mine.set(f.id, id);
    }
  }
  return {
    patched: true,
    model: {
      ...m,
      // The list of changes isn't stored in the database yet either (the fixture has the prototype's 13).
      ...(m.changes === undefined && from.changes
        ? { changes: from.changes.map((c) => ({ ...c, effects: c.effects.map((e) => ({ ...e, step: mine.get(e.step) ?? e.step })) })) }
        : {}),
      steps: m.steps.map((s) => {
        const f = byId.get(s.id);
        return f ? { ...s, ...(f.split ? { split: f.split } : {}), ...(f.tierMultiplier ? { tierMultiplier: f.tierMultiplier } : {}), ...(f.toClientManager ? { toClientManager: true } : {}) } : s;
      }),
    },
  };
}

describe("busy shares against the engine fixture capacityModel()", () => {
  const fixture = capacityModel();
  const reps = 8;
  const share = (m: EngineModel, who: EngineModel) => {
    const people = simulate(m, reps, 1).people;
    return new Map(Object.entries(people).map(([id, p]) => [who.people![id]!.name, p.util]));
  };
  const table = (label: string, ours: Map<string, number>, theirs: Map<string, number>) => {
    const rows = [...theirs].map(([name, t]) => `${name.padEnd(26)} example ${(ours.get(name)! * 100).toFixed(0).padStart(4)}%  fixture ${(t * 100).toFixed(0).padStart(4)}%  diff ${((ours.get(name)! - t) * 100 >= 0 ? "+" : "")}${((ours.get(name)! - t) * 100).toFixed(0)}`);
    console.log(`BUSY SHARE (util), ${label}, ${reps} replications:\n${rows.join("\n")}`);
    return Math.max(...[...theirs].map(([name, t]) => Math.abs(ours.get(name)! - t) * 100));
  };

  it("each person's busy share is within 15 percentage points of the fixture's; the differences are reported", () => {
    const theirs = share(fixture, fixture);
    const { model: m, patched } = withP4StepFields(model, fixture);
    // The model as the database gives it today, then with P4's step fields: the first shows what P4 still has to map.
    if (patched) table("as the database gives it (no P4 step fields)", share(model, model), theirs);
    const worst = table(patched ? "with P4's step fields and the changes copied from the fixture" : "as the database gives it", share(m, m), theirs);
    expect(worst).toBeLessThanOrEqual(15);
  }, 300_000);
});
