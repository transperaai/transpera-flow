// Traffic by type (lever A6), shown and set as percentages that add up to 100%. The engine takes a weight per service type
// (`services.<id>.mix_share`) and draws each opportunity's type in proportion to it, so a type's share is its weight over the total.
// A change stores ONE weight (a "set" patch), chosen so the type lands on the percentage asked for while the other types keep their
// weights (and so their proportions to one another). Pure: no React.

/** The most a type can be set to: the other types keep a sliver, since 100% would need them at nothing. */
export const MAX_TRAFFIC_PERCENT = 99;

/** The sum of the weights of every type but `targetId`. */
export function othersTotal(mix: Readonly<Record<string, number>>, targetId: string): number {
  return Object.entries(mix).reduce((sum, [id, w]) => (id === targetId ? sum : sum + (Number.isFinite(w) && w > 0 ? w : 0)), 0);
}

/** A weight as a share (0 to 1) of all traffic, with the other types' weights adding up to `others`. */
export function weightToShare(weight: number, others: number): number {
  const total = weight + others;
  return total > 0 ? weight / total : 0;
}

/**
 * The weight that gives a type `share` (0 to 1, below 1) of all traffic with the other types' weights adding up to `others`; null
 * when there is no such weight (the others have nothing, or the share is 100% or more). Rounded to 6 places, as stored values are.
 */
export function shareToWeight(share: number, others: number): number | null {
  if (!Number.isFinite(share) || share < 0 || share >= 1) return null;
  if (share === 0) return 0;
  if (!(others > 0)) return null;
  return Math.round(((share * others) / (1 - share)) * 1e6) / 1e6;
}

/** A share as the percent shown: one decimal at most ("40%", "33.3%"). */
export const percentText = (share: number): string => `${Math.round(share * 1000) / 10}%`;
