"use client";

import { useEffect, useRef, useState } from "react";
import type { EngineModel } from "@transpera-flow/engine";
import { SimulationCancelled, SimulationClient, type SimRun, type WorkerLike } from "./client";

/** `model` is the model `run` was made from (null before the first run): it can differ from the current one while a newer run goes. */
export type SimulationState =
  | { status: "running"; run: SimRun | null; model: EngineModel | null }
  | { status: "done"; run: SimRun; model: EngineModel }
  | { status: "error"; error: string; run: SimRun | null; model: EngineModel | null };

const DEBOUNCE_MS = 40;

/**
 * Runs the model in a Web Worker whenever it changes (debounced, stale runs cancelled). With `monthly`, the run also
 * carries its month-by-month numbers (the forecast, issue #35).
 */
export function useSimulation(
  model: EngineModel | null,
  reps = 30,
  seed = 1,
  { monthly = false, monthStarts }: { monthly?: boolean; monthStarts?: readonly number[] | null } = {},
): SimulationState {
  // The months' edges by value, so a new array with the same edges doesn't run the model again.
  const starts = monthStarts ? monthStarts.join(",") : "";
  const clientRef = useRef<SimulationClient | null>(null);
  const [state, setState] = useState<SimulationState>({ status: "running", run: null, model: null });

  useEffect(() => {
    const client = new SimulationClient(
      () => new Worker(new URL("../../workers/simulate.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
    );
    clientRef.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    if (!model) return;
    let active = true;
    const timer = setTimeout(() => {
      setState((s) => ({ status: "running", run: s.run, model: s.model }));
      clientRef.current
        ?.run(model, { reps, seed, monthly, ...(starts ? { monthStarts: starts.split(",").map(Number) } : {}) })
        .then((run) => active && setState({ status: "done", run, model }))
        .catch((err: Error) => {
          if (active && !(err instanceof SimulationCancelled)) setState((s) => ({ status: "error", error: err.message, run: s.run, model: s.model }));
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [model, reps, seed, monthly, starts]);

  return state;
}
