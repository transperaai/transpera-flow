// The Sandbox's result charts, worked out from two runs (D54): the team-by-month heatmap's rows, the purposes that moved, and the signed numbers
// the chart headers carry. Pure: no React. The busy cut-offs are the Capacity page's (`toneOf`), the purposes come from P4's `timeRows`.

import type { PlayTeamLine, PurposeCategory } from "@transpera-flow/db";
import { timeRows, type TimeRow } from "@transpera-flow/db/sandbox";
import type { MonthlyResult } from "@transpera-flow/engine";

export type BusyTone = "ok" | "warn" | "bad";

/** The Capacity page's cut-offs: at or over the line is bad, within 10 points under it is a warning. */
export function busyTone(busy: number, line: number): BusyTone {
  return busy >= line ? "bad" : busy >= line - 0.1 ? "warn" : "ok";
}

export interface HeatRow {
  id: string;
  name: string;
  line: number;
  /** One per month: the mean busy share, the 90th percentile ("in 9 of 10 runs"), and null when nobody of the team is there. */
  busy: (number | null)[];
  p90: (number | null)[];
}

/** Every team, in the order of `order` (the run on screen: the busiest first), with the values of `from` (this scene or today). */
export function heatRows(order: readonly PlayTeamLine[], from: readonly PlayTeamLine[]): HeatRow[] {
  const by = new Map(from.map((t) => [t.id, t]));
  return order.map((t) => {
    const x = by.get(t.id);
    return { id: t.id, name: t.name, line: t.line, busy: x?.values ?? t.values.map(() => null), p90: x?.p90 ?? t.values.map(() => null) };
  });
}

export interface PurposeSlice {
  id: string;
  name: string;
  /** Hours a month over the run. */
  hours: number;
}

/** The team's hours a month by purpose (the workspace's purposes in its order; Idle and unfilled work are not a purpose). */
export function purposeSlices(monthly: MonthlyResult, categories: readonly PurposeCategory[]): PurposeSlice[] {
  const n = Math.max(1, monthly.months.length);
  return timeRows(monthly, monthly.months.length, categories, { kind: "team" })
    .rows.filter((r: TimeRow) => r.kind === "category")
    .map((r: TimeRow) => ({ id: r.id, name: r.name, hours: r.runHours / n }));
}

export interface PurposeMove {
  id: string;
  name: string;
  /** Hours a month, this scene less today. */
  delta: number;
}

/** The purposes that moved most (at least half an hour a month), biggest first. */
export function purposeMoves(today: readonly PurposeSlice[], scene: readonly PurposeSlice[], limit = 3): PurposeMove[] {
  const was = new Map(today.map((s) => [s.id, s.hours]));
  return scene
    .map((s) => ({ id: s.id, name: s.name, delta: s.hours - (was.get(s.id) ?? 0) }))
    .filter((m) => Math.abs(m.delta) >= 0.5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

const MINUS = "−";
/** "+3", "−2", "+0": a change of a count, in whole numbers. */
export function signedCount(v: number): string {
  const r = Math.round(v);
  return (r < 0 ? MINUS : "+") + Math.abs(r);
}
/** "+A$12.3k", "−A$4k", "+A$0". */
export function signedMoney(v: number, money: (v: number) => string): string {
  return (Math.round(v) < 0 ? MINUS : "+") + money(Math.abs(Math.round(v)));
}
/** "−40 h" (hours a month). */
export function signedHours(v: number): string {
  return `${Math.round(v) < 0 ? MINUS : "+"}${Math.abs(Math.round(v))} h`;
}

/** The worst month of the first `months` (QA round 2, option A1): the month with the most people over their utilisation threshold, how many, and
 * which teams they are in (most first). Null when nobody is over in any of those months. The first such month wins a tie. */
export interface WorstMonth {
  month: number;
  count: number;
  teams: { id: string; name: string; count: number }[];
}

export function worstMonth(
  people: readonly { roleId?: string | null; line: number; busy: readonly (number | null)[] }[],
  months: number,
  teamName: (roleId: string) => string | undefined,
): WorstMonth | null {
  let best: WorstMonth | null = null;
  for (let m = 0; m < months; m++) {
    const over = people.filter((p) => p.busy[m] != null && p.busy[m]! >= p.line);
    if (!over.length || (best && over.length <= best.count)) continue;
    const by = new Map<string, number>();
    for (const p of over) by.set(p.roleId ?? "", (by.get(p.roleId ?? "") ?? 0) + 1);
    const teams = [...by]
      .map(([id, count]) => ({ id, name: (id && teamName(id)) || "Other", count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    best = { month: m, count: over.length, teams };
  }
  return best;
}
