import "server-only";
import { loadProcessBySlug, type ProcessListing } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";
import { parseChanges, type AuthorKind, type VersionMeta } from "./versions";

export interface HistoryData {
  workspace: { id: string; name: string; slug: string };
  process: { id: string; name: string; kind: "pipeline" | "servicing" };
  processes: ProcessListing[];
  /** Published versions, newest first. */
  versions: VersionMeta[];
  /** The process has a draft open (restoring replaces it, so the screen warns first). */
  hasDraft: boolean;
  /** The company map (B11): the screen lists what changed. */
  company: boolean;
  /** Archived (issue #182): read only until it is restored. */
  archived: boolean;
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
  return {
    workspace: { id: live.workspace.id, name: live.workspace.name, slug: live.workspace.slug },
    process: { id: live.process.id, name: live.process.name, kind: live.process.kind },
    processes,
    versions,
    hasDraft: draft !== null,
    company: Boolean(live.process.is_company),
    archived: Boolean(live.process.archived_at),
  };
}
