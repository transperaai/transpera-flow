// The forecast's monthly timeline (issue #35, B6), as data for the chart: how busy each role and person is per month,
// the client groups by service, the market conditions from the schedule, and markers for planned hires, end dates and
// leave. Pure (no React), so it is tested without a browser, and shared: any screen that runs the model month by month
// (`simulate(…, { monthly: true })`) can draw the same timeline from it (the Overview's team load chart, B15).

import { monthOfHour, type EngineModel, type MonthBusy, type SimulationResult, type Stat } from "@transpera-flow/engine";
import type { ProcessBundle } from "@transpera-flow/db";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A month of the forecast, named by the calendar month it starts in. */
export interface TimelineMonth {
  index: number;
  /** "Oct", with the year on January and on the first month: "Oct 26". */
  short: string;
  /** "October 2026". */
  long: string;
  /** "October": what the alerts say. */
  name: string;
}

/**
 * The calendar months of a forecast that starts on `startDate` (ISO): month i is the calendar month i months on.
 * The engine's months are 52/12 weeks of working time, so this is the month each one mostly falls in.
 */
export function timelineMonths(startDate: string, count: number): TimelineMonth[] {
  const [y, m] = startDate.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, index) => {
    const month = (m - 1 + index) % 12;
    const year = y + Math.floor((m - 1 + index) / 12);
    const name = MONTH_NAMES[month]!;
    const yy = String(year % 100).padStart(2, "0");
    return { index, name, long: `${name} ${year}`, short: index === 0 || month === 0 ? `${name.slice(0, 3)} ${yy}` : name.slice(0, 3) };
  });
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
  /** Where in the months it starts and ends, as months from the start (2.5 is halfway through the third), for drawing. */
  at: number;
  until: number;
  /** "Ben Ortiz starts", "Leah Grant on leave". */
  label: string;
  /** When, in words: "1 Feb 2027", "14 Dec 2026 to 8 Jan 2027". */
  when: string;
}

/** The calendar date `hours` working hours after the start of `startDate` (weekdays only, as the model counts them). */
export function dateAtHour(startDate: string, hours: number, hoursPerWeek: number): Date {
  const perDay = hoursPerWeek / 5;
  let days = Math.floor(hours / perDay + 1e-9);
  const d = new Date(`${startDate}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  while (days > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days--;
  }
  return d;
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
  const monthHours = (52 / 12) * model.hoursPerWeek;
  const end = monthly.months[last]!.end;
  const at = (hour: number) => Math.min(end, Math.max(0, hour)) / monthHours;
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

/** The market schedule's conditions other than Stable, as runs of months inside the first `count` months. */
export function marketBands(bundle: Pick<ProcessBundle, "marketSchedule" | "marketConditions">, count: number): MarketBand[] {
  const byId = new Map((bundle.marketConditions ?? []).map((c) => [c.id, c]));
  const months: (string | null)[] = new Array<string | null>(count).fill(null);
  // Later entries win where they overlap, as the engine reads the schedule (marketFromSchedule).
  for (const e of bundle.marketSchedule ?? []) {
    const c = byId.get(e.condition_id);
    if (!c || c.preset === "stable") continue;
    for (let m = Math.max(1, e.from_month); m <= Math.min(count, e.to_month); m++) months[m - 1] = c.name;
  }
  const bands: MarketBand[] = [];
  months.forEach((name, i) => {
    const prev = bands[bands.length - 1];
    if (name === null) return;
    if (prev && prev.name === name && prev.to === i - 1) prev.to = i;
    else bands.push({ from: i, to: i, name });
  });
  return bands;
}

/** Rows with any work in the forecast, in the model's order for roles and by name for people. */
const busyRows = (series: Record<string, (MonthBusy | null)[]>, names: [string, string][], markersOf: (id: string) => TimelineMarker[]): TimelineRow[] =>
  names.filter(([id]) => series[id]?.some((m) => m && m.p90 > 0.005)).map(([id, name]) => ({ id, name, series: series[id]!, markers: markersOf(id) }));

/** Everything the timeline draws, from a month-by-month run of `model` that starts on `startDate`. */
export function timelineData(
  model: EngineModel,
  result: SimulationResult,
  bundle: Pick<ProcessBundle, "marketSchedule" | "marketConditions" | "services">,
  startDate: string,
): TimelineData | null {
  const monthly = result.monthly;
  if (!monthly) return null;
  const months = timelineMonths(startDate, monthly.months.length);
  const markers = plannedMarkers(model, monthly, startDate);
  const roleNames = Object.entries(model.roles).map(([id, r]): [string, string] => [id, r.name]);
  const people = Object.entries(result.resolvedPeople)
    .map(([id, p]): [string, string] => [id, p.name])
    .sort((a, b) => a[1].localeCompare(b[1]));
  const serviceName = new Map(bundle.services.map((s) => [s.id, s.name]));
  return {
    months,
    roles: busyRows(monthly.roles, roleNames, (rid) => markers.filter((m) => m.roleIds.includes(rid))),
    people: busyRows(monthly.people, people, (pid) => markers.filter((m) => m.personId === pid)),
    clients: Object.entries(monthly.clients).map(([id, series]) => ({ id, name: id ? (serviceName.get(id) ?? model.services?.[id]?.name ?? "Other") : "Clients", series })),
    market: marketBands(bundle, months.length),
    markers,
  };
}
