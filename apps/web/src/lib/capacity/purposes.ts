// The Capacity page's "time to serve" bars label their segments by the planned hours' purpose. A step carries a purpose key
// ("client_job"); the workspace names each key (Settings → Purposes). This maps the keys to those names, as the Sandbox's time view does.
// Pure: no React.

import { workspacePurposes, type PurposeCategory } from "@transpera-flow/db";

/** What a key reads as when the workspace's list has no such category (a deleted one, or a step with no purpose). */
export const PURPOSE_NOT_SET = "Not set";
/** Hand-holding hours are not a step's purpose: the plan adds them under this name. */
const HAND_HOLDING = "Hand-holding";

export interface PurposePart {
  key: string;
  name: string;
  value: number;
}

/**
 * Planned hours by purpose key, as bar segments named by the workspace's categories, largest first. A key the list doesn't have
 * (including the plan's "Other" for a step with no purpose) is "Not set"; several such keys are one segment.
 */
export function namedPurposeParts(byPurpose: readonly { name: string; hours: number }[], categories: readonly PurposeCategory[] = workspacePurposes(null)): PurposePart[] {
  const names = new Map(categories.map((c) => [c.key, c.name]));
  const parts = new Map<string, PurposePart>();
  for (const { name: key, hours } of byPurpose) {
    const name = names.get(key) ?? (key === HAND_HOLDING ? HAND_HOLDING : PURPOSE_NOT_SET);
    const part = parts.get(name);
    if (part) part.value += hours;
    else parts.set(name, { key: name, name, value: hours });
  }
  return [...parts.values()].sort((a, b) => b.value - a.value);
}

/**
 * A categorical palette for the time-to-serve bars: hues far apart (blue, orange, purple, green, pink, olive, indigo, cyan), each a theme
 * token at mid-lightness so a segment reads on both themes. "Not set" is always the neutral grey.
 */
export const PURPOSE_PALETTE = [
  "var(--accent)",
  "var(--purpose-spare-1)",
  "var(--purpose-winning)",
  "var(--purpose-spare-2)",
  "var(--purpose-coordination)",
  "var(--purpose-spare-4)",
  "var(--purpose-spare-3)",
  "var(--purpose-upkeep)",
] as const;
const UNSET_COLOUR = "var(--purpose-unset)";

/**
 * One colour per segment name across a set of bars, so a purpose keeps its colour in every bar: the names by their hours across all the
 * bars, largest first, take the palette in order ("Not set" is grey); past the palette's length the colours repeat.
 */
export function purposeColours(bars: readonly (readonly PurposePart[])[]): Map<string, string> {
  const totals = new Map<string, number>();
  for (const bar of bars) for (const p of bar) totals.set(p.name, (totals.get(p.name) ?? 0) + p.value);
  const names = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  const colours = new Map<string, string>();
  let i = 0;
  for (const n of names) colours.set(n, n === PURPOSE_NOT_SET ? UNSET_COLOUR : PURPOSE_PALETTE[i++ % PURPOSE_PALETTE.length]!);
  return colours;
}
