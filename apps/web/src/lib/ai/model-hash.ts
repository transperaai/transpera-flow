// What an analysis read, as one hash (issue #175, B17: "results are saved until the model changes, then marked out of
// date"). Pure. The model is the engine model built at a fixed start date (so the hash doesn't change with the calendar,
// only with what someone entered: steps, times, people, demand, services, clients), with the first principles the
// analysis judges it against, the scope, and the prompt version. An analysis stored with one hash is out of date once the
// page's model hashes differently.

import { createHash } from "node:crypto";
import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import type { FirstPrinciples } from "@transpera-flow/engine";
import { AI_PROMPT_VERSION } from "./facts";

/** Any fixed date: only differences between models matter. */
const FIXED_START = "2026-01-05";

/** The hash of what an analysis of `bundle` reads; null when the model can't be built (nothing to analyse). */
export function analysisModelHash(bundle: ProcessBundle, firstPrinciples: FirstPrinciples | null, scope: "process" | "company"): string | null {
  let model;
  try {
    model = toEngineModel(bundle, { startDate: FIXED_START });
  } catch (err) {
    if (err instanceof ModelError) return null;
    throw err;
  }
  return createHash("sha256")
    .update(JSON.stringify({ v: AI_PROMPT_VERSION, scope, model, firstPrinciples }))
    .digest("hex");
}

/**
 * Whether a stored analysis is out of date: the model now hashes differently, or (for a process, when the analysis has no
 * hash, as those written before B17) it read another version.
 */
export function isStale(view: { modelHash?: string | null; revisionId: string } | null, now: { hash: string | null; revisionId: string | null }): boolean {
  if (!view) return false;
  if (view.modelHash && now.hash) return view.modelHash !== now.hash;
  return now.revisionId !== null && view.revisionId !== now.revisionId;
}
