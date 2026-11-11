// How every chart in the app picks its colours (the palette is in styles/tokens.css). One job per colour:
// - categorical (identity): `categoricalColour(i)` for a fixed order, `colourFor(key, orderedKeys)` for entities by their place in a stable
//   list (never by rank in the current view, so a filter or a re-sort never repaints them). Eight slots, never cycled: the ninth and on
//   fold into the "Other" neutral.
// - purposes and departments: fixed slots (`purposeColour`, `departmentColours`).
// - sequential (magnitude): `SEQUENTIAL`, light to dark. Diverging (which side of a baseline): `DIVERGING`.
// - today's path / "no changes": `BASELINE_COLOUR`, drawn dashed.
// - status (good / warn / crit, the ratings) stays in the status tokens and is never a series; nothing here hands one out.
// Text never wears a series colour: labels, legends and values use the text tokens; a label inside a fill takes `labelOn(fill)`.
// Pure: no React.

import { CLIENT_JOB_PURPOSE, DEFAULT_PURPOSES, FIXED_PURPOSES, FIXING_PURPOSE, UPKEEP_PURPOSE } from "@transpera-flow/db";

/** The categorical slots, in their fixed order (slot 1, the brand teal, first). */
export const CATEGORICAL = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)", "var(--cat-6)", "var(--cat-7)", "var(--cat-8)"] as const;
/** How many entities can have a hue of their own; the rest are "Other". */
export const MORE_THAN_8 = CATEGORICAL.length;
/** The folded tail ("Other"), and a purpose that is not set. */
export const OTHER_COLOUR = "var(--series-other)";
/** Today's path, "No changes": what a scenario is compared with. Draw it dashed (`BASELINE_DASH`). */
export const BASELINE_COLOUR = "var(--series-baseline)";
export const BASELINE_DASH = "5 4";
/** Time nobody spent (a run's idle hours). */
export const IDLE_COLOUR = "var(--series-idle)";
/** Magnitude, lightest (least) first. */
export const SEQUENTIAL = ["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"] as const;
/** Polarity around a baseline: the low side, the neutral middle, the high side. */
export const DIVERGING = { neg: "var(--div-neg)", mid: "var(--div-mid)", pos: "var(--div-pos)" } as const;

/** The colour of the entity at `index` of a fixed order; from the ninth on (or a missing one, -1) it is "Other". */
export function categoricalColour(index: number): string {
  return Number.isInteger(index) && index >= 0 && index < MORE_THAN_8 ? CATEGORICAL[index]! : OTHER_COLOUR;
}

/** Keys in a stable order: each once, by name (case- and accent-insensitive, numbers in order), so the same set always comes out the same. */
export function stableOrder(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0));
}

/** An entity's colour by its place in a stable ordered list (`stableOrder`, or the workspace's own order); not in the list: "Other". */
export function colourFor(key: string, orderedKeys: readonly string[]): string {
  return categoricalColour(orderedKeys.indexOf(key));
}

/** Every key's colour, by its place in `orderedKeys` (`colourFor`). */
export function colourMap(orderedKeys: readonly string[]): Map<string, string> {
  return new Map(orderedKeys.map((k, i) => [k, categoricalColour(i)]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Purposes
// ---------------------------------------------------------------------------------------------------------------------

/** Hand-holding hours are not a step's purpose, but they sit beside the purposes in a bar: their own slot. */
export const HAND_HOLDING = "Hand-holding";

/**
 * The default purposes on fixed slots, so a rename or a reorder never recolours one. "Moves the client's job forward" is slot 1, the brand
 * teal, as the product has always drawn it. Fixing is a kind of time, not a state, so it takes a slot like the others (not the warning).
 */
export const PURPOSE_COLOURS: Readonly<Record<string, string>> = {
  [CLIENT_JOB_PURPOSE]: CATEGORICAL[0],
  [UPKEEP_PURPOSE]: CATEGORICAL[1],
  required: CATEGORICAL[2],
  winning: CATEGORICAL[3],
  coordination: CATEGORICAL[4],
  [FIXING_PURPOSE]: CATEGORICAL[5],
  removable: CATEGORICAL[6],
  [HAND_HOLDING]: CATEGORICAL[7],
};
/** The neutral rows of a time split: a purpose that is not set, and idle time. */
export const NOT_SET_KEY = "not_set";
export const IDLE_KEY = "idle";

/**
 * A purpose's colour. The defaults keep their slots (`PURPOSE_COLOURS`); a purpose the workspace added takes the slot of a default it removed
 * (only Required and Coordination can be removed), in the order of their keys, which never change; with no slot free it is "Other". `keys`
 * is the workspace's purpose keys; without it an added purpose is "Other". Not set is "Other"; idle is the idle neutral.
 */
export function purposeColour(key: string, keys?: readonly string[]): string {
  if (key === IDLE_KEY) return IDLE_COLOUR;
  if (key === NOT_SET_KEY) return OTHER_COLOUR;
  const fixed = PURPOSE_COLOURS[key];
  if (fixed) return fixed;
  if (!keys) return OTHER_COLOUR;
  const removed = DEFAULT_PURPOSES.map((p) => p.key).filter((k) => !(FIXED_PURPOSES as readonly string[]).includes(k) && !keys.includes(k));
  const added = stableOrder(keys.filter((k) => !(k in PURPOSE_COLOURS) && k !== NOT_SET_KEY && k !== IDLE_KEY));
  const i = added.indexOf(key);
  return i >= 0 && i < removed.length ? PURPOSE_COLOURS[removed[i]!]! : OTHER_COLOUR;
}

// ---------------------------------------------------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------------------------------------------------

/** Each department's colour, by id: the departments by name (then id) take the slots in order, so adding a person or a filter never repaints one. */
export function departmentColours(departments: readonly { id: string; name: string }[]): Map<string, string> {
  const sorted = [...departments].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((d, i) => [d.id, categoricalColour(i)]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------------

/** The text colour for a label set inside a fill: white on a categorical hue, the main text colour on a neutral one. */
export function labelOn(fill: string): string {
  return (CATEGORICAL as readonly string[]).includes(fill) ? "var(--on-series)" : "var(--fg)";
}
