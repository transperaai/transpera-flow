// What the Editor calls the kinds of node a person works with (editor brainstorm, item 2): Step, Wait, Decision and End, plus the one
// fixed Start. Go back is not a kind of step: it is a decision's branch that loops to an earlier step (./branches.ts).

import type { StepKind } from "@transpera-flow/db";

/** The "Type" field's choices, in the order it lists them. Start is never offered: a process has one, and it stays. */
export const TYPE_CHOICES = ["task", "wait", "decision", "end"] as const satisfies readonly StepKind[];

/** The Editor's words for a step's kind. */
export const TYPE_LABELS: Record<StepKind, string> = {
  task: "Step",
  wait: "Wait",
  decision: "Decision",
  end: "End",
  start: "Start",
  group: "Group",
  subprocess: "Linked process",
};
