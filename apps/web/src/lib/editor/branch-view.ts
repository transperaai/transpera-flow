// How a decision's branches are drawn and listed in the simpler editor (editor brainstorm, items 5 and 6). Pure.
//
// A branch is a line out of a decision (./branches.ts). On the canvas the decision shows one row per branch, and a branch that goes back
// to an earlier step (`isGoBack`) ends in a small "Go back to X" node instead of a line drawn across the map.

import type { EdgeRow, ProcessBundle, StepOutcome } from "@transpera-flow/db";
import { OUTCOME_LABELS } from "./commands";
import { branchTargetProblem, branchesOf, goBackProblem, isGoBack, type BranchTarget } from "./branches";

/** The id of the node drawn for a go back is this plus the branch's line id. */
export const GO_BACK_PREFIX = "goback:";
/** ...and of the dotted line from that node to the step it goes back to. */
export const GO_BACK_LINK_PREFIX = "gobacklink:";

export const goBackNodeId = (edgeId: string) => `${GO_BACK_PREFIX}${edgeId}`;
export const isGoBackNodeId = (id: string) => id.startsWith(GO_BACK_PREFIX);
export const edgeOfGoBackNode = (id: string) => id.slice(GO_BACK_PREFIX.length);

/** What a branch is called: its name, else the step it leads to. */
export function branchName(bundle: ProcessBundle, edge: EdgeRow): string {
  return edge.label?.trim() || bundle.steps.find((s) => s.id === edge.to_step_id)?.name || "Branch";
}

export interface BranchRow {
  id: string;
  name: string;
  /** Whole percent. */
  percent: number;
  /** "Only when…", or null. */
  condition: string | null;
  goBack: boolean;
  /** The step the line leads to. */
  to: string;
}

/** A decision's branches as the node and the panel list them, in line order. */
export function branchRows(bundle: ProcessBundle, decisionId: string): BranchRow[] {
  return branchesOf(bundle, decisionId).map((e) => ({
    id: e.id,
    name: branchName(bundle, e),
    percent: Math.round(Number(e.probability) * 100),
    condition: e.condition_tag?.trim() || null,
    goBack: isGoBack(bundle, e.id),
    to: e.to_step_id,
  }));
}

export interface GoBackNode {
  /** The node's id on the canvas. */
  id: string;
  edgeId: string;
  decisionId: string;
  /** The step it goes back to. */
  targetId: string;
  targetName: string;
}

/** A go back node for every branch of a decision that goes back to an earlier step. */
export function goBackNodes(bundle: ProcessBundle): GoBackNode[] {
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  return bundle.edges.flatMap((e) => {
    const from = byId.get(e.from_step_id);
    const to = byId.get(e.to_step_id);
    if (from?.kind !== "decision" || !to || !isGoBack(bundle, e.id)) return [];
    return [{ id: goBackNodeId(e.id), edgeId: e.id, decisionId: from.id, targetId: to.id, targetName: to.name }];
  });
}

/** One choice in a branch's "Goes to" menu. `value` is what the select holds. */
export interface GoesToOption {
  value: string;
  label: string;
}
export interface GoesToGroup {
  /** "Next step…", "Go back to…" or "End (won / lost / done)". */
  label: string;
  options: GoesToOption[];
}

export const encodeTarget = (t: BranchTarget): string => (typeof t === "string" ? `step:${t}` : "goBackTo" in t ? `back:${t.goBackTo}` : `end:${t.end}`);
export function decodeTarget(value: string): BranchTarget | null {
  const at = value.indexOf(":");
  const kind = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (kind === "step" && rest) return rest;
  if (kind === "back" && rest) return { goBackTo: rest };
  if (kind === "end" && (rest === "won" || rest === "lost" || rest === "done")) return { end: rest as StepOutcome };
  return null;
}

/** What a branch leads to now, as the "Goes to" menu holds it. */
export function currentTarget(bundle: ProcessBundle, edge: EdgeRow): string {
  const to = bundle.steps.find((s) => s.id === edge.to_step_id);
  if (to?.kind === "end" && to.outcome) return encodeTarget({ end: to.outcome });
  return encodeTarget(isGoBack(bundle, edge.id) ? { goBackTo: edge.to_step_id } : edge.to_step_id);
}

/**
 * The "Goes to" menu of one branch: only places it can really lead. The branch's current place is always offered, so the menu
 * can show it.
 */
export function goesToMenu(bundle: ProcessBundle, edge: EdgeRow): GoesToGroup[] {
  const decisionId = edge.from_step_id;
  const now = currentTarget(bundle, edge);
  const working = bundle.steps.filter((s) => s.id !== decisionId && s.kind !== "start" && s.kind !== "end");
  const offer = (target: BranchTarget) => {
    const value = encodeTarget(target);
    return value === now || branchTargetProblem(bundle, decisionId, target, edge.id) === null;
  };
  // A step that leads back to the decision is a "Go back to…", not a next step: the menu keeps the two apart.
  const next = working.filter((s) => offer(s.id) && (encodeTarget(s.id) === now || goBackProblem(bundle, decisionId, s.id) !== null)).map((s) => ({ value: encodeTarget(s.id), label: s.name }));
  const back = working.filter((s) => offer({ goBackTo: s.id })).map((s) => ({ value: encodeTarget({ goBackTo: s.id }), label: s.name }));
  const ends = (["won", "lost", "done"] as const).filter((o) => offer({ end: o })).map((o) => ({ value: encodeTarget({ end: o }), label: OUTCOME_LABELS[o] }));
  return [
    { label: "Next step…", options: next },
    { label: "Go back to…", options: back },
    { label: "End (won / lost / done)", options: ends },
  ].filter((g) => g.options.length > 0);
}
