// What the Solutions list, the process page's Solutions section and the Solution page show (issue #115, A50), as pure
// functions: the type, who built it, the steps it changes, the verdict on each issue it solves, and where its page is.
// The components render the results.

import type { IssueRow, SolutionIssueRow, SolutionRow, SolutionsData, SolutionVerdict } from "@transpera-flow/db";
import { shortDate, type SolutionSummary, type SolutionTest } from "@/lib/issues/pages";

// The type lives in `packages/db` (a share link's snapshot holds it, B3); re-exported so nothing else changes.
export type { SolutionsData };

export const NO_SOLUTIONS_DATA: SolutionsData = { solutions: [], links: [] };

/**
 * Where a solution's page is. `base` is `/w/<slug>` or `/demo`.
 */
export const solutionHref = (base: string, id: string): string => `${base}/solutions/${id}`;

/** The list: `/w/<slug>/solutions` or `/demo/solutions`. */
export const solutionsListHref = (base: string): string => `${base}/solutions`;

export type SolutionType = "By hand" | "AI block";

/**
 * How a solution was made: "AI block" when it was built from an AI idea (a built `suggestion_proposals` row records the solution's id in
 * `applied.solution_id`, passed here as `aiIds`), else "By hand". With no data it reads "By hand".
 */
export function solutionType(solution: Pick<SolutionRow, "id">, aiIds?: readonly string[]): SolutionType {
  return aiIds?.includes(solution.id) ? "AI block" : "By hand";
}

/**
 * Who built it, for a card: "You" for the viewer, the person linked to that member (`names`, by user id) when there is one,
 * "A team member" when the member has no person linked, and "Someone" when nobody is recorded. The demo is always you.
 */
export function builtBy(createdBy: string | null, viewerId: string | null | undefined, demo = false, names: Readonly<Record<string, string>> = {}): string {
  if (demo) return "You";
  if (!createdBy) return "Someone";
  return createdBy === viewerId ? "You" : (names[createdBy] ?? "A team member");
}

/** The verdict that counts for a link: the person's own, else the automatic one, else none. */
export const effectiveVerdict = (l: Pick<SolutionIssueRow, "auto_verdict" | "user_verdict">): SolutionVerdict | null => l.user_verdict ?? l.auto_verdict;

export const VERDICT_WORDS: Record<SolutionVerdict, string> = { pass: "Pass", fail: "Fail" };

/** The automatic verdict as a word: "Pass", "Fail" or "Not checked" (the issue's target could not be turned into a number). */
export const autoWord = (v: SolutionVerdict | null): string => (v ? VERDICT_WORDS[v] : "Not checked");

/** The date a solution was built: "5 Oct". */
export const builtDate = (s: Pick<SolutionRow, "created_at">, now?: Date): string => shortDate(s.created_at, now);

/** The names of the steps a solution changes, as the solution's own copy names them, in the order the copy has them. */
export function changedStepNames(s: Pick<SolutionRow, "steps" | "changed_step_ids">): string[] {
  const changed = new Set(s.changed_step_ids);
  return s.steps.steps.filter((st) => changed.has(st.id)).map((st) => st.name);
}

/** "Check fit, Enrich lead and 2 more", or "no steps" when it only changes levers. */
export function changesLine(s: Pick<SolutionRow, "steps" | "changed_step_ids" | "lever_changes">, max = 3): string {
  const names = changedStepNames(s);
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  const steps = names.length ? `${shown}${rest > 0 ? ` and ${rest} more` : ""}` : s.changed_step_ids.length ? `${s.changed_step_ids.length} steps` : "";
  const levers = s.lever_changes.length ? `${s.lever_changes.length} lever ${s.lever_changes.length === 1 ? "change" : "changes"}` : "";
  return [steps, levers].filter(Boolean).join(" · ") || "nothing yet";
}

/** The links of one solution, in the order they were made. */
export const linksOf = (data: SolutionsData, solutionId: string): SolutionIssueRow[] => data.links.filter((l) => l.solution_id === solutionId);

/** The solutions linked to one issue, with the link, newest solution first. */
export function solutionsForIssue(data: SolutionsData, issueId: string): { solution: SolutionRow; link: SolutionIssueRow }[] {
  return data.links
    .filter((l) => l.issue_id === issueId)
    .flatMap((link) => {
      const solution = data.solutions.find((s) => s.id === link.solution_id);
      return solution ? [{ solution, link }] : [];
    })
    .sort((a, b) => b.solution.created_at.localeCompare(a.solution.created_at));
}

/** Issues a solution of `processId` could still be linked to: about that process, open or testing, not already linked, not a detection. */
export function linkableIssues(issues: readonly IssueRow[], processId: string, already: ReadonlySet<string>): IssueRow[] {
  return issues
    .filter(
      (i) =>
        (i.status === "open" || i.status === "testing") &&
        i.source !== "detected" &&
        !already.has(i.id) &&
        (i.process_id === processId || i.links.some((l) => l.process_id === processId)),
    )
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

/** The longest note a solution or a verdict can hold (the table checks the same). */
export const MAX_NOTES = 4000;

/** The solutions tested for one issue, as the Issue page's table wants them. */
export function solutionTests(issueId: string, data: SolutionsData, base: string, now?: Date): SolutionTest[] {
  return solutionsForIssue(data, issueId).map(({ solution, link }) => ({
    id: solution.id,
    name: solution.name,
    type: solutionType(solution, data.aiIds),
    built: builtDate(solution, now),
    auto: link.auto_verdict ?? "unchecked",
    holds: link.holds_pct === null ? null : link.holds_pct / 100,
    yours: link.user_verdict,
    href: solutionHref(base, solution.id),
  }));
}

/** Each issue's summary for the Issues list, by issue id: how many solutions were tested, and whether one passed. */
export function solutionSummaries(data: SolutionsData): Record<string, SolutionSummary> {
  const out: Record<string, SolutionSummary> = {};
  for (const l of data.links) {
    if (!data.solutions.some((s) => s.id === l.solution_id)) continue;
    const was = out[l.issue_id] ?? { tested: 0, passed: false, ideas: 0 };
    out[l.issue_id] = { tested: was.tested + 1, passed: was.passed || effectiveVerdict(l) === "pass", ideas: 0 };
  }
  return out;
}
