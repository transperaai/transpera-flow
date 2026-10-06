import type { BackSolvedChurn, EngineModel } from "@transpera-flow/engine";

// The churn back-solve off the main thread (issue #41, part 2): what the page asks the worker for, what it answers, and how
// the answers for each process are put together. Framework-free so it can be tested.

/** One process's model and the measured monthly churn (> 0) of the services it runs, by service id. */
export interface ChurnJob {
  processId: string;
  model: EngineModel;
  measured: Record<string, number>;
}

export interface ChurnRequest {
  id: number;
  jobs: ChurnJob[];
}

export type ChurnMessage =
  | { id: number; kind: "run"; job: number; jobs: number; run: number }
  | { id: number; kind: "done"; solved: BackSolvedChurn[] }
  | { id: number; kind: "error"; error: string };

/** Runs a simulation takes at most (run 0, then up to three more). */
export const MAX_RUNS = 4;

/**
 * One answer from the answers for each process. Services are solved in the process that runs them, so the proposals
 * and reasons are simply joined. Today's simulated checks come from the first process that measures each.
 */
export function mergeSolved(list: readonly BackSolvedChurn[]): BackSolvedChurn | null {
  if (!list.length) return null;
  const first = list[0]!;
  const pick = (k: "late" | "resp" | "onb") => list.map((s) => s.simulated[k]).find((v) => v !== null) ?? null;
  return {
    bases: Object.assign({}, ...list.map((s) => s.bases)),
    multipliers: Object.assign({}, ...list.map((s) => s.multipliers)),
    why: Object.assign({}, ...list.map((s) => s.why)),
    runs: Math.max(...list.map((s) => s.runs)),
    // Only a job that solved something can be approximate.
    converged: list.filter((s) => Object.keys(s.bases).length > 0).every((s) => s.converged),
    simulated: { late: pick("late"), resp: pick("resp"), onb: pick("onb") },
    engineVersion: first.engineVersion,
    seed: first.seed,
    reps: first.reps,
    horizonWeeks: first.horizonWeeks,
  };
}

/** "Measuring today's driver pressure… (run 2 of up to 4)" */
export function progressText(run: number, job: number, jobs: number): string {
  return `Measuring today's driver pressure… (run ${Math.min(MAX_RUNS, run + 1)} of up to ${MAX_RUNS}${jobs > 1 ? `, process ${job + 1} of ${jobs}` : ""})`;
}
