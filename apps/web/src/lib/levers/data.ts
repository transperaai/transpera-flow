import "server-only";
import { loadLeverSettings, type LeverSettings } from "@transpera-flow/db";
import { cleanHidden } from "@/lib/scenarios/lever-catalogue";
import { getDb } from "@/lib/auth/session";

/**
 * The levers the workspace has switched off (RLS: every member reads them); no row means every lever is shown. If
 * they can't be read (say the table isn't there yet), pages fall back to showing every lever rather than break.
 */
export async function loadWorkspaceLeverSettings(workspaceId: string): Promise<LeverSettings> {
  try {
    const stored = await loadLeverSettings(await getDb(), workspaceId);
    return { ...stored, hidden: cleanHidden(stored.hidden) };
  } catch (err) {
    console.error("Couldn't load the lever settings; showing every lever.", err instanceof Error ? err.message : err);
    return { hidden: [], version: null };
  }
}
