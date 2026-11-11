// The Capacity page's "time to serve" bars label their segments by the planned hours' purpose. A step carries a purpose key
// ("client_job"); the workspace names each key (Settings → Purposes). This maps the keys to those names, as the Sandbox's time view does.
// Pure: no React.

import { workspacePurposes, type PurposeCategory } from "@transpera-flow/db";
import { CATEGORICAL, HAND_HOLDING, OTHER_COLOUR, PURPOSE_COLOURS, purposeColour } from "@/lib/chart-colours";

/** What a key reads as when the workspace's list has no such category (a deleted one, or a step with no purpose). */
export const PURPOSE_NOT_SET = "Not set";

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

/** The categorical slots in order (lib/chart-colours.ts), for a chart that colours its own fixed set of things. */
export const PURPOSE_PALETTE = CATEGORICAL;

/**
 * One colour per segment name across a set of bars, so a purpose keeps its colour in every bar and on every page: each purpose takes its
 * fixed slot by key (`purposeColour`), Hand-holding its own, Not set the neutral, never a slot by its size in these bars. Listed in the
 * workspace's order (`categories`), then Hand-holding, then Not set.
 */
export function purposeColours(bars: readonly (readonly PurposePart[])[], categories: readonly PurposeCategory[] = workspacePurposes(null)): Map<string, string> {
  const present = new Set(bars.flatMap((b) => b.map((p) => p.name)));
  const keys = categories.map((c) => c.key);
  const colours = new Map<string, string>();
  for (const c of categories) if (present.has(c.name)) colours.set(c.name, purposeColour(c.key, keys));
  if (present.has(HAND_HOLDING)) colours.set(HAND_HOLDING, PURPOSE_COLOURS[HAND_HOLDING]!);
  for (const n of present) if (!colours.has(n)) colours.set(n, OTHER_COLOUR);
  return colours;
}
