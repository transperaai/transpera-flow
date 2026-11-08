import { useMemo } from "react";
import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import type { EngineModel, ScenarioPatch } from "@transpera-flow/engine";
import type { ScreenMode } from "@/lib/mode";
import { withLeverChanges } from "@/lib/solutions/levers";

/**
 * How edits are saved: `live` to the database as the signed-in user, `demo`
 * in memory (lost on reload), `readonly` not at all (viewers). Either way
 * edits go into the process's draft, never the live revision (issue #9).
 */
export type EditMode = ScreenMode;

/** A bundle's engine model, the same object while the model is unchanged (moving a step doesn't change it). */
export function useEngineModel(bundle: ProcessBundle, weeks: number | null, levers?: readonly ScenarioPatch[]): { model: EngineModel | null; error: string | null } {
  const resolved = useMemo(() => {
    try {
      // A solution's lever changes (B4) are applied on top, so the page shows the solution's own numbers.
      const built = toEngineModel(bundle);
      return { model: levers?.length ? withLeverChanges(built, levers).model : built, error: null };
    } catch (err) {
      if (err instanceof ModelError) return { model: null, error: err.message };
      throw err;
    }
  }, [bundle, levers]);
  const modelKey = resolved.model ? JSON.stringify(resolved.model) : null;
  // The horizon picked on the page replaces the workspace's (issue #123); null keeps the workspace's.
  const model = useMemo(() => {
    if (!modelKey) return null;
    const m = JSON.parse(modelKey) as EngineModel;
    return weeks === null ? m : { ...m, horizonWeeks: weeks };
  }, [modelKey, weeks]);
  return { model, error: resolved.error };
}
