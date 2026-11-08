"use client";

// Runs a Sandbox scenario (docs/plans/sandbox-p1-brief.md §3): the live model with the scenario's changes in it, and, for each month
// a spliced change takes effect, one more run with everything in force by then (scenarioSegments). The runs are spread over a shared
// pool of up to three workers (shared by every scenario on the page, with a map of runs in flight so an identical run is computed
// once), with the same seed as the live forecast (so a difference comes from the scenario, not from chance), and finished runs are
// kept by what they were run from. Their month-by-month numbers are spliced (spliceMonthly). A newer input cancels the runs in
// flight and drops their results; a run that fails stops the rest of that scenario's runs from starting.

import { useEffect, useMemo, useState } from "react";
import type { ProcessBundle, SolutionRow } from "@transpera-flow/db";
import { SimulationCancelled } from "@/lib/sim/client";
import { runSegments, sharedSimPool } from "@/lib/forecast/sim-pool";
import { joinRun, prepareScenario, priceRiseOf, type ChangeProblem, type EffectiveChange, type PreparedScenario, type PriceRiseTradeoff, type ScenarioRun } from "@transpera-flow/db/sandbox";

export type { ScenarioRun };

/** Re-runs wait this long after the last change, so a key held down or changes moved one after another run once. */
const DEBOUNCE_MS = 150;

export interface ScenarioForecast {
  status: "idle" | "running" | "done" | "error";
  /** The last finished run (kept while a newer one runs). */
  run: ScenarioRun | null;
  problems: ChangeProblem[];
  /** Ids of changes dated at or after the horizon, left out of the run. */
  later: string[];
  error: string | null;
  /** With a price rise (B5), once it and the same scenario without it have run: what it gains, loses and nets. */
  priceRise: PriceRiseTradeoff | null;
  /** Runs finished in this scenario's segments (and its price-rise pair), and how many there are. */
  progress: [done: number, total: number];
  /** How many runs have finished since the page opened (for tests and the timeline's status attributes). */
  finished: number;
}

const IDLE: ScenarioForecast = { status: "idle", run: null, problems: [], later: [], error: null, priceRise: null, progress: [0, 0], finished: 0 };

export function useScenarioRun({
  bundle,
  changes,
  solutions,
  months,
  startDate,
  pair = true,
}: {
  bundle: ProcessBundle;
  /** The effective changes (parents first); null: nothing to run (the hook stays idle). */
  changes: readonly EffectiveChange[] | null;
  solutions: readonly SolutionRow[];
  months: number;
  startDate: string;
  /** false: skip a price rise's paired run (no `priceRise`), for a caller that only reads the run itself (the hire payback). */
  pair?: boolean;
}): ScenarioForecast {
  // The models, by the inputs' identity, so a re-render with the same inputs doesn't run anything again.
  const prepared = useMemo((): PreparedScenario | null => (changes === null ? null : prepareScenario(bundle, changes, solutions, months, startDate, { pair })), [bundle, changes, solutions, months, startDate, pair]);

  const [state, setState] = useState<{ status: ScenarioForecast["status"]; run: ScenarioRun | null; priceRise: PriceRiseTradeoff | null; error: string | null; progress: [number, number]; finished: number }>({
    status: "idle",
    run: null,
    priceRise: null,
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
    const pairSegments = prepared.pair ?? [];
    const total = prepared.segments.length + pairSegments.length;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, status: "running", error: null, progress: [0, total] }));
      try {
        // Every segment (and the price rise's pair) is asked of the page's shared pool at once: it runs a few at a time, shares runs in
        // flight with the other scenarios on the page, and keeps finished ones.
        let doneMain = 0;
        let donePair = 0;
        const report = () => {
          if (active) setState((s) => ({ ...s, progress: [doneMain + donePair, total] }));
        };
        const job = runSegments(sharedSimPool(), prepared.segments, prepared.monthStarts, (done) => ((doneMain = done), report()), prepared.start);
        const pairJob = pairSegments.length ? runSegments(sharedSimPool(), pairSegments, prepared.monthStarts, (done) => ((donePair = done), report()), prepared.start) : null;
        cancelJob = () => {
          job.cancel();
          pairJob?.cancel();
        };
        const [results, pairResults] = await Promise.all([job.results, pairJob?.results ?? Promise.resolve(null)]);
        if (!active) return;
        const run = joinRun(prepared, prepared.segments, results);
        const priceRise = pairResults ? priceRiseOf(prepared, run, joinRun(prepared, pairSegments, pairResults)) : null;
        setState((s) => ({ status: "done", run, priceRise, error: null, progress: [total, total], finished: s.finished + 1 }));
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
  return { status, run: status === "error" ? null : state.run, priceRise: status === "error" ? null : state.priceRise, problems: prepared.problems, later: prepared.later, error: prepared.error ?? state.error, progress: state.progress, finished: state.finished };
}
