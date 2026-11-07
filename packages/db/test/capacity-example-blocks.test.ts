import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import { loadProcessBySlug, toEngineModel, type BlockRow, type ProcessBundle, type SolutionRow } from "../src";
import { withSolution } from "../src/sandbox";
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { addExampleBlocks } from "../src/fixtures/capacity-example-blocks";
import { addExampleIssues } from "../src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "./harness";

// Q12: the example blocks for the Block library. Made-up data, written the way the app saves a block and a solution.

let db: TestDb;
let dbAs: ReturnType<TestDb["dbAs"]>;
let ws: string;
const SLUG = "capacity-example-blocks";
const TODAY = new Date().toISOString().slice(0, 10);

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];
const inTransaction = async <T>(fn: () => Promise<T>, commit: (r: T) => boolean) => {
  await db.client.query("begin");
  const r = await fn();
  await db.client.query(commit(r) ? "commit" : "rollback");
  return r;
};

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(db, "owner@capacity-example-blocks.example.com", { agency_admin: true });
  ws = (await q("insert into workspaces (name, slug) values ($1, $1) returning id", [SLUG]))[0]!.id as string;
  await inTransaction(() => loadCapacityExample(db.client, ws, TODAY), (r) => r.applied);
  dbAs = db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
}, 180_000);
afterAll(async () => {
  await db?.close();
});

describe("blocks on a workspace without the issues", () => {
  it("adds the four blocks but no solution, because the issue it solves is not there", async () => {
    const result = await inTransaction(() => addExampleBlocks(db.client, ws), (r) => r.applied);
    expect(result).toEqual({ applied: true, blocks: 4, solutions: 0 });
    expect((await q("select name from blocks where workspace_id = $1 order by name", [ws])).map((r) => r.name)).toEqual([
      "Client approval loop",
      "Link vetting pair",
      "Monthly report",
      "QA and sign-off",
    ]);
    // The example's changes are held by solutions of their own (D53); none of them is made by the blocks.
    expect(Number((await q("select count(*)::int as n from solutions where workspace_id = $1 and step_changes = '[]'::jsonb", [ws]))[0]!.n)).toBe(0);
  });

  it("is idempotent: the second run changes nothing and says so", async () => {
    const again = await inTransaction(() => addExampleBlocks(db.client, ws), (r) => r.applied);
    expect(again).toEqual({ applied: false, reason: expect.stringContaining("already has the example blocks") });
    expect(Number((await q("select count(*)::int as n from blocks where workspace_id = $1", [ws]))[0]!.n)).toBe(4);
  });
});

