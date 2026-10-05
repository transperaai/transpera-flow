"use client";

import { useEffect, useRef, useState } from "react";
import type { EngineModel } from "@transpera-flow/engine";
import { SimulationCancelled, SimulationClient, type SimRun, type WorkerLike } from "./client";

export type SimulationState =
  | { status: "running"; run: SimRun | null }
  | { status: "done"; run: SimRun }
  | { status: "error"; error: string; run: SimRun | null };

const DEBOUNCE_MS = 40;

/**
 * Runs the model in a Web Worker whenever it changes (debounced, stale runs cancelled). With `monthly`, the run also
 * carries its month-by-month numbers (the forecast, issue #35).
 */
export function useSimulation(model: EngineModel | null, reps = 30, seed = 1, { monthly = false }: { monthly?: boolean } = {}): SimulationState {
  const clientRef = useRef<SimulationClient | null>(null);
  const [state, setState] = useState<SimulationState>({ status: "running", run: null });

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
      setState((s) => ({ status: "running", run: s.run }));
      clientRef.current
        ?.run(model, { reps, seed, monthly })
        .then((run) => active && setState({ status: "done", run }))
        .catch((err: Error) => {
          if (active && !(err instanceof SimulationCancelled)) setState((s) => ({ status: "error", error: err.message, run: s.run }));
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [model, reps, seed, monthly]);

  return state;
}
