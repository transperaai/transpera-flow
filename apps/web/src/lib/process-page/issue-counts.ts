// The counts in the Issues and solutions card's header (Q8): "3 open · 1 in progress · 2 resolved". Pure.

import type { IssueStatus } from "@transpera-flow/db";

export interface IssueCounts {
  open: number;
  inProgress: number;
  resolved: number;
  wontFix: number;
}

export function issueCounts(statuses: readonly IssueStatus[]): IssueCounts {
  const n = (s: IssueStatus) => statuses.filter((x) => x === s).length;
  return { open: n("open"), inProgress: n("testing"), resolved: n("resolved"), wontFix: n("wont_fix") };
}

/** The header line; "won't fix" shows only when there is one, and an empty list says nothing yet. */
export function issueCountsText(c: IssueCounts): string {
  if (c.open + c.inProgress + c.resolved + c.wontFix === 0) return "None logged yet";
  return [`${c.open} open`, `${c.inProgress} in progress`, `${c.resolved} resolved`, ...(c.wontFix ? [`${c.wontFix} won't fix`] : [])].join(" · ");
}
