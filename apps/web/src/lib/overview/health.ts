// What the Overview's health strip and trends show (issue #173, B15): how well the operation runs, read off one
// simulation run and the issues in the database. Pure: no React, no workers, no clock (the date is passed in).
//
// - Flow efficiency: the share of elapsed time at the steps that is hands-on work rather than waiting.
// - Time split by process: the same, process by process.
// - Process health and open issues: counts by rating.
// - Issues opened versus resolved, month by month.
//
// Months are calendar months in a time zone: the workspace's if it ever has one, else the browser's own (the reader's
// month), the same for "resolved this month" and the chart. `timeZone` undefined means the browser's.

import { isActiveStatus, isVisibleIssue, type IssueRow, type ProcessPart } from "@transpera-flow/db";
import { RATINGS, ratingOfStored, worseRating, type EngineModel, type Rating, type SimulationResult } from "@transpera-flow/engine";
import { timeSplitOf, workingShare, type TimeSplit } from "./time-split";

export { timeSplitOf, totalOf, workingShare, type TimeSplit } from "./time-split";

/** "18% working, 82% waiting", the share rounded so the two add up to 100. */
export function flowEfficiencyWords(share: number): { working: number; waiting: number; text: string } {
  const working = Math.round(share * 100);
  return { working, waiting: 100 - working, text: `${working}% working, ${100 - working}% waiting` };
}

export interface ProcessTimeSplit extends TimeSplit {
  id: string;
  name: string;
  /** Hands-on share of this process's elapsed time. */
  share: number;
}

/** The time split of each process that had any work in the run, in the order given. A process's own steps only (not those of processes inside it). */
export function timeSplitByProcess(model: Pick<EngineModel, "steps">, result: Pick<SimulationResult, "steps" | "stepFacts" | "H">, parts: readonly Pick<ProcessPart, "process" | "steps">[]): ProcessTimeSplit[] {
  return parts.flatMap((p) => {
    const split = timeSplitOf(model, result, new Set(p.steps.map((s) => s.id)));
    const share = split ? workingShare(split) : null;
    return split && share !== null ? [{ id: p.process.id, name: p.process.name, ...split, share }] : [];
  });
}

/** Ratings worst first, as the counts list them. */
export const RATINGS_WORST_FIRST: readonly Rating[] = [...RATINGS].reverse();

/** How many of `items` sit at each rating, worst first (every rating listed, zeros included). */
export function countByRating(items: readonly (Rating | null)[], none: Rating = "great"): { rating: Rating; count: number }[] {
  return RATINGS_WORST_FIRST.map((rating) => ({ rating, count: items.filter((r) => (r ?? none) === rating).length }));
}

export interface ProcessHealth {
  /** Processes at each rating, worst first (every rating listed, zeros included). */
  byRating: { rating: Rating; count: number }[];
  /** Processes with no open issue worse than Great: "Not rated", as on the Processes page. */
  notRated: number;
  total: number;
  /** Rated Operational risk or Bad, not urgent. */
  attention: number;
}

/** The Process health card, from each process's rating as the map and the Processes page give it (null: not rated). */
export function processHealth(ratings: readonly (Rating | null)[]): ProcessHealth {
  const byRating = RATINGS_WORST_FIRST.map((rating) => ({ rating, count: ratings.filter((r) => r === rating).length }));
  return {
    byRating,
    notRated: ratings.filter((r) => r === null).length,
    total: ratings.length,
    attention: ratings.filter((r) => r === "risk" || r === "bad").length,
  };
}

/** A tracked issue still to deal with: open or having a solution tested. */
export const isOpenIssue = (i: Pick<IssueRow, "status">): boolean => isVisibleIssue(i) && isActiveStatus(i.status);

/** The calendar month of an instant, "2026-10", in `timeZone` (the browser's when undefined). */
export function monthKey(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value.padStart(2, "0");
  return `${year}-${month}`;
}

/** The calendar month of an ISO timestamp, "2026-10", in `timeZone` (the browser's when undefined); "" when it isn't a date. */
export function monthOf(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : monthKey(d, timeZone);
}

export interface OpenIssues {
  /** Open issues by rating, worst first. */
  byRating: { rating: Rating; count: number }[];
  total: number;
  /** Issues resolved in the calendar month of `now`. */
  resolvedThisMonth: number;
}

/** The Open issues card: open issues by rating, and how many were resolved this calendar month (in `timeZone`). */
export function openIssues(issues: readonly IssueRow[], now: Date, timeZone?: string): OpenIssues {
  const open = issues.filter(isOpenIssue);
  const thisMonth = monthKey(now, timeZone);
  return {
    byRating: countByRating(open.map((i) => ratingOfStored(i.severity))),
    total: open.length,
    resolvedThisMonth: issues.filter((i) => i.status === "resolved" && i.resolved_at && monthOf(i.resolved_at, timeZone) === thisMonth).length,
  };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MonthCount {
  /** "2026-10". */
  month: string;
  /** "Oct", with the year on January and on the first month shown: "Oct 26". */
  label: string;
  opened: number;
  resolved: number;
}

/**
 * Issues opened and resolved in each of the last `months` calendar months, up to and including the month of `now`. An
 * issue counts as opened when it was logged or acknowledged, and as resolved in the month it was resolved (Won't fix and
 * dismissed insights don't count as resolved; a dismissed insight was never an issue).
 */
export function openedVersusResolved(issues: readonly IssueRow[], now: Date, months = 6, timeZone?: string): MonthCount[] {
  const [y, m] = monthKey(now, timeZone).split("-").map(Number) as [number, number];
  const out: MonthCount[] = [];
  for (let k = months - 1; k >= 0; k--) {
    // Month arithmetic on the calendar's numbers, so no time zone can shift a month.
    const index = y * 12 + (m - 1) - k;
    const year = Math.floor(index / 12);
    const mo = index % 12;
    const short = MONTH_SHORT[mo]!;
    out.push({ month: `${year}-${String(mo + 1).padStart(2, "0")}`, label: k === months - 1 || mo === 0 ? `${short} ${String(year % 100).padStart(2, "0")}` : short, opened: 0, resolved: 0 });
  }
  const at = new Map(out.map((c) => [c.month, c]));
  for (const i of issues) {
    if (!isVisibleIssue(i)) continue;
    const opened = at.get(monthOf(i.created_at, timeZone));
    if (opened) opened.opened++;
    if (i.status === "resolved" && i.resolved_at) {
      const resolved = at.get(monthOf(i.resolved_at, timeZone));
      if (resolved) resolved.resolved++;
    }
  }
  return out;
}

/** The worse of two ratings, either of which may be missing. */
export const worseOf = (a: Rating | null, b: Rating | null): Rating | null => (a === null ? b : b === null ? a : worseRating(a, b));
