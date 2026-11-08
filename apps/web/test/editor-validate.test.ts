import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamStepIds } from "@transpera-flow/db";
import { addEdge, addStep } from "@/lib/editor/commands";
import { parseFieldUpdate, parseIds, parseNewEdge, parseNewStep } from "@/lib/editor/validate";

// Input checks behind the process editor's Server Actions (app/w/[slug]/actions.ts).

describe("parseFieldUpdate: what a step achieves (sandbox phase 4)", () => {
  it("takes null (Automatic), a default key and a c + 8 hex key, and refuses words, client upkeep and short keys", () => {
    for (const ok of [null, "winning", "client_job", "fixing", "c0a1b2c3d"]) expect(parseFieldUpdate("steps", { purpose: null }, { purpose: ok }), String(ok)).not.toBeNull();
    for (const bad of ["Sales", "client_upkeep", "c123", "C0A1B2C3D", 5, true]) expect(parseFieldUpdate("steps", { purpose: null }, { purpose: bad as never }), String(bad)).toBeNull();
    // A blank is Automatic, as a blank tool is nothing.
    expect(parseFieldUpdate("steps", { purpose: "winning" }, { purpose: "" })?.changes).toEqual({ purpose: null });
  });
});

describe("parseFieldUpdate", () => {
  it("accepts known fields with a base each, trimming text and blanking empty optional text", () => {
    expect(parseFieldUpdate("steps", { name: "Audit", tool: "Docs" }, { name: "  Audit v2 ", tool: "  " })).toEqual({
      table: "steps",
      base: { name: "Audit", tool: "Docs" },
      changes: { name: "Audit v2", tool: null },
    });
    expect(parseFieldUpdate("steps", { "work_params.cv": null }, { "work_params.cv": 0.5 })).not.toBeNull();
    expect(parseFieldUpdate("edges", { probability: 1 }, { probability: 0.4 })).not.toBeNull();
    expect(parseFieldUpdate("steps", { kind: "task", outcome: null }, { kind: "end", outcome: "won" })).not.toBeNull();
  });

  it("rejects unknown tables and fields, and fields the table can't change", () => {
    expect(parseFieldUpdate("people", { name: "a" }, { name: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { id: "a" }, { id: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { workspace_id: "a" }, { workspace_id: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { provenance: "a" }, { provenance: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { "work_params.other": 1 }, { "work_params.other": 2 })).toBeNull();
    expect(parseFieldUpdate("edges", { name: "a" }, { name: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { toString: 1 }, { toString: 2 })).toBeNull();
  });

  it("rejects a change without a base, empty changes and non-scalar values", () => {
    expect(parseFieldUpdate("steps", {}, { name: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", {}, {})).toBeNull();
    expect(parseFieldUpdate("steps", null, { name: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { name: ["a"] }, { name: "b" })).toBeNull();
    expect(parseFieldUpdate("steps", { name: "a" }, { name: { x: 1 } })).toBeNull();
  });

  it("checks each value", () => {
    const bad: [string, unknown][] = [
      ["name", "  "],
      ["name", "x".repeat(201)],
      ["kind", "loop"],
      ["outcome", "maybe"],
      ["role_id", "not-a-uuid"],
      ["work_hours", -1],
      ["work_hours", Number.NaN],
      ["work_hours", "3"],
      ["work_dist", "normal"],
      ["rework_rate", 1.5],
      ["current_wip", 2.5],
      ["current_wip", -1],
      ["sla_hours", -2],
      // The analysis rules' step settings.
      ["expected_wait_hours", -1],
      ["lost_per_day_waiting", 1.5],
      ["lost_per_day_waiting", -0.1],
      ["dropoff_benchmark", 2],
      ["target_cycle_hours", 0],
      ["target_cycle_hours", -5],
      ["x", Infinity],
    ];
    for (const [field, value] of bad) {
      expect(parseFieldUpdate("steps", { [field]: null }, { [field]: value }), `${field} = ${String(value)}`).toBeNull();
    }
    expect(parseFieldUpdate("edges", { probability: 1 }, { probability: 1.2 })).toBeNull();
    expect(parseFieldUpdate("edges", { from_step_id: northbeamStepIds.audit }, { from_step_id: "x" })).toBeNull();
  });

  it("accepts the analysis rules' step settings, and blank for each", () => {
    for (const [field, value] of [["expected_wait_hours", 4], ["lost_per_day_waiting", 0.05], ["dropoff_benchmark", 0.3], ["target_cycle_hours", 120]] as const) {
      expect(parseFieldUpdate("steps", { [field]: null }, { [field]: value }), field).not.toBeNull();
      expect(parseFieldUpdate("steps", { [field]: value }, { [field]: null }), `${field} blank`).not.toBeNull();
    }
  });

  it("keeps end steps, and only end steps, with an outcome when both change", () => {
    expect(parseFieldUpdate("steps", { kind: "task", outcome: null }, { kind: "end", outcome: null })).toBeNull();
    expect(parseFieldUpdate("steps", { kind: "end", outcome: "won" }, { kind: "task", outcome: "won" })).toBeNull();
  });
});

describe("parseNewStep / parseNewEdge", () => {
  it("accepts what the editor creates, without the columns the server fills in", () => {
    const b = northbeamBundle();
    const op = addStep(b, { kind: "end", x: 1, y: 2 }).edit.ops[0]!;
    if (op.kind !== "insert") throw new Error("expected an insert");
    const parsed = parseNewStep(op.steps[0]);
    expect(parsed).toMatchObject({ id: op.steps[0]!.id, kind: "end", outcome: "done", work_params: {} });
    expect(parsed).not.toHaveProperty("workspace_id");
    expect(parsed).not.toHaveProperty("revision_id");
    // Steps restored by undo come from the loaded rows, and keep columns the editor doesn't edit.
    expect(parseNewStep(b.steps[0])).not.toBeNull();
    const loaded = { ...b.steps[0]!, provenance: { source: "entered" }, assumption: true, conflict: false, replaced_by: [], cost_override: 12 };
    expect(parseNewStep(loaded)).toMatchObject({ provenance: { source: "entered" }, assumption: true, replaced_by: [], cost_override: 12 });
    expect(parseNewStep({ ...loaded, replaced_by: ["x"] })).toBeNull();
    expect(parseNewStep({ ...loaded, provenance: "x" })).toBeNull();

    const edgeOp = addEdge(b, northbeamStepIds.qualify, northbeamStepIds.audit)!.edit.ops[0]!;
    if (edgeOp.kind !== "insert") throw new Error("expected an insert");
    expect(parseNewEdge(edgeOp.edges[0])).toMatchObject({ from_step_id: northbeamStepIds.qualify, probability: 0 });
    expect(parseNewEdge(edgeOp.edges[0])).not.toHaveProperty("process_id");
  });

  it("rejects malformed rows", () => {
    const b = northbeamBundle();
    const s = b.steps[0]!;
    expect(parseNewStep({ ...s, id: "1" })).toBeNull();
    expect(parseNewStep({ ...s, kind: "end", outcome: null })).toBeNull();
    expect(parseNewStep({ ...s, work_hours: -1 })).toBeNull();
    expect(parseNewStep({ ...s, work_params: { cv: -1 } })).toBeNull();
    expect(parseNewStep({ ...s, work_params: { evil: 1 } })).toBeNull();
    expect(parseNewStep({ ...s, work_params: [] })).toBeNull();
    expect(parseNewStep("step")).toBeNull();
    const e = b.edges[0]!;
    expect(parseNewEdge({ ...e, to_step_id: e.from_step_id })).toBeNull();
    expect(parseNewEdge({ ...e, probability: 2 })).toBeNull();
    expect(parseNewEdge({ ...e, from_step_id: null })).toBeNull();
  });

  it("parses id lists", () => {
    expect(parseIds([northbeamStepIds.audit, northbeamStepIds.audit])).toEqual([northbeamStepIds.audit]);
    expect(parseIds([])).toEqual([]);
    expect(parseIds(["x"])).toBeNull();
    expect(parseIds("x")).toBeNull();
  });
});
