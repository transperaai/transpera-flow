// The plan lane's markers in words (B7, issue #36): what each marker is called, when it is, and what is wrong with it.
// Pure: no React.

import type { ForecastPlanMarker, ProcessBundle, SolutionRow } from "@transpera-flow/db";
import { hireNames, leaveEnd, type MarkerProblem } from "./plan";
import { hoursToDate } from "./positions";

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

/** One marker as the plan lane draws and announces it. */
export interface PlanLaneMarker {
  id: string;
  kind: ForecastPlanMarker["kind"];
  date: string;
  /** Leave: its last day (the Friday of the last week). */
  endDate?: string;
  /** "New PPC specialist starts", "Leah Brooks on leave", "Faster PPC campaign setup goes live". */
  label: string;
  /** "1 Mar 2027", "14 Dec 2026 to 1 Jan 2027". */
  when: string;
  /** What is wrong with it today (a role, person or solution that is gone), in words. */
  problem?: string;
}

/** Every marker of a plan in words, in the plan's order. */
export function laneMarkers(
  bundle: Pick<ProcessBundle, "roles" | "people">,
  markers: readonly ForecastPlanMarker[],
  solutions: readonly Pick<SolutionRow, "id" | "name">[],
  problems: readonly MarkerProblem[],
  startDate: string,
  hoursPerWeek: number,
): PlanLaneMarker[] {
  const names = hireNames(bundle, markers);
  const people = new Map(bundle.people.map((p) => [p.id, p.name]));
  const solutionNames = new Map(solutions.map((s) => [s.id, s.name]));
  const problemOf = new Map(problems.map((p) => [p.markerId, p.message]));
  return markers.map((m): PlanLaneMarker => {
    const problem = problemOf.get(m.id);
    const base = { id: m.id, kind: m.kind, date: m.date, ...(problem ? { problem } : {}) };
    if (m.kind === "hire") {
      const started = hoursToDate(startDate, m.date, hoursPerWeek) <= 0;
      return { ...base, label: `${names.get(m.id)!} starts${started ? " (already started)" : ""}`, when: shortDate(m.date) };
    }
    if (m.kind === "leave") {
      const endDate = leaveEnd(m.date, m.weeks);
      return { ...base, endDate, label: `${people.get(m.person_id) ?? "Someone"} on leave`, when: `${shortDate(m.date)} to ${shortDate(endDate)}` };
    }
    return { ...base, label: `${solutionNames.get(m.solution_id) ?? "A solution"} goes live`, when: shortDate(m.date) };
  });
}
