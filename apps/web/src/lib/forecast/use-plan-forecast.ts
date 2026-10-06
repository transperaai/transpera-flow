"use client";

// Runs a forecast plan (B7, issue #36): the live model with the plan's hires and leave in it, and, for each month a
// solution goes live, one more run with the solutions live by then (planSegments). The runs are awaited in order in one
// worker, with the same seed as the live forecast (so a difference comes from the plan, not from chance), and their
// month-by-month numbers are spliced (spliceMonthly). A newer input cancels the run in flight and drops its results.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ForecastPlanMarker, ProcessBundle, SolutionRow } from "@transpera-flow/db";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { SimulationCancelled, SimulationClient, type WorkerLike } from "@/lib/sim/client";
import { forecastModel } from "./forecast";
import { planSegments, type MarkerProblem } from "./plan";
import { monthBounds } from "./positions";
import { spliceMonthly } from "./splice";

/** Re-runs wait this long after the last change, so a key held down or markers moved one after another run once. */
const DEBOUNCE_MS = 150;
/** The most workers a plan's runs are spread over. */
const POOL_SIZE = 3;
/** Finished segment runs, by what they were run from, kept so a change that leaves a segment's model alone doesn't run it again. */
const CACHE_LIMIT = 24;
const segmentCache = new Map<string, SimulationResult>();
const cacheKey = (model: EngineModel, monthStarts: readonly number[]) => `${JSON.stringify(model)}|${monthStarts.join(",")}|${REPS}|${SEED}`;
function remember(key: string, result: SimulationResult) {
  segmentCache.delete(key);
  segmentCache.set(key, result);
  while (segmentCache.size > CACHE_LIMIT) segmentCache.delete(segmentCache.keys().next().value!);
}
const REPS = 30;
const SEED = 1;

export interface PlanRun {
  model: EngineModel;
  result: SimulationResult;
  /** The model without the plan: what Settings' own hires and leave are drawn from. */
  markersModel: EngineModel;
  /** Ids of the people the plan added (its hire markers' ids). */
  planPeople: Set<string>;
}

export interface PlanForecast {
  status: "idle" | "running" | "done" | "error";
  /** The last finished run (kept while a newer one runs). */
  run: PlanRun | null;
  problems: MarkerProblem[];
  /** Ids of solution markers dated at or after the horizon, left out of the run. */
  later: string[];
  error: string | null;
  /** Runs finished in this plan's segments, and how many there are. */
  progress: [done: number, total: number];
  /** How many plan runs have finished since the page opened (for tests and the timeline's status attributes). */
  finished: number;
}

interface Prepared {
  segments: { from: number; model: EngineModel; solutionNames: string[] }[];
  monthStarts: number[];
  markersModel: EngineModel;
  planPeople: Set<string>;
  problems: MarkerProblem[];
  later: string[];
  error: string | null;
}

const IDLE: PlanForecast = { status: "idle", run: null, problems: [], later: [], error: null, progress: [0, 0], finished: 0 };

