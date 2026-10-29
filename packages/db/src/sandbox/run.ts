// Running a Sandbox scenario (docs/plans/sandbox-p1-brief.md §3): what its changes do to the bundle the forecast runs. Pure: no React,
// no database.
//
// Four mechanisms, all of them ones the engine already has:
//   * whole-run patches (`applyPatches`), for every patch lever with no `from`;
//   * people over time: a hire (D1), a leaver (D2), leave (D3) and an FTE change from a month (D4) become person rows with start and
//     end dates, as a planned hire from Settings is. One run, exact;
//   * splicing: a patch from a month (and a solution going live, D46/D48) cannot switch mid-run, so `scenarioSegments` lists the runs
//     it needs (one per distinct month, with everything in force by then) and `spliceMonthly` (lib/forecast/splice.ts) joins their
//     month-by-month numbers;
//   * a change whose target is gone is skipped and listed (`ChangeProblem`), never silent.
// A scenario's effective changes are its parents' first, then its own (./effective.ts).

import { workingDaysBetween, ModelError, engineMarket, toEngineModel } from "../model";
import { sandboxLever, patchOf, type SandboxChange } from "../sandbox-levers";
import type { PersonLeaveRow, PersonRoleRow, PersonRow, PersonSkillRow, PersonCapacityFactorRow, ProcessBundle, ProcessPart, SolutionRow } from "../types";
import { applyPatches, checkScenario, initialState, type EngineModel, type InitialState, type RetiredSteps, type ScenarioPatch } from "@transpera-flow/engine";
import { retiredSteps } from "../retired";
import { addDays, addMonths, calendarMonthStarts, horizonWeeks, hoursToDate, monthBounds } from "./months";
import { bundleFromSolution } from "./solution";
import { channelsOf, isChannelChange, overheadsCarried } from "./channels";
import { applyBundleChanges, applyModelChanges } from "./edits";
import type { EffectiveChange } from "./effective";

/** What can be wrong with a change today, in words, for the "needs attention" list. `note` marks something applied but worth knowing (a value brought into range). */
export interface ChangeProblem {
  changeId: string;
  message: string;
  note?: true;
}

/** Segments one scenario may need: the start of the run and up to six change months. */
export const MAX_SEGMENTS = 7;

/** The last day of leave of `weeks` whole weeks from the Monday `date`: the Friday of the last week. */
export const leaveEnd = (date: string, weeks: number): string => addDays(date, 7 * weeks - 3);

/** The date a change's `from` means: the 1st of its month, or the Monday itself. */
export const fromDate = (from: string): string => (from.length === 7 ? `${from}-01` : from);

/**
 * The name each hire shows: the one typed, or "New <role name>", numbered "New PPC specialist 2" when several hires share the default
 * (in the order of the changes). A hire whose role is gone is "New hire" (unless named).
 */
