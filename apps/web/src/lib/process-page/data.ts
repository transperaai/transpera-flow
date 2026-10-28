import "server-only";
import { getDb } from "@/lib/auth/session";

/**
 * When the live version was published and by whom, for "About this process". Reads that one revision directly; the name
 * comes from the workspace's member names (user id to person name), "A team member" for a member with no person linked, and
 * "The system" for a version nobody published. Null when it can't be read.
 */
export async function loadLastChange(liveRevisionId: string, memberNames: Readonly<Record<string, string>>): Promise<{ at: string | null; by: string } | null> {
  try {
    const db = await getDb();
    const data = await db.selectFrom("process_revisions").select(["published_at", "published_by"]).where("id", "=", liveRevisionId).where("status", "=", "published").executeTakeFirst();
    if (!data) return null;
    return { at: data.published_at, by: data.published_by ? (memberNames[data.published_by] ?? "A team member") : "The system" };
  } catch (err) {
    console.error("Couldn't read the last change; showing none.", err instanceof Error ? err.message : err);
    return null;
  }
}
