// A solution's copy of a process (issue #114, A49): the whole map as the solution has it, stored apart from live and from
// the draft (D18). It uses a block's document shape (`{steps, edges, entry_step_id}`, rows without their revision, workspace
// and process) but keeps everything a map needs: the start and end steps, where each step sits, and anything resting at it.
// Pure.

import { isGroup, type BlockBundle, type BlockEdge, type BlockStep, type ProcessBundle } from "@transpera-flow/db";
import type { DraftDiff } from "@/lib/drafts/diff";

/** The copy a solution stores: the map's steps and connections, as they are in the Editor now. */
export function solutionCopy(bundle: Pick<ProcessBundle, "steps" | "edges">): BlockBundle {
  const steps = bundle.steps.map((s): BlockStep => {
    const { revision_id: _r, workspace_id: _w, process_id: _p, ...rest } = structuredClone(s);
    void _r;
    void _w;
    void _p;
    return rest;
  });
  const edges = bundle.edges.map((e): BlockEdge => {
    const { revision_id: _r, workspace_id: _w, process_id: _p, ...rest } = structuredClone(e);
    void _r;
    void _w;
    void _p;
    return rest;
  });
  return { steps, edges, entry_step_id: null };
}

/** The steps a solution added or changed against live, by id: what the map shows as new. */
export function changedStepIds(diff: Pick<DraftDiff, "steps">): string[] {
  return [...diff.steps.entries()].filter(([, change]) => change.kind !== "removed").map(([id]) => id);
}

/** Why a stored copy can't be saved, in plain English, or null. */
export function solutionProblem(copy: unknown): string | null {
  const bad = "That solution's steps aren't valid.";
  const c = copy as Partial<BlockBundle> | null;
  if (!c || typeof c !== "object" || !Array.isArray(c.steps) || !Array.isArray(c.edges)) return bad;
  if (!c.steps.length) return "Add at least one step to the solution first.";
  const ids = new Set<string>();
  for (const s of c.steps) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.kind !== "string") return bad;
    if (ids.has(s.id)) return bad;
    ids.add(s.id);
  }
  for (const s of c.steps) {
    const parent = s.parent_step_id ?? null;
    if (parent !== null && !ids.has(parent)) return bad;
    if (isGroup(s) && s.entry_step_id && !ids.has(s.entry_step_id)) return bad;
  }
  for (const e of c.edges) {
    if (!e || typeof e.id !== "string" || !ids.has(e.from_step_id) || !ids.has(e.to_step_id)) return bad;
  }
  return null;
}
