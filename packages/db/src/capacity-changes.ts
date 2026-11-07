// Step changes: automations and augmentations that are part of a solution's version of a process (D53; migration 20270136000000).
//
// A change acts on parts of steps: the engine's `StepChangeEffect[]` (with step ids), its adoption, its ramp, the tiers it applies to and what it costs
// a month. It lives in `solutions.step_changes`. When the Sandbox runs a solution (picked as a process's version on the company map from a month),
// `toEngineStepChanges(solution, startMonth)` gives the engine's `EngineStepChange`s for it, starting in that month: the same input a change switched
// on from that month used to be. Live runs carry none. (The old workspace table `capacity_changes` is read-only for one release and nothing reads it.)
//
// Pure functions. The writes are the editor's (Part B of the brief) and the migration's.

import type { EngineStepChange, StepChangeEffect } from "@transpera-flow/engine";

/** What a person types or picks to make or edit a step change (the id is made when it is stored). */
export interface StepChangeInput {
  name: string;
  kind: "automation" | "augmentation";
  effects: StepChangeEffect[];
  adoption: number;
  ramp_months: number;
  /** Tier keys, or null for every tier. */
  tiers: string[] | null;
  cost_monthly: number | null;
}

/** One element of `solutions.step_changes`. `id` is the engine's id for the change (the move keeps the old change's id); older or hand-made rows may have none. */
export interface StoredStepChange extends StepChangeInput {
  id?: string;
}

export const MAX_CHANGE_EFFECTS = 40;
export const MAX_STEP_CHANGES = 40;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const STEP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored list as the app uses it: anything that isn't a list of changes counts as none (the database checks the shape on write). */
export function parseStepChanges(stored: unknown): StoredStepChange[] {
  if (!Array.isArray(stored)) return [];
  const out: StoredStepChange[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { effects?: unknown }).effects)) continue;
    const c = raw as Record<string, unknown>;
    out.push({
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      name: String(c.name ?? ""),
      kind: c.kind === "augmentation" ? "augmentation" : "automation",
      effects: (c.effects as StepChangeEffect[]).map((e) => ({ ...e })),
      adoption: Number(c.adoption),
      ramp_months: Number(c.ramp_months),
      tiers: Array.isArray(c.tiers) && c.tiers.length ? (c.tiers as string[]).map(String) : null,
      cost_monthly: c.cost_monthly === null || c.cost_monthly === undefined ? null : Number(c.cost_monthly),
    });
  }
  return out;
}

/**
 * The engine's changes for a solution's version going live in the 1-based `startMonth`. The engine id is the stored one, else the solution's id and the
 * change's place; `issueId` (the issue the solution is for) is reporting only.
 */
export function toEngineStepChanges(solution: { id: string; step_changes: readonly StoredStepChange[] }, startMonth: number, issueId?: string | null): EngineStepChange[] {
  return solution.step_changes.map((c, i) => ({
    id: c.id ?? `${solution.id}:${i}`,
    name: c.name,
    kind: c.kind,
    effects: c.effects.map((e) => ({ ...e })),
    adoption: c.adoption,
    startMonth,
    rampMonths: c.ramp_months,
    ...(c.tiers && c.tiers.length ? { tiers: [...c.tiers] } : {}),
    ...(issueId ? { issueId } : {}),
  }));
}

/** The ids of the steps a change acts on, in order of first use. */
export function changeStepIds(change: Pick<StepChangeInput, "effects">): string[] {
  const out: string[] = [];
  for (const e of change.effects) if (!out.includes(e.step)) out.push(e.step);
  return out;
}

const PART_WORDS = { automatable: "the automatable part", augmentable: "the augmentable part" } as const;

/** One effect in plain words: "Removes 85% of the automatable part, 2 min of checking left." */
export function describeEffect(e: StepChangeEffect): string {
  if (e.part === "automatable") {
    const left = e.residualHours && e.residualHours > 0 ? `, ${Math.round(e.residualHours * 60)} min of checking left` : "";
    return `Removes ${Math.round(e.remove * 100)}% of ${PART_WORDS.automatable}${left}`;
  }
  return `Speeds up ${PART_WORDS.augmentable} ${Math.round(e.factor * 100) / 100} times`;
}

