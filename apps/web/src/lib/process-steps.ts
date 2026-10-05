// Which steps belong to the process on a process page: its own and those of the processes inside it. The model can
// hold more (a servicing process runs beside the pipeline), so the page's wait chart, insights and issues keep to these.

import type { ProcessBundle, StepRow } from "@transpera-flow/db";

/**
 * The steps of the bundle's process and of every process nested inside it, any depth. "Inside" is a link (B12): a holder step
 * of this revision, or of a process it holds, whose `child_process_id` is the process.
 */
export function processSteps(bundle: ProcessBundle): StepRow[] {
  const others = new Map((bundle.otherProcesses ?? []).map((o) => [o.process.id, o]));
  const inside = new Set([bundle.process.id]);
  const out = [...bundle.steps];
  const visit = (steps: readonly StepRow[]) => {
    for (const s of steps) {
      const child = s.child_process_id ? others.get(s.child_process_id) : undefined;
      if (!child || inside.has(child.process.id)) continue;
      inside.add(child.process.id);
      out.push(...child.steps);
      visit(child.steps);
    }
  };
  visit(bundle.steps);
  return out;
}

export const processStepIds = (bundle: ProcessBundle): Set<string> => new Set(processSteps(bundle).map((s) => s.id));
