// The issue status track on the process page (issue #174): Open, Solution idea, Being built, Implemented, Verified.
// Derived from what is already stored (the issue's status, the solutions linked to it and their verdicts, and the AI ideas
// waiting for it), so nothing new is saved. Pure: no React, no I/O.

import type { IssueRow, SolutionIssueRow, SolutionRow, SolutionVerdict } from "@transpera-flow/db";
import { effectiveVerdict, type SolutionsData } from "@/lib/solutions/cards";

export const TRACK_STAGES = ["Open", "Solution idea", "Being built", "Implemented", "Verified"] as const;
export type TrackStage = 0 | 1 | 2 | 3 | 4;

export interface LinkedSolution {
  solution: Pick<SolutionRow, "id" | "name" | "process_id" | "changed_step_ids">;
  verdict: SolutionVerdict | null;
  /** Share of simulated runs that meet the target, 0 to 100. */
  holdsPct: number | null;
  /** True when the verdict is the person's own rather than the simulation's. */
  yours: boolean;
}

export interface IssueTrack {
  /** Where the issue is on the track, or null when it was closed without a fix (it is off the track). */
  stage: TrackStage | null;
  closed: "wont_fix" | "not_a_problem" | null;
  solutions: LinkedSolution[];
  /** At Verified: the verdict that verified it (the first linked solution that passed). */
  verified: LinkedSolution | null;
}

/** The solutions linked to an issue, newest first, with the verdict that counts for each. */
export function linkedSolutions(data: Pick<SolutionsData, "solutions" | "links">, issueId: string): LinkedSolution[] {
  const byId = new Map(data.solutions.map((s) => [s.id, s]));
  return data.links
    .filter((l: SolutionIssueRow) => l.issue_id === issueId && byId.has(l.solution_id))
    .map((l) => ({ solution: byId.get(l.solution_id)!, verdict: effectiveVerdict(l), holdsPct: l.holds_pct, yours: l.user_verdict !== null }))
    .sort((a, b) => byId.get(b.solution.id)!.created_at.localeCompare(byId.get(a.solution.id)!.created_at) || a.solution.id.localeCompare(b.solution.id));
}

/**
 * Where an issue is:
 * - Open: nothing proposed yet.
 * - Solution idea: an AI idea is waiting for it, or a solution is linked that has no verdict yet.
 * - Being built: a solution has been tested against it (a verdict, or the issue is in Testing solutions).
 * - Implemented: the issue is resolved by a solution or a change to the process.
 * - Verified: implemented, and a linked solution passed its check.
 * Won't fix, and resolved as not a problem, leave the track.
 */
export function trackOf(issue: Pick<IssueRow, "status" | "resolved_how">, solutions: readonly LinkedSolution[], hasIdea = false): IssueTrack {
  const base = { solutions: [...solutions], verified: null };
  if (issue.status === "wont_fix") return { ...base, stage: null, closed: "wont_fix" };
  if (issue.status === "resolved") {
    if (issue.resolved_how === "not_a_problem") return { ...base, stage: null, closed: "not_a_problem" };
    const passed = solutions.find((s) => s.verdict === "pass") ?? null;
    return passed ? { ...base, stage: 4, closed: null, verified: passed } : { ...base, stage: 3, closed: null };
  }
  if (issue.status === "testing" || solutions.some((s) => s.verdict !== null)) return { ...base, stage: 2, closed: null };
  if (solutions.length > 0 || hasIdea) return { ...base, stage: 1, closed: null };
  return { ...base, stage: 0, closed: null };
}

/** Solutions of this process that are not linked to any issue: "Other improvements". */
export function otherImprovements(data: SolutionsData, processId: string): SolutionsData {
  const linked = new Set(data.links.map((l) => l.solution_id));
  return { ...data, solutions: data.solutions.filter((s) => s.process_id === processId && !linked.has(s.id)), links: [] };
}
