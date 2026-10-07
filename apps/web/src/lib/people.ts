// What the People page shows, worked out from a run (issue #120). Pure, so it can be unit tested.

import type { ProcessBundle } from "@transpera-flow/db";
import {
  absenceCandidates,
  absenceRating,
  resolvePeople,
  type AbsenceTest,
  type EngineModel,
  type EnginePerson,
  type Rating,
  type RatingConfig,
  type SimulationResult,
} from "@transpera-flow/engine";

/** A person whose utilisation at or above this in a bad month (the 90th percentile) counts as too busy; as on the rating model's busy rule. */
export const BUSY_LIMIT = 0.85;

export interface PersonBusy {
  id: string;
  name: string;
  /** Role names, comma separated. */
  role: string;
  /** Full-time equivalent from the person's record; null when the model made the person up from a role's head-count. */
  fte: number | null;
  /** Average utilisation over the runs, 0 to 1 and a bit above with overtime. */
  average: number;
  /** A bad month: the 90th percentile over the runs. */
  p90: number;
  /** Shares of the person's capacity, averaged over the runs. */
  clientWork: number;
  salesWork: number;
  overtime: number;
  /** Working days of leave inside the run's period. */
  leaveDays: number;
}

/** Working days in a week: the model's working day is `hoursPerWeek / 5` (WORKING_DAYS_PER_WEEK in packages/db/src/model.ts, not exported). */
const WORKING_DAYS_PER_WEEK = 5;

/** Working days of `person`'s leave inside the first `horizonHours` of the run; leave before the start or after the end doesn't count. */
export function leaveDays(person: EnginePerson, horizonHours: number, hoursPerWeek: number): number {
  const hours = (person.leave ?? []).reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, horizonHours) - Math.max(a, 0)), 0);
  return hours / (hoursPerWeek / WORKING_DAYS_PER_WEEK);
}

/** First role's place in role order, then name: the one order the page uses for people (D20: never ranked). */
function byRoleThenName(roleOrder: readonly string[]) {
  return (a: { roles: readonly string[]; name: string }, b: { roles: readonly string[]; name: string }) =>
    roleOrder.indexOf(a.roles[0] ?? "") - roleOrder.indexOf(b.roles[0] ?? "") || a.name.localeCompare(b.name);
}

/** Everyone in the run with their average and P90 utilisation, grouped by their first role in role order, then by name. */
export function personRows(model: EngineModel, result: SimulationResult, fteById: ReadonlyMap<string, number>): PersonBusy[] {
  const roleOrder = Object.keys(model.roles);
  const horizonHours = model.horizonWeeks * model.hoursPerWeek;
  return Object.entries(result.resolvedPeople)
    .flatMap(([id, p]) => {
      const band = result.kpi.people[id];
      if (!band) return [];
      return [
        {
          roles: p.roles,
          name: p.name,
          row: {
            id,
            name: p.name,
            role: p.roles.map((rid) => model.roles[rid]?.name).filter(Boolean).join(", "),
            fte: fteById.get(id) ?? null,
            average: band.util.mean,
            p90: band.util.p90,
            clientWork: band.ongoing.mean + band.servicing.mean,
            salesWork: band.pipeline.mean,
            overtime: band.overtime.mean,
            leaveDays: leaveDays(p, horizonHours, model.hoursPerWeek),
          } satisfies PersonBusy,
        },
      ];
    })
    .sort(byRoleThenName(roleOrder))
    .map((r) => r.row);
}

export interface TeamSummary {
  people: number;
  /** Total full-time equivalents of the people who have one on record; null when none do. */
  fte: number | null;
  /** People whose bad month (P90) is above the busy limit. */
  busyInBadMonth: number;
}

export function teamSummary(rows: readonly PersonBusy[]): TeamSummary {
  const withFte = rows.filter((r) => r.fte !== null);
  return {
    people: rows.length,
    fte: withFte.length ? withFte.reduce((a, r) => a + r.fte!, 0) : null,
    busyInBadMonth: rows.filter((r) => r.p90 > BUSY_LIMIT).length,
  };
}

export interface AbsenceRow {
  id: string;
  name: string;
  role: string;
  /** Names of the steps only they can do, in model step order. */
  steps: string[];
  workLost: number;
  /** Weeks to catch up; when `recovered` is false, "more than" `weeksWatched`. */
  weeks: number;
  recovered: boolean;
  weeksWatched: number;
  clientDeadlineMissed: boolean;
  /** Null only if the rule is switched off (never with the documented defaults). */
  rating: Rating | null;
}

/**
 * Rule 8's results, one row per person tested, in the same order as `personRows` (never by work lost: D20). Rated with
 * `absenceRating`, as the Issues register does. The subject carries the person's first role and the first step; with the
 * documented defaults there are no overrides, so the subject changes nothing.
 */
