import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate, type EngineModel, type EngineStepChange } from "@transpera-flow/engine";
import {
  defaultPlay,
  loadCapacitySetup,
  loadProcessBySlug,
  loadSolutionIssues,
  loadSolutions,
  type PlayContext,
  type PlayState,
  type ProcessBundle,
  type SolutionIssueRow,
  type SolutionRow,
} from "../src";
import { SANDBOX_SEED, joinRun, preparePlay, type PreparedPlay } from "../src/sandbox";
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { addExampleIssues } from "../src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "./harness";

// D53, Part A item 2: the equality test. In the capacity example, a Sandbox run with change X switched on from month m (what the levers did before the
// move: one `EngineStepChange` with `startMonth` m + 1 added to the model) must equal a run with X's solution picked from month m: the same model and
// the same results. The "before" is built here as the old `applyPlay` built it; the "after" is the code the Sandbox runs now (`preparePlay` with the
// version picked), over the solutions the example loader and the migration make.

let db: TestDb;
let ws: string;
let bundle: ProcessBundle;
let solutions: SolutionRow[];
let links: SolutionIssueRow[];
let ctx: PlayContext;
const SLUG = "changes-into-solutions";
const TODAY = "2026-10-05";
const REPS = 3;
const MONTHS = 12;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(db, "owner@changes-into-solutions.example.com", { agency_admin: true });
  ws = (await db.client.query("insert into workspaces (name, slug) values ($1, $1) returning id", [SLUG])).rows[0].id as string;
  await db.client.query("begin");
  expect(await loadCapacityExample(db.client, ws, TODAY)).toMatchObject({ applied: true });
  await db.client.query("commit");
  await db.client.query("begin");
  expect(await addExampleIssues(db.client, ws)).toMatchObject({ applied: true });
  await db.client.query("commit");
  const dbAs = db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const pipeline = (await db.client.query("select id from processes where workspace_id = $1 and kind = 'pipeline' and is_company is not true", [ws])).rows[0].id as string;
  bundle = (await loadProcessBySlug(dbAs, SLUG, { draft: false, processId: pipeline }))!.live as ProcessBundle;
  solutions = await loadSolutions(dbAs, ws);
  links = await loadSolutionIssues(dbAs, ws);
  const setup = (await loadCapacitySetup(dbAs, ws))!;
  ctx = { startDate: TODAY, setup, issueOf: (id) => links.find((l) => l.solution_id === id)?.issue_id, winMix: () => ({}) };
}, 300_000);
afterAll(async () => {
  await db?.close();
});

/** The solutions that hold a change, by its name (one for each process it acts on). */
const holding = (name: string) => solutions.filter((s) => s.step_changes.some((c) => c.name === name));

const play = (picks: { solution: SolutionRow; month: number }[]): PlayState => ({ ...defaultPlay(), versions: Object.fromEntries(picks.map((p) => [p.solution.process_id, { solution: p.solution.id, month: p.month }])) });

/** What a switched-on change was in the model before the move: the old `toEngineStepChange(row, month + 1)`, with its issue. */
function legacyChange(solutionsOfIt: SolutionRow[], month: number): EngineStepChange {
  const one = solutionsOfIt[0]!.step_changes[0]!;
  const issueId = links.find((l) => l.solution_id === solutionsOfIt[0]!.id)?.issue_id;
  return {
    id: one.id!,
    name: one.name,
    kind: one.kind,
    // A change of one row had all its effects; the solutions hold the effects on each process's steps, in order.
    effects: solutionsOfIt.flatMap((s) => s.step_changes[0]!.effects.map((e) => ({ ...e }))),
    adoption: one.adoption,
    startMonth: month + 1,
    rampMonths: one.ramp_months,
    ...(one.tiers && one.tiers.length ? { tiers: [...one.tiers] } : {}),
    ...(issueId ? { issueId } : {}),
  };
}

/** The engine run of one model as the Sandbox runs a segment, from the same pinned warm-up. */
const run = (model: EngineModel, plan: PreparedPlay) => simulate(model, REPS, SANDBOX_SEED, { monthly: true, monthStarts: plan.monthStarts, ...(plan.start ? { initialState: plan.start } : {}) });

