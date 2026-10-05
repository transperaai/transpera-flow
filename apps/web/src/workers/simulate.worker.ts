/// <reference lib="webworker" />
import { simulate } from "@transpera-flow/engine";
import type { SimRequest, SimResponse } from "@/lib/sim/protocol";

self.onmessage = (event: MessageEvent<SimRequest>) => {
  const { id, model, reps, seed, monthly } = event.data;
  const started = performance.now();
  let response: SimResponse;
  try {
    const result = simulate(model, reps, seed, monthly ? { monthly } : {});
    response = { id, ok: true, result, durationMs: performance.now() - started };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