export function absenceRows(model: EngineModel, test: AbsenceTest, config: RatingConfig): AbsenceRow[] {
  const people = resolvePeople(model);
  const roleOrder = Object.keys(model.roles);
  const stepOrder = model.steps.map((s) => s.id);
  return test.people
    .flatMap((f) => {
      const p = people[f.personId];
      if (!p) return [];
      const steps = stepOrder.filter((id) => f.stepIds.includes(id));
      return [
        {
          roles: p.roles,
          name: p.name,
          row: {
            id: f.personId,
            name: p.name,
            role: p.roles.map((rid) => model.roles[rid]?.name).filter(Boolean).join(", "),
            steps: steps.map((id) => model.steps.find((s) => s.id === id)!.name),
            workLost: f.workLost,
            weeks: f.recoveryWeeks,
            recovered: f.recovered,
            weeksWatched: f.recovered ? f.recoveryWeeks : Math.max(0, f.recoveryWeeks - 1),
            clientDeadlineMissed: f.clientDeadlineMissed,
            rating: absenceRating(config, f, { roleId: p.roles[0] ?? null, personId: f.personId, stepId: f.stepIds[0] ?? null }),
          } satisfies AbsenceRow,
        },
      ];
    })
    .sort(byRoleThenName(roleOrder))
    .map((r) => r.row);
}

/** People who are the only one for a step but weren't tested (over ABSENCE_MAX_PEOPLE, or the time budget ran out). */
export function untestedSoleHolders(model: EngineModel, test: AbsenceTest): string[] {
  const tested = new Set(test.people.map((f) => f.personId));
  return absenceCandidates(model)
    .map((c) => c.personId)
    .filter((id) => !tested.has(id));
}

/** Completed items for a person-step before a capacity factor counts as measured (PRD §6.3.7, D20). */
export const CAPACITY_FACTOR_MIN_ITEMS = 10;

/**
 * Whether a person's capacity factors may be shown (PRD §6.3.7, D20; #31). Only when the workspace has switched them on
 * and the factor is measured (at least 10 completed items for that person-step) or entered. C6 (#198) stores entered ones
 * (`person_capacity_factors`); nothing measures them yet (`measuredItems` is 0), so only entered ones show.
 */
export function capacityFactorsShown<F extends { measuredItems: number; entered: boolean }>(settings: unknown, factors: readonly F[]): F[] {
  const on = typeof settings === "object" && settings !== null && (settings as { capacity_factor_enabled?: unknown }).capacity_factor_enabled === true;
  return on ? factors.filter((f) => f.entered || f.measuredItems >= CAPACITY_FACTOR_MIN_ITEMS) : [];
}

/** The (i) text for "Time on each step", the same in Settings and on the People page. */
export const FACTOR_HELP = {
  description:
    "How long this person takes compared with their role's normal time. 1 is normal, 0.8 is 20% faster, 1.25 is 25% slower; from 0.5 to 2. Blank uses their time for every step, or the normal time. The simulation multiplies the hands-on time they spend on the step by this. Only owners and editors set it; the person sees their own.",
  example: "Every step 1, Kickoff 0.8: Maya's kickoffs take 20% less time than the role's normal; everything else takes the normal time.",
} as const;

/** The note a member or viewer sees when the switch is on: their numbers use everyone's normal time. */
export const SPEEDS_NORMALISED_NOTE = {
  text: "Per-person times are on in this workspace. Your numbers use each role's normal time, so they can differ a little from what owners and editors see.",
  description: "Each person's times are visible only to them and to owners and editors.",
  example: "Maya sees her own times and an editor sees everyone's, so a member's run uses each role's normal time instead.",
} as const;

/** How a factor reads in words: "normal time" at 1, "20% faster" below, "25% slower" above. */
export function factorWords(f: number): string {
  if (f === 1) return "normal time";
  const n = Math.round(Math.abs(1 - f) * 100);
  return `${n}% ${f < 1 ? "faster" : "slower"}`;
}

/** One person's time on a step, as the People page and Settings show it. Never ranked, never compared across people. */
export interface ShownFactor {
  /** Null: their time on every step they do. */
  stepId: string | null;
  stepName: string;
  factor: number;
  /** Completed items behind it when measured; 0 for an entered one (nothing is measured yet). */
  measuredItems: number;
  entered: boolean;
}

/**
 * The steps a person can do, for per-person times: their skills if they have any, otherwise the steps of their roles, in the
 * order of `steps`. One rule for Settings (which fields to offer) and the People page (which times to show), so a time on a step
 * they can no longer do is listed under "Not used now" in Settings and shown nowhere else. The engine ignores it too.
 */