describe("blocks on a workspace with the example issues", () => {
  let blocks: BlockRow[];
  beforeAll(async () => {
    // The blocks, then the issues (so the solution that uses a block finds its issue): start from an empty library.
    await q("delete from blocks where workspace_id = $1", [ws]);
    expect(await inTransaction(() => addExampleIssues(db.client, ws), (r) => r.applied)).toMatchObject({ applied: true, solutions: 3 });
    expect(await inTransaction(() => addExampleBlocks(db.client, ws), (r) => r.applied)).toEqual({ applied: true, blocks: 4, solutions: 1 });
    blocks = (await q("select * from blocks where workspace_id = $1 order by name", [ws])) as unknown as BlockRow[];
  }, 180_000);

  it("saves manual blocks with steps, chained edges, and base values from the real step", () => {
    expect(blocks).toHaveLength(4);
    const byName = new Map(blocks.map((b) => [b.name, b]));
    const parts = (name: string) => byName.get(name)!.steps.steps.map((s) => s.name);
    expect(parts("Client approval loop")).toEqual(["Send for approval", "Wait for client approval", "Revise after feedback"]);
    expect(parts("QA and sign-off")).toEqual(["Check the work", "Sign off"]);
    expect(parts("Monthly report")).toEqual(["Pull the data", "Write the commentary", "Send the report"]);
    expect(parts("Link vetting pair")).toEqual(["Pre-screen the domain", "Final look"]);
    for (const b of blocks) {
      expect(b.type, b.name).toBe("manual");
      expect(b.description, b.name).toBeTruthy();
      const { steps, edges, entry_step_id } = b.steps;
      expect(edges, b.name).toHaveLength(steps.length - 1);
      expect(entry_step_id, b.name).toBe(steps[0]!.id);
      for (const s of steps) {
        expect(s.kind, `${b.name}: ${s.name}`).toBe("task");
        expect(s.parent_step_id, `${b.name}: ${s.name}`).toBeNull();
        // Base values: the split carries over, and the tier multipliers wherever the real step has them.
        expect(s.split, `${b.name}: ${s.name}`).toBeTruthy();
      }
    }
    // The approval loop is made from the monthly plan step, which has tier multipliers.
    for (const s of byName.get("Client approval loop")!.steps.steps) expect(s.tier_multiplier).toEqual({ T1: 1.5, T3: 0.7 });
    expect(byName.get("Client approval loop")!.steps.steps[1]!.wait_hours).toBe(24);
  });

  it("puts one block into one solution, so the library shows 'Used in 1 solution'", async () => {
    const approval = blocks.find((b) => b.name === "Client approval loop")!;
    const solutions = (await q("select * from solutions where workspace_id = $1 and step_changes = '[]'::jsonb order by name", [ws])) as unknown as SolutionRow[];
    expect(solutions).toHaveLength(4);
    const using = solutions.filter((s) => s.steps.steps.some((st) => (st.provenance as { block?: string } | null)?.block === approval.id));
    expect(using.map((s) => s.name)).toEqual(["One approval loop for monthly plans"]);
    for (const other of blocks.filter((b) => b.id !== approval.id)) {
      expect(solutions.some((s) => s.steps.steps.some((st) => (st.provenance as { block?: string } | null)?.block === other.id)), other.name).toBe(false);
    }
    // Tied to an issue, as every solution is.
    const link = await q(
      "select i.title from solution_issues l join issues i on i.id = l.issue_id where l.solution_id = $1",
      [using[0]!.id],
    );
    expect(link).toEqual([{ title: "Monthly plans wait on client approval" }]);
  });

  it("gives that solution a valid map that simulates", async () => {
    const s = (await q("select * from solutions where workspace_id = $1 and name = 'One approval loop for monthly plans'", [ws]))[0] as unknown as SolutionRow;
    const ids = new Set(s.steps.steps.map((x) => x.id));
    expect(ids.size).toBe(s.steps.steps.length);
    for (const e of s.steps.edges) expect(ids.has(e.from_step_id) && ids.has(e.to_step_id)).toBe(true);
    const group = s.steps.steps.find((x) => x.kind === "group")!;
    expect(group.name).toBe("Client approval loop");
    expect(s.steps.steps.filter((x) => x.parent_step_id === group.id)).toHaveLength(3);
    expect(s.changed_step_ids.length).toBeGreaterThan(0);
    const pipeline = (await q("select id from processes where workspace_id = $1 and kind = 'pipeline' and is_company is not true", [ws]))[0]!.id as string;
    const bundle = (await loadProcessBySlug(dbAs, SLUG, { draft: false, processId: pipeline }))!.live as ProcessBundle;
    const solved = withSolution(bundle, s);
    expect(solved).not.toBeNull();
    const result = simulate(toEngineModel(solved!, { startDate: TODAY, planned: true }), 2, 1);
    expect(result.kpi).toBeDefined();
  }, 300_000);

  it("leaves the session's claims as they were", async () => {
    expect((await q("select coalesce(current_setting('request.jwt.claims', true), '') as v"))[0]!.v).toBe("");
  });
});

describe("the wrong workspace", () => {
  it("refuses one that doesn't hold the example", async () => {
    const other = (await q("insert into workspaces (name, slug) values ('Not the example', 'not-the-example-blocks') returning id"))[0]!.id as string;
    const result = await inTransaction(() => addExampleBlocks(db.client, other), (r) => r.applied);
    expect(result).toEqual({ applied: false, reason: expect.stringContaining("doesn't hold the example") });
    expect(await inTransaction(() => addExampleBlocks(db.client, "00000000-0000-4000-8000-0000000000ff"), (r) => r.applied)).toEqual({ applied: false, reason: "No such workspace." });
  });
});
