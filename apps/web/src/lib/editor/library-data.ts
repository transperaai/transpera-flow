import "server-only";
import { listPlacements, listProcesses } from "@transpera-flow/db";
import { getDb } from "@/lib/auth/session";
import type { LibraryProcess } from "./library";

/**
 * What the process library (B12, #164) lists in an editor of this workspace: every process (never the company map) with where
 * it sits now, which is the process whose LIVE version holds it (`public.process_placements`) (no templates, QA round 2). As the
 * signed-in user (RLS decides what is visible).
 */
export async function loadLibrary(workspaceId: string): Promise<{ processes: LibraryProcess[] }> {
  const db = await getDb();
  const [processes, placements] = await Promise.all([listProcesses(db, workspaceId), listPlacements(db, workspaceId)]);
  const holderOf = new Map(placements.map((p) => [p.processId, { id: p.holderId, name: p.holderName, company: p.holderIsCompany }]));
  return {
    processes: processes.map((p) => ({ id: p.id, name: p.name, kind: p.kind, category: p.category, live: Boolean(p.live_revision_id), holder: holderOf.get(p.id) ?? null })),
  };
}
