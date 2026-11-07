// A solution's step changes as the step panel lists them (D53): one row per change, keyed the way the server finds it.

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
