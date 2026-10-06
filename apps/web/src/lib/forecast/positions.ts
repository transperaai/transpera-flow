// Where plan markers sit on the forecast timeline, and what a drop or a key press means (B7, issue #36). The timeline's
// columns are equal width while months differ in length, so a position is "columns from the left" with the fraction of
// the month, the same rule as `plannedMarkers`'s `at` (timeline.ts). Dates are ISO strings; time is working hours from
// the start of the forecast's start date (weekdays only, as the model counts it). Pure: no React.

import { workingDaysBetween } from "@transpera-flow/db";
import { dateAtHour } from "./timeline";

const DAY_MS = 86_400_000;

/** `iso` plus `days` calendar days. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The 1st of the calendar month `iso` falls in. */
export const firstOfMonth = (iso: string): string => `${iso.slice(0, 7)}-01`;

/** The 1st of the month `delta` months from the one `iso` falls in. */
export function addMonths(iso: string, delta: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + delta;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
}

/** The Monday on or before `iso`. */
export function mondayOnOrBefore(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

/** The months' edges in working hours: [0, ...monthStarts, H]. */
export function monthBounds(monthStarts: readonly number[], horizonHours: number): number[] {
  return [0, ...monthStarts, horizonHours];
}

/** Hours from the start of `startDate` to the start of `date` (negative before it), weekdays only. */
export function hoursToDate(startDate: string, date: string, hoursPerWeek: number): number {
  return workingDaysBetween(startDate, date) * (hoursPerWeek / 5);
}

/** Where a date sits on the timeline, in columns from the left (2.5 = halfway through the third month), clamped to [0, n]. */
export function positionOfDate(date: string, startDate: string, bounds: readonly number[], hoursPerWeek: number): number {
  const n = bounds.length - 1;
  const hour = hoursToDate(startDate, date, hoursPerWeek);
  if (hour <= 0) return 0;
  if (hour >= bounds[n]!) return n;
  let i = 0;
  while (i < n - 1 && bounds[i + 1]! <= hour) i++;
  return Math.min(n, Math.max(0, i + (hour - bounds[i]!) / (bounds[i + 1]! - bounds[i]!)));
}

/** The month (column) a date falls in: the last bound at or before it; 0 on or before the start, n - 1 at or after the horizon. */
export function monthIndexOfDate(date: string, startDate: string, bounds: readonly number[], hoursPerWeek: number): number {
  const n = bounds.length - 1;
  return Math.min(n - 1, Math.floor(positionOfDate(date, startDate, bounds, hoursPerWeek) + 1e-9));
}

/**
 * The date a drop at `position` columns means. "month" snaps to the 1st of the calendar month of the column under the
 * pointer (the first column: the 1st of the start date's month); "week" snaps to the Monday on or before the date there.
 */
export function dateAtPosition(position: number, snap: "month" | "week", startDate: string, bounds: readonly number[], hoursPerWeek: number): string {
  const n = bounds.length - 1;
  const p = Math.min(n, Math.max(0, position));
  const column = Math.min(n - 1, Math.floor(p + 1e-9));
  if (snap === "month") {
    if (column === 0) return firstOfMonth(startDate);
    return firstOfMonth(dateAtHour(startDate, bounds[column]!, hoursPerWeek).toISOString().slice(0, 10));
  }
  // At the right edge, the last working hour of the span rather than the hour after it.
  const hour = p >= n ? bounds[n]! - 1e-6 : bounds[column]! + (p - column) * (bounds[column + 1]! - bounds[column]!);
  return mondayOnOrBefore(dateAtHour(startDate, Math.max(0, hour), hoursPerWeek).toISOString().slice(0, 10));
}

/** One step by keyboard: a month (the 1st of the next or previous month) or a week (± 7 days). */
export function stepDate(date: string, snap: "month" | "week", direction: 1 | -1): string {
  return snap === "month" ? addMonths(date, direction) : addDays(date, 7 * direction);
}
