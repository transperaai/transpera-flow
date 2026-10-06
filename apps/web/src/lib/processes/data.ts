import "server-only";
import { listProcesses, loadIssuesForReader, loadProcessBySlug, type IssueRow, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";
import type { ArchivedProcess } from "./admin";
import { isOnProcess, processRows, type LiveVersion, type ProcessRowData } from "./rows";

/** What a row's map card needs: the process at its live revision, and its tracked issues (for the map's ratings and badges). */
export interface ProcessCardData {
  bundle: ProcessBundle;
  issues: IssueRow[];
}

/** The Processes page: every process of a workspace with its numbers (RLS decides which are visible). */
export async function loadProcessesPage(workspaceId: string): Promise<ProcessRowData[]> {
  return (await loadProcessesAndArchived(workspaceId)).rows;
}

/** The Processes page's rows, and the archived processes for its Archived filter (issue #182), newest archived first. */
export async function loadProcessesAndArchived(workspaceId: string): Promise<{ rows: ProcessRowData[]; archived: ArchivedProcess[] }> {
  const db = await createClient();
  const [everything, issues] = await Promise.all([listProcesses(db, workspaceId, { includeArchived: true }), loadIssuesForReader(db, workspaceId)]);
  const processes = everything.filter((p) => !p.archived_at);
  const archived = everything
    .flatMap((p) => (p.archived_at ? [{ id: p.id, name: p.name, kind: p.kind, archivedAt: p.archived_at }] : []))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.name.localeCompare(b.name));
  return { rows: await rowsFor(db, processes, issues), archived };
}

async function rowsFor(
  db: Awaited<ReturnType<typeof createClient>>,
  processes: Awaited<ReturnType<typeof listProcesses>>,
  issues: IssueRow[],
): Promise<ProcessRowData[]> {
  const revisionIds = processes.flatMap((p) => (p.live_revision_id ? [p.live_revision_id] : []));
  const [revisions, steps] = revisionIds.length
    ? await Promise.all([
        db.from("process_revisions").select("id, number, published_at").in("id", revisionIds),
        db.from("steps").select("id, process_id, kind, child_process_id").in("revision_id", revisionIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (revisions.error) throw revisions.error;
  if (steps.error) throw steps.error;
  const versions = new Map<string, LiveVersion>();
  for (const p of processes) {
    const r = (revisions.data ?? []).find((x) => x.id === p.live_revision_id);
    if (r) versions.set(p.id, { number: r.number, publishedAt: r.published_at });
  }
  return processRows({
    processes: processes.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      description: p.description,
      parentId: p.parent_process_id,
      live: Boolean(p.live_revision_id),
      draft: Boolean(p.draft_revision_id),
    })),
    steps: (steps.data ?? []) as Pick<StepRow, "id" | "process_id" | "kind" | "child_process_id">[],
    issues,
    versions,
  });
}

/** One process's map card: its live revision (null when it has never been published) and its tracked issues. */
export async function loadProcessCard(slug: string, processId: string): Promise<ProcessCardData | null> {
  const db = await createClient();
  const found = await loadProcessBySlug(db, slug, { draft: false, processId });
  if (!found || found.live.revision.status !== "published" || found.live.steps.length === 0) return null;
  const stepIds = new Set(found.live.steps.map((s) => s.id));
  const issues = (await loadIssuesForReader(db, found.live.workspace.id)).filter((i) => isOnProcess(i, processId, stepIds));
  return { bundle: found.live, issues };
}
