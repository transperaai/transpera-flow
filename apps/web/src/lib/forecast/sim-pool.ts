// One small pool of simulation workers for every plan on the Forecast page (B7, issue #36). The live forecast, the plan on
// screen and both plans of the compare view ask the same pool, so they share at most `size` workers and never compute the
// same run twice: a finished run is kept by what it was run from, and a run in flight is shared by everyone who asked for it
// (a map of runs in flight). A run nobody wants any more (every asker released it) is dropped before it starts or stopped
// while it runs. Pure of React: tested with fake workers.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { SimulationCancelled, SimulationClient, type WorkerLike } from "@/lib/sim/client";

export const REPS = 30;
export const SEED = 1;
/** The most workers a page runs at once. */
export const POOL_SIZE = 3;
/** Finished runs kept, most recently used last. */
const CACHE_LIMIT = 24;
/** A pool with nothing to do for this long lets its workers go (they start again when asked). */
const IDLE_MS = 20_000;

/** What a run was run from: the model, the months' edges, the reps and the seed. */
export const runKey = (model: EngineModel, monthStarts: readonly number[]): string => `${JSON.stringify(model)}|${monthStarts.join(",")}|${REPS}|${SEED}`;

/** A request for a run: its result, and a way to say it isn't wanted any more. */
export interface RunRequest {
  promise: Promise<SimulationResult>;
  /** Nobody needs this result: dropped if it hasn't started, stopped if it has and nobody else asked for it. */
  release: () => void;
}

interface Entry {
  key: string;
  model: EngineModel;
  monthStarts: number[];
  refs: number;
  running: boolean;
  client: SimulationClient | null;
  promise: Promise<SimulationResult>;
  resolve: (r: SimulationResult) => void;
  reject: (e: unknown) => void;
}

export class SimPool {
  private readonly clients: SimulationClient[] = [];
  private readonly free: SimulationClient[] = [];
  private readonly queue: Entry[] = [];
  private readonly flight = new Map<string, Entry>();
  private readonly cache = new Map<string, SimulationResult>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Runs sent to a worker so far (for tests). */
  started = 0;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly size = POOL_SIZE,
  ) {}

  /** Keep a result that is already known (the live forecast's own run), so nobody runs it again. */
  seed(key: string, result: SimulationResult): void {
    this.remember(key, result);
  }

  request(model: EngineModel, monthStarts: number[]): RunRequest {
    const key = runKey(model, monthStarts);
    const hit = this.cache.get(key);
    if (hit) {
      this.remember(key, hit);
      return { promise: Promise.resolve(hit), release: () => {} };
    }
    let entry = this.flight.get(key);
    if (!entry) {
      let resolve!: Entry["resolve"];
      let reject!: Entry["reject"];
      const promise = new Promise<SimulationResult>((res, rej) => ((resolve = res), (reject = rej)));
      // A run nobody is waiting for any more rejects without anyone to hear it.
      promise.catch(() => {});
      entry = { key, model, monthStarts, refs: 0, running: false, client: null, promise, resolve, reject };
      this.flight.set(key, entry);
      this.queue.push(entry);
      this.pump();
    }
    entry.refs++;
    let released = false;
    const e = entry;
    return {
      promise: e.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--e.refs > 0) return;
        this.flight.delete(e.key);
        const queued = this.queue.indexOf(e);
        if (queued >= 0) this.queue.splice(queued, 1);
        // Stopping a worker rejects its run with `SimulationCancelled`, which settles the entry and frees the slot.
        else if (e.running) e.client?.cancel();
        if (queued >= 0) e.reject(new SimulationCancelled());
      },
    };
  }

  /** Stop everything and let the workers go. */
  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    for (const c of this.clients) c.dispose();
    this.clients.length = 0;
    this.free.length = 0;
  }

  private remember(key: string, result: SimulationResult) {
    this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }

  private take(): SimulationClient | null {
    const c = this.free.pop();
    if (c) return c;
    if (this.clients.length >= this.size) return null;
    const created = new SimulationClient(this.createWorker);
    this.clients.push(created);
    return created;
  }

  private pump() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    for (;;) {
      if (!this.queue.length) break;
      const client = this.take();
      if (!client) break;
      const entry = this.queue.shift()!;
      entry.running = true;
      entry.client = client;
      this.started++;
      client
        .run(entry.model, { reps: REPS, seed: SEED, monthly: true, monthStarts: entry.monthStarts })
        .then((run) => {
          this.remember(entry.key, run.result);
          entry.resolve(run.result);
        })
        .catch((err) => entry.reject(err))
        .finally(() => {
          if (this.flight.get(entry.key) === entry) this.flight.delete(entry.key);
          this.free.push(client);
          // The next run starts after whoever was waiting for this one has had its say: a plan whose run failed releases its
          // other runs first, so none of them start.
          setTimeout(() => {
            this.pump();
            if (!this.queue.length && this.free.length === this.clients.length) {
              this.idle = setTimeout(() => this.dispose(), IDLE_MS);
              (this.idle as { unref?: () => void }).unref?.();
            }
          }, 0);
        });
    }
  }
}

/**
 * Ask the pool for every run of a plan at once and wait for them all. Results come back in the order asked; `onProgress` is
 * told how many have finished (a plain callback, called once per finished run). When one fails, the rest are released at
 * once, so runs that haven't started never start. `cancel` releases everything (a newer input arrived).
 */
export function runSegments(
  pool: SimPool,
  segments: { model: EngineModel }[],
  monthStarts: number[],
  onProgress: (done: number, total: number) => void,
): { results: Promise<SimulationResult[]>; cancel: () => void } {
  const requests = segments.map((s) => pool.request(s.model, monthStarts));
  const cancel = () => requests.forEach((r) => r.release());
  let done = 0;
  const results = Promise.all(
    requests.map((r) =>
      r.promise.then((result) => {
        onProgress(++done, requests.length);
        return result;
      }),
    ),
  ).catch((err) => {
    cancel();
    throw err;
  });
  return { results, cancel };
}

let shared: SimPool | null = null;
/** The page's pool, made when first asked for. */
export function sharedSimPool(): SimPool {
  return (shared ??= new SimPool(() => new Worker(new URL("../../workers/simulate.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike));
}
