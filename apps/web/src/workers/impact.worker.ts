/// <reference lib="webworker" />
import { measureImpact } from "@/lib/overview/impact-run";
import type { ImpactRequest, ImpactResponse } from "@/lib/overview/use-impacts";

// The Overview's before and after per solution (issue #173): each pair simulated in turn, off the main thread.
self.onmessage = (event: MessageEvent<ImpactRequest>) => {
  const { id, pairs, reps, seed } = event.data;
  let response: ImpactResponse;
  try {
    response = { id, ok: true, impacts: pairs.map((p) => measureImpact(p, reps, seed)) };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
