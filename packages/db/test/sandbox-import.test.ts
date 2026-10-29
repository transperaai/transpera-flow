import { describe, expect, it } from "vitest";
import { MAX_SCENARIO_NAME, SANDBOX_LIBRARY, planSandboxScenarios, type SandboxChange } from "../src";

// How a backup's scenarios become restore-plan rows (packages/db/src/sandbox-import.ts): an older backup's patches are converted, and
// whatever the database would refuse is dealt with here so a restore cannot fail on a scenario.

const ID = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const change = (n: number, extra: Partial<SandboxChange> = {}): SandboxChange => ({ id: ID(0x100 + n), lever: "A1", target: null, op: "multiply", value: 1.2, ...extra });
const row = (n: number, extra: Record<string, unknown> = {}) => ({ id: ID(n), name: `S${n}`, description: null, parent_id: null, changes: [change(n)], ...extra });

describe("planSandboxScenarios", () => {
  it("passes valid scenarios through, parents first", () => {
    const out = planSandboxScenarios([row(2, { parent_id: ID(1) }), row(1)], []);
    expect(out.rows.map((r) => r.name)).toEqual(["S1", "S2"]);
    expect(out.warnings).toEqual([]);
    expect(out.rows[1]!.parent_id).toBe(ID(1));
  });

  it("keeps the notes on changes (including a build-on child's), and drops a scenario whose note is not valid", () => {
    const out = planSandboxScenarios([row(1, { changes: [change(1, { note: "Assumes the Q3 campaign doubles leads." })] }), row(2, { parent_id: ID(1), changes: [change(2, { note: "x".repeat(281) })] })], []);
    expect(out.rows.map((r) => r.name)).toEqual(["S1"]);
    expect((out.rows[0]!.changes as SandboxChange[])[0]!.note).toBe("Assumes the Q3 campaign doubles leads.");
    expect(out.dropped).toBe(1);
  });

  it("converts an older backup's patches into whole-run changes with no parent, keeping the order", () => {
    const out = planSandboxScenarios([], [{ id: ID(1), name: "Old", description: "d", parent_scenario_id: ID(2), patch: [{ path: "demand.leads_per_week", op: "multiply", value: 1.25 }, { path: `steps.${ID(9)}.work_hours`, op: "set", value: 2 }], created_at: "2026-01-01" }]);
    const changes = out.rows[0]!.changes as SandboxChange[];
    expect(changes.map(({ id: _id, ...c }) => c)).toEqual([
      { lever: "A1", target: null, op: "multiply", value: 1.25 },
      { lever: "E1", target: ID(9), op: "set", value: 2 },
    ]);
    expect(out.rows[0]!.parent_id).toBeNull();
    expect(out.rows[0]!.created_at).toBe("2026-01-01");
  });

  it("leaves out a patch scenario with a path in no lever, and a scenario whose changes are not valid, with a warning", () => {
    const out = planSandboxScenarios([row(1, { changes: [{ id: "x" }] }), row(2, { changes: "no" })], [{ id: ID(3), name: "Odd", patch: [{ path: "nope", op: "set", value: 1 }] }]);
    expect(out.rows).toEqual([]);
    expect(out.dropped).toBe(3);
    expect(out.warnings.join(" ")).toMatch(/3 scenarios aren't valid/);
  });

  it("leaves out a change that puts a solution live (solutions are not restored) and says how many", () => {
    const out = planSandboxScenarios([row(1, { changes: [change(1), { id: ID(0x900), lever: "E6", target: ID(7), op: "set", value: 1, from: "2027-04" }] })], []);
    expect((out.rows[0]!.changes as unknown[]).length).toBe(1);
    expect(out.solutionChanges).toBe(1);
    expect(out.warnings.join(" ")).toMatch(/1 change that puts a solution live was left out/);
  });

  it("makes names unique (ignoring case and spaces) with (2), (3) and cuts a 120-character name to fit", () => {
    const long = "x".repeat(MAX_SCENARIO_NAME);
    const out = planSandboxScenarios([row(1, { name: "Plan" }), row(2, { name: " plan " }), row(3, { name: "PLAN" }), row(4, { name: long }), row(5, { name: long.toUpperCase() })], []);
    expect(out.rows.map((r) => r.name)).toEqual(["Plan", "plan (2)", "PLAN (3)", long, `${long.toUpperCase().slice(0, MAX_SCENARIO_NAME - 4)} (2)`]);
    expect(out.rows.every((r) => (r.name as string).length <= MAX_SCENARIO_NAME)).toBe(true);
    expect(out.renamed).toBe(4 - 1);
  });

  it("keeps a library scenario's name when its changes are the library's (the restore skips it), and renames any other that takes a library name", () => {
    const lib = SANDBOX_LIBRARY[3]!;
    const same = row(1, { name: lib.name, changes: lib.changes.map((c, i) => ({ ...c, id: ID(0x500 + i) })) });
    const other = row(2, { name: "More leads" });
    const out = planSandboxScenarios([same, other], []);
    expect(out.rows.map((r) => r.name)).toEqual([lib.name, "More leads (2)"]);
  });

  it("clears a parent that is not restored, a loop, and a chain deeper than the database takes", () => {
    const missing = planSandboxScenarios([row(1, { parent_id: ID(99) })], []);
    expect(missing.rows[0]!.parent_id).toBeNull();
    expect(missing.clearedParents).toBe(1);
    const loop = planSandboxScenarios([row(1, { parent_id: ID(2) }), row(2, { parent_id: ID(1) })], []);
    expect(loop.rows.filter((r) => r.parent_id !== null)).toHaveLength(1);
    const chain = Array.from({ length: 8 }, (_, i) => row(i + 1, { parent_id: i === 0 ? null : ID(i) }));
    const deep = planSandboxScenarios(chain, []);
    const depth = (r: Record<string, unknown>): number => (r.parent_id == null ? 0 : 1 + depth(deep.rows.find((x) => x.id === r.parent_id)!));
    expect(Math.max(...deep.rows.map(depth))).toBeLessThanOrEqual(5);
  });

  it("keeps a valid horizon and start month; an invalid horizon becomes the default 12 (never missing: the restore would insert null), an invalid start is dropped", () => {
    const out = planSandboxScenarios([row(1, { horizon_months: 24, start_date: "2027-03-01" }), row(2, { horizon_months: 25, start_date: "2027-03-02" })], []);
    expect(out.rows[0]).toMatchObject({ horizon_months: 24, start_date: "2027-03-01" });
    expect(out.rows[1]).toMatchObject({ horizon_months: 12 });
    expect(out.rows[1]).not.toHaveProperty("start_date");
  });
});
