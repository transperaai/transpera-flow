import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { addExampleIssues } from "../src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "./harness";

// Q12 (D44): "Adopt" opens the process's draft seeded with the solution's steps. Never publishes; live is untouched.

let db: TestDb;
let ws: string;
let adminClaims: Record<string, unknown>;
let viewerClaims: Record<string, unknown>;
let solution: { id: string; process_id: string; steps: { steps: { id: string }[]; edges: { id: string }[] } };
const TODAY = new Date().toISOString().slice(0, 10);

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  adminClaims = (await createUser(db, "admin@adopt-solution.example.com", { agency_admin: true })).claims;
  viewerClaims = (await createUser(db, "viewer@adopt-solution.example.com")).claims;
  ws = (await q("insert into workspaces (name, slug) values ('adopt', 'adopt') returning id"))[0]!.id as string;
  await db.client.query("begin");
  await loadCapacityExample(db.client, ws, TODAY);
  await db.client.query("commit");
  await db.client.query("begin");
  await addExampleIssues(db.client, ws);
  await db.client.query("commit");
  solution = (await q("select id, process_id, steps from solutions where workspace_id = $1 and name = 'Vetting by a second person'", [ws]))[0] as unknown as typeof solution;
}, 180_000);
afterAll(async () => {
  await db?.close();
});

const adopt = async (client: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, replace = false) =>
  (await client.query("select public.adopt_solution($1, $2) as r", [solution.id, replace])).rows[0]!.r as Record<string, unknown>;

describe("adopt_solution", () => {
  it("opens a draft with the solution's steps and edges, leaves live alone and marks the solution adopted", async () => {
    const live = (await q("select live_revision_id, draft_revision_id from processes where id = $1", [solution.process_id]))[0]!;
    expect(live.draft_revision_id).toBeNull();
    const liveSteps = Number((await q("select count(*)::int as n from steps where revision_id = $1", [live.live_revision_id]))[0]!.n);
    const result = await db.as(adminClaims, async (c) => {
      const r = await adopt(c);
      const draftId = r.revision_id as string;
      const steps = (await c.query("select id from steps where revision_id = $1", [draftId])).rows.map((x) => x.id as string).sort();
      const edges = (await c.query("select id from edges where revision_id = $1", [draftId])).rows.map((x) => x.id as string).sort();
      const p = (await c.query("select draft_revision_id, live_revision_id from processes where id = $1", [solution.process_id])).rows[0]!;
      const status = (await c.query("select status from solutions where id = $1", [solution.id])).rows[0]!.status;
      const draft = (await c.query("select status, number from process_revisions where id = $1", [draftId])).rows[0]!;
      const liveNow = Number((await c.query("select count(*)::int as n from steps where revision_id = $1", [live.live_revision_id])).rows[0]!.n);
      return { r, steps, edges, p, status, draft, liveNow, draftId };
    });
    expect(result.r).toMatchObject({ status: "ok", replaced_draft: false });
    expect(result.steps).toEqual(solution.steps.steps.map((s) => s.id).sort());
    expect(result.edges).toEqual(solution.steps.edges.map((e) => e.id).sort());
    expect(result.p.draft_revision_id).toBe(result.draftId);
    expect(result.p.live_revision_id).toBe(live.live_revision_id);
    expect(result.draft).toMatchObject({ status: "draft" });
    expect(result.status).toBe("adopted");
    expect(result.liveNow).toBe(liveSteps);
  });

  it("keeps a draft with work in it unless told to replace it", async () => {
    await db.as(adminClaims, async (c) => {
      expect(await adopt(c)).toMatchObject({ status: "ok" });
      // The draft now differs from live (the solution's changes): a second adopt asks first.
      expect(await adopt(c)).toMatchObject({ status: "draft_exists" });
      expect(await adopt(c, true)).toMatchObject({ status: "ok", replaced_draft: true });
    });
  });

  it("refuses someone who can't edit the workspace, and changes nothing", async () => {
    await db.as(viewerClaims, async (c) => {
      expect(await adopt(c)).toEqual({ status: "not_found" });
    });
    expect((await q("select draft_revision_id from processes where id = $1", [solution.process_id]))[0]!.draft_revision_id).toBeNull();
    expect((await q("select status from solutions where id = $1", [solution.id]))[0]!.status).toBe("works");
  });
});
