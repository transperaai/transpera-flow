"use client";

import { useEffect, useState } from "react";
import type { CapacityChangeRow, CapacitySetup, IssueChangeFigure } from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import { runIssueChanges } from "@/lib/capacity/issue-runs";
import { SimulationCancelled, SimulationClient, type WorkerLike } from "./client";

export interface IssueChangeRuns {
  status: "idle" | "running" | "done" | "error";
  done: number;
  total: number;
  figures: Record<string, IssueChangeFigure>;
  error: string | null;
}

const IDLE: IssueChangeRuns = { status: "idle", done: 0, total: 0, figures: {}, error: null };

/**
 * The issue page's runs: today, then one per change, in the simulation worker. They start when the page that uses this is open, never before, and
 * a run already done (same model) comes back from the cache. A new set of changes or a new model cancels the runs in flight.
 */
export function useIssueChangeRuns(setup: CapacitySetup | null, model: EngineModel | null, changes: readonly CapacityChangeRow[]): IssueChangeRuns {
  const [state, setState] = useState<IssueChangeRuns>(IDLE);
  useEffect(() => {
    if (!setup || !model || !changes.length) return;
    let active = true;
    const client = new SimulationClient(() => new Worker(new URL("../../workers/simulate.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
    runIssueChanges(client, setup, model, changes, {
      isCancelled: () => !active,
      onProgress: (p) => active && setState((s) => ({ ...s, status: s.status === "idle" ? "running" : s.status, done: p.done, total: p.total })),
      onFigure: (f) => active && setState((s) => ({ ...s, figures: { ...s.figures, [f.changeId]: f } })),
    })
      .then(() => active && setState((s) => ({ ...s, status: "done" })))
      .catch((err: Error) => {
        if (active && !(err instanceof SimulationCancelled)) setState((s) => ({ ...s, status: "error", error: err.message }));
      });
    return () => {
      active = false;
      client.dispose();
    };
  }, [setup, model, changes]);
  return state;
}
