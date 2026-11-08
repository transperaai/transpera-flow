"use client";

import { PayHidden } from "@/components/pay-hidden";
import { formatIssueCost } from "@/lib/issues/register";
import type { IssueCost } from "@transpera-flow/engine";

/**
 * What an issue or insight costs a month, as the screens print it: "—" with its (i) when it depends on people's pay (members,
 * viewers), else as before.
 */
export function IssueCostText({ cost, currency }: { cost: IssueCost | null; currency: string }) {
  if (cost?.payHidden) return <PayHidden />;
  return <>{formatIssueCost(cost, currency)}</>;
}

/** An issue's "how it's worked out" text: nothing when it depends on pay. */
export function visibleCostMethod(cost: IssueCost | null | undefined): string | undefined {
  if (!cost || cost.payHidden) return undefined;
  return cost.method;
}
