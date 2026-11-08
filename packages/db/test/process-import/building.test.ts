import { describe, expect, it } from "vitest";
import { checklistItems, openConflict, type EdgeRow, type StepRow } from "../../src";
import {
  buildNewStep,
  buildStepChange,
  connectionProblem,
  graphWarnings,
  normalizeName,
  planImport,
  PROPOSED_BY,
  resolveName,
  revisionDiff,
  type Graph,
  type ImportInput,
} from "../../src/process-import/building";
import { ImportError } from "../../src/process-import/errors";
import { PROCESS_TEMPLATES } from "../../src/process-import/templates";

const owner = { revision_id: "r0000000-0000-4000-8000-000000000001", workspace_id: "w1", process_id: "p1" };
const stamp = { at: "2026-10-13T09:00:00.000Z", by: "u0000000-0000-4000-8000-000000000001" };
const SOURCE = "50000000-0000-4000-8000-000000000001";
const SOURCE2 = "50000000-0000-4000-8000-000000000002";

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function step(over: Partial<StepRow> & { id: string; name: string }): StepRow {
  return {
    ...owner,
    kind: "task",
    outcome: null,
    role_id: null,
    person_id: null,
    work_hours: 1,
    work_dist: "lognormal",
    work_params: {},
    wait_hours: 0,
    wait_dist: "lognormal",
    wait_params: {},
    rework_rate: 0,
    rework_to_step_id: null,
    tool: null,
    purpose: null,
    split: null,
    split_notes: null,
    tier_multiplier: null,
    to_client_manager: false,
    notes: null,
    sla_hours: null,
    expected_wait_hours: null,
    lost_per_day_waiting: null,
    dropoff_benchmark: null,
    target_cycle_hours: null,
    current_wip: null,
    parent_step_id: null,
    entry_step_id: null,
    child_process_id: null,
    x: 0,
    y: 0,
    assumption: false,
    conflict: false,
    provenance: {},
    replaced_by: [],
    ...over,
  };
}

const edge = (id: string, from: string, to: string, probability = 1): EdgeRow => ({
  id,
  ...owner,
  from_step_id: from,
  to_step_id: to,
  probability,
  condition_tag: null,
  label: null,
});

const errorOf = (fn: () => unknown): ImportError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ImportError) return err;
    throw err;
  }
  throw new Error("expected a ImportError");
};

describe("resolveName", () => {
  const items = [
    { id: "a1", name: "Audit & proposal" },
    { id: "a2", name: "Proposal review" },
    { id: "a3", name: "Discovery call" },
  ];
  it("finds by id, exact name, name without punctuation, a unique part, or words in any order", () => {
    expect(resolveName(items, "a3", "step").id).toBe("a3");
    expect(resolveName(items, "discovery CALL", "step").id).toBe("a3");
    expect(resolveName(items, "audit and proposal", "step").id).toBe("a1");
    expect(resolveName(items, "discov", "step").id).toBe("a3");
    expect(resolveName(items, "review proposal", "step").id).toBe("a2");
    expect(normalizeName("Audit & Proposal!")).toBe("audit and proposal");
  });
  it("returns candidates instead of guessing when a name is ambiguous", () => {
    const err = errorOf(() => resolveName(items, "proposal", "step"));
    expect(err.code).toBe("ambiguous");
    expect(err.candidates).toEqual([
      { id: "a1", name: "Audit & proposal" },
      { id: "a2", name: "Proposal review" },
    ]);
  });
  it("says what exists when nothing matches, and strict mode never matches a part", () => {
    const err = errorOf(() => resolveName(items, "invoice", "step"));
    expect(err.code).toBe("not_found");
    expect(err.candidates).toHaveLength(3);
    expect(errorOf(() => resolveName(items, "discov", "step", "", { strict: true })).code).toBe("not_found");
  });
});

