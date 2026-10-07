import { beforeEach, describe, expect, it, vi } from "vitest";
import { northbeamBundle, northbeamRoleIds, northbeamScenarios, northbeamServiceIds, northbeamStepIds, toEngineModel, type ScenarioRow } from "@transpera-flow/db";
import { applyPatches, simulate } from "@transpera-flow/engine";
import { buildLevers, leverPatches, neutral } from "@/lib/scenarios/levers";
import { copyName, describePatch, effectivePatches, headlineSubject, scenarioProblems } from "@/lib/scenarios/scenarios";
import { MemoryScenarioStore } from "@/lib/scenarios/store";
import { parseScenarioInput } from "@/lib/scenarios/validate";

// A stand-in for Supabase behind the scenario Server Actions: records what
// reaches the database, so the tests can show malformed input never does.
const db = vi.hoisted(() => ({ calls: [] as { op: string; args: unknown[] }[], signedIn: true, result: { data: null as unknown, error: null as unknown } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain = {
      insert: (...args: unknown[]) => (db.calls.push({ op: "insert", args }), chain),
      delete: () => (db.calls.push({ op: "delete", args: [] }), chain),
      eq: (...args: unknown[]) => (db.calls.push({ op: "eq", args }), chain),
      select: () => chain,
      single: async () => db.result,
      then: (resolve: (v: unknown) => void) => resolve(db.result),
    };
    return {
      auth: { getClaims: async () => ({ data: db.signedIn ? { claims: { sub: "u1" } } : null }) },
      from: (table: string) => (db.calls.push({ op: "from", args: [table] }), chain),
    };
  },
}));
const { createScenario, deleteScenario } = await import("@/app/w/[slug]/scenario-actions");

const START = { startDate: "2026-10-05" };
const model = () => toEngineModel(northbeamBundle(), START);
const WS = northbeamBundle().workspace.id;
const valid = { name: " Automate proposals ", description: "  ", patch: [{ path: "steps.x.work_hours", op: "multiply", value: 0.4 }] };

