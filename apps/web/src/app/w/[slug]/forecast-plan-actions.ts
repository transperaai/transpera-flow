"use server";

import type { ForecastPlanRow } from "@transpera-flow/db";
import { parsePlanInput } from "@/lib/forecast/plan";
import { PLAN_CHANGED_ELSEWHERE, PLAN_SIGNED_OUT, planFailure } from "@/lib/forecast/plan-save";
import { isId } from "@/lib/sources/validate";
import { jsonb, pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const PLAN_COLUMNS = ["id", "workspace_id", "name", "markers", "created_at", "updated_at", "created_by"] as const;

// Saving and deleting forecast plans (issue #36, B7). A plan is a named set of markers; it never touches the live model.
// Everything runs as the signed-in user through row-level security: Agency admins and the Owner read and write
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
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();

  // Two solutions for one process can't go live in the same month: needs each solution's process (small columns only).
  const [solutions, processes] = await Promise.all([
    db.selectFrom("solutions").select(["id", "process_id"]).where("workspace_id", "=", workspaceId).execute().catch(() => []),
    db.selectFrom("processes").select(["id", "name"]).where("workspace_id", "=", workspaceId).execute().catch(() => []),
  ]);
  const names = new Map(processes.map((p) => [p.id, p.name]));
  const parsed = parsePlanInput(input, { solutions, processName: (id) => names.get(id) ?? "that process" });
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const { name, markers } = parsed.value;

  if (planId === null) {
    try {
      const data = await db
        .insertInto("forecast_plans")
        .values({ workspace_id: workspaceId, name, markers: jsonb(markers) })
        .returning(PLAN_COLUMNS)
        .executeTakeFirstOrThrow();
      return { status: "ok", plan: data as unknown as ForecastPlanRow };
    } catch (e) {
      return { status: "error", message: planFailure(pgError(e)) };
    }
  }
  let data;
  try {
    data = await db
      .updateTable("forecast_plans")
      .set({ name, markers: jsonb(markers) })
      .where("id", "=", planId as string)
      .where("workspace_id", "=", workspaceId)
      .where("updated_at", "=", expectedUpdatedAt as string)
      .returning(PLAN_COLUMNS)
      .execute();
  } catch (e) {
    return { status: "error", message: planFailure(pgError(e)) };
  }
  // No row back: someone else changed or deleted it since this page loaded it, so nothing was overwritten.
  if (!data.length) return { status: "error", message: PLAN_CHANGED_ELSEWHERE };
  return { status: "ok", plan: data[0] as unknown as ForecastPlanRow };
}

/** Delete a plan. */
export async function deletePlan(workspaceId: unknown, planId: unknown): Promise<DeletePlanResult> {
  if (!isId(workspaceId) || !isId(planId)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  let data;
  try {
    data = await db.deleteFrom("forecast_plans").where("id", "=", planId).where("workspace_id", "=", workspaceId).returning("id").execute();
  } catch (e) {
    return { status: "error", message: planFailure(pgError(e)) };
  }
  if (!data.length) return { status: "error", message: PLAN_CHANGED_ELSEWHERE };
  return { status: "ok" };
}
