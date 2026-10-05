import type { ProcessBundle, StepRow } from "@transpera-flow/db";
import type { SimulationResult } from "@transpera-flow/engine";
import type { PlaybackGraph, PlaybackRun } from "./trace-index";
import type { PlaybackStep } from "./use-playback";

/**
 * The drawn map as playback sees it: every edge, the start step, and the end
 * step for each outcome. `toEngineModel` makes the single won and lost end
 * steps the engine's sinks, so an entity's outcome names the end it reached.
 */
export function playbackGraph(bundle: ProcessBundle): PlaybackGraph {
  const start = bundle.steps.find((s) => s.kind === "start")?.id ?? null;
  const ends: PlaybackGraph["ends"] = {};
  const servicing = bundle.process.kind === "servicing";
  for (const s of bundle.steps) {
    if (s.kind === "end" && (s.outcome === "won" || s.outcome === "lost") && !ends[s.outcome]) ends[s.outcome] = s.id;
    // A servicing task ends at its process's end, whatever the end's outcome (issue #19).
    if (servicing && s.kind === "end" && !ends.done) ends.done = s.id;
  }
  return { edges: bundle.edges.map((e) => ({ id: e.id, from: e.from_step_id, to: e.to_step_id })), start, ends };
}

/**
 * Replication 0's trace, or null when the run kept none: the items on the
 * drawn process only. A run carries the pipeline's items and every servicing
 * task (issue #19); a pipeline shows its leads, a servicing process its own
 * tasks, each ending `done` when it reaches the process's end.
 */
export function playbackRun(result: SimulationResult, process?: Pick<ProcessBundle["process"], "id" | "kind"> | "all"): PlaybackRun | null {
  if (!result.trace) return null;
  // The company map (issue #173) plays everything: the pipeline's items and every servicing task.
  if (process === "all") {
    const entities = result.trace.map((e) => (e.servicing && e.done !== undefined ? { ...e, outcome: "done" as const } : e));
    return { entities, H: result.H, seededWip: result.initialState.kind === "wip" };
  }
  const entities =
    process?.kind === "servicing"
      ? result.trace.filter((e) => e.servicing?.process === process.id).map((e) => (e.done !== undefined ? { ...e, outcome: "done" as const } : e))
      : result.trace.filter((e) => !e.servicing);
  return { entities, H: result.H, seededWip: result.initialState.kind === "wip" };
}

/**
 * The steps playback labels when steps inside closed groups roll up into the card that holds them (the company map, issue
 * #173): every card drawn, each with the steps it stands for (itself, or everything inside it while it is closed). A step
 * inside a closed group is drawn by the outermost closed group around it.
 */
export function rolledUpSteps(steps: readonly Pick<StepRow, "id" | "name" | "kind" | "parent_step_id">[], open: ReadonlySet<string>): PlaybackStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const drawnAs = (id: string): string => {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let at = byId.get(id)?.parent_step_id ?? null; at && !seen.has(at); at = byId.get(at)?.parent_step_id ?? null) {
      seen.add(at);
      chain.unshift(at);
    }
    return chain.find((g) => !open.has(g)) ?? id;
  };
  const members = new Map<string, string[]>();
  for (const s of steps) {
    if (s.kind === "start") continue;
    const at = drawnAs(s.id);
    let list = members.get(at);
    if (!list) members.set(at, (list = []));
    list.push(s.id);
  }
  return steps.flatMap((s): PlaybackStep[] => {
    const list = members.get(s.id);
    if (!list) return [];
    return [{ id: s.id, name: s.name, kind: s.kind === "end" ? "end" : "work", members: list }];
  });
}