describe("levers are generated from the model", () => {
  const levers = buildLevers(model());
  const byPath = (p: string) => levers.find((l) => l.path === p)!;

  it("covers demand, head-count per role, FTE per person, each step's time, wait and rework, and each service's price", () => {
    expect(byPath("demand.leads_per_week")).toMatchObject({ group: "demand", op: "set", base: 7 });
    expect(byPath(`roles.${northbeamRoleIds.strat}.headcount`)).toMatchObject({ group: "people", op: "set", base: 1, label: "Strategist" });
    expect(levers.filter((l) => l.path.startsWith("people.")).map((l) => [l.label, l.base])).toContainEqual(["Maya Collins", 1]);
    expect(levers.filter((l) => l.path.startsWith("people."))).toHaveLength(11);
    // Northbeam sells SEO and PPC (#12), so prices are per service, not the single retainer.
    expect(byPath(`services.${northbeamServiceIds.seo}.price`)).toMatchObject({ group: "finances", op: "set", base: 3500, label: "SEO retainer" });
    expect(byPath(`services.${northbeamServiceIds.ppc}.price`)).toMatchObject({ group: "finances", op: "set", base: 4200 });
    expect(levers.find((l) => l.path === "finances.retainer")).toBeUndefined();
  });

  it("makes process parameters relative, except those at 0 (a relative lever on 0 would do nothing)", () => {
    const audit = northbeamStepIds.audit;
    expect(byPath(`steps.${audit}.work_hours`)).toMatchObject({ op: "multiply", base: 6, min: 0.1, max: 2 });
    expect(byPath(`steps.${audit}.rework_rate`)).toMatchObject({ op: "multiply", base: 0.15 });
    expect(byPath(`steps.${audit}.wait_hours`)).toMatchObject({ op: "set", base: 0 });
    // The client-decision wait has no one working it: a wait lever only.
    expect(levers.filter((l) => l.path.startsWith(`steps.${northbeamStepIds.decision}.`)).map((l) => l.label)).toEqual(["Wait"]);
  });

  it("turns moved levers into patches, and leaves neutral ones out", () => {
    const work = `steps.${northbeamStepIds.audit}.work_hours`;
    const values = { [work]: 0.6, "demand.leads_per_week": 7, [`roles.${northbeamRoleIds.strat}.headcount`]: 2 };
    expect(leverPatches(levers, values)).toEqual([
      { path: `roles.${northbeamRoleIds.strat}.headcount`, op: "set", value: 2 },
      { path: work, op: "multiply", value: 0.6 },
    ]);
    expect(levers.every((l) => leverPatches([l], { [l.path]: neutral(l) }).length === 0)).toBe(true);
    // Every lever's patch applies to the model it came from.
    const all = Object.fromEntries(levers.map((l) => [l.path, l.op === "multiply" ? 0.5 : l.base + l.step]));
    expect(applyPatches(model(), leverPatches(levers, all)).issues.filter((i) => i.problem !== "clamped")).toEqual([]);
  });

  // Re-running after a lever move: warm up on a patched model, then the best of 3 re-runs, each rebuilding the levers and patches.
  const rerunBest = (base: () => ReturnType<typeof model>) => {
    const patched = applyPatches(base(), [{ path: `steps.${northbeamStepIds.audit}.work_hours`, op: "multiply", value: 0.5 }]).model;
    simulate(patched, 30, 1);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      simulate(applyPatches(base(), leverPatches(buildLevers(base()), { "demand.leads_per_week": 8 + i })).model, 30, 1);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };

  it("re-running a pipeline-only Northbeam after a lever move stays within the PRD §6.7 target (< 150 ms for 30 replications)", { tags: ["perf"] }, () => {
    // The seeded bundle without its servicing processes and links: the pipeline model §6.7's first target describes.
    const pipelineOnly = () => {
      const b = northbeamBundle();
      return toEngineModel({ ...b, servicingLinks: [], otherProcesses: (b.otherProcesses ?? []).filter((p) => p.process.kind !== "servicing") }, START);
    };
    expect(pipelineOnly().servicingProcesses).toBeUndefined();
    expect(rerunBest(pipelineOnly)).toBeLessThan(150);
  });

  it("re-running the full seeded Northbeam (client groups and servicing, as the app runs it) after a lever move stays within its PRD §6.7 target (< 250 ms for 30 replications)", { tags: ["perf"] }, () => {
    expect(model().servicingProcesses).toBeDefined();
    expect(model().clientGroups).toBeDefined();
    expect(model().clients).toBeUndefined();
    expect(rerunBest(model)).toBeLessThan(250);
  });

  it("re-running the full seeded Northbeam with per-person times (every person 0.9, two step factors; C6) stays within the same target", { tags: ["perf"] }, () => {
    const factored = () => {
      const m = model();
      const steps = [northbeamStepIds.audit, northbeamStepIds.discovery];
      return {
        ...m,
        people: Object.fromEntries(
          Object.entries(m.people!).map(([id, p]) => [id, { ...p, capacityFactor: { default: 0.9, steps: Object.fromEntries(steps.map((s, i) => [s, 0.8 + i * 0.3])) } }]),
        ),
      };
    };
    expect(Object.values(factored().people!).every((p) => p.capacityFactor?.default === 0.9)).toBe(true);
    expect(rerunBest(factored)).toBeLessThan(250);
  });

  it("re-running Northbeam with its named client roster and servicing stays within the same target", { tags: ["perf"] }, () => {
    const named = () => toEngineModel({ ...northbeamBundle(), clientGroups: [] }, START);
    expect(named().clients).toBeDefined();
    expect(rerunBest(named)).toBeLessThan(250);
  });
});

describe("saved scenarios in the panel", () => {
  const [hire, automate] = northbeamScenarios() as [ScenarioRow, ScenarioRow];
  const broken: ScenarioRow = { ...hire, id: "x", name: "Old step", patch: [{ path: "steps.deleted.work_hours", op: "multiply", value: 0.5 }] };

  it("describes patches in words", () => {
    expect(describePatch(model(), hire.patch[0]!)).toBe("Strategist's head-count +1");
    expect(describePatch(model(), automate.patch[0]!)).toBe("Audit & proposal's hands-on time −60%");
    expect(describePatch(model(), { path: "demand.leads_per_week", op: "set", value: 10 })).toBe("Leads per week → 10");
    expect(describePatch(model(), { path: "steps.@heaviest.work_hours", op: "multiply", value: 0.4 })).toBe("The heaviest step's hands-on time −60%");
    expect(describePatch(model(), broken.patch[0]!)).toBe("A removed item's hands-on time −50%");
  });

  it("flags a scenario whose target is gone and leaves it out, keeping the stack's order", () => {
    expect(scenarioProblems(model(), hire)).toEqual([]);
    expect(scenarioProblems(model(), broken)).toMatchObject([{ problem: "missing_target" }]);
    const levers = [{ path: "demand.leads_per_week", op: "set" as const, value: 9 }];
    expect(effectivePatches(model(), [automate, broken, hire], levers)).toEqual([...automate.patch, ...hire.patch, ...levers]);
  });

  it("names the headline's subject", () => {
    expect(headlineSubject(["Hire a strategist"], false)).toEqual({ subject: "“Hire a strategist”", plural: false });
    expect(headlineSubject(["A", "B"], false)).toEqual({ subject: "“A” + “B”", plural: true });
    expect(headlineSubject(["A"], true)).toEqual({ subject: "“A” plus lever changes", plural: true });
    expect(headlineSubject([], true)).toEqual({ subject: "These lever changes", plural: true });
  });

  it("names copies", () => {
    expect(copyName("A", ["A"])).toBe("A (copy)");
    expect(copyName("A", ["A", "A (copy)", "A (copy 2)"])).toBe("A (copy 3)");
  });

  it("the demo store saves valid scenarios in memory", async () => {
    const store = new MemoryScenarioStore(WS);
    const r = await store.create({ name: "X", description: null, patch: hire.patch, parent_scenario_id: null });
    expect(r).toMatchObject({ status: "ok", scenario: { name: "X", workspace_id: WS, patch: hire.patch } });
    expect(await store.create({ name: "", description: null, patch: hire.patch, parent_scenario_id: null })).toMatchObject({ status: "error" });
  });
});

