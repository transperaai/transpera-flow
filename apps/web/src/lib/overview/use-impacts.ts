"use client";

// The runs behind the Overview's "Improvement delivered" card and before/after chart (issue #173), in their own worker so
// they never hold up the map or the other cards. Nothing runs without a solution to compare.
//
// The answers are kept for the session, by the pairs' models (which carry their length), the runs and the seed: the same
// solutions compared again (a change of horizon, coming back to the Overview) don't run again.

import { useEffect, useState } from "react";
import type { ImpactPair, SolutionImpact } from "./impact-run";

export interface ImpactRequest {
  id: number;
  pairs: ImpactPair[];
  reps: number;
  seed: number;
}

export type ImpactResponse = { id: number; ok: true; impacts: SolutionImpact[] } | { id: number; ok: false; error: string };

export type Impacts = { status: "running" } | { status: "done"; impacts: SolutionImpact[] } | { status: "error"; error: string };

const DEBOUNCE_MS = 60;
const RUNNING: Impacts = { status: "running" };
const NONE: Impacts = { status: "done", impacts: [] };

/** Finished comparisons, by `cacheKey`. Only answers that came back whole are kept; at most this many. */
const CACHE_SIZE = 8;
const cache = new Map<string, Impacts>();
const cacheKey = (pairsKey: string, reps: number, seed: number) => `${reps}:${seed}:${pairsKey}`;
const remember = (key: string, value: Impacts) => {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
};

/** Each pair's before and after; `running` until they are all in. `enabled` false holds the runs back (until the page needs them). */
export function useImpacts(pairs: readonly ImpactPair[], enabled = true, reps = 30, seed = 1): Impacts {
  const key = JSON.stringify(pairs);
  const cached = cache.get(cacheKey(key, reps, seed));
  const [state, setState] = useState<{ key: string; value: Impacts }>({ key: "", value: RUNNING });

  useEffect(() => {
    if (!enabled || !pairs.length || cache.has(cacheKey(key, reps, seed))) return;
    let worker: Worker | null = null;
    const settle = (value: Impacts) => {
      if (value.status === "done") remember(cacheKey(key, reps, seed), value);
      setState({ key, value });
    };
    const timer = setTimeout(() => {
      worker = new Worker(new URL("../../workers/impact.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<ImpactResponse>) => {
        settle(event.data.ok ? { status: "done", impacts: event.data.impacts } : { status: "error", error: event.data.error });
        worker?.terminate();
      };
      worker.onerror = (event) => settle({ status: "error", error: event.message || "The comparison failed" });
      worker.postMessage({ id: 1, pairs: JSON.parse(key) as ImpactPair[], reps, seed } satisfies ImpactRequest);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
    // `key` stands for the pairs by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, reps, seed]);

  if (!pairs.length) return NONE;
  if (cached) return cached;
  return state.key === key ? state.value : RUNNING;
}