export function hireNames(bundle: Pick<ProcessBundle, "roles">, changes: readonly SandboxChange[]): Map<string, string> {
  const roleName = new Map(bundle.roles.map((r) => [r.id, r.name]));
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of changes) {
    if (c.lever !== "D1") continue;
    const typed = c.params?.name?.trim();
    if (typed) {
      out.set(c.id, typed);
      continue;
    }
    const base = `New ${roleName.get(c.target ?? "") ?? "hire"}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    out.set(c.id, count > 1 ? `${base} ${count}` : base);
  }
  return out;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar 2027" for "2027-03". */
export const monthWord = (from: string): string => `${MONTHS_SHORT[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;

/** An id for a row a change makes beyond its own (a copy's leave): the change's id with its tail counted up. Stable across renders, so a run is cached. */
const derivedId = (changeId: string, n: number): string => `${changeId.slice(0, 24)}${n.toString(16).padStart(12, "0")}`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const month0 = (from: string) => `${from}-01`;
const combine = (current: number, op: SandboxChange["op"], value: number) => (op === "set" ? value : op === "multiply" ? current * value : current + value);

export interface PeopleApplied {
  bundle: ProcessBundle;
  problems: ChangeProblem[];
  /** Ids of the people the scenario added: its hires, and the second row of an FTE change split in two. */
  planPeople: Set<string>;
  /** FTE changes (D4) that were done as person rows: they are not patches. Any other D4 is a patch (whole run) or a spliced patch (a person pinned to a step or assigned clients). */
  handled: Set<string>;
}

/** One stretch of a person's time: a row in force from `from` to `to` (ISO dates, `to` inclusive; null: no end). */
interface Stretch {
  row: PersonRow;
  from: string | null;
  to: string | null;
}

/**
 * The bundle with the scenario's people in it. Hires (D1) are person rows (id = the change's id, `start_date` the 1st of its month,
 * none when whole-run and undelayed, `capacity_hours_week: null`, one `person_roles` row). Leaving (D2) sets the person's `end_date` to the day
 * before the month (whole-run: the day before the start date, which drops them from the model; an earlier end date is kept). Leave
 * (D3) is a `person_leave` row from the Monday to `leaveEnd`, merged with any leave it overlaps or touches (the engine adds up a
 * person's leave windows). An FTE change from a month (D4) ends the person the day before and starts a copy row (id = the change's
 * id, the same roles, skills, per-person times, and the leave after the month) on the 1st with the new FTE, clamped to 0 to 2.
 * For a person pinned to a step or assigned clients that split would break the pinning, so the change stays a patch (spliced).
 * A change whose role or person is gone, or whose person is inactive, is skipped and returned as a problem.
 */
export function applyPeopleChanges(bundle: ProcessBundle, changes: readonly SandboxChange[], startDate: string): PeopleApplied {
  const problems: ChangeProblem[] = [];
  const handled = new Set<string>();
  const planPeople = new Set<string>();
  const workspace_id = bundle.workspace.id;
  const hpw = bundle.workspace.settings.hours_per_week;
  const roleName = new Map(bundle.roles.map((r) => [r.id, r.name]));
  const people = new Map<string, PersonRow>(bundle.people.map((p) => [p.id, { ...p }]));
  const order = bundle.people.map((p) => p.id);
  const personRoles: PersonRoleRow[] = [...bundle.personRoles];
  const personSkills: PersonSkillRow[] = [...bundle.personSkills];
  const personFactors: PersonCapacityFactorRow[] = [...(bundle.personCapacityFactors ?? [])];
  const names = hireNames(bundle, changes);
  const pinned = new Set([...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)].map((s) => s.person_id).filter((id): id is string => !!id));
  // Clients counted per service replace the named roster in the engine (its assignments are ignored), so then nobody is assigned.
  const countedPerService = (bundle.clientGroups ?? []).some((g) => g.client_count > 0);
  const assigned = new Set(countedPerService ? [] : (bundle.clientAssignments ?? []).map((a) => a.person_id));

  // Every person's stretches, starting with the one row they have.
  const stretches = new Map<string, Stretch[]>();
  const chain = (id: string): Stretch[] => stretches.get(id) ?? (stretches.set(id, [{ row: people.get(id)!, from: null, to: people.get(id)!.end_date }]), stretches.get(id)!);
  const leaveRows = new Map<string, PersonLeaveRow[]>();
  const leaveOf = (id: string) => leaveRows.get(id) ?? (leaveRows.set(id, bundle.personLeave.filter((l) => l.person_id === id).map((l) => ({ ...l }))), leaveRows.get(id)!);

  const problemOfPerson = (c: SandboxChange): PersonRow | null => {
    const person = people.get(c.target ?? "");
    if (!person) {
      problems.push({ changeId: c.id, message: "Someone in this scenario is no longer on the team" });
      return null;
    }
    if (!person.active) {
      problems.push({ changeId: c.id, message: `${person.name} is no longer on the team` });
      return null;
    }
    return person;
  };

  // The hiring delay (D9): every hire of the scenario from a month starts that many months later, stretched by the market's "time to hire" in
  // the month the hire was planned for. A whole run hire counts from the start of the run (month 0): with a delay it starts on the 1st of that
  // month many months on, and with none it is there from the start. Settings' own planned hires are dated already.
  const delayChange = [...changes].reverse().find((c) => c.lever === "D9");
  const hireFactor = (() => {
    const market = engineMarket(bundle);
    return (from: string) => {
      if (!market) return 1;
      const idx = Math.floor(hoursToDate(startDate, `${from}-01`, hpw) / ((52 / 12) * hpw));
      return market.months[Math.min(Math.max(0, idx), market.months.length - 1)]?.hire ?? 1;
    };
  })();
  const delayMonths = (factor: number): number => (delayChange && delayChange.value > 0 ? Math.round(delayChange.value * factor) : 0);
  const startOf = (from: string): string => addMonths(`${from}-01`, delayMonths(hireFactor(from)));
  const wholeRunStart = (): string | null => {
    const months = delayMonths(hireFactor(startDate.slice(0, 7)));
    return months > 0 ? addMonths(startDate, months) : null;
  };

  // 1. Hires.
  const hires: PersonRow[] = [];
  for (const c of changes) {
    if (c.lever !== "D1") continue;
    if (!roleName.has(c.target ?? "")) {
      problems.push({ changeId: c.id, message: `The role of “${c.params?.name?.trim() || "a new hire"}” isn't there any more` });
      continue;
    }
    hires.push({ id: c.id, workspace_id, name: names.get(c.id)!, fte: c.value, capacity_hours_week: null, cost_rate: null, active: true, start_date: c.from ? startOf(c.from) : wholeRunStart(), end_date: null });
    personRoles.push({ person_id: c.id, role_id: c.target!, workspace_id });
    planPeople.add(c.id);
  }

  // 2. FTE changes from a month, a person at a time, earliest month first (a later one applies to what the earlier one left).
  const fteChanges = changes.filter((c) => c.lever === "D4" && c.from !== undefined && `${c.from}-01` > startDate).sort((a, b) => (a.from! < b.from! ? -1 : a.from! > b.from! ? 1 : 0));
  for (const c of fteChanges) {
    const person = problemOfPerson(c);
    if (!person) continue;
    // Pinned or assigned: splitting would lose the pin, so the capacity channel does it, unless it takes them to nothing: then they leave.
    if (pinned.has(person.id) || assigned.has(person.id)) {
      const hours = person.capacity_hours_week != null ? person.capacity_hours_week / hpw : person.fte;
      if (clamp(combine(hours, c.op, c.value), 0, 2) <= 0) {
        const last = addDays(month0(c.from!), -1);
        for (const st of chain(person.id)) {
          if (st.to === null || st.to > last) {
            st.to = last;
            st.row.end_date = last;
          }
        }
        handled.add(c.id);
      }
      continue;
    }
    const month = `${c.from}-01`;
    const tail = chain(person.id).at(-1)!;
    const base = tail.row.capacity_hours_week != null ? tail.row.capacity_hours_week / hpw : tail.row.fte;
    const fte = Math.round(clamp(combine(base, c.op, c.value), 0, 2) * 1e6) / 1e6;
    if (tail.from === month) {
      // The same month again: the copy already starting then takes the new value.
      tail.row.fte = fte;
      tail.row.capacity_hours_week = null;
      handled.add(c.id);
      continue;
    }
    const until = tail.to;
    tail.row.end_date = until !== null && until < addDays(month, -1) ? until : addDays(month, -1);
    tail.to = tail.row.end_date;
    const copy: PersonRow = { ...tail.row, id: c.id, name: `${person.name} (from ${monthWord(c.from!)})`, fte, capacity_hours_week: null, start_date: month, end_date: until };
    stretches.get(person.id)!.push({ row: copy, from: month, to: until });
    personRoles.push(...bundle.personRoles.filter((r) => r.person_id === person.id).map((r) => ({ ...r, person_id: c.id })));
    personSkills.push(...bundle.personSkills.filter((s) => s.person_id === person.id).map((s) => ({ ...s, person_id: c.id })));
    personFactors.push(...(bundle.personCapacityFactors ?? []).filter((f) => f.person_id === person.id).map((f) => ({ ...f, person_id: c.id })));
    planPeople.add(c.id);
    handled.add(c.id);
  }

  // 3. People who leave: every stretch ends the day before; a stretch that would start after that is dropped.
  for (const c of changes) {
    if (c.lever !== "D2") continue;
    const person = problemOfPerson(c);
    if (!person) continue;
    const last = addDays(c.from ? `${c.from}-01` : startDate, -1);
    const list = chain(person.id);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i]!;
      if (s.from !== null && s.from > last) {
        list.splice(i, 1);
        planPeople.delete(s.row.id);
        continue;
      }
      if (s.to === null || s.to > last) {
        s.to = last;
        s.row.end_date = last;
      }
    }
  }

  // 4. Leave: a row on the stretch that holds its first day (cut at a stretch's end, the rest on the next); overlapping or touching leave is merged.
  const planLeave: PersonLeaveRow[] = [];
  const leaveSources = new Set<string>();
  for (const c of changes) {
    if (c.lever !== "D3" || !c.from) continue;
    const person = problemOfPerson(c);
    if (!person) continue;
    const row: PersonLeaveRow = { id: c.id, person_id: person.id, workspace_id, start_date: c.from, end_date: leaveEnd(c.from, c.value) };
    planLeave.push(row);
    leaveSources.add(person.id);
  }
  const mergedLeave: PersonLeaveRow[] = [];
  const untouchedLeave = bundle.personLeave.filter((l) => !leaveSources.has(l.person_id));
  for (const personId of leaveSources) {
    const rows = [...leaveOf(personId), ...planLeave.filter((l) => l.person_id === personId)].sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
    const out: PersonLeaveRow[] = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      // Overlapping, or with no working day between them (a Friday's end and the next Monday's start).
      if (last && workingDaysBetween(addDays(last.end_date, 1), row.start_date) <= 0) {
        if (row.end_date > last.end_date) last.end_date = row.end_date;
      } else out.push({ ...row });
    }
    mergedLeave.push(...out);
  }
  // Leave moves onto the stretch it falls in, cut where a stretch ends (a copy has its own leave rows).
  const finalLeave: PersonLeaveRow[] = [];
  const placeLeave = (l: PersonLeaveRow) => {
    const list = stretches.get(l.person_id);
    if (!list || list.length === 1) return void finalLeave.push(l);
    let n = 0;
    for (const s of list) {
      const from = s.from !== null && s.from > l.start_date ? s.from : l.start_date;
      const to = s.to !== null && s.to < l.end_date ? s.to : l.end_date;
      if (from > to) continue;
      finalLeave.push({ ...l, id: n === 0 && from === l.start_date ? l.id : derivedId(l.id + s.row.id, ++n), person_id: s.row.id, start_date: from, end_date: to });
    }
  };
  for (const l of [...untouchedLeave, ...mergedLeave]) placeLeave(l);

  const outPeople: PersonRow[] = [];
  for (const id of order) {
    const list = stretches.get(id);
    if (!list) outPeople.push(people.get(id)!);
    else for (const s of list) outPeople.push(s.row);
  }
  outPeople.push(...hires);
  return {
    bundle: { ...bundle, people: outPeople, personRoles, personSkills, personLeave: finalLeave, ...(bundle.personCapacityFactors ? { personCapacityFactors: personFactors } : {}) },
    problems,
    planPeople,
    handled,
  };
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

