import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyEngineModel, larkspurBundle, loadLiveCompanyPart, loadLiveParts, loadLiveProcessBySlug, loadProcessBySlug, northbeamBundle, toEngineModel, type Db, type ProcessBundle } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Q17 (ADR 0023), the loader seam: every screen that runs the company reads its bundle through `loadLiveProcessBySlug`, which builds it from the live
// company map once a person has published a version (`map_drives_run`). A card taken off the map in a published version must therefore show in
// the model Capacity reads and in the Sandbox's default run alike; a process page is unchanged. Two workspaces: Northbeam (a person takes the
// Monthly report card off and publishes), and Larkspur (a person already changed its map: the flag is false, so its run is still today's).

let db: TestDb;
let dbAs: Db;
let admin: { id: string; claims: Record<string, unknown> };
const TODAY = "2026-11-09";
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];

async function asAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin.claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}
const rpc = async (c: pg.Client, fn: string, ...args: unknown[]) => (await c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r as Record<string, unknown>;

const NB = northbeamBundle();
const LS = larkspurBundle();
let dropped: string;

/** A person takes the card of process `name` off the live company map and publishes it. */
async function takeCardOff(ws: string, name: string): Promise<string> {
  const company = (await q("select id from processes where workspace_id = $1 and is_company", [ws]))[0]!.id as string;
  const pid = (await q("select id from processes where workspace_id = $1 and name = $2 and not is_company", [ws, name]))[0]!.id as string;
  const draft = (await asAdmin((c) => rpc(c, "open_draft", company))).revision_id as string;
  await q("delete from steps where revision_id = $1 and child_process_id = $2", [draft, pid]);
  expect((await asAdmin((c) => rpc(c, "publish_process", company))).status).toBe("published");
  return pid;
}

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  admin = await createUser(db, "admin@company-run-loader.example.com", { agency_admin: true });
  dbAs = db.dbAs({ sub: admin.id, role: "authenticated", app_metadata: { agency_admin: true } } as never);
  dropped = await takeCardOff(NB.workspace.id, "Monthly report");
  // Larkspur: a person's version existed before the flag (as a backfilled workspace's), so the flag is false and the map doesn't drive the run.
  await takeCardOff(LS.workspace.id, "Content calendar");
  await q("update processes set map_drives_run = false where workspace_id = $1 and is_company", [LS.workspace.id]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const ids = (b: ProcessBundle) => [b.process.id, ...(b.otherProcesses ?? []).map((p) => p.process.id)].sort();

describe("a map-driven workspace with a card taken off", () => {
  it("the person's publish made the map drive the run", async () => {
    expect((await q("select map_drives_run from processes where workspace_id = $1 and is_company", [NB.workspace.id]))[0]!.map_drives_run).toBe(true);
  });

  it("Capacity's model and the Sandbox's default model are deep-equal, and leave the dropped process out", async () => {
    const live = (await loadLiveProcessBySlug(dbAs, NB.workspace.slug))!;
    const today = (await loadProcessBySlug(dbAs, NB.workspace.slug, { draft: false }))!.live;
    // Capacity reads the loader's bundle as it is; the Sandbox runs the live company map on it.
    const capacity = toEngineModel(live, { startDate: TODAY, planned: true, purposes: true });
    const [parts, company] = await Promise.all([loadLiveParts(dbAs, NB.workspace.id), loadLiveCompanyPart(dbAs, NB.workspace.id)]);
    const sandbox = companyEngineModel(company!, live, parts, { startDate: TODAY, planned: true, purposes: true });
    expect(sandbox.model).toEqual(capacity);
    // The same again from the bundle with no map applied (what the Sandbox page would have before the loader did it).
    expect(companyEngineModel(company!, today, parts, { startDate: TODAY, planned: true, purposes: true }).model).toEqual(capacity);
    // The card is off the map, so that process is neither in the bundle nor in the model, though today's bundle runs it.
    expect(ids(live)).not.toContain(dropped);
    expect(ids(today)).toContain(dropped);
    expect(Object.keys(capacity.servicingProcesses ?? {})).not.toContain(dropped);
    expect(Object.keys(toEngineModel(today, { startDate: TODAY, planned: true, purposes: true }).servicingProcesses ?? {})).toContain(dropped);
    expect(sandbox.notes.map((n) => n.message)).toEqual([expect.stringMatching(/^'Monthly report' is linked to .+ but isn't on this company map, so its work isn't simulated\.$/)]);
  });

  it("a process page is unchanged: a bundle opened by process id still runs today's processes", async () => {
    const pipelineId = NB.process.id;
    const page = (await loadProcessBySlug(dbAs, NB.workspace.slug, { draft: false, processId: pipelineId }))!.live;
    expect(ids(page)).toContain(dropped);
    expect(toEngineModel(page, { startDate: TODAY })).toEqual(toEngineModel((await loadProcessBySlug(dbAs, NB.workspace.slug, { draft: false }))!.live, { startDate: TODAY }));
  });
});

describe("a workspace whose live map a person changed before the flag", () => {
  it("keeps today's run on every screen: the loader's bundle is today's, and the Sandbox on the live map says how the map differs", async () => {
    expect((await q("select map_drives_run from processes where workspace_id = $1 and is_company", [LS.workspace.id]))[0]!.map_drives_run).toBe(false);
    const live = (await loadLiveProcessBySlug(dbAs, LS.workspace.slug))!;
    const today = (await loadProcessBySlug(dbAs, LS.workspace.slug, { draft: false }))!.live;
    expect(toEngineModel(live, { startDate: TODAY })).toEqual(toEngineModel(today, { startDate: TODAY }));
    expect(ids(live)).toEqual(ids(today));
    // The map itself does leave a card off: run from it (the draft or a version chosen in the Sandbox), it is a different run.
    const [parts, company] = await Promise.all([loadLiveParts(dbAs, LS.workspace.id), loadLiveCompanyPart(dbAs, LS.workspace.id)]);
    const fromMap = companyEngineModel(company!, live, parts, { startDate: TODAY });
    expect(fromMap.model).not.toEqual(toEngineModel(live, { startDate: TODAY }));
    expect(fromMap.notes.map((n) => n.kind)).toContain("not-on-map");
  });
});
