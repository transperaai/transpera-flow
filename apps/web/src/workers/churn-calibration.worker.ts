/// <reference lib="webworker" />
// The churn back-solve, off the main thread (issue #41, part 2): up to four simulations of each process's model, posting
// which run it is on, then the answers once all are done.
import { backSolveChurn, type BackSolvedChurn } from "@transpera-flow/engine";
import type { ChurnMessage, ChurnRequest } from "@/lib/calibration/backsolve";

self.onmessage = (event: MessageEvent<ChurnRequest>) => {
  const req = event.data;
  try {
    const solved: BackSolvedChurn[] = [];
    req.jobs.forEach((job, i) => {
      solved.push(
        backSolveChurn(job.model, job.measured, {
          onRun: (run) => self.postMessage({ id: req.id, kind: "run", job: i, jobs: req.jobs.length, run } satisfies ChurnMessage),
        }),
      );
    });
    self.postMessage({ id: req.id, kind: "done", solved } satisfies ChurnMessage);
  } catch (err) {
    self.postMessage({ id: req.id, kind: "error", error: err instanceof Error ? err.message : String(err) } satisfies ChurnMessage);
  }
};
