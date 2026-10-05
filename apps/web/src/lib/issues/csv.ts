// The Issues list as a CSV (issue #39, B10; moved here from B9): one row per issue the list shows, so it honours the
// Open / Resolved / All and rating filters exactly (the page passes the list it draws). Pure.

import type { IssueRow } from "@transpera-flow/db";
import { RATING_LABELS, ratingOfStored, type IssueCost } from "@transpera-flow/engine";
import { csvText, type CsvCell } from "@/lib/export/csv";
import { statusLabel } from "./pages";

export const ISSUES_CSV_HEADER = [
  "Number",
  "Title",
  "Rating",
  "Status",
  "Process",
  "Steps",
  "Owners",
  "Target measure",
  "Target now",
  "Target goal",
  "Estimated cost per month",
  "Currency",
  "Created",
  "Resolved",
] as const;

export interface IssuesCsvNames {
  processes: ReadonlyMap<string, string>;
  steps: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
}

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

/** What an issue costs a month as one cell: money as a number, a time-only cost as "12 h", none as empty. */
function costCell(cost: IssueCost | null): CsvCell {
  if (cost?.perMonth != null) return Math.round(cost.perMonth);
  if (cost?.hoursPerMonth != null) return `${Math.round(cost.hoursPerMonth * 10) / 10} h`;
  return "";
}

/** The CSV of `issues` (already filtered and sorted as the list shows them). */
export function issuesCsv(issues: readonly IssueRow[], names: IssuesCsvNames, costOf: (i: IssueRow) => IssueCost | null, currency: string): string {
  const rows = issues.map((i): CsvCell[] => {
    const processIds = [...new Set([...i.links.flatMap((l) => (l.process_id ? [l.process_id] : [])), ...(i.process_id ? [i.process_id] : [])])];
    const stepIds = i.links.flatMap((l) => (l.step_id ? [l.step_id] : []));
    const steps = stepIds.length ? stepIds : i.step_id ? [i.step_id] : [];
    const owners = i.owner_ids.length ? i.owner_ids : i.owner_person_id ? [i.owner_person_id] : [];
    return [
      i.number,
      i.title,
      RATING_LABELS[ratingOfStored(i.severity)],
      statusLabel(i.status),
      processIds.map((id) => names.processes.get(id) ?? "A process").join("; "),
      [...new Set(steps)].map((id) => names.steps.get(id) ?? "A step").join("; "),
      owners.map((id) => names.people.get(id) ?? "Someone").join("; "),
      i.target_measure,
      i.target_now,
      i.target_goal,
      costCell(costOf(i)),
      currency,
      day(i.created_at),
      day(i.resolved_at),
    ];
  });
  return csvText(ISSUES_CSV_HEADER, rows);
}
