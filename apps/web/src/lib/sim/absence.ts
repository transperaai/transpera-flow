"use client";

// The absence test in the browser (docs/analysis-rules.md rule 8, issue #107):
// once the baseline run is in, an extra set of replications per person who is
// the only one for a step runs in its own worker, with the person away for
// two weeks, so it never slows the baseline run (PRD §6.7). It uses the
// baseline's seed so the two pair up. A newer model cancels it. Until it
// returns, "only one person can do it" isn't raised; the other rules are.

import { useEffect, useState } from "react";
import type { AbsenceTest, EngineModel } from "@transpera-flow/engine";

export interface AbsenceRequest {
  id: number;
  model: EngineModel;
  seed: number;
  weeks: number;
  /** Test only these people (default: every candidate). */
  personIds?: readonly string[];
}

export type AbsenceResponse = { id: number; ok: true; value: AbsenceTest } | { id: number; ok: false; error: string };

const DEBOUNCE_MS = 250;

/** The absence test of `model`, computed in a worker; null while it runs, or when `model` is missing or the worker failed. */
export function useAbsenceTest(model: EngineModel | null, seed = 1, weeks = 2, personIds?: readonly string[]): AbsenceTest | null {
  // Compared by content, not array identity, so a caller can pass a fresh array each render.
  const who = personIds?.join(",");
  const [state, setState] = useState<{ model: EngineModel | null; seed: number; weeks: number; who: string | undefined; value: AbsenceTest | null }>({ model: null, seed, weeks, who, value: null });

  useEffect(() => {
    if (!model) return;
    let worker: Worker | null = null;
    const settle = (value: AbsenceTest | null) => setState({ model, seed, weeks, who, value });
    const timer = setTimeout(() => {
      worker = new Worker(new URL("../../workers/absence.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<AbsenceResponse>) => {
        settle(event.data.ok ? event.data.value : null);
        worker?.terminate();
      };
      worker.onerror = () => settle(null);
      worker.postMessage({ id: 1, model, seed, weeks, personIds: who === undefined ? undefined : who === "" ? [] : who.split(",") } satisfies AbsenceRequest);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [model, seed, weeks, who]);

  // A result for an older model isn't shown against a newer one.
  return model && state.model === model && state.seed === seed && state.weeks === weeks && state.who === who ? state.value : null;
}
