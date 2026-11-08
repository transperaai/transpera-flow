import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import { loadIssues, loadProcessBySlug, toEngineModel, type ProcessBundle, type SolutionRow } from "../src";
import { withSolution } from "../src/sandbox";
import { loadCapacityExample } from "../src/fixtures/capacity-example";
import { addExampleIssues } from "../src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "./harness";

// Q6: the example issues and solutions for the preview's example agency. Made-up data, written through the app's own SQL functions.

let db: TestDb;
let dbAs: ReturnType<TestDb["dbAs"]>;
let ws: string;
let first: Awaited<ReturnType<typeof addExampleIssues>>;
const SLUG = "capacity-example-issues";
const TODAY = new Date().toISOString().slice(0, 10);

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];
const count = async (table: string) => Number((await q(`select count(*)::int as n from ${table} where workspace_id = $1`, [ws]))[0]!.n);

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(db, "owner@capacity-example-issues.example.com", { agency_admin: true });
  ws = (await q("insert into workspaces (name, slug) values ($1, $1) returning id", [SLUG]))[0]!.id as string;
  await db.client.query("begin");
  expect(await loadCapacityExample(db.client, ws, TODAY)).toMatchObject({ applied: true });
  await db.client.query("commit");
  dbAs = db.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  await db.client.query("begin");
  first = await addExampleIssues(db.client, ws);
  await db.client.query("commit");
}, 180_000);
afterAll(async () => {
  await db?.close();
});

describe("adding the example issues to a freshly loaded example workspace", () => {
  it("adds eight issues, links changes to them and saves three solutions", () => {
    expect(first).toEqual({ applied: true, issues: 8, changesLinked: 10, solutions: 3 });
  });

  it("gives the issues a mix of ratings and statuses, owners and a note each, on real steps", async () => {
    const issues = await loadIssues(dbAs, ws);
    expect(issues).toHaveLength(8);
    expect(new Set(issues.map((i) => i.severity))).toEqual(new Set(["critical", "serious", "warning", "info"]));
    expect(issues.map((i) => i.status).sort()).toEqual(["open", "open", "open", "open", "open", "resolved", "testing", "testing"]);
    expect(issues.map((i) => i.number).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const i of issues) {
      expect(i.evidence, i.title).toBeTruthy();
      expect(i.owner_ids, i.title).toHaveLength(1);
      expect(i.links.length, i.title).toBeGreaterThan(0);
      for (const l of i.links) {
        const step = await q("select 1 from steps where id = $1 and process_id = $2 and workspace_id = $3", [l.step_id, l.process_id, ws]);
        expect(step, i.title).toHaveLength(1);
      }
    }
    const titles = issues.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(["Pacing lives in three places", "Meeting prep is data hunting", "Only Karl can vet link domains"]));
    const onboarding = issues.find((i) => i.title === "Onboarding crowds out monthly work")!;
    expect(onboarding.evidence).toContain("no onboarding process");
  });

  it("links the solutions that hold the changes to the issue each fixes, and leaves the rest alone", async () => {
    const issues = await loadIssues(dbAs, ws);
    const idOf = (title: string) => issues.find((i) => i.title === title)!.id;
    // A change is one solution for each process it acts on; a solution that holds a change is named after it and has a step_changes list of one.
    const held = await q(
      `select s.name, l.issue_id from solutions s left join solution_issues l on l.solution_id = s.id where s.workspace_id = $1 and s.step_changes <> '[]'::jsonb order by s.name`,
      [ws],
    );
    const linked = (name: string) => held.filter((h) => h.name === name).map((h) => h.issue_id);
    expect(new Set(held.map((h) => h.name)).size).toBe(13);
    expect(linked("Unified pacing with alerts")).toEqual([idOf("Pacing lives in three places")]);
    expect(linked("Anomaly and threshold alerts")).toEqual([idOf("Pacing lives in three places")]);
    expect(linked("AI link-domain pre-vetting")).toEqual([idOf("Link team runs near its utilisation threshold")]);
    expect(linked("Link health monitor, publisher CRM, invoice chasing")).toEqual([idOf("Link team runs near its utilisation threshold")]);
    expect(linked("Content brief automation and freelancer handoff")).toEqual([idOf("Content briefs are re-typed for freelancers")]);
    expect(linked("Pre-call data collation and talking points")).toEqual([idOf("Meeting prep is data hunting")]);
    expect(linked("Pre-call data collation (Organic)")).toEqual([idOf("Meeting prep is data hunting")]);
    expect(linked("Review slides for small clients")).toEqual([idOf("Onboarding crowds out monthly work")]);
    expect(linked('Report "work completed / planned" page')).toEqual([idOf("Monthly plans wait on client approval")]);
    expect(linked("Meta ad QA checker")).toEqual([idOf("Ad QA repeats checks done at build")]);
    expect(new Set(held.filter((h) => h.issue_id).map((h) => h.name)).size).toBe(10);
    expect(held.filter((h) => !h.issue_id).length).toBeGreaterThan(0);
  });

  it("saves three solutions, each linked to an issue at a different stage", async () => {
    const rows = await q(
      `select s.name, s.status as solution_status, i.title, i.status, coalesce(i.resolved_solution_id = s.id, false) as fixed, l.user_verdict
         from solutions s join solution_issues l on l.solution_id = s.id join issues i on i.id = l.issue_id where s.workspace_id = $1 and s.step_changes = '[]'::jsonb order by s.name`,
      [ws],
    );
    expect(rows).toEqual([
      { name: "Ad QA only on new campaigns", solution_status: "adopted", title: "Ad QA repeats checks done at build", status: "done", fixed: true, user_verdict: null },
      { name: "One budget entry instead of three", solution_status: "testing", title: "Pacing lives in three places", status: "in_progress", fixed: false, user_verdict: null },
      { name: "Vetting by a second person", solution_status: "works", title: "Only Karl can vet link domains", status: "in_progress", fixed: false, user_verdict: "pass" },
    ]);
  });

  it("gives each solution a valid map that simulates, with routing odds that sum to 1", async () => {
    const solutions = (await q("select * from solutions where workspace_id = $1 and step_changes = '[]'::jsonb", [ws])) as unknown as SolutionRow[];
    expect(solutions).toHaveLength(3);
    const pipeline = (await q("select id from processes where workspace_id = $1 and kind = 'pipeline' and is_company is not true", [ws]))[0]!.id as string;
    const bundle = (await loadProcessBySlug(dbAs, SLUG, { draft: false, processId: pipeline }))!.live as ProcessBundle;
    for (const s of solutions) {
      const { steps, edges } = s.steps;
      const ids = new Set(steps.map((x) => x.id));
      expect(ids.size, s.name).toBe(steps.length);
      for (const e of edges) {
        expect(ids.has(e.from_step_id) && ids.has(e.to_step_id), s.name).toBe(true);
      }
      expect(steps.filter((x) => x.kind === "start"), s.name).toHaveLength(1);
      // Every step that leads somewhere splits its work over odds that sum to 1.
      for (const x of steps.filter((y) => y.kind !== "end")) {
        const out = edges.filter((e) => e.from_step_id === x.id);
        expect(out.length, `${s.name}: ${x.name}`).toBeGreaterThan(0);
        expect(out.reduce((a, e) => a + Number(e.probability), 0), `${s.name}: ${x.name}`).toBeCloseTo(1, 9);
      }
      // It is a real routing change, not the live map again.
      const live = await q("select count(*)::int as n from steps where revision_id = $1", [s.base_revision_id]);
      const liveEdges = await q("select from_step_id, to_step_id, probability from edges where revision_id = $1", [s.base_revision_id]);
      const sig = (list: Record<string, unknown>[]) => list.map((e) => `${e.from_step_id}>${e.to_step_id}:${Number(e.probability)}`).sort().join("|");
      expect(sig(edges) !== sig(liveEdges) || steps.length !== Number(live[0]!.n), s.name).toBe(true);
      expect(s.changed_step_ids.length, s.name).toBeGreaterThan(0);
      // It opens in the Sandbox's model and simulates.
      const solved = withSolution(bundle, s);
      expect(solved, s.name).not.toBeNull();
      const result = simulate(toEngineModel(solved!, { startDate: TODAY, planned: true }), 2, 1);
      expect(result.kpi, s.name).toBeDefined();
      expect(Object.keys(result.people), s.name).toHaveLength(27);
    }
  }, 300_000);

  it("shares the vetting between two people and merges two pacing steps", async () => {
    const byName = async (name: string) => (await q("select steps from solutions where workspace_id = $1 and name = $2", [ws, name]))[0]!.steps as { steps: { name: string; person_id: string | null }[]; edges: unknown[] };
    const vetting = await byName("Vetting by a second person");
    const people = vetting.steps.filter((x) => x.name.startsWith("Domain vetting")).map((x) => x.person_id);
    expect(people).toHaveLength(2);
    expect(new Set(people).size).toBe(2);
    const pacing = await byName("One budget entry instead of three");
    expect(pacing.steps.map((x) => x.name)).not.toContain("Pacing checks");
    expect(pacing.steps.map((x) => x.name)).toContain("Pacing and review from one budget entry");
  });
});

