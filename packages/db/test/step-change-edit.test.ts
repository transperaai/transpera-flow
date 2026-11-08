import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStepChangeEdit, carryStepChanges, loadSolutions, MAX_STEP_CHANGES, parseStepChanges, toEngineStepChanges, type SolutionRow, type StepChangeInput } from "../src";
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { addExampleIssues } from "../src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "./harness";

// D53, Part B: a change saved through the step panel (`applyStepChangeEdit`, written to `solutions.step_changes` as the action does) reaches the Sandbox
// as exactly the `EngineStepChange` the equivalent stored element gives, and the database's own checks and row-level security still decide.

let db: TestDb;
let ws: string;
let owner: Awaited<ReturnType<typeof createUser>>;
let viewer: Awaited<ReturnType<typeof createUser>>;
let solution: SolutionRow;
let stepIds: Set<string>;
const SLUG = "step-change-edit";
const NEW_ID = "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11";

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  owner = await createUser(db, "owner@step-change-edit.example.com", { agency_admin: true });
  viewer = await createUser(db, "viewer@step-change-edit.example.com");
  ws = (await db.client.query("insert into workspaces (name, slug) values ($1, $1) returning id", [SLUG])).rows[0].id as string;
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, viewer.id]);
  await db.client.query("begin");
  await loadCapacityExample(db.client, ws, "2026-10-05");
  await db.client.query("commit");
  await db.client.query("begin");
  await addExampleIssues(db.client, ws);
  await db.client.query("commit");
  const dbAs = db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  solution = (await loadSolutions(dbAs, ws)).find((s) => s.step_changes.length > 0)!;
  stepIds = new Set(solution.steps.steps.map((s) => s.id));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }> };
/** Writes the list the way the action does (as the signed-in user; the transaction is rolled back after), and gives back what was stored. */
const writeAs = (claims: Record<string, unknown>, list: unknown, then?: (c: Q) => Promise<void>) =>
  db.as(claims, async (c) => {
    const n = (await c.query("update solutions set step_changes = $1::jsonb where id = $2 and workspace_id = $3", [JSON.stringify(list), solution.id, ws])).rowCount;
    await then?.(c);
    return { n, stored: (await c.query("select step_changes from solutions where id = $1", [solution.id])).rows[0]?.step_changes as unknown[] };
  });

describe("a change saved through the step panel", () => {
  it("equals the equivalent stored element, in the stored list and in the engine's input", async () => {
    const stored = solution.step_changes[0]!;
    // The same change as the panel's form would send it (no id: the action makes one), added to an empty list.
    const input: StepChangeInput = { name: stored.name, kind: stored.kind, effects: stored.effects, adoption: stored.adoption, ramp_months: stored.ramp_months, tiers: stored.tiers, cost_monthly: stored.cost_monthly };
    const made = applyStepChangeEdit(solution.id, [], { op: "save", key: null, change: input }, stepIds, () => NEW_ID);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.list).toHaveLength(1);
    const { n, stored: back } = await writeAs(owner.claims, made.list);
    expect(n).toBe(1);
    const equivalent = { ...stored, id: NEW_ID };
    expect(back[0]).toEqual(equivalent);
    const parsed = parseStepChanges(back);
    for (const month of [1, 4, 9]) {
      expect(toEngineStepChanges({ id: solution.id, step_changes: parsed }, month)).toEqual(toEngineStepChanges({ id: solution.id, step_changes: [equivalent] }, month));
    }
    expect(toEngineStepChanges({ id: solution.id, step_changes: parsed }, 4)).toEqual([
      {
        id: NEW_ID,
        name: stored.name,
        kind: stored.kind,
        effects: stored.effects.map((e) => ({ ...e })),
        adoption: stored.adoption,
        startMonth: 4,
        rampMonths: stored.ramp_months,
        ...(stored.tiers && stored.tiers.length ? { tiers: stored.tiers } : {}),
      },
    ]);
  });

  it("an edit keeps the change's id, so the engine's id for it does not move", async () => {
    const list = solution.step_changes;
    const first = list[0]!;
    const edited = applyStepChangeEdit(solution.id, list, { op: "save", key: first.id!, change: { ...first, adoption: 0.5 } }, stepIds, () => "unused");
    expect(edited.ok && edited.list[0]).toMatchObject({ id: first.id, adoption: 0.5 });
    if (!edited.ok) return;
    const { n, stored } = await writeAs(owner.claims, edited.list);
    expect(n).toBe(1);
    expect(stored[0]).toMatchObject({ id: first.id, adoption: 0.5 });
  });

  it("removes one by its key, and says plainly when it is gone", async () => {
    const list = solution.step_changes;
    const removed = applyStepChangeEdit(solution.id, list, { op: "remove", key: list[0]!.id! }, stepIds, () => "unused");
    expect(removed).toEqual({ ok: true, list: list.slice(1) });
    expect(applyStepChangeEdit(solution.id, [], { op: "remove", key: "nope" }, stepIds, () => "unused")).toEqual({ ok: false, message: "That change isn't in the solution any more. Reload the page." });
  });

  it("refuses a 41st change with a plain message, and an effect on a step that isn't in the solution", () => {
    const one: StepChangeInput = { name: "X", kind: "automation", effects: [{ step: [...stepIds][0]!, part: "automatable", remove: 0.5 }], adoption: 0.8, ramp_months: 0, tiers: null, cost_monthly: null };
    const full = Array.from({ length: MAX_STEP_CHANGES }, (_, i) => ({ ...one, id: `0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c${String(i).padStart(2, "0")}` }));
    expect(applyStepChangeEdit(solution.id, full, { op: "save", key: null, change: one }, stepIds, () => NEW_ID)).toEqual({ ok: false, message: "A solution can have at most 40 changes. Remove one first." });
    expect(applyStepChangeEdit(solution.id, [], { op: "save", key: null, change: { ...one, effects: [{ step: "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9cff", part: "automatable", remove: 0.5 }] } }, stepIds, () => NEW_ID)).toEqual({ ok: false, message: "An effect points at a step that isn't there." });
  });

  it("row-level security decides who: a viewer's write changes no rows", async () => {
    expect((await writeAs(viewer.claims, [])).n).toBe(0);
  });

  it("a copy keeps its changes with the same ids, so the Sandbox model of the copy equals the source's when no steps changed", async () => {
    const source = solution.step_changes;
    const carried = carryStepChanges(source, stepIds);
    expect(carried).toEqual(source);
    const { n, stored } = await writeAs(owner.claims, carried);
    expect(n).toBe(1);
    for (const month of [1, 6]) {
      expect(toEngineStepChanges({ id: "another-solution", step_changes: parseStepChanges(stored) }, month)).toEqual(toEngineStepChanges(solution, month));
    }
  });

  it("a copy drops an effect on a deleted step, and a change left with no effects", () => {
    const [a] = solution.step_changes;
    const gone = "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9cff";
    // Every step the change acts on is kept: which stored change comes first depends on the order rows come back, and it can act
    // on more than one step (keeping only its first effect's step made this fail now and then).
    const kept = new Set(a!.effects.map((e) => e.step));
    const two = { ...a!, id: NEW_ID, effects: [...a!.effects, { step: gone, part: "augmentable" as const, factor: 2 }] };
    const onlyGone = { ...a!, id: "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c22", effects: [{ step: gone, part: "automatable" as const, remove: 0.5 }] };
    const out = carryStepChanges([two, onlyGone], kept);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(NEW_ID);
    expect(out[0]!.effects.every((e) => kept.has(e.step))).toBe(true);
    expect(out[0]!.effects).toEqual(a!.effects);
  });
});
