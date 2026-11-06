// What the Solution page's maps and "What it changes" need (issue #115, A50; Q12), as a pure function: the solution's map set against the
// version it was copied from, and the groups to open. (The measures, the revenue chart and the stress test were taken off the page in Q12.)

import { ancestorsOf, type ProcessBundle, type SolutionRow } from "@transpera-flow/db";
import { diffBundles, type DraftDiff } from "@/lib/drafts/diff";
import { bundleFromSolution } from "@transpera-flow/db/sandbox";

/**
 * The two maps: `base` (the version of the process the solution was copied from) and the solution's copy of it, with the changes
 * between them and the groups to open so the changes are in view.
 */
export interface Comparison {
  base: ProcessBundle;
  solved: ProcessBundle;
  diff: DraftDiff;
  /** Steps the copy added or changed, by id. */
  changed: string[];
  /** Groups to open on both maps at first: every ancestor of a changed step, in the copy and in the base. */
  open: ReadonlySet<string>;
}

export function compareMaps(base: ProcessBundle, solution: Pick<SolutionRow, "steps">): Comparison {
  const solved = bundleFromSolution(base, solution);
  const diff = diffBundles(base, solved);
  const changed = [...diff.steps.values()].filter((c) => c.kind !== "removed").map((c) => c.id);
  const byId = new Map([...base.steps, ...solved.steps].map((s) => [s.id, s]));
  const open = new Set<string>();
  for (const id of [...diff.steps.keys()]) for (const a of ancestorsOf(id, byId)) open.add(a);
  return { base, solved, diff, changed, open };
}