describe("the example's changes in solutions", () => {
  it("holds the prototype's 13 changes, one solution each (none acts on two processes), with ids and the engine's shape", () => {
    const names = [...new Set(solutions.flatMap((s) => s.step_changes.map((c) => c.name)))];
    expect(names).toHaveLength(13);
    for (const name of names) expect(holding(name), name).toHaveLength(1);
    for (const s of solutions.filter((x) => x.step_changes.length)) {
      expect(s.status).toBe("testing");
      expect(s.step_changes).toHaveLength(1);
      expect(s.step_changes[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.changed_step_ids.length).toBeGreaterThan(0);
    }
  });
});

describe("a change switched on from month m equals its solution picked from month m", () => {
  const names = [
    "Unified pacing with alerts",
    "Anomaly and threshold alerts",
    "AI link-domain pre-vetting",
    "Link health monitor, publisher CRM, invoice chasing",
    "Content brief automation and freelancer handoff",
    "Pre-call data collation and talking points",
    "Pre-call data collation (Organic)",
    "Review slides for small clients",
    'Report "work completed / planned" page',
    "Meta ad QA checker",
    "Auto-generated implementation briefs",
    "Quarterly review deck generation",
    "Report commentary drafts",
  ];

  for (const month of [0, 3]) {
    for (const name of names) {
      it(`${name}, from month ${month + 1}: the same model and the same results`, () => {
        const mine = holding(name);
        // Before: today's path with the change added from the month.
        const base = preparePlay(bundle, defaultPlay(), ctx, solutions, MONTHS);
        expect(base.error).toBeNull();
        const before: EngineModel = { ...base.segments[0]!.model, changes: [...(base.segments[0]!.model.changes ?? []), legacyChange(mine, month)] };
        // After: the solution picked as its process's version from the month.
        const after = preparePlay(bundle, play(mine.map((solution) => ({ solution, month }))), ctx, solutions, MONTHS);
        expect(after.error).toBeNull();
        expect(after.segments.map((s) => s.from)).toEqual(month === 0 ? [0] : [0, month]);
        // The same model: the last segment (the one the change is in force in) is the "before" model, field for field.
        expect(after.segments[after.segments.length - 1]!.model).toEqual(before);
        // Before the version goes live the run is today's path, untouched.
        if (month > 0) expect(after.segments[0]!.model).toEqual(base.segments[0]!.model);
        // The same results: the months of the "before" run equal the spliced months of the "after" run.
        const wanted = run(before, after);
        const joined = joinRun(after.prepared, after.segments, after.segments.map((s) => run(s.model, after)));
        expect(joined.result.monthly).toEqual(wanted.monthly);
      }, 120_000);
    }
  }

  it("a month's change moves the results from that month and not before", () => {
    const mine = holding("Report commentary drafts");
    const after = preparePlay(bundle, play(mine.map((solution) => ({ solution, month: 3 }))), ctx, solutions, MONTHS);
    const todays = preparePlay(bundle, defaultPlay(), ctx, solutions, MONTHS);
    const a = joinRun(after.prepared, after.segments, after.segments.map((s) => run(s.model, after))).result.monthly!;
    const t = run(todays.segments[0]!.model, todays).monthly!;
    const roles = Object.keys(a.roles ?? {});
    expect(roles.length).toBeGreaterThan(0);
    const hours = (m: typeof a) => Object.values(m.roles ?? {}).map((rows) => rows.map((r) => r?.mean));
    const x = hours(a);
    const y = hours(t);
    // Identical for the first three months; somewhere later at least one role differs.
    for (let i = 0; i < x.length; i++) expect(x[i]!.slice(0, 3)).toEqual(y[i]!.slice(0, 3));
    expect(x.some((row, i) => row.slice(3).some((v, j) => v !== y[i]![j + 3]))).toBe(true);
  }, 120_000);

  it("live runs carry no step changes (Capacity and the Overview)", () => {
    const base = preparePlay(bundle, defaultPlay(), ctx, solutions, MONTHS);
    expect(base.segments[0]!.model.changes ?? []).toEqual([]);
  });
});
