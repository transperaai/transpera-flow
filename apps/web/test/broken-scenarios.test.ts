import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { northbeamBundle, northbeamScenarios, northbeamStepIds, toEngineModel, type ProcessBundle, type ScenarioRow } from "@transpera-flow/db";
import { brokenScenarioKey, checkScenario, detectBrokenScenarios, repointPatch } from "@transpera-flow/engine";
import { discardChange } from "@/lib/drafts/discard";
import { diffBundles } from "@/lib/drafts/diff";
import { DraftSession, MemoryDraftBackend } from "@/lib/drafts/session";
import { deleteSteps } from "@/lib/editor/commands";
import { applyEdit, invertEdit } from "@/lib/editor/ops";
import { splitProblem, splitStep } from "@/lib/editor/split";
import { parseNewEdge, parseNewStep } from "@/lib/editor/validate";
import { promoteInput, registerEntries } from "@/lib/issues/register";
import { stepFromRecord } from "@/lib/realtime/rows";
import { newlyBroken, repointTargets, resolveRun, retiredSteps } from "@/lib/scenarios/broken";
import { describePatch, scenarioProblems } from "@/lib/scenarios/scenarios";
import { MemoryScenarioStore } from "@/lib/scenarios/store";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";

// The scenario Server Action runs against a real database (the seeded Northbeam scenarios) as an editor.
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { updateScenarioPatch } = await import("@/app/w/[slug]/scenario-actions");

const ids = northbeamStepIds;
const START = { startDate: "2026-10-05" };
const automate = () => northbeamScenarios().find((s) => s.name === "Automate proposals")!;

/** Northbeam with Audit & proposal split in two, and the split's step ids. */
function splitAudit(bundle: ProcessBundle = northbeamBundle()) {
  let n = 0;
  const r = splitStep(bundle, ids.audit, () => `00000000-0000-4000-8000-00000000aa0${++n}`)!;
  return { bundle: applyEdit(bundle, r.edit), edit: r.edit, parts: r.ids };
}

describe("splitting a step", () => {
  it("retires the old step with replaced_by, and the process still simulates", () => {
    const live = northbeamBundle();
    const { bundle, parts } = splitAudit(live);
    const [a, b] = parts;
    expect(bundle.steps.some((s) => s.id === ids.audit)).toBe(false);
    expect(bundle.retired).toEqual([expect.objectContaining({ id: ids.audit, replaced_by: [a, b], assumption: false })]);
    const [first, second] = [bundle.steps.find((s) => s.id === a)!, bundle.steps.find((s) => s.id === b)!];
    expect([first.name, second.name]).toEqual(["Audit & proposal (part 1)", "Audit & proposal (part 2)"]);
    expect(first.work_hours + second.work_hours).toBeCloseTo(6);
    expect(second.rework_rate).toBe(0.15);
    // In and out go through the halves; the connections keep their ids.
    const into = live.edges.filter((e) => e.to_step_id === ids.audit).map((e) => e.id);
    expect(bundle.edges.filter((e) => e.to_step_id === a).map((e) => e.id)).toEqual(into);
    expect(bundle.edges.some((e) => e.from_step_id === a && e.to_step_id === b && e.probability === 1)).toBe(true);
    const model = toEngineModel(bundle, START);
    expect(model.steps.map((s) => s.id)).toEqual(expect.arrayContaining([a, b]));
    expect(model.steps.some((s) => s.id === ids.audit)).toBe(false);
  });

  it("writes rows the insert Server Action accepts, the retired one with its replaced_by", () => {
    const { edit } = splitAudit();
    const insert = edit.ops.find((op) => op.kind === "insert")!;
    if (insert.kind !== "insert") throw new Error("no insert");
    const parsed = insert.steps.map(parseNewStep);
    expect(parsed.every(Boolean)).toBe(true);
    expect(parsed[2]).toMatchObject({ id: ids.audit, replaced_by: insert.steps.slice(0, 2).map((s) => s.id), assumption: false, conflict: false });
    expect(insert.edges.map(parseNewEdge).every(Boolean)).toBe(true);
  });

  it("undoes exactly, and only splits task and wait steps", () => {
    const live = northbeamBundle();
    const { bundle, edit } = splitAudit(live);
    const back = applyEdit(bundle, invertEdit(edit));
    expect(diffBundles(live, back).list).toEqual([]);
    expect(back.retired).toEqual([]);
    expect(splitProblem(live, ids.start)).toMatch(/Only task and wait steps/);
    expect(splitStep(live, ids.won)).toBeNull();
  });

  it("shows as the old step removed in the draft, and restoring it puts the retired row away", () => {
    const live = northbeamBundle();
    const { bundle } = splitAudit(live);
    expect(diffBundles(live, bundle).steps.get(ids.audit)?.kind).toBe("removed");
    const restored = applyEdit(bundle, discardChange(live, bundle, "steps", ids.audit)!);
    expect(restored.steps.some((s) => s.id === ids.audit)).toBe(true);
    expect(restored.retired).toEqual([]);
  });
});

