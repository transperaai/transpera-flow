// Running goal seek's probes and the tornado's bars (docs/plans/sandbox-p5-brief.md sections 9 and 10). Each probe is the scenario on screen with
// one more change on the end, prepared and run exactly as the scenario is (the shared runner), but asked of the pool without keeping the result
// (`cache: false`), so the page's own runs stay cached. A `Runner` is "run this scenario's changes": the pool's (the browser), or `syncRunner`
// (tests and the performance check, no workers). Pure of React.

import type { ProcessBundle, SandboxChange, SolutionRow } from "@transpera-flow/db";
import { joinRun, prepareScenario, simulateScenario, type EffectiveChange, type ScenarioRun } from "@transpera-flow/db/sandbox";
import { runSegments, type SimPool } from "@/lib/forecast/sim-pool";
import { SimulationCancelled } from "@/lib/sim/client";
import { addResult, answer, markAsked, nextProbes, startSearch, type Probe, type SeekAnswer, type SeekSpec, type SeekState } from "./goal-seek";
import { rankTornado, type TornadoBar, type TornadoResult, type TornadoVariant } from "./tornado";

export interface Job {
  promise: Promise<ScenarioRun>;
  cancel: () => void;
}
/** Runs the scenario made of `changes` over the page's bundle, solutions, months and start. */
export type Runner = (changes: readonly EffectiveChange[]) => Job;

export interface RunContext {
  bundle: ProcessBundle;
  solutions: readonly SolutionRow[];
  months: number;
  startDate: string;
}

/** A change as one more effective change on the end of the scenario's list. */
export const probeChange = (change: SandboxChange): EffectiveChange => ({ change, scenarioId: "probe", scenarioName: "", inherited: false });

/** The pool's runner: segments asked together, not cached (so many probes don't push the page's own runs out). */
export function poolRunner(pool: SimPool, ctx: RunContext): Runner {
  return (changes) => {
    const prepared = prepareScenario(ctx.bundle, changes, ctx.solutions, ctx.months, ctx.startDate, { pair: false });
    if (prepared.error !== null) return { promise: Promise.reject(new Error(prepared.error)), cancel: () => {} };
    const job = runSegments(pool, prepared.segments, prepared.monthStarts, () => {}, prepared.start, { cache: false });
    return { promise: job.results.then((results) => joinRun(prepared, prepared.segments, results)), cancel: job.cancel };
  };
}

/** A runner on the calling thread, for tests and the performance check: the same preparation, the engine called directly. */
export function syncRunner(ctx: RunContext): Runner {
  return (changes) => {
    try {
      const prepared = prepareScenario(ctx.bundle, changes, ctx.solutions, ctx.months, ctx.startDate, { pair: false });
      if (prepared.error !== null) return { promise: Promise.reject(new Error(prepared.error)), cancel: () => {} };
      const { run } = simulateScenario(prepared, { pair: false });
      return { promise: Promise.resolve(run), cancel: () => {} };
    } catch (e) {
      return { promise: Promise.reject(e), cancel: () => {} };
    }
  };
}

/** A way to stop a search or a tornado: releases every request in flight. */
export class Cancel {
  cancelled = false;
  private readonly jobs = new Set<Job>();
  track(job: Job): Job {
    if (this.cancelled) job.cancel();
    else this.jobs.add(job);
    return job;
  }
  cancel() {
    this.cancelled = true;
    for (const j of this.jobs) j.cancel();
    this.jobs.clear();
  }
}

export interface SeekOutcome {
  state: SeekState;
  answer: SeekAnswer;
  /** False when it was cancelled before it finished. */
  finished: boolean;
}

/**
 * Runs a goal seek: `change(x)` is the scenario's changes with the lever set to x; `measure` reads the number from a run. The two ends go
 * together; after that one probe at a time, so two of the page's three workers stay free. `onProbe` hears each finished probe.
 */
