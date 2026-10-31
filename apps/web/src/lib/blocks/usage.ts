// "Used in N solutions" on the block library (capacity build P8 section 4).
//
// A block put into a map arrives as a new group whose steps have fresh ids, so the steps' ids can't say where a block went. Inserting a block
// records it instead: the new group's `provenance.block` is the library block's id (blocks.ts, `BLOCK_MARK`). A solution holds a copy of the
// whole map, so its copy of that group says the block is in it. A block counts once per solution, however many times it was put in. Solutions
// made before the record existed (or from a block since deleted and made again) carry no mark and are not counted.

import type { BlockRow, SolutionRow } from "@transpera-flow/db";
import { blockOfStep } from "./blocks";

/** The number of solutions whose map holds each block, by block id (a block no solution uses has no entry). */
export function blockUsage(solutions: readonly Pick<SolutionRow, "steps">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const solution of solutions) {
    const steps = Array.isArray(solution.steps?.steps) ? solution.steps.steps : [];
    const used = new Set<string>();
    for (const step of steps) {
      const id = step && typeof step === "object" ? blockOfStep(step) : null;
      if (id) used.add(id);
    }
    for (const id of used) out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/** How many solutions use this block. */
export const usedIn = (usage: Record<string, number>, block: Pick<BlockRow, "id">): number => usage[block.id] ?? 0;
