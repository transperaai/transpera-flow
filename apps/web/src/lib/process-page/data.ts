import "server-only";
import { loadProposals } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";
import { authorLabel, type AuthorKind } from "@/lib/history/versions";

/** Who last published the process and when, for "About this process". Null when it was never published or can't be read. */
export async function loadLastChange(processId: string): Promise<{ at: string | null; by: string } | null> {
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("revision_history", { target_process: processId });
    if (error) throw error;
    const latest = (data ?? []).filter((r) => r.status === "published").sort((a, b) => b.number - a.number)[0];
    if (!latest) return null;
    return { at: latest.published_at, by: authorLabel({ authorKind: (latest.author_kind as AuthorKind | null) ?? null, authorName: latest.author_name }) };
  } catch (err) {
    console.error("Couldn't read the last change; showing none.", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The ids of issues an AI solution idea is waiting for ("Solution idea" on the status track). Empty if they can't be read. */
export async function loadIdeaIssueIds(workspaceId: string): Promise<string[]> {
  try {
    const waiting = await loadProposals(await createClient(), workspaceId, "pending");
    return [...new Set(waiting.flatMap((p) => (p.kind === "solution_idea" && p.issue_id ? [p.issue_id] : [])))];
  } catch (err) {
    console.error("Couldn't read the AI ideas; showing none.", err instanceof Error ? err.message : err);
    return [];
  }
}
