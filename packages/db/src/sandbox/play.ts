// A free-play run, prepared (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md sections 2 and 3): the levers' registry changes go through the
// existing runner (`prepareScenario`: people rows, spliced map versions, monthly channels), and the levers the registry has no lever for are edits to
// each segment's model (`applyPlay`). Pure: no React, no worker. The web app runs the segments on its pool and joins them with `joinPlay`.

import type { EngineModel, InitialState, SimulationResult } from "@transpera-flow/engine";
import { applyPlay, playChanges, playIsDefault, type PlayContext, type PlayState } from "../sandbox-play";
import type { ProcessBundle, SolutionRow } from "../types";
import { joinRun, type ScenarioRun } from "./execute";
import { prepareScenario, type ChangeProblem, type PreparedScenario } from "./run";

/** What a free-play run needs: its segments (one run of the whole year, or one more for each month a map version goes live), ready to run. */
export interface PreparedPlay {
  segments: { from: number; model: EngineModel }[];
  monthStarts: number[];
  /** The warm-up every segment starts from, so the months before a lever acts equal today's path exactly. */
  start: InitialState | null;
  problems: ChangeProblem[];
  /** Why it can't run (plain words), or null. */
  error: string | null;
  /** Levers that were left out because their month is past the run, by change id. */
  later: string[];
  /** The scenario the segments came from, for `joinPlay`. */
  prepared: PreparedScenario;
}

/** The segments for `play` on `bundle`: the model of each segment with every lever applied. */
export function preparePlay(bundle: ProcessBundle, play: PlayState, ctx: PlayContext, solutions: readonly SolutionRow[], months = 12): PreparedPlay {
  const effective = playChanges(play, ctx).map((change) => ({ change, scenarioId: "play", scenarioName: "Free play", inherited: false }));
  const prepared = prepareScenario(bundle, effective, solutions, months, ctx.startDate, { pair: false });
  const edited = playIsDefault(play)
    ? prepared
    : { ...prepared, segments: prepared.segments.map((s) => ({ from: s.from, model: applyPlay(s.model, play, ctx, prepared.planPeople) })) };
  return { segments: edited.segments, monthStarts: prepared.monthStarts, start: prepared.start, problems: prepared.problems, error: prepared.error, later: prepared.later, prepared: edited };
}

/**
 * The runs of `plan`'s segments as one: months spliced. The churn causes are the last segment's (it runs the whole year with every lever in force by
 * then, the price rise included), since a spliced run's other figures are the first segment's alone.
 */
export function joinPlay(plan: PreparedPlay, results: SimulationResult[]): ScenarioRun {
  const run = joinRun(plan.prepared, plan.segments, results);
  const last = results[results.length - 1]!;
  return { ...run, result: { ...run.result, ...(last.churnCauses ? { churnCauses: last.churnCauses } : {}) } };
}
