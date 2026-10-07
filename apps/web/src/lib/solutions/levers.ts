// A solution's lever changes, applied wherever a solution is simulated (B4, D48). A49 describes a solution as "a copy of a process
// with changed steps, plus optional lever changes", and `solutions.lever_changes` has always been stored, but nothing simulated
// it until a visitor's idea (a play link) arrived with nothing but lever moves. Now the Editor's solution run, the server verdict,
// the Solution page, the Overview's impact, the demo link check and the Forecast's plans all apply them, so a solution's numbers
// mean the same everywhere. Pure.

import { applyPatches, isBlocking, type EngineModel, type ScenarioPatch } from "@transpera-flow/engine";

/**
 * A solution's model with its lever changes applied on top. Changes whose target is gone (a step, role or service removed since)
 * are left out and reported in `problems`, never thrown. With no changes the model is returned as it is (the same object), so a
 * solution without lever changes simulates exactly as before.
 */
export function withLeverChanges(model: EngineModel, levers: readonly ScenarioPatch[]): { model: EngineModel; problems: string[] } {
  if (!levers.length) return { model, problems: [] };
  const patched = applyPatches(model, levers);
  return { model: patched.model, problems: patched.issues.filter(isBlocking).map((i) => i.message) };
}
