"use client";

import { useEffect, useRef, useState } from "react";
import type { EngineModel } from "@transpera-flow/engine";
import { SimulationCancelled, SimulationClient, type WorkerLike } from "./client";
import { cachedRun, capacityRunKey, runCapacity, type CapacityRun } from "@/lib/capacity/runs";

export type PhaseState = { status: "idle" } | { status: "running" } | { status: "done"; run: CapacityRun } | { status: "error"; error: string };

/**
 * The Capacity page's two runs, in the simulation worker one after the other: Today first (most of the page comes from it), then the next
 * 12 months. Anything already run for the same model comes back at once. A new model cancels the runs in flight.
 */
export function useCapacityRuns(today: EngineModel | null, year: EngineModel | null, monthStarts: readonly number[] | null): { today: PhaseState; year: PhaseState } {
  const starts = monthStarts ? monthStarts.join(",") : "";
  const clientRef = useRef<SimulationClient | null>(null);
  const [state, setState] = useState<{ today: PhaseState; year: PhaseState }>({ today: { status: "idle" }, year: { status: "idle" } });

  useEffect(() => {
    const client = new SimulationClient(() => new Worker(new URL("../../workers/simulate.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
    clientRef.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !today) return;
    let active = true;
    const edges = starts ? starts.split(",").map(Number) : null;
    const hitToday = cachedRun(capacityRunKey("today", today));
    const hitYear = year ? cachedRun(capacityRunKey("year", year, edges)) : null;
    setState({ today: hitToday ? { status: "done", run: hitToday } : { status: "running" }, year: hitYear ? { status: "done", run: hitYear } : { status: "idle" } });
    const fail = (kind: "today" | "year") => (err: Error) => {
      if (active && !(err instanceof SimulationCancelled)) setState((s) => ({ ...s, [kind]: { status: "error", error: err.message } }));
    };
    (async () => {
      try {
        const t = hitToday ?? (await runCapacity(client, "today", today));
        if (!active) return;
        setState((s) => ({ ...s, today: { status: "done", run: t } }));
      } catch (e) {
        fail("today")(e as Error);
        return;
      }
      if (!year) return;
      try {
        setState((s) => (s.year.status === "done" ? s : { ...s, year: { status: "running" } }));
        const y = hitYear ?? (await runCapacity(client, "year", year, edges));
        if (active) setState((s) => ({ ...s, year: { status: "done", run: y } }));
      } catch (e) {
        fail("year")(e as Error);
      }
    })();
    return () => {
      active = false;
      client.cancel();
    };
  }, [today, year, starts]);

  return state;
}
