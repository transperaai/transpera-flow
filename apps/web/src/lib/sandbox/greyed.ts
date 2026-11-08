// Levers the Sandbox's change dialog greys out, and why (design suggestion 8: offer only a lever that will move the result here, and
// say why when one doesn't). A greyed option in a <select> can't be picked, so its reason has to be shown beside the list, not only
// once the lever is chosen. Pure: no React.

import type { SandboxLever } from "@transpera-flow/db";

/** Why "Solution goes live" can't be used: no saved solution belongs to a process the run includes. */
export const NO_SOLUTION_REASON = "No solution is saved for the processes in this run yet. Design one on the Solutions page first.";

/** E6's reason, from the solutions the dialog would offer, or null when one can go live. */
export function solutionReason(solutions: readonly { inModel: boolean }[]): string | null {
  return solutions.some((s) => s.inModel) ? null : NO_SOLUTION_REASON;
}

/** The greyed levers grouped by their reason, in the order offered: "Clients on the book and Base churn" with one sentence. */
export function greyedLevers(levers: readonly Pick<SandboxLever, "id" | "label">[], appliesReason: (leverId: string) => string | null): { reason: string; labels: string[] }[] {
  const out: { reason: string; labels: string[] }[] = [];
  for (const l of levers) {
    const reason = appliesReason(l.id);
    if (!reason) continue;
    const group = out.find((g) => g.reason === reason);
    if (group) group.labels.push(l.label);
    else out.push({ reason, labels: [l.label] });
  }
  return out;
}

/** "A", "A and B", "A, B and C". */
export function listWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