/** One run of a scenario: from month `from` on, this bundle's numbers are used. */
export interface ScenarioSegment {
  from: number;
  bundle: ProcessBundle;
  solutionIds: string[];
  /** The patches in force by then, in change order (a parent's first); a solution's lever changes sit at its change's place. */
  patches: ScenarioPatch[];
  /** The change each patch came from, one per patch (a solution's lever changes: the change that put it live). */
  patchChangeIds: string[];
}

export interface SegmentsResult {
  segments: ScenarioSegment[];
  problems: ChangeProblem[];
  /** Ids of changes dated at or after the horizon, left out of the run. */
  later: string[];
  /** Ids of the people the scenario added. */
  planPeople: Set<string>;
  /** Set when the scenario cannot run at all (more change months than a run takes). Nothing runs. */
  error: string | null;
  /** Timed FTE changes that were not done as person rows (someone pinned to a step or assigned clients): the capacity channel does them. */
  d4Unhandled: Set<string>;
}

interface Item {
  change: SandboxChange;
  month: number;
  kind: "patch" | "solution";
  patch?: ScenarioPatch;
  solution?: SolutionRow;
}

/**
 * The runs a scenario needs. `bounds` are the months' edges in working hours ([0, ...monthStarts, H]). Whole-run patches are in every
 * segment. A patch from a month, or a solution going live (E6), takes effect in the month its date falls in (on or before the start:
 * month 0, the whole run; at or after the horizon: left out and listed in `later`). Segment 0 starts at month 0; one more segment
 * per distinct month of such a change. Each segment has the scenario's people applied and every solution live by then (for one
 * process the latest wins, and only the winners' lever changes count: a x0.8 from two solutions would otherwise compound to x0.64).
 * More than six change months is an error: nothing runs. Missing solutions and solutions of processes outside the company model
 * are problems, skipped.
 */
