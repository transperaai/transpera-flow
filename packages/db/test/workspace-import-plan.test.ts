import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import { IMPORT_COLUMNS, PLACEHOLDER_PREFIX, WORKSPACE_IMPORT_LIMITS, checkWorkspaceBundle, planWorkspaceImport, type Row, type WorkspaceBundle } from "../src";
import { ACCOUNT_KEY } from "../src/workspace-bundle";

// Checking and planning a workspace restore (issue #39, B10 2a): pure, no database. A real export is checked in
// workspace-import-plan-db.test.ts.

const id = () => randomUUID();
const FREE_UUID = "123e4567-e89b-42d3-a456-426614174000";

interface Ids {
  [k: string]: string;
}

/** A small, valid backup with one of everything the restore treats specially. */
function makeBundle(): { bundle: WorkspaceBundle; ids: Ids } {
  const ids: Ids = {};
  for (const k of ["ws", "role", "person", "service", "client", "src", "srcFile", "issue", "issueDet", "issueDone", "scn", "scnChild", "blk", "cond", "presetCond", "sugg", "suggDone", "prop", "propDone", "sol",
    "pA", "pB", "pC", "pCompany", "revA1", "revA2", "revAd", "revB", "revC", "revCo", "sA1", "sA2", "sC1", "sB1", "eA1", "eB1", "fpA", "ev1"]) ids[k] = id();
  const step = (sid: string, name: string, extra: Row = {}): Row => ({ id: sid, name, kind: "task", x: 1, y: 2, workspace_id: ids.ws, created_by: "u", created_at: "2026-01-01", updated_at: "2026-01-02", parent_step_id: null, entry_step_id: null, rework_to_step_id: null, person_id: null, role_id: null, child_process_id: null, replaced_by: [], provenance: {}, ...extra });
  const version = (vid: string, pid: string, n: number, status: string, flags: { live?: boolean; draft?: boolean }, steps: Row[], edges: Row[] = []): Row => ({
    id: vid, process_id: pid, number: n, status, layout: { a: n }, workspace_id: ids.ws, created_by: "u", live: !!flags.live, draft: !!flags.draft, steps, edges, first_principles: null,
  });
  const edge = (eid: string, a: string, b: string): Row => ({ id: eid, from_step_id: a, to_step_id: b, label: null, probability: 1, workspace_id: ids.ws, created_at: "x" });
  const proc = (pid: string, name: string, extra: Row, versions: Row[]): Row => ({ id: pid, name, kind: "process", entity_name: "lead", description: null, parent_process_id: null, is_company: false, archived_at: null, archived_by: null, workspace_id: ids.ws, created_by: "u", source: "manual", ...extra, versions });
  const processes = [
    proc(ids.pC!, "Child", { parent_process_id: ids.pA }, [version(ids.revC!, ids.pC!, 1, "published", { live: true }, [step(ids.sC1!, "c1")])]),
    proc(ids.pA!, "Alpha", {}, [
      version(ids.revA1!, ids.pA!, 1, "superseded", {}, [step(ids.sA1!, "a1")]),
      version(ids.revA2!, ids.pA!, 2, "published", { live: true }, [step(ids.sA1!, "a1", { replaced_by: [ids.sA2] }), step(ids.sA2!, "a2", { child_process_id: ids.pC, parent_step_id: ids.sA1, provenance: { name: { evidence: [{ source_id: ids.src }] } }, rework_to_step_id: id() })], [edge(ids.eA1!, ids.sA1!, ids.sA2!)]),
      version(ids.revAd!, ids.pA!, 3, "draft", { draft: true }, [step(ids.sA1!, "a1")]),
    ]),
    proc(ids.pB!, "Beta", { archived_at: "2026-03-01", archived_by: "u" }, [{ ...version(ids.revB!, ids.pB!, 1, "draft", { draft: true }, [step(ids.sB1!, "b1")], []), first_principles: { id: ids.fpA, process_id: ids.pB, revision_id: ids.revB, workspace_id: ids.ws, job_done: "x", created_by: "u" } }]),
    proc(ids.pCompany!, "Company", { is_company: true }, [version(ids.revCo!, ids.pCompany!, 1, "published", { live: true }, [])]),
  ];
  const w = ids.ws;
  const bundle = {
    format: "transpera-workspace/1",
    exported_at: "2026-10-05T00:00:00Z",
    engine_version: ENGINE_VERSION,
    scope: "everything",
    about: "x",
    workspace: { id: w, name: "Northbeam", slug: "northbeam", plan: null, settings: { hours_per_week: 40, currency: "GBP", mystery_key: 1 }, provenance: {} },
    company_model: {
      roles: [{ id: ids.role, workspace_id: w, name: "Analyst", color: null, default_cost_rate: 10, headcount: 1, ongoing_hours_per_client_week: 0, active: true, provenance: {}, created_at: "2026-01-01", created_by: "u" }],
      people: [{ id: ids.person, workspace_id: w, name: "Pat", email: "pat@example.com", active: true, capacity_hours_week: 40, cost_rate: 1, fte: 1, notes: null, provenance: {}, created_at: "2026-01-01" }],
      person_roles: [{ person_id: ids.person, role_id: ids.role, workspace_id: w }],
      person_skills: [{ person_id: ids.person, step_id: ids.sA1, workspace_id: w, efficiency: 1, provenance: {} }, { person_id: ids.person, step_id: id(), workspace_id: w, efficiency: 1, provenance: {} }],
      person_leave: [],
      services: [{ id: ids.service, workspace_id: w, name: "Retainer", entry_process_id: ids.pA, created_at: "2026-01-01", price: 1 }],
      service_servicing: [{ id: id(), workspace_id: w, service_id: ids.service, process_id: ids.pC, recurrence: null }],
      client_groups: [],
      clients: [{ id: ids.client, workspace_id: w, name: "Acme", active: true, hidden: true, created_at: "2026-01-01" }],
      client_services: [],
      client_assignments: [],
      lead_sources: [],
      seasonality: [],
      demand_settings: [{ workspace_id: w, growth_monthly: 0.01, provenance: {}, created_at: "2026-01-01" }],
      market_conditions: [{ id: ids.presetCond, workspace_id: w, name: "Boom", preset: "boom", churn: 1 }, { id: ids.cond, workspace_id: w, name: "Mine", preset: null, churn: 1, created_at: "2026-01-01" }],
      market_schedule: [{ id: id(), workspace_id: w, condition_id: ids.presetCond, from_month: 1, to_month: 2 }, { id: id(), workspace_id: w, condition_id: ids.cond, from_month: 3, to_month: 4 }],
      churn_drivers: [],
      lever_settings: [{ workspace_id: w, hidden: [], created_at: "2026-01-01" }],
      analysis_rules: [],
    },
    processes,
    scenarios: [
      { id: ids.scnChild, workspace_id: w, name: "Child", description: null, parent_scenario_id: ids.scn, patch: { [`steps.${ids.sA2}.work_hours`]: 3 }, created_at: "2026-01-02" },
      { id: ids.scn, workspace_id: w, name: "Base", description: null, parent_scenario_id: null, patch: {}, created_at: "2026-01-01" },
    ],
    solutions: [{ id: ids.sol, workspace_id: w }],
    solution_issues: [],
    blocks: [{ id: ids.blk, workspace_id: w, name: "Block", description: null, type: "x", steps: [], created_at: "2026-01-01" }],
    issues: [
      { id: ids.issueDone, workspace_id: w, number: 2, title: "Later", status: "open", source: "manual", created_at: "2026-02-01", detected_key: null, links: [], owner_ids: [], source_ids: [], events: [{ id: ids.ev1, workspace_id: w }], dismissed_revision_id: ids.revA1, resolved_solution_id: ids.sol, process_id: null, step_id: null },
      { id: ids.issue, workspace_id: w, number: 1, title: "First", status: "open", source: "manual", created_at: "2026-01-01", detected_key: `perception_gap:step:${ids.sA2}.work_hours`, links: [{ process_id: ids.pA, step_id: ids.sA2 }, { process_id: id(), step_id: null }], owner_ids: [ids.person], source_ids: [ids.src, id()], events: [], process_id: ids.pA, step_id: ids.sA2, person_id: id() },
      { id: ids.issueDet, workspace_id: w, number: null, title: "Seen", status: "open", source: "detected", created_at: "2026-01-01", links: [], owner_ids: [], source_ids: [], events: [] },
    ],
    sources: [
      { id: ids.src, workspace_id: w, kind: "notes", title: "Call", body: `we met ${FREE_UUID}`, file_path: null, created_at: "2026-01-01" },
      { id: ids.srcFile, workspace_id: w, kind: "data", title: "Sheet", body: "t", file_path: "w/x.pdf", file_name: "x.pdf", file_type: "pdf", file_size: 5, created_at: "2026-01-02" },
    ],
    source_links: [
      { id: id(), workspace_id: w, source_id: ids.src, kind: "step", process_id: ids.pA, step_id: ids.sA2, insight_key: null },
      { id: id(), workspace_id: w, source_id: ids.src, kind: "step", process_id: ids.pA, step_id: id(), insight_key: null },
      { id: id(), workspace_id: w, source_id: ids.src, kind: "insight", process_id: ids.pA, step_id: null, insight_key: `perception_gap:step:${ids.sA2}.work_hours` },
      { id: id(), workspace_id: w, source_id: ids.src, kind: "solution", solution_id: ids.sol },
    ],
    suggestions: [
      { id: ids.sugg, workspace_id: w, status: "pending", target_table: "steps", target_id: ids.sA2, patch: { set: { name: "z" } }, created_at: "2026-01-01", reviewed_by: "u" },
      { id: ids.suggDone, workspace_id: w, status: "accepted", target_table: "steps", target_id: ids.sA2, patch: {} },
    ],
    suggestion_proposals: [
      { id: ids.prop, workspace_id: w, status: "pending", kind: "solution_idea", title: "t", issue_id: ids.issue, payload: {}, created_at: "2026-01-01" },
      { id: ids.propDone, workspace_id: w, status: "rejected", kind: "x", title: "t", issue_id: null },
    ],
    counts: {},
  } as unknown as WorkspaceBundle;
  return { bundle: recount(bundle), ids };
}