export function stepsPersonCanDo<S extends { id: string; role_id: string | null }>(
  personId: string,
  steps: readonly S[],
  personSkills: readonly { person_id: string; step_id: string }[],
  personRoles: readonly { person_id: string; role_id: string }[],
): S[] {
  const skills = new Set(personSkills.filter((s) => s.person_id === personId).map((s) => s.step_id));
  const roles = new Set(personRoles.filter((r) => r.person_id === personId).map((r) => r.role_id));
  return steps.filter((s) => (skills.size > 0 ? skills.has(s.id) : s.role_id !== null && roles.has(s.role_id)));
}

/**
 * One person's per-person times from the bundle (`bundle.personCapacityFactors`, which for a member holds only their own): the
 * default first (named "Every step"), then the steps in `stepNames` in that map's order (the process's step order). Never sorted
 * by value. Steps not in `stepNames` are dropped.
 */
export function personFactors(bundle: ProcessBundle, personId: string, stepNames: Map<string, string>): ShownFactor[] {
  const mine = (bundle.personCapacityFactors ?? []).filter((f) => f.person_id === personId);
  const shown = (stepId: string | null, stepName: string, f: { factor: number; source: string }): ShownFactor => ({
    stepId,
    stepName,
    factor: Number(f.factor),
    measuredItems: 0,
    entered: f.source !== "measured",
  });
  const out: ShownFactor[] = [];
  const every = mine.find((f) => f.step_id === null);
  if (every) out.push(shown(null, "Every step", every));
  for (const [stepId, name] of stepNames) {
    const f = mine.find((r) => r.step_id === stepId);
    if (f) out.push(shown(stepId, name, f));
  }
  return out;
}

export interface PersonDetail {
  /** Role names. */
  roles: string[];
  hoursPerWeek: number;
  fte: number | null;
  /** ISO dates from the person's record. */
  startDate: string | null;
  endDate: string | null;
  /** Step names they can do; null means "every step of their roles" (no skill rows). */
  skills: string[] | null;
  /** Leave periods, ISO start and end, oldest first; only those ending today or later. Notes are never read. */
  leave: { start: string; end: string }[];
}

/** One person's record for the detail row; null for a person the engine made up from a role's head-count (not in `bundle.people`). */
export function personDetail(model: EngineModel, result: SimulationResult, bundle: ProcessBundle, id: string, today: string): PersonDetail | null {
  const row = bundle.people.find((p) => p.id === id);
  const resolved = result.resolvedPeople[id];
  if (!row || !resolved) return null;
  const stepName = new Map(model.steps.map((s) => [s.id, s.name]));
  return {
    roles: resolved.roles.map((rid) => model.roles[rid]?.name).filter((n): n is string => Boolean(n)),
    hoursPerWeek: resolved.capacity,
    fte: Number.isFinite(Number(row.fte)) ? Number(row.fte) : null,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    skills: resolved.skills === undefined ? null : model.steps.filter((s) => resolved.skills!.includes(s.id)).map((s) => stepName.get(s.id)!),
    leave: bundle.personLeave
      .filter((l) => l.person_id === id && l.end_date >= today)
      .map((l) => ({ start: l.start_date, end: l.end_date }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0)),
  };
}

/**
 * What the absence test left out. `tooShort` when it tested nobody although there are people to test: the run is too short
 * (the engine tests nothing when the run is shorter than the absence plus its start week), so "nobody is tested" would be wrong.
 * `untested` counts sole holders left out of a test that did run (over ABSENCE_MAX_PEOPLE, or the time budget). Both are limited
 * to `personIds` when the test was asked for only them (a member's own person).
 */
export function absenceCoverage(model: EngineModel, test: AbsenceTest, personIds?: readonly string[]): { tooShort: boolean; untested: number } {
  const left = untestedSoleHolders(model, test).filter((id) => !personIds || personIds.includes(id));
  const tooShort = test.people.length === 0 && left.length > 0;
  return { tooShort, untested: tooShort ? 0 : left.length };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Under 1 week", "1 week", "3 weeks"; when the queues never recovered, "Not within N weeks" (singular for 1, and no "0 weeks"). */
export function weeksLabel(r: Pick<AbsenceRow, "weeks" | "recovered" | "weeksWatched">): string {
  if (!r.recovered) {
    const n = Math.round(r.weeksWatched);
    return n < 1 ? "Not before the run ends" : `Not within ${plural(n, "week", "weeks")}`;
  }
  const n = Math.round(r.weeks);
  return n < 1 ? "Under 1 week" : plural(n, "week", "weeks");
}

/** "2 weeks", "1 week". */
export const weeksText = (n: number) => plural(n, "week", "weeks");