export function scenarioSegments(
  bundle: ProcessBundle,
  changes: readonly EffectiveChange[],
  solutions: readonly SolutionRow[],
  startDate: string,
  bounds: readonly number[],
  hoursPerWeek: number,
): SegmentsResult {
  const list = changes.map((c) => c.change);
  const people = applyPeopleChanges(bundle, list, startDate);
  // A lead source's volume is a row of the bundle (A1 for one source, whole run).
  const edited = applyBundleChanges(people.bundle, list);
  people.bundle = edited.bundle;
  const problems = [...people.problems, ...edited.problems];
  const n = bounds.length - 1;
  const horizon = bounds[n]!;
  const byId = new Map(solutions.map((s) => [s.id, s]));
  const later: string[] = [];
  const monthOf = (from: string) => {
    const hour = hoursToDate(startDate, fromDate(from), hoursPerWeek);
    if (hour >= horizon) return null;
    let month = 0;
    if (hour > 0) while (month < n - 1 && bounds[month + 1]! <= hour) month++;
    return month;
  };

  const items: Item[] = [];
  for (const c of list) {
    const lever = sandboxLever(c.lever);
    if (!lever) {
      problems.push({ changeId: c.id, message: "A change names a lever that doesn't exist" });
      continue;
    }
    let month = 0;
    if (c.from !== undefined) {
      const m = monthOf(c.from);
      if (m === null) {
        later.push(c.id);
        continue;
      }
      month = m;
    }
    // People are rows; every other timed lever but a headcount cut and a solution is a channel (./channels.ts), not a segment.
    if (lever.people && !(lever.id === "D4" && c.from === undefined)) continue;
    if (c.from !== undefined && lever.timed === "channel") continue;
    if (lever.solution) {
      const solution = byId.get(c.target ?? "");
      if (!solution) {
        problems.push({ changeId: c.id, message: "A solution in this scenario was deleted" });
        continue;
      }
      if (withSolution(people.bundle, solution) === null) {
        problems.push({ changeId: c.id, message: `“${solution.name}” changes a process the forecast doesn't run` });
        continue;
      }
      items.push({ change: c, month, kind: "solution", solution });
      continue;
    }
    const patch = patchOf(c);
    if (!patch) continue;
    items.push({ change: c, month, kind: "patch", patch });
  }

  const d4Unhandled = new Set(list.filter((c) => c.lever === "D4" && c.from !== undefined && !people.handled.has(c.id)).map((c) => c.id));
  const starts = [...new Set([0, ...items.map((i) => i.month)])].sort((a, b) => a - b);
  if (starts.length > MAX_SEGMENTS) {
    return { segments: [], problems, later, d4Unhandled, planPeople: people.planPeople, error: `This scenario has changes from more than ${MAX_SEGMENTS - 1} different months, which is more than a run can take. Remove or move some.` };
  }
  // The latest by date wins for one process: apply in date order, then change order.
  const solutionItems = items.filter((i) => i.kind === "solution").sort((a, b) => ((a.change.from ?? "") < (b.change.from ?? "") ? -1 : (a.change.from ?? "") > (b.change.from ?? "") ? 1 : 0));
  const segments = starts.map((from): ScenarioSegment => {
    let b = people.bundle;
    const solutionIds: string[] = [];
    const applied = solutionItems.filter((i) => i.month <= from);
    for (const i of applied) {
      b = withSolution(b, i.solution!)!;
      solutionIds.push(i.solution!.id);
    }
    const winners = new Map<string, Item>();
    for (const i of applied) {
      winners.delete(i.solution!.process_id);
      winners.set(i.solution!.process_id, i);
    }
    const winning = new Set([...winners.values()].map((i) => i.change.id));
    const patches: ScenarioPatch[] = [];
    const patchChangeIds: string[] = [];
    for (const i of items) {
      if (i.month > from) continue;
      if (i.kind === "patch") {
        patches.push(i.patch!);
        patchChangeIds.push(i.change.id);
      } else if (winning.has(i.change.id)) {
        for (const p of i.solution!.lever_changes ?? []) {
          patches.push(p);
          patchChangeIds.push(i.change.id);
        }
      }
    }
    return { from, bundle: b, solutionIds, patches, patchChangeIds };
  });
  return { segments, problems, later, d4Unhandled, planPeople: people.planPeople, error: null };
}

