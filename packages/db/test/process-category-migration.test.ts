import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { IMPORT_COLUMNS, PROCESS_CATEGORIES, defaultProcessCategory } from "../src";
import { createTestDb, type TestDb } from "./harness";

// Process categories (capacity Q3, migration 20270126000000_process_categories.sql): existing processes are given a category from their
// kind and their service links, a new process without one gets the same default, and a restore and a process file carry it.

const BASE = "20270125000100";
const WS = "00000000-0000-4000-8000-0000000000b3";
let db: TestDb;
const ids = { pipeline: randomUUID(), routine: randomUUID(), adhocDriver: randomUUID(), adhocPoisson: randomUUID(), mixed: randomUUID() };

const category = async (id: string) => (await db.client.query("select category from public.processes where id = $1", [id])).rows[0]?.category as string;

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  const q = (sql: string, p: unknown[] = []) => db.client.query(sql, p);
  await q("insert into public.workspaces (id, name, slug) values ($1, 'Categories', 'categories-q3')", [WS]);
  const proc = (id: string, name: string, kind: string) => q("insert into public.processes (id, workspace_id, name, kind, entity_name) values ($1, $2, $3, $4, 'item')", [id, WS, name, kind]);
  await proc(ids.pipeline, "Lead to live", "pipeline");
  await proc(ids.routine, "Monthly report", "servicing");
  await proc(ids.adhocDriver, "Quick requests", "servicing");
  await proc(ids.adhocPoisson, "Random requests", "servicing");
  await proc(ids.mixed, "Check-in", "servicing");
  const svc = async (name: string) => (await q("insert into public.services (workspace_id, name, pricing_model, price) values ($1, $2, 'retainer', 1000) returning id", [WS, name])).rows[0].id as string;
  const link = async (service: string, process: string, recurrence: unknown) =>
    q("insert into public.service_servicing (workspace_id, service_id, process_id, recurrence, sla_hours) values ($1, $2, $3, $4, 24)", [WS, service, process, JSON.stringify(recurrence)]);
  const s1 = await svc("S1");
  const s2 = await svc("S2");
  await link(s1, ids.routine, { every: "month", times: 1 });
  await link(s1, ids.adhocDriver, { perMonth: 1, driver: "adhoc" });
  await link(s1, ids.adhocPoisson, { poisson_per_month: 2 });
  await link(s1, ids.mixed, { every: "week", times: 1 });
  await link(s2, ids.mixed, { poisson_per_month: 1 });
  const applied = await applyMigrations(db.client, {});
  expect(applied.files).toContain("20270126000000_process_categories.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the backfill", () => {
  it("makes a pipeline sales and a servicing process routine client work", async () => {
    expect(await category(ids.pipeline)).toBe("sales");
    expect(await category(ids.routine)).toBe("routine_client_work");
  });

  it("makes a servicing process whose links use the ad-hoc driver or a Poisson recurrence ad hoc", async () => {
    expect(await category(ids.adhocDriver)).toBe("ad_hoc");
    expect(await category(ids.adhocPoisson)).toBe("ad_hoc");
    expect(await category(ids.mixed)).toBe("ad_hoc");
  });

  it("makes the company map internal, and the TS default agrees with the rest", async () => {
    const r = await db.client.query("select category from public.processes where workspace_id = $1 and is_company", [WS]);
    expect(r.rows.map((x) => x.category)).toEqual(["internal"]);
    expect(defaultProcessCategory("pipeline")).toBe("sales");
    expect(defaultProcessCategory("servicing")).toBe("routine_client_work");
    expect(defaultProcessCategory("servicing", [{ recurrence: { poisson_per_month: 1 } }])).toBe("ad_hoc");
    expect(defaultProcessCategory("servicing", [{ recurrence: { perMonth: 1, driver: "adhoc" } }])).toBe("ad_hoc");
    expect(defaultProcessCategory("servicing", [{ recurrence: { every: "month", times: 2 } }])).toBe("routine_client_work");
  });
});

describe("a new process", () => {
  const make = async (kind: string, category?: string) => {
    const id = randomUUID();
    if (category) await db.client.query("insert into public.processes (id, workspace_id, name, kind, entity_name, category) values ($1, $2, $3, $4, 'item', $5)", [id, WS, `P ${id}`, kind, category]);
    else await db.client.query("insert into public.processes (id, workspace_id, name, kind, entity_name) values ($1, $2, $3, $4, 'item')", [id, WS, `P ${id}`, kind]);
    return id;
  };

  it("gets its category from its kind when none is given, and keeps one that is", async () => {
    expect(await category(await make("pipeline"))).toBe("sales");
    expect(await category(await make("servicing"))).toBe("routine_client_work");
    expect(await category(await make("servicing", "onboarding"))).toBe("onboarding");
    expect(await category(await make("pipeline", "internal"))).toBe("internal");
  });

  it("refuses a category that isn't one of the five", async () => {
    await expect(make("pipeline", "nonsense")).rejects.toThrow(/processes_category_check/);
    for (const c of PROCESS_CATEGORIES) await expect(make("pipeline", c)).resolves.toBeTruthy();
  });

  it("can be changed with save_fields", async () => {
    const id = await make("servicing");
    const r = await db.client.query("select public.save_fields('processes', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
      JSON.stringify({ id }),
      JSON.stringify({ category: "routine_client_work" }),
      JSON.stringify({ category: "onboarding" }),
    ]);
    expect(r.rows[0].r.status).toBe("saved");
    expect(await category(id)).toBe("onboarding");
  });
});

describe("restore and import", () => {
  it("is a column a restore accepts", () => {
    expect(IMPORT_COLUMNS.processes).toContain("category");
  });

  it("import_workspace_bundle and import_new_process take a node's category, and give one by kind when it has none", async () => {
    const ws = randomUUID();
    await db.client.query("insert into public.workspaces (id, name, slug) values ($1, 'Import', $2)", [ws, `import-${ws.slice(0, 8)}`]);
    const start = () => ({ id: randomUUID(), name: "Start", kind: "start", outcome: null, work_hours: 0, wait_hours: 0, rework_rate: 0, x: 0, y: 0, provenance: {}, assumption: false, conflict: false });
    const node = (name: string, kind: string, category?: string) => ({ id: randomUUID(), parent_id: null, name, kind, entity_name: "item", description: null, ...(category ? { category } : {}), steps: [start()], edges: [] });
    const a = node("Onboard", "servicing", "onboarding");
    const b = node("Plain", "servicing");
    await db.client.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([a])]);
    await db.client.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([b])]);
    expect(await category(a.id)).toBe("onboarding");
    expect(await category(b.id)).toBe("routine_client_work");
  });
});
