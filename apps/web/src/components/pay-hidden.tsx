"use client";

import { Help } from "@/components/help";

/** The (i) text wherever a figure depends on individual pay and the viewer is a member or viewer (B1 2a, issue #30). */
export const PAY_HIDDEN_HELP = {
  label: "Costs that depend on pay",
  description: "Only owners and editors see costs that depend on people's pay.",
  example: "The cost of overtime, and the cost attached to an overtime or too-busy issue.",
} as const;

/** "—" with its (i): shown instead of a money figure that needs people's pay. Never 0, never an estimate from a role's rate. */
export function PayHidden() {
  return (
    <span className="inline-flex items-center" data-pay-hidden>
      <span aria-label="Not available">—</span>
      <Help {...PAY_HIDDEN_HELP} />
    </span>
  );
}
