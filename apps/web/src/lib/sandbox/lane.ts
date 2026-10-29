// The scenario lane's markers in words (docs/plans/sandbox-p1-brief.md §4): what each timed change is called, when it is, and what is
// wrong with it. Pure: no React.

import type { SandboxChange } from "@transpera-flow/db";
import { sandboxLever } from "@transpera-flow/db";
import { describeChange, type DescribeContext } from "./describe";
import { type EffectiveChange, fromDate, leaveEnd, type ChangeProblem, hoursToDate } from "@transpera-flow/db/sandbox";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "1 Mar 2027". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]!.slice(0, 3)} ${y}`;
}

/** "1 March 2027". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]!} ${y}`;
}

/** "Monday 14 December 2026". */
export function weekdayDate(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `${day} ${longDate(iso)}`;
}

/** The lane's glyph kind: hire, leave and solution have their own marks; every other timed change is a "change". */
export type LaneKind = "hire" | "leave" | "solution" | "change";

/** One timed change as the lane draws and announces it. */
export interface PlanLaneMarker {
  id: string;
  kind: LaneKind;
  date: string;
  /** Leave: its last day (the Friday of the last week). */
  endDate?: string;
  /** "New PPC specialist starts", "Leah Brooks on leave for 2 weeks", "Faster PPC campaign setup goes live". */
  label: string;
  /** "1 Mar 2027", "14 Dec 2026 to 1 Jan 2027". */
  when: string;
  /** What is wrong with it today (a role, person or solution that is gone), in words. */
  problem?: string;
  /** A parent's change: shown, not movable. */
  inherited?: boolean;
}

export const laneKindOf = (c: SandboxChange): LaneKind => (c.lever === "D1" ? "hire" : c.lever === "D3" ? "leave" : c.lever === "E6" ? "solution" : "change");

/** Every timed change of a scenario in words, in order (a change that applies to the whole run has no place on the lane). */
export function laneMarkers(ctx: DescribeContext, changes: readonly EffectiveChange[], problems: readonly ChangeProblem[], startDate: string, hoursPerWeek: number): PlanLaneMarker[] {
  const problemOf = new Map(problems.filter((p) => !p.note).map((p) => [p.changeId, p.message]));
  const out: PlanLaneMarker[] = [];
  for (const e of changes) {
    const c = e.change;
    if (!c.from || !sandboxLever(c.lever)) continue;
    const date = fromDate(c.from);
    const problem = problemOf.get(c.id);
    const base = { id: c.id, kind: laneKindOf(c), date, ...(problem ? { problem } : {}), ...(e.inherited ? { inherited: true as const } : {}) };
    let label = describeChange(c, ctx);
    if (c.lever === "D1" && hoursToDate(startDate, date, hoursPerWeek) <= 0) label += " (already started)";
    if (c.lever === "D3") {
      const endDate = leaveEnd(c.from, c.value);
      out.push({ ...base, endDate, label, when: `${shortDate(date)} to ${shortDate(endDate)}` });
    } else out.push({ ...base, label, when: shortDate(date) });
  }
  return out;
}
