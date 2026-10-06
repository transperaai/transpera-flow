// Forecast plans (issue #36, B7): a named set of markers (hires, leave, solutions going live) and what it does to the
// bundle the forecast runs. Pure: no React, no database. A hire or leave marker becomes extra `people`, `person_roles`
// and `person_leave` rows before `forecastModel` builds the model, exactly as a planned hire from Settings does. A
// solution can't switch a process's steps mid-run, so `planSegments` lists the runs a plan needs and `spliceMonthly`
// (splice.ts) joins their month-by-month numbers.

import { workingDaysBetween, type ForecastPlanMarker, type PersonLeaveRow, type PersonRoleRow, type PersonRow, type ProcessBundle, type ProcessPart, type SolutionRow } from "@transpera-flow/db";
import { bundleFromSolution } from "@/lib/solutions/bundle";
import { addDays, hoursToDate } from "./positions";

export const MAX_PLANS = 50;
export const MAX_MARKERS = 40;
export const MAX_SOLUTIONS = 4;
export const MAX_NAME = 120;

/** What can be wrong with a marker today, in words, for the "needs attention" list. */
export type MarkerProblem = { markerId: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date between 2000 and 2100, as the database checks. */
export function isPlanDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== value) return false;
  return value >= "2000-01-01" && value <= "2100-12-31";
}

/** What `parsePlanInput` needs to refuse two solutions for one process in one month. Without it that check is skipped. */
export interface PlanParseContext {
  solutions: readonly Pick<SolutionRow, "id" | "process_id">[];
  processName: (processId: string) => string;
}

const NOT_VALID = "A marker in this plan isn't valid.";

/** A marker as typed, checked as the database checks it; null with the reason when it isn't valid. */
function parseMarker(raw: unknown): { ok: true; marker: ForecastPlanMarker } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(NOT_VALID);
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !UUID.test(m.id)) return fail(NOT_VALID);
  if (!isPlanDate(m.date)) return fail("A marker's date isn't valid.");
  const only = (...keys: string[]) => Object.keys(m).every((k) => keys.includes(k));
  if (m.kind === "hire") {
    if (!only("id", "kind", "date", "role_id", "fte", "name")) return fail(NOT_VALID);
    if (typeof m.role_id !== "string" || !UUID.test(m.role_id)) return fail("A hire needs a role.");
    if (typeof m.fte !== "number" || !Number.isFinite(m.fte) || m.fte < 0.1 || m.fte > 2) return fail("A hire's FTE must be between 0.1 and 2.");
    let name: string | undefined;
    if (m.name !== undefined) {
      if (typeof m.name !== "string") return fail(NOT_VALID);
      name = m.name.trim();
      if (name.length > MAX_NAME) return fail(`A name can have up to ${MAX_NAME} characters.`);
    }
    return { ok: true, marker: { id: m.id, kind: "hire", date: m.date, role_id: m.role_id, fte: m.fte, ...(name ? { name } : {}) } };
  }
  if (m.kind === "leave") {
    if (!only("id", "kind", "date", "person_id", "weeks")) return fail(NOT_VALID);
    if (typeof m.person_id !== "string" || !UUID.test(m.person_id)) return fail("Leave needs a person.");
    if (typeof m.weeks !== "number" || !Number.isInteger(m.weeks) || m.weeks < 1 || m.weeks > 52) return fail("Leave lasts 1 to 52 whole weeks.");
    return { ok: true, marker: { id: m.id, kind: "leave", date: m.date, person_id: m.person_id, weeks: m.weeks } };
  }
  if (m.kind === "solution") {
    if (!only("id", "kind", "date", "solution_id")) return fail(NOT_VALID);
    if (typeof m.solution_id !== "string" || !UUID.test(m.solution_id)) return fail("A solution marker needs a solution.");
    return { ok: true, marker: { id: m.id, kind: "solution", date: m.date, solution_id: m.solution_id } };
  }
  return fail(NOT_VALID);
}

