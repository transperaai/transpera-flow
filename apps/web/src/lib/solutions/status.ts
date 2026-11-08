// A solution's status (Q10, D43): the colour each is drawn in and the order the dropdown lists them. The values and words are in
// `packages/db` (`SOLUTION_STATUSES`, `SOLUTION_STATUS_LABELS`), which the table's check mirrors.

import { SOLUTION_STATUSES, SOLUTION_STATUS_LABELS, type SolutionStatus } from "@transpera-flow/db";

/** The theme token each status is drawn in. */
export const SOLUTION_STATUS_TONE: Record<SolutionStatus, string> = {
  idea: "fg-3",
  testing: "warn",
  works: "good",
  doesnt_work: "crit",
  adopted: "auto",
};

export const SOLUTION_STATUS_OPTIONS = SOLUTION_STATUSES.map((s) => ({ value: s, label: SOLUTION_STATUS_LABELS[s], tone: SOLUTION_STATUS_TONE[s] }));
