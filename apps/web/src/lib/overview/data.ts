import "server-only";
import { listProcesses, loadLiveCompanyPart, partitionSteps, type EdgeRow, type ProcessPart, type ProcessRevisionRow, type StepRow } from "@transpera-flow/db";
import { createClient } from "../supabase/server";

/**
 * The workspace's company map at its live revision, which the Overview draws its map from (B11): where each process
 * sits and the handoff lines. Null when there is none (the Overview then lays the map out as it always did). As the
 * signed-in user (RLS decides what is visible).
 */
export async function loadLiveCompany(workspaceId: string): Promise<ProcessPart | null> {
  return loadLiveCompanyPart(await createClient(), workspaceId);
}

/**
 * An earlier published version of the company map, for the Overview's `?version=N` (read only). Null when `number` is not an
 * earlier version of this map (the live one, a draft, or none): the Overview then shows the live map.
 */
export async function loadCompanyVersion(live: ProcessPart, number: number): Promise<ProcessPart | null> {
  const db = await createClient();
  const found = await db.from("process_revisions").select("id, workspace_id, process_id, number, status").eq("process_id", live.process.id).eq("number", number).in("status", ["published", "superseded"]).maybeSingle();
  if (found.error) throw found.error;
  const revision = found.data as ProcessRevisionRow | null;
  if (!revision || revision.id === live.revision.id) return null;
  const [steps, edges] = await Promise.all([
    db.from("steps").select("*").eq("revision_id", revision.id).order("y").order("x").order("id"),
    db.from("edges").select("*").eq("revision_id", revision.id).order("id"),
  ]);
  if (steps.error) throw steps.error;
  if (edges.error) throw edges.error;
  return { process: live.process, revision, steps: steps.data as unknown as StepRow[], edges: edges.data as unknown as EdgeRow[] };
}

/**
 * Every process of the workspace at its live revision, for the Overview's company map (issue #100): the
 * pipelines, the servicing processes and the child processes, in creation order. Processes never published
 * aren't on the map. As the signed-in user (RLS decides what is visible).
 */
export async function loadLiveParts(workspaceId: string): Promise<ProcessPart[]> {
  const db = await createClient();
  const live = (await listProcesses(db, workspaceId)).filter((p) => p.live_revision_id);
  const ids = live.map((p) => p.live_revision_id!);
  if (!ids.length) return [];
  const [revisions, steps, edges] = await Promise.all([
    db.from("process_revisions").select("id, workspace_id, process_id, number, status").in("id", ids),
    db.from("steps").select("*").in("revision_id", ids),
    db.from("edges").select("*").in("revision_id", ids),
  ]);
  if (revisions.error) throw revisions.error;
  if (steps.error) throw steps.error;
  if (edges.error) throw edges.error;
  const parts: ProcessPart[] = [];
  for (const p of live) {
    const revision = (revisions.data as ProcessRevisionRow[]).find((r) => r.id === p.live_revision_id);
    if (!revision) continue;
    const { draft_revision_id, ...process } = p;
    void draft_revision_id;
    parts.push({
      process,
      revision,
      // Split or replaced steps are never drawn or simulated.
      steps: partitionSteps((steps.data as unknown as StepRow[]).filter((s) => s.revision_id === revision.id)).steps,
      edges: (edges.data as unknown as EdgeRow[]).filter((e) => e.revision_id === revision.id),
    });
  }
  return parts;
}
