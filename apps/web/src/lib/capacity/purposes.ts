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
