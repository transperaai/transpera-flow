import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import type { SimRequest, SimResponse } from "./protocol";

export class SimulationCancelled extends Error {
  constructor() {
    super("Simulation cancelled");
    this.name = "SimulationCancelled";
  }
}

export interface WorkerLike {
  postMessage(message: SimRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<SimResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface SimRun {
  result: SimulationResult;
  durationMs: number;
}

interface Pending {
  id: number;
  resolve: (run: SimRun) => void;
  reject: (err: Error) => void;
}

/**
 * Runs simulations in a Web Worker, one at a time. Starting a new run while
 * one is in flight terminates the worker (the engine is synchronous, so that
 * is the only way to stop it) and rejects the stale run with
 * `SimulationCancelled`.
 */
export class SimulationClient {
  private worker: WorkerLike | null = null;
  private pending: Pending | null = null;
  private nextId = 1;

  constructor(private readonly createWorker: () => WorkerLike) {}

  run(model: EngineModel, { reps = 30, seed = 1, monthly = false }: { reps?: number; seed?: number; monthly?: boolean } = {}): Promise<SimRun> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<SimRun>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      worker.postMessage({ id, model, reps, seed, ...(monthly ? { monthly } : {}) });
    });
  }

  /** Stop the in-flight run, if any. */
  cancel(): void {
    if (!this.pending) return;
    const stale = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    stale.reject(new SimulationCancelled());
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event) => {
      const msg = event.data;
      const p = this.pending;
      if (!p || p.id !== msg.id) return;
      this.pending = null;
      if (msg.ok) p.resolve({ result: msg.result, durationMs: msg.durationMs });
      else p.reject(new Error(msg.error));
    };
    worker.onerror = (event) => {
      const p = this.pending;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      p?.reject(new Error(event.message || "Simulation worker failed"));
    };
    this.worker = worker;
    return worker;
  }
}
