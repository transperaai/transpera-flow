"use server";

import type { ProcessBundle } from "@transpera-flow/db";
import { loadProcessLive } from "@/lib/blocks/data";
import { isId } from "@/lib/editor/validate";

/**
 * The live bundle of the process that lends its roles and people to the Block library's maps, loaded when a row is first opened (as the
 * signed-in user: RLS decides what is visible, so a viewer can open rows too). Null when there is nothing to draw on.
 */
export async function openBlockBase(slug: string, processId: string): Promise<ProcessBundle | null> {
  if (typeof slug !== "string" || !isId(processId)) return null;
  return loadProcessLive(slug, processId);
}
