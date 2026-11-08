// The forecast's monthly timeline (issue #35, B6), as data for the chart: how busy each role and person is per month,
// the client groups by service, the market conditions from the schedule, and markers for planned hires, end dates and
// leave. Pure (no React), so it is tested without a browser, and shared: any screen that runs the model month by month
// (`simulate(…, { monthly: true })`) can draw the same timeline from it (the Overview's team load chart, B15).

import { monthOfHour, type EngineModel, type MonthBusy, type MonthlyResult, type SimulationResult, type Stat } from "@transpera-flow/engine";
import type { ProcessBundle } from "@transpera-flow/db";
import { dateAtHour } from "@transpera-flow/db/sandbox";
import { ownRowsOnly, viewerOf } from "@/lib/viewer";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A month of the forecast, named by the calendar month its middle falls in. */
export interface TimelineMonth {
  index: number;
  /** "Oct", with the year on January and on the first month: "Oct 26". */
  short: string;
  /** "October 2026". */
  long: string;
  /** "October": what the alerts say. */
  name: string;
  /** The first and last working day it covers (ISO dates). The first month starts today, and the last may stop short of its month's end. */
  from: string;
  to: string;
  /** The first month starts part-way through its calendar month, or the last ends before its calendar month does: a part month. */
  partial: boolean;
  /** What a part month covers, "from 28 Oct", "to 27 Oct" (or both); null for a whole month. */
  span: string | null;
  /** `long`, and for a part month what it covers: "November 2026 (from 28 Oct)". For tables and tooltips. */
  label: string;
}

/**
 * The calendar months of a forecast that starts on `startDate` (ISO), one per month of the run, each named by the
 * calendar month its middle falls in (with calendar month edges, the month it is; a first or last part of a month
 * joined to its neighbour takes the neighbour's name).
 */