describe("broken scenarios", () => {
  it("deleting a step a scenario targets marks the scenario needs attention, naming the path and the step", () => {
    const live = northbeamBundle();
    const draft = applyEdit(live, deleteSteps(live, [ids.audit])!);
    // Re-connect what led into the deleted step, so the draft still simulates.
    const model = toEngineModel(
      { ...draft, edges: [...draft.edges, { ...live.edges.find((e) => e.to_step_id === ids.audit)!, id: "00000000-0000-4000-8000-0000000000e1", to_step_id: ids.decision }] },
      START,
    );
    const problems = scenarioProblems(model, automate(), retiredSteps(draft, live));
    expect(problems).toEqual([
      expect.objectContaining({
        path: `steps.${ids.audit}.work_hours`,
        problem: "missing_target",
        targetName: "Audit & proposal",
        replacements: [],
        message: "“Audit & proposal” (hands-on time) was deleted from the process. Re-point this change or remove the scenario.",
      }),
    ]);
  });

  it("splitting a step a scenario targets marks it needs attention and suggests the replacing steps; re-pointing clears it", () => {
    const { bundle, parts } = splitAudit();
    const model = toEngineModel(bundle, START);
    const retired = retiredSteps(bundle);
    const [problem] = scenarioProblems(model, automate(), retired);
    expect(problem).toMatchObject({
      replaced: true,
      replacements: [
        { id: parts[0], name: "Audit & proposal (part 1)" },
        { id: parts[1], name: "Audit & proposal (part 2)" },
      ],
      message: "“Audit & proposal” (hands-on time) was split into Audit & proposal (part 1) and Audit & proposal (part 2). Re-point this change to one of them.",
    });
    expect(describePatch(model, automate().patch[0]!, retired)).toBe("Audit & proposal (removed)'s hands-on time −60%");
    const targets = repointTargets(model, problem!);
    expect(targets.suggested.map((t) => t.id)).toEqual(parts);
    expect(targets.others.map((t) => t.id)).not.toContain(parts[0]);
    expect(targets.others.length).toBeGreaterThan(3);

    const fixed = { ...automate(), patch: repointPatch(automate().patch, 0, parts[1]) };
    expect(scenarioProblems(model, fixed, retired)).toEqual([]);
  });

  it("refuses to run a broken scenario rather than skipping its patch", () => {
    const { bundle } = splitAudit();
    const model = toEngineModel(bundle, START);
    const run = resolveRun(model, [{ path: "demand.leads_per_week", op: "multiply", value: 1.2 }, ...automate().patch], retiredSteps(bundle));
    expect(run).toEqual({ ok: false, error: expect.stringMatching(/^This scenario needs attention and can't be run: 1 of its changes no longer resolves\./) });
    expect(resolveRun(model, [{ path: "demand.leads_per_week", op: "multiply", value: 1.2 }])).toMatchObject({ ok: true });
  });

  it("warns about the scenarios publishing a draft would break", () => {
    const live = northbeamBundle();
    const { bundle } = splitAudit(live);
    const breaks = newlyBroken(toEngineModel(live, START), toEngineModel(bundle, START), northbeamScenarios(), retiredSteps(bundle, live));
    expect(breaks.map((b) => b.scenario.name)).toEqual(["Automate proposals"]);
    expect(newlyBroken(toEngineModel(live, START), toEngineModel(live, START), northbeamScenarios())).toEqual([]);
  });

  it("raises a broken_scenario issue with a stable key, linked to the scenario, and none once fixed", () => {
    const { bundle, parts } = splitAudit();
    const model = toEngineModel(bundle, START);
    const scenarios = northbeamScenarios();
    const detected = detectBrokenScenarios(model, scenarios, retiredSteps(bundle));
    expect(detected.map((d) => [d.key, d.type, d.stepId])).toEqual([[brokenScenarioKey(automate().id), "broken_scenario", parts[0]]]);
    const input = promoteInput(detected[0]!, bundle.process.id, scenarios);
    expect(input).toMatchObject({ detected_key: `broken_scenario:scenario:${automate().id}`, type: "broken_scenario", scenario_id: automate().id });
    expect(registerEntries([], detected).map((e) => e.kind)).toEqual(["detected"]);

    const fixed = scenarios.map((s) => (s.id === automate().id ? { ...s, patch: repointPatch(s.patch, 0, parts[0]) } : s));
    expect(detectBrokenScenarios(model, fixed, retiredSteps(bundle))).toEqual([]);
  });
});

describe("retired rows through the editor, drafts and Realtime", () => {
  it("saves the retired row into the draft, keeps it off the map after a catch-up and a publish, and remembers it", async () => {
    const live = northbeamBundle();
    const backend = new MemoryDraftBackend(live);
    const session = new DraftSession(live, null, backend);
    const editor = session.editor;
    let parts: string[] = [];
    editor.run((b) => {
      const r = splitStep(b, ids.audit);
      parts = r?.ids ?? [];
      return r?.edit ?? null;
    });
    await editor.settled();
    const stored = backend.draftRows()!;
    expect(stored.steps.find((s) => s.id === ids.audit)?.replaced_by).toEqual(parts);
    // A catch-up read brings the stored rows, retired one included: it stays off the map.
    editor.resync(stored);
    expect(editor.getState().bundle.steps.some((s) => s.id === ids.audit)).toBe(false);
    expect(editor.getState().bundle.retired?.map((s) => s.id)).toEqual([ids.audit]);
    await session.publish();
    const published = session.getState().live;
    expect(published.retired?.map((s) => s.id)).toEqual([ids.audit]);
    expect(checkScenario(toEngineModel(published, START), automate().patch, retiredSteps(published)).broken[0]?.replacements.map((r) => r.id)).toEqual(parts);
    // The next draft is copied from live with the retired row, so it is still remembered.
    editor.run((b) => deleteSteps(b, [parts[1]!]));
    await editor.settled();
    expect(backend.draftRows()!.steps.find((s) => s.id === ids.audit)?.replaced_by).toEqual(parts);
  });

  it("files someone else's retired row away instead of drawing it", () => {
    const live = northbeamBundle();
    const session = new DraftSession(live, null, new MemoryDraftBackend(live));
    const old = live.steps.find((s) => s.id === ids.audit)!;
    const record = { ...old, replaced_by: ["00000000-0000-4000-8000-0000000000b1"] } as unknown as Record<string, unknown>;
    const row = stepFromRecord(record)!;
    expect(row.replaced_by).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
    expect(stepFromRecord({ ...record, replaced_by: [] })!.replaced_by).toBeUndefined();
    session.editor.applyRemote({ kind: "upsert", table: "steps", row });
    const bundle = session.editor.getState().bundle;
    expect(bundle.steps.some((s) => s.id === ids.audit)).toBe(false);
    expect(bundle.retired?.map((s) => s.id)).toEqual([ids.audit]);
  });
});

describe("re-pointing a saved scenario", () => {
  let tdb: TestDb;
  let editor: TestUser;
  let viewer: TestUser;
  beforeAll(async () => {
    tdb = await createTestDb();
    editor = await addMember(tdb, northbeamBundle().workspace.id, "editor");
    viewer = await addMember(tdb, northbeamBundle().workspace.id, "viewer");
    signInAs({ tdb }, editor);
  }, 120_000);
  afterAll(async () => {
    await tdb?.close();
  });
  const storedPatch = async (id: string) => (await tdb.client.query("select patch from scenarios where id = $1", [id])).rows[0].patch;

  it("in memory (the demo)", async () => {
    const store = new MemoryScenarioStore("ws");
    const s: ScenarioRow = automate();
    const r = await store.repoint(s, repointPatch(s.patch, 0, "x"));
    expect(r).toEqual({ status: "ok", scenario: { ...s, patch: [{ path: "steps.x.work_hours", op: "multiply", value: 0.4 }] } });
    expect(await store.repoint(s, [])).toMatchObject({ status: "error" });
  });

  it("through the Server Action: checks the patches, then updates the one row", async () => {
    const s = automate();
    signInAs({ tdb }, editor);
    const patch = repointPatch(s.patch, 0, "x");
    expect(await updateScenarioPatch(s.id, patch)).toEqual({ status: "ok", scenario: { ...s, patch } });
    expect(await storedPatch(s.id)).toEqual(patch);
    // Bad input changes nothing.
    expect(await updateScenarioPatch(s.id, [{ path: "nope", op: "set", value: 1 }])).toMatchObject({ status: "error" });
    expect(await updateScenarioPatch("not-an-id", patch)).toMatchObject({ status: "error" });
    expect(await storedPatch(s.id)).toEqual(patch);
    // A viewer's update matches no row.
    signInAs({ tdb }, viewer);
    expect(await updateScenarioPatch(s.id, s.patch)).toMatchObject({ status: "error", message: expect.stringMatching(/permission/) });
    expect(await storedPatch(s.id)).toEqual(patch);
    signOut({ tdb });
    expect(await updateScenarioPatch(s.id, patch)).toMatchObject({ status: "error", message: expect.stringMatching(/Sign in/) });
  });
});