describe("running it again, or on the wrong workspace", () => {
  it("changes nothing the second time and says so", async () => {
    const before = [await count("issues"), await count("solutions"), await count("solution_issues"), await count("capacity_changes")];
    await db.client.query("begin");
    const again = await addExampleIssues(db.client, ws);
    await db.client.query("rollback");
    expect(again).toEqual({ applied: false, reason: expect.stringContaining("already has issues") });
    expect([await count("issues"), await count("solutions"), await count("solution_issues"), await count("capacity_changes")]).toEqual(before);
  });

  it("refuses a workspace that doesn't hold the example", async () => {
    const other = (await q("insert into workspaces (name, slug) values ('Not the example', 'not-the-example') returning id"))[0]!.id as string;
    await db.client.query("begin");
    const result = await addExampleIssues(db.client, other);
    await db.client.query("rollback");
    expect(result).toEqual({ applied: false, reason: expect.stringContaining("doesn't hold the example") });
    expect(Number((await q("select count(*)::int as n from issues where workspace_id = $1", [other]))[0]!.n)).toBe(0);
    await db.client.query("begin");
    expect(await addExampleIssues(db.client, "00000000-0000-4000-8000-0000000000ff")).toEqual({ applied: false, reason: "No such workspace." });
    await db.client.query("rollback");
  });

  it("leaves the session's claims as they were", async () => {
    const claims = await q("select coalesce(current_setting('request.jwt.claims', true), '') as v");
    expect(claims[0]!.v).toBe("");
  });
});
