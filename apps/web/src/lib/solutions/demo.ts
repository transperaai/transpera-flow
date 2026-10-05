// The demo's solutions (issue #114): an in-memory store the Editor's solution mode and the process page share for the length
// of the tab (like the demo's blocks, gone on reload). Saving here writes nothing but this list: the demo's live map and its
// draft are never touched, as in a workspace.

import { useSyncExternalStore } from "react";
import { NORTHBEAM_WORKSPACE_ID, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import type { SolutionInput } from "./save";

interface DemoState {
  solutions: SolutionRow[];
  links: SolutionIssueRow[];
  /** Solutions built from an AI idea (the demo's Suggestions page records them when an idea is built). */
  aiIds: string[];
}

const EMPTY: DemoState = { solutions: [], links: [], aiIds: [] };
let state: DemoState = EMPTY;
const listeners = new Set<() => void>();

/** Save a solution into the demo's list (this tab only), with a link per issue it was built for. */
export function addDemoSolution(input: SolutionInput): { solution: SolutionRow; links: SolutionIssueRow[] } {
  const now = new Date().toISOString();
  const solution: SolutionRow = {
    id: crypto.randomUUID(),
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    process_id: input.processId,
    base_revision_id: input.baseRevisionId,
    name: input.name,
    notes: "",
    steps: structuredClone(input.copy),
    changed_step_ids: [...input.changedStepIds],
    lever_changes: structuredClone(input.levers),
    created_at: now,
    updated_at: now,
    created_by: null,
  };
  const links: SolutionIssueRow[] = input.links.map((l) => ({
    solution_id: solution.id,
    issue_id: l.issueId,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    auto_verdict: l.autoVerdict,
    holds_pct: l.holdsPct,
    auto_note: l.autoNote,
    user_verdict: null,
    user_notes: "",
    created_at: now,
    updated_at: now,
    created_by: null,
  }));
  state = { ...state, solutions: [solution, ...state.solutions], links: [...state.links, ...links] };
  for (const l of listeners) l();
  return { solution, links };
}

/** Record that a demo solution was built from an AI idea, so it reads "AI block". */
export function markDemoSolutionAi(solutionId: string): void {
  if (state.aiIds.includes(solutionId)) return;
  state = { ...state, aiIds: [...state.aiIds, solutionId] };
  emit();
}

const emit = () => {
  for (const l of listeners) l();
};

/** What one save changes: your verdict (null clears it), your note, or both. A field left out is not written. */
export interface VerdictPatch {
  verdict?: "pass" | "fail" | null;
  notes?: string;
}

/** Your verdict and/or note on one issue a solution solves, in this tab. Only the fields in `patch` change. */
export function setDemoVerdict(solutionId: string, issueId: string, patch: VerdictPatch): SolutionIssueRow | null {
  let found: SolutionIssueRow | null = null;
  state = {
    ...state,
    links: state.links.map((l) => {
      if (l.solution_id !== solutionId || l.issue_id !== issueId) return l;
      found = { ...l, ...(patch.verdict === undefined ? {} : { user_verdict: patch.verdict }), ...(patch.notes === undefined ? {} : { user_notes: patch.notes }), updated_at: new Date().toISOString() };
      return found;
    }),
  };
  emit();
  return found;
}

/** The notes on a solution, in this tab. */
export function setDemoNotes(solutionId: string, notes: string): void {
  state = { ...state, solutions: state.solutions.map((s) => (s.id === solutionId ? { ...s, notes, updated_at: new Date().toISOString() } : s)) };
  emit();
}

/** Link a solution to another issue in this tab, with the verdict worked out by the caller (null: not checked). */
export function addDemoLink(solutionId: string, issueId: string, verdict: { autoVerdict: "pass" | "fail" | null; holdsPct: number | null; autoNote: string }): SolutionIssueRow | null {
  if (!state.solutions.some((s) => s.id === solutionId) || state.links.some((l) => l.solution_id === solutionId && l.issue_id === issueId)) return null;
  const now = new Date().toISOString();
  const link: SolutionIssueRow = {
    solution_id: solutionId,
    issue_id: issueId,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    auto_verdict: verdict.autoVerdict,
    holds_pct: verdict.autoVerdict ? verdict.holdsPct : null,
    auto_note: verdict.autoNote,
    user_verdict: null,
    user_notes: "",
    created_at: now,
    updated_at: now,
    created_by: null,
  };
  state = { ...state, links: [...state.links, link] };
  emit();
  return link;
}

/** Delete a solution and its links in this tab (issue #182). */
export function removeDemoSolution(solutionId: string): void {
  state = {
    ...state,
    solutions: state.solutions.filter((s) => s.id !== solutionId),
    links: state.links.filter((l) => l.solution_id !== solutionId),
    aiIds: state.aiIds.filter((id) => id !== solutionId),
  };
  emit();
}

/** The demo's solutions as they are now (outside a component; the tests read this). */
export const demoSolutionsNow = (): DemoState => state;

/** The demo's solutions, kept up to date as the Editor saves more. Server rendering and hydration see none. */
export function useDemoSolutions(): DemoState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
    () => EMPTY,
  );
}
