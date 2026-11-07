import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyEngineModel, larkspurBundle, loadLiveCompanyPart, loadLiveParts, loadProcessBySlug, northbeamBundle, toEngineModel, type Db } from "../src";
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { createTestDb, createUser, type TestDb } from "./harness";

// Q17 (ADR 0023), the equality proof through the database: for the seeded workspaces and the capacity example, the live run built through the stored
// company map (backfilled by the database for a workspace nobody has changed) deep-equals today's `toEngineModel` of the loaded bundle. The
// unit-level proof over every variant is `engine-model-snapshot.test.ts`.

let db: TestDb;
let dbAs: Db;
const TODAY = "2026-11-09";
const EXAMPLE = "capacity-example-q17";

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(db, "owner@company-run-equality.example.com", { agency_admin: true });
  const ws = (await q("insert into workspaces (name, slug) values ($1, $1) returning id", [EXAMPLE]))[0]!.id as string;
  await db.client.query("begin");
  const result = await loadCapacityExample(db.client, ws, TODAY);
  await db.client.query("commit");
  expect(result, JSON.stringify(result)).toMatchObject({ applied: true });
  dbAs = db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the live run through the stored company map is today's run", () => {
  for (const [label, slug] of [["Northbeam", northbeamBundle().workspace.slug], ["Larkspur", larkspurBundle().workspace.slug], ["the capacity example", EXAMPLE]] as const) {
    for (const options of [{ startDate: TODAY }, { startDate: TODAY, planned: true, purposes: true }]) {
      it(`${label} (${Object.keys(options).join(", ")}): the models are deep-equal`, async () => {
        const live = (await loadProcessBySlug(dbAs, slug, { draft: false }))!.live;
        const ws = live.workspace.id;
        const [parts, company] = await Promise.all([loadLiveParts(dbAs, ws), loadLiveCompanyPart(dbAs, ws)]);
        expect(company, "the workspace has a stored company map").not.toBeNull();
        const today = toEngineModel(live, options);
        const made = companyEngineModel(company!, live, parts, options);
        expect(made.model).toEqual(today);
        // Nothing is handed on, and the bundle keeps today's root and processes.
        expect(made.bundle.handoffs).toBeUndefined();
        // The same processes run. (A workspace whose first process is client work is loaded rooted at it, and `pipelineOf` finds the pipeline
        // beside it; the map's bundle is rooted at the pipeline itself.)
        const ids = (b: typeof live) => [b.process.id, ...(b.otherProcesses ?? []).map((p) => p.process.id)].sort();
        expect(ids(made.bundle)).toEqual(ids(live));
        expect(made.bundle.process.kind).toBe("pipeline");
      });
    }
  }

  it("the system-made map of a seeded workspace has nothing to say", async () => {
    for (const slug of [northbeamBundle().workspace.slug, larkspurBundle().workspace.slug]) {
      const live = (await loadProcessBySlug(dbAs, slug, { draft: false }))!.live;
      const [parts, company] = await Promise.all([loadLiveParts(dbAs, live.workspace.id), loadLiveCompanyPart(dbAs, live.workspace.id)]);
      expect(companyEngineModel(company!, live, parts, { startDate: TODAY }).notes).toEqual([]);
    }
  });
});
