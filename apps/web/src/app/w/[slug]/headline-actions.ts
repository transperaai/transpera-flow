"use server";

import { ENGINE_VERSION } from "@transpera-flow/engine";
import { headlineIsFresh, pickHeadline, sameHeadline, type HeadlineNumbers } from "@/lib/overview/headline";
import { isId } from "@/lib/services";
import { createClient } from "@/lib/supabase/server";

// The agency list's headline numbers (issue #30, B1 part 3): the Overview, once its run at the workspace's own horizon is in,
// records flow efficiency, processes needing attention and client groups at risk, so the agency's home page can list them
// without simulating every workspace. Runs as the signed-in user: RLS lets owners and editors write `workspace_headlines`, the
// table's check pins the numbers' shape, and a trigger stamps who and when. A failure is quiet: the Overview doesn't depend on it.

export type RecordHeadlineResult = { status: "recorded" | "fresh" } | { status: "error"; message: string };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

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
    !isId(workspaceId) ||
    !Array.isArray(revisionIds) ||
    revisionIds.length > 500 ||
    !revisionIds.every(isId) ||
    !Number.isInteger(horizonWeeks) ||
    horizonWeeks < 1 ||
    !(flow === null || (typeof flow === "number" && flow >= 0 && flow <= 1)) ||
    !isCount(numbers.processes_attention) ||
    !isCount(numbers.processes_total) ||
    !isCount(numbers.client_groups_at_risk) ||
    !isCount(numbers.client_groups_total)
  ) {
    return { status: "error", message: "That isn't valid." };
  }
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return { status: "error", message: "Your session has ended. Sign in again." };

  const stored = await supabase
    .from("workspace_headlines")
    .select("engine_version, revision_ids, computed_at, horizon_weeks, numbers")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (stored.error) return { status: "error", message: "Couldn't read the stored numbers." };
  const fresh = stored.data && stored.data.horizon_weeks === horizonWeeks && headlineIsFresh(stored.data, { engineVersion: ENGINE_VERSION, revisionIds, at: new Date() });
  if (fresh && sameHeadline(stored.data?.numbers, numbers)) return { status: "fresh" };
  // `computed_by` and `computed_at` are set by the database.
  const { error } = await supabase.from("workspace_headlines").upsert({
    workspace_id: workspaceId,
    engine_version: ENGINE_VERSION,
    revision_ids: revisionIds,
    horizon_weeks: horizonWeeks,
    numbers: { ...pickHeadline(numbers) },
  });
  if (error) return { status: "error", message: "Couldn't save the headline numbers." };
  return { status: "recorded" };
}
