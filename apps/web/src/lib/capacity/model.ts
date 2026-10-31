// The workspace's model as the Capacity page and the Overview's department cards both build it (a year long, purposes on). They must build
// the same one: a finished "Today" run is kept by a hash of the model, so the second page opened costs nothing (runs.ts).

import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import { horizonWeeks } from "@/lib/horizon";

export function capacityBaseModel(bundle: ProcessBundle): { model: EngineModel | null; error: string | null } {
  try {
    // A year long, as the Sandbox's month-by-month run is; the measured window is the whole year with nobody arriving or leaving.
    return { model: { ...toEngineModel(bundle, { purposes: true }), horizonWeeks: horizonWeeks(12) }, error: null };
  } catch (err) {
    if (err instanceof ModelError) return { model: null, error: err.message };
    throw err;
  }
}
