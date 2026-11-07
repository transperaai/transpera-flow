import "server-only";
import { cache } from "react";
import { ACTIVE_STORED_STATUSES, loadCompanyModel, loadLiveRevisions, snapshotModel } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { getDb } from "./auth/session";

// Reads for the company model's pages, as the signed-in user (RLS decides what's visible): the model as it is now (for the
// "model changed since this run" banner) and the sidebar's counts. (The Suggestions page's reads lived here until
// it was removed, 28 Oct 2026.)

type Db = Awaited<ReturnType<typeof getDb>>;

export interface WorkspaceHead {
  id: string;
  name: string;
  slug: string;
}

/** The company model as it is now, and the snapshot a run saved now would keep. */
export async function currentModel(db: Db, workspace: { id: string; name: string; slug: string; settings: unknown; provenance?: unknown }) {
  const [model, processes] = await Promise.all([loadCompanyModel(db, workspace), loadLiveRevisions(db, workspace.id)]);
  return { model, snapshot: snapshotModel(model, processes), processes };
}

const countOf = async (q: { executeTakeFirstOrThrow(): Promise<{ count: number | string | bigint }> }) => Number((await q.executeTakeFirstOrThrow()).count);

/** The numbers beside the sidebar's Processes, Issues and Sources items: how many processes, tracked issues still open and sources linked to nothing. */
export const shellCounts = cache(async (workspaceId: string): Promise<{ processes: number; openIssues: number; unlinkedSources: number }> => {
  const db = await getDb();
  const [processes, issues, unlinked] = await Promise.all([
    countOf(db.selectFrom("processes").select((eb) => eb.fn.countAll<number>().as("count")).where("workspace_id", "=", workspaceId).where("is_company", "=", false).where("archived_at", "is", null)),
    countOf(db.selectFrom("issues").select((eb) => eb.fn.countAll<number>().as("count")).where("workspace_id", "=", workspaceId).where("status", "in", [...ACTIVE_STORED_STATUSES])),
    // The count is a warning, not a page: if it can't be read (say the function isn't there yet), show none rather than break the shell.
    rpc(db, "unlinked_source_count", { p_workspace: workspaceId }).catch((err: unknown) => {
      console.error("Couldn't count the unlinked sources; showing none.", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);
  return { processes, openIssues: issues, unlinkedSources: unlinked ?? 0 };
});
