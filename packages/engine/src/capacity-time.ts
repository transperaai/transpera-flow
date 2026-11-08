// How the run scales a drawn hands-on time by the capacity inputs (engine 1.16.0; docs/adr/0022-capacity-inputs.md, "Engine 1.16.0").
//
// `simulate` multiplies a step's drawn time, after the draw, by `stepTimeFactor` (capacity-inputs.ts): the step's tier multiplier,
// its split and the changes in force, and the client's own factor. This file holds what the run needs around that:
// - the inputs made safe to run (a malformed split or change counts as the engine can use it: see `checkCapacityInputs`, which
//   names each of these);
// - a cache of the factor per (step, tier, month), because a model's draws are many and its months few;
// - the parts and the savings each draw carries, for `PersonTime`.
//
// A step with no `split` and no `tierMultiplier` is not here at all (`capacityStep` gives null), so a model that sets none of the
// new fields pays one null test per draw and every number is as it was.

import { SPLIT_TOLERANCE } from "./capacity-check";
import { stepPartsDetail, stepTimeFactor, type StepFreed } from "./capacity-inputs";
import type { EngineStep, EngineStepChange, StepChangeEffect } from "./model";

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
/** 0 for anything that isn't a finite, non-negative number: the capacity inputs' convention for a malformed number. */
const usable = (v: number | undefined): number => (finite(v) && v > 0 ? v : 0);
const clamp01 = (v: number | undefined): number => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * The changes as the run can use them. What each repair is, and the problem `checkCapacityInputs` names for it:
 * - `adoption_out_of_range`: adoption is held to 0-1 (not a number: 0);
 * - `bad_number` on `startMonth`: below 1 acts from month 1; not a number, the change never starts;
 * - `bad_number` on `rampMonths`: a bad ramp is no ramp (0);
 * - `bad_number` on `remove`, `residualHours`: held to 0-1, and not a negative time (a bad one: 0);
 * - `bad_number` / `augmentation_slower` on `factor`: below 1 or not a number is 1 (no speed-up);
 * - `change_unknown_step`: nothing to repair, an effect on a step the model hasn't acts on nothing.
 */
export function cleanChanges(changes: readonly EngineStepChange[] | undefined): readonly EngineStepChange[] {
  if (!changes || changes.length === 0) return [];
  return changes.map(cleanChange);
}

function cleanChange(c: EngineStepChange): EngineStepChange {
  const effects = c.effects.map((e): StepChangeEffect => {
    if (e.part === "automatable") {
      const out: StepChangeEffect = { step: e.step, part: "automatable", remove: clamp01(e.remove) };
      if (e.residualHours !== undefined) out.residualHours = usable(e.residualHours);
      return out;
    }
    return { step: e.step, part: "augmentable", factor: finite(e.factor) && e.factor >= 1 ? e.factor : 1 };
  });
  return {
    ...c,
    effects,
    adoption: clamp01(c.adoption),
    startMonth: finite(c.startMonth) ? Math.max(1, c.startMonth) : Number.POSITIVE_INFINITY,
    rampMonths: usable(c.rampMonths),
  };
}

/** A split the run can use: three shares in 0-1 that add to 1 (within `SPLIT_TOLERANCE`). Anything else is no split: all manual. */
export function usableSplit(split: EngineStep["split"]): EngineStep["split"] {
  if (!split) return undefined;
  const { automatable: a, augmentable: g, manual: m } = split;
  if (![a, g, m].every((v) => finite(v) && v >= 0 && v <= 1)) return undefined;
  return Math.abs(a + g + m - 1) > SPLIT_TOLERANCE ? undefined : split;
}

/** A tier multiplier map the run can use: a number that isn't finite is left out (1); a negative one counts as 0. */
function usableMultipliers(m: EngineStep["tierMultiplier"]): Record<string, number> | undefined {
  if (!m) return undefined;
  const out: Record<string, number> = {};
  let any = false;
  for (const [k, v] of Object.entries(m)) {
    if (!finite(v)) continue;
    out[k] = Math.max(0, v);
    any = true;
  }
  return any ? out : undefined;
}

/** What one draw of a step carries for a (tier, month, work scale): the number to scale by, and the parts and savings per unit of drawn time. */
export interface CapacityEntry {
  /** `stepTimeFactor` without the client's own factor (that multiplies on top). Exactly 1 when no change acted and there is no tier multiplier. */
  f: number;
  /** The step's mean parts after the changes and before them, in hours, at the work the entry was made for. */
  actual: { automatable: number; augmentable: number; manual: number };
  before: { automatable: number; augmentable: number; manual: number };
  /** The mean work the entry was made for: the step's `work` × the scale (an ad-hoc client's own hours replace the time before the split). */
  work: number;
  /** What each change that acted saved, in hours of the mean time. */
  freed: StepFreed[];
}

/** A step as the run reads it: its cleaned fields and its cache. */
export interface CapacityStep {
  /** The step with a usable split and multipliers. */
  view: Pick<EngineStep, "id" | "work" | "split" | "tierMultiplier">;
  cache: Map<number, CapacityEntry>;
  /** Entries for a scale other than 1, by "key|scale". */
  scaled: Map<string, CapacityEntry>;
}

/** The capacity view of a step, or null when it has no `split` and no `tierMultiplier` (the run does nothing new for it). */
export function capacityStep(step: EngineStep): CapacityStep | null {
  if (!step.split && !step.tierMultiplier) return null;
  return { view: { id: step.id, work: step.work, split: usableSplit(step.split), tierMultiplier: usableMultipliers(step.tierMultiplier) }, cache: new Map(), scaled: new Map() };
}

const NO_CHANGES: readonly EngineStepChange[] = [];

/**
 * The entry for a step, a tier slot (0 = no tier; the run numbers tiers from 1), a month and a work scale. Cached on the
 * step; a scale other than 1 (a client's own ad-hoc hours) is rare and kept apart.
 */
export function capacityEntry(
  cs: CapacityStep,
  changes: readonly EngineStepChange[],
  tierKey: string | undefined,
  tierSlot: number,
  month: number,
  scale: number,
): CapacityEntry {
  const key = tierSlot * 1_000_000 + month;
  const skey = scale === 1 ? "" : `${key}|${scale}`;
  const hit = scale === 1 ? cs.cache.get(key) : cs.scaled.get(skey);
  if (hit) return hit;
  const work = cs.view.work * scale;
  const view = scale === 1 ? cs.view : { ...cs.view, work };
  const d = stepPartsDetail(view, tierKey, changes.length ? changes : NO_CHANGES, month);
  // No change acted: the time is the base time exactly (the split's shares can add to 1 only up to rounding).
  const f = d.acted ? stepTimeFactor(view, tierKey, changes, month) : work > 0 ? d.base / work : 1;
  const actual = d.acted ? { automatable: d.automatable, augmentable: d.augmentable, manual: d.manual } : d.before;
  const entry: CapacityEntry = { f, actual, before: d.before, work, freed: d.freed };
  if (scale === 1) cs.cache.set(key, entry);
  else cs.scaled.set(skey, entry);
  return entry;
}
