import "server-only";
import { listPlacements, listProcesses } from "@transpera-flow/db";
import { PROCESS_TEMPLATES } from "@transpera-flow/mcp";
import { createClient } from "@/lib/supabase/server";
import type { LibraryProcess, LibraryTemplate } from "./library";

/**
 * What the process library (B12, #164) lists in an editor of this workspace: every process (never the company map) with where
 * it sits now, which is the process whose LIVE version holds it (`public.process_placements`), and the templates. As the
 * signed-in user (RLS decides what is visible).
 */
export async function loadLibrary(workspaceId: string): Promise<{ processes: LibraryProcess[]; templates: LibraryTemplate[] }> {
  const db = await createClient();
  const [processes, placements] = await Promise.all([listProcesses(db, workspaceId), listPlacements(db, workspaceId)]);
  const holderOf = new Map(placements.map((p) => [p.processId, { id: p.holderId, name: p.holderName, company: p.holderIsCompany }]));
  return {
    processes: processes.map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: Boolean(p.live_revision_id), holder: holderOf.get(p.id) ?? null })),
    templates: PROCESS_TEMPLATES.map((t) => ({ id: t.id, name: t.name, kind: t.kind, description: t.description })),
  };
}