describe("buildNewStep", () => {
  it("defaults omitted parameters as estimated assumptions and lists them", () => {
    const { row, assumptions } = buildNewStep("s1", { name: "Draft brief" }, owner, stamp, { outcome: "won" });
    expect(row).toMatchObject({ kind: "task", work_hours: 1, wait_hours: 0, rework_rate: 0, assumption: true, conflict: false });
    for (const col of ["work_hours", "wait_hours", "rework_rate"]) {
      expect(row.provenance[col]).toMatchObject({ source: "estimated", assumption: true, at: stamp.at, by: stamp.by });
    }
    expect(row.provenance.sla_hours).toBeUndefined();
    expect(assumptions).toEqual([
      "Step 'Draft brief': work_hours defaulted to 1 h (estimated; confirm it on the canvas).",
      "Step 'Draft brief': wait_hours defaulted to 0 h (estimated; confirm it on the canvas).",
      "Step 'Draft brief': rework_rate defaulted to 0% (estimated; confirm it on the canvas).",
    ]);
    // The canvas's checklist rail shows each as an assumption.
    expect(checklistItems([row]).map((i) => [i.kind, i.column])).toEqual([
      ["assumption", "work_hours"],
      ["assumption", "wait_hours"],
      ["assumption", "rework_rate"],
    ]);
  });

  it("cites evidence, takes the stated value, and keeps reasoning for uncited values", () => {
    const { row, assumptions } = buildNewStep(
      "s1",
      {
        name: "Audit",
        work_hours: 5,
        wait_hours: 24,
        rework_rate: 0.1,
        reasoning: { wait_hours: "Usually waits a day for the strategist." },
        evidence: [{ field: "work_hours", source_id: SOURCE, speaker: "Maya", quote: "call it six hours", timestamp: "00:14:05", value: 6 }],
      },
      owner,
      stamp,
      { outcome: "won" },
    );
    expect(row.work_hours).toBe(6);
    expect(row.provenance.work_hours).toMatchObject({
      source: "estimated",
      assumption: true,
      evidence: [{ source_id: SOURCE, speaker: "Maya", quote: "call it six hours", timestamp: "00:14:05", value: 6 }],
    });
    expect(row.provenance.wait_hours).toMatchObject({ assumption: true, note: "Usually waits a day for the strategist." });
    expect(assumptions.join("\n")).toMatch(/wait_hours 24 h has no cited source; marked as an assumption \(Usually waits/);
    expect(assumptions.join("\n")).not.toMatch(/work_hours/);
  });

  it("turns disagreeing sources into a triangular range and a conflict", () => {
    const { row, conflicts } = buildNewStep(
      "s1",
      {
        name: "Audit",
        evidence: [
          { field: "work_hours", source_id: SOURCE, speaker: "Maya", quote: "six hours", value: 6 },
          { field: "work_hours", source_id: SOURCE, speaker: "Rosa", quote: "more like twelve", value: 12 },
        ],
      },
      owner,
      stamp,
      { outcome: "won" },
    );
    expect(row).toMatchObject({ work_dist: "triangular", work_params: { min: 6, mode: 9, max: 12 }, work_hours: 9, conflict: true });
    expect(conflicts).toEqual([expect.objectContaining({ field: "work_hours", text: "Audit: hands-on time is in conflict (Maya: 6 h; Rosa: 12 h)." })]);
  });

  it("gives end steps an outcome, and refuses an outcome on another kind", () => {
    expect(buildNewStep("e", { name: "Lost", kind: "end" }, owner, stamp, { outcome: "lost" })).toMatchObject({
      row: { outcome: "lost", assumption: false },
      assumptions: ["Step 'Lost': outcome defaulted to lost."],
    });
    expect(buildNewStep("e", { name: "Won", outcome: "won" }, owner, stamp, { outcome: "lost" }).row.kind).toBe("end");
    expect(errorOf(() => buildNewStep("x", { name: "X", kind: "task", outcome: "won" }, owner, stamp, { outcome: "won" })).code).toBe("invalid_input");
  });

  it("validates like the editor", () => {
    expect(errorOf(() => buildNewStep("x", { name: " " }, owner, stamp, { outcome: "won" })).code).toBe("invalid_input");
    expect(
      errorOf(() => buildNewStep("x", { name: "X", work_dist: "triangular", work_params: { min: 5, mode: 2, max: 9 } }, owner, stamp, { outcome: "won" })).message,
    ).toMatch(/min ≤ mode ≤ max/);
    expect(
      errorOf(() =>
        buildNewStep("x", { name: "X", evidence: [{ field: "rework_rate", source_id: SOURCE, quote: "q", value: 3 }] }, owner, stamp, { outcome: "won" }),
      ).message,
    ).toMatch(/share from 0 to 1/);
  });
});

describe("buildStepChange", () => {
  const entered = step({
    id: "s1",
    name: "Audit",
    work_hours: 6,
    provenance: { work_hours: { source: "entered", at: "2026-10-01T00:00:00Z", by: "someone" } },
  });

  it("never overwrites an entered value: the new value is flagged as a conflict", () => {
    const change = buildStepChange(entered, { work_hours: 12 }, stamp, { outcome: "won" });
    expect(change.changes).not.toHaveProperty("work_hours");
    expect(change.changes.conflict).toBe(true);
    expect(change.kept).toEqual([expect.objectContaining({ field: "work_hours", kept: 6, proposed: 12 })]);
    expect(openConflict(change.row, "work_hours")?.values).toEqual([
      { value: 6, source_id: null, speaker: null },
      { value: 12, source_id: null, speaker: PROPOSED_BY },
    ]);
    expect(change.base).toMatchObject({ "provenance.work_hours": entered.provenance.work_hours, conflict: false });
  });

  it("flags a cited value against an entered one with its source", () => {
    const change = buildStepChange(
      entered,
      { work_hours: 12, evidence: [{ field: "work_hours", source_id: SOURCE2, speaker: "Rosa", quote: "twelve hours", value: 12 }] },
      stamp,
      { outcome: "won" },
    );
    expect(change.row.work_hours).toBe(6);
    expect(openConflict(change.row, "work_hours")?.values).toEqual([
      { value: 6, source_id: null, speaker: null },
      { value: 12, source_id: SOURCE2, speaker: "Rosa" },
    ]);
    expect(change.conflicts[0]!.text).toBe("Audit: hands-on time is in conflict (Entered value: 6 h; Rosa: 12 h).");
  });

  it("keeps the distribution of an entered duration", () => {
    const change = buildStepChange(entered, { work_dist: "triangular", work_params: { min: 1, mode: 2, max: 3 } }, stamp, { outcome: "won" });
    expect(change.changes).not.toHaveProperty("work_dist");
    expect(change.changes).not.toHaveProperty("work_params.min");
    expect(change.kept.map((k) => k.field)).toEqual(["work_dist", "work_hours"]);
    // The range's mean (2 h) differs from the entered 6 h, so it is flagged.
    expect(openConflict(change.row, "work_hours")?.values.map((v) => v.value)).toEqual([6, 2]);
  });

  it("updates an estimate, marking an uncited value as an assumption, and changes only what differs", () => {
    const est = step({ id: "s2", name: "Kickoff", work_hours: 2, provenance: { work_hours: { source: "estimated", note: "old" } } });
    const change = buildStepChange(est, { work_hours: 3, tool: "Zoom", rework_rate: 0, name: "Kickoff" }, stamp, { outcome: "won" });
    expect(change.changes).toEqual({
      work_hours: 3,
      tool: "Zoom",
      "provenance.work_hours": { source: "estimated", at: stamp.at, by: stamp.by, note: "old", assumption: true },
      assumption: true,
    });
    expect(change.base).toEqual({ work_hours: 2, tool: null, "provenance.work_hours": { source: "estimated", note: "old" }, assumption: false });
    expect(change.assumptions).toEqual(["Step 'Kickoff': work_hours 3 h has no cited source; marked as an assumption."]);
  });

  it("scales a triangular range to new hours, and switches kind with its outcome", () => {
    const tri = step({ id: "s3", name: "Build", work_hours: 4, work_dist: "triangular", work_params: { min: 2, mode: 4, max: 6 } });
    expect(buildStepChange(tri, { work_hours: 8 }, stamp, { outcome: "won" }).changes).toMatchObject({
      "work_params.min": 4,
      "work_params.mode": 8,
      "work_params.max": 12,
      work_hours: 8,
    });
    expect(buildStepChange(tri, { kind: "end" }, stamp, { outcome: "lost" })).toMatchObject({
      changes: { kind: "end", outcome: "lost" },
      assumptions: ["Step 'Build': outcome defaulted to lost."],
    });
    expect(errorOf(() => buildStepChange(tri, { outcome: "won" }, stamp, { outcome: "won" })).code).toBe("invalid_input");
  });
});

describe("graph rules", () => {
  const g: Graph = {
    steps: [step({ id: "st", name: "Start", kind: "start" }), step({ id: "a", name: "A" }), step({ id: "end", name: "Won", kind: "end", outcome: "won" })],
    edges: [edge("e1", "st", "a"), edge("e2", "a", "end", 0.5)],
  };
  it("mirrors the editor's connection checks and warnings", () => {
    expect(connectionProblem(g, "end", "a")).toMatch(/End steps can't lead anywhere/);
    expect(connectionProblem(g, "a", "st")).toMatch(/start step/);
    expect(connectionProblem(g, "a", "a")).toMatch(/itself/);
    expect(connectionProblem(g, "a", "end")).toMatch(/already leads/);
    expect(graphWarnings(g)).toEqual([{ step_id: "a", step: "A", warning: "Branches add up to 50%, not 100%." }]);
  });
});

describe("planImport", () => {
  const live = step({
    id: "11111111-0000-4000-8000-000000000001",
    name: "Audit & proposal",
    work_hours: 6,
    provenance: { work_hours: { source: "entered", at: "2026-10-01T00:00:00Z" } },
  });
  const start = step({ id: "11111111-0000-4000-8000-000000000000", name: "Lead", kind: "start" });
  const won = step({ id: "11111111-0000-4000-8000-000000000009", name: "Won", kind: "end", outcome: "won" });
  const kickoff = step({ id: "11111111-0000-4000-8000-000000000002", name: "Kickoff", work_hours: 2 });
  const draft = {
    steps: [start, live, kickoff, won],
    retired: [],
    edges: [
      edge("22222222-0000-4000-8000-000000000001", start.id, live.id),
      edge("22222222-0000-4000-8000-000000000002", live.id, kickoff.id),
      edge("22222222-0000-4000-8000-000000000003", kickoff.id, won.id),
    ],
  };

  it("matches by stable id, then by name, keeps ids, and never overwrites an entered value", () => {
    const input: ImportInput = {
      steps: [
        { name: "audit and proposal", work_hours: 12, evidence: [{ field: "work_hours", source_id: SOURCE, speaker: "Rosa", quote: "twelve", value: 12 }] },
        { id: kickoff.id, name: "Kick-off call", work_hours: 3 },
        { name: "Access setup", work_hours: 2, evidence: [{ field: "work_hours", source_id: SOURCE, speaker: "Sam", quote: "two hours", value: 2 }] },
      ],
      edges: [
        { from: "Kick-off call", to: "Access setup" },
        { from: "Access setup", to: "Won" },
      ],
    };
    const plan = planImport(input, draft, owner, stamp, { newId });
    expect(plan.matched).toEqual([
      { name: "audit and proposal", id: live.id, by: "name" },
      { name: "Kick-off call", id: kickoff.id, by: "id" },
      { name: "Access setup", id: expect.any(String), by: "new" },
    ]);
    const audit = plan.updateSteps.find((u) => u.id === live.id)!;
    expect(audit.changes).not.toHaveProperty("work_hours");
    expect(audit.changes.conflict).toBe(true);
    expect(plan.kept).toEqual([expect.objectContaining({ step_id: live.id, field: "work_hours", kept: 6, proposed: 12 })]);
    expect(plan.conflicts.map((c) => c.step_id)).toEqual([live.id]);
    expect(plan.updateSteps.find((u) => u.id === kickoff.id)!.changes).toMatchObject({ name: "Kick-off call", work_hours: 3 });
    // Kickoff's routing is replaced: its old edge to Won goes, the new one to Access setup keeps nothing else.
    expect(plan.removeEdges.map((e) => e.id)).toEqual(["22222222-0000-4000-8000-000000000003"]);
    expect(plan.insertEdges.map((e) => [e.from_step_id, e.to_step_id, e.probability])).toEqual([
      [kickoff.id, plan.matched[2]!.id, 1],
      [plan.matched[2]!.id, won.id, 1],
    ]);
    expect(plan.insertSteps).toHaveLength(1);
    expect(plan.removeSteps).toEqual([]);

    const diff = revisionDiff(draft, plan.after);
    expect(diff.steps.added.map((s) => s.name)).toEqual(["Access setup"]);
    expect(diff.steps.changed.map((s) => s.name).sort()).toEqual(["Audit & proposal", "Kick-off call"]);
    expect(diff.steps.changed.find((s) => s.id === kickoff.id)!.fields).toMatchObject({ name: { live: "Kickoff", draft: "Kick-off call" }, work_hours: { live: 2, draft: 3 } });
    expect(diff.edges).toMatchObject({ added: [{ from: "Kick-off call", to: "Access setup" }, { from: "Access setup", to: "Won" }], removed: [{ from: "Kick-off call", to: "Won" }] });
    expect(diff.text).toMatch(/^Draft vs live: 1 step added \(Access setup\); 2 changed/);
  });

  it("returns candidates when a name matches two draft steps, and writes nothing", () => {
    const twins = { ...draft, steps: [...draft.steps, step({ id: "11111111-0000-4000-8000-000000000003", name: "kickoff" })] };
    const err = errorOf(() => planImport({ steps: [{ name: "Kickoff" }], edges: [] }, twins, owner, stamp, { newId }));
    expect(err.code).toBe("ambiguous");
    expect(err.candidates).toHaveLength(2);
  });

  it("removes steps the JSON leaves out only when asked", () => {
    const plan = planImport({ steps: [{ name: "Lead" }, { name: "Won" }], edges: [{ from: "Lead", to: "Won" }], remove_missing: true }, draft, owner, stamp, { newId });
    expect(plan.removeSteps.map((s) => s.name).sort()).toEqual(["Audit & proposal", "Kickoff"]);
    expect(plan.removeEdges).toHaveLength(3);
    expect(plan.insertEdges).toHaveLength(1);
  });

  it("refuses a second start step, a bad edge and duplicate names", () => {
    expect(errorOf(() => planImport({ steps: [{ name: "Another start", kind: "start" }], edges: [] }, draft, owner, stamp, { newId })).message).toMatch(/one start step/);
    expect(errorOf(() => planImport({ steps: [], edges: [{ from: "Won", to: "Kickoff" }] }, draft, owner, stamp, { newId })).message).toMatch(/End steps/);
    expect(errorOf(() => planImport({ steps: [{ name: "X" }, { name: "x" }], edges: [] }, draft, owner, stamp, { newId })).message).toMatch(/two steps/);
  });

  it("builds every template as a valid new process whose numbers are all assumptions", () => {
    for (const t of PROCESS_TEMPLATES) {
      const plan = planImport({ steps: t.steps, edges: t.edges }, { steps: [], edges: [], retired: [] }, owner, stamp, { newId, origin: `template '${t.name}'` });
      expect(graphWarnings(plan.after), t.id).toEqual([]);
      const working = plan.insertSteps.filter((s) => s.kind === "task");
      expect(working.every((s) => s.assumption), t.id).toBe(true);
      expect(new Set(plan.insertSteps.map((s) => `${s.x},${s.y}`)).size, t.id).toBe(plan.insertSteps.length);
      expect(revisionDiff(null, plan.after).text).toMatch(/^New process: \d+ steps added/);
    }
  });
});
