"use client";

// The runs behind the Overview's "Improvement delivered" card and before/after chart (issue #173), in their own worker so
// they never hold up the map or the other cards. Nothing runs without a solution to compare.

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

/** Each pair's before and after; `running` until they are all in. `enabled` false holds the runs back (until the page needs them). */
export function useImpacts(pairs: readonly ImpactPair[], enabled = true, reps = 30, seed = 1): Impacts {
  const key = JSON.stringify(pairs);
  const [state, setState] = useState<{ key: string; value: Impacts }>({ key: "", value: RUNNING });

  useEffect(() => {
    if (!enabled || !pairs.length) return;
    let worker: Worker | null = null;
    const settle = (value: Impacts) => setState({ key, value });
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
  return state.key === key ? state.value : RUNNING;
}
