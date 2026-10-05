import "server-only";
import {
  ModelError,
  listProcesses,
  loadProcessBundle,
  loadProcessBySlug,
  partitionSteps,
  toEngineModel,
  type EdgeRow,
  type ProcessBundle,
  type ProcessListing,
  type StepRow,
} from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import { createClient } from "@/lib/supabase/server";
import { AUTO_RUN_VERSIONS, autoRunIds, parseChanges, type AuthorKind, type VersionMeta } from "./versions";

/** A version's model for the simulation, or why it can't be built (an old version the model no longer accepts). */
export type ModelEntry = { model: EngineModel } | { error: string };

export interface HistoryData {
  workspace: { id: string; name: string; slug: string };
  process: { id: string; name: string; kind: "pipeline" | "servicing" };
  processes: ProcessListing[];
  /** Published versions, newest first. */
  versions: VersionMeta[];
  /** Models of the newest versions, which are simulated straight away; older ones are fetched on request. */
  models: Record<string, ModelEntry>;
  /** The process has a draft open (restoring replaces it, so the screen warns first). */
  hasDraft: boolean;
  /** The company map (B11): its versions are not simulated, so the screen lists what changed and nothing else. */
  company: boolean;
}

/** One revision as the engine's model, with the process's current roles, people and settings around it. */
function modelOf(base: ProcessBundle, revision: { id: string; number: number }, steps: StepRow[], edges: EdgeRow[]): ModelEntry {
  const { steps: inUse, retired } = partitionSteps(steps);
  try {
    return { model: toEngineModel({ ...base, revision: { ...base.revision, id: revision.id, number: revision.number, status: "superseded" }, steps: inUse, edges, retired }) };
  } catch (err) {
    if (err instanceof ModelError) return { error: err.message };
    throw err;
  }
}

/** Everything the History screen shows for a process, or null if it isn't visible (RLS decides). */
export async function loadHistory(slug: string, processId: string): Promise<HistoryData | null> {
  const db = await createClient();
  const found = await loadProcessBySlug(db, slug, { draft: false, processId, includeCompany: true });
  if (!found) return null;
  const { live, draft, processes } = found;
  const { data: rows, error } = await db.rpc("revision_history", { target_process: processId });
  if (error) throw error;
  const versions: VersionMeta[] = (rows ?? []).map((r) => ({
    revisionId: r.revision_id,
    number: r.number,
    live: r.status === "published",
    publishedAt: r.published_at,
    authorKind: (r.author_kind as AuthorKind | null) ?? null,
    authorName: r.author_name,
    changes: parseChanges(r.changes),
    note: r.note ?? null,
  }));
  const models: Record<string, ModelEntry> = {};
  // The company map is a picture of the business, not a process: nothing to simulate.
  const wanted = live.process.is_company ? [] : autoRunIds(versions, AUTO_RUN_VERSIONS);
  // One query pair per version: a single query for all of them would hit PostgREST's 1000-row cap on a big process.
  await Promise.all(
    wanted.map(async (id) => {
      const v = versions.find((x) => x.revisionId === id)!;
      const [steps, edges] = await Promise.all([db.from("steps").select("*").eq("revision_id", id), db.from("edges").select("*").eq("revision_id", id)]);
      if (steps.error) throw steps.error;
      if (edges.error) throw edges.error;
      models[id] = modelOf(live, { id, number: v.number }, steps.data as StepRow[], edges.data as EdgeRow[]);
    }),
  );
  return {
    workspace: { id: live.workspace.id, name: live.workspace.name, slug: live.workspace.slug },
    process: { id: live.process.id, name: live.process.name, kind: live.process.kind },
    processes,
    versions,
    models,
    hasDraft: draft !== null,
    company: Boolean(live.process.is_company),
  };
}

/** One published version's model, for a version older than the ones simulated up front. Null if it isn't a version of this process. */
export async function loadVersionModel(processId: string, revisionId: string): Promise<ModelEntry | null> {
  const db = await createClient();
  const { data: process, error } = await db.from("processes").select("workspace_id").eq("id", processId).maybeSingle();
  if (error) throw error;
  if (!process) return null;
  const { data: revision, error: revisionError } = await db.from("process_revisions").select("id, process_id, number, status").eq("id", revisionId).maybeSingle();
  if (revisionError) throw revisionError;
  if (!revision || revision.process_id !== processId || revision.status === "draft") return null;
  const { data: workspace, error: wsError } = await db.from("workspaces").select("id, name, slug, settings").eq("id", process.workspace_id).maybeSingle();
  if (wsError) throw wsError;
  if (!workspace) return null;
  const row = (await listProcesses(db, workspace.id)).find((p) => p.id === processId);
  if (!row) return null;
  const { draft_revision_id: draftId, ...processRow } = row;
  void draftId;
  const bundle = await loadProcessBundle(db, workspace, processRow, revisionId);
  return modelOf(bundle, { id: revisionId, number: revision.number }, [...bundle.steps, ...(bundle.retired ?? [])], bundle.edges);
}
