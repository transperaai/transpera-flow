import type { EngineModel, SimulationResult } from "@transpera-flow/engine";

export interface SimRequest {
  id: number;
  model: EngineModel;
  reps: number;
  seed: number;
  /** Month-by-month numbers too (`SimulationResult.monthly`; the forecast, issue #35). */
  monthly?: boolean;
}

export type SimResponse =
  | { id: number; ok: true; result: SimulationResult; durationMs: number }
  | { id: number; ok: false; error: string };