export function timelineMonths(startDate: string, months: MonthlyResult["months"], hoursPerWeek: number): TimelineMonth[] {
  const last = months.length - 1;
  return months.map((mo, index) => {
    const mid = dateAtHour(startDate, (mo.start + mo.end) / 2, hoursPerWeek);
    const month = mid.getUTCMonth();
    const year = mid.getUTCFullYear();
    const name = MONTH_NAMES[month]!;
    const yy = String(year % 100).padStart(2, "0");
    // The days it covers. Only the first month (it starts today) and the last (the horizon is weeks, not months) can be part of one.
    const first = dateAtHour(startDate, mo.start, hoursPerWeek);
    const final = dateAtHour(startDate, Math.max(mo.start, mo.end - 1e-6), hoursPerWeek);
    const partStart = index === 0 && !isMonthEdge(first, -1);
    const partEnd = index === last && !isMonthEdge(final, 1);
    const span = partStart || partEnd ? [partStart ? `from ${dayMonth(first)}` : "", partEnd ? `to ${dayMonth(final)}` : ""].filter(Boolean).join(" ") : null;
    const long = `${name} ${year}`;
    return { index, name, long, short: index === 0 || month === 0 ? `${name.slice(0, 3)} ${yy}` : name.slice(0, 3), from: isoDay(first), to: isoDay(final), partial: span !== null, span, label: span ? `${long} (${span})` : long };
  });
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayMonth = (d: Date) => `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]!.slice(0, 3)}`;

/** Is `d` the first (`-1`) or last (`1`) working day of its calendar month? Its neighbouring working day, before or after, is in another month. */
function isMonthEdge(d: Date, dir: -1 | 1): boolean {
  const n = new Date(d);
  do n.setUTCDate(n.getUTCDate() + dir);
  while (n.getUTCDay() === 0 || n.getUTCDay() === 6);
  return n.getUTCMonth() !== d.getUTCMonth();
}

/**
 * A line saying which columns are part months, for under a chart or table: "Part months: the first column covers from 5 Oct, the last
 * to 27 Oct; the others are whole months." Null when every month is whole.
 */
export function partMonthNote(months: readonly Pick<TimelineMonth, "partial" | "span" | "index">[]): string | null {
  const parts = months.filter((m) => m.partial);
  if (!parts.length) return null;
  const which = (m: (typeof parts)[number]) => (m.index === 0 ? "the first column" : "the last column");
  return `Part month${parts.length > 1 ? "s" : ""}: ${parts.map((m) => `${which(m)} covers ${m.span}`).join(", ")}; the others are whole months.`;
}

/** Something planned that changes someone's hours: a hire starting, someone leaving for good, or leave. */
export interface TimelineMarker {
  kind: "hire" | "end" | "leave";
  personId: string;
  personName: string;
  roleIds: string[];
  /** The month it starts in, and (leave) the month it ends in. */
  from: number;
  to: number;
  /** Where in the months it starts and ends, as months from the start (2.5 is halfway through the third month), for drawing. */
  at: number;
  until: number;
  /** "Ben Ortiz starts", "Leah Grant on leave". */
  label: string;
  /** When, in words: "1 Feb 2027", "14 Dec 2026 to 8 Jan 2027". */
  when: string;
}

const dayLabel = (d: Date) => `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}`;

/** A stretch of months under one market condition other than Stable. */
export interface MarketBand {
  from: number;
  to: number;
  name: string;
}

/** One row of the timeline: a busy share per month (roles, people), or a count (clients). */
export interface TimelineRow {
  id: string;
  name: string;
  /** Null for a month with nobody there. */
  series: (MonthBusy | null)[];
  /** Roles: hours a week of work nobody in the role is there to do, per month (null when none). */
  uncovered?: (number | null)[];
  markers: TimelineMarker[];
}

export interface ClientRow {
  /** Service id; "" for the pooled count. */
  id: string;
  name: string;
  series: Stat[];
}

export interface TimelineData {
  months: TimelineMonth[];
  roles: TimelineRow[];
  people: TimelineRow[];
  clients: ClientRow[];
  market: MarketBand[];
  markers: TimelineMarker[];
}

/** The planned hires, end dates and leave of the model's people, as months of the forecast (inside the horizon only). */
export function plannedMarkers(model: EngineModel, monthly: NonNullable<SimulationResult["monthly"]>, startDate: string): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  const last = monthly.months.length - 1;
  const end = monthly.months[last]!.end;
  /** Months from the start, with the fraction of the month: months differ in length, the timeline's columns don't. */
  const at = (hour: number) => {
    const h = Math.min(end, Math.max(0, hour));
    if (h >= end) return last + 1;
    const i = monthOfHour(monthly, h)!;
    const mo = monthly.months[i]!;
    return i + (h - mo.start) / (mo.end - mo.start);
  };
  const day = (hour: number) => dayLabel(dateAtHour(startDate, hour, model.hoursPerWeek));
  for (const [id, p] of Object.entries(model.people ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const base = { personId: id, personName: p.name, roleIds: p.roles };
    if (p.from !== undefined && p.from > 0) {
      const m = monthOfHour(monthly, p.from);
      if (m !== null) out.push({ ...base, kind: "hire", from: m, to: m, at: at(p.from), until: at(p.from), label: `${p.name} starts`, when: day(p.from) });
    }
    if (p.until !== undefined && p.until > 0) {
      const m = monthOfHour(monthly, p.until);
      // Their last day is the one before the hour they are gone from.
      if (m !== null) out.push({ ...base, kind: "end", from: m, to: m, at: at(p.until), until: at(p.until), label: `${p.name} leaves`, when: day(Math.max(0, p.until - 1)) });
    }
    for (const [a, b] of p.leave ?? []) {
      const from = monthOfHour(monthly, Math.max(0, a));
      if (from === null) continue;
      // The month of its last hour (the window ends just before `b`).
      const to = monthOfHour(monthly, b - 1e-6) ?? last;
      out.push({ ...base, kind: "leave", from, to, at: at(a), until: at(b), label: `${p.name} on leave`, when: `${day(Math.max(0, a))} to ${day(b - 1)}` });
    }
  }
  return out;
}

/**
 * The market schedule's conditions other than Stable, as runs of the forecast's months. The schedule's months are the
 * engine's (52/12 weeks from the start, see market.ts); each forecast month takes the condition at its middle.
 */
export function marketBands(bundle: Pick<ProcessBundle, "marketSchedule" | "marketConditions">, months: MonthlyResult["months"], hoursPerWeek: number): MarketBand[] {
  const byId = new Map((bundle.marketConditions ?? []).map((c) => [c.id, c]));
  const scheduleHours = (52 / 12) * hoursPerWeek;
  const bySchedule: (string | null)[] = new Array<string | null>(24).fill(null);
  // Later entries win where they overlap, as the engine reads the schedule (marketFromSchedule).
  for (const e of bundle.marketSchedule ?? []) {
    const c = byId.get(e.condition_id);
    if (!c) continue;
    for (let m = Math.max(1, e.from_month); m <= Math.min(24, e.to_month); m++) bySchedule[m - 1] = c.preset === "stable" ? null : c.name;
  }
  // The last month of the schedule holds after it ends, as in the engine.
  const conditionAt = (hour: number) => bySchedule[Math.min(23, Math.floor(hour / scheduleHours))] ?? null;
  const names = months.map((mo) => conditionAt((mo.start + mo.end) / 2));
  const bands: MarketBand[] = [];
  names.forEach((name, i) => {
    const prev = bands[bands.length - 1];
    if (name === null) return;
    if (prev && prev.name === name && prev.to === i - 1) prev.to = i;
    else bands.push({ from: i, to: i, name });
  });
  return bands;
}

/** Rows with any work in the forecast (or work nobody is there to do), in the model's order for roles and by name for people. */
const busyRows = (
  series: Record<string, (MonthBusy | null)[]>,
  names: [string, string][],
  markersOf: (id: string) => TimelineMarker[],
  uncovered?: Record<string, (number | null)[]>,
): TimelineRow[] =>
  names
    .filter(([id]) => series[id]?.some((m) => m && m.p90 > 0.005) || uncovered?.[id]?.some((h) => h !== null))
    .map(([id, name]) => ({ id, name, series: series[id]!, ...(uncovered?.[id]?.some((h) => h !== null) ? { uncovered: uncovered[id]! } : {}), markers: markersOf(id) }));

/** Options for a run that has a plan in it (B7). */
export interface TimelineOptions {
  /**
   * The model whose people's start dates, end dates and leave are drawn as markers (default `model`). With a plan, pass the
   * model without it, so Settings' hires and leave are drawn per row as always and the plan's are not drawn twice (the plan
   * lane draws them).
   */
  markersModel?: EngineModel;
  /** Ids of the people a plan added: their "By person" rows are named "<name> (plan)". */
  planPeople?: ReadonlySet<string>;
}

/** Everything the timeline draws, from a month-by-month run of `model` that starts on `startDate`. */
export function timelineData(
  model: EngineModel,
  result: SimulationResult,
  bundle: Pick<ProcessBundle, "marketSchedule" | "marketConditions" | "services" | "viewer">,
  startDate: string,
  options: TimelineOptions = {},
): TimelineData | null {
  const monthly = result.monthly;
  if (!monthly) return null;
  const months = timelineMonths(startDate, monthly.months, model.hoursPerWeek);
  const markers = plannedMarkers(options.markersModel ?? model, monthly, startDate);
  const roleNames = Object.entries(model.roles).map(([id, r]): [string, string] => [id, r.name]);
  // A member or viewer sees their own person's row only (B1 2b); the roles and the clients stay.
  const people = ownRowsOnly(viewerOf(bundle), Object.entries(result.resolvedPeople), ([id]) => id)
    .map(([id, p]): [string, string] => [id, options.planPeople?.has(id) ? `${p.name} (plan)` : p.name])
    .sort((a, b) => a[1].localeCompare(b[1]));
  const serviceName = new Map(bundle.services.map((s) => [s.id, s.name]));
  return {
    months,
    roles: busyRows(monthly.roles, roleNames, (rid) => markers.filter((m) => m.roleIds.includes(rid)), monthly.uncovered),
    people: busyRows(monthly.people, people, (pid) => markers.filter((m) => m.personId === pid)),
    clients: Object.entries(monthly.clients).map(([id, series]) => ({ id, name: id ? (serviceName.get(id) ?? model.services?.[id]?.name ?? "Other") : "Clients", series })),
    market: marketBands(bundle, monthly.months, model.hoursPerWeek),
    markers,
  };
}
