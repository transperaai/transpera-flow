// What each change anchored to an issue frees (capacity build P8, docs/plans/capacity/p8-issues-brief.md section 2).
//
// One run per change: today's model with that change alone swapped in from the first month, run with `personTime` on. Two figures come out of it:
//   - hours freed a month: the engine's `personTime.freed.byChange[id]` of that run (what the change saved against the step's own base time);
//   - more clients the department can hold: `departmentCeiling` of the run with the change, less the ceiling of today's run without it. A change
//     can help several departments (a shared team); the department whose ceiling moved most is the one shown.
// Pure functions: the web app's worker runs the models (apps/web/src/lib/sim/use-issue-change-runs.ts).

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import type { CapacityChangeRow } from "./capacity-changes";
import { toEngineStepChange } from "./capacity-changes";
import type { CapacitySetup } from "./capacity-setup";
import { departmentCeiling } from "./capacity-figures";

/** The changes that name an issue, in the order they were made. */
export const changesForIssue = <T extends Pick<CapacityChangeRow, "issue_id">>(changes: readonly T[], issueId: string): T[] => changes.filter((c) => c.issue_id === issueId);

/** How many changes name each issue (the Issues list's "N changes →"). */
export function changeCounts(changes: readonly Pick<CapacityChangeRow, "issue_id">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) if (c.issue_id) out[c.issue_id] = (out[c.issue_id] ?? 0) + 1;
  return out;
}

/** Today's model with this change alone swapped in from the first month. */
export function changeRunModel(todayModel: EngineModel, change: CapacityChangeRow): EngineModel {
  return { ...todayModel, changes: [...(todayModel.changes ?? []), toEngineStepChange(change, 1)] };
}

export interface IssueChangeFigure {
  changeId: string;
  /** Hours a month the change frees, against today. */
  freed: number;
  /** More clients the department can hold with the change than without; negative if it holds fewer. */
  moreClients: number;
  /** The department whose ceiling moved most, or null when no department has a ceiling. */
  department: { id: string; name: string } | null;
}

/** The two figures from today's run (`base`) and the run with the change alone (`changed`). */
export function issueChangeFigure(
  setup: CapacitySetup,
  change: Pick<CapacityChangeRow, "id">,
  base: { model: EngineModel; result: SimulationResult },
  changed: { model: EngineModel; result: SimulationResult },
): IssueChangeFigure {
  const freed = changed.result.personTime?.freed?.byChange[change.id] ?? 0;
  const departments = setup.departments.filter((d) => setup.services.some((s) => s.active && s.department_id === d.id && s.tier_id));
  let best: { id: string; name: string; delta: number } | null = null;
  for (const d of departments) {
    const delta = departmentCeiling(setup, changed.model, changed.result, d.id).max - departmentCeiling(setup, base.model, base.result, d.id).max;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { id: d.id, name: d.name, delta };
  }
  return { changeId: change.id, freed, moreClients: best?.delta ?? 0, department: best ? { id: best.id, name: best.name } : null };
}
