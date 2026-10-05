// What an analysis read, as a hash (issue #175, B17: "results are saved until the model changes, then marked out of
// date"). Pure. Two parts, joined by a dot (`joinAnalysisHash`):
//
//   * the base, worked out here on the server: the engine model built at a fixed start date (so it doesn't change with
//     the calendar, only with what someone entered: steps, times, people, demand, services, clients), the first principles
//     the analysis judges it against, the scope, the prompt version, the Anthropic model that writes it, whether the
//     workspace lets AI read sources and, when it does, every source citation on the model's steps (source id and quote);
//   * the facts (`factsDigest`): the run's facts by key and rating, which the pages work out in the browser from the run.
//
// An analysis stored with one hash is out of date once either part differs from what the page has now (`isStale`).

import { createHash } from "node:crypto";
import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import type { FirstPrinciples } from "@transpera-flow/engine";
import { processSteps } from "@/lib/process-steps";
import { AI_PROMPT_VERSION } from "./facts";

export { factsDigest, isStale, joinAnalysisHash } from "./facts-digest";

/** Any fixed date: only differences between models matter. */
const FIXED_START = "2026-01-05";

export interface AnalysisReads {
  /** The workspace's "AI reads sources" switch. */
  readSources: boolean;
  /** The Anthropic model that writes the analysis. */
  model: string;
}

/** Every source citation on the steps AI reads: which source, and the words quoted. */
export function sourceCitations(bundle: ProcessBundle, scope: "process" | "company"): { step: string; source: string; quote: string }[] {
  const steps = scope === "company" ? [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((o) => o.steps)] : processSteps(bundle);
  const out: { step: string; source: string; quote: string }[] = [];
  for (const step of steps) {
    const provenance = step.provenance as unknown;
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) continue;
    for (const [field, entry] of Object.entries(provenance as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const evidence = entry && typeof entry === "object" ? (entry as { evidence?: unknown }).evidence : null;
      if (!Array.isArray(evidence)) continue;
      for (const c of evidence) {
        if (!c || typeof c !== "object") continue;
        const { source_id, quote } = c as { source_id?: unknown; quote?: unknown };
        out.push({ step: `${step.id}:${field}`, source: typeof source_id === "string" ? source_id : "", quote: typeof quote === "string" ? quote : "" });
      }
    }
  }
  return out;
}

/** The base hash of what an analysis of `bundle` reads (32 hex digits); null when the model can't be built (nothing to analyse). */
export function analysisBaseHash(bundle: ProcessBundle, firstPrinciples: FirstPrinciples | null, scope: "process" | "company", reads: AnalysisReads): string | null {
  let model;
  try {
    model = toEngineModel(bundle, { startDate: FIXED_START });
  } catch (err) {
    if (err instanceof ModelError) return null;
    throw err;
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: AI_PROMPT_VERSION,
        scope,
        model,
        firstPrinciples,
        ai: reads.model,
        readSources: reads.readSources,
        sources: reads.readSources ? sourceCitations(bundle, scope) : null,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}
