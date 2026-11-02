// The Overview's "Process health" roll-up: each process's rating is the worst of its confirmed open issues and of the
// processes inside it. The Processes page and the process switcher no longer show a process rating (Q3); only this
// roll-up, which feeds the health donut, still reads one. Pure.

import { companyMap, type IssueLinkRef, type IssueRow, type StepRow } from "@transpera-flow/db";
import { compareRatingsDesc, ratingOfStored, type Rating } from "@transpera-flow/engine";

type IssueFact = Pick<IssueRow, "process_id" | "step_id" | "severity" | "status"> & { links?: readonly IssueLinkRef[] };

const worse = (a: Rating | null, b: Rating | null): Rating | null => (a === null ? b : b === null ? a : compareRatingsDesc(b, a) < 0 ? b : a);

/** Each process's rating (the worst of its open issues, and of the processes inside it), by id. A Great issue is not a problem. */
export function processRatings(
  processes: readonly { id: string; name: string; kind: "pipeline" | "servicing"; parentId?: string | null }[],
  issues: readonly IssueFact[],
  /** The live steps of every process, so an issue that names only a step still counts toward its process. */
  steps: readonly (Pick<StepRow, "process_id"> & { id?: string })[] = [],
): Record<string, Rating | null> {
  const nodes = companyMap(processes.map((p) => ({ ...p, description: null, parentId: p.parentId ?? null, live: true, draft: false })));
  const stepProcess = new Map<string, string>();
  for (const s of steps) if (s.id) stepProcess.set(s.id, s.process_id);
  const own = new Map<string, Rating | null>();
  for (const i of issues) {
    if (i.status !== "open" && i.status !== "testing") continue;
    const where = new Set<string>();
    const add = (processId: string | null | undefined, stepId: string | null | undefined) => {
      const pid = processId ?? (stepId ? stepProcess.get(stepId) : undefined);
      if (pid) where.add(pid);
    };
    add(i.process_id, i.step_id);
    for (const l of i.links ?? []) add(l.process_id, l.step_id);
    const r = ratingOfStored(i.severity);
    if (r === "great") continue;
    for (const pid of where) own.set(pid, worse(own.get(pid) ?? null, r));
  }
  const total = new Map<string, Rating | null>();
  const sum = (n: (typeof nodes)[number]): Rating | null => {
    let t = own.get(n.process.id) ?? null;
    for (const c of n.children) t = worse(t, sum(c));
    total.set(n.process.id, t);
    return t;
  };
  nodes.forEach(sum);
  return Object.fromEntries(processes.map((p) => [p.id, total.get(p.id) ?? null]));
}