export interface ScenarioModelResult {
  model: EngineModel;
  monthStarts: number[];
  /** Changes whose target is gone (skipped) and values brought into range (applied). */
  problems: ChangeProblem[];
  error: null;
}

/**
 * The company model for a run of `months` months from `startDate` with the patches applied: planned hires join on their start date and
 * people with an end date leave then, and the market schedule applies month by month as always. A patch whose target is gone is skipped
 * and listed against its change (`patchChangeIds[i]` is the change of `patches[i]`); a value out of range is clamped and noted. An
 * error message instead when the model can't be simulated yet.
 */
export function scenarioModel(
  bundle: ProcessBundle,
  months: number,
  startDate: string,
  patches: readonly ScenarioPatch[] = [],
  patchChangeIds: readonly string[] = [],
  retired: RetiredSteps = {},
  /** The scenario's effective changes, for the edits and channels that are not patches (sandbox phase 3). */
  edits?: { changes: readonly SandboxChange[]; d4Unhandled: ReadonlySet<string>; forcePriceDriver?: boolean },
): ScenarioModelResult | { model: null; monthStarts: null; problems: ChangeProblem[]; error: string } {
  try {
    const base = toEngineModel(bundle, { startDate, planned: true, purposes: true });
    const problems: ChangeProblem[] = [];
    let model = base;
    if (patches.length) {
      const check = checkScenario(base, patches, retired);
      const brokenAt = new Set(check.broken.map((b) => b.index));
      for (const b of check.broken) problems.push({ changeId: patchChangeIds[b.index]!, message: `${b.message} It is skipped in this run.` });
      const patched = applyPatches(base, patches);
      model = patched.model;
      for (const issue of patched.issues) if (issue.problem === "clamped" && !brokenAt.has(issue.index)) problems.push({ changeId: patchChangeIds[issue.index]!, message: issue.message, note: true });
    }
    if (edits) {
      const edited = applyModelChanges(model, edits.changes, bundle, edits.forcePriceDriver);
      model = edited.model;
      problems.push(...edited.problems);
    }
    model = { ...model, horizonWeeks: horizonWeeks(months) };
    // The run's months are the calendar's, so "February" in an alert is February.
    const monthStarts = calendarMonthStarts(startDate, model.horizonWeeks, model.hoursPerWeek);
    if (edits) {
      const made = channelsOf(model, edits.changes, { bundle, bounds: [0, ...monthStarts, model.horizonWeeks * model.hoursPerWeek], startDate, hoursPerWeek: model.hoursPerWeek, d4Unhandled: edits.d4Unhandled });
      problems.push(...made.problems);
      if (made.channels) {
        const carried = overheadsCarried(model, made.channels, edits.changes);
        model = { ...model, channels: made.channels, ...(carried !== null ? { overheadMonthly: carried } : {}) };
      }
    }
    return { model, monthStarts, problems, error: null };
  } catch (err) {
    if (err instanceof ModelError) return { model: null, monthStarts: null, problems: [], error: err.message };
    throw err;
  }
}


