// What solutions changed, for the Overview (issue #173, B15): each solution's before and after (the version of its process
// it was copied from, and the copy), simulated with the same seed so the two runs line up, as hands-on hours a month and
// time to complete. "Improvement delivered" adds up the ones that were implemented (an issue was resolved by them). The
// numbers aren't stored, so they are simulated on the page, in a worker; this is the pure part.

import { bundleForProcess, toEngineModel, type EdgeRow, type IssueRow, type ProcessBundle, type SolutionRow, type StepRow } from "@transpera-flow/db";
import { bundleFromSolution } from "@/lib/solutions/bundle";
import { withLeverChanges } from "@/lib/solutions/levers";
import { effectiveVerdict, type SolutionsData } from "@/lib/solutions/cards";
import { hoursAMonth, type ImpactPair, type SolutionImpact } from "./impact-run";

export { hoursAMonth, impactNumbers, measureImpact, type ImpactNumbers, type ImpactPair, type SolutionImpact } from "./impact-run";

/** At most this many solutions are compared on the Overview: each costs two runs. */
export const MAX_COMPARED = 6;

/** The solutions the Overview compares: those implemented first (an issue was resolved by them), then those with a verdict, newest first. */
export function solutionsToCompare(data: Pick<SolutionsData, "solutions" | "links">, issues: readonly Pick<IssueRow, "status" | "resolved_solution_id">[], max = MAX_COMPARED): { solution: SolutionRow; implemented: boolean }[] {
  const implemented = new Set(issues.flatMap((i) => (i.status === "resolved" && i.resolved_solution_id ? [i.resolved_solution_id] : [])));
  const tested = new Set(data.links.filter((l) => effectiveVerdict(l) !== null).map((l) => l.solution_id));
  return data.solutions
    .filter((s) => implemented.has(s.id) || tested.has(s.id))
    .map((solution) => ({ solution, implemented: implemented.has(solution.id) }))
    .sort((a, b) => Number(b.implemented) - Number(a.implemented) || b.solution.created_at.localeCompare(a.solution.created_at) || a.solution.id.localeCompare(b.solution.id))
    .slice(0, max);
}

/** The steps and lines of the version a solution was copied from, when that isn't the live one (loaded by the server). */
export type SolutionBases = Readonly<Record<string, { steps: StepRow[]; edges: EdgeRow[] }>>;

/**
 * Engine models for each solution's before and after, at `horizonWeeks`. The before is its process at the version the copy
 * was made from: live when that is still live, else the steps in `bases`. A solution whose before isn't known, or that
 * can't be simulated, is left out.
 */
export function impactPairs(live: ProcessBundle, chosen: readonly { solution: SolutionRow; implemented: boolean }[], bases: SolutionBases, horizonWeeks: number): ImpactPair[] {
  return chosen.flatMap(({ solution, implemented }) => {
    const current = bundleForProcess(live, solution.process_id);
    if (!current) return [];
    const older = bases[solution.id];
    if (current.revision.id !== solution.base_revision_id && !older) return [];
    const base: ProcessBundle = older ? { ...current, steps: older.steps, edges: older.edges } : current;
    try {
      return [
        {
          id: solution.id,
          name: solution.name,
          implemented,
          processId: solution.process_id,
          processName: current.process.name,
          baseRevisionId: solution.base_revision_id,
          base: { ...toEngineModel(base), horizonWeeks },
          solved: { ...withLeverChanges(toEngineModel(bundleFromSolution(base, solution)), solution.lever_changes ?? []).model, horizonWeeks },
        },
      ];
    } catch {
      return [];
    }
  });
}

export interface Delivered {
  /** Implemented solutions counted: the latest per version of a process they were built from. */
  count: number;
  /** Implemented solutions left out because a later one was built from the same version (counting both would count it twice). */
  superseded: number;
  /** Hands-on hours a month saved, all together, at the demand before (negative when they added work per item). */
  hoursSaved: number;
  /**
   * The biggest cut in working days from one process's time to complete, and that process; null when no solution changed a
   * completion time. Days from different processes don't add up (an item's time to complete is one process's), so it is
   * the largest, named.
   */
  daysCut: { days: number; processName: string } | null;
}

/**
 * "Improvement delivered": what the implemented solutions saved, from each one's before and after. Null when none is
 * implemented (or none could be measured). Two solutions built from the same version of a process each measure against
 * that version, so only the latest (the first in `impacts`, newest first) counts.
 */
export function improvementDelivered(impacts: readonly SolutionImpact[], hoursPerWeek: number): Delivered | null {
  const implemented = impacts.filter((i) => i.implemented);
  const seen = new Set<string>();
  const done = implemented.filter((i) => {
    const key = `${i.processId}:${i.baseRevisionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!done.length) return null;
  const day = hoursPerWeek / 5;
  // Within one process, cuts from successive versions add up; across processes, the largest is shown.
  const byProcess = new Map<string, { days: number; processName: string }>();
  for (const i of done) {
    if (i.before.cycleHours === null || i.after.cycleHours === null) continue;
    const cut = (i.before.cycleHours - i.after.cycleHours) / day;
    const at = byProcess.get(i.processId);
    byProcess.set(i.processId, { days: (at?.days ?? 0) + cut, processName: i.processName });
  }
  const cuts = [...byProcess.values()].sort((a, b) => Math.abs(b.days) - Math.abs(a.days));
  return {
    count: done.length,
    superseded: implemented.length - done.length,
    hoursSaved: done.reduce((a, i) => {
      const h = hoursAMonth(i);
      return a + h.before - h.after;
    }, 0),
    daysCut: cuts[0] ?? null,
  };
}
