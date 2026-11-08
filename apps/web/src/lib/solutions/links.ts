// Where the Editor opens in solution mode (issue #114, A49). A48's issue page calls `buildSolutionHref` for its
// "✎ Build solution" button, and "New solution" uses `newSolutionHref`. The Editor's route is the one the draft uses,
// `/w/<slug>/p/<process>/edit`, with `?mode=solution`; `issue` names the issue the solution is built for, and `from`
// is where Exit editor and a saved solution go back to.

import type { IssueRow } from "@transpera-flow/db";
import { issueProcessId } from "./area";

/** The Editor in solution mode on `processId`, optionally for an issue. `base` is `/w/<slug>` or `/demo`. */
export function solutionEditorHref(base: string, processId: string, opts: { issueId?: string | null; from?: string | null } = {}): string {
  const q = new URLSearchParams({ mode: "solution" });
  if (opts.issueId) q.set("issue", opts.issueId);
  if (opts.from) q.set("from", opts.from);
  // The demo's Editor is one page for the sample; `process` picks a servicing process there, as elsewhere in the demo.
  return base === "/demo" ? `/demo/edit?${q.toString()}${processId ? `&process=${encodeURIComponent(processId)}` : ""}` : `${base}/p/${processId}/edit?${q.toString()}`;
}

/**
 * "✎ Build solution" on an issue: the Editor in solution mode on the issue's process, with the issue's steps outlined.
 * Null when the issue names no process (there is no map to open).
 */
export function buildSolutionHref(base: string, issue: Pick<IssueRow, "id" | "links" | "process_id">, from?: string | null): string | null {
  const processId = issueProcessId(issue);
  return processId ? solutionEditorHref(base, processId, { issueId: issue.id, from }) : null;
}

/** "✎ New solution" on a process: the Editor in solution mode with no issue, to be linked later. */
export const newSolutionHref = (base: string, processId: string, from?: string | null): string => solutionEditorHref(base, processId, { from });