/** What is wrong with a change as typed, in plain words, or null. `stepIds` is the steps that exist (when given, an effect must point at one). */
export function checkStepChange(input: StepChangeInput, stepIds?: ReadonlySet<string>): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) return "Give the change a name of up to 200 characters.";
  if (input.kind !== "automation" && input.kind !== "augmentation") return "Choose automation or augmentation.";
  if (!isFiniteNumber(input.adoption) || input.adoption < 0 || input.adoption > 1) return "Adoption is a share from 0% to 100%.";
  if (!Number.isInteger(input.ramp_months) || input.ramp_months < 0 || input.ramp_months > 24) return "Months to full effect is a whole number from 0 to 24.";
  if (input.cost_monthly !== null && (!isFiniteNumber(input.cost_monthly) || input.cost_monthly < 0 || input.cost_monthly > 10_000_000)) return "What it costs a month must be 0 or more.";
  if (input.tiers !== null && (input.tiers.length < 1 || input.tiers.length > 20)) return "Pick at least one tier, or leave it for every tier.";
  if (!input.effects.length) return "Add at least one effect: a step and the part of it the change acts on.";
  if (input.effects.length > MAX_CHANGE_EFFECTS) return `A change has at most ${MAX_CHANGE_EFFECTS} effects.`;
  for (const e of input.effects) {
    // With the steps that exist given, that set decides; without it, the id must at least be a step id's shape (the table checks the same).
    if (typeof e.step !== "string" || (stepIds ? !stepIds.has(e.step) : !STEP_ID.test(e.step))) return "An effect points at a step that isn't there.";
    if (e.part === "automatable") {
      if (!isFiniteNumber(e.remove) || e.remove < 0 || e.remove > 1) return "The share an automation removes is from 0% to 100%.";
      if (e.residualHours !== undefined && (!isFiniteNumber(e.residualHours) || e.residualHours < 0 || e.residualHours > 1000)) return "Checking time is 0 or more.";
    } else if (e.part === "augmentable") {
      if (!isFiniteNumber(e.factor) || e.factor < 1 || e.factor > 100) return "An augmentation speeds a part up by at least 1 times.";
    } else return "An effect acts on the automatable or the augmentable part.";
  }
  return null;
}

/** The input as it will be stored: trimmed name, effects with only their own keys. */
export function cleanStepChange(input: StepChangeInput): StepChangeInput {
  return {
    ...input,
    name: input.name.trim(),
    effects: input.effects.map((e) =>
      e.part === "automatable"
        ? { step: e.step, part: "automatable" as const, remove: e.remove, ...(e.residualHours !== undefined && e.residualHours > 0 ? { residualHours: e.residualHours } : {}) }
        : { step: e.step, part: "augmentable" as const, factor: e.factor },
    ),
    tiers: input.tiers && input.tiers.length ? [...new Set(input.tiers)] : null,
  };
}

/** The key the app uses for a stored change: its id, else the solution's id and its place (the same id the engine gets). */
export const stepChangeKey = (solutionId: string, change: Pick<StoredStepChange, "id">, index: number): string => change.id ?? `${solutionId}:${index}`;

/** One edit to a solution's list of step changes: add or replace one (`key` null adds), or take one out. */
export type StepChangeEdit = { op: "save"; key: string | null; change: StepChangeInput } | { op: "remove"; key: string };

export type StepChangeEditResult = { ok: true; list: StoredStepChange[] } | { ok: false; message: string };

/**
 * The list after one edit, or why it can't be made. `stepIds` is the steps of the solution's stored version (an effect must point at one).
 * An edited change keeps its id (or has none, as before), so the engine's id for it does not move; a new one gets `newId()`.
 */
export function applyStepChangeEdit(solutionId: string, current: readonly StoredStepChange[], edit: StepChangeEdit, stepIds: ReadonlySet<string>, newId: () => string): StepChangeEditResult {
  const at = current.findIndex((c, i) => stepChangeKey(solutionId, c, i) === edit.key);
  if (edit.key !== null && at < 0) return { ok: false, message: "That change isn't in the solution any more. Reload the page." };
  if (edit.op === "remove") return { ok: true, list: current.filter((_, i) => i !== at) };
  const problem = checkStepChange(edit.change, stepIds);
  if (problem) return { ok: false, message: problem };
  if (at < 0 && current.length >= MAX_STEP_CHANGES) return { ok: false, message: `A solution can have at most ${MAX_STEP_CHANGES} changes. Remove one first.` };
  const clean = cleanStepChange(edit.change);
  const old = current[at];
  const stored: StoredStepChange = { ...(at < 0 ? { id: newId() } : old?.id ? { id: old.id } : {}), ...clean };
  return { ok: true, list: at < 0 ? [...current, stored] : current.map((c, i) => (i === at ? stored : c)) };
}

/**
 * The changes a copy of a solution keeps (saving from the editor on a solution's version makes a copy): each change with only the effects on steps
 * that are still in the copy, a change with none left dropped, every kept change with its own id (so the engine's id for it is the same).
 */
export function carryStepChanges(source: readonly StoredStepChange[], stepIds: ReadonlySet<string>): StoredStepChange[] {
  const out: StoredStepChange[] = [];
  for (const c of source) {
    const effects = c.effects.filter((e) => stepIds.has(e.step)).map((e) => ({ ...e }));
    if (effects.length) out.push({ ...c, effects, tiers: c.tiers ? [...c.tiers] : null });
  }
  return out;
}
