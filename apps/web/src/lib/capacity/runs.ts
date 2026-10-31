// The Capacity page's two runs (P5 brief section 2): "Today" (the current book of clients: demand off, nobody leaving, `personTime` on)
// and "The next 12 months" (the normal model, month by month). Both run in the app's simulation worker, one after the other, never on the
// server. A finished run is kept by what it was run from (a hash of the model, the months' edges, the reps and the seed), as the Sandbox
// keeps its own, so coming back to the page or changing nothing does not run it again.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import type { SimClientLike } from "./client-like";

/** Replications for Today (hands-on hours and busy shares settle quickly) and for the 12 months. Measured in the P5 report. */
export const TODAY_REPS = 10;
export const YEAR_REPS = 20;
export const CAPACITY_SEED = 1;

export type RunKind = "today" | "year";

export interface CapacityRun {
  result: SimulationResult;
  /** Milliseconds the worker took; 0 for a run served from the cache. */
  durationMs: number;
  cached: boolean;
}

/** FNV-1a over the text: short, and the same text always gives the same key. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const capacityRunKey = (kind: RunKind, model: EngineModel, monthStarts?: readonly number[] | null): string =>
  `${kind}|${hash(JSON.stringify(model))}|${monthStarts ? monthStarts.join(",") : ""}|${kind === "today" ? TODAY_REPS : YEAR_REPS}|${CAPACITY_SEED}`;

const CACHE_LIMIT = 24;
const cache = new Map<string, CapacityRun>();

export function cachedRun(key: string): CapacityRun | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return { ...hit, durationMs: 0, cached: true };
}

function remember(key: string, run: CapacityRun): void {
  cache.set(key, run);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export function clearCapacityRuns(): void {
  cache.clear();
}

/** Runs one of the two runs on `client`, or answers from the cache. */
export async function runCapacity(client: SimClientLike, kind: RunKind, model: EngineModel, monthStarts?: readonly number[] | null): Promise<CapacityRun> {
  const key = capacityRunKey(kind, model, monthStarts);
  const hit = cachedRun(key);
  if (hit) return hit;
  const run =
    kind === "today"
      ? await client.run(model, { reps: TODAY_REPS, seed: CAPACITY_SEED, personTime: true })
      : await client.run(model, { reps: YEAR_REPS, seed: CAPACITY_SEED, monthly: true, ...(monthStarts ? { monthStarts: [...monthStarts] } : {}) });
  const out: CapacityRun = { result: run.result, durationMs: run.durationMs, cached: false };
  remember(key, out);
  return out;
}
