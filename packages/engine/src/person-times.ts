// Per-person times from a step log that names people (docs/PRD.md §6.3.7; issue #227).
//
// For each person and each task step they have logged hands-on hours at, this compares the mean of their visits with
// the mean of every visit at that step in the same log (the value `calibrate` proposes as the step's work time), and
// proposes the ratio as a per-person time: a multiple of the step's normal time, limited to 0.5 to 2 (what
// person_capacity_factors allows). Fewer than `minSample` visits by that person on that step is flagged, not proposed.
//
// Nothing here ranks or compares people: proposals come out in the order of the people and steps given, never by
// value, and a proposal's note never names a person. Nothing is written; the caller shows the proposals to owners and
// editors, who tick what to apply. Pure and deterministic: no I/O, no clock, no randomness.

import { CALIBRATION_MIN_SAMPLE, meanAndCv, normStepName, stepIdsByName, type CalibrationStep, type StepLogRow } from "./calibration";

export const PERSON_TIME_MIN = 0.5;
export const PERSON_TIME_MAX = 2;

export interface PersonTimesPerson {
  id: string;
  /** Step ids this person can do (their skills if any, otherwise their roles' steps): the C6 rule, `stepsPersonCanDo`. */
  canDo: readonly string[];
  /** Their stored times now: the "Every step" one and one per step, with where each came from. */
  every: { factor: number; source: "entered" | "measured" } | null;
  steps: Readonly<Record<string, { factor: number; source: "entered" | "measured" }>>;
}

export interface PersonTimesInput {
  steps: readonly CalibrationStep[];
  /** `person` holds a person id, or null (no one matched, or a visit by several people). */
  rows: readonly StepLogRow[];
  /** In the order the page lists them (the roster); never re-sorted. */
  people: readonly PersonTimesPerson[];
  /** Default CALIBRATION_MIN_SAMPLE (10, PRD §6.3.7). */
  minSample?: number;
}

export interface PersonTimeProposal {
  /** `factor:<personId>:<stepId>` */
  key: string;
  kind: "capacity_factor";
  /** `id` is the person. */
  target: { table: "person_capacity_factors"; id: string; step_id: string };
  personId: string;
  stepId: string;
  /** The step's name. */
  subject: string;
  /** Their visits with hands-on hours at this step. */
  n: number;
  /** All visits with hands-on hours at this step. */
  stepN: number;
  enough: boolean;
  /** Their stored time on this step, or null. */
  current: number | null;
  currentSource: "entered" | "measured" | null;
  /** Their "Every step" time, or null. */
  every: number | null;
  /** Their mean ÷ the step's mean, 3 places, before limiting to 0.5-2; null when blocked. */
  measured: number | null;
  /** Limited to 0.5-2, 2 places; null when blocked. */
  proposed: number | null;
  /** `measured` was outside 0.5-2. */
  limited: boolean;
  /** |measured − 1| ≤ 2 standard errors: inside the visit-to-visit spread. */
  within: boolean;
  /** proposed !== round(current ?? every ?? 1, 2). */
  changed: boolean;
  blocked: string | null;
  note: string;
  set: { factor: number } | null;
  before: { factor: number | null } | null;
}

const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

const words = (x: number) => String(round(x, 2));

export function proposePersonTimes(input: PersonTimesInput): { proposals: PersonTimeProposal[]; minSample: number } {
  const minSample = Math.max(1, Math.floor(input.minSample ?? CALIBRATION_MIN_SAMPLE));
  const byName = stepIdsByName(input.steps);

  // Hands-on hours per matched step: every visit (stepHours) and each person's (personHours).
  const stepHours = new Map<string, number[]>();
  const personHours = new Map<string, Map<string, number[]>>();
  for (const row of input.rows) {
    const id = byName.get(normStepName(row.step));
    if (!id || row.hours === null || !(row.hours >= 0)) continue;
    const all = stepHours.get(id) ?? [];
    all.push(row.hours);
    stepHours.set(id, all);
    if (row.person) {
      const byStep = personHours.get(row.person) ?? new Map<string, number[]>();
      const list = byStep.get(id) ?? [];
      list.push(row.hours);
      byStep.set(id, list);
      personHours.set(row.person, byStep);
    }
  }

  const proposals: PersonTimeProposal[] = [];
  for (const p of input.people) {
    const mine = personHours.get(p.id);
    if (!mine) continue;
    const canDo = new Set(p.canDo);
    for (const s of input.steps) {
      if (s.kind !== "task" || !s.worked || s.holder) continue;
      const hours = mine.get(s.id);
      if (!hours || !hours.length) continue;
      const all = stepHours.get(s.id) ?? [];
      const n = hours.length;
      const stepN = all.length;
      const M = all.reduce((t, x) => t + x, 0) / stepN;
      const stored = p.steps[s.id] ?? null;
      const current = stored ? stored.factor : null;
      const every = p.every ? p.every.factor : null;
      const base = {
        key: `factor:${p.id}:${s.id}`,
        kind: "capacity_factor" as const,
        target: { table: "person_capacity_factors" as const, id: p.id, step_id: s.id },
        personId: p.id,
        stepId: s.id,
        subject: s.name,
        n,
        stepN,
        enough: n >= minSample,
        current,
        currentSource: stored ? stored.source : null,
        every,
      };
      let blocked: string | null = null;
      if (!canDo.has(s.id)) blocked = "Not one of the steps this person does (Settings → People), so it wouldn't be used.";
      else if (n < minSample) blocked = `Too few to measure: ${n} of the ${minSample} needed.`;
      else if (stepN < minSample) blocked = `The step has ${stepN} logged visits with hands-on hours; ${minSample} are needed to know its normal time.`;
      else if (n === stepN) blocked = "Every logged visit at this step is theirs, so the step's normal time is already their time.";
      else if (M <= 0) blocked = "The step's logged hands-on hours are all zero.";
      if (blocked) {
        proposals.push({ ...base, measured: null, proposed: null, limited: false, within: false, changed: false, blocked, note: blocked, set: null, before: null });
        continue;
      }
      const { mean: m, cv } = meanAndCv(hours);
      const r = m / M;
      const measured = round(r, 3);
      const proposed = round(Math.min(PERSON_TIME_MAX, Math.max(PERSON_TIME_MIN, r)), 2);
      const limited = r < PERSON_TIME_MIN || r > PERSON_TIME_MAX;
      const se = (r * cv) / Math.sqrt(n);
      const within = Math.abs(r - 1) <= 2 * se;
      let note = `${n} of the step's ${stepN} logged visits. Their hands-on time is ${words(measured)} × the step's normal time.`;
      if (limited) note += ` Per-person times go from 0.5 to 2, so ${proposed} is proposed.`;
      if (within) note += " That is within the usual spread from visit to visit.";
      proposals.push({
        ...base,
        measured,
        proposed,
        limited,
        within,
        changed: proposed !== round(current ?? every ?? 1, 2),
        blocked: null,
        note,
        set: { factor: proposed },
        before: { factor: current },
      });
    }
  }
  return { proposals, minSample };
}
