// Editing a decision's branches (editor brainstorm, items 5 and 6). Pure, like ./commands.ts and ./groups.ts: each returns an Edit
// (or a plain-English problem, or null when there is nothing to do) against the process as the editor shows it, so each is a
// single undo.
//
// A branch is a line out of the decision: its name is the line's `label`, its share the line's `probability`, its "Only when…"
// the line's `condition_tag`. "Go back" is not a kind of step: it is a line from a branch to an earlier step, which the engine
// already runs as a loop (packages/engine/test/loops.test.ts). `isGoBack` tells the canvas to draw one as "Go back to X".
//
// Shares are whole percents that add up to exactly 100, stored as percent / 100. Changing one share re-balances the others in
// proportion to what they had (brainstorm round 2, item 12): setting a branch, adding one and removing one all keep the others'
// shares in the same ratio to each other. That replaces "the last branch takes what is left" (item 5), which made the last branch
// special for no reason a person could see.

import { type EdgeRow, type ProcessBundle, type StepOutcome, type StepRow } from "@transpera-flow/db";
import { OUTCOME_LABELS, connectionProblem, newStepRow, updateEdge } from "./commands";
import { edgeRow } from "./groups";
import type { Edit, Op, RowChange } from "./ops";

/** Where a branch can lead: a step, an earlier step to go back to, or an end (won, lost or done). */
export type BranchTarget = string | { goBackTo: string } | { end: StepOutcome };

/** What a branch edit gives back: the edit, the line it concerns, a plain-English reason it can't be done, or null (nothing to do). */
export type BranchResult = { edit: Edit; id: string } | { problem: string } | null;

const stepOf = (bundle: ProcessBundle, id: string) => bundle.steps.find((s) => s.id === id);

/** A decision's branches, in line order. */
export const branchesOf = (bundle: ProcessBundle, decisionId: string): EdgeRow[] => bundle.edges.filter((e) => e.from_step_id === decisionId);

/** A share as a whole percent. */
const toPercent = (probability: number | string) => Math.round(Number(probability) * 100);

/**
 * Whether `from` leads to `to` by following lines. A group leads where its first step does and where its steps lead out of it,
 * and a step in a group leads where the group leads, so a loop through a group is still seen as one.
 */
function leadsTo(bundle: ProcessBundle, from: string, to: string): boolean {
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const at = queue.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (at === to) return true;
    for (const e of bundle.edges) if (e.from_step_id === at) queue.push(e.to_step_id);
    const step = byId.get(at);
    if (step?.entry_step_id) queue.push(step.entry_step_id);
    // Leaving a step with no line out of it, inside a group: it goes on where the group goes.
    if (step?.parent_step_id) queue.push(step.parent_step_id);
  }
  return false;
}

/** True when the line points to a step that leads to the step the line comes from: a loop. The canvas draws these as "Go back to X". */
export function isGoBack(bundle: ProcessBundle, edgeId: string): boolean {
  const edge = bundle.edges.find((e) => e.id === edgeId);
  if (!edge || edge.from_step_id === edge.to_step_id) return false;
  return leadsTo(bundle, edge.to_step_id, edge.from_step_id);
}

/** Why a decision's branch can't go back to this step, or null if it can. */
export function goBackProblem(bundle: ProcessBundle, decisionId: string, stepId: string): string | null {
  const target = stepOf(bundle, stepId);
  if (!target) return "Pick the step to go back to.";
  if (stepId === decisionId) return "A decision can't go back to itself. Send the branch to an earlier step.";
  if (target.kind === "start" || target.kind === "end") return "A branch goes back to a step, not to the start or an end.";
  if (!leadsTo(bundle, stepId, decisionId)) return `${target.name} doesn't lead to this decision, so going back to it isn't a loop. Pick a step that comes before the decision.`;
  return null;
}

/** An end with this outcome that the branch could reuse (the first one on the map), or undefined. */
function endWith(bundle: ProcessBundle, outcome: StepOutcome): StepRow | undefined {
  return bundle.steps.find((s) => s.kind === "end" && s.outcome === outcome);
}

/** Why a branch can't end with this outcome, or null. Won and lost are for pipelines: client work just ends. */
export function endProblem(bundle: ProcessBundle, outcome: StepOutcome): string | null {
  if (outcome !== "done" && bundle.process.kind === "servicing") return "Client work just ends. Won and lost are for pipelines.";
  return null;
}

