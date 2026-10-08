// How a group of steps is drawn on the process map (issue #102): closed, one
// card with a roll-up of the steps inside it; open, a box around them, laid
// out where their positions (relative to the box) put them. The numbers are the
// same either way: the engine simulates the steps inside, never the group.

import { childrenOf, isGroup, type Expanded, type StepRow } from "@transpera-flow/db";

export interface Size {
  width: number;
  height: number;
}

/** What a step card measures, before React Flow has measured it. */
export const CARD_SIZE: Size = { width: 192, height: 100 };
export const TERMINAL_SIZE: Size = { width: 96, height: 46 };
/** A closed group's card. */
export const GROUP_CARD: Size = { width: 192, height: 124 };
/** An open group with nothing in it yet. */
export const EMPTY_GROUP: Size = { width: 240, height: 120 };
/** Room inside an open group's box: its name above, and a margin below and to the right. Matches where MCP places a group's steps. */
export const GROUP_PADDING = { left: 24, top: 56, right: 24, bottom: 24 };

/** The size of an open group's box: around the steps in it (open groups among them at their own size). */
export function openGroupSize(steps: readonly StepRow[], id: string, expanded: Expanded, measured: ReadonlyMap<string, Size> = new Map()): Size {
  const kids = childrenOf(steps);
  const sizeOf = (s: StepRow, seen: ReadonlySet<string>): Size => {
    if (isGroup(s)) {
      const open = expanded === "all" || expanded.has(s.id);
      return open && !seen.has(s.id) ? box(s.id, new Set([...seen, s.id])) : GROUP_CARD;
    }
    return measured.get(s.id) ?? (s.kind === "start" || s.kind === "end" ? TERMINAL_SIZE : CARD_SIZE);
  };
  const box = (gid: string, seen: ReadonlySet<string>): Size => {
    const inside = kids.get(gid) ?? [];
    if (!inside.length) return EMPTY_GROUP;
    let right = 0;
    let bottom = 0;
    for (const s of inside) {
      const size = sizeOf(s, seen);
      right = Math.max(right, Number(s.x) + size.width);
      bottom = Math.max(bottom, Number(s.y) + size.height);
    }
    return {
      width: Math.max(EMPTY_GROUP.width, Math.round(right + GROUP_PADDING.right)),
      height: Math.max(EMPTY_GROUP.height, Math.round(bottom + GROUP_PADDING.bottom)),
    };
  };
  return box(id, new Set([id]));
}

/** The ids of every group in the process. */
export const groupIds = (steps: readonly StepRow[]): string[] => steps.filter(isGroup).map((s) => s.id);
