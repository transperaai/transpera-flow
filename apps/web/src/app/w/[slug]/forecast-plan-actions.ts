"use server";

import { FORECAST_PLAN_COLUMNS, type ForecastPlanRow, type Json } from "@transpera-flow/db";
import { parsePlanInput } from "@/lib/forecast/plan";
import { PLAN_CHANGED_ELSEWHERE, PLAN_SIGNED_OUT, planFailure } from "@/lib/forecast/plan-save";
import { isId } from "@/lib/sources/validate";
import { createClient } from "@/lib/supabase/server";

// Saving and deleting forecast plans (issue #36, B7). A plan is a named set of markers; it never touches the live model.
// Everything runs as the signed-in user through row-level security: owners, editors and agency admins read and write
// plans, nobody else reads any. The database checks every marker again (roles, people and solutions of this workspace,
// dates, FTE, weeks, limits); `planFailure` puts its errors in plain words.

export type SavePlanResult = { status: "ok"; plan: ForecastPlanRow } | { status: "error"; message: string };
export type DeletePlanResult = { status: "ok" } | { status: "error"; message: string };

const invalid = { status: "error", message: "That plan isn't valid." } as const;
const signedOut = { status: "error", message: PLAN_SIGNED_OUT } as const;

/**
 * Save a plan: a new one (`planId` null) or a change to one, only if nobody else has changed it since `expectedUpdatedAt`
 * (the `updated_at` the page loaded it with).
 */
export async function savePlan(workspaceId: unknown, planId: unknown, input: unknown, expectedUpdatedAt: unknown): Promise<SavePlanResult> {
  if (!isId(workspaceId)) return invalid;
  if (planId !== null && !isId(planId)) return invalid;
  if (planId !== null && (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt)) return invalid;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return signedOut;

  // Two solutions for one process can't go live in the same month: needs each solution's process (small columns only).
  const [{ data: solutions }, { data: processes }] = await Promise.all([
    supabase.from("solutions").select("id, process_id").eq("workspace_id", workspaceId),
    supabase.from("processes").select("id, name").eq("workspace_id", workspaceId),
  ]);
  const names = new Map((processes ?? []).map((p) => [p.id, p.name]));
  const parsed = parsePlanInput(input, { solutions: solutions ?? [], processName: (id) => names.get(id) ?? "that process" });
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const { name, markers } = parsed.value;

  if (planId === null) {
    const { data, error } = await supabase
      .from("forecast_plans")
      .insert({ workspace_id: workspaceId, name, markers: markers as unknown as Json })
      .select(FORECAST_PLAN_COLUMNS)
      .single();
    if (error) return { status: "error", message: planFailure(error) };
    return { status: "ok", plan: data as unknown as ForecastPlanRow };
  }
  const { data, error } = await supabase
    .from("forecast_plans")
    .update({ name, markers: markers as unknown as Json })
    .eq("id", planId)
    .eq("workspace_id", workspaceId)
    .eq("updated_at", expectedUpdatedAt as string)
    .select(FORECAST_PLAN_COLUMNS);
  if (error) return { status: "error", message: planFailure(error) };
  // No row back: someone else changed or deleted it since this page loaded it, so nothing was overwritten.
  if (!data?.length) return { status: "error", message: PLAN_CHANGED_ELSEWHERE };
  return { status: "ok", plan: data[0] as unknown as ForecastPlanRow };
}

/** Delete a plan. */
export async function deletePlan(workspaceId: unknown, planId: unknown): Promise<DeletePlanResult> {
  if (!isId(workspaceId) || !isId(planId)) return invalid;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return signedOut;
  const { data, error } = await supabase.from("forecast_plans").delete().eq("id", planId).eq("workspace_id", workspaceId).select("id");
  if (error) return { status: "error", message: planFailure(error) };
  if (!data?.length) return { status: "error", message: PLAN_CHANGED_ELSEWHERE };
  return { status: "ok" };
}