/** Where a new end step goes: to the right of the top-level step the decision sits in (or is). */
function endSpot(bundle: ProcessBundle, decision: StepRow): { x: number; y: number } {
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  let top = decision;
  for (let seen = 0; top.parent_step_id && byId.has(top.parent_step_id) && seen < 50; seen++) top = byId.get(top.parent_step_id)!;
  const ends = bundle.steps.filter((s) => s.kind === "end").length;
  return { x: Number(top.x) + 360, y: Number(top.y) + 80 * ends };
}

/** Why a branch from `decisionId` can't lead to `target` (a line being moved is `except`), or null. */
export function branchTargetProblem(bundle: ProcessBundle, decisionId: string, target: BranchTarget, except?: string): string | null {
  const decision = stepOf(bundle, decisionId);
  if (!decision) return "Pick the decision to add a branch to.";
  if (decision.kind === "end") return "End steps can't lead anywhere.";
  if (typeof target === "string") return connectionProblem(bundle, decisionId, target, except);
  if ("goBackTo" in target) return goBackProblem(bundle, decisionId, target.goBackTo) ?? connectionProblem(bundle, decisionId, target.goBackTo, except);
  return endProblem(bundle, target.end);
}

/** The step a branch will lead to, and the rows to add for it (a new end when the map has none with that outcome). */
function resolveTarget(bundle: ProcessBundle, decision: StepRow, target: BranchTarget): { to: string; steps: StepRow[] } {
  if (typeof target === "string") return { to: target, steps: [] };
  if ("goBackTo" in target) return { to: target.goBackTo, steps: [] };
  const existing = endWith(bundle, target.end);
  if (existing) return { to: existing.id, steps: [] };
  const { x, y } = endSpot(bundle, decision);
  const end = newStepRow(bundle, "end", target.end, x, y);
  return { to: end.id, steps: [end] };
}

const describeTarget = (bundle: ProcessBundle, target: BranchTarget, to: string): string => {
  if (typeof target !== "string" && "end" in target) return `end (${OUTCOME_LABELS[target.end].toLowerCase()})`;
  const name = stepOf(bundle, to)?.name ?? "step";
  return typeof target !== "string" ? `go back to ${name}` : name;
};

/**
 * Add a branch to a decision. The new branch gets an even share (100 / the new number of branches, rounded) and the others shrink
 * in proportion to make room, so "Yes 50 / No 50" becomes "Yes 34 / No 33 / new 33". The new branch is the last in line order.
 * A decision with no branches gives it 100%.
 */
export function addBranch(bundle: ProcessBundle, decisionId: string, target: BranchTarget): BranchResult {
  const decision = stepOf(bundle, decisionId);
  if (!decision) return null;
  const problem = branchTargetProblem(bundle, decisionId, target);
  if (problem) return { problem };
  const branches = branchesOf(bundle, decisionId);
  const share = Math.round(100 / (branches.length + 1));
  const rest = shareOut(branches.map((e) => toPercent(e.probability)), 100 - share);
  const { to, steps } = resolveTarget(bundle, decision, target);
  const edge: EdgeRow = { ...edgeRow(bundle, decisionId, to, share / 100), label: `Branch ${branches.length + 1}` };
  const ops: Op[] = [{ kind: "insert", steps, edges: [edge] }];
  const changes = shareChanges(branches, rest);
  if (changes.length) ops.push({ kind: "update", changes });
  return { edit: { label: `Added a branch from ${decision.name} to ${describeTarget(bundle, target, to)}`, ops }, id: edge.id };
}

/** Send an existing branch somewhere else. Its name, share and "Only when…" stay. */
export function setBranchTarget(bundle: ProcessBundle, edgeId: string, target: BranchTarget): BranchResult {
  const edge = bundle.edges.find((e) => e.id === edgeId);
  const decision = edge && stepOf(bundle, edge.from_step_id);
  if (!edge || !decision) return null;
  const problem = branchTargetProblem(bundle, decision.id, target, edgeId);
  if (problem) return { problem };
  const { to, steps } = resolveTarget(bundle, decision, target);
  if (to === edge.to_step_id) return null;
  const ops: Op[] = [];
  if (steps.length) ops.push({ kind: "insert", steps, edges: [] });
  ops.push({ kind: "update", changes: [{ table: "edges", id: edgeId, before: { to_step_id: edge.to_step_id }, after: { to_step_id: to } }] });
  return { edit: { label: `Sent a branch of ${decision.name} to ${describeTarget(bundle, target, to)}`, ops }, id: edgeId };
}