// ---------------------------------------------------------------------------
// A scenario as the hook runs it
// ---------------------------------------------------------------------------

/** One run of a prepared scenario: its model from month `from` on. */
export interface PreparedSegment {
  from: number;
  model: EngineModel;
}

export interface PreparedScenario {
  segments: PreparedSegment[];
  /** With a price rise (B5): the same scenario without it, run the same way, to pair against. Null otherwise. */
  pair: PreparedSegment[] | null;
  /** Month indexes where a price rise starts (for the trade-off). */
  riseMonths: number[];
  /** The scenario's pinned warm-up: the live model with only its whole-run changes (§1 of the brief), so months before a timed change don't move. */
  start: InitialState | null;
  monthStarts: number[];
  markersModel: EngineModel;
  planPeople: Set<string>;
  problems: ChangeProblem[];
  later: string[];
  error: string | null;
}

const startCache = new Map<string, InitialState>();
/** The warm-up a model sizes for itself, kept by the model (a pilot run costs a few milliseconds). */
export function warmupOf(model: EngineModel): InitialState {
  const key = JSON.stringify(model);
  let hit = startCache.get(key);
  if (!hit) {
    hit = initialState(model);
    startCache.set(key, hit);
    if (startCache.size > 24) startCache.delete(startCache.keys().next().value!);
  }
  return hit;
}

