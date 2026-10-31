import type { EngineModel } from "@transpera-flow/engine";
import type { SimRun } from "@/lib/sim/client";

/** What the runs need of a `SimulationClient` (a fake in the tests). */
export interface SimClientLike {
  run(model: EngineModel, options: { reps?: number; seed?: number; monthly?: boolean; monthStarts?: number[]; personTime?: boolean }): Promise<SimRun>;
}
