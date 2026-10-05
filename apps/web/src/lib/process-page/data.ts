import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * When the live version was published and by whom, for "About this process". Reads that one revision directly; the name
 * comes from the workspace's member names (user id to person name), "A team member" for a member with no person linked, and
 * "The system" for a version nobody published. Null when it can't be read.
 */
export async function loadLastChange(liveRevisionId: string, memberNames: Readonly<Record<string, string>>): Promise<{ at: string | null; by: string } | null> {
  try {
    const db = await createClient();
    const { data, error } = await db.from("process_revisions").select("published_at, published_by").eq("id", liveRevisionId).eq("status", "published").maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { at: data.published_at, by: data.published_by ? (memberNames[data.published_by] ?? "A team member") : "The system" };
  } catch (err) {
    console.error("Couldn't read the last change; showing none.", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Which of these issues an AI solution idea is waiting for ("Solution idea" on the status track): only the issue ids, no idea contents. */
export async function loadIdeaIssueIds(workspaceId: string, issueIds: readonly string[]): Promise<string[]> {
  if (issueIds.length === 0) return [];
  try {
    const db = await createClient();
    const { data, error } = await db
      .from("suggestion_proposals")
      .select("issue_id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "solution_idea")
      .eq("status", "pending")
      .in("issue_id", [...issueIds]);
    if (error) throw error;
    return [...new Set((data ?? []).flatMap((r) => (r.issue_id ? [r.issue_id] : [])))];
  } catch (err) {
    console.error("Couldn't read the AI ideas; showing none.", err instanceof Error ? err.message : err);
    return [];
  }
}
