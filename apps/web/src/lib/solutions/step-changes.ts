// A solution's step changes as the step panel lists them (D53): one row per change, keyed the way the server finds it.

import type { Percents } from "@/lib/editor/base-values";
import { changeStepIds, stepChangeKey, type StoredStepChange } from "@transpera-flow/db";

export interface ChangeOnStep {
  /** The key the server finds the change by (its id, else the solution's id and its place). */
  id: string;
  name: string;
  kind: "automation" | "augmentation";
  /** The steps it acts on. */
  steps: string[];
  /** The change itself, for the form that edits it. */
  value: StoredStepChange;
}

export const changesOnStepsOf = (solutionId: string, list: readonly StoredStepChange[]): ChangeOnStep[] =>
  list.map((c, i) => ({ id: stepChangeKey(solutionId, c, i), name: c.name, kind: c.kind, steps: changeStepIds(c), value: c }));

/**
 * A plain warning when a part of a step that a change acts on is 0% of the step's work split (a step with no split counts as all manual), so the change
 * would do nothing yet. It never blocks saving. `percents` is the step's split as [automatable, augmentable, manual].
 */
export function zeroPartWarning(part: "automatable" | "augmentable", percents: Percents): string | null {
  const share = part === "automatable" ? percents[0] : percents[1];
  return share > 0 ? null : `This step's ${part} part is 0%, so this changes nothing yet. Set the work split above first.`;
}

/** The warning for a change on one step: the first part it acts on there that has no share, or null. */
export function changeWarning(change: Pick<StoredStepChange, "effects">, stepId: string, percents: Percents): string | null {
  for (const e of change.effects) {
    if (e.step !== stepId) continue;
    const w = zeroPartWarning(e.part, percents);
    if (w) return w;
  }
  return null;
}
