import type { EngineModel, InitialState, SimulationResult } from "@transpera-flow/engine";

export interface SimRequest {
  id: number;
  model: EngineModel;
  reps: number;
  seed: number;
  /** Month-by-month numbers too (`SimulationResult.monthly`; the forecast, issue #35). */
  monthly?: boolean;
  /** With `monthly`: where each month after the first starts, in working hours (calendar months; see `calendarMonthStarts`). */
  monthStarts?: number[];
  /** Start from this state instead of sizing a warm-up from the model (the Sandbox pins a scenario's warm-up to the live model's). */
  initialState?: InitialState;
}

export type SimResponse =
  | { id: number; ok: true; result: SimulationResult; durationMs: number }
  | { id: number; ok: false; error: string };
