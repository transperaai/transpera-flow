import { describe, expect, it } from "vitest";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { runKey, runSegments, SimPool } from "@/lib/forecast/sim-pool";
import { SimulationCancelled, type WorkerLike } from "@/lib/sim/client";
import type { SimRequest, SimResponse } from "@/lib/sim/protocol";

// The shared worker pool for plan runs (B7, issue #36), with fake workers: runs are shared and kept, a failure stops the rest
// of a plan from starting, progress is counted outside any state updater, and runs nobody wants are dropped or stopped.

const model = (n: number) => ({ n }) as unknown as EngineModel;
const modelOf = (req: SimRequest) => (req.model as unknown as { n: number }).n;
const result = (n: number) => ({ n }) as unknown as SimulationResult;

/** Fake workers: each posted run is answered on the next tick, by `answer`; "hang" never answers. */
function fakeWorkers(answer: (n: number) => "ok" | "fail" | "hang" = () => "ok") {
  const posted: number[] = [];
  const terminated: number[] = [];
  const create = (): WorkerLike => {
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (req) => {
        const n = modelOf(req);
        posted.push(n);
        const how = answer(n);
        if (how === "hang") return;
        setTimeout(() => {
          const msg: SimResponse = how === "ok" ? { id: req.id, ok: true, result: result(n), durationMs: 1 } : { id: req.id, ok: false, error: `run ${n} failed` };
          w.onmessage?.({ data: msg } as MessageEvent<SimResponse>);
        }, 1);
      },
      terminate: () => void terminated.push(posted.at(-1)!),
    };
    return w;
  };
  return { create, posted, terminated };
}

const STARTS = [100, 200];

describe("the shared simulation pool", () => {
  it("runs a plan's segments a few at a time and counts progress once per finished run, in order", async () => {
    const f = fakeWorkers();
    const pool = new SimPool(f.create, 2);
    const progress: [number, number][] = [];
    const job = runSegments(pool, [0, 1, 2, 3, 4].map((n) => ({ model: model(n) })), STARTS, (d, t) => progress.push([d, t]));
    const results = await job.results;
    expect(results.map((r) => (r as unknown as { n: number }).n)).toEqual([0, 1, 2, 3, 4]);
    // One call per finished run, 1, 2, 3...: never skipping or repeating (a state updater run twice by StrictMode would).
    expect(progress.map(([d]) => d)).toEqual([1, 2, 3, 4, 5]);
    expect(progress.every(([, t]) => t === 5)).toBe(true);
    pool.dispose();
  });

  it("starts no more segments once one fails", async () => {
    // Segment 1 fails; with two workers, segments 0 and 1 are running, 2 to 4 are waiting.
    const f = fakeWorkers((n) => (n === 1 ? "fail" : n === 0 ? "hang" : "ok"));
    const pool = new SimPool(f.create, 2);
    const job = runSegments(pool, [0, 1, 2, 3, 4].map((n) => ({ model: model(n) })), STARTS, () => {});
    await expect(job.results).rejects.toThrow("run 1 failed");
    await new Promise((r) => setTimeout(r, 20));
    expect(f.posted.sort()).toEqual([0, 1]);
    pool.dispose();
  });

  it("computes an identical run once, whoever asks, in flight or after", async () => {
    const f = fakeWorkers();
    const pool = new SimPool(f.create, 3);
    const a = runSegments(pool, [{ model: model(7) }, { model: model(8) }], STARTS, () => {});
    const b = runSegments(pool, [{ model: model(7) }, { model: model(9) }], STARTS, () => {});
    await Promise.all([a.results, b.results]);
    expect(f.posted.filter((n) => n === 7)).toHaveLength(1);
    expect([...f.posted].sort()).toEqual([7, 8, 9]);
    // Finished: kept.
    await runSegments(pool, [{ model: model(8) }], STARTS, () => {}).results;
    expect(f.posted).toHaveLength(3);
    // A different month layout is a different run.
    await runSegments(pool, [{ model: model(8) }], [300], () => {}).results;
    expect(f.posted).toHaveLength(4);
    pool.dispose();
  });

  it("uses a result it was given (the live forecast's own run) without running it", async () => {
    const f = fakeWorkers();
    const pool = new SimPool(f.create, 3);
    pool.seed(runKey(model(1), STARTS), result(1));
    expect(await pool.request(model(1), STARTS).promise).toEqual(result(1));
    expect(f.posted).toEqual([]);
    pool.dispose();
  });

  it("keeps a shared run going while anyone still wants it, and stops it when nobody does", async () => {
    const f = fakeWorkers(() => "hang");
    const pool = new SimPool(f.create, 3);
    const one = pool.request(model(5), STARTS);
    const two = pool.request(model(5), STARTS);
    expect(f.posted).toEqual([5]);
    one.release();
    expect(f.terminated).toEqual([]);
    two.release();
    expect(f.terminated).toEqual([5]);
    await expect(two.promise).rejects.toBeInstanceOf(SimulationCancelled);
    pool.dispose();
  });

  it("drops a run that hasn't started when nobody wants it any more", async () => {
    const f = fakeWorkers(() => "hang");
    const pool = new SimPool(f.create, 1);
    pool.request(model(0), STARTS);
    const waiting = pool.request(model(1), STARTS);
    waiting.release();
    await expect(waiting.promise).rejects.toBeInstanceOf(SimulationCancelled);
    expect(f.posted).toEqual([0]);
    pool.dispose();
  });
});