describe("parseScenarioInput", () => {
  it("trims the name, blanks an empty description and keeps the patches", () => {
    expect(parseScenarioInput(valid)).toEqual({
      ok: true,
      value: { name: "Automate proposals", description: null, patch: valid.patch, parent_scenario_id: null },
    });
    expect(parseScenarioInput({ ...valid, parent_scenario_id: northbeamScenarios()[0]!.id })).toMatchObject({ ok: true });
  });

  it("rejects malformed input", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      { ...valid, name: "  " },
      { ...valid, name: 3 },
      { ...valid, name: "x".repeat(121) },
      { ...valid, description: 5 },
      { ...valid, description: "x".repeat(2001) },
      { ...valid, patch: [] },
      { ...valid, patch: "[]" },
      { ...valid, patch: [{ path: "steps.x.colour", op: "set", value: 1 }] },
      { ...valid, patch: [{ path: "steps.x.work_hours", op: "set", value: "1" }] },
      { ...valid, parent_scenario_id: "not-a-uuid" },
    ];
    for (const input of bad) expect(parseScenarioInput(input).ok, JSON.stringify(input)?.slice(0, 60)).toBe(false);
  });
});

describe("scenario Server Actions", () => {
  beforeEach(() => {
    db.calls = [];
    db.signedIn = true;
    db.result = { data: null, error: null };
  });

  it("reject malformed input before touching the database", async () => {
    expect(await createScenario("not-a-uuid", valid)).toMatchObject({ status: "error" });
    expect(await createScenario(WS, { ...valid, patch: [{ path: "nope", op: "set", value: 1 }] })).toMatchObject({ status: "error" });
    expect(await createScenario(WS, { ...valid, name: "" })).toEqual({ status: "error", message: "Give the scenario a name." });
    expect(await deleteScenario("x")).toMatchObject({ status: "error" });
    expect(db.calls).toEqual([]);
  });

  it("refuse a signed-out user", async () => {
    db.signedIn = false;
    expect(await createScenario(WS, valid)).toEqual({ status: "error", message: "Your session has ended. Sign in again." });
    expect(db.calls).toEqual([]);
  });

  it("insert the parsed scenario into the given workspace as the user", async () => {
    const row = { id: "s1", workspace_id: WS, name: "Automate proposals", description: null, patch: valid.patch, parent_scenario_id: null };
    db.result = { data: row, error: null };
    expect(await createScenario(WS, { ...valid, workspace_id: "someone-elses", id: "forged" })).toEqual({ status: "ok", scenario: row });
    expect(db.calls[0]).toEqual({ op: "from", args: ["scenarios"] });
    expect(db.calls[1]).toEqual({
      op: "insert",
      args: [{ name: "Automate proposals", description: null, patch: valid.patch, parent_scenario_id: null, workspace_id: WS }],
    });
  });

  it("turn RLS refusals into a sentence", async () => {
    db.result = { data: null, error: { code: "42501" } };
    expect(await createScenario(WS, valid)).toEqual({ status: "error", message: "You don't have permission to change scenarios here." });
    // A delete RLS filters out removes nothing.
    db.result = { data: [], error: null };
    expect(await deleteScenario(northbeamScenarios()[0]!.id)).toEqual({ status: "error", message: "You don't have permission to change scenarios here." });
  });
});