/** A plan's name and markers as typed, checked (as the database checks, plus "two solutions for one process in one month"). */
export function parsePlanInput(
  input: unknown,
  context?: PlanParseContext,
): { ok: true; value: { name: string; markers: ForecastPlanMarker[] } } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "That plan isn't valid." };
  const { name: rawName, markers: rawMarkers } = input as { name?: unknown; markers?: unknown };
  if (typeof rawName !== "string") return { ok: false, error: "Give the plan a name." };
  const name = rawName.trim();
  if (!name) return { ok: false, error: "Give the plan a name." };
  if (name.length > MAX_NAME) return { ok: false, error: `A plan's name can have up to ${MAX_NAME} characters.` };
  if (!Array.isArray(rawMarkers)) return { ok: false, error: "That plan isn't valid." };
  if (rawMarkers.length > MAX_MARKERS) return { ok: false, error: `A plan can have up to ${MAX_MARKERS} markers.` };
  const markers: ForecastPlanMarker[] = [];
  const seen = new Set<string>();
  for (const raw of rawMarkers) {
    const parsed = parseMarker(raw);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.marker.id)) return { ok: false, error: NOT_VALID };
    seen.add(parsed.marker.id);
    markers.push(parsed.marker);
  }
  const solutionMarkers = markers.filter((m): m is Extract<ForecastPlanMarker, { kind: "solution" }> => m.kind === "solution");
  if (solutionMarkers.length > MAX_SOLUTIONS) return { ok: false, error: `A plan can have up to ${MAX_SOLUTIONS} solutions.` };
  if (context) {
    const processOf = new Map(context.solutions.map((s) => [s.id, s.process_id]));
    const taken = new Set<string>();
    for (const m of solutionMarkers) {
      const process = processOf.get(m.solution_id);
      if (!process) continue;
      const key = `${process}|${m.date.slice(0, 7)}`;
      if (taken.has(key)) return { ok: false, error: `Two solutions for ${context.processName(process)} can't go live in the same month.` };
      taken.add(key);
    }
  }
  return { ok: true, value: { name, markers } };
}

/** The last day of leave of `weeks` whole weeks from the Monday `date`: the Friday of the last week. */
export const leaveEnd = (date: string, weeks: number): string => addDays(date, 7 * weeks - 3);

/**
 * The name each hire marker shows: the one typed, or "New <role name>", numbered "New PPC specialist 2" when several
 * hires share the default (in the order of the markers). A hire whose role is gone is "New hire" (unless named).
 */
export function hireNames(bundle: Pick<ProcessBundle, "roles">, markers: readonly ForecastPlanMarker[]): Map<string, string> {
  const roleName = new Map(bundle.roles.map((r) => [r.id, r.name]));
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const m of markers) {
    if (m.kind !== "hire") continue;
    const typed = m.name?.trim();
    if (typed) {
      out.set(m.id, typed);
      continue;
    }
    const base = `New ${roleName.get(m.role_id) ?? "hire"}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    out.set(m.id, count > 1 ? `${base} ${count}` : base);
  }
  return out;
}

/**
 * The bundle with the plan's hires and leave in it: a hire is a person row (`name` or "New <role name>", numbered
 * "New PPC specialist 2" when there are several, `fte`, `capacity_hours_week: null`, `cost_rate: null`, `active: true`,
 * `start_date: date`, `end_date: null`) with one `person_roles` row; leave is a `person_leave` row from `date` to
 * `date + 7 × weeks − 3` days (Monday to Friday of the last week). Ids: the marker's id for the person and the leave row.
 * Markers whose role or person is gone, or whose person is inactive, are skipped and returned as problems.
 * Solution markers are ignored here.
 *
 * The engine adds up a person's leave windows, so overlapping ones would count twice: a person who gets plan leave has
 * their leave rows (Settings' and the plan's) that overlap or touch merged into one.
 */
export function applyPlanPeople(bundle: ProcessBundle, markers: readonly ForecastPlanMarker[]): { bundle: ProcessBundle; problems: MarkerProblem[] } {
  const problems: MarkerProblem[] = [];
  const workspace_id = bundle.workspace.id;
  const roleName = new Map(bundle.roles.map((r) => [r.id, r.name]));
  const people: PersonRow[] = [];
  const personRoles: PersonRoleRow[] = [];
  const names = hireNames(bundle, markers);
  for (const m of markers) {
    if (m.kind !== "hire") continue;
    if (!roleName.has(m.role_id)) {
      problems.push({ markerId: m.id, message: `The role of “${m.name?.trim() || "a new hire"}” isn't there any more` });
      continue;
    }
    const name = names.get(m.id)!;
    people.push({ id: m.id, workspace_id, name, fte: m.fte, capacity_hours_week: null, cost_rate: null, active: true, start_date: m.date, end_date: null });
    personRoles.push({ person_id: m.id, role_id: m.role_id, workspace_id });
  }
  const leaveByPerson = new Map<string, PersonLeaveRow[]>();
  const planLeave: PersonLeaveRow[] = [];
  const activePeople = new Map(bundle.people.map((p) => [p.id, p]));
  for (const m of markers) {
    if (m.kind !== "leave") continue;
    const person = activePeople.get(m.person_id);
    if (!person) {
      problems.push({ markerId: m.id, message: "Someone on leave in this plan is no longer on the team" });
      continue;
    }
    if (!person.active) {
      problems.push({ markerId: m.id, message: `${person.name} is no longer on the team` });
      continue;
    }
    planLeave.push({ id: m.id, person_id: m.person_id, workspace_id, start_date: m.date, end_date: leaveEnd(m.date, m.weeks) });
    leaveByPerson.set(m.person_id, []);
  }
  const merged = new Map<string, PersonLeaveRow[]>();
  for (const personId of leaveByPerson.keys()) {
    const rows = [...bundle.personLeave.filter((l) => l.person_id === personId), ...planLeave.filter((l) => l.person_id === personId)].sort(
      (a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0),
    );
    const out: PersonLeaveRow[] = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      // Overlapping, or with no working day between them (a Friday's end and the next Monday's start).
      if (last && workingDaysBetween(addDays(last.end_date, 1), row.start_date) <= 0) {
        if (row.end_date > last.end_date) last.end_date = row.end_date;
      } else out.push({ ...row });
    }
    merged.set(personId, out);
  }
  const personLeave = [...bundle.personLeave.filter((l) => !merged.has(l.person_id)), ...[...merged.values()].flat()];
  return { bundle: { ...bundle, people: [...bundle.people, ...people], personRoles: [...bundle.personRoles, ...personRoles], personLeave }, problems };
}

