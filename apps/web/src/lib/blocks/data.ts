import "server-only";
import { loadProcessBySlug, type ProcessBundle } from "@transpera-flow/db";
import { getDb } from "@/lib/auth/session";

/** A process at its live revision (a draft-only process lends its draft), or null. Read as the signed-in user. */
export async function loadProcessLive(slug: string, processId: string): Promise<ProcessBundle | null> {
  const found = await loadProcessBySlug(await getDb(), slug, { draft: false, processId });
  return found?.live ?? null;
}
