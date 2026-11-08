import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, northbeamModel, simulate } from "@transpera-flow/engine";
import { summarizeRun } from "../src";

const KPI_KEYS = "billed clientsAtRisk clientsChurned costPerWin cycle done hourly labour labourCost lost lostRevenue ltvAdded mrrAdded overheads overtimeCost overtimeHours people profit revenue revenueHourly roles services touchpoints wipEnd won".split(" ");

// Every run the MCP server reports says which engine produced it (docs/PRD.md
// §6.9; issue #22), as a saved run records it.
describe("engine version in MCP results", () => {
  it("run_scenario's summary carries the engine version", () => {
    const model = northbeamModel();
    expect(summarizeRun(model, simulate(model, 2, 1)).engine_version).toBe(ENGINE_VERSION);
  });

  // Sandbox phase 3 (engine 1.12.0) adds outputs to the engine's samples, monthly results and churn causes, none to the summary an MCP
  // tool returns: only engine_version reads differently. The keys below are those of 1.11.0.
  it("run_scenario's summary keeps its keys, and its kpi keeps the 1.11.0 set", () => {
    const model = northbeamModel();
    const summary = summarizeRun(model, simulate(model, 2, 1));
    expect(Object.keys(summary).sort()).toEqual(["bottleneck", "engine_version", "horizon_weeks", "kpi", "names", "reps"]);
    // Some keys exist only for a model with a client roster; none may be new.
    expect(KPI_KEYS).toEqual(expect.arrayContaining(Object.keys(summary.kpi)));
  });
});