/**
 * The bundle with a solution's copy in place of its process: the main process (`bundle.process.id`) through
 * `bundleFromSolution`, or the matching part in `bundle.otherProcesses` (steps and edges swapped, its revision kept).
 * Null when the process isn't part of the company model the forecast runs.
 */
export function withSolution(bundle: ProcessBundle, solution: Pick<SolutionRow, "process_id" | "steps">): ProcessBundle | null {
  if (solution.process_id === bundle.process.id) return bundleFromSolution(bundle, solution);
  const parts = bundle.otherProcesses ?? [];
  const index = parts.findIndex((p) => p.process.id === solution.process_id);
  if (index < 0) return null;
  const part = parts[index]!;
  const at = { revision_id: part.revision.id, workspace_id: part.process.workspace_id, process_id: part.process.id };
  const swapped: ProcessPart = {
    ...part,
    steps: solution.steps.steps.map((s) => ({ ...structuredClone(s), ...at }) as ProcessPart["steps"][number]),
    edges: solution.steps.edges.map((e) => ({ ...structuredClone(e), ...at }) as ProcessPart["edges"][number]),
  };
  return { ...bundle, otherProcesses: parts.map((p, i) => (i === index ? swapped : p)) };
}

/** One run of a plan: from month `from` on, this bundle's numbers are used. */
export interface PlanSegment {
  from: number;
  bundle: ProcessBundle;
  solutionIds: string[];
}

/**
 * The runs a plan needs. `bounds` are the months' edges in working hours ([0, ...monthStarts, H]). Each solution marker
 * goes live in the month its date falls in (a date on or before the start: month 0; at or after the horizon: left out and
 * listed in `later`, by marker id). Segment 0 starts at month 0; one more segment per distinct go-live month; each
 * segment's bundle has the plan's people applied and every solution live by then (for one process, the latest one by
 * date wins). Missing solutions and solutions of processes outside the company model are problems, skipped.
 */
export function planSegments(
  bundle: ProcessBundle,
  markers: readonly ForecastPlanMarker[],
  solutions: readonly SolutionRow[],
  startDate: string,
  bounds: readonly number[],
  hoursPerWeek: number,
): { segments: PlanSegment[]; problems: MarkerProblem[]; later: string[] } {
  const { bundle: withPeople, problems } = applyPlanPeople(bundle, markers);
  const n = bounds.length - 1;
  const horizon = bounds[n]!;
  const byId = new Map(solutions.map((s) => [s.id, s]));
  const later: string[] = [];
  const live: { marker: Extract<ForecastPlanMarker, { kind: "solution" }>; solution: SolutionRow; month: number }[] = [];
  for (const m of markers) {
    if (m.kind !== "solution") continue;
    const solution = byId.get(m.solution_id);
    if (!solution) {
      problems.push({ markerId: m.id, message: "A solution in this plan was deleted" });
      continue;
    }
    if (withSolution(withPeople, solution) === null) {
      problems.push({ markerId: m.id, message: `“${solution.name}” changes a process the forecast doesn't run` });
      continue;
    }
    const hour = hoursToDate(startDate, m.date, hoursPerWeek);
    if (hour >= horizon) {
      later.push(m.id);
      continue;
    }
    let month = 0;
    if (hour > 0) while (month < n - 1 && bounds[month + 1]! <= hour) month++;
    live.push({ marker: m, solution, month });
  }
  // The latest by date wins for one process: apply in date order, then marker order.
  live.sort((a, b) => (a.marker.date < b.marker.date ? -1 : a.marker.date > b.marker.date ? 1 : 0));
  const starts = [...new Set([0, ...live.map((l) => l.month)])].sort((a, b) => a - b);
  const segments = starts.map((from): PlanSegment => {
    let b = withPeople;
    const solutionIds: string[] = [];
    for (const l of live) {
      if (l.month > from) continue;
      b = withSolution(b, l.solution)!;
      solutionIds.push(l.solution.id);
    }
    return { from, bundle: b, solutionIds };
  });
  return { segments, problems, later };
}
