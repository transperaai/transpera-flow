import { beforeEach, describe, expect, it } from "vitest";
import { capacityModel, type SimulationResult } from "@transpera-flow/engine";
import { todayModel } from "@transpera-flow/db";
import { CAPACITY_SEED, TODAY_REPS, YEAR_REPS, capacityRunKey, clearCapacityRuns, runCapacity } from "@/lib/capacity/runs";
import type { SimClientLike } from "@/lib/capacity/client-like";

// The Capacity page's two runs: what each asks the worker for, and that a run for the same model is not run again (cached by the model's hash).

const result = { seed: 1 } as unknown as SimulationResult;

function fakeClient() {
  const calls: { reps?: number; seed?: number; monthly?: boolean; monthStarts?: number[]; personTime?: boolean }[] = [];
  const client: SimClientLike = {
    run: async (_model, options) => {
      calls.push(options);
      return { result, durationMs: 123 };
    },
  };
  return { client, calls };
}

beforeEach(() => clearCapacityRuns());

describe("capacity runs", () => {
  it("Today asks for person time at 10 replications, the year for monthly numbers at 20", async () => {
    const { client, calls } = fakeClient();
    const model = capacityModel();
    await runCapacity(client, "today", todayModel(model));
    await runCapacity(client, "year", model, [100, 200]);
    expect(calls).toEqual([
      { reps: TODAY_REPS, seed: CAPACITY_SEED, personTime: true },
      { reps: YEAR_REPS, seed: CAPACITY_SEED, monthly: true, monthStarts: [100, 200] },
    ]);
    expect(TODAY_REPS).toBe(10);
    expect(YEAR_REPS).toBe(20);
  });

  it("the same model is answered from the cache, with no time and no second run", async () => {
    const { client, calls } = fakeClient();
    const model = todayModel(capacityModel());
    const first = await runCapacity(client, "today", model);
    const again = await runCapacity(client, "today", { ...model });
    expect(calls).toHaveLength(1);
    expect(first).toMatchObject({ durationMs: 123, cached: false });
    expect(again).toMatchObject({ durationMs: 0, cached: true });
    expect(again.result).toBe(first.result);
  });

  it("a changed model, other months or the other run is a different run", async () => {
    const { client, calls } = fakeClient();
    const model = capacityModel();
    await runCapacity(client, "year", model, [1, 2]);
    await runCapacity(client, "year", model, [1, 3]);
    await runCapacity(client, "year", { ...model, hoursPerWeek: 37 }, [1, 2]);
    await runCapacity(client, "today", model);
    expect(calls).toHaveLength(4);
    expect(new Set([capacityRunKey("year", model, [1, 2]), capacityRunKey("year", model, [1, 3]), capacityRunKey("today", model)]).size).toBe(3);
  });
});
