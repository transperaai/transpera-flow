// Retired steps (issue #16, docs/PRD.md §4.1 "Stable step IDs"). Splitting or
// replacing a step in the editor keeps the old row in the revision with
// `replaced_by` set to the steps that took over, so a saved scenario aimed at
// the old id can say what replaced it. Such rows are never drawn or
// simulated: whatever loads a revision's steps sorts them out with these.

import type { RetiredSteps } from "@transpera-flow/engine";
import type { ProcessBundle } from "./types";

/** The step was split or replaced: it has `replaced_by` entries. */
export function isRetiredStep(step: { replaced_by?: unknown }): boolean {
  return Array.isArray(step.replaced_by) && step.replaced_by.length > 0;
}

/** A revision's step rows sorted into the ones in use and the retired ones, each in their original order. */
export function partitionSteps<T extends { replaced_by?: unknown }>(rows: readonly T[]): { steps: T[]; retired: T[] } {
  const steps: T[] = [];
  const retired: T[] = [];
  for (const row of rows) (isRetiredStep(row) ? retired : steps).push(row);
  return { steps, retired };
}

type Steps = Pick<ProcessBundle, "steps" | "retired">;

/**
 * Steps `bundle` no longer has, by id: its retired rows (split or replaced,
 * with `replaced_by`), then the same from `others` (e.g. the live revision
 * while a draft is shown), then steps of `others` that `bundle` lacks, which
 * were deleted (no replacements). The first record of an id wins.
 */
export function retiredSteps(bundle: Steps, ...others: (Steps | null | undefined)[]): RetiredSteps {
  const out: RetiredSteps = {};
  const present = new Set(bundle.steps.map((s) => s.id));
  const add = (id: string, name: string, replacedBy: string[]) => {
    if (!present.has(id) && !out[id]) out[id] = { name, replacedBy };
  };
  const all = [bundle, ...others.filter((o): o is Steps => Boolean(o))];
  for (const b of all) for (const s of b.retired ?? []) add(s.id, s.name, [...(s.replaced_by ?? [])]);
  for (const b of others) for (const s of b?.steps ?? []) add(s.id, s.name, []);
  return out;
}
