// A step's base values for capacity (P4, requirements section 7): the work split, a line about each part, the tier multipliers,
// "goes to the client's manager" and where each value came from. Pure, like ./commands.ts: each function returns an Edit against
// the process as the editor shows it, so each is one undo and one per-field save. The split, its notes and the multipliers are
// saved as one whole value (never key by key), so a split in the database always adds up to 100%.

import type { ProcessBundle, StepSourceLabel, StepSourcedValue, StepSplit, StepSplitNotes, TierMultiplier } from "@transpera-flow/db";
import { updateStep } from "./commands";
import type { Edit } from "./ops";
import type { Stamp } from "./provenance";

export const SPLIT_PARTS = ["automatable", "augmentable", "manual"] as const;
export type SplitPart = (typeof SPLIT_PARTS)[number];
export type Percents = [number, number, number];

/** What each part is called on the slider and the legend (the prototype's words). */
export const SPLIT_LABELS: Record<SplitPart, string> = { automatable: "Automatable", augmentable: "Augmentable", manual: "Stays manual" };

/** The sliders move in steps of 5%. */
export const SPLIT_STEP = 5;

/** The source labels, as the select shows them (the prototype's words). */
export const SOURCE_OPTIONS: { value: StepSourceLabel; label: string; confidence: string }[] = [
  { value: "interview", label: "Interview", confidence: "Medium confidence" },
  { value: "calculator", label: "Calculator", confidence: "Medium confidence" },
  { value: "measured", label: "Measured", confidence: "High confidence" },
  { value: "estimate", label: "Estimate", confidence: "Low confidence" },
];

/** The step values that carry a label, and what each is called. */
export const SOURCED_VALUE_LABELS: Record<StepSourcedValue, string> = { work: "Time", split: "Work split", tier_multiplier: "Tier multipliers" };

/** The split as whole percents; a step with none is all manual (as the engine reads it). */
export function splitPercents(split: StepSplit | null | undefined): Percents {
  if (!split) return [0, 0, 100];
  return SPLIT_PARTS.map((p) => Math.round(Number(split[p]) * 100)) as Percents;
}

/** Whole percents as shares of 1, to two places, so they add up to 1 exactly enough for the database's check. */
export function splitFromPercents(p: Percents): StepSplit {
  const [automatable, augmentable, manual] = p.map((x) => Math.round(x) / 100) as [number, number, number];
  return { automatable, augmentable, manual };
}

/**
 * Move one slider to `value` and take the difference from the other two in proportion to what they hold (the prototype's way),
 * in steps of 5%, so the three always add up to 100. Two empty others share the difference equally.
 */
export function rebalance(current: Percents, index: 0 | 1 | 2, value: number): Percents {
  const v = Math.min(100, Math.max(0, Math.round(value / SPLIT_STEP) * SPLIT_STEP));
  const [i, j] = ([0, 1, 2] as const).filter((k) => k !== index) as [0 | 1 | 2, 0 | 1 | 2];
  const rest = 100 - v;
  const sum = current[i] + current[j];
  const ratio = sum > 0 ? current[i] / sum : 0.5;
  const first = Math.round((rest * ratio) / SPLIT_STEP) * SPLIT_STEP;
  const out: Percents = [0, 0, 0];
  out[index] = v;
  out[i] = first;
  out[j] = rest - first;
  return out;
}

/** The split in words: "70% automatable, 20% augmentable, 10% manual". */
export function describeSplit(split: StepSplit): string {
  return `${Math.round(split.automatable * 100)}% automatable, ${Math.round(split.augmentable * 100)}% augmentable, ${Math.round(split.manual * 100)}% manual`;
}

const nameOf = (bundle: ProcessBundle, id: string) => bundle.steps.find((s) => s.id === id)?.name ?? "step";

/** Set the split from slider percents (they must add up to 100). */
export function setStepSplit(bundle: ProcessBundle, id: string, percents: Percents): Edit | null {
  if (percents.reduce((a, b) => a + b, 0) !== 100 || percents.some((x) => x < 0)) return null;
  const edit = updateStep(bundle, id, { split: splitFromPercents(percents) });
  return edit && { ...edit, label: `Changed the work split of ${nameOf(bundle, id)}` };
}

/** Take the split, its notes and its source label away: the step is all manual again, as if none had been entered. */
export function clearStepSplit(bundle: ProcessBundle, id: string): Edit | null {
  const edit = updateStep(bundle, id, { split: null, split_notes: null, "provenance.split": null });
  return edit && { ...edit, label: `Cleared the work split of ${nameOf(bundle, id)}` };
}

/** One line about one part of the split; blank takes the line away, and no lines at all is null. */
export function setSplitNote(bundle: ProcessBundle, id: string, part: SplitPart, text: string | null): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step) return null;
  const notes: StepSplitNotes = { ...(step.split_notes ?? {}) };
  const line = text?.replace(/\s+/g, " ").trim() ?? "";
  if (line) notes[part] = line;
  else delete notes[part];
  const edit = updateStep(bundle, id, { split_notes: Object.keys(notes).length ? notes : null });
  return edit && { ...edit, label: `Changed the ${SPLIT_LABELS[part].toLowerCase()} note of ${nameOf(bundle, id)}` };
}

/** One tier's multiplier on the step's time; null takes it away (that tier reads as 1), and none at all is null. */
export function setTierMultiplier(bundle: ProcessBundle, id: string, tier: string, value: number | null): Edit | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step) return null;
  const next: TierMultiplier = { ...(step.tier_multiplier ?? {}) };
  if (value === null) delete next[tier];
  else next[tier] = value;
  const edit = updateStep(bundle, id, { tier_multiplier: Object.keys(next).length ? next : null });
  return edit && { ...edit, label: `Changed the ${tier} multiplier of ${nameOf(bundle, id)}` };
}

/** The step goes to the client's manager (the role stays as the fallback), or back to its role or pinned person. */
export function setToClientManager(bundle: ProcessBundle, id: string, on: boolean): Edit | null {
  const edit = updateStep(bundle, id, { to_client_manager: on });
  return edit && { ...edit, label: on ? `Sent ${nameOf(bundle, id)} to the client's manager` : `Took ${nameOf(bundle, id)} off the client's manager` };
}

/** Say where a base value came from (null takes the label away). Stored beside the step's other provenance. */
export function setSourceLabel(bundle: ProcessBundle, id: string, value: StepSourcedValue, label: StepSourceLabel | null, stamp: Stamp): Edit | null {
  const entry = label === null ? null : { source: label, at: stamp.at, ...(stamp.by ? { by: stamp.by } : {}) };
  const edit = updateStep(bundle, id, { [`provenance.${value}`]: entry });
  return edit && { ...edit, label: `Changed where the ${SOURCED_VALUE_LABELS[value].toLowerCase()} of ${nameOf(bundle, id)} came from` };
}

/** The source label a step's value carries, or null. */
export function sourceLabelOf(step: { provenance?: unknown }, value: StepSourcedValue): StepSourceLabel | null {
  const map = step.provenance as Record<string, { source?: unknown } | undefined> | null | undefined;
  const source = map?.[value]?.source;
  return source === "interview" || source === "calculator" || source === "measured" || source === "estimate" ? source : null;
}
