// What the process page's Supporting data shows beyond the wait and busy charts (issue #174): the time split per step, the
// cycle time spread, key-person risk and the rework loops, all read off one simulation result. Pure.

import type { EngineModel, SimulationResult, Stat } from "@transpera-flow/engine";
import type { IssueRow } from "@transpera-flow/db";
import { isOnProcess } from "@/lib/processes/rows";
import type { LinkedSolution } from "./track";

export interface TimeSplitRow {
  id: string;
  label: string;
  /** Hours per visit: hands-on, waiting for a person (queue and part-time availability), and fixed waits (outside the team). */
  handsOn: number;
  waitingForPerson: number;
  fixedWait: number;
  total: number;
  /** Hands-on as a share of the whole visit. */
  handsOnShare: number;
}

/** Hands-on versus waiting per step, the steps whose visit takes longest in total first. Needs a run that carries step facts. */
export function timeSplitRows(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>, max = 8): TimeSplitRow[] {
  if (!result?.stepFacts) return [];
  return model.steps
    .flatMap((s) => {
      const f = result.stepFacts![s.id];
      const r = result.steps[s.id];
      if (!f || !r || r.arrivals <= 0 || !stepIds.has(s.id)) return [];
      const waitingForPerson = f.queueWaitHours + f.stretchHours;
      const total = f.handsOnHours + waitingForPerson + f.fixedWaitHours;
      return total > 0 ? [{ id: s.id, label: s.name, handsOn: f.handsOnHours, waitingForPerson, fixedWait: f.fixedWaitHours, total, handsOnShare: f.handsOnShare }] : [];
    })
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
    .slice(0, max);
}

export interface KeyPersonRow {
  id: string;
  step: string;
  /** Who is the only one that can do it; null when nobody can. */
  person: string | null;
  /** The name is one the simulation made up for a role with no named people ("Reviewer 1"), not a person in People. */
  placeholder: boolean;
}

/** Steps only one person can do (and any nobody can do), in process order. */
export function keyPersonRows(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>): KeyPersonRow[] {
  if (!result?.stepFacts) return [];
  return model.steps.flatMap((s): KeyPersonRow[] => {
    const f = result.stepFacts![s.id];
    if (!f || !stepIds.has(s.id)) return [];
    // Without named people the engine makes one up per head-count, keyed "<role>#<n>"; a person in People never has a # in the id.
    if (f.keyPerson) return [{ id: s.id, step: s.name, person: f.keyPerson.personName, placeholder: f.keyPerson.personId.includes("#") }];
    return f.nobodyCanDo ? [{ id: s.id, step: s.name, person: null, placeholder: false }] : [];
  });
}

export interface CycleSpread {
  p50: number;
  p90: number;
  /** How much longer a slow item takes than a typical one (p90 over median), 0 when the median is 0. */
  ratio: number;
}

export function cycleSpread(result: SimulationResult | null): CycleSpread | null {
  const c = result?.kpi.cycle;
  if (!c || !(c.p90 > 0)) return null;
  return { p50: c.p50, p90: c.p90, ratio: c.p50 > 0 ? c.p90 / c.p50 : 0 };
}

export interface LoopRow {
  id: string;
  kind: "redo" | "back-edge";
  /** The step names, in the order items go round them. */
  steps: string[];
  /** Plain description: "Redo at Review" or "Review sends work back to Draft". */
  title: string;
  share: Stat;
  meanRounds: Stat;
  hoursPerMonth: Stat;
  /** Elapsed working hours a trip adds to the average item that enters the loop. */
  extraCycleHours: Stat;
  /** Issues on any of its steps (open or being tested) and solutions that change them. */
  issues: { id: string; number: number | null; label: string }[];
  solutions: { id: string; name: string }[];
}

/** One row per rework loop, biggest cost first, with the issues and solutions that touch its steps. */
export function loopRows(
  model: EngineModel,
  result: SimulationResult | null,
  input: { processId: string; stepIds: ReadonlySet<string>; issues: readonly IssueRow[]; solutions: readonly LinkedSolution["solution"][] },
): LoopRow[] {
  if (!result?.loops) return [];
  const names = new Map(model.steps.map((s) => [s.id, s.name]));
  const name = (id: string) => names.get(id) ?? "a removed step";
  const out: LoopRow[] = [];
  for (const l of result.loops) {
    if (!l.steps.some((id) => input.stepIds.has(id))) continue;
    const mine = new Set(l.steps);
    const issues = input.issues
      .filter((i) => (i.status === "open" || i.status === "testing") && isOnProcess(i, input.processId, input.stepIds))
      .filter((i) => [i.step_id, ...i.links.map((k) => k.step_id)].some((id) => id !== null && mine.has(id)))
      .map((i) => ({ id: i.id, number: i.number, label: `${i.number == null ? "" : `#${i.number} `}${i.title}` }));
    const solutions = input.solutions.filter((s) => s.changed_step_ids.some((id) => mine.has(id))).map((s) => ({ id: s.id, name: s.name }));
    out.push({
      id: l.id,
      kind: l.kind,
      steps: l.steps.map(name),
      title: l.kind === "redo" ? `Redo at ${name(l.from)}` : `${name(l.from)} sends work back to ${name(l.to)}`,
      share: l.share,
      meanRounds: l.meanRounds,
      hoursPerMonth: l.extraHandsOnHoursPerMonthTotal,
      extraCycleHours: l.extraCycleHours,
      issues,
      solutions,
    });
  }
  return out.sort((a, b) => b.hoursPerMonth.mean - a.hoursPerMonth.mean || a.id.localeCompare(b.id));
}
