// Rework loops (issue #174). On the flattened model (groups and child processes
// already dissolved into their leaf steps) a loop is either
//
// - a same-step redo: a step with a rework rate sends an item back to itself, or
// - a back-edge: an edge that closes a cycle, found by a depth-first search.
//
// The search starts at the model's entry, then at each service's and servicing
// process's entry in model order, and follows each step's edges in the order of
// the steps they lead to (not the order they were drawn), so the loops and their
// order depend only on the graph. Any routing back is treated as a loop (rework);
// a future "not rework" flag on edges could exclude some (see docs/PRD.md D41). An edge into a step that
// is still on the search stack closes a cycle: the stack from that step to the
// edge's source is the loop's `steps` (entry, ..., last step), and the edge goes
// back to the first. Edges to ends (including hand-offs) are not followed.
//
// Pure: no randomness and no I/O.

import { flattenModel } from "./flatten";
import type { EngineModel } from "./model";

export type LoopKind = "redo" | "back-edge";

export interface Loop {
  /** `redo:<step>` or `back:<from>><to>`. */
  id: string;
  kind: LoopKind;
  /** The steps in the loop, from where it is entered round to the step that sends items back (a redo: just the step). */
  steps: string[];
  /** The step an item is sent back from, and the one it is sent back to (the same for a redo). */
  from: string;
  to: string;
  /**
   * Every step on some path from `to` to `from`, `steps` among them. Time an
   * item spends in these on a repeat pass is what the loop's hours and days count.
   */
  body: string[];
}

/** The loops of `model`, flattened first if it is nested: redos in step order, then back-edges in the order the search meets them. */
export function detectLoops(model: EngineModel): Loop[] {
  model = flattenModel(model);
  const known = new Set(model.steps.map((s) => s.id));
  const out: Loop[] = [];
  for (const s of model.steps) {
    if (s.rework > 0) out.push({ id: `redo:${s.id}`, kind: "redo", steps: [s.id], from: s.id, to: s.id, body: [s.id] });
  }

  // Forward and backward adjacency, in model order, over step-to-step edges only.
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const s of model.steps) {
    fwd.set(s.id, []);
    back.set(s.id, []);
  }
  for (const s of model.steps) {
    for (const n of s.next) {
      if (!known.has(n.to)) continue;
      if (!fwd.get(s.id)!.includes(n.to)) fwd.get(s.id)!.push(n.to);
      if (!back.get(n.to)!.includes(s.id)) back.get(n.to)!.push(s.id);
    }
  }
  // Canonical order: edges are followed in the order of the steps they lead to, not the order they were drawn, so the same graph gives the same loops.
  const order = new Map(model.steps.map((s, i) => [s.id, i]));
  for (const adj of [fwd, back]) for (const list of adj.values()) list.sort((a, b) => order.get(a)! - order.get(b)!);
  const reach = (from: string, adj: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>([from]);
    const todo = [from];
    for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
      for (const n of adj.get(id)!) {
        if (!seen.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return seen;
  };

  const roots = [
    model.entry,
    ...Object.values(model.services ?? {}).flatMap((sv) => (sv.entry !== undefined ? [sv.entry] : [])),
    ...Object.values(model.servicingProcesses ?? {}).map((p) => p.entry),
  ];
  const state = new Map<string, 1 | 2>(); // 1 on the stack, 2 finished
  const dfs = (root: string) => {
    if (!known.has(root) || state.has(root)) return;
    const stack: string[] = [root];
    const idx: number[] = [0];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const edges = fwd.get(top)!;
      const i = idx[idx.length - 1]!;
      if (i >= edges.length) {
        state.set(top, 2);
        stack.pop();
        idx.pop();
        continue;
      }
      idx[idx.length - 1] = i + 1;
      const to = edges[i]!;
      const seen = state.get(to);
      if (seen === 1) {
        const inFwd = reach(to, fwd);
        const inBack = reach(top, back);
        const body = model.steps.filter((s) => inFwd.has(s.id) && inBack.has(s.id)).map((s) => s.id);
        out.push({ id: `back:${top}>${to}`, kind: "back-edge", steps: stack.slice(stack.indexOf(to)), from: top, to, body });
      } else if (seen === undefined) {
        state.set(to, 1);
        stack.push(to);
        idx.push(0);
      }
    }
  };
  for (const r of roots) dfs(r);
  return out;
}
