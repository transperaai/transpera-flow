"use client";

import { Help } from "@/components/help";
import { PayHidden } from "@/components/pay-hidden";
import { useShareFinancialsHidden } from "@/components/share/share-context";
import { formatIssueCost } from "@/lib/issues/register";
import type { IssueCost } from "@transpera-flow/engine";

/** The (i) text wherever a share link hides a money figure because Financials is off (B3, issue #32). */
export const MONEY_HIDDEN_HELP = {
  label: "Money hidden",
  description: "This shared view hides costs, margins and overhead. Revenue is still shown.",
  example: "The cost of an issue shows —, but New MRR shows £12.4k.",
} as const;

/** "—" with its (i): shown in a shared view instead of a cost, margin or overhead figure when Financials is off. */
export function MoneyHidden() {
  return (
    <span className="inline-flex items-center" data-money-hidden>
      <span aria-label="Not available">—</span>
      <Help {...MONEY_HIDDEN_HELP} />
    </span>
  );
}

/**
 * What an issue or insight costs a month, as the screens print it: "—" with its (i) when it depends on people's pay (members,
 * viewers, every share link), "—" when it is money and a share link hides financials (hours stay), else as before.
 */
export function IssueCostText({ cost, currency }: { cost: IssueCost | null; currency: string }) {
  const hideMoney = useShareFinancialsHidden();
  if (cost?.payHidden) return <PayHidden />;
  if (hideMoney && cost?.perMonth != null) return <MoneyHidden />;
  return <>{formatIssueCost(cost, currency)}</>;
}

/** An issue's "how it's worked out" text: nothing when it depends on pay, or when it is money and the share link hides financials. */
export function visibleCostMethod(cost: IssueCost | null | undefined, hideMoney: boolean): string | undefined {
  if (!cost || cost.payHidden || (hideMoney && cost.perMonth != null)) return undefined;
  return cost.method;
}
