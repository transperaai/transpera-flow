"use client";

// The churn back-solve's runs, in their own Web Worker (issue #41, part 2). A new set of jobs (another file, another date, a model
// that changed) stops the one in flight; answers for older jobs are never shown against newer ones. Nothing runs without jobs.

import { useEffect, useState } from "react";
import type { BackSolvedChurn } from "@transpera-flow/engine";
import { mergeSolved, type ChurnJob, type ChurnMessage, type ChurnRequest } from "./backsolve";

export type BackSolveState =
  | { status: "idle" }
  | { status: "running"; run: number; job: number; jobs: number }
  | { status: "done"; solved: BackSolvedChurn }
  | { status: "error"; error: string };

const DEBOUNCE_MS = 80;
const IDLE: BackSolveState = { status: "idle" };

interface Held {
  jobs: ChurnJob[] | null;
  value: BackSolveState;
}

/** `jobs` must keep its identity while its content is the same (build it with `useMemo`). Null or empty: nothing to solve. */
export function useChurnBackSolve(jobs: ChurnJob[] | null): BackSolveState {
  const [held, setHeld] = useState<Held>({ jobs: null, value: IDLE });
  const active = jobs && jobs.length ? jobs : null;

  useEffect(() => {
    if (!active) return;
    let worker: Worker | null = null;
    const put = (value: BackSolveState) => setHeld({ jobs: active, value });
    const timer = setTimeout(() => {
      put({ status: "running", run: 0, job: 0, jobs: active.length });
      const stop = () => {
        worker?.terminate();
        worker = null;
      };
      worker = new Worker(new URL("../../workers/churn-calibration.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<ChurnMessage>) => {
        const m = event.data;
        if (m.kind === "run") put({ status: "running", run: m.run, job: m.job, jobs: m.jobs });
        else if (m.kind === "done") {
          const solved = mergeSolved(m.solved);
          put(solved ? { status: "done", solved } : { status: "error", error: "Nothing was solved." });
          stop();
        } else {
          put({ status: "error", error: m.error });
          stop();
        }
      };
      worker.onerror = (e) => {
        put({ status: "error", error: e.message || "The simulation failed" });
        stop();
      };
      worker.postMessage({ id: 1, jobs: active } satisfies ChurnRequest);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [active]);

  if (!active) return IDLE;
  // A result for older jobs is not shown against newer ones.
  return held.jobs === active ? held.value : { status: "running", run: 0, job: 0, jobs: active.length };
}
