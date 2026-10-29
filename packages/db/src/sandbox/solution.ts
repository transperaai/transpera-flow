// A solution's map as a process bundle, for the Sandbox's E6 changes (moved from the web app's lib/solutions/bundle.ts). Pure.

import type { EdgeRow, ProcessBundle, SolutionRow, StepRow } from "../types";

/**
 * The map a stored solution describes, as a process bundle: `base` (the process as it is now, for its roles, people and
 * workspace) with the solution's steps and connections in place of the revision's. Nothing is written back to `base`.
 */
export function bundleFromSolution(base: ProcessBundle, solution: Pick<SolutionRow, "steps">): ProcessBundle {
  const at = { revision_id: base.revision.id, workspace_id: base.workspace.id, process_id: base.process.id };
  const steps = solution.steps.steps.map((s) => ({ ...structuredClone(s), ...at }) as StepRow);
  const edges = solution.steps.edges.map((e) => ({ ...structuredClone(e), ...at }) as EdgeRow);
  return { ...base, steps, edges };
}