export async function runGoalSeek(spec: SeekSpec, run: Runner, base: readonly EffectiveChange[], change: (x: number) => SandboxChange, measure: (r: ScenarioRun) => number | null, cancel: Cancel, onProbe: (p: Probe, state: SeekState) => void = () => {}): Promise<SeekOutcome> {
  let state = startSearch(spec);
  for (let guard = 0; guard < 12; guard++) {
    if (cancel.cancelled) return { state, answer: answer(state), finished: false };
    const xs = nextProbes(state);
    if (!xs.length) break;
    state = markAsked(state, xs);
    const done = await Promise.all(
      xs.map(async (x) => {
        const job = cancel.track(run([...base, probeChange(change(x))]));
        try {
          return { x, value: measure(await job.promise) };
        } catch (e) {
          if (e instanceof SimulationCancelled || cancel.cancelled) return null;
          throw e;
        }
      }),
    );
    if (done.some((d) => d === null) || cancel.cancelled) return { state, answer: answer(state), finished: false };
    for (const d of done) {
      state = addResult(state, d!.x, d!.value);
      onProbe(state.probes.find((p) => p.x === d!.x)!, state);
    }
  }
  return { state, answer: answer(state), finished: true };
}

export interface TornadoOutcome {
  base: number | null;
  bars: TornadoBar[];
  results: TornadoResult[];
  runs: number;
  finished: boolean;
}

/**
 * Runs the tornado: the scenario once (its value), then every variant's two sides (and a price rise's own baseline), all asked of the runner at
 * once (the pool does three at a time and queues the rest). `onBars` hears the ranked bars each time a lever's last number arrives.
 */
export async function runTornado(variants: readonly TornadoVariant[], run: Runner, base: readonly EffectiveChange[], measure: (r: ScenarioRun) => number | null, cancel: Cancel, onBars: (bars: TornadoBar[], base: number | null, done: number, total: number) => void = () => {}): Promise<TornadoOutcome> {
  const own = cancel.track(run(base));
  const asks = variants.flatMap((v) => [
    { v, side: "low" as const, changes: [...base, probeChange(v.low)] },
    { v, side: "high" as const, changes: [...base, probeChange(v.high)] },
    ...(v.base ? [{ v, side: "base" as const, changes: [...base, probeChange(v.base)] }] : []),
  ]);
  const total = asks.length + 1;
  let done = 0;
  let baseValue: number | null = null;
  const results = new Map<string, TornadoResult>(variants.map((v) => [v.leverId, { leverId: v.leverId, low: null, high: null, ...(v.base ? { base: null } : {}) }]));
  const pending = new Map<string, number>(variants.map((v) => [v.leverId, v.base ? 3 : 2]));
  const emit = () => onBars(baseValue === null ? [] : rankTornado(baseValue, variants, [...results.values()].filter((r) => (pending.get(r.leverId) ?? 0) === 0)), baseValue, done, total);
  try {
    // The scenario's own run first, so the bars have somewhere to start; the rest are already queued behind it.
    const jobs = asks.map((a) => ({ a, job: cancel.track(run(a.changes)) }));
    baseValue = measure(await own.promise);
    done++;
    emit();
    await Promise.all(
      jobs.map(async ({ a, job }) => {
        const value = measure(await job.promise);
        const r = results.get(a.v.leverId)!;
        if (a.side === "low") r.low = value;
        else if (a.side === "high") r.high = value;
        else r.base = value;
        pending.set(a.v.leverId, pending.get(a.v.leverId)! - 1);
        done++;
        emit();
      }),
    );
  } catch (e) {
    if (e instanceof SimulationCancelled || cancel.cancelled) return { base: baseValue, bars: [], results: [...results.values()], runs: done, finished: false };
    throw e;
  }
  const bars = baseValue === null ? [] : rankTornado(baseValue, variants, [...results.values()]);
  return { base: baseValue, bars, results: [...results.values()], runs: done, finished: !cancel.cancelled };
}