/**
 * Share `total` whole percents over branches that now have `weights` percent, in proportion to them, so they keep their ratio to
 * each other. All zero: evenly. Each gets its exact share rounded down, and what rounding leaves goes to the largest (the first of
 * equals), so the result is whole numbers that add up to `total` exactly and no branch moves against the others' direction.
 */
function shareOut(weights: readonly number[], total: number): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (sum > 0 ? (w * total) / sum : total / weights.length));
  const out = exact.map((x) => Math.floor(x + 1e-9));
  const largest = exact.reduce((best, x, i) => (x > exact[best]! ? i : best), 0);
  out[largest]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** The row changes that give `branches` these whole percents (none for a branch already at its share, as stored). */
function shareChanges(branches: readonly EdgeRow[], percents: readonly number[]): RowChange[] {
  return branches.flatMap((e, i) =>
    // Compare as stored, so a share that was 0.333 is settled to 33%.
    Number(e.probability) === percents[i]! / 100 ? [] : [{ table: "edges" as const, id: e.id, before: { probability: e.probability }, after: { probability: percents[i]! / 100 } }],
  );
}

/**
 * Set one branch's share, in whole percent. The other branches share what is left in proportion to what they had (all at 0: evenly),
 * so the shares always add up to 100%: "Yes 50 / No 30 / Maybe 20" with Yes set to 60 gives "60 / 24 / 16".
 * Null when the share isn't a number from 0 to 100, the line isn't a branch of the decision, there is only one branch (it is
 * always 100%), or nothing changes.
 */
export function setBranchShare(bundle: ProcessBundle, decisionId: string, edgeId: string, percent: number): Edit | null {
  const decision = stepOf(bundle, decisionId);
  const branches = branchesOf(bundle, decisionId);
  const at = branches.findIndex((e) => e.id === edgeId);
  if (!decision || at < 0 || branches.length < 2 || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const value = Math.round(percent);
  const others = branches.filter((_, i) => i !== at);
  const shared = shareOut(others.map((e) => toPercent(e.probability)), 100 - value);
  const next = branches.map((_, i) => (i === at ? value : shared[i < at ? i : i - 1]!));
  const changes = shareChanges(branches, next);
  if (!changes.length) return null;
  const name = branches[at]!.label?.trim() || stepOf(bundle, branches[at]!.to_step_id)?.name || "branch";
  return { label: `Set ${name} to ${value}%`, ops: [{ kind: "update", changes }] };
}

/** Rename a branch (the line's label); blank clears it. */
export function setBranchName(bundle: ProcessBundle, edgeId: string, name: string): Edit | null {
  const label = name.trim();
  if (label.length > 200) return null;
  const edit = updateEdge(bundle, edgeId, { label: label || null });
  return edit && { ...edit, label: label ? `Renamed a branch to ${label}` : "Cleared a branch's name" };
}

/** Set a branch's optional "Only when…" (the line's condition tag); blank clears it. */
export function setBranchCondition(bundle: ProcessBundle, edgeId: string, condition: string): Edit | null {
  const tag = condition.trim();
  if (tag.length > 100) return null;
  const edit = updateEdge(bundle, edgeId, { condition_tag: tag || null });
  return edit && { ...edit, label: tag ? `Set a branch to only when ${tag}` : "Cleared a branch's condition" };
}

/**
 * Take a branch off a decision. The branches left grow in proportion to what they had, so the shares still add up to 100%:
 * "Yes 50 / No 30 / Maybe 20" without Yes gives "No 60 / Maybe 40". A decision with one branch left keeps it (at 100%); it never
 * loses its last branch this way. Null when the line isn't a branch, or is the only one.
 */
export function removeBranch(bundle: ProcessBundle, edgeId: string): Edit | null {
  const edge = bundle.edges.find((e) => e.id === edgeId);
  const decision = edge && stepOf(bundle, edge.from_step_id);
  if (!edge || !decision) return null;
  const branches = branchesOf(bundle, decision.id);
  if (branches.length < 2) return null;
  const rest = branches.filter((e) => e.id !== edgeId);
  const changes = shareChanges(rest, shareOut(rest.map((e) => toPercent(e.probability)), 100));
  const ops: Op[] = [{ kind: "remove", steps: [], edges: [edge] }];
  if (changes.length) ops.push({ kind: "update", changes });
  const name = edge.label?.trim() || stepOf(bundle, edge.to_step_id)?.name || "branch";
  return { label: `Removed the ${name} branch from ${decision.name}`, ops };
}
