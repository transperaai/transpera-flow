// Where the time goes (sandbox G, phase 4): the engine's `MonthlyResult.time` read as hours and shares of the whole capacity, one row per
// category of the workspace's list, then Idle and (for the team and roles) Uncovered. The rows are worked out in the Sandbox runner
// package (`timeRows`, shared with MCP and the exports); this adds the timeline's months for the page. Pure: no React.

import type { MonthlyResult } from "@transpera-flow/engine";
import type { PurposeCategory } from "@transpera-flow/db";
import { timeRows, type TimeRows, type TimeScope } from "@transpera-flow/db/sandbox";
import type { TimelineMonth } from "@/lib/forecast/timeline";

export { IDLE, NOT_SET, UNCOVERED, type TimeRow, type TimeScope } from "@transpera-flow/db/sandbox";

export interface TimeView extends TimeRows {
  months: TimelineMonth[];
}

/** The split of a scope as rows, with the run's months. See `timeRows`. */
export function timeView(monthly: MonthlyResult, months: TimelineMonth[], categories: readonly PurposeCategory[], scope: TimeScope): TimeView {
  return { months, ...timeRows(monthly, months.length, categories, scope) };
}

/** The 100% stack of a view: the category rows and Idle, in order, for one month (shares sum to 1 unless over). Uncovered is not in it. */
export function stackOf(view: TimeView, month: number): { id: string; name: string; share: number }[] {
  return view.rows.filter((r) => r.kind !== "uncovered").map((r) => ({ id: r.id, name: r.name, share: r.share[month] ?? 0 }));
}
