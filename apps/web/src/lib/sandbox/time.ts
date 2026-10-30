// Where the time goes (sandbox G, phase 4): the engine's `MonthlyResult.time` read as hours and shares of the whole capacity, one row per
// category of the workspace's list, then Idle and (for the team and roles) Uncovered. The rows are worked out in the Sandbox runner
// package (`timeRows`, shared with MCP and the exports); this adds the timeline's months for the page. Pure: no React.

import type { MonthlyResult } from "@transpera-flow/engine";
import type { PurposeCategory } from "@transpera-flow/db";
import { everyoneElseShown, SMALL_TEAM_NOTE, timeRows, type TimeRows, type TimeScope } from "@transpera-flow/db/sandbox";
import type { TimelineMonth } from "@/lib/forecast/timeline";

export { IDLE, NOT_SET, UNCOVERED, type TimeRow, type TimeScope } from "@transpera-flow/db/sandbox";

export interface PersonChoice {
  value: string;
  label: string;
}

/**
 * The "By person" choices. An Agency admin or the Owner: each person. A Viewer: "You" (when they are in the run) and "Everyone else"
 * (the team less themselves), except in a team of two or fewer, where "Everyone else" would be one identifiable colleague: then only
 * "You", with a note (Austin, 30 Oct).
 */
export function personChoices(
  monthly: MonthlyResult,
  people: readonly { id: string; name: string }[],
  viewer: { seesEveryone: boolean; ownPersonId: string | null },
): { options: PersonChoice[]; note: string | null } {
  if (viewer.seesEveryone) return { options: people.map((p) => ({ value: p.id, label: p.name })), note: null };
  const own = viewer.ownPersonId;
  const options: PersonChoice[] = own && monthly.time.people[own] ? [{ value: own, label: "You" }] : [];
  if (everyoneElseShown(monthly)) options.push({ value: "others", label: "Everyone else" });
  return { options, note: everyoneElseShown(monthly) ? null : SMALL_TEAM_NOTE };
}

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