export function usePlanForecast({
  bundle,
  markers,
  solutions,
  months,
  startDate,
}: {
  bundle: ProcessBundle;
  markers: readonly ForecastPlanMarker[] | null;
  solutions: readonly SolutionRow[];
  months: number;
  startDate: string;
}): PlanForecast {
  // The models, by the inputs' identity, so a re-render with the same inputs doesn't run anything again.
  const prepared = useMemo((): Prepared | null => {
    if (markers === null) return null;
    const live = forecastModel(bundle, months, startDate);
    if (live.error !== null) return { segments: [], monthStarts: [], markersModel: null as unknown as EngineModel, planPeople: new Set(), problems: [], later: [], error: live.error };
    const bounds = monthBounds(live.monthStarts, live.model.horizonWeeks * live.model.hoursPerWeek);
    const plan = planSegments(bundle, markers, solutions, startDate, bounds, live.model.hoursPerWeek);
    const names = new Map(solutions.map((s) => [s.id, s.name]));
    const segments: Prepared["segments"] = [];
    let error: string | null = null;
    for (const seg of plan.segments) {
      const built = forecastModel(seg.bundle, months, startDate);
      if (built.error !== null) {
        const solutionNames = seg.solutionIds.map((id) => names.get(id) ?? "A solution");
        // The last solution to go live is the one that changed this segment.
        error = seg.from === 0 && !solutionNames.length ? built.error : `“${solutionNames[solutionNames.length - 1] ?? "A solution"}” can't be simulated: ${built.error}`;
        break;
      }
      segments.push({ from: seg.from, model: built.model, solutionNames: seg.solutionIds.map((id) => names.get(id) ?? "") });
    }
    return {
      segments,
      monthStarts: live.monthStarts,
      markersModel: live.model,
      planPeople: new Set(markers.filter((m) => m.kind === "hire").map((m) => m.id)),
      problems: plan.problems,
      later: plan.later,
      error,
    };
  }, [bundle, markers, solutions, months, startDate]);

  const poolRef = useRef<SimulationClient[]>([]);
  const [state, setState] = useState<{ status: PlanForecast["status"]; run: PlanRun | null; error: string | null; progress: [number, number]; finished: number }>({
    status: "idle",
    run: null,
    error: null,
    progress: [0, 0],
    finished: 0,
  });

  useEffect(() => {
    // Workers start when a client first runs something, so a page with no plan costs none.
    const pool = Array.from(
      { length: POOL_SIZE },
      () => new SimulationClient(() => new Worker(new URL("../../workers/simulate.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike),
    );
    poolRef.current = pool;
    return () => pool.forEach((c) => c.dispose());
  }, []);

  useEffect(() => {
    if (!prepared) {
      poolRef.current.forEach((c) => c.cancel());
      setState((s) => (s.status === "idle" && !s.run ? s : { ...s, status: "idle", run: null, error: null, progress: [0, 0] }));
      return;
    }
    if (prepared.error !== null || !prepared.segments.length) {
      setState((s) => ({ ...s, status: "error", error: prepared.error ?? "The plan can't be simulated.", progress: [0, 0] }));
      return;
    }
    let active = true;
    const total = prepared.segments.length;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, status: "running", error: null, progress: [0, total] }));
      try {
        const results: SimulationResult[] = new Array<SimulationResult>(total);
        let finishedRuns = 0;
        const one = async (i: number, client: SimulationClient) => {
          const seg = prepared.segments[i]!;
          const key = cacheKey(seg.model, prepared.monthStarts);
          let result = segmentCache.get(key);
          if (result) remember(key, result);
          else {
            result = (await client.run(seg.model, { reps: REPS, seed: SEED, monthly: true, monthStarts: prepared.monthStarts })).result;
            remember(key, result);
          }
          if (!active) return;
          results[i] = result;
          setState((s) => ({ ...s, progress: [++finishedRuns, total] }));
        };
        // Each worker takes every POOL_SIZE-th segment, one after another; the workers run side by side.
        const workers = Math.min(POOL_SIZE, total);
        await Promise.all(
          Array.from({ length: workers }, async (_, w) => {
            for (let i = w; i < total && active; i += workers) await one(i, poolRef.current[w]!);
          }),
        );
        if (!active) return;
        const runs = prepared.segments.map((seg, i) => ({ from: seg.from, result: results[i]! }));
        const first = runs[0]!.result;
        const monthly = spliceMonthly(runs.map((r) => ({ from: r.from, monthly: r.result.monthly! })));
        const run: PlanRun = { model: prepared.segments[0]!.model, result: { ...first, monthly }, markersModel: prepared.markersModel, planPeople: prepared.planPeople };
        setState((s) => ({ status: "done", run, error: null, progress: [total, total], finished: s.finished + 1 }));
      } catch (err) {
        if (active && !(err instanceof SimulationCancelled)) setState((s) => ({ ...s, status: "error", error: (err as Error).message }));
      }
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      // A newer input cancels what is running: its results are dropped.
      poolRef.current.forEach((c) => c.cancel());
    };
  }, [prepared]);

  if (!prepared) return IDLE;
  // A plan that fails has no numbers: the page shows the failure, never the previous plan's numbers under this plan's name.
  const status = prepared.error !== null ? "error" : state.status === "idle" ? "running" : state.status;
  return { status, run: status === "error" ? null : state.run, problems: prepared.problems, later: prepared.later, error: prepared.error ?? state.error, progress: state.progress, finished: state.finished };
}
