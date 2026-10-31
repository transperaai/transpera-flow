"use client";

// The free-play Sandbox's runs (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md section 3): today's path once, then the changed path every time a
// lever moves (after a short pause, so a held key runs once), in a small pool of simulation workers, with progress. The replications are the Capacity
// page's count for the 12-month run (YEAR_REPS). A finished run is kept by what it was run from (the model, the months' edges, the reps, the seed), so a
// lever put back where it was costs nothing and today's path is never run twice. A newer lever cancels the runs in flight and drops their results.

import { useEffect, useMemo, useState } from "react";
import { playIsDefault, playSeries, type CapacityChangeRow, type CapacitySetup, type PlayOutcome, type PlayState } from "@transpera-flow/db";
import { joinPlay, type ChangeProblem, type PreparedPlay, type ScenarioRun } from "@transpera-flow/db/sandbox";
import { SimulationCancelled, type WorkerLike } from "@/lib/sim/client";
import { SimPool, runKey, runSegments } from "@/lib/forecast/sim-pool";
import { YEAR_REPS } from "@/lib/capacity/runs";

const DEBOUNCE_MS = 200;

let pool: SimPool | null = null;
/** The page's own pool: the Capacity page's replications for a year, apart from the old Sandbox's 30. */
export function playPool(): SimPool {
  return (pool ??= new SimPool(() => new Worker(new URL("../../workers/simulate.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike, 3, YEAR_REPS));
}

export interface PlayRun {
  run: ScenarioRun;
  outcome: PlayOutcome;
  /** Wall-clock milliseconds the runs took. */
  ms: number;
}

export interface PlayRuns {
  status: "running" | "done" | "error";
  /** Today's path (null until it has run). */
  today: PlayRun | null;
  /** The levers' path: today's path itself while nothing has moved; the last finished run while a newer one is running. */
  changed: PlayRun | null;
  error: string | null;
  /** Runs finished of the runs this change needs, for a progress line. */
  progress: [done: number, total: number];
  problems: ChangeProblem[];
  /** Whether `changed` is the run for the levers as they are now. */
  current: boolean;
}

interface Slot {
  key: string;
  run: PlayRun;
}

export function usePlayRuns(setup: CapacitySetup, play: PlayState, library: readonly CapacityChangeRow[], today: PreparedPlay, prepare: (play: PlayState, library: readonly CapacityChangeRow[]) => PreparedPlay): PlayRuns {
  const asDefault = playIsDefault(play);
  const prepared = useMemo(() => (asDefault ? today : prepare(play, library)), [asDefault, today, prepare, play, library]);
  const todayKey = useMemo(() => today.segments.map((s) => `${s.from}:${runKey(s.model, today.monthStarts, today.start, YEAR_REPS)}`).join("|"), [today]);
  // The changes swapped in are part of what the run was run from (editing one re-runs it).
  const swappedKey = useMemo(() => JSON.stringify(library.filter((c) => play.blocks[c.id] !== undefined)), [library, play.blocks]);
  const preparedKey = useMemo(() => (asDefault ? todayKey : JSON.stringify(play) + "|" + swappedKey + "|" + prepared.segments.map((s) => s.from).join(",")), [asDefault, todayKey, play, swappedKey, prepared]);

  const [todaySlot, setTodaySlot] = useState<Slot | null>(null);
  const [changedSlot, setChangedSlot] = useState<Slot | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [progress, setProgress] = useState<{ key: string; done: number; total: number } | null>(null);

  // Today's path, once per workspace model.
  useEffect(() => {
    if (today.error !== null) return;
    let active = true;
    const job = runSegments(playPool(), today.segments, today.monthStarts, () => undefined, today.start);
    const t0 = performance.now();
    job.results.then(
      (results) => {
        if (!active) return;
        const run = joinPlay(today, results);
        const outcome = playSeries(setup, { leavers: [], hires: [] }, run.model, run.result);
        setTodaySlot({ key: todayKey, run: { run, outcome, ms: performance.now() - t0 } });
      },
      (err) => {
        if (active && !(err instanceof SimulationCancelled)) setFailure({ key: todayKey, message: (err as Error).message });
      },
    );
    return () => {
      active = false;
      job.cancel();
    };
  }, [today, todayKey, setup]);

  // The changed path, after the levers settle.
  useEffect(() => {
    if (asDefault || prepared.error !== null) return;
    let active = true;
    let cancel: (() => void) | null = null;
    const total = prepared.segments.length;
    const timer = setTimeout(() => {
      setProgress({ key: preparedKey, done: 0, total });
      const t0 = performance.now();
      const job = runSegments(playPool(), prepared.segments, prepared.monthStarts, (done) => active && setProgress({ key: preparedKey, done, total }), prepared.start);
      cancel = job.cancel;
      job.results.then(
        (results) => {
          if (!active) return;
          const run = joinPlay(prepared, results);
          const outcome = playSeries(setup, play, run.model, run.result);
          setChangedSlot({ key: preparedKey, run: { run, outcome, ms: performance.now() - t0 } });
        },
        (err) => {
          if (active && !(err instanceof SimulationCancelled)) setFailure({ key: preparedKey, message: (err as Error).message });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      cancel?.();
    };
    // `play` is in `preparedKey`; `prepared` follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asDefault, prepared, preparedKey, setup]);

  const todayRun = todaySlot?.key === todayKey ? todaySlot.run : null;
  const changed = asDefault ? todayRun : (changedSlot?.run ?? null);
  const current = asDefault ? todayRun !== null : changedSlot?.key === preparedKey;
  const error = today.error ?? (asDefault ? null : prepared.error) ?? (failure && (failure.key === todayKey || failure.key === preparedKey) ? failure.message : null);
  const status: PlayRuns["status"] = error !== null ? "error" : !todayRun || (!asDefault && !current) ? "running" : "done";
  const shown: [number, number] = progress && progress.key === preparedKey ? [progress.done, progress.total] : [0, prepared.segments.length];
  return { status, today: todayRun, changed, error, progress: current ? [shown[1], shown[1]] : shown, problems: prepared.problems, current };
}
