"use server";

import type { SandboxScenarioRow } from "@transpera-flow/db";
import { SANDBOX_CHANGED_ELSEWHERE, SANDBOX_SIGNED_OUT, sandboxFailure } from "@/lib/sandbox/save-errors";
import { isId, parseSandboxInput } from "@/lib/sandbox/validate";
import { jsonb, pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const COLUMNS = ["id", "workspace_id", "name", "description", "parent_id", "changes", "horizon_months", "start_date", "created_at", "updated_at", "created_by"] as const;

// Saving and deleting Sandbox scenarios (docs/plans/sandbox-p1-brief.md §5). A scenario is a named list of changes; it never touches the
// live model. Everything runs as the signed-in user through row-level security: Agency admins and the Owner write scenarios, everyone
// who can read the workspace reads them. The database checks every change again (shape, limits, parent chain); `sandboxFailure` puts
// its errors in plain words. Rename, Duplicate and Build on are all saves.

export type SaveSandboxResult = { status: "ok"; scenario: SandboxScenarioRow } | { status: "error"; message: string };
export type DeleteSandboxResult = { status: "ok" } | { status: "error"; message: string };

const invalid = { status: "error", message: "That scenario isn't valid." } as const;
const signedOut = { status: "error", message: SANDBOX_SIGNED_OUT } as const;

/**
 * Save a scenario: a new one (`scenarioId` null) or a change to one, only if nobody else has changed it since `expectedUpdatedAt` (the
 * `updated_at` the page loaded it with). `input` is `{ name, description, parent_id, changes, horizon_months }`.
 */
export async function saveSandboxScenario(workspaceId: unknown, scenarioId: unknown, input: unknown, expectedUpdatedAt: unknown): Promise<SaveSandboxResult> {
  if (!isId(workspaceId)) return invalid;
  if (scenarioId !== null && !isId(scenarioId)) return invalid;
  if (scenarioId !== null && (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();

  // What the checks beyond the database's need: each solution's process (two can't go live in one month), the process names, and the
  // workspace's scenarios (the parent, and the limits on this scenario with its parents and on those that build on it).
  const [solutions, processes, scenarios] = await Promise.all([
    db.selectFrom("solutions").select(["id", "process_id"]).where("workspace_id", "=", workspaceId).execute().catch(() => []),
    db.selectFrom("processes").select(["id", "name"]).where("workspace_id", "=", workspaceId).execute().catch(() => []),
    db.selectFrom("sandbox_scenarios").select(["id", "name", "parent_id", "changes"]).where("workspace_id", "=", workspaceId).execute().catch(() => []),
  ]);
  const names = new Map(processes.map((p) => [p.id, p.name]));
  const parsed = parseSandboxInput(input, {
    solutions,
    processName: (id) => names.get(id) ?? "that process",
    scenarios: scenarios as unknown as NonNullable<Parameters<typeof parseSandboxInput>[1]>["scenarios"],
    selfId: scenarioId as string | null,
  });
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const { name, description, parent_id, changes, horizon_months } = parsed.value;

  if (scenarioId === null) {
    try {
      const data = await db
        .insertInto("sandbox_scenarios")
        .values({ workspace_id: workspaceId, name, description, parent_id, changes: jsonb(changes), horizon_months })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return { status: "ok", scenario: data as unknown as SandboxScenarioRow };
    } catch (e) {
      return { status: "error", message: sandboxFailure(pgError(e)) };
    }
  }
  let data;
  try {
    data = await db
      .updateTable("sandbox_scenarios")
      .set({ name, description, parent_id, changes: jsonb(changes), horizon_months })
      .where("id", "=", scenarioId as string)
      .where("workspace_id", "=", workspaceId)
      .where("updated_at", "=", expectedUpdatedAt as string)
      .returning(COLUMNS)
      .execute();
  } catch (e) {
    return { status: "error", message: sandboxFailure(pgError(e)) };
  }
  // No row back: someone else changed or deleted it since this page loaded it, so nothing was overwritten.
  if (!data.length) return { status: "error", message: SANDBOX_CHANGED_ELSEWHERE };
  return { status: "ok", scenario: data[0] as unknown as SandboxScenarioRow };
}

/** Delete a scenario. Refused while others build on it, naming them. */
export async function deleteSandboxScenario(workspaceId: unknown, scenarioId: unknown): Promise<DeleteSandboxResult> {
  if (!isId(workspaceId) || !isId(scenarioId)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  let data;
  try {
    data = await db.deleteFrom("sandbox_scenarios").where("id", "=", scenarioId).where("workspace_id", "=", workspaceId).returning("id").execute();
  } catch (e) {
    const err = pgError(e);
    if (err?.code === "23503") {
      const children = await db.selectFrom("sandbox_scenarios").select("name").where("parent_id", "=", scenarioId).where("workspace_id", "=", workspaceId).orderBy("name").execute().catch(() => []);
      const list = children.map((c) => `“${c.name}”`).join(", ");
      return { status: "error", message: `Other scenarios build on this one${list ? `: ${list}` : ""}. Delete them or change what they build on first.` };
    }
    return { status: "error", message: sandboxFailure(err) };
  }
  if (!data.length) return { status: "error", message: SANDBOX_CHANGED_ELSEWHERE };
  return { status: "ok" };
}
