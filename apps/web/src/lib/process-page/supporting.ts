// What the process page's Supporting data shows besides the hours (lib/process-page/hours.ts): the time split per step and key-person
// risk, read off one simulation result. Pure.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import type { ProcessHours } from "./hours";

export interface TimeSplitRow {
  id: string;
  label: string;
  /** Hours per visit: hands-on, waiting for a person (queue and part-time availability), and fixed waits (outside the team). */
  handsOn: number;
  waitingForPerson: number;
  fixedWait: number;
  total: number;
  /** Hands-on as a share of the whole visit. */
  handsOnShare: number;
  /** How many visits in 100 were a repeat pass (the step's `reworks / departures`), rounded; null when the run has no departures. */
  redonePer100: number | null;
}

/** Hands-on versus waiting per step, the steps whose visit takes longest in total first. Needs a run that carries step facts. */
export function timeSplitRows(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>, max = Infinity): TimeSplitRow[] {
  if (!result?.stepFacts) return [];
  return model.steps
    .flatMap((s) => {
      const f = result.stepFacts![s.id];
      const r = result.steps[s.id];
      if (!f || !r || r.arrivals <= 0 || !stepIds.has(s.id)) return [];
      const waitingForPerson = f.queueWaitHours + f.stretchHours;
      const total = f.handsOnHours + waitingForPerson + f.fixedWaitHours;
      const redonePer100 = r.departures > 0 ? Math.round((r.reworks / r.departures) * 100) : null;
      return total > 0 ? [{ id: s.id, label: s.name, handsOn: f.handsOnHours, waitingForPerson, fixedWait: f.fixedWaitHours, total, handsOnShare: f.handsOnShare, redonePer100 }] : [];
    })
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
    .slice(0, max);
}

/** How many steps the time split names under "Most waiting". */
export const LONGEST_WAITS = 4;

export interface TimeSplitSummary {
  /** Hours per visit summed over the steps: one visit to each step of the process. */
  handsOn: number;
  waitingForPerson: number;
  fixedWait: number;
  total: number;
  /** How many steps the sums are over. */
  steps: number;
  /** The steps that wait longest per visit (for a person plus on others), longest first; steps with no wait are left out. */
  longestWaits: TimeSplitRow[];
}

/** The totals over every step, then the steps that wait longest. Null with no rows. */
export function timeSplitSummary(rows: readonly TimeSplitRow[], top = LONGEST_WAITS): TimeSplitSummary | null {
  if (rows.length === 0) return null;
  const sum = (f: (r: TimeSplitRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const waiting = (r: TimeSplitRow) => r.waitingForPerson + r.fixedWait;
  return {
    handsOn: sum((r) => r.handsOn),
    waitingForPerson: sum((r) => r.waitingForPerson),
    fixedWait: sum((r) => r.fixedWait),
    total: sum((r) => r.total),
    steps: rows.length,
    longestWaits: rows
      .filter((r) => waiting(r) > 0)
      .sort((a, b) => waiting(b) - waiting(a) || a.id.localeCompare(b.id))
      .slice(0, top),
  };
}

export interface KeyPersonRow {
  id: string;
  step: string;
  /** Who is the only one that can do it; null when nobody can. */
  person: string | null;
  /** Their id in the run (a placeholder's is "<role>#<n>"); null when nobody can. */
  personId: string | null;
  /** The role they carry the step under (the step's role, else their first), for the card's subtitle; null when not known. */
  role: string | null;
  /** The name is one the simulation made up for a role with no named people ("Reviewer 1"), not a person in People. */
  placeholder: boolean;
}

/** Steps only one person can do (and any nobody can do), in process order. */
export function keyPersonRows(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>): KeyPersonRow[] {
  if (!result?.stepFacts) return [];
  return model.steps.flatMap((s): KeyPersonRow[] => {
    const f = result.stepFacts![s.id];
    if (!f || !stepIds.has(s.id)) return [];
    if (f.keyPerson) {
      const { personId, personName } = f.keyPerson;
      // Without named people the engine makes one up per head-count, keyed "<role>#<n>"; a person in People never has a # in the id.
      const placeholder = personId.includes("#");
      const roleId = s.role ?? (placeholder ? personId.split("#")[0] : model.people?.[personId]?.roles[0]) ?? null;
      return [{ id: s.id, step: s.name, person: personName, personId, role: roleId ? (model.roles[roleId]?.name ?? null) : null, placeholder }];
    }
    return f.nobodyCanDo ? [{ id: s.id, step: s.name, person: null, personId: null, role: null, placeholder: false }] : [];
  });
}

export interface KeyPersonGroup {
  /** The person's id in the run. */
  key: string;
  person: string;
  role: string | null;
  placeholder: boolean;
  /** The steps only they can do, heaviest first, with each step's hours a month from the same run. */
  steps: { id: string; step: string; hours: number }[];
  /** Hours a month of this process that stop while they are away: the sum of their steps'. */
  hours: number;
}

export interface KeyPersonGroups {
  /** One per sole person, the most hours at stake first. */
  people: KeyPersonGroup[];
  /** Steps nobody can do, in process order. */
  nobody: { id: string; step: string }[];
}

/** The key-person rows grouped by the person they hang on, with the hours a month at stake (from `processHours` of the same run). */
export function keyPersonGroups(rows: readonly KeyPersonRow[], hours: Pick<ProcessHours, "steps"> | null): KeyPersonGroups {
  const stepHours = new Map((hours?.steps ?? []).map((s) => [s.id, s.hours]));
  const byPerson = new Map<string, KeyPersonGroup>();
  const nobody: KeyPersonGroups["nobody"] = [];
  for (const r of rows) {
    if (r.person === null || r.personId === null) {
      nobody.push({ id: r.id, step: r.step });
      continue;
    }
    const g = byPerson.get(r.personId) ?? { key: r.personId, person: r.person, role: r.role, placeholder: r.placeholder, steps: [], hours: 0 };
    const h = stepHours.get(r.id) ?? 0;
    g.steps.push({ id: r.id, step: r.step, hours: h });
    g.hours += h;
    byPerson.set(r.personId, g);
  }
  const people = [...byPerson.values()].map((g) => ({ ...g, steps: [...g.steps].sort((a, b) => b.hours - a.hours || a.step.localeCompare(b.step)) }));
  people.sort((a, b) => b.hours - a.hours || b.steps.length - a.steps.length || a.person.localeCompare(b.person));
  return { people, nobody };
}
