/// <reference lib="webworker" />
import { absenceTest } from "@transpera-flow/engine";
import type { AbsenceRequest, AbsenceResponse } from "@/lib/sim/absence";

// The absence test's extra replication sets (docs/analysis-rules.md rule 8), off the main thread.
self.onmessage = (event: MessageEvent<AbsenceRequest>) => {
  const { id, model, seed, weeks, personIds } = event.data;
  let response: AbsenceResponse;
  try {
    response = { id, ok: true, value: absenceTest(model, { seed, weeks, personIds }) };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
