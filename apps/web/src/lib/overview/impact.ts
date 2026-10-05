// What solutions changed, for the Overview (issue #173, B15): each solution's before and after (the version of its process
// it was copied from, and the copy), simulated with the same seed so the two runs line up, as hands-on hours a month and
// time to complete. "Improvement delivered" adds up the ones that were implemented (an issue was resolved by them). The
// numbers aren't stored, so they are simulated on the page, in a worker; this is the pure part.

import { bundleForProcess, toEngineModel, type EdgeRow, type IssueRow, type ProcessBundle, type SolutionRow, type StepRow } from "@transpera-flow/db";
import { bundleFromSolution } from "@/lib/solutions/bundle";
import { effectiveVerdict, type SolutionsData } from "@/lib/solutions/cards";
import type { ImpactPair, SolutionImpact } from "./impact-run";

export { impactNumbers, measureImpact, type ImpactNumbers, type ImpactPair, type SolutionImpact } from "./impact-run";

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
          base: { ...toEngineModel(base), horizonWeeks },
          solved: { ...toEngineModel(bundleFromSolution(base, solution)), horizonWeeks },
        },
      ];
    } catch {
      return [];
    }
  });
}

export interface Delivered {
  /** Implemented solutions counted. */
  count: number;
  /** Hands-on hours a month saved, all together (negative when they added work). */
  hoursSaved: number;
  /** Working days cut from the time to complete, all together; null when no solution changed a completion time. */
  daysCut: number | null;
}

/** "Improvement delivered": what the implemented solutions saved, from each one's before and after. Null when none is implemented. */
export function improvementDelivered(impacts: readonly SolutionImpact[], hoursPerWeek: number): Delivered | null {
  const done = impacts.filter((i) => i.implemented);
  if (!done.length) return null;
  const day = hoursPerWeek / 5;
  const cuts = done.flatMap((i) => (i.before.cycleHours !== null && i.after.cycleHours !== null ? [(i.before.cycleHours - i.after.cycleHours) / day] : []));
  return {
    count: done.length,
    hoursSaved: done.reduce((a, i) => a + i.before.handsOnPerMonth - i.after.handsOnPerMonth, 0),
    daysCut: cuts.length ? cuts.reduce((a, b) => a + b, 0) : null,
  };
}
