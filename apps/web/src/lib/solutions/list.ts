// What the Solutions list and its "New solution" dialog work out (Q12), as pure functions: which issues a new solution can start from, how
// the list is filtered by issue, and where "Log a new issue" goes. Every solution is tied to an issue.

import type { IssueRow, SolutionIssueRow, SolutionRow } from "@transpera-flow/db";
import { isOpenIssue } from "@/lib/issues/pages";
import { issueProcessId } from "./area";
import { buildSolutionHref } from "./links";

/** The Issue filter's choice for a solution that is linked to no issue. */
export const NO_ISSUE = "none";

/** The words a solution with no issue shows. */
export const NO_ISSUE_WORDS = "No issue";

/**
 * The issues a new solution can start from: open ones a person logged or acknowledged (a detection is only a suggestion until it is
 * acknowledged), about a process that has a published version to copy. By number.
 */
export function startableIssues(issues: readonly IssueRow[], publishedProcessIds: ReadonlySet<string>): IssueRow[] {
  return issues
    .filter((i) => isOpenIssue(i) && i.source !== "detected" && publishedFor(i, publishedProcessIds))
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

function publishedFor(issue: Pick<IssueRow, "links" | "process_id">, published: ReadonlySet<string>): boolean {
  const id = issueProcessId(issue);
  return id !== null && published.has(id);
}

/** The issues that match what was typed: by number ("12" or "#12"), title, or the name of the process they are about. */
export function searchIssues(issues: readonly IssueRow[], query: string, processName: (issue: IssueRow) => string): IssueRow[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return [...issues];
  return issues.filter((i) => [i.number == null ? "" : String(i.number), i.title, processName(i)].some((t) => t.toLowerCase().includes(q)));
}

/** Where "Log a new issue" goes: the Issues list with its New issue dialog open, and on from there to the Editor for the issue. */
export const logIssueHref = (base: string): string => `${base}/issues?new=1&then=solution`;

/** Where a new solution for `issue` opens: the Editor in solution mode on its process, with the issue linked, and back to the list on exit. */
export function startSolutionHref(base: string, issue: Pick<IssueRow, "id" | "links" | "process_id">, from: string): string | null {
  return buildSolutionHref(base, issue, from);
}

/** The issue ids each solution is linked to, in the order the links were made. */
export function issuesBySolution(links: readonly Pick<SolutionIssueRow, "solution_id" | "issue_id">[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of links) out.set(l.solution_id, [...(out.get(l.solution_id) ?? []), l.issue_id]);
  return out;
}

/** Whether a solution passes the Issue filter: nothing chosen shows all; "none" shows the ones with no issue; an id shows its solutions. */
export function matchesIssueFilter(solution: Pick<SolutionRow, "id">, linked: ReadonlyMap<string, string[]>, selected: readonly string[]): boolean {
  if (!selected.length) return true;
  const mine = linked.get(solution.id) ?? [];
  return selected.some((v) => (v === NO_ISSUE ? mine.length === 0 : mine.includes(v)));
}
