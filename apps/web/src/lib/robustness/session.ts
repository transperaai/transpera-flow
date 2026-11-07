// The robustness check in the browser (issue #20, docs/PRD.md §6.5): a
// worker pool, a cache, and which parameters count as estimated.
//
// Cache: job results are kept in memory for the life of the tab, keyed by
// (model hash, scenario hash, parameter, perturbation, replications). That is
// enough for "re-open compare on an unchanged model and see the answer
// straight away": closing and re-opening the compare view, moving a lever
// away and back, or switching scenarios back and forth all hit it. It is not
// persisted because a result is cheap to recompute (10–30 s), is tied to the
// engine version, and the PRD's `robustness_results` table needs a migration
// and a server writer that belong with the PDF ticket. The cache is capped,
// so a long session doesn't grow without bound.

import {
  MemoryRobustnessCache,
  RobustnessPool,
  checkRobustness,
  estimatedParameters,
  poolSize,
  provenanceFromRows,
  robustness,
  type EngineModel,
  type PoolWorker,
  type ProvenanceRows,
  type RobustnessCache,
  type RobustnessOptions,
  type RobustnessParameter,
  type RobustnessProgress,
  type RobustnessResult,
  type ScenarioPatch,
} from "@transpera-flow/engine";

/** Shared by every compare view in this tab. */
export const sessionCache: RobustnessCache = new MemoryRobustnessCache(20_000);

/**
 * The parameters to perturb, given the rows' `provenance` jsonb: steps',
 * services' and the workspace's (its settings, for the health rules; issue
 * #79).
 *
 * Rule: a parameter is estimated, and so perturbed, unless its provenance
 * says `entered` (see `provenanceSource` in the engine for the
 * per-column and per-row shapes); a health rule the workspace hasn't set is
 * the estimated default. Demand and roles carry no provenance the check
 * reads, so theirs are all estimated.
 */
export function robustnessParameters(
  model: EngineModel,
  rows: ProvenanceRows,
  opts: Pick<RobustnessOptions, "perturbation" | "metric"> = {},
): RobustnessParameter[] {
  return estimatedParameters(model, { ...opts, provenance: provenanceFromRows(rows) });
}

export interface RobustnessRequestInput {
  model: EngineModel;
  scenario: ScenarioPatch[];
  options: RobustnessOptions;
}

/**
 * One compare view's robustness checks: at most one running at a time, on a
 * pool of workers, reading and filling the tab's cache.
 */
export class RobustnessSession {
  private pool: RobustnessPool | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly createWorker: () => PoolWorker,
    private readonly cache: RobustnessCache = sessionCache,
    private readonly size = poolSize(typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency),
  ) {}

  /** The result if every job is already cached, without running anything; otherwise null. */
  cached({ model, scenario, options }: RobustnessRequestInput): RobustnessResult | null {
    return robustness(model, scenario, { ...options, cache: this.cache, cacheOnly: true });
  }

  /** Run the check (cancelling any running one). Rejects with `RobustnessCancelled` if cancelled. */
  run({ model, scenario, options }: RobustnessRequestInput, onProgress: (p: RobustnessProgress) => void): Promise<RobustnessResult> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.pool ??= new RobustnessPool(this.createWorker, this.size);
    const pool = this.pool;
    return checkRobustness(model, scenario, { ...options, cache: this.cache, execute: pool.execute, signal: controller.signal, onProgress }).finally(() => {
      if (this.controller !== controller) return;
      this.controller = null;
      // Idle workers hold a copy of the engine each; free them between checks.
      pool.dispose();
    });
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.cancel();
    this.pool?.dispose();
    this.pool = null;
  }
}