function recount(b: WorkspaceBundle): WorkspaceBundle {
  const counts: Record<string, number> = {};
  for (const [k, rows] of Object.entries(b.company_model)) counts[`company_model.${k}`] = rows.length;
  const versions = b.processes.flatMap((p) => p.versions as Row[]);
  counts.processes = b.processes.length;
  counts.process_versions = versions.length;
  counts.steps = versions.reduce((n, v) => n + (v.steps as Row[]).length, 0);
  counts.edges = versions.reduce((n, v) => n + (v.edges as Row[]).length, 0);
  for (const k of ["scenarios", "solutions", "solution_issues", "blocks", "issues", "sources", "source_links", "suggestions", "suggestion_proposals"] as const) counts[k] = b[k].length;
  return { ...b, counts };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const planOf = (b: WorkspaceBundle, canManage = true) => planWorkspaceImport(b, { canManage });
const keysDeep = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
};

describe("checkWorkspaceBundle: what is refused, in order", () => {
  it("accepts a good backup", () => {
    const c = checkWorkspaceBundle(clone(makeBundle().bundle));
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it("1. refuses what isn't an object", () => {
    for (const v of [null, "x", 3, [], undefined]) {
      const c = checkWorkspaceBundle(v);
      expect(c.ok).toBe(false);
      expect(c.errors).toEqual(["This isn't a Transpera Flow workspace backup. Choose the .json file that Export → JSON backup made."]);
    }
  });

  it("2. says a process file is a process file", () => {
    for (const f of ["transpera-process/1", "transpera-process/2"]) {
      expect(checkWorkspaceBundle({ format: f }).errors).toEqual(["This is a process file, not a workspace backup. Upload it from Processes → Upload process."]);
    }
  });

  it("3. refuses an unknown workspace version, with a clear error", () => {
    const c = checkWorkspaceBundle({ ...makeBundle().bundle, format: "transpera-workspace/2" });
    expect(c.ok).toBe(false);
    expect(c.errors).toEqual(["This backup is in a format this version of Transpera Flow can't read (transpera-workspace/2). It may have been made by a newer version."]);
  });

  it("4. treats any other or missing format as not a backup", () => {
    const first = checkWorkspaceBundle({ format: "something" }).errors;
    expect(first[0]).toMatch(/^This isn't a Transpera Flow workspace backup/);
    expect(checkWorkspaceBundle({}).errors).toEqual(first);
  });

  it("5. names what is damaged", () => {
    const damage = (f: (b: Row) => void): string => {
      const b = clone(makeBundle().bundle) as unknown as Row;
      f(b);
      const c = checkWorkspaceBundle(b);
      expect(c.ok).toBe(false);
      expect(c.errors).toHaveLength(1);
      return c.errors[0]!;
    };
    expect(damage((b) => ((b.workspace as Row).id = "nope"))).toBe("The backup is damaged: the workspace has no id, so nothing was restored.");
    expect(damage((b) => (b.company_model = []))).toMatch(/^The backup is damaged: the company model is missing/);
    expect(damage((b) => (b.issues = {}))).toMatch(/^The backup is damaged: issues isn't a list/);
    expect(damage((b) => delete (b.processes as Row[])[0]!.versions)).toMatch(/no list of versions/);
    expect(damage((b) => ((b.sources as Row[])[0]!.id = "x"))).toMatch(/a row of sources has no valid id/);
    expect(damage((b) => ((b.sources as Row[])[1]!.id = (b.sources as Row[])[0]!.id))).toMatch(/an id repeats in sources/);
    const dupStep = damage((b) => {
      const v = ((b.processes as Row[])[1]!.versions as Row[])[1]!;
      (v.steps as Row[])[1]!.id = (v.steps as Row[])[0]!.id;
    });
    expect(dupStep).toMatch(/an id repeats in the steps of a version/);
    expect(damage((b) => ((b.processes as Row[])[0]!.parent_process_id = (b.processes as Row[])[0]!.id))).toMatch(/nested in a loop/);
  });

  it("lets step ids repeat across versions", () => {
    const b = makeBundle().bundle;
    const a = b.processes.find((p) => p.name === "Alpha")!;
    const ids = (a.versions as Row[]).map((v) => (v.steps as Row[]).map((s) => s.id));
    expect(ids[0]![0]).toBe(ids[1]![0]);
    expect(checkWorkspaceBundle(clone(b)).ok).toBe(true);
  });

  it("6. refuses rows of another workspace", () => {
    const b = clone(makeBundle().bundle);
    (b.sources[0] as Row).workspace_id = id();
    expect(checkWorkspaceBundle(b).errors).toContain("The backup mixes rows from more than one workspace.");
  });

  it("7. refuses counts that disagree", () => {
    const b = clone(makeBundle().bundle);
    b.counts.steps = 99;
    b.counts["company_model.people"] = 0;
    const c = checkWorkspaceBundle(b);
    expect(c.errors).toContain("The backup looks cut short or edited: it says 99 steps but holds 6.");
    expect(c.errors).toContain("The backup looks cut short or edited: it says 0 people but holds 1.");
  });

  it("8. warns when there is no company map, and refuses two", () => {
    const b = clone(makeBundle().bundle);
    b.processes = b.processes.filter((p) => !p.is_company);
    const none = checkWorkspaceBundle(recount(b));
    expect(none.ok).toBe(true);
    expect(none.warnings).toContain("No company map in the backup; the new one is laid out from the processes.");
    const two = clone(makeBundle().bundle);
    two.processes.push({ ...clone(two.processes[3]!), id: id(), versions: [] });
    const c = checkWorkspaceBundle(recount(two));
    expect(c.ok).toBe(false);
    expect(c.errors.join(" ")).toContain("more than one company map");
  });

  it("10. warns about engine version, a viewer's backup and everything left out, with counts", () => {
    const b = clone(makeBundle().bundle);
    b.engine_version = "0.0.1";
    b.scope = "published";
    const c = checkWorkspaceBundle(b);
    expect(c.ok).toBe(true);
    expect(c.warnings).toContain(`This backup was made with engine 0.0.1; this is ${ENGINE_VERSION}. Numbers may differ slightly.`);
    expect(c.warnings).toContain("This backup was made by a viewer: it has no drafts and no pending suggestions.");
    expect(c.warnings).toContain("Stays in the file: 2 solutions and their links.");
    expect(c.warnings).toContain("Stays in the file: 2 decided suggestions and proposals.");
    expect(c.warnings).toContain("Stays in the file: 1 detected insights (they show again until dismissed).");
    expect(c.warnings).toContain("Stays in the file: 1 unpublished drafts.");
    expect(c.warnings).toContain("Stays in the file: 1 source links to steps no longer in the process.");
    expect(c.warnings).toContain("Stays in the file: 1 issue history entries.");
    expect(c.warnings).toContain("Stays in the file: 1 source file originals (the text is restored).");
  });

  it("accepts a viewer's backup (scope published)", () => {
    const b = clone(makeBundle().bundle);
    b.scope = "published";
    expect(checkWorkspaceBundle(b).ok).toBe(true);
  });
});

describe("checkWorkspaceBundle: limits", () => {
  const L = WORKSPACE_IMPORT_LIMITS;
  const filler = (n: number, make: () => Row): Row[] => Array.from({ length: n }, make);
  const run = (add: (b: WorkspaceBundle, n: number) => void, n: number) => {
    const b = clone(makeBundle().bundle);
    add(b, n);
    return checkWorkspaceBundle(recount(b));
  };
  const cases: { name: string; max: number; add: (b: WorkspaceBundle, n: number) => void; message: string }[] = [
    // The fixture already holds 2 issues that restore (and 1 detection), 1 person, 1 client, 2 scenarios, 1 block, 2 sources, 1 pending suggestion and 1 pending proposal.
    { name: "issues", max: L.issues, add: (b, n) => b.issues.push(...filler(n - 2, () => ({ id: id(), workspace_id: b.workspace.id, number: null, source: "manual", status: "open", links: [], owner_ids: [], source_ids: [], events: [] }))), message: "The backup has 2,001 issues; a restore takes at most 2,000." },
    { name: "people", max: L.people, add: (b, n) => b.company_model.people!.push(...filler(n - 1, () => ({ id: id(), workspace_id: b.workspace.id }))), message: "The backup has 1,001 people; a restore takes at most 1,000." },
    { name: "clients", max: L.clients, add: (b, n) => b.company_model.clients!.push(...filler(n - 1, () => ({ id: id(), workspace_id: b.workspace.id }))), message: "The backup has 5,001 clients; a restore takes at most 5,000." },
    { name: "scenarios", max: L.scenarios, add: (b, n) => b.scenarios.push(...filler(n - 2, () => ({ id: id(), workspace_id: b.workspace.id, parent_scenario_id: null }))), message: "The backup has 501 scenarios; a restore takes at most 500." },
    { name: "blocks", max: L.blocks, add: (b, n) => b.blocks.push(...filler(n - 1, () => ({ id: id(), workspace_id: b.workspace.id }))), message: "The backup has 501 blocks; a restore takes at most 500." },
    { name: "sources", max: L.sources, add: (b, n) => b.sources.push(...filler(n - 2, () => ({ id: id(), workspace_id: b.workspace.id, body: "" }))), message: "The backup has 301 sources; a restore takes at most 300." },
    { name: "suggestions", max: L.suggestions, add: (b, n) => b.suggestions.push(...filler(n - 1, () => ({ id: id(), workspace_id: b.workspace.id, status: "pending", target_id: null }))), message: "The backup has 1,001 pending suggestions; a restore takes at most 1,000." },
    { name: "proposals", max: L.proposals, add: (b, n) => b.suggestion_proposals.push(...filler(n - 1, () => ({ id: id(), workspace_id: b.workspace.id, status: "pending", issue_id: null }))), message: "The backup has 501 pending proposals; a restore takes at most 500." },
    {
      name: "processes",
      max: L.processes,
      add: (b, n) => {
        // The fixture restores 3 processes.
        for (let i = 0; i < n - 3; i++) {
          b.processes.push({ id: id(), name: "p", is_company: false, workspace_id: b.workspace.id, parent_process_id: null, versions: [{ id: id(), live: true, draft: false, steps: [], edges: [], workspace_id: b.workspace.id }] } as Row);
        }
      },
      message: "The backup has 201 processes; a restore takes at most 200.",
    },
  ];
  for (const c of cases) {
    it(`${c.name}: ok at ${c.max}, an error one over`, () => {
      expect(run(c.add, c.max).errors).toEqual([]);
      expect(run(c.add, c.max + 1).errors).toContain(c.message);
    });
  }

  it("steps and edges in the restored versions", () => {
    const build = (steps: number, edges: number) => {
      const b = clone(makeBundle().bundle);
      const v = (b.processes.find((p) => p.name === "Child")!.versions as Row[])[0]!;
      // Alpha's live version restores 2 steps, Beta's draft 1, and Child's own 1 is counted below.
      const target = steps - 3;
      (v.steps as Row[]).push(...Array.from({ length: target - 1 }, () => ({ id: id(), name: "s", workspace_id: b.workspace.id })));
      const all = (v.steps as Row[]).map((s) => s.id);
      (v.edges as Row[]).push(...Array.from({ length: edges }, (_, i) => ({ id: id(), from_step_id: all[0], to_step_id: all[(i % (all.length - 1)) + 1], workspace_id: b.workspace.id })));
      return checkWorkspaceBundle(recount(b));
    };
    expect(build(L.steps, 10).errors).toEqual([]);
    expect(build(L.steps + 1, 10).errors).toContain("The backup has 2,001 steps in the versions it would restore; a restore takes at most 2,000.");
    // Alpha's live version has 1 edge.
    expect(build(10, L.edges - 1).errors).toEqual([]);
    expect(build(10, L.edges).errors).toContain("The backup has 4,001 edges in the versions it would restore; a restore takes at most 4,000.");
  });

  it("source text, in characters", () => {
    const b = clone(makeBundle().bundle);
    (b.sources[0] as Row).body = "x".repeat(L.sourceChars - 1);
    (b.sources[1] as Row).body = "x";
    expect(checkWorkspaceBundle(b).errors).toEqual([]);
    (b.sources[1] as Row).body = "xx";
    expect(checkWorkspaceBundle(b).errors).toContain("The backup has 5,000,001 characters of source text; a restore takes at most 5,000,000.");
  });

  it("the serialised plan", () => {
    const b = clone(makeBundle().bundle);
    (b.company_model.roles as Row[])[0]!.provenance = { note: "y".repeat(L.planBytes) };
    expect(checkWorkspaceBundle(b).errors.join(" ")).toMatch(/too big to restore in one go/);
  });
});

describe("planWorkspaceImport", () => {
  it("keeps the order of ids: placeholders sort as the old ids did", () => {
    const { bundle } = makeBundle();
    const { plan, placeholderOf } = planOf(bundle);
    expect(placeholderOf.size).toBeGreaterThan(30);
    expect(new Set(placeholderOf.values()).size).toBe(placeholderOf.size);
    const old = [...placeholderOf.keys()].sort();
    const mapped = old.map((k) => placeholderOf.get(k)!);
    expect(mapped).toEqual([...mapped].sort());
    // Per table: the old ids in the bundle, sorted and mapped, equal the plan's ids sorted.
    const same = (a: Row[], b: Row[]) => expect(a.map((r) => placeholderOf.get(String(r.id))).sort()).toEqual(b.map((r) => r.id as string).sort());
    same(bundle.company_model.people!, plan.people);
    same(bundle.company_model.roles!, plan.roles);
    same(bundle.sources, plan.sources);
    same(bundle.blocks, plan.blocks);
    same(bundle.scenarios, plan.scenarios);
    same(bundle.issues.filter((i) => i.source !== "detected"), plan.issues);
    // Order across tables too: a smaller old id always has a smaller placeholder.
    const people = bundle.company_model.people![0]!.id as string;
    const role = bundle.company_model.roles![0]!.id as string;
    expect(people < role).toBe(placeholderOf.get(people)! < placeholderOf.get(role)!);
    const stepIds = [...new Set(bundle.processes.flatMap((p) => (p.versions as Row[]).flatMap((v) => (v.steps as Row[]).map((s) => String(s.id)))))].sort();
    const m = stepIds.map((s) => placeholderOf.get(s)!);
    expect(m).toEqual([...m].sort());
  });

  it("leaves no id but placeholders in a plan made from this backup, except free text", () => {
    const { plan } = planOf(makeBundle().bundle);
    const found = JSON.stringify(plan).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(found.filter((u) => !u.startsWith(PLACEHOLDER_PREFIX))).toEqual([FREE_UUID]);
  });

  it("maps ids inside strings and JSON: scenario paths, detected keys, insight keys, evidence, replaced_by", () => {
    const { bundle, ids } = makeBundle();
    const { plan, placeholderOf } = planOf(bundle);
    const p = (k: string) => placeholderOf.get(ids[k]!)!;
    expect(plan.scenarios.find((s) => s.name === "Child")!.patch).toEqual({ [`steps.${p("sA2")}.work_hours`]: 3 });
    expect(plan.issues.find((i) => i.title === "First")!.detected_key).toBe(`perception_gap:step:${p("sA2")}.work_hours`);
    expect(plan.source_links.some((l) => l.insight_key === `perception_gap:step:${p("sA2")}.work_hours`)).toBe(true);
    const alpha = plan.processes.find((x) => x.name === "Alpha")!;
    expect(alpha.steps.find((s) => s.name === "a2")!.provenance).toEqual({ name: { evidence: [{ source_id: p("src") }] } });
    expect(alpha.steps.find((s) => s.name === "a1")!.replaced_by).toEqual([p("sA2")]);
  });

  it("leaves free text holding a uuid that isn't a bundle id alone", () => {
    const { plan } = planOf(makeBundle().bundle);
    expect(plan.sources.find((s) => s.title === "Call")!.body).toBe(`we met ${FREE_UUID}`);
  });

  it("drops the hidden flag, emails, file columns and every account key at any depth", () => {
    const { plan } = planOf(makeBundle().bundle);
    expect(plan.clients.some((c) => "hidden" in c)).toBe(false);
    const keys = keysDeep(plan);
    expect(keys.has("email")).toBe(false);
    for (const k of ["file_path", "file_name", "file_type", "file_size", "workspace_id", "created_by", "updated_at", "reviewed_by", "archived_by"]) expect(keys.has(k)).toBe(false);
    expect([...keys].filter((k) => ACCOUNT_KEY.test(k) && k !== "replaced_by")).toEqual([]);
    for (const p of plan.processes) for (const s of [...p.steps, ...p.edges]) expect(s).not.toHaveProperty("created_at");
  });

  it("only sends columns from the allow-lists", () => {
    const { plan } = planOf(makeBundle().bundle);
    const allowed = (rows: Row[], section: keyof typeof IMPORT_COLUMNS, extra: string[] = []) => {
      for (const r of rows) for (const k of Object.keys(r)) expect([...IMPORT_COLUMNS[section], ...extra]).toContain(k);
    };
    allowed(plan.roles, "roles");
    allowed(plan.people, "people");
    allowed(plan.issues, "issues", ["links", "owner_ids", "source_ids"]);
    allowed(plan.sources, "sources");
    allowed(plan.market_schedule, "market_schedule", ["condition_preset"]);
    allowed(plan.processes.flatMap((p) => p.steps), "steps");
    allowed(plan.processes.flatMap((p) => p.edges), "edges");
    allowed(plan.suggestions, "suggestions");
    allowed(plan.proposals, "proposals");
  });

  it("restores the live version, the draft of a never-published process, the archived flag, and not the company map", () => {
    const { bundle, ids } = makeBundle();
    const { plan, summary, placeholderOf } = planOf(bundle);
    const names = plan.processes.map((p) => p.name);
    expect(names).not.toContain("Company");
    expect([...names].sort()).toEqual(["Alpha", "Beta", "Child"]);
    const alpha = plan.processes.find((p) => p.name === "Alpha")!;
    expect(alpha.layout).toEqual({ a: 2 });
    expect(alpha.steps.map((s) => s.name).sort()).toEqual(["a1", "a2"]);
    expect(alpha.edges).toHaveLength(1);
    expect(alpha.archived).toBe(false);
    const beta = plan.processes.find((p) => p.name === "Beta")!;
    expect(beta.archived).toBe(true);
    expect(beta.steps.map((s) => s.name)).toEqual(["b1"]);
    expect(beta.first_principles).toEqual({ job_done: "x" });
    expect(summary.leftOut.find((l) => l.key === "unpublished_drafts")!.count).toBe(1);
    expect(summary.leftOut.find((l) => l.key === "older_versions")!.count).toBe(1);
    expect(placeholderOf.has(ids.pCompany!)).toBe(true);
  });

  it("puts parents before children in processes and scenarios, and issues in number order", () => {
    const { plan } = planOf(makeBundle().bundle);
    const idx = (n: string) => plan.processes.findIndex((p) => p.name === n);
    expect(idx("Alpha")).toBeLessThan(idx("Child"));
    expect(plan.scenarios.map((s) => s.name)).toEqual(["Base", "Child"]);
    expect(plan.issues.map((i) => i.title)).toEqual(["First", "Later"]);
  });

  it("carries the seeded scenario library like any other scenario (the restore skips equal ones)", () => {
    const b = clone(makeBundle().bundle);
    b.scenarios.push({ id: id(), workspace_id: b.workspace.id, name: "Seeded", description: null, parent_scenario_id: null, patch: { x: 1 }, created_at: "2026-01-01" });
    expect(planOf(recount(b)).plan.scenarios.map((s) => s.name)).toContain("Seeded");
  });

  it("applies the left-out rules", () => {
    const { bundle, ids } = makeBundle();
    const { plan, placeholderOf } = planOf(bundle);
    const p = (k: string) => placeholderOf.get(ids[k]!)!;
    expect(plan.issues.map((i) => i.title)).not.toContain("Seen");
    expect(plan.suggestions.map((s) => s.id)).toEqual([p("sugg")]);
    expect(plan.proposals.map((s) => s.id)).toEqual([p("prop")]);
    expect(JSON.stringify(plan)).not.toContain(p("sol"));
    expect(plan.issues.every((i) => !("dismissed_revision_id" in i) && !("resolved_solution_id" in i) && !("events" in i))).toBe(true);
    expect(plan.source_links.map((l) => l.kind).sort()).toEqual(["insight", "step"]);
    const first = plan.issues.find((i) => i.title === "First")!;
    expect(first.links).toEqual([{ process_id: p("pA"), step_id: p("sA2") }]);
    expect(first.owner_ids).toEqual([p("person")]);
    expect(first.source_ids).toEqual([p("src")]);
    expect(first.person_id).toBeNull();
    expect(plan.person_skills).toHaveLength(1);
  });

  it("settings: known keys only, and who writes them", () => {
    const { bundle } = makeBundle();
    const owner = planOf(bundle, true);
    expect(owner.plan.settings).toEqual({ hours_per_week: 40, currency: "GBP" });
    expect(owner.summary.settings).toBe("applied");
    expect(owner.warnings.join(" ")).toContain("mystery_key");
    expect(planOf(bundle, false).summary.settings).toBe("suggested");
  });

  it("market schedule: a preset row names the preset, a custom one its condition; presets are never inserted", () => {
    const { bundle, ids } = makeBundle();
    const { plan, placeholderOf } = planOf(bundle);
    expect(plan.market_conditions.map((c) => c.name)).toEqual(["Mine"]);
    expect(plan.market_schedule.find((r) => r.from_month === 1)).toMatchObject({ condition_preset: "boom" });
    expect(plan.market_schedule.find((r) => r.from_month === 1)).not.toHaveProperty("condition_id");
    expect(plan.market_schedule.find((r) => r.from_month === 3)!.condition_id).toBe(placeholderOf.get(ids.cond!));
  });

  it("does not change the bundle", () => {
    const { bundle } = makeBundle();
    const before = JSON.stringify(bundle);
    planOf(bundle);
    expect(JSON.stringify(bundle)).toBe(before);
  });

  it("summarises what is restored and what stays", () => {
    const { summary } = planOf(makeBundle().bundle);
    expect(summary.restored.find((l) => l.key === "processes")!.count).toBe(3);
    expect(summary.restored.find((l) => l.key === "issues")!.count).toBe(2);
    expect(summary.leftOut.map((l) => l.key)).toEqual(expect.arrayContaining(["solutions", "detections", "decided_suggestions", "history", "file_originals", "step_links", "company_map"]));
  });
});