/**
 * Everything a run of the scenario needs: its segments' models (channels in them), the pinned warm-up, and for a price rise the
 * paired run without it. Pure; the hook calls it in a memo. `pair: false` skips the price rise's pair (goal seek and the tornado don't need it).
 */
export function prepareScenario(bundle: ProcessBundle, changes: readonly EffectiveChange[], solutions: readonly SolutionRow[], months: number, startDate: string, o: { pair?: boolean } = {}): PreparedScenario {
  const retired = retiredSteps(bundle);
  const live = scenarioModel(bundle, months, startDate);
  const fail = (error: string, extra: Partial<PreparedScenario> = {}): PreparedScenario => ({ segments: [], pair: null, riseMonths: [], start: null, monthStarts: [], markersModel: null as unknown as EngineModel, planPeople: new Set(), problems: [], later: [], error, ...extra });
  if (live.error !== null) return fail(live.error);
  const hpw = live.model.hoursPerWeek;
  const bounds = monthBounds(live.monthStarts, live.model.horizonWeeks * hpw);
  const names = new Map(solutions.map((x) => [x.id, x.name]));

  const build = (list: readonly EffectiveChange[], forcePriceDriver = false) => {
    const plan = scenarioSegments(bundle, list, solutions, startDate, bounds, hpw);
    if (plan.error !== null) return { error: plan.error, plan, segments: [] as PreparedSegment[], problems: plan.problems };
    const all = list.map((c) => c.change);
    const segments: PreparedSegment[] = [];
    const problems: ChangeProblem[] = [...plan.problems];
    const seen = new Set(problems.map((p) => p.changeId + p.message));
    let error: string | null = null;
    for (const seg of plan.segments) {
      const built = scenarioModel(seg.bundle, months, startDate, seg.patches, seg.patchChangeIds, retired, { changes: all, d4Unhandled: plan.d4Unhandled, forcePriceDriver });
      if (built.error !== null) {
        const solutionNames = seg.solutionIds.map((id) => names.get(id) ?? "A solution");
        error = seg.from === 0 && !solutionNames.length ? built.error : `“${solutionNames[solutionNames.length - 1] ?? "A solution"}” can't be simulated: ${built.error}`;
        break;
      }
      for (const p of built.problems) {
        if (seen.has(p.changeId + p.message)) continue;
        seen.add(p.changeId + p.message);
        problems.push(p);
      }
      segments.push({ from: seg.from, model: built.model });
    }
    return { error, plan, segments, problems };
  };

  const main = build(changes);
  if (main.error !== null) return fail(main.error, { problems: main.problems, later: main.plan.later });

  // The pinned warm-up: the live model with the whole-run changes that are not channels (and not the price rise, which a pair must share).
  const wholeRun = changes.filter((e) => e.change.from === undefined && e.change.lever !== "B5" && !isChannelChange(e.change, new Set()));
  let warm = live.model;
  if (wholeRun.length) {
    const w = build(wholeRun);
    if (w.error === null && w.segments[0]) warm = w.segments[0].model;
  }
  const start = warmupOf(warm);

  const rises = changes.filter((e) => e.change.lever === "B5");
  let pair: PreparedSegment[] | null = null;
  const riseMonths: number[] = [];
  if (rises.length && o.pair !== false) {
    // The price driver is on in this run too, as the scenario's rise turns it on: the pair differs only by the rise (Settings' own planned rise then counts in both).
    const p = build(changes.filter((e) => e.change.lever !== "B5"), true);
    pair = p.error === null ? p.segments : null;
    for (const e of rises) {
      const from = e.change.from;
      if (from === undefined) riseMonths.push(0);
      else {
        const hour = hoursToDate(startDate, fromDate(from), hpw);
        if (hour >= bounds[bounds.length - 1]!) continue;
        let m = 0;
        if (hour > 0) while (m < bounds.length - 2 && bounds[m + 1]! <= hour) m++;
        riseMonths.push(m);
      }
    }
  }
  return { segments: main.segments, pair, riseMonths: [...new Set(riseMonths)].sort((a, b) => a - b), start, monthStarts: live.monthStarts, markersModel: live.model, planPeople: main.plan.planPeople, problems: main.problems, later: main.plan.later, error: null };
}
