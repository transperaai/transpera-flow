"use client";

// Runs a Sandbox scenario (docs/plans/sandbox-p1-brief.md §3): the live model with the scenario's changes in it, and, for each month
// a spliced change takes effect, one more run with everything in force by then (scenarioSegments). The runs are spread over a shared
// pool of up to three workers (shared by every scenario on the page, with a map of runs in flight so an identical run is computed
// once), with the same seed as the live forecast (so a difference comes from the scenario, not from chance), and finished runs are
// kept by what they were run from. Their month-by-month numbers are spliced (spliceMonthly). A newer input cancels the runs in
// flight and drops their results; a run that fails stops the rest of that scenario's runs from starting.

import { useEffect, useMemo, useState } from "react";
import type { ProcessBundle, SolutionRow } from "@transpera-flow/db";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { retiredSteps } from "@/lib/scenarios/broken";
import { SimulationCancelled } from "@/lib/sim/client";
import { monthBounds } from "@/lib/forecast/positions";
import { runSegments, sharedSimPool } from "@/lib/forecast/sim-pool";
import { spliceMonthly } from "@/lib/forecast/splice";
import type { EffectiveChange } from "./effective";
import { scenarioModel, scenarioSegments, type ChangeProblem } from "./run";

/** Re-runs wait this long after the last change, so a key held down or changes moved one after another run once. */
const DEBOUNCE_MS = 150;

export interface ScenarioRun {
  model: EngineModel;
  result: SimulationResult;
  /** The model without the scenario: what Settings' own hires and leave are drawn from. */
  markersModel: EngineModel;
  /** Ids of the people the scenario added (its hires, and the second row of an FTE change). */
  planPeople: Set<string>;
}

export interface ScenarioForecast {
  status: "idle" | "running" | "done" | "error";
  /** The last finished run (kept while a newer one runs). */
  run: ScenarioRun | null;
  problems: ChangeProblem[];
  /** Ids of changes dated at or after the horizon, left out of the run. */
  later: string[];
  error: string | null;
  /** Runs finished in this scenario's segments, and how many there are. */
  progress: [done: number, total: number];
  /** How many runs have finished since the page opened (for tests and the timeline's status attributes). */
  finished: number;
}

interface Prepared {
  segments: { from: number; model: EngineModel }[];
  monthStarts: number[];
  markersModel: EngineModel;
  planPeople: Set<string>;
  problems: ChangeProblem[];
  later: string[];
  error: string | null;
}

const IDLE: ScenarioForecast = { status: "idle", run: null, problems: [], later: [], error: null, progress: [0, 0], finished: 0 };

export function useScenarioRun({
  bundle,
  changes,
  solutions,
  months,
  startDate,
}: {
  bundle: ProcessBundle;
  /** The effective changes (parents first); null: nothing to run (the hook stays idle). */
  changes: readonly EffectiveChange[] | null;
  solutions: readonly SolutionRow[];
  months: number;
  startDate: string;
}): ScenarioForecast {
  // The models, by the inputs' identity, so a re-render with the same inputs doesn't run anything again.
  const prepared = useMemo((): Prepared | null => {
    if (changes === null) return null;
    const retired = retiredSteps(bundle);
    const live = scenarioModel(bundle, months, startDate);
    const fail = (error: string): Prepared => ({ segments: [], monthStarts: [], markersModel: null as unknown as EngineModel, planPeople: new Set(), problems: [], later: [], error });
    if (live.error !== null) return fail(live.error);
    const bounds = monthBounds(live.monthStarts, live.model.horizonWeeks * live.model.hoursPerWeek);
    const plan = scenarioSegments(bundle, changes, solutions, startDate, bounds, live.model.hoursPerWeek);
    if (plan.error !== null) return { ...fail(plan.error), problems: plan.problems, later: plan.later };
    const names = new Map(solutions.map((s) => [s.id, s.name]));
    const segments: Prepared["segments"] = [];
    const problems: ChangeProblem[] = [...plan.problems];
    const seen = new Set(problems.map((p) => p.changeId + p.message));
    let error: string | null = null;
    for (const seg of plan.segments) {
      const built = scenarioModel(seg.bundle, months, startDate, seg.patches, seg.patchChangeIds, retired);
      if (built.error !== null) {
        const solutionNames = seg.solutionIds.map((id) => names.get(id) ?? "A solution");
        // The last solution to go live is the one that changed this segment.
        error = seg.from === 0 && !solutionNames.length ? built.error : `“${solutionNames[solutionNames.length - 1] ?? "A solution"}” can't be simulated: ${built.error}`;
        break;
      }
      for (const p of built.problems) {
        if (seen.has(p.changeId + p.message)) continue;
        seen.add(p.changeId + p.message);
        problems.push(p);
      }
      segments.push({ from: seg.from, model: built.model });
    }
    return { segments, monthStarts: live.monthStarts, markersModel: live.model, planPeople: plan.planPeople, problems, later: plan.later, error };
  }, [bundle, changes, solutions, months, startDate]);

  const [state, setState] = useState<{ status: ScenarioForecast["status"]; run: ScenarioRun | null; error: string | null; progress: [number, number]; finished: number }>({
    status: "idle",
    run: null,
    error: null,
    progress: [0, 0],
    finished: 0,
  });

  useEffect(() => {
    if (!prepared) {
      setState((s) => (s.status === "idle" && !s.run ? s : { ...s, status: "idle", run: null, error: null, progress: [0, 0] }));
      return;
    }
    if (prepared.error !== null || !prepared.segments.length) {
      setState((s) => ({ ...s, status: "error", error: prepared.error ?? "The scenario can't be simulated.", progress: [0, 0] }));
      return;
    }
    let active = true;
    let cancelJob: (() => void) | null = null;
    const total = prepared.segments.length;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, status: "running", error: null, progress: [0, total] }));
      try {
        // Every segment is asked of the page's shared pool at once: it runs a few at a time, shares runs in flight with the other
        // scenarios on the page, and keeps finished ones.
        const job = runSegments(sharedSimPool(), prepared.segments, prepared.monthStarts, (done, count) => {
          if (active) setState((s) => ({ ...s, progress: [done, count] }));
        });
        cancelJob = job.cancel;
        const results = await job.results;
        if (!active) return;
        const runs = prepared.segments.map((seg, i) => ({ from: seg.from, result: results[i]! }));
        const first = runs[0]!.result;
        const monthly = spliceMonthly(runs.map((r) => ({ from: r.from, monthly: r.result.monthly! })));
        const run: ScenarioRun = { model: prepared.segments[0]!.model, result: { ...first, monthly }, markersModel: prepared.markersModel, planPeople: prepared.planPeople };
        setState((s) => ({ status: "done", run, error: null, progress: [total, total], finished: s.finished + 1 }));
      } catch (err) {
        if (active && !(err instanceof SimulationCancelled)) setState((s) => ({ ...s, status: "error", error: (err as Error).message }));
      }
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      // A newer input drops what is running: runs nobody else wants are stopped.
      cancelJob?.();
    };
  }, [prepared]);

  if (!prepared) return IDLE;
  // A scenario that fails has no numbers: the page shows the failure, never the previous scenario's numbers under this one's name.
  const status = prepared.error !== null ? "error" : state.status === "idle" ? "running" : state.status;
  return { status, run: status === "error" ? null : state.run, problems: prepared.problems, later: prepared.later, error: prepared.error ?? state.error, progress: state.progress, finished: state.finished };
}
