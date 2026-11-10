"use server";

import { ENGINE_VERSION } from "@transpera-flow/engine";
import { headlineIsFresh, pickHeadline, sameHeadline, type HeadlineNumbers } from "@/lib/overview/headline";
import { isId } from "@/lib/services";
import { jsonb } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// The agency list's headline numbers (issue #30, B1 part 3): the Overview, once its run at the workspace's own horizon is in,
// records flow efficiency, processes needing attention and client groups at risk, so the agency's home page can list them
// without simulating every workspace. Runs as the signed-in user: RLS lets Agency admins write `workspace_headlines`, the
// table's check pins the numbers' shape, and a trigger stamps who and when. A failure is quiet: the Overview doesn't depend on it.

export type RecordHeadlineResult = { status: "recorded" | "fresh" } | { status: "error"; message: string };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
/** One revision per process: far more processes than a workspace has. */
const MAX_REVISIONS = 200;
/** The workspace horizon setting's own range (1 to 104 weeks). */
const MAX_HORIZON_WEEKS = 104;
const MAX_COUNT = 100_000;

/**
 * Store the workspace's headline numbers, unless the stored ones are the same numbers for the same engine, revisions and horizon
 * and under an hour old. Different numbers (a changed rule, team or client group) are written at once.
 */
export async function recordHeadline(
  workspaceId: string,
  revisionIds: string[],
  horizonWeeks: number,
  numbers: HeadlineNumbers,
): Promise<RecordHeadlineResult> {
  const flow = numbers?.flow_efficiency;
  if (
    !numbers ||
    typeof numbers !== "object" ||
    !isId(workspaceId) ||
    !Array.isArray(revisionIds) ||
    revisionIds.length > MAX_REVISIONS ||
    !revisionIds.every(isId) ||
    new Set(revisionIds).size !== revisionIds.length ||
    !Number.isInteger(horizonWeeks) ||
    horizonWeeks < 1 ||
    horizonWeeks > MAX_HORIZON_WEEKS ||
    !(flow === null || (typeof flow === "number" && flow >= 0 && flow <= 1)) ||
    !isCount(numbers.processes_attention) ||
    !isCount(numbers.processes_total) ||
    !isCount(numbers.client_groups_at_risk) ||
    !isCount(numbers.client_groups_total)
  ) {
    return { status: "error", message: "That isn't valid." };
  }
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const db = await getDb();

  let stored;
  try {
    stored = await db
      .selectFrom("workspace_headlines")
      .select(["engine_version", "revision_ids", "computed_at", "horizon_weeks", "numbers"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
  } catch {
    return { status: "error", message: "Couldn't read the stored numbers." };
  }
  const fresh = stored && stored.horizon_weeks === horizonWeeks && headlineIsFresh(stored, { engineVersion: ENGINE_VERSION, revisionIds, at: new Date() });
  if (fresh && sameHeadline(stored?.numbers, numbers)) return { status: "fresh" };
  // `computed_by` and `computed_at` are set by the database.
  try {
    const row = { engine_version: ENGINE_VERSION, revision_ids: revisionIds, horizon_weeks: horizonWeeks, numbers: jsonb({ ...pickHeadline(numbers) }) };
    await db
      .insertInto("workspace_headlines")
      .values({ workspace_id: workspaceId, ...row })
      .onConflict((oc) =>
        oc.column("workspace_id").doUpdateSet({
          engine_version: (eb) => eb.ref("excluded.engine_version"),
          revision_ids: (eb) => eb.ref("excluded.revision_ids"),
          horizon_weeks: (eb) => eb.ref("excluded.horizon_weeks"),
          numbers: (eb) => eb.ref("excluded.numbers"),
        }),
      )
      .execute();
  } catch {
    return { status: "error", message: "Couldn't save the headline numbers." };
  }
  return { status: "recorded" };
}
